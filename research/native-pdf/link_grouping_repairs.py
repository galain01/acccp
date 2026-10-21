"""Restore source-proven, complete native Link groups without redrawing.

Only a source Link whose complete visible address matches its unchanged URI is
eligible. Exact paint occurrences, source annotation identities, adjacent native
children and ParentTree owners establish the grouping; matching text alone does
not. A split GoTo title is eligible only when its complete original native Link
proves the exact title, painted content and annotation membership. Destinations
remain unchanged. Research use only.
"""
from __future__ import annotations

import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path
import re

from pypdf import PdfReader
from pypdf.generic import ArrayObject, DictionaryObject, NameObject, NumberObject
from conformance_repairs import _open, _save
from link_repairs import _annotations, _owners
from semantic_repairs import _tag_nodes
from verify_pdf import (Canonicalizer, figure_association_inventory, integer,
                        number_tree, reference_key, resolved, structure_inventory)


def compact(value):
    return re.sub(r"\s+", "", value)


def _children(node):
    value = resolved(node.get('/K'))
    return list(value) if isinstance(value, list) else [value]


def _leaves(tag):
    sequence = tag.get('contentSequence', [])
    if (tag.get('textIncomplete') or not sequence or any(
        item.get('kind') not in {'markedContent', 'objectReference'}
        or item.get('resolved') is not True or item.get('parentTreeVerified') is not True
        or item.get('streamId') is not None for item in sequence)):
        raise ValueError('simple_resolved_page_link_required')
    if any(item.get('pageNumber') != tag['pageNumber'] for item in sequence):
        raise ValueError('single_page_link_required')
    return sequence


def _paint(tag, pages):
    result = set()
    for item in _leaves(tag):
        if item['kind'] != 'markedContent':
            continue
        owned = pages[item['pageNumber']]['owned'].get(item['mcid'])
        if not owned:
            raise ValueError('link_paint_unresolved')
        result.update(owned)
    return result


def _uri(annotation):
    action = resolved(annotation.get('/A'))
    if (not isinstance(action, dict) or action.get('/S') != '/URI'
            or '/Dest' in annotation or '/AA' in annotation):
        return None
    uri = action.get('/URI')
    if (not isinstance(uri, str) or not 1 <= len(uri) <= 2048
            or re.search(r'\s|[\x00-\x1f\x7f\ufffd]', uri)
            or not re.match(r'^(https?://|mailto:)', uri)):
        return None
    if uri.startswith('mailto:') and any(character in uri for character in ('?', '#')):
        return None
    return uri


def _visible_uri(uri):
    return uri[7:] if uri.startswith('mailto:') else uri


