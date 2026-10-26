"""Restore selected source-bound text scopes wrongly excluded as artifacts.

The semantic planner selects exact exposed scope IDs and native roles. The
writer only changes marked-content wrappers and the corresponding structure
ownership. It never accepts replacement text or model-supplied PDF operators.
"""
from __future__ import annotations

import hashlib
import json

from pypdf import PdfReader, PdfWriter
from pypdf.generic import (ArrayObject, ContentStream, DictionaryObject,
    NameObject as N, NullObject, NumberObject as I)

import bounded_semantic_structure as semantic
import bounded_reading_order as reading
import bounded_interrupted_text as interrupted
import verify_pdf as v

MAX_SCOPES = 100
MAX_PAGE_OPS = 100_000
MAX_TEXT = 16_000
MAX_SCOPE_TEXT = 8_000
MAX_EXTRACTION_WORK = 8_000_000
ROLES = {'P', 'H2', 'H3', 'H4', 'H5', 'H6'}
PARENTS = {'Document', 'Div', 'Sect', 'Part', 'Art'}
ANCHOR_ROLES = {'P', 'H', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'Caption', 'Note'}
UNSAFE = {'duplicate_mcid', 'invalid_mcid', 'unbalanced_marked_content',
    'nested_mcid_scope_unsupported', 'invalid_marked_content_properties',
    'duplicate_structure_content', 'parent_tree_owner_mismatch',
    'unowned_marked_content'}
_PROOF_TOKEN = object()


class ArtifactReadingError(semantic.SemanticStructureError):
    """A fixed diagnostic with no source content."""


def require(condition, code='native_pdf_invalid_plan'):
    if not condition:
        raise ArtifactReadingError(code)


