"""Restore prose whose decimal percentages were mistaken for list numbers.

Only fixed source-proven label/body splits are offered. The planner confirms
the semantic interpretation; it supplies neither replacement words nor order.
"""
from __future__ import annotations

from decimal import Decimal
import json
import re

from pypdf.generic import ArrayObject, DictionaryObject, NameObject as N

import bounded_semantic_structure as semantic
import bounded_reading_order as reading
import bounded_interrupted_text as common
import verify_pdf as v

MAX_ITEMS = 20
MAX_NODES = 100
MAX_PARAGRAPHS = 10
MAX_CANDIDATES = 100
KEYS = common.LEAF_KEYS
_TOKEN = object()


class FalseListError(semantic.SemanticStructureError):
    """A fixed diagnostic that does not contain document text."""


def require(condition, code='native_pdf_invalid_plan'):
    if not condition:
        raise FalseListError(code)


def _attribute_plan(node, classes):
    attributes, gaps = v.tag_attributes(node, classes)
    if gaps or any(item['owner'] == 'List' and item['source'] == 'class' for item in attributes):
        return None
    if '/A' not in node:
        return {'present': False, 'value': None}
    raw = v.resolved(node['/A'])
    entries = list(raw) if isinstance(raw, ArrayObject) else [raw]
    kept, removed = [], False
    for entry in entries:
        value = v.resolved(entry)
        if v.integer(value) is not None:
            if not removed:
                kept.append(entry)
            continue
        if not isinstance(value, DictionaryObject):
            return None
        removed = value.get('/O') == '/List'
        if removed:
            if set(value) - {'/O', '/ListNumbering'} or value.get('/ListNumbering') not in (None, '/Decimal', '/None'):
                return None
        else:
            kept.append(entry)
    return {'present': True, 'value': (ArrayObject(kept) if isinstance(raw, ArrayObject) else kept[0]) if kept else None}


def _base(tag, node, role, page, classes):
    return (tag.get('role') == role and tag.get('pageNumber') == page
        and not tag.get('textIncomplete') and not tag.get('attributeGaps')
        and set(node) <= KEYS and _attribute_plan(node, classes) is not None)


def _direct(tag, node, role, page, classes, maximum=100):
    content = tag.get('contentSequence', []); native = reading._children(node)
    return (_base(tag, node, role, page, classes) and 1 <= len(content) <= maximum
        and len(content) == len(native) and all(
            item.get('kind') == 'markedContent' and item.get('resolved') is True
            and item.get('parentTreeVerified') is True and item.get('pageNumber') == page
            and 'streamId' not in item and v.integer(owner) == item.get('mcid')
            for item, owner in zip(content, native)))


def _children(tag, node, role, page, classes, by_id, nodes):
    content = tag.get('contentSequence', []); native = reading._children(node)
    if (not _base(tag, node, role, page, classes) or len(content) != len(native)
        or any(item.get('kind') != 'childTag' or item.get('resolved') is not True
            or item.get('tagId') not in by_id for item in content)):
        return None
    selected = [by_id[item['tagId']] for item in content]
    return selected if all(v.resolved(child) is nodes[item['id']]
        and v.resolved(nodes[item['id']].get('/P')) is node and item.get('parentId') == tag['id']
        for child, item in zip(native, selected)) else None


def _decimal_pair(label, body, page, scopes, states, positions):
    number, text = reading._text(label), reading._text(body)
    fraction = re.match(r'^\.(\d{1,4})\s*%(?=$|[\s),;:.\]])', text)
    if not re.fullmatch(r'\d{1,3}', number) or not fraction or len(text) < 40:
        return None
    if not Decimal(0) <= Decimal(number + '.' + fraction.group(1)) <= Decimal(100):
        return None
    if len(label.get('mcids', [])) != 1:
        return None
    label_scope = scopes.get(label['mcids'][0])
    body_mcid = body['contentSequence'][0].get('mcid')
    body_scope = scopes.get(body_mcid)
    if not label_scope or not body_scope or len(label_scope['shows']) != 1 or not body_scope['shows']:
        return None
    left, right = label_scope['shows'][0], body_scope['shows'][0]
    # The exact source operators must show an uninterrupted number. A list
    # label with an indented/repositioned body cannot pass this predicate.
    if (left != label_scope['start'] + 1 or label_scope['end'] != left + 1
        or body_scope['start'] != label_scope['end'] + 1 or right != body_scope['start'] + 1):
        return None
    before, after = states.get(left), states.get(right)
    a, b = positions.get(label['mcids'][0], []), positions.get(body_mcid, [])
    if not before or not after or not a or not b or before.get('font') != after.get('font'):
        return None
    size = a[0][2]
    if (not 4 <= size <= 40 or abs(size - b[0][2]) > 0.001
        or abs(a[0][0] - b[0][0]) > 0.01 * size or abs(a[0][1] - b[0][1]) > 0.01 * size):
        return None
    font = before.get('font')
    fonts = v.resolved(v.resolved(page.get('/Resources', {})).get('/Font', {}))
    if font not in fonts:
        return None
    return {'percentage': number + '.' + fraction.group(1) + '%',
        'labelMcid': label['mcids'][0], 'bodyMcid': body_mcid,
        'font': v.Canonicalizer().hash(fonts[font]), 'origin': a[0]}


