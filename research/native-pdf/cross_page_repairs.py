"""Restore one proven cross-page paragraph from unchanged source paint.

The source and candidate tag identities and input hashes are explicit. This
bounded experiment repairs a simple P whose continuation was made Artifact by
autotagging. It never deletes original paragraph content or infers new content.
"""
from __future__ import annotations

from collections import defaultdict
import hashlib
import json
from pathlib import Path
import re

from pypdf import PdfReader
from pypdf.generic import ArrayObject, ContentStream, DictionaryObject, NameObject, NullObject, NumberObject, TextStringObject
from conformance_repairs import _open, _save
from semantic_repairs import _tag_nodes
from preserve_figures import atoms, scan, structure, parent_entries, refkey, obj, props, effective_language, PAINT
from verify_pdf import Canonicalizer, compare_figure_associations, drawing_fingerprint, operations


def _paragraph(reader, tag_id):
    nodes = _tag_nodes(reader)
    if not isinstance(tag_id, str) or not re.fullmatch(r'tag-[1-9][0-9]{0,4}', tag_id):
        raise ValueError('invalid_paragraph_id')
    index = int(tag_id[4:]) - 1
    if index >= len(nodes):
        raise ValueError('unknown_paragraph_id')
    node = nodes[index]
    catalog = reader.root_object
    role_map = obj(obj(catalog.get('/StructTreeRoot')).get('/RoleMap', {}))
    role = node.get('/S')
    visited = set()
    while role != '/P' and role in role_map and role not in visited:
        visited.add(role); role = obj(role_map[role])
    if role != '/P' or set(node) - {'/Type','/S','/P','/Pg','/K','/C','/A','/Lang'}:
        raise ValueError('simple_unmodified_paragraph_required')
    _layout_attributes(reader,node)
    lookup = {refkey(page): number for number, page in enumerate(reader.pages)}
    inherited = lookup.get(refkey(node.get('/Pg')))
    if inherited is None:
        raise ValueError('explicit_paragraph_page_required')
    leaves = []
    visited_arrays = set()
    def collect(value, depth=0):
        if depth > 32 or len(leaves) > 1000:
            raise ValueError('paragraph_content_limit')
        value = obj(value)
        if isinstance(value, ArrayObject):
            if id(value) in visited_arrays or len(value) > 1000:
                raise ValueError('paragraph_content_limit')
            visited_arrays.add(id(value))
            for item in value: collect(item, depth + 1)
        elif isinstance(value, NumberObject) and int(value) >= 0:
            leaves.append((inherited, int(value)))
        elif isinstance(value, DictionaryObject) and value.get('/Type') == '/MCR' and not set(value) - {'/Type','/Pg','/MCID'}:
            page = lookup.get(refkey(value.get('/Pg')), inherited if '/Pg' not in value else None)
            mcid = value.get('/MCID')
            if page is None or not isinstance(mcid, NumberObject) or int(mcid) < 0:
                raise ValueError('invalid_paragraph_content')
            leaves.append((page, int(mcid)))
        else:
            raise ValueError('simple_paragraph_content_required')
    collect(node.get('/K'))
    if not leaves or len(leaves) > 1000 or len(set(leaves)) != len(leaves):
        raise ValueError('ambiguous_paragraph_content')
    if [p for p,_ in leaves] != sorted(p for p,_ in leaves):
        raise ValueError('nonsequential_cross_page_paragraph')
    return node, leaves


def _layout_attributes(reader,node):
    """Resolve only self-contained paragraph layout classes; keep exact values."""
    root = obj(reader.root_object.get('/StructTreeRoot'))
    attributes=[]
    if '/C' in node:
        classes=obj(node['/C']); classes=classes if isinstance(classes,ArrayObject) else [classes]
        class_map=obj(root.get('/ClassMap',{}))
        for name in classes:
            if not isinstance(name,NameObject) or name not in class_map:
                raise ValueError('paragraph_class_unresolved')
            value=obj(class_map[name]); attributes.extend(value if isinstance(value,ArrayObject) else [value])
    if '/A' in node:
        value=obj(node['/A']); attributes.extend(value if isinstance(value,ArrayObject) else [value])
    if len(attributes)>4:raise ValueError('paragraph_attribute_limit')
    for attr in attributes:
        attr=obj(attr)
        if not isinstance(attr,DictionaryObject) or attr.get('/O')!='/Layout' or set(attr)-{'/O','/LineHeight','/TextAlign','/TextIndent'}:
            raise ValueError('paragraph_attributes_unsupported')
        if any(not isinstance(value,(NumberObject,NameObject)) and type(value).__name__!='FloatObject' for value in attr.values()):
            raise ValueError('paragraph_attributes_unsupported')
    return [obj(value) for value in attributes]