def _hash(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def _children(node):
    value = v.resolved(node.get('/K'))
    return list(value) if isinstance(value, ArrayObject) else [] if value is None else [value]


def _key(node):
    key = v.reference_key(node)
    require(key is not None)
    return list(key)


def _paint(ops):
    return v.drawing_fingerprint(ops, v.Canonicalizer())


def _marks(ops):
    return _hash(semantic.raw([(args, operator.decode('ascii'))
        for args, operator in ops if operator in semantic.MARK]))


def _text_scopes(reader, page, ops, *, work=None):
    """Top-level text-only Artifact windows; pagination remains excluded."""
    require(len(ops) <= MAX_PAGE_OPS, 'pdf_complexity_limit')
    if work is None:
        work = {'used': 0}
    stack, scopes, occurrence = [], [], 0
    for index, (args, operator) in enumerate(ops):
        if operator in (b'BMC', b'BDC'):
            valid = operator == b'BMC' and len(args) == 1 and args[0] == '/Artifact'
            if operator == b'BDC' and len(args) == 2 and args[0] == '/Artifact':
                props = v.resolved(args[1])
                valid = isinstance(props, DictionaryObject) and set(props) <= {'/Type'} and props.get('/Type') in (None, '/Layout')
            if stack:
                for scope in stack:
                    scope['valid'] = False
            stack.append({'start': index, 'valid': valid and not stack,
                'shows': [], 'occurrences': []})
        elif operator == b'EMC':
            if not stack:
                return []
            scope = stack.pop()
            allowed = semantic.TEXT_ONLY | {b'BT', b'ET', b'q', b'Q', b'cm'}
            if (scope['valid'] and scope['shows'] and len(scope['shows']) <= MAX_SCOPES
                    and all(ops[i][1] in allowed for i in range(scope['start'] + 1, index))):
                scope['end'] = index
                # _show_text reparses this page while retaining the exact font
                # state. Charge the whole operation list before doing that work.
                work['used'] += len(ops)
                require(work['used'] <= MAX_EXTRACTION_WORK, 'pdf_complexity_limit')
                text = semantic._show_text(reader, page, ops, set(scope['shows']))
                if text and len(text) <= MAX_SCOPE_TEXT and not any(ord(char) < 32 and char not in '\n\t\r' for char in text):
                    scope['text'] = text
                    scope['paint'] = _paint(ops[scope['start'] + 1:index])
                    scopes.append(scope)
                    require(len(scopes) <= MAX_SCOPES, 'pdf_complexity_limit')
        if operator in semantic.SHOW:
            occurrence += 1
            for scope in stack:
                scope['shows'].append(index)
                scope['occurrences'].append(occurrence)
    return [] if stack else scopes


def _owned_occurrences(ops):
    result, stack, occurrence = {}, [], 0
    for args, operator in ops:
        if operator in (b'BMC', b'BDC'):
            props = v.resolved(args[1]) if operator == b'BDC' and len(args) == 2 else None
            mcid = v.integer(props.get('/MCID')) if isinstance(props, dict) else None
            stack.append(mcid if mcid is not None else stack[-1] if stack else None)
        elif operator == b'EMC':
            require(bool(stack)); stack.pop()
        elif operator in semantic.SHOW:
            occurrence += 1
            if stack and stack[-1] is not None:
                result.setdefault(stack[-1], []).append(occurrence)
    require(not stack)
    return result


def _inventory(reader, inspection):
    if inspection is not None:
        require(type(inspection) is semantic._DiscoveryInspection)
        return inspection.copy_for(reader)
    return v.structure_inventory(reader)


def _discover(reader, *, _inspection=None):
    inventory = _inventory(reader, _inspection)
    native = semantic.nodes(reader)
    require(len(native) == len(inventory['tags']))
    by_id = {tag['id']: tag for tag in inventory['tags']}
    nodes = {tag['id']: node for tag, node in zip(inventory['tags'], native)}
    parents = v.number_tree(v.resolved(reader.trailer['/Root']['/StructTreeRoot']).get('/ParentTree'))
    source = semantic.source_digest(reader)
    unsafe = {finding.get('page') for finding in inventory['findings'] if finding['code'] in UNSAFE}
    output, work = [], {'used': 0}
    for pn, page in enumerate(reader.pages, 1):
        if pn in unsafe:
            continue
        info = inventory['page_content'][pn - 1]
        if not info.get('artifactTextComplete') or not info.get('artifact_text_operators'):
            continue
        ops = v.operations(page)
        if len(ops) > MAX_PAGE_OPS:
            continue
        scopes = _text_scopes(reader, page, ops, work=work)
        if not scopes or len(scopes) > MAX_SCOPES or sum(len(scope['text']) for scope in scopes) > MAX_TEXT:
            continue
        parent_array = parents.get(v.integer(page.get('/StructParents')))
        if not isinstance(parent_array, ArrayObject):
            continue
        anchors = [tag for tag in inventory['tags'] if tag.get('pageNumber') == pn
            and tag.get('role') in ANCHOR_ROLES and semantic._heading_leaf(tag, nodes[tag['id']])
            and by_id.get(tag.get('parentId'), {}).get('role') in PARENTS]
        if not anchors:
            continue
        # The last eligible leaf often represents a footer and is less likely
        # to participate in another repair of an earlier body paragraph.
        anchor = anchors[-1]
        public_scopes = []
        for scope in scopes:
            scope['scopeId'] = _hash({'source': source, 'page': pn,
                'occurrences': scope['occurrences'], 'paint': scope['paint']})
            public_scopes.append({'scopeId': scope['scopeId'], 'text': scope['text']})
        detail = {'source': source, 'pageNumber': pn, 'parentId': anchor['parentId'],
            'scopes': scopes, 'pagePaint': _paint(ops),
            'resources': v.Canonicalizer().hash(page.get('/Resources', {}))}
        identifier = _hash({'source': source, 'page': pn, 'anchor': anchor['id'],
            'scopeIds': [item['scopeId'] for item in scopes], 'paint': detail['pagePaint']})
        public = {'kind': 'restore_artifact_text', 'candidateId': identifier,
            'tagId': anchor['id'], 'pageNumber': pn, 'relatedTagIds': [],
            'text': '\n'.join(scope['text'] for scope in scopes),
            'textScopes': public_scopes,
            'preview': 'Select meaningful excluded text scopes and their native roles. Each selected source scope is restored in its verified page text-show order; unselected artifact scopes remain excluded. The existing anchor is retained.'}
        output.append((public, detail))
    return output, inventory, nodes


def discover_candidates(reader, *, _inspection=None):
    return [public for public, _ in _discover(reader, _inspection=_inspection)[0]]


def _page_number(value, pages):
    key = v.reference_key(value)
    return next((i + 1 for i, page in enumerate(pages) if v.reference_key(page) == key), None)


def _first_occurrence(node, pn, occurrences, pages, inherited=None, depth=0):
    require(depth <= 64, 'pdf_complexity_limit')
    page = _page_number(node.get('/Pg'), pages) if '/Pg' in node else inherited
    found = []
    for value in _children(node):
        child = v.resolved(value)
        mcid = v.integer(child)
        if mcid is not None:
            if page == pn:
                found.extend(occurrences.get(mcid, []))
        elif isinstance(child, DictionaryObject) and child.get('/Type') == '/MCR':
            child_page = _page_number(child.get('/Pg'), pages) if '/Pg' in child else page
            if child_page == pn and '/Stm' not in child:
                found.extend(occurrences.get(v.integer(child.get('/MCID')), []))
        elif isinstance(child, DictionaryObject) and child.get('/Type') != '/OBJR':
            value = _first_occurrence(child, pn, occurrences, pages, page, depth + 1)
            if value is not None:
                found.append(value)
    return min(found) if found else None


def _node_signature(node, pages):
    children = []
    for value in _children(node):
        child = v.resolved(value)
        if isinstance(child, DictionaryObject) and child.get('/Type') not in ('/MCR', '/OBJR'):
            children.append({'node': _key(child)})
        else:
            children.append({'content': v.Canonicalizer(pages).value(value)})
    return {'attributes': v.Canonicalizer(pages).value(DictionaryObject({key: value
            for key, value in node.items() if key not in ('/P', '/K')})),
        'parent': _key(v.resolved(node['/P'])), 'children': children}


def _array_owners(array):
    result = []
    for value in array:
        owner = v.resolved(value)
        if isinstance(owner, NullObject):
            result.append(None)
        else:
            require(isinstance(owner, DictionaryObject))
            result.append(_key(owner))
    return result


class _ArtifactProof:
    __slots__ = ('_payload',)

    def __init__(self, token, entries):
        require(token is _PROOF_TOKEN)
        object.__setattr__(self, '_payload', json.dumps(entries, sort_keys=True, separators=(',', ':')))

    def __setattr__(self, key, value):
        require(False)

    @property
    def entries(self):
        return json.loads(self._payload)


def apply_operations(source_reader, writer, operations, *, _inspection=None,
                     _source_nodes=None, _target_nodes=None, _prior_verifications=()):
    require(isinstance(operations, list) and len(operations) <= 60)
    discovered, inventory, original = _discover(source_reader, _inspection=_inspection)
    source_nodes = original if _source_nodes is None else _source_nodes
    require(set(source_nodes) == set(original) and all(source_nodes[key] is original[key] for key in original))
    if _target_nodes is None:
        native = semantic.nodes(writer)
        require(len(native) == len(original))
        targets = dict(zip(original, native))
    else:
        targets = _target_nodes
    require(isinstance(targets, dict) and set(targets) == set(original))
    options = {public['candidateId']: (public, detail) for public, detail in discovered}
    protected_windows, protected_nodes = [], set()
    for module, proof in _prior_verifications:
        if module is reading:
            require(type(proof) is reading._Verification)
            protected_windows.extend(proof._windows)
            protected_nodes.update(key for key, _ in proof._nodes)
        elif module is interrupted:
            protected_windows.extend(interrupted.protected_windows(proof))
            protected_nodes.update(tuple(item['key']) for item in proof.payload['nodes'])
    parents = v.number_tree(v.resolved(writer.root_object['/StructTreeRoot']).get('/ParentTree'))
    used_pages, changes, lineage, proofs = set(), [], [], []
    for operation in operations:
        require(isinstance(operation, dict) and set(operation) <= {'type', 'tagId', 'candidateId', 'selections', 'anchorRole'}
            and set(operation) >= {'type', 'tagId', 'candidateId', 'selections'}
            and operation.get('type') == 'repair_structure' and operation.get('candidateId') in options)
        public, detail = options[operation['candidateId']]
        require(operation['tagId'] == public['tagId'])
        pn = public['pageNumber']
        require(pn not in used_pages); used_pages.add(pn)
        selections = operation['selections']
        require(isinstance(selections, list) and 1 <= len(selections) <= MAX_SCOPES)
        scopes = {scope['scopeId']: scope for scope in detail['scopes']}
        selected, used = [], set()
        for item in selections:
            require(isinstance(item, dict) and set(item) == {'scopeId', 'role'}
                and item.get('scopeId') in scopes and item['scopeId'] not in used and item.get('role') in ROLES)
            used.add(item['scopeId']); selected.append((scopes[item['scopeId']], item['role']))
        selected.sort(key=lambda value: value[0]['occurrences'][0])
        page, parent, anchor = writer.pages[pn - 1], targets[detail['parentId']], targets[public['tagId']]
        require(any(v.resolved(child) is anchor for child in _children(parent)))
        if 'anchorRole' in operation:
            require(operation['anchorRole'] == 'P' and semantic._heading_leaf(
                next(tag for tag in inventory['tags'] if tag['id'] == public['tagId']), anchor)
                and str(anchor.get('/S', '')).lstrip('/') in ANCHOR_ROLES)
            require(tuple(_key(anchor)) not in protected_nodes or anchor.get('/S') == '/P')
            anchor[N('/S')] = N('/P')
        ops = v.operations(page)
        require(_paint(ops) == detail['pagePaint']
            and v.Canonicalizer().hash(page.get('/Resources', {})) == detail['resources'], 'native_pdf_preservation')
        current = _text_scopes(writer, page, ops)
        matched = {(tuple(scope['occurrences']), scope['paint']): scope for scope in current}
        array_key = v.integer(page.get('/StructParents'))
        array = parents.get(array_key)
        require(isinstance(array, ArrayObject))
        before_owners = _array_owners(array)
        occurrences = _owned_occurrences(ops)
        next_mcid = max([len(array) - 1, *occurrences], default=-1) + 1
        replacements, added, added_proofs = {}, [], []
        for source, role in selected:
            scope = matched.get((tuple(source['occurrences']), source['paint']))
            require(scope is not None and scope['text'] == source['text'])
            mcid = next_mcid; next_mcid += 1
            require(mcid <= 100_000, 'pdf_complexity_limit')
            node = semantic._new_tag(writer, role, parent, page, I(mcid))
            while len(array) <= mcid:
                array.append(NullObject())
            require(isinstance(v.resolved(array[mcid]), NullObject))
            array[mcid] = semantic._reference(writer, node)
            replacements[scope['start']] = ([N('/' + role), DictionaryObject({N('/MCID'): I(mcid)})], b'BDC')
            occurrences[mcid] = source['occurrences']
            added.append((node, source['occurrences'][0]))
            lineage.append({'node': node, 'sourceTagId': public['tagId']})
            added_proofs.append({'node': _key(node), 'mcid': mcid, 'role': role,
                'text': source['text'], 'occurrences': source['occurrences'], 'scopeId': source['scopeId']})
        kids = _children(parent)
        for node, ordinal in added:
            positions = [_first_occurrence(v.resolved(child), pn, occurrences, writer.pages)
                if isinstance(v.resolved(child), DictionaryObject) else None for child in kids]
            at = next((index for index, position in enumerate(positions) if position is not None and position > ordinal), None)
            if at is None:
                positions = [index for index, position in enumerate(positions) if position is not None]
                require(bool(positions)); at = positions[-1] + 1
            child_keys = tuple(v.reference_key(v.resolved(child))
                if isinstance(v.resolved(child), DictionaryObject) else None for child in kids)
            for parent_key, window in protected_windows:
                if parent_key != tuple(_key(parent)):
                    continue
                starts = [index for index in range(len(child_keys))
                    if child_keys[index:index + len(window)] == window]
                require(len(starts) == 1, 'native_pdf_preservation')
                # A verified uninterrupted paragraph or callout must stay
                # uninterrupted. The model must not combine conflicting plans.
                require(not (starts[0] < at < starts[0] + len(window)))
            kids.insert(at, semantic._reference(writer, node))
        parent[N('/K')] = ArrayObject(kids)
        changed = [(replacements[index] if index in replacements else
            ([semantic._freeze(arg) for arg in args] if operator in semantic.SHOW else args, operator))
            for index, (args, operator) in enumerate(ops)]
        require(_paint(changed) == detail['pagePaint'], 'native_pdf_preservation')
        require(_array_owners(array)[:len(before_owners)] == before_owners, 'native_pdf_preservation')
        stream = ContentStream(None, writer); stream.operations = changed
        page[N('/Contents')] = writer._add_object(stream)
        proofs.append({'pageNumber': pn, 'paint': _paint(changed), 'marks': _marks(changed),
            'resources': detail['resources'], 'parent': _key(parent),
            'parentSignature': _node_signature(parent, writer.pages), 'anchor': _key(anchor),
            'anchorSignature': _node_signature(anchor, writer.pages),
            'parentTreeKey': array_key, 'parentArrayOwners': _array_owners(array), 'added': added_proofs})
        changes.append({'code': 'restore_artifact_text', 'pageNumber': pn,
            'tagId': public['tagId'], 'candidateId': public['candidateId'],
            'message': 'Restored selected existing text to screen-reader reading order without changing its wording or page appearance.'})
    # Different pages commonly share a Document parent. Snapshot that parent's
    # final child order only after all selected page scopes have been inserted.
    final_nodes = {tuple(_key(node)): node for node in semantic.nodes(writer)}
    for proof in proofs:
        proof['parentSignature'] = _node_signature(final_nodes[tuple(proof['parent'])], writer.pages)
        proof['anchorSignature'] = _node_signature(final_nodes[tuple(proof['anchor'])], writer.pages)
    return {'changes': changes, 'lineage': lineage, 'verification': _ArtifactProof(_PROOF_TOKEN, proofs)}


def verify_saved(reader, verification, *, _inspection=None):
    require(type(verification) is _ArtifactProof, 'native_pdf_preservation')
    inventory = _inventory(reader, _inspection)
    native = semantic.nodes(reader)
    require(len(native) == len(inventory['tags']), 'native_pdf_preservation')
    nodes = {tuple(_key(node)): node for node in native}
    tags = {tuple(_key(node)): tag for node, tag in zip(native, inventory['tags'])}
    parents = v.number_tree(v.resolved(reader.trailer['/Root']['/StructTreeRoot']).get('/ParentTree'))
    for proof in verification.entries:
        pn = proof['pageNumber']; page = reader.pages[pn - 1]; ops = v.operations(page)
        require(_paint(ops) == proof['paint'] and _marks(ops) == proof['marks']
            and v.Canonicalizer().hash(page.get('/Resources', {})) == proof['resources'], 'native_pdf_preservation')
        parent, anchor = nodes.get(tuple(proof['parent'])), nodes.get(tuple(proof['anchor']))
        require(parent is not None and anchor is not None
            and _node_signature(parent, reader.pages) == proof['parentSignature']
            and _node_signature(anchor, reader.pages) == proof['anchorSignature'], 'native_pdf_preservation')
        array = parents.get(proof['parentTreeKey'])
        require(isinstance(array, ArrayObject) and _array_owners(array) == proof['parentArrayOwners'], 'native_pdf_preservation')
        occurrences = _owned_occurrences(ops)
        for added in proof['added']:
            node = nodes.get(tuple(added['node'])); tag = tags.get(tuple(added['node']))
            require(node is not None and tag is not None and tag.get('role') == added['role']
                and tag.get('pageNumber') == pn and tag.get('text', '').strip() == added['text'].strip()
                and tag.get('mcids') == [added['mcid']] and not tag.get('textIncomplete')
                and all(item.get('resolved') is True and item.get('parentTreeVerified') is True
                    for item in tag.get('contentSequence', []))
                and occurrences.get(added['mcid']) == added['occurrences'], 'native_pdf_preservation')
    return True
