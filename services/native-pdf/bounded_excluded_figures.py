"""Restore an excluded native owner of existing, verified Figure painting.

Only the native role and its new description change. The original content
stream, MCID owner, native ID, attributes, and page appearance stay intact.
Selection and a full visible-content description remain semantic decisions.
"""
from __future__ import annotations

import hashlib
import json

from pypdf.generic import (ArrayObject, DictionaryObject, NameObject as N,
    TextStringObject)

import bounded_semantic_structure as semantic
import native_image_alternatives as alternatives
import verify_pdf as v

MAX_CANDIDATES = 200
MAX_PAGE_OPS = 100_000
MAX_SUBTREE_NODES = 12
SCOPE_KEYS = ('marks', 'paint', 'name', 'textOnly')
GRAPHIC_PAINT = {b'S', b's', b'f', b'F', b'f*', b'B', b'B*', b'b', b'b*', b'sh', b'Do', b'INLINE IMAGE'}
UNSAFE = {'duplicate_mcid', 'invalid_mcid', 'unbalanced_marked_content',
    'nested_mcid_scope_unsupported', 'invalid_marked_content_properties',
    'duplicate_structure_content', 'parent_tree_owner_mismatch',
    'unowned_marked_content'}
_PROOF_TOKEN = object()


class ExcludedFigureError(semantic.SemanticStructureError):
    """A fixed diagnostic without document contents."""


def require(condition, code='native_pdf_invalid_plan'):
    if not condition:
        raise ExcludedFigureError(code)