def _existing_scope_names(page):
    # scan(candidate=True) has already rejected every property besides MCID,
    # including Artifact metadata and unrelated PlacedPDF/optional-content scopes.
    # Preserve the surviving marked-content tag names rather than guessing them
    # from their owning structure role.
    result = {}
    for args, operator in page.get_contents().operations:
        if operator == b'BDC':
            identifier = props(page, args[1]).get('/MCID')
            if identifier is not None:
                result[int(identifier)] = args[0]
    return result


def _source_scope_properties(page, identifiers):
    """Preserve exact simple source line scopes, including authored language."""
    stack, result = [], {}
    for args, operator in page.get_contents().operations:
        if operator in (b'BDC',b'BMC'):
            properties = props(page,args[1]) if operator == b'BDC' else DictionaryObject()
            stack.append((args[0],properties))
        elif operator == b'EMC':
            if not stack:raise ValueError('unbalanced_marked_content')
            stack.pop()
        else:
            relevant=[(tag,properties) for tag,properties in stack if properties.get('/MCID') in identifiers]
            if not relevant:continue
            if operator in (b'MP',b'DP') or len(stack)!=1 or len(relevant)!=1:
                raise ValueError('source_paragraph_scoped_properties_unsupported')
            tag,properties=relevant[0]
            if set(properties)-{'/MCID','/Lang'}:
                raise ValueError('source_paragraph_scoped_properties_unsupported')
            if '/Lang' in properties:
                language=properties['/Lang']
                if not isinstance(language,TextStringObject) or not re.fullmatch(r'[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*',language) or len(language)>35:
                    raise ValueError('source_paragraph_language_unsupported')
            result[int(properties['/MCID'])]=(tag,properties)
    if set(result)!=set(identifiers):raise ValueError('source_paragraph_scopes_unresolved')
    return result


def _can_keep_anchor_page(page, rows, selected, owners, target, page_number,
                          old_leaves, source_ids, source_scopes, final_language,
                          source_language):
    """Prove an existing anchor page is complete before leaving all bytes alone.

    One-to-one line scope correspondence avoids changing reading order or
    inheriting a different language while adding the missing continuation.
    Unrelated marked-content metadata is never reconstructed in this path.
    """
    expected = [identifier for number,identifier in old_leaves if number==page_number]
    if not expected:
        return False
    mapping = defaultdict(set)
    observed = []
    for row in rows:
        # Text state operators can legitimately sit outside the candidate's
        # MCID wrapper. The unchanged full page program proves their placement;
        # semantic ownership must agree for each actual painting operation.
        if row['index'] not in selected or row['op'] not in PAINT:
            continue
        if row['artifact'] or owners.get((page_number,row['mcid'])) is not target:
            return False
        mapping[selected[row['index']]].add(row['mcid'])
        if not observed or observed[-1]!=row['mcid']:
            observed.append(row['mcid'])
    if set(mapping)!=set(source_ids) or any(len(values)!=1 for values in mapping.values()):
        return False
    mapped = [next(iter(mapping[identifier])) for identifier in source_ids]
    if mapped!=expected or observed!=expected or len(set(mapped))!=len(mapped):
        return False
    existing_scopes = _source_scope_properties(page,set(expected))
    for source_id,candidate_id in zip(source_ids,mapped):
        desired_language = source_scopes[source_id][1].get('/Lang',source_language)
        current_language = existing_scopes[candidate_id][1].get('/Lang',final_language)
        if desired_language is not None and current_language!=desired_language:
            return False
    return True