def restore_source_uri_groups(original: Path, candidate: Path, output: Path) -> dict:
    """Return a new candidate plus a bounded ledger; never modify input bytes."""
    if output.resolve() == original.resolve():
        raise ValueError('new_output_required')
    source, _ = _open(original, output)
    reader, writer = _open(candidate, output)
    source_inventory = structure_inventory(source)
    candidate_inventory = structure_inventory(reader)
    source_paint = figure_association_inventory(source)['pages']
    candidate_paint = figure_association_inventory(reader)['pages']
    if len(source.pages) != len(reader.pages):
        raise ValueError('page_count_changed')
    for page_number in source_paint:
        before, after = source_paint[page_number], candidate_paint[page_number]
        if before['executionHash'] != after['executionHash'] or before['resourcesHash'] != after['resourcesHash']:
            raise ValueError('source_page_content_changed')
    old_annotations, annotations = _annotations(source), _annotations(reader)
    if old_annotations.keys() != annotations.keys() or any(old_annotations[key][1] != value[1] for key, value in annotations.items()):
        raise ValueError('source_annotation_behavior_changed')
    source_owners, candidate_owners = _owners(source_inventory), _owners(candidate_inventory)
    tags = {tag['id']: tag for tag in candidate_inventory['tags']}
    nodes = _tag_nodes(reader)
    writer_nodes = _tag_nodes(writer)
    if len(nodes) != len(tags) or len(writer_nodes) != len(nodes):
        raise ValueError('tag_inventory_mismatch')
    native = {tag['id']: node for tag, node in zip(candidate_inventory['tags'], nodes)}
    clones = {tag['id']: node for tag, node in zip(candidate_inventory['tags'], writer_nodes)}
    parent_tree = number_tree(writer.root_object['/StructTreeRoot'].get('/ParentTree'))
    changes, unresolved, plans = [], [], []
    claimed = set()
    for source_tag in source_inventory['tags']:
        if source_tag.get('role') != 'Link':
            continue
        source_refs = [entry for entry in source_tag.get('contentSequence', []) if entry.get('kind') == 'objectReference']
        annotation_keys = [(entry.get('pageNumber'), entry.get('annotationIndex')) for entry in source_refs]
        if not annotation_keys or any(key not in old_annotations for key in annotation_keys):
            continue
        uris = [_uri(old_annotations[key][0]) for key in annotation_keys]
        uri = uris[0] if uris[0] and len(set(uris)) == 1 else None
        local_actions = [resolved(old_annotations[key][0].get('/A')) for key in annotation_keys]
        local_group = uri is None and all(isinstance(action, dict) and set(action) == {'/S', '/D'}
            and action.get('/S') == '/GoTo' and isinstance(action.get('/D'), str)
            and 1 <= len(action['/D']) <= 512 for action in local_actions)
        if not uri and not (local_group and len({Canonicalizer().hash(action) for action in local_actions}) == 1):
            continue
        # A PMID or other descriptive label is not a fragmented visible URI.
        # It remains valid for its existing purpose and is outside this repair.
        expected_text = compact(source_tag.get('text', ''))
        if not 1 <= len(expected_text) <= 4000 or (uri and expected_text != _visible_uri(uri)):
            continue
        def leave(code):
            unresolved.append({'sourceTagId': source_tag['id'], 'pageNumber': source_tag['pageNumber'], 'code': code})
        try:
            _leaves(source_tag)
            if (len(annotation_keys) != len(set(annotation_keys)) or len(annotation_keys) > 20
                    or any(len(source_owners.get(key, [])) != 1 for key in annotation_keys)):
                raise ValueError('source_complete_uri_group_unverified')
            owners = []
            for key in annotation_keys:
                matches = candidate_owners.get(key, [])
                if len(matches) != 1:
                    raise ValueError('candidate_annotation_owner_ambiguous')
                tag = matches[0][0]
                if tag['id'] not in [item['id'] for item in owners]:
                    owners.append(tag)
            if any(tag['role'] != 'Link' or tag['sourceRole'] != 'Link' for tag in owners):
                raise ValueError('native_link_owner_required')
            if len({tag['parentId'] for tag in owners}) != 1 or owners[0]['parentId'] not in tags:
                raise ValueError('adjacent_sibling_links_required')
            parent = tags[owners[0]['parentId']]
            if parent.get('actualText') is not None or parent.get('alt') is not None:
                raise ValueError('parent_text_override_requires_review')
            positions = {item.get('tagId'): index for index, item in enumerate(parent['contentSequence']) if item['kind'] == 'childTag'}
            if any(tag['id'] not in positions for tag in owners):
                raise ValueError('parent_child_reference_missing')
            owners.sort(key=lambda tag: positions[tag['id']])
            indexes = [positions[tag['id']] for tag in owners]
            if indexes != list(range(indexes[0], indexes[0] + len(indexes))):
                raise ValueError('intervening_content_requires_review')
            all_refs = []
            painted = set()
            for tag in owners:
                _leaves(tag)
                if tag['pageNumber'] != source_tag['pageNumber'] or tag.get('effectiveLanguage') != source_tag.get('effectiveLanguage'):
                    raise ValueError('link_page_or_language_mismatch')
                if set(native[tag['id']]) - {'/Type', '/S', '/P', '/Pg', '/K', '/Alt', '/ActualText', '/Lang'}:
                    raise ValueError('link_metadata_requires_review')
                if tag.get('actualText') != source_tag.get('actualText'):
                    raise ValueError('authored_actual_text_changed')
                allowed_alt = {source_tag.get('alt'), uri}
                generated_local_label = local_group and compact(tag.get('alt') or '') == compact(tag.get('text') or '')
                if (tag.get('alt') not in allowed_alt and not generated_local_label) or ('alt' in source_tag and tag.get('alt') != source_tag['alt']):
                    raise ValueError('link_alternative_requires_review')
                all_refs.extend((entry['pageNumber'], entry['annotationIndex']) for entry in tag['contentSequence'] if entry['kind'] == 'objectReference')
                painted.update(_paint(tag, candidate_paint))
            if sorted(all_refs) != sorted(annotation_keys):
                raise ValueError('source_annotation_group_mismatch')
            expected = _paint(source_tag, source_paint)
            if not painted.issubset(expected):
                raise ValueError('candidate_link_paint_not_in_source_link')
            prefix = None
            missing = expected - painted
            if missing:
                if not uri:
                    raise ValueError('source_title_link_paint_missing')
                if indexes[0] < 1:
                    raise ValueError('source_link_prefix_missing')
                prefix = parent['contentSequence'][indexes[0] - 1]
                prefix_text = compact(prefix.get('text') or '')
                if (prefix.get('kind') != 'markedContent' or prefix.get('resolved') is not True
                        or prefix.get('parentTreeVerified') is not True or prefix.get('streamId') is not None
                        or prefix.get('pageNumber') != source_tag['pageNumber']
                        or not 1 <= len(prefix_text) <= 8
                        or not _visible_uri(uri).startswith(prefix_text)
                        or candidate_paint[prefix['pageNumber']]['owned'].get(prefix['mcid']) != missing):
                    raise ValueError('source_link_prefix_unverified')
            complete_text = (compact(prefix.get('text') or '') if prefix else '') + ''.join(compact(tag['text']) for tag in owners)
            if complete_text != expected_text:
                raise ValueError('complete_visible_uri_unverified')
            if len(owners) == 1 and prefix is None:
                continue
            if any(tag['id'] in claimed for tag in owners):
                raise ValueError('reused_candidate_link_group')
            if len(plans) >= 100:
                raise ValueError('link_group_count_limit')
            removed_refs = {reference_key(native[tag['id']]) for tag in owners[1:]}
            for node in nodes:
                if '/Ref' in node:
                    refs = resolved(node['/Ref'])
                    refs = refs if isinstance(refs, list) else [refs]
                    if any(reference_key(ref) in removed_refs for ref in refs):
                        raise ValueError('externally_referenced_link_requires_review')
            plans.append((source_tag, parent, owners, prefix, uri, expected_text))
            claimed.update(tag['id'] for tag in owners)
        except ValueError as error:
            leave(str(error))
    for source_tag, parent, owners, prefix, uri, expected_text in plans:
        kept = clones[owners[0]['id']]
        kept_ref = kept.indirect_reference
        if kept_ref is None:
            raise ValueError('indirect_link_required')
        parent_clone = clones[parent['id']]
        parent_children = _children(parent_clone)
        original_children = _children(native[parent['id']])
        if len(original_children) != len(parent['contentSequence']):
            raise ValueError('flat_parent_content_required')
        combined = []
        removed = {id(clones[tag['id']]) for tag in owners[1:]}
        prefix_child = None
        if prefix:
            index = parent['contentSequence'].index(prefix)
            prefix_child = original_children[index]
            # The unchanged page MCID is moved between owners, not rewritten.
            copied = prefix_child.clone(writer) if hasattr(prefix_child, 'clone') else prefix_child
            combined.append(copied)
            page_key = integer(writer.pages[prefix['pageNumber'] - 1].get('/StructParents'))
            entries = parent_tree.get(page_key)
            if not isinstance(entries, list) or resolved(entries[prefix['mcid']]) is not parent_clone:
                raise ValueError('prefix_parent_tree_mismatch')
            entries[prefix['mcid']] = kept_ref
        for tag in owners:
            node = clones[tag['id']]
            combined.extend(_children(node))
            for item in tag['contentSequence']:
                if item['kind'] == 'markedContent':
                    page_key = integer(writer.pages[item['pageNumber'] - 1].get('/StructParents'))
                    entries = parent_tree.get(page_key)
                    if not isinstance(entries, list) or resolved(entries[item['mcid']]) is not node:
                        raise ValueError('link_parent_tree_mismatch')
                    entries[item['mcid']] = kept_ref
                else:
                    annotation = resolved(writer.pages[item['pageNumber'] - 1]['/Annots'][item['annotationIndex'] - 1])
                    key = integer(annotation.get('/StructParent'))
                    if resolved(parent_tree.get(key)) is not node:
                        raise ValueError('annotation_parent_tree_mismatch')
                    parent_tree[key] = kept_ref
        kept[NameObject('/K')] = ArrayObject(combined)
        # Source-authored alternatives stay exact. Generated partial-title Alt
        # would otherwise override the newly complete visible Link text.
        if uri is None and 'alt' not in source_tag:
            kept.pop('/Alt', None)
        def retain(child):
            value = resolved(child)
            if id(value) in removed:
                return False
            if prefix is not None:
                if integer(value) == prefix['mcid'] and not isinstance(value, dict):
                    return False
                if isinstance(value, dict) and value.get('/Type') == '/MCR' and integer(value.get('/MCID')) == prefix['mcid']:
                    pg = value.get('/Pg', parent_clone.get('/Pg'))
                    if reference_key(pg) == reference_key(writer.pages[prefix['pageNumber'] - 1]):
                        return False
            return True
        parent_clone[NameObject('/K')] = ArrayObject([child for child in parent_children if retain(child)])
        changes.append({'sourceTagId': source_tag['id'], 'inputTagIds': [tag['id'] for tag in owners],
                        'pageNumber': source_tag['pageNumber'], 'uri': uri,
                        'completeTextSha256': hashlib.sha256(expected_text.encode('utf-8')).hexdigest(),
                        'kind': 'visibleUri' if uri else 'sourceTitle',
                        'movedPrefixMcid': prefix['mcid'] if prefix else None,
                        'annotationIds': [item['annotationId'] for tag in owners for item in tag['contentSequence'] if item['kind'] == 'objectReference'],
                        'sourcePaintMembershipVerified': True})
    tree_root = writer.root_object['/StructTreeRoot']
    # number_tree resolves each value. Scalar annotation owners must remain
    # indirect references; serializing a resolved StructElem here would create
    # a second, detached owner for every annotation outside the repaired groups.
    native_parent_values = []
    for key, entries in sorted(parent_tree.items()):
        value = entries.indirect_reference if isinstance(entries, DictionaryObject) else entries
        if value is None:
            raise ValueError('indirect_parent_tree_owner_required')
        native_parent_values.extend((NumberObject(key), value))
    tree_root[NameObject('/ParentTree')] = writer._add_object(DictionaryObject({NameObject('/Nums'): ArrayObject(native_parent_values)}))
    output_hash = _save(writer, output)
    reopened = PdfReader(output, strict=True)
    after = structure_inventory(reopened)
    before_errors = Counter((item['code'], item.get('page')) for item in candidate_inventory['findings'] if item.get('severity') == 'error')
    after_errors = Counter((item['code'], item.get('page')) for item in after['findings'] if item.get('severity') == 'error')
    if after_errors - before_errors:
        raise ValueError('saved_native_structure_regressed')
    reopened_owners = _owners(after)
    reopened_annotations = _annotations(reopened)
    if annotations.keys() != reopened_annotations.keys() or any(value[1] != reopened_annotations[key][1] for key, value in annotations.items()):
        raise ValueError('saved_annotation_behavior_changed')
    old_canonical, new_canonical = Canonicalizer(list(reader.pages)), Canonicalizer(list(reopened.pages))
    for key, (annotation, _) in annotations.items():
        # Unlike the general behavior fingerprint, this also retains generated
        # descriptions. Grouping only changes ownership in the ParentTree.
        saved_annotation = reopened_annotations[key][0]
        before_values = [(str(k), value) for k, value in sorted(annotation.items()) if k != '/StructParent']
        after_values = [(str(k), value) for k, value in sorted(saved_annotation.items()) if k != '/StructParent']
        if old_canonical.hash(before_values) != new_canonical.hash(after_values):
            raise ValueError('saved_annotation_description_or_behavior_changed')
    for before, after_page in zip(reader.pages, reopened.pages):
        if before.get_contents().get_data() != after_page.get_contents().get_data():
            raise ValueError('saved_drawing_stream_changed')
    for change in changes:
        owners = [reopened_owners[(change['pageNumber'], int(identifier.split('-a')[1]))] for identifier in change['annotationIds']]
        if any(len(matches) != 1 for matches in owners) or len({matches[0][0]['id'] for matches in owners}) != 1:
            raise ValueError('saved_link_group_verification_failed')
        saved = owners[0][0][0]
        _leaves(saved)
        if hashlib.sha256(compact(saved['text']).encode('utf-8')).hexdigest() != change['completeTextSha256']:
            raise ValueError('saved_visible_uri_mismatch')
        change['outputTagId'] = saved['id']
    return {'experimental': True, 'certification': False, 'requires_revalidation': True,
            'sourceSha256': hashlib.sha256(source.stream.getvalue()).hexdigest(),
            'inputSha256': hashlib.sha256(reader.stream.getvalue()).hexdigest(), 'outputSha256': output_hash,
            'changes': changes, 'unresolved': unresolved,
            'localDestinationsChanged': False, 'annotationsAndDrawingStreamsChanged': False}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('original', type=Path)
    parser.add_argument('candidate', type=Path)
    parser.add_argument('output', type=Path)
    parser.add_argument('--report', type=Path, required=True)
    args = parser.parse_args()
    result = restore_source_uri_groups(args.original, args.candidate, args.output)
    args.report.write_text(json.dumps(result, indent=2), encoding='utf-8')
    print(json.dumps({'groupsRestored': len(result['changes']), 'unresolved': len(result['unresolved'])}))