def _hash(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def _key(node):
    key = v.reference_key(node)
    require(key is not None)
    return list(key)


def _children(node):
    value = v.resolved(node.get('/K'))
    return list(value) if isinstance(value, ArrayObject) else [] if value is None else [value]


def _shape(node, pages):
    canonical, seen = v.Canonicalizer(list(pages)), set()
    def visit(current, depth=0):
        require(depth <= 2 and id(current) not in seen and len(seen) < MAX_SUBTREE_NODES)
        seen.add(id(current))
        omitted = {'/P', '/K'} | ({'/S', '/Alt'} if depth == 0 else set())
        attributes = canonical.value(DictionaryObject({key: value for key, value in current.items() if key not in omitted}))
        children = []
        for raw in _children(current):
            child = v.resolved(raw)
            children.append({'node': visit(child, depth + 1)} if isinstance(child, DictionaryObject) and '/S' in child
                else {'content': canonical.value(raw)})
        return {'attributes': attributes, 'children': children,
            'childrenArray': isinstance(v.resolved(current.get('/K')), ArrayObject),
            'childrenPresent': '/K' in current}
    return visit(node)


def _paint(page):
    return v.drawing_fingerprint(v.operations(page), v.Canonicalizer())


def _ancestors_clear(node):
    seen = set()
    for _ in range(64):
        node = v.resolved(node)
        if not isinstance(node, DictionaryObject) or id(node) in seen:
            return False
        seen.add(id(node))
        if any(key in node for key in ('/Alt', '/ActualText', '/E', '/Ref')):
            return False
        if node.get('/S') == '/Artifact':
            return False
        if node.get('/Type') == '/StructTreeRoot':
            return True
        node = node.get('/P')
    return False


def _scopes(page):
    """Exact top-level Figure MCIDs; harmless clipping wrappers may nest."""
    ops = v.operations(page)
    if len(ops) > MAX_PAGE_OPS:
        return {}
    stack, found, declared = [], {}, set()
    properties = v.resolved(v.resolved(page.get('/Resources', {})).get('/Properties', {}))
    assets = v.resolved(v.resolved(page.get('/Resources', {})).get('/XObject', {}))
    for index, (args, operator) in enumerate(ops):
        if operator in (b'BMC', b'BDC'):
            if not args or len(stack) >= 64:
                return {}
            props, mcid = None, None
            if operator == b'BDC':
                if len(args) != 2:
                    return {}
                props = v.resolved(args[1])
                if isinstance(props, N):
                    props = v.resolved(properties.get(props)) if isinstance(properties, dict) else None
                if not isinstance(props, DictionaryObject):
                    return {}
                if '/MCID' in props:
                    mcid = v.integer(props['/MCID'])
                    if mcid is None or mcid < 0 or mcid in declared or any(scope['mcid'] is not None for scope in stack):
                        return {}
                    declared.add(mcid)
            elif len(args) != 1:
                return {}
            bad = args[0] == '/Artifact' or (isinstance(props, dict) and any(key in props for key in ('/Alt', '/ActualText')))
            if bad:
                for scope in stack:
                    scope['safe'] = False
            safe = (mcid is not None and args[0] in ('/Figure', '/P', '/Caption') and set(props) == {'/MCID'}
                and not any(scope['name'] == '/Artifact' or not scope['clear'] for scope in stack))
            stack.append({'mcid': mcid, 'name': args[0], 'start': index,
                'safe': safe, 'clear': not bad, 'textOnly': True})
        elif operator == b'EMC':
            if not stack:
                return {}
            scope = stack.pop()
            if scope['mcid'] is not None and scope['safe']:
                body = ops[scope['start']:index + 1]
                scope['marks'] = _hash(semantic.raw([(args, op.decode('ascii')) for args, op in body if op in semantic.MARK]))
                scope['paint'] = v.drawing_fingerprint(body, v.Canonicalizer())
                found[scope['mcid']] = scope
        elif operator in GRAPHIC_PAINT and stack:
            for scope in stack:
                scope['textOnly'] = False
            if operator in (b'Do', b'INLINE IMAGE'):
                asset = v.resolved(assets.get(args[0])) if operator == b'Do' and len(args) == 1 and isinstance(assets, dict) else None
                if not isinstance(asset, DictionaryObject) or asset.get('/Subtype') != '/Image':
                    for scope in stack:
                        scope['safe'] = False
    return {} if stack else found


def _subtree(root_tag, by_id, nodes, *, restored=False):
    """One Figure owner, optionally simple Caption/P children on its page."""
    page_number, found, active = root_tag.get('pageNumber'), [], set()
    def visit(tag, depth=0, parent_role=None):
        node = nodes[tag['id']]
        role = tag.get('role')
        expected_root = 'Figure' if restored else 'Artifact'
        if (depth > 2 or tag['id'] in active or len(found) >= MAX_SUBTREE_NODES
                or role != tag.get('sourceRole') or node.get('/S') != '/' + str(role)
                or (depth == 0 and role != expected_root)
                or (depth > 0 and role not in ('Caption', 'P'))
                or (depth > 1 and (role != 'P' or parent_role != 'Caption'))
                or tag.get('pageNumber') != page_number or tag.get('textIncomplete') or tag.get('attributeGaps')
                or any(key in node for key in ('/ActualText', '/E', '/Ref', '/AA', '/AF', '/Action', '/Dest'))
                or ('/Alt' in node and not (restored and depth == 0))
                or ('/ID' in node and tag.get('idTreeVerified') is not True)
                or any(item.get('owner') != 'Layout' for item in tag.get('attributes', []))):
            return False
        active.add(tag['id']); found.append(tag)
        parts = tag.get('contentSequence', [])
        children, owned = [], []
        for part in parts:
            if part.get('kind') == 'markedContent':
                if (part.get('resolved') is not True or part.get('parentTreeVerified') is not True
                        or part.get('pageNumber') != page_number or 'streamId' in part):
                    return False
                owned.append(part['mcid'])
            elif part.get('kind') == 'childTag' and part.get('resolved') is True:
                child = by_id.get(part.get('tagId'))
                if (child is None or child.get('parentId') != tag['id']
                        or v.resolved(nodes[child['id']].get('/P')) is not node):
                    return False
                children.append(child)
            else:
                return False
        native_children = [v.resolved(child) for child in _children(node)
            if isinstance(v.resolved(child), DictionaryObject) and '/S' in v.resolved(child)]
        if (len(native_children) != len(children)
                or any(node is not nodes[child['id']] for node, child in zip(native_children, children))
                or (depth == 0 and not owned)
                or (role == 'P' and (children or not owned or not tag.get('text', '').strip()))
                or (role == 'Caption' and not (owned or children))
                or sum(child.get('role') == 'Caption' for child in children) > 1):
            return False
        for child in children:
            if not visit(child, depth + 1, role):
                return False
        return True
    if not visit(root_tag) or sum(len(tag.get('text', '')) for tag in found) > 16_000:
        return None
    all_mcids = [part['mcid'] for tag in found for part in tag.get('contentSequence', []) if part.get('kind') == 'markedContent']
    return found if len(all_mcids) <= 32 and len(set(all_mcids)) == len(all_mcids) else None


def _inventory(reader, inspection):
    if inspection is not None:
        require(type(inspection) is semantic._DiscoveryInspection)
        return inspection.copy_for(reader)
    return v.structure_inventory(reader)


def _membership(scan, page, mcids):
    events = set().union(*(scan['owned'].get(mcid, set()) for mcid in mcids))
    if not events or scan['gaps'] or events & scan['artifactEvents']:
        return None
    return _hash([{'pageNumber': page, 'executionHash': scan['executionHash'],
        'resourcesHash': scan['resourcesHash'], 'paintOccurrences': sorted(events)}])


def _discover(reader, *, _inspection=None):
    inventory = _inventory(reader, _inspection)
    native = semantic.nodes(reader)
    require(len(native) == len(inventory['tags']))
    nodes = {tag['id']: node for tag, node in zip(inventory['tags'], native)}
    by_id = {tag['id']: tag for tag in inventory['tags']}
    unsafe = {finding.get('page') for finding in inventory['findings'] if finding['code'] in UNSAFE}
    source_hash = semantic.source_digest(reader)
    page_paint = v.figure_association_inventory(reader)['pages']
    scopes, output = {}, []
    for tag in inventory['tags']:
        node, page_number = nodes[tag['id']], tag.get('pageNumber')
        if (tag.get('role') != 'Artifact' or node.get('/S') != '/Artifact'
                or not isinstance(page_number, int) or page_number in unsafe
                or tag.get('textIncomplete') or tag.get('attributeGaps')
                or any(key in node for key in ('/Alt', '/ActualText', '/E', '/Ref'))
                or not _ancestors_clear(node.get('/P'))
                or ('/ID' in node and tag.get('idTreeVerified') is not True)):
            continue
        members = _subtree(tag, by_id, nodes)
        if members is None:
            continue
        if page_number not in scopes:
            scopes[page_number] = _scopes(reader.pages[page_number - 1])
        mcids = tag['mcids']
        all_mcids = [mcid for member in members for mcid in member['mcids']]
        if any(mcid not in scopes[page_number] for mcid in all_mcids):
            continue
        if any(scopes[page_number][mcid]['name'] != '/Figure' for mcid in mcids):
            continue
        if any(scopes[page_number][mcid]['name'] != '/' + member['role'] or not scopes[page_number][mcid]['textOnly']
                for member in members[1:] for mcid in member['mcids']):
            continue
        membership = _membership(page_paint[page_number], page_number, all_mcids)
        if membership is None:
            continue
        detail = {'sourceSha256': source_hash, 'shape': _shape(node, reader.pages),
            'mcids': mcids, 'allMcids': all_mcids, 'membershipHash': membership,
            'members': [{'sourceTagId': member['id'], 'role': member['role'], 'mcids': member['mcids']} for member in members],
            'scopes': {str(mcid): {key: scopes[page_number][mcid][key] for key in SCOPE_KEYS} for mcid in all_mcids},
            'pagePaint': _paint(reader.pages[page_number - 1]),
            'resources': v.Canonicalizer().hash(reader.pages[page_number - 1].get('/Resources', {}))}
        public = {'kind': 'restore_excluded_figure', 'tagId': tag['id'], 'pageNumber': page_number,
            'text': '\n'.join(member.get('text', '') for member in members)[:16000],
            'relatedTagIds': [member['id'] for member in members[1:]],
            'preview': 'This excluded native object owns existing Figure graphics. Restore meaningful content with a complete description, including all essential visible wording, numbers, and chart information. Leave purely decorative content excluded.'}
        public['candidateId'] = _hash({'source': source_hash, **public, 'details': detail})
        output.append((public, detail))
        require(len(output) <= MAX_CANDIDATES, 'pdf_complexity_limit')
    return output, inventory, nodes


def discover_candidates(reader, *, _inspection=None):
    return [public for public, _ in _discover(reader, _inspection=_inspection)[0]]


class _ExcludedFigureProof:
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
    require(isinstance(operations, list) and len(operations) <= MAX_CANDIDATES)
    found, inventory, original = _discover(source_reader, _inspection=_inspection)
    source_nodes = original if _source_nodes is None else _source_nodes
    require(type(source_nodes) is dict and set(source_nodes) == set(original)
        and all(source_nodes[key] is original[key] for key in original))
    if _target_nodes is None:
        native = semantic.nodes(writer)
        require(len(native) == len(original))
        targets = dict(zip(original, native))
    else:
        targets = _target_nodes
    reachable = {id(node) for node in semantic.nodes(writer)}
    require(type(targets) is dict and set(targets) == set(original)
        and len({id(node) for node in targets.values()}) == len(targets)
        and all(id(node) in reachable for node in targets.values()))
    options, used, selected = {public['candidateId']: (public, detail) for public, detail in found}, set(), []
    for operation in operations:
        require(isinstance(operation, dict) and set(operation) == {'type', 'tagId', 'candidateId', 'alt'}
            and operation.get('type') == 'repair_structure' and operation.get('candidateId') in options)
        public, detail = options[operation['candidateId']]
        identifier, alt = operation['tagId'], operation['alt']
        participants = {public['tagId'], *public['relatedTagIds']}
        require(identifier == public['tagId'] and not participants.intersection(used)
            and alternatives._valid_replacement(alt))
        used.update(participants)
        target = targets[identifier]
        require(target.get('/S') == '/Artifact' and '/Alt' not in target and '/ActualText' not in target
            and _shape(target, writer.pages) == detail['shape'] and _ancestors_clear(target.get('/P')),
            'native_pdf_preservation')
        original_parent = v.resolved(original[identifier].get('/P'))
        mapped = next((targets[key] for key, value in original.items() if value is original_parent), None)
        expected_parent = mapped if mapped is not None else v.resolved(writer.root_object.get('/StructTreeRoot'))
        require(v.resolved(target.get('/P')) is expected_parent
            and sum(v.resolved(child) is target for child in _children(expected_parent)) == 1,
            'native_pdf_preservation')
        for member in detail['members'][1:]:
            child = targets[member['sourceTagId']]
            source_parent = v.resolved(original[member['sourceTagId']].get('/P'))
            mapped_parent = next((targets[key] for key, node in original.items() if node is source_parent), None)
            require(mapped_parent is not None and v.resolved(child.get('/P')) is mapped_parent
                and sum(v.resolved(raw) is child for raw in _children(mapped_parent)) == 1,
                'native_pdf_preservation')
        pn = public['pageNumber']; page = writer.pages[pn - 1]
        current_scopes = _scopes(page)
        require(_paint(page) == detail['pagePaint']
            and v.Canonicalizer().hash(page.get('/Resources', {})) == detail['resources']
            and all(mcid in current_scopes and all(current_scopes[mcid][key] == expected[key]
                for key in SCOPE_KEYS) for mcid, expected in ((int(mcid), value) for mcid, value in detail['scopes'].items())),
            'native_pdf_preservation')
        selected.append((public, detail, target, alt.strip()))
    changes, proofs = [], []
    for public, detail, target, alt in selected:
        target[N('/S')] = N('/Figure')
        target[N('/Alt')] = TextStringObject(alt)
        proofs.append({**detail, 'node': _key(target), 'parent': _key(v.resolved(target['/P'])),
            'pageNumber': public['pageNumber'], 'alt': alt,
            'savedMembers': [{'node': _key(targets[member['sourceTagId']]),
                'parent': _key(v.resolved(targets[member['sourceTagId']]['/P'])),
                'role': 'Figure' if member['sourceTagId'] == public['tagId'] else member['role'],
                'mcids': member['mcids']} for member in detail['members']]})
        changes.append({'code': 'restore_excluded_figure', 'candidateId': public['candidateId'],
            'tagId': public['tagId'], 'pageNumber': public['pageNumber'],
            'message': 'Restored an existing excluded graphic and its description without changing its page appearance.'})
    return {'changes': changes, 'lineage': [{'node': node, 'sourceTagId': key} for key, node in targets.items()],
        'verification': _ExcludedFigureProof(_PROOF_TOKEN, proofs)}


def verify_saved(reader, verification, *, _inspection=None):
    require(type(verification) is _ExcludedFigureProof, 'native_pdf_preservation')
    inventory = _inventory(reader, _inspection)
    native = semantic.nodes(reader)
    require(len(native) == len(inventory['tags']), 'native_pdf_preservation')
    nodes = {tuple(_key(node)): node for node in native}
    tags = {tuple(_key(node)): tag for node, tag in zip(native, inventory['tags'])}
    by_id = {tag['id']: tag for tag in inventory['tags']}
    by_tag_id = {tag['id']: node for node, tag in zip(native, inventory['tags'])}
    figures = v.figure_association_inventory(reader)['figures']
    for proof in verification.entries:
        node, tag = nodes.get(tuple(proof['node'])), tags.get(tuple(proof['node']))
        require(node is not None and tag is not None and node.get('/S') == '/Figure'
            and node.get('/Alt') == proof['alt'] and '/ActualText' not in node
            and _shape(node, reader.pages) == proof['shape'] and _ancestors_clear(node.get('/P'))
            and _key(v.resolved(node.get('/P'))) == proof['parent']
            and sum(v.resolved(child) is node for child in _children(v.resolved(node['/P']))) == 1
            and ('/ID' not in node or tag.get('idTreeVerified') is True)
            and tag.get('pageNumber') == proof['pageNumber'] and tag.get('mcids') == proof['mcids']
            and _subtree(tag, by_id, by_tag_id, restored=True) is not None,
            'native_pdf_preservation')
        for member in proof['savedMembers']:
            child, current = nodes.get(tuple(member['node'])), tags.get(tuple(member['node']))
            require(child is not None and current is not None and current.get('role') == member['role']
                and current.get('mcids') == member['mcids']
                and _key(v.resolved(child.get('/P'))) == member['parent'], 'native_pdf_preservation')
        matches = [figure for figure in figures if figure['membershipHash'] == proof['membershipHash']]
        require(len(matches) == 1 and matches[0]['supported'] and matches[0].get('alt') == proof['alt']
            and 'actualText' not in matches[0], 'native_pdf_preservation')
        page = reader.pages[proof['pageNumber'] - 1]; scopes = _scopes(page)
        require(_paint(page) == proof['pagePaint']
            and v.Canonicalizer().hash(page.get('/Resources', {})) == proof['resources']
            and all(int(mcid) in scopes and all(scopes[int(mcid)][key] == expected[key]
                for key in SCOPE_KEYS) for mcid, expected in proof['scopes'].items()), 'native_pdf_preservation')
    return True