def _discover(reader, *, _inspection=None):
    inventory = common._inventory(reader, _inspection)
    native = semantic.nodes(reader); require(len(native) == len(inventory['tags']))
    nodes = {tag['id']: node for tag, node in zip(inventory['tags'], native)}
    by_id = {tag['id']: tag for tag in inventory['tags']}
    if inventory.get('native_id_tree', {}).get('verified') is not True:
        return [], inventory, nodes
    unsafe = {item.get('page') for item in inventory['findings'] if item['code'] in common.UNSAFE}
    source, cache, output = semantic.source_digest(reader), {}, []
    classes = v.resolved(common._root(reader).get('/ClassMap', {}))
    for listing in inventory['tags']:
        pn = listing.get('pageNumber')
        if listing['role'] != 'L' or not isinstance(pn, int) or pn in unsafe:
            continue
        items = _children(listing, nodes[listing['id']], 'L', pn, classes, by_id, nodes)
        if items is None or not 1 <= len(items) <= MAX_ITEMS:
            continue
        if pn not in cache:
            ops = v.operations(reader.pages[pn - 1])
            require(len(ops) <= common.MAX_PAGE_OPS, 'pdf_complexity_limit')
            cache[pn] = (semantic._scopes(ops, allow_text_boundaries=True), semantic._states(reader.pages[pn - 1], ops), reading._positions(reader.pages[pn - 1]))
        scopes, states, positions = cache[pn]
        details, related, valid = [], [], True
        for item in items:
            parts = _children(item, nodes[item['id']], 'LI', pn, classes, by_id, nodes)
            if parts is None or len(parts) != 2:
                valid = False; break
            label, body = parts
            if not _direct(label, nodes[label['id']], 'Lbl', pn, classes, maximum=1):
                valid = False; break
            body_node = nodes[body['id']]; sequence = body.get('contentSequence', [])
            if not _base(body, body_node, 'LBody', pn, classes) or not sequence:
                valid = False; break
            direct, children, seen_child = [], [], False
            for content in sequence:
                if content.get('kind') == 'childTag':
                    seen_child = True
                    child = by_id.get(content.get('tagId'))
                    if (child is None or child.get('parentId') != body['id']
                        or not _direct(child, nodes[child['id']], 'P', pn, classes)
                        or v.resolved(nodes[child['id']].get('/P')) is not body_node):
                        valid = False; break
                    children.append(child)
                elif (seen_child or content.get('kind') != 'markedContent'
                    or content.get('resolved') is not True or content.get('parentTreeVerified') is not True
                    or content.get('pageNumber') != pn or 'streamId' in content):
                    valid = False; break
                else:
                    direct.append(content['mcid'])
            native_body = reading._children(body_node)
            if (not valid or not 1 <= len(direct) <= 100 or len(children) > MAX_PARAGRAPHS
                or len(native_body) != len(direct) + len(children)
                or any(v.integer(value) != mcid for value, mcid in zip(native_body, direct))
                or any(v.resolved(value) is not nodes[child['id']] for value, child in zip(native_body[len(direct):], children))):
                valid = False; break
            pair = _decimal_pair(label, body, reader.pages[pn - 1], scopes, states, positions)
            if pair is None:
                valid = False; break
            details.append({'itemId': item['id'], 'labelId': label['id'], 'bodyId': body['id'],
                'paragraphIds': [child['id'] for child in children], 'directMcids': direct, 'sourcePair': pair})
            related.extend([item['id'], label['id'], body['id'], *[child['id'] for child in children]])
        if not valid or 1 + len(related) > MAX_NODES:
            continue
        texts = [reading._text(by_id[item['labelId']]) + reading._text(by_id[item['bodyId']]) for item in details]
        if sum(map(len, texts)) > 16000:
            continue
        public = {'kind': 'restore_decimal_paragraphs', 'tagId': listing['id'],
            'relatedTagIds': related, 'pageNumber': pn, 'text': '\n'.join(texts),
            'preview': 'Confirm ordinary decimal-percentage prose rather than numbered list items: '
                + ', '.join(item['sourcePair']['percentage'] for item in details)
                + '. Retain every word and native owner; restore separate nested paragraphs immediately afterward.'}
        detail = {'items': details}
        public['candidateId'] = common._hash({'source': source, **public, 'details': detail})
        output.append((public, detail)); require(len(output) <= MAX_CANDIDATES, 'pdf_complexity_limit')
    return output, inventory, nodes


def discover_candidates(reader, *, _inspection=None):
    return [public for public, _ in _discover(reader, _inspection=_inspection)[0]]