def repair_cross_page_paragraph(original: Path, candidate: Path, output: Path, *,
                                source_tag_id: str, candidate_tag_id: str,
                                expected_original_sha256: str, expected_candidate_sha256: str) -> dict:
    if original.resolve() == output.resolve():
        raise ValueError('new_output_required')
    source, _ = _open(original, output)
    proposed, writer = _open(candidate, output)
    source_hash = hashlib.sha256(source.stream.getvalue()).hexdigest()
    candidate_hash = hashlib.sha256(proposed.stream.getvalue()).hexdigest()
    if source_hash != expected_original_sha256 or candidate_hash != expected_candidate_sha256:
        raise ValueError('input_hash_mismatch')
    if len(source.pages) != len(proposed.pages):
        raise ValueError('page_count_changed')
    source_node, source_leaves = _paragraph(source, source_tag_id)
    target, old_leaves = _paragraph(writer, candidate_tag_id)
    source_language = effective_language(source_node,source.root_object)
    target_language = effective_language(target,writer.root_object)
    if source_language is not None and (not isinstance(source_language,TextStringObject) or not re.fullmatch(r'[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*',source_language) or len(source_language)>35):
        raise ValueError('source_paragraph_language_unsupported')
    source_attributes = _layout_attributes(source,source_node)
    candidate_attributes = _layout_attributes(writer,target)
    if candidate_attributes and Canonicalizer().hash(candidate_attributes)!=Canonicalizer().hash(source_attributes):
        raise ValueError('paragraph_attributes_changed')
    pages = sorted({p for p,_ in source_leaves})
    if not 2 <= len(pages) <= 4 or any(p not in pages for p,_ in old_leaves):
        raise ValueError('bounded_cross_page_paragraph_required')
    source_membership = set(source_leaves)
    source_scopes_by_page = {
        page_number:_source_scope_properties(source.pages[page_number],{mcid for p,mcid in source_leaves if p==page_number})
        for page_number in pages
    }
    source_line_languages = {
        properties.get('/Lang',source_language)
        for scopes in source_scopes_by_page.values() for _,properties in scopes.values()
    }
    # A uniform authored line language can be carried on the paragraph itself.
    # This lets an already-correct anchor keep its original content stream and
    # all unrelated metadata, while retaining the same effective language.
    final_language = source_language
    if len(source_line_languages)==1 and None not in source_line_languages:
        final_language = next(iter(source_line_languages))
    root, owners, _, _ = structure(writer)
    tree = parent_entries(root)
    # Verify the source structure itself owns every leaf being restored.
    _, source_owners, _, _ = structure(source)
    if any(source_owners.get(key) is not source_node for key in source_membership):
        raise ValueError('source_paragraph_owner_mismatch')
    target_ref = target.indirect_reference
    if target_ref is None:
        raise ValueError('indirect_paragraph_required')
    parent_keys = [int(page.get('/StructParents', -1)) for page in writer.pages]
    if any(parent_keys.count(parent_keys[p]) != 1 or parent_keys[p] < 0 for p in pages):
        raise ValueError('ambiguous_page_parent_tree')
    plans, anchored, restored_paint = [], False, 0
    for page_number in pages:
        old_page, new_page = source.pages[page_number], writer.pages[page_number]
        if Canonicalizer(list(source.pages)).hash(old_page.get('/Resources', {})) != Canonicalizer(list(writer.pages)).hash(new_page.get('/Resources', {})):
            raise ValueError('page_resources_changed')
        original_rows, proposed_rows = scan(old_page), scan(new_page)
        source_scopes = source_scopes_by_page[page_number]
        ordered_source_mcids = []
        for row in original_rows:
            if row['op'] in PAINT and (page_number,row['mcid']) in source_membership and not row['artifact']:
                if not ordered_source_mcids or ordered_source_mcids[-1] != row['mcid']:
                    ordered_source_mcids.append(row['mcid'])
        if ordered_source_mcids != [mcid for p,mcid in source_leaves if p == page_number]:
            raise ValueError('source_logical_order_or_paint_membership_unsupported')
        left, right = atoms(original_rows), atoms(proposed_rows)
        if [token for token,_ in left] != [token for token,_ in right]:
            raise ValueError('page_painting_changed')
        original_by_index = {row['index']: row for row in original_rows}
        targets = defaultdict(set)
        for (_, old_indices), (_, new_indices) in zip(left, right):
            choices = {original_by_index[index]['mcid'] if (page_number, original_by_index[index]['mcid']) in source_membership
                       and not original_by_index[index]['artifact'] else None for index in old_indices}
            if len(choices) != 1:
                raise ValueError('source_paragraph_boundary_ambiguous')
            for index in new_indices: targets[index].update(choices)
        if any(len(values) != 1 for values in targets.values()):
            raise ValueError('paragraph_boundary_inside_candidate_operation')
        selected = {index:next(iter(choices)) for index, choices in targets.items() if choices != {None}}
        count = sum(row['index'] in selected and row['op'] in PAINT for row in proposed_rows)
        if not count:
            raise ValueError('source_paragraph_page_has_no_paint')
        restored_paint += count
        for row in proposed_rows:
            current = owners.get((page_number,row['mcid'])) if row['mcid'] is not None and not row['artifact'] else None
            if row['index'] in selected:
                if current is not None and current is not target:
                    raise ValueError('paragraph_paint_owned_by_other_element')
                if current is target and row['op'] in PAINT: anchored = True
            elif current is target:
                raise ValueError('candidate_paragraph_contains_other_source_content')
        entries = obj(tree.get(parent_keys[page_number]))
        if not isinstance(entries, ArrayObject):
            raise ValueError('page_parent_tree_array_required')
        unchanged = _can_keep_anchor_page(new_page,proposed_rows,selected,owners,target,page_number,
                                         old_leaves,ordered_source_mcids,source_scopes,final_language,source_language)
        if not unchanged:
            # Only pages that will actually be reconstructed need the strict
            # no-extra-properties subset. Inspection alone never authorizes
            # discarding metadata or optional-content behavior.
            scan(new_page,candidate=True)
        plans.append((page_number, proposed_rows, selected, list(entries), _existing_scope_names(new_page),source_scopes,unchanged))
    if not anchored:
        raise ValueError('surviving_paragraph_anchor_required')
    if all(plan[-1] for plan in plans):
        raise ValueError('no_missing_continuation_to_repair')
    # Every old reference must be either mapped original paint or a demonstrably
    # absent scope. No other paragraph content may be discarded during rebinding.
    for page_number, mcid in old_leaves:
        entries = obj(tree.get(parent_keys[page_number]))
        if not isinstance(entries, ArrayObject) or mcid >= len(entries) or obj(entries[mcid]) is not target:
            raise ValueError('candidate_paragraph_parent_tree_mismatch')
    new_refs = []
    for page_number, rows, selected, entries, scope_names, source_scopes, unchanged in plans:
        if unchanged:
            new_refs.extend(DictionaryObject({NameObject('/Type'):NameObject('/MCR'),NameObject('/Pg'):writer.pages[page_number].indirect_reference,NameObject('/MCID'):NumberObject(identifier)})
                            for number,identifier in old_leaves if number==page_number)
            continue
        for p, mcid in old_leaves:
            if p == page_number: entries[mcid] = NullObject()
        groups = []
        for row in rows:
            if row['index'] in selected: kind = ('restored',selected[row['index']])
            elif row['artifact']: kind = ('artifact',None)
            elif row['mcid'] is not None: kind = ('existing',row['mcid'])
            else: kind = ('unmarked',None)
            if not groups or groups[-1][0] != kind: groups.append((kind,[]))
            groups[-1][1].append((row['args'],row['op']))
        newops, emitted_existing = [], set()
        for (kind, identifier), content in groups:
            if kind == 'restored':
                source_tag,source_properties=source_scopes[identifier]
                identifier = len(entries); entries.append(target_ref)
                new_refs.append(DictionaryObject({NameObject('/Type'):NameObject('/MCR'),NameObject('/Pg'):writer.pages[page_number].indirect_reference,NameObject('/MCID'):NumberObject(identifier)}))
                restored_properties=DictionaryObject({key:value.clone(writer) for key,value in source_properties.items() if key!='/MCID'})
                restored_properties[NameObject('/MCID')]=NumberObject(identifier)
                newops.append(([source_tag,restored_properties],b'BDC'))
            elif kind == 'existing':
                if identifier in emitted_existing:
                    raise ValueError('existing_mcid_would_be_split')
                emitted_existing.add(identifier)
                owner = owners.get((page_number,identifier))
                if owner is None: raise ValueError('candidate_content_owner_missing')
                newops.append(([scope_names[identifier],DictionaryObject({NameObject('/MCID'):NumberObject(identifier)})],b'BDC'))
            elif kind == 'artifact':newops.append(([NameObject('/Artifact')],b'BMC'))
            newops.extend(content)
            if kind != 'unmarked':newops.append(([],b'EMC'))
        stream = ContentStream(None,writer); stream.operations = newops
        writer.pages[page_number][NameObject('/Contents')] = writer._add_object(stream)
        tree[parent_keys[page_number]] = ArrayObject(entries)
    target[NameObject('/K')] = ArrayObject(new_refs)
    if source_attributes and not candidate_attributes:
        target[NameObject('/A')] = ArrayObject([attribute.clone(writer) for attribute in source_attributes])
    if final_language is not None and final_language!=target_language:
        target[NameObject('/Lang')]=TextStringObject(final_language)
    root[NameObject('/ParentTree')] = writer._add_object(DictionaryObject({NameObject('/Nums'):ArrayObject([value for key, entries in sorted(tree.items()) for value in (NumberObject(key),entries)])}))
    root[NameObject('/ParentTreeNextKey')] = NumberObject(max(tree,default=-1)+1)
    digest = _save(writer,output)
    reopened = PdfReader(output,strict=True)
    _, leaves = _paragraph(reopened,candidate_tag_id)
    if {p for p,_ in leaves} != set(pages): raise ValueError('saved_paragraph_pages_mismatch')
    for number in pages:
        if drawing_fingerprint(operations(proposed.pages[number]),Canonicalizer()) != drawing_fingerprint(operations(reopened.pages[number]),Canonicalizer()):
            raise ValueError('saved_painting_changed')
    unchanged_pages = [plan[0] for plan in plans if plan[-1]]
    for number in unchanged_pages:
        if proposed.pages[number].get_contents().get_data()!=reopened.pages[number].get_contents().get_data():
            raise ValueError('saved_anchor_page_stream_changed')
        if Canonicalizer(list(proposed.pages)).hash(proposed.pages[number].get('/Resources',{}))!=Canonicalizer(list(reopened.pages)).hash(reopened.pages[number].get('/Resources',{})):
            raise ValueError('saved_anchor_page_resources_changed')
    figure_check = compare_figure_associations(proposed,reopened)
    if not figure_check['passed']:
        raise ValueError('saved_figure_associations_changed_or_unverifiable')
    return {'experimental':True,'certification':False,'requires_revalidation':True,
            'originalSha256':source_hash,'inputSha256':candidate_hash,'outputSha256':digest,
            'sourceTagId':source_tag_id,'candidateTagId':candidate_tag_id,
            'sourceReferences':[{'pageNumber':p+1,'mcid':m} for p,m in source_leaves],
            'previousReferences':[{'pageNumber':p+1,'mcid':m} for p,m in old_leaves],
            'restoredReferences':[{'pageNumber':p+1,'mcid':m} for p,m in leaves],
            'sourceLayoutAttributeSetsPreserved':len(source_attributes),
            'sourceEffectiveLanguagePreserved':str(source_language) if source_language is not None else None,
            'outputParagraphLanguage':str(final_language) if final_language is not None else None,
            'unchangedAnchorPageNumbers':[number+1 for number in unchanged_pages],
            'rewrittenPageNumbers':[plan[0]+1 for plan in plans if not plan[-1]],
            'unchangedFigureAssociationsVerified':True,
            'verifiedParagraphPaintOperations':restored_paint}
