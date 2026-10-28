"""Join a verified pair of native text fragments interrupted by a styled note.

The planner may confirm one discovered adjacent triple; it cannot supply a new
ordering or new words. Source geometry and fonts bound the possible pattern.
Only the structure tree changes. Existing text owners, IDs and paint survive.
"""
from __future__ import annotations

import hashlib
import json
import re
import statistics

from pypdf.generic import (ArrayObject, ByteStringObject, DictionaryObject,
    NameObject as N, TextStringObject)

import bounded_semantic_structure as semantic
import bounded_reading_order as reading
import verify_pdf as v

MAX_CANDIDATES = 100
MAX_PAGE_OPS = 100_000
LEAF_KEYS = {'/Type', '/S', '/P', '/Pg', '/K', '/A', '/C', '/ID', '/Lang'}
PARENTS = {'Document', 'Part', 'Art', 'Sect', 'Div'}
UNSAFE = reading.UNSAFE_FINDINGS | {'unowned_marked_content'}
_TOKEN = object()


class InterruptedTextError(semantic.SemanticStructureError):
    """A controlled diagnostic without source text."""


def require(condition, code='native_pdf_invalid_plan'):
    if not condition:
        raise InterruptedTextError(code)


def _json(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'))


def _hash(value):
    return hashlib.sha256(_json(value).encode()).hexdigest()


def _key(node):
    value = v.reference_key(node)
    require(value is not None)
    return tuple(value)


def _root(reader):
    return v.resolved(reader.root_object['/StructTreeRoot'])


def _inventory(reader, inspection):
    if inspection is not None:
        require(type(inspection) is semantic._DiscoveryInspection)
        return inspection.copy_for(reader)
    return v.structure_inventory(reader)


def _nonempty_show(value):
    if isinstance(value, TextStringObject):
        return bool(value.original_bytes.strip(b'\x00\t\n\r\f '))
    if isinstance(value, (ByteStringObject, bytes)):
        return bool(bytes(value).strip(b'\x00\t\n\r\f '))
    return isinstance(value, (list, ArrayObject)) and any(_nonempty_show(child) for child in value)


def _page_features(page):
    ops = v.operations(page)
    require(len(ops) <= MAX_PAGE_OPS, 'pdf_complexity_limit')
    scopes = semantic._scopes(ops, allow_text_boundaries=True)
    states, points = semantic._states(page, ops), reading._positions(page)
    resources = v.resolved(v.resolved(page.get('/Resources', {})).get('/Font', {}))
    font_hashes, result = {}, {}
    for mcid, scope in scopes.items():
        if mcid not in points:
            continue
        fonts = set()
        for index in scope['shows']:
            if not _nonempty_show(ops[index][0]):
                continue
            name = states.get(index, {}).get('font')
            if name not in resources:
                fonts.add(None); continue
            if name not in font_hashes:
                font_hashes[name] = v.Canonicalizer().hash(resources[name])
            fonts.add(font_hashes[name])
        if len(fonts) == 1 and None not in fonts:
            result[mcid] = {'font': next(iter(fonts)), 'points': points[mcid]}
    return result


def _leaf(tag, node):
    content = tag.get('contentSequence', [])
    native = reading._children(node)
    return (tag.get('role') == 'P' and not tag.get('textIncomplete')
        and not tag.get('attributeGaps') and set(node) <= LEAF_KEYS
        and isinstance(tag.get('pageNumber'), int) and 1 <= len(content) <= 4
        and len(native) == len(content) and all(
            item.get('kind') == 'markedContent' and item.get('resolved') is True
            and item.get('parentTreeVerified') is True and 'streamId' not in item
            and item.get('pageNumber') == tag['pageNumber']
            and v.integer(owner) == item.get('mcid')
            for item, owner in zip(content, native)))


def _pattern(tags, features):
    texts = [reading._text(tag) for tag in tags]
    if (not 40 <= len(texts[0]) <= 1200 or not 1 <= len(texts[1]) <= 120
        or not 1 <= len(texts[2]) <= 80 or len(texts[1].split()) > 12
        or len(texts[2].split()) > 4 or not re.search(r'[\w\-\u00ad]$', texts[0])):
        return None
    data = []
    for tag in tags:
        parts = [features.get(mcid) for mcid in tag['mcids']]
        if not parts or any(part is None for part in parts):
            return None
        fonts = {part['font'] for part in parts}
        if len(fonts) != 1:
            return None
        points = [point for part in parts for point in part['points']]
        data.append({'font': next(iter(fonts)), 'x': min(point[0] for point in points),
            'low': min(point[1] for point in points), 'high': max(point[1] for point in points),
            'size': statistics.median(point[2] for point in points)})
    first, middle, last = data
    em = statistics.median(item['size'] for item in data)
    if (not 4 <= em <= 40 or first['font'] != last['font'] or first['font'] == middle['font']
        or max(abs(item['size'] - em) for item in data) > 0.08 * em
        or max(item['x'] for item in data) - min(item['x'] for item in data) > 0.3 * em
        or not 0.7 * em <= first['high'] - first['low'] <= 20 * em
        or middle['high'] - middle['low'] > 0.2 * em
        or last['high'] - last['low'] > 0.2 * em
        or not 0.6 * em <= first['low'] - middle['high'] <= 1.7 * em
        or not 0.6 * em <= middle['low'] - last['high'] <= 1.7 * em):
        return None
    return data


def _discover(reader, *, _inspection=None):
    inventory = _inventory(reader, _inspection)
    tags, native = inventory['tags'], semantic.nodes(reader)
    require(len(tags) == len(native))
    if inventory.get('native_id_tree', {}).get('verified') is not True:
        return [], inventory, {}
    by_id = {tag['id']: tag for tag in tags}
    nodes = {tag['id']: node for tag, node in zip(tags, native)}
    by_reference = {_key(node): tag for tag, node in zip(tags, native)}
    source, cache, output = semantic.source_digest(reader), {}, []
    unsafe_pages = {item.get('page') for item in inventory['findings'] if item['code'] in UNSAFE}
    parents = [(None, _root(reader)), *[(tag['id'], node) for tag, node in zip(tags, native)
        if tag['role'] in PARENTS and not any(key in node for key in ('/Alt', '/ActualText', '/E', '/Ref'))]]
    for parent_id, parent in parents:
        children = reading._children(parent)
        for offset in range(len(children) - 2):
            group = [v.resolved(child) for child in children[offset:offset + 3]]
            selected = [by_reference.get(v.reference_key(node)) for node in group]
            if any(tag is None for tag in selected) or not all(_leaf(tag, node) for tag, node in zip(selected, group)):
                continue
            pn = selected[0]['pageNumber']
            if pn in unsafe_pages or any(tag['pageNumber'] != pn or tag.get('parentId') != parent_id
                or v.resolved(node.get('/P')) is not parent for tag, node in zip(selected, group)):
                continue
            if pn not in cache:
                cache[pn] = _page_features(reader.pages[pn - 1])
            pattern = _pattern(selected, cache[pn])
            if pattern is None:
                continue
            public = {'kind': 'join_interrupted_text', 'tagId': selected[0]['id'],
                'relatedTagIds': [tag['id'] for tag in selected[1:]], 'pageNumber': pn,
                'text': reading._text(selected[0]),
                'preview': ('Confirm that the first and final source fragments belong together: '
                    + reading._text(selected[0]) + ' ' + reading._text(selected[2])
                    + '\nRead this separate styled line afterward: ' + reading._text(selected[1]))}
            detail = {'parentId': parent_id, 'geometryAndFonts': pattern,
                'texts': [reading._text(tag) for tag in selected]}
            public['candidateId'] = _hash({'source': source, **public, 'details': detail})
            output.append((public, detail))
            require(len(output) <= MAX_CANDIDATES, 'pdf_complexity_limit')
    return output, inventory, nodes


def discover_candidates(reader, *, _inspection=None):
    return [public for public, _ in _discover(reader, _inspection=_inspection)[0]]


def _id_owners(reader):
    return {identifier: list(_key(node)) for identifier, node in v.structure_id_tree(_root(reader)).items()}


def _paint(page):
    return v.drawing_fingerprint(v.operations(page), v.Canonicalizer())


def _maps(reader):
    return {key: v.Canonicalizer().hash(_root(reader).get(key, {}))
        for key in ('/RoleMap', '/ClassMap', '/Namespaces')}


def _child_token(child, pages):
    native = v.resolved(child)
    if isinstance(native, DictionaryObject) and '/S' in native:
        return {'node': list(_key(native))}
    return {'content': v.Canonicalizer(pages).value(child)}


class _Proof:
    __slots__ = ('_payload',)

    def __init__(self, token, payload):
        require(token is _TOKEN)
        object.__setattr__(self, '_payload', _json(payload))

    def __setattr__(self, key, value):
        require(False)

    @property
    def payload(self):
        return json.loads(self._payload)


def protected_windows(proof):
    require(type(proof) is _Proof)
    return tuple((tuple(item['parent']), tuple(tuple(key) for key in item['window']))
        for item in proof.payload['windows'])


def apply_operations(source_reader, writer, operations, *, _inspection=None,
                     _source_nodes=None, _target_nodes=None):
    require(isinstance(operations, list) and len(operations) <= MAX_CANDIDATES)
    candidates, inventory, original = _discover(source_reader, _inspection=_inspection)
    source_nodes = original if _source_nodes is None else _source_nodes
    require(set(source_nodes) == set(original) and all(source_nodes[key] is original[key] for key in original))
    if _target_nodes is None:
        native = semantic.nodes(writer); require(len(native) == len(original))
        targets = dict(zip(original, native))
    else:
        targets = _target_nodes
    require(isinstance(targets, dict) and set(targets) == set(original)
        and len({id(node) for node in targets.values()}) == len(targets))
    options = {public['candidateId']: (public, detail) for public, detail in candidates}
    tags = {tag['id']: tag for tag in inventory['tags']}
    ids_before, maps_before = _id_owners(writer), _maps(writer)
    retained = [list(_key(node)) for node in targets.values()]
    pages, proof_nodes, owners, windows, parents = {}, {}, {}, [], {}
    changes, lineage, used = [], [], set()
    for operation in operations:
        require(isinstance(operation, dict) and set(operation) == {'type', 'tagId', 'candidateId'}
            and operation.get('type') == 'repair_structure' and operation.get('candidateId') in options)
        public, detail = options[operation['candidateId']]
        require(operation['tagId'] == public['tagId'])
        identifiers = [public['tagId'], *public['relatedTagIds']]
        require(not used.intersection(identifiers)); used.update(identifiers)
        parent = _root(writer) if detail['parentId'] is None else targets[detail['parentId']]
        group = [targets[identifier] for identifier in identifiers]
        for identifier, node in zip(identifiers, group):
            require(set(node) == set(original[identifier])
                and reading._evidence(node, writer.pages) == reading._evidence(original[identifier], source_reader.pages)
                and v.resolved(node.get('/P')) is parent)
        children = reading._children(parent)
        matches = [index for index in range(len(children))
            if all(v.resolved(child) is node for child, node in zip(children[index:index + 3], group))
            and len(children[index:index + 3]) == 3]
        require(len(matches) == 1)
        pn = public['pageNumber']; page = writer.pages[pn - 1]
        require(_paint(page) == _paint(source_reader.pages[pn - 1]), 'native_pdf_preservation')
        first, middle, last = group
        wrapper = semantic._new_tag(writer, 'P', parent, page,
            ArrayObject([semantic._reference(writer, first), semantic._reference(writer, last)]))
        for fragment in (first, last):
            fragment[N('/S')] = N('/Span'); fragment[N('/P')] = semantic._reference(writer, wrapper)
        offset = matches[0]
        parent[N('/K')] = ArrayObject(children[:offset] + [semantic._reference(writer, wrapper),
            semantic._reference(writer, middle)] + children[offset + 3:])
        parents[_key(parent)] = parent
        for identifier, node in zip(identifiers, group):
            proof_nodes[_key(node)] = reading._signature(node, writer.pages)
            owners[_key(node)] = reading._ownership(tags[identifier])
        proof_nodes[_key(wrapper)] = reading._signature(wrapper, writer.pages)
        windows.append({'parent': list(_key(parent)), 'window': [list(_key(wrapper)), list(_key(middle))]})
        pages[pn] = {'paint': _paint(page), 'resources': v.Canonicalizer().hash(page.get('/Resources', {}))}
        lineage.append({'node': wrapper, 'sourceTagId': public['tagId']})
        changes.append({'code': 'join_interrupted_text', 'tagId': public['tagId'],
            'candidateId': public['candidateId'], 'pageNumber': pn,
            'message': 'Joined the existing text fragments in reading order and placed the separate styled line afterward. All source words, IDs and page appearance were preserved.'})
    require(_id_owners(writer) == ids_before and _maps(writer) == maps_before, 'native_pdf_preservation')
    proof = {'ids': ids_before, 'maps': maps_before, 'retained': retained, 'pages': pages, 'windows': windows,
        'parents': [{'key': list(key), 'children': [_child_token(child, writer.pages)
            for child in reading._children(parent)]} for key, parent in parents.items()],
        'nodes': [{'key': list(key), 'signature': signature} for key, signature in proof_nodes.items()],
        'owners': [{'key': list(key), 'sequence': sequence} for key, sequence in owners.items()]}
    return {'changes': changes, 'lineage': lineage, 'verification': _Proof(_TOKEN, proof)}


def verify_saved(reader, verification, *, _inspection=None):
    require(type(verification) is _Proof, 'native_pdf_preservation')
    proof, inventory = verification.payload, _inventory(reader, _inspection)
    native = semantic.nodes(reader); require(len(native) == len(inventory['tags']), 'native_pdf_preservation')
    indexed = {_key(node): node for node in [_root(reader), *native]}
    tags = {_key(node): tag for node, tag in zip(native, inventory['tags'])}
    require(all(tuple(key) in indexed for key in proof['retained'])
        and _id_owners(reader) == proof['ids'] and _maps(reader) == proof['maps'], 'native_pdf_preservation')
    for item in proof['nodes']:
        node = indexed.get(tuple(item['key']))
        require(node is not None and _json(reading._signature(node, reader.pages)) == _json(item['signature']), 'native_pdf_preservation')
    for item in proof['owners']:
        tag = tags.get(tuple(item['key']))
        require(tag is not None and reading._ownership(tag) == item['sequence'], 'native_pdf_preservation')
    for parent_key, window in protected_windows(verification):
        parent = indexed.get(parent_key); require(parent is not None, 'native_pdf_preservation')
        keys = tuple(v.reference_key(v.resolved(child)) for child in reading._children(parent))
        require(sum(keys[index:index + len(window)] == window for index in range(len(keys))) == 1, 'native_pdf_preservation')
    for item in proof['parents']:
        parent = indexed.get(tuple(item['key'])); require(parent is not None, 'native_pdf_preservation')
        expected = [_json(token) for token in item['children']]
        projected = []
        for child in reading._children(parent):
            token = _child_token(child, reader.pages); encoded = _json(token)
            if encoded in expected:
                projected.append(encoded)
                if 'node' in token:
                    require(v.resolved(v.resolved(child).get('/P')) is parent, 'native_pdf_preservation')
            else:
                # A later bounded repair may add a new structure element, but
                # cannot delete/reorder existing siblings or add raw content.
                require('node' in token, 'native_pdf_preservation')
        require(projected == expected, 'native_pdf_preservation')
    for pn, page_proof in proof['pages'].items():
        page = reader.pages[int(pn) - 1]
        require(_paint(page) == page_proof['paint']
            and v.Canonicalizer().hash(page.get('/Resources', {})) == page_proof['resources'], 'native_pdf_preservation')
    return True