class _Proof:
    __slots__ = ('_payload',)

    def __init__(self, token, payload):
        require(token is _TOKEN)
        object.__setattr__(self, '_payload', common._json(payload))

    def __setattr__(self, key, value):
        require(False)

    @property
    def payload(self):
        return json.loads(self._payload)


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
    by_id = {tag['id']: tag for tag in inventory['tags']}
    classes = v.resolved(common._root(writer).get('/ClassMap', {}))
    ids, maps = common._id_owners(writer), common._maps(writer)
    proof_nodes, owners, pages, changes, used = {}, {}, {}, [], set()
    for operation in operations:
        require(isinstance(operation, dict) and set(operation) == {'type', 'tagId', 'candidateId'}
            and operation.get('type') == 'repair_structure' and operation.get('candidateId') in options)
        public, detail = options[operation['candidateId']]
        require(operation['tagId'] == public['tagId'])
        identifiers = [public['tagId'], *public['relatedTagIds']]
        require(not used.intersection(identifiers)); used.update(identifiers)
        for identifier in identifiers:
            node, source = targets[identifier], original[identifier]
            require(set(node) == set(source)
                and reading._evidence(node, writer.pages) == reading._evidence(source, source_reader.pages))
            expected_parent = targets.get(by_id[identifier].get('parentId'), common._root(writer))
            require(v.resolved(node.get('/P')) is expected_parent)
        listing = targets[public['tagId']]; kids = []
        listing[N('/S')] = N('/Div')
        for item in detail['items']:
            native_item = targets[item['itemId']]; native_item[N('/S')] = N('/P')
            label, body = targets[item['labelId']], targets[item['bodyId']]
            label[N('/S')] = N('/Span'); body[N('/S')] = N('/Span')
            direct = reading._children(body)[:len(item['directMcids'])]
            body[N('/K')] = ArrayObject(direct)
            kids.append(semantic._reference(writer, native_item))
            for identifier in item['paragraphIds']:
                paragraph = targets[identifier]; paragraph[N('/P')] = semantic._reference(writer, listing)
                kids.append(semantic._reference(writer, paragraph))
        listing[N('/K')] = ArrayObject(kids)
        for identifier in identifiers:
            node = targets[identifier]; plan = _attribute_plan(node, classes); require(plan is not None)
            if plan['present']:
                if plan['value'] is None:
                    del node['/A']
                else:
                    node[N('/A')] = plan['value']
            proof_nodes[common._key(node)] = reading._signature(node, writer.pages)
            sequence = reading._ownership(by_id[identifier])
            if sequence:
                owners[common._key(node)] = sequence
        pn = public['pageNumber']; page = writer.pages[pn - 1]
        require(common._paint(page) == common._paint(source_reader.pages[pn - 1]), 'native_pdf_preservation')
        pages[pn] = {'paint': common._paint(page), 'resources': v.Canonicalizer().hash(page.get('/Resources', {}))}
        changes.append({'code': 'restore_decimal_paragraphs', 'candidateId': public['candidateId'],
            'tagId': public['tagId'], 'pageNumber': pn,
            'message': 'Restored decimal percentages as ordinary paragraph text and moved separate nested paragraphs out of the false list. The source words, IDs, owners and page appearance were preserved.'})
    require(common._id_owners(writer) == ids and common._maps(writer) == maps, 'native_pdf_preservation')
    proof = {'ids': ids, 'maps': maps, 'pages': pages,
        'retained': [list(common._key(node)) for node in targets.values()],
        'nodes': [{'key': list(key), 'signature': signature} for key, signature in proof_nodes.items()],
        'owners': [{'key': list(key), 'sequence': sequence} for key, sequence in owners.items()]}
    return {'changes': changes, 'lineage': [], 'verification': _Proof(_TOKEN, proof)}


def verify_saved(reader, verification, *, _inspection=None):
    require(type(verification) is _Proof, 'native_pdf_preservation')
    proof, inventory = verification.payload, common._inventory(reader, _inspection)
    native = semantic.nodes(reader); require(len(native) == len(inventory['tags']), 'native_pdf_preservation')
    indexed = {common._key(node): node for node in native}
    tags = {common._key(node): tag for node, tag in zip(native, inventory['tags'])}
    require(all(tuple(key) in indexed for key in proof['retained'])
        and common._id_owners(reader) == proof['ids'] and common._maps(reader) == proof['maps'], 'native_pdf_preservation')
    for item in proof['nodes']:
        node = indexed.get(tuple(item['key']))
        require(node is not None and common._json(reading._signature(node, reader.pages)) == common._json(item['signature']), 'native_pdf_preservation')
    for item in proof['owners']:
        tag = tags.get(tuple(item['key']))
        require(tag is not None and reading._ownership(tag) == item['sequence'], 'native_pdf_preservation')
    for pn, page_proof in proof['pages'].items():
        page = reader.pages[int(pn) - 1]
        require(common._paint(page) == page_proof['paint']
            and v.Canonicalizer().hash(page.get('/Resources', {})) == page_proof['resources'], 'native_pdf_preservation')
    return True
