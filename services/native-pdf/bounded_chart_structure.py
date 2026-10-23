"""Source-bound descriptions for captioned, native vector charts.

Only simple existing Artifact path scopes may become graphic content. The
original chart labels remain real native nodes inside the new Figure; original
page painting, captions, links and authored alternatives are never rewritten.
"""
from __future__ import annotations

import copy
import hashlib
import json
import math
import re

import pypdfium2 as pdfium
import pypdfium2.raw as raw
from pypdf import PdfReader
from pypdf.generic import (ArrayObject, ByteStringObject, ContentStream, DictionaryObject,
    NameObject, NullObject, NumberObject, TextStringObject)

import verify_pdf as v
from bounded_semantic_structure import _DiscoveryInspection, SemanticStructureError, SHOW, _freeze, nodes, source_digest

MAX_CANDIDATES = 40
MAX_OBJECTS = 100_000
MAX_SCOPES = 20_000
MAX_GROUPS = 80
CAPTION = re.compile(r'^(?:fig(?:ure)?\.?|chart|graph)\s*(?:[0-9]+|[A-Za-z])(?:[.:\s]|$)', re.I)
LABEL_ROLES = {'P', 'Span', 'Div', 'L', 'LI', 'Lbl', 'LBody'}
CONTAINER_ROLES = {'Document', 'Part', 'Sect', 'Div', 'Art'}
PATH = {b'm', b'l', b'c', b'v', b'y', b're', b'h'}
PAINT = {b'S', b's', b'f', b'F', b'f*', b'B', b'B*', b'b', b'b*'}
STATE = {b'q', b'Q', b'cm', b'w', b'J', b'j', b'M', b'd', b'ri', b'i',
         b'gs', b'CS', b'cs', b'SC', b'SCN', b'sc', b'scn', b'G', b'g',
         b'RG', b'rg', b'K', b'k'}
IDENTITY = (1., 0., 0., 1., 0., 0.)


class ChartStructureError(SemanticStructureError):
    pass


def require(condition, code='native_pdf_invalid_plan'):
    if not condition:
        raise ChartStructureError(code)


def normalized(text):
    return re.sub(r'\s+', ' ', text).strip()


def _hash(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True).encode()).hexdigest()


def _bytes(reader):
    require(isinstance(reader, PdfReader))
    position = reader.stream.tell()
    try:
        reader.stream.seek(0)
        data = reader.stream.read(v.MAX_FILE_BYTES + 1)
        require(len(data) <= v.MAX_FILE_BYTES)
        return data
    finally:
        reader.stream.seek(position)


def _inventory(reader, inspection):
    if inspection is None:
        return v.structure_inventory(reader)
    require(type(inspection) is _DiscoveryInspection)
    return inspection.copy_for(reader)


def _union(boxes):
    boxes = list(boxes)
    return (min(b[0] for b in boxes), min(b[1] for b in boxes),
            max(b[2] for b in boxes), max(b[3] for b in boxes)) if boxes else None


def _inside(inner, outer, tolerance=.01):
    return (outer[0] - tolerance <= inner[0] <= inner[2] <= outer[2] + tolerance
            and outer[1] - tolerance <= inner[1] <= inner[3] <= outer[3] + tolerance)


def _intersects(left, right):
    overlap = (min(left[2], right[2]) - max(left[0], right[0]),
               min(left[3], right[3]) - max(left[1], right[1]))
    return min(overlap) >= -.01 and max(overlap) > .5


def _point(matrix, x, y):
    a, b, c, d, e, f = matrix
    result = (a*x+c*y+e, b*x+d*y+f)
    require(all(math.isfinite(n) and abs(n) <= 10_000_000 for n in result))
    return result


def _multiply(matrix, operand):
    a, b, c, d, e, f = operand
    aa, bb, cc, dd, ee, ff = matrix
    return (a*aa+b*cc, a*bb+b*dd, c*aa+d*cc, c*bb+d*dd, e*aa+f*cc+ee, e*bb+f*dd+ff)


def _path_scopes(page, *, semantic=False):
    """Inspect whole marked scopes; partial paths and nested marks are ineligible."""
    ops, matrix, saved, marks, scopes = v.operations(page), IDENTITY, [], [], []
    points, path_owner = [], None
    for index, (args, operator) in enumerate(ops):
        if operator in (b'BMC', b'BDC'):
            props = v.resolved(args[1]) if operator == b'BDC' and len(args) == 2 else None
            mcid = v.integer(props.get('/MCID')) if isinstance(props, dict) else None
            eligible = (not marks and ((operator == b'BMC' and len(args) == 1 and args[0] == '/Artifact')
                or (semantic and operator == b'BDC' and len(args) == 2 and args[0] == '/Figure'
                    and isinstance(props, DictionaryObject) and set(props) == {'/MCID'} and mcid is not None)))
            if marks:
                marks[-1]['safe'] = False
            marks.append({'start': index, 'safe': eligible, 'paints': [], 'mcid': mcid})
            require(len(marks) <= 64 and len(scopes) < MAX_SCOPES, 'pdf_complexity_limit')
            continue
        if operator == b'EMC':
            require(bool(marks))
            scope = marks.pop()
            if points and path_owner is scope:
                scope['safe'] = False
            if scope['paints']:
                scope['end'] = index
                scope['bounds'] = _union(p['bounds'] for p in scope['paints'])
                scopes.append(scope)
            continue
        owner = marks[-1] if marks else None
        if owner is not None and operator not in PATH | PAINT | STATE | {b'n'}:
            owner['safe'] = False
        if operator == b'q':
            saved.append(matrix)
            require(len(saved) <= 128, 'pdf_complexity_limit')
        elif operator == b'Q':
            require(bool(saved))
            matrix = saved.pop()
        elif operator == b'cm':
            require(len(args) == 6)
            matrix = _multiply(matrix, tuple(float(n) for n in args))
            require(all(math.isfinite(n) and abs(n) <= 10_000_000 for n in matrix))
        if operator in PATH:
            if not points:
                path_owner = owner
            if path_owner is not owner and owner is not None:
                owner['safe'] = False
            values = [float(n) for n in args]
            require(all(math.isfinite(n) and abs(n) <= 10_000_000 for n in values))
            if operator == b're':
                require(len(values) == 4)
                x, y, width, height = values
                values = [x, y, x+width, y, x+width, y+height, x, y+height]
            elif operator == b'h':
                require(not values and bool(points))
            else:
                require(len(values) == {b'm': 2, b'l': 2, b'c': 6, b'v': 4, b'y': 4}[operator])
            points.extend(_point(matrix, values[i], values[i+1]) for i in range(0, len(values), 2))
            require(len(points) <= 20_000, 'pdf_complexity_limit')
        elif operator in PAINT | {b'n'}:
            if operator in PAINT:
                if points:
                    box = _union((x, y, x, y) for x, y in points)
                    record = {'operator': operator.decode(), 'bounds': box,
                        'points': [[round(x, 6), round(y, 6)] for x, y in points]}
                    if owner is not None and path_owner is owner:
                        owner['paints'].append(record)
                    else:
                        scopes.append({'start': index, 'end': index, 'safe': False, 'mcid': None,
                            'paints': [record], 'bounds': box})
                elif owner is not None:
                    owner['safe'] = False
            points, path_owner = [], None
    require(not marks and not saved)
    return ops, scopes


def _groups(ops, scopes):
    result = []
    for scope in sorted(scopes, key=lambda item: item['start']):
        if result and all(operator in STATE for _, operator in ops[result[-1]['end']+1:scope['start']]):
            group = result[-1]
            group['end'] = scope['end']
            group['scopes'].append(scope)
        else:
            result.append({'start': scope['start'], 'end': scope['end'], 'scopes': [scope]})
    for group in result:
        group['bounds'] = _union(scope['bounds'] for scope in group['scopes'])
        group['paintCount'] = sum(len(scope['paints']) for scope in group['scopes'])
        group['identity'] = _hash({'paint': v.drawing_fingerprint(ops[group['start']:group['end']+1], v.Canonicalizer()),
            'paths': [paint for scope in group['scopes'] for paint in scope['paints']]})
    return result


def _pdfium_bounds(reader, page_numbers):
    result, count = {}, 0
    with pdfium.PdfDocument(_bytes(reader)) as document:
        for pn in page_numbers:
            page = document[pn-1]
            try:
                if page.get_rotation() != 0:
                    continue
                boxes = {}
                unsupported = []
                for item in page.get_objects(max_depth=0):
                    count += 1
                    require(count <= MAX_OBJECTS, 'pdf_complexity_limit')
                    if item.type in (raw.FPDF_PAGEOBJ_IMAGE, raw.FPDF_PAGEOBJ_FORM):
                        unsupported.append(item.get_bounds())
                    if item.type != raw.FPDF_PAGEOBJ_TEXT or item.level != 0:
                        continue
                    mcid = raw.FPDFPageObj_GetMarkedContentID(item)
                    if mcid < 0:
                        continue
                    box = item.get_bounds()
                    require(all(math.isfinite(n) and abs(n) <= 10_000_000 for n in box))
                    if box[2] > box[0] and box[3] > box[1]:
                        boxes.setdefault(mcid, []).append(box)
                result[pn] = {mcid: _union(values) for mcid, values in boxes.items()}
                result[pn][-1] = unsupported
            finally:
                page.close()
    return result


def _children(node):
    value = v.resolved(node.get('/K'))
    return list(value) if isinstance(value, ArrayObject) else [] if value is None else [node.raw_get('/K')]


def _subtree(tag, by_id):
    result, pending, seen = [], [tag], set()
    while pending:
        item = pending.pop()
        require(item['id'] not in seen and len(seen) <= 300)
        seen.add(item['id'])
        result.append(item)
        children = [entry['tagId'] for entry in item.get('contentSequence', []) if entry['kind'] == 'childTag']
        pending.extend(by_id[key] for key in reversed(children))
    return result


def _text(tag, by_id):
    return normalized(' '.join(item.get('text', '') for item in _subtree(tag, by_id)))


def _bound(tag, by_id, boxes, page_number):
    found = []
    for item in _subtree(tag, by_id):
        for entry in item.get('contentSequence', []):
            if entry['kind'] == 'childTag':
                continue
            if (entry['kind'] != 'markedContent' or entry.get('pageNumber') != page_number
                    or entry.get('streamId') is not None or entry.get('resolved') is not True
                    or entry.get('parentTreeVerified') is not True or entry.get('mcid') not in boxes):
                return None
            found.append(boxes[entry['mcid']])
    return _union(found)


def _negative_list(tag, by_id):
    if tag['role'] != 'L':
        return []
    children = [by_id[item['tagId']] for item in tag['contentSequence'] if item['kind'] == 'childTag']
    if not children or len(children) > 12:
        return []
    altered = [tag['id']]
    for child in children:
        descendants = [by_id[item['tagId']] for item in child['contentSequence'] if item['kind'] == 'childTag']
        if (child['role'] != 'LI' or [item['role'] for item in descendants] != ['Lbl', 'LBody']
                or _text(descendants[0], by_id) not in ('-', '\u2013', '\u2212')
                or not re.fullmatch(r'[0-9]+(?:\.[0-9]+)?', _text(descendants[1], by_id))):
            return []
        altered.extend([child['id'], *(item['id'] for item in descendants)])
    return altered


def _discover(reader, inspection=None):
    inventory = _inventory(reader, inspection)
    tags, native = inventory.get('tags', []), nodes(reader)
    require(len(tags) == len(native) <= 5000)
    by_id, by_node = {tag['id']: tag for tag in tags}, {tag['id']: node for tag, node in zip(tags, native)}
    captions = [tag for tag in tags if tag['role'] in {'P', 'Caption', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6'}
                and CAPTION.match(normalized(tag.get('text', ''))) and 5 <= len(normalized(tag.get('text', ''))) <= 500]
    if not captions:
        return [], inventory, native
    pages = sorted({tag['pageNumber'] for tag in captions if type(tag.get('pageNumber')) is int})
    boxes = _pdfium_bounds(reader, pages)
    scans, output = {}, []
    siblings = {}
    for tag in tags:
        siblings.setdefault(tag.get('parentId'), []).append(tag)
    source_hash = source_digest(reader)
    for caption in captions:
        pn, parent_id = caption.get('pageNumber'), caption.get('parentId')
        if pn not in boxes or by_id.get(parent_id, {}).get('role') not in CONTAINER_ROLES:
            continue
        ancestor, protected = caption, False
        while ancestor:
            protected |= any(key in by_node[ancestor['id']] for key in ('/Alt', '/ActualText', '/ID', '/Ref', '/E'))
            ancestor = by_id.get(ancestor.get('parentId'))
        if protected:
            continue
        title_box = _bound(caption, by_id, boxes[pn], pn)
        if title_box is None:
            continue
        candidates, selected, axis_boxes, numbers = siblings[parent_id], [], [], 0
        for tag in candidates[candidates.index(caption)+1:]:
            group = _subtree(tag, by_id)
            text = _text(tag, by_id)
            box = _bound(tag, by_id, boxes[pn], pn)
            if (len(selected) >= 40 or not 1 <= len(text) <= 240 or box is None or box[3] > title_box[1]+1
                    or box[0] < title_box[0]-8 or box[2] > title_box[2]+20
                    or any(item['role'] not in LABEL_ROLES or item.get('sourceRole') != item['role'] or item.get('textIncomplete')
                           or any(key in by_node[item['id']] for key in ('/Alt', '/ActualText', '/ID', '/Ref', '/E', '/C'))
                           for item in group)):
                break
            selected.append(tag)
            axis_boxes.append(box)
            numbers += bool(re.search(r'\d', text))
        if len(selected) < 3 or numbers < 3 or not any(re.search(r'[A-Za-z]', _text(tag, by_id)) for tag in selected):
            continue
        label_box = _union(axis_boxes)
        region = (min(label_box[0], title_box[0])-4, label_box[1]-6,
                  max(label_box[2], title_box[2])+24, label_box[3]+6)
        if region[2]-region[0] < 60 or not 50 <= region[3]-region[1] <= 600:
            continue
        if any(_intersects(box, region) for box in boxes[pn].get(-1, [])):
            continue
        selected_ids = {item['id'] for tag in selected for item in _subtree(tag, by_id)}
        if any(v.resolved(by_node[identifier].get('/P')) is not by_node.get(by_id[identifier].get('parentId'))
               for identifier in selected_ids | {caption['id']}):
            continue
        unrelated = False
        for tag in tags:
            if tag['id'] in selected_ids or tag['id'] == caption['id'] or tag.get('pageNumber') != pn:
                continue
            if any(entry['kind'] == 'childTag' for entry in tag.get('contentSequence', [])):
                continue
            box = _bound(tag, by_id, boxes[pn], pn)
            if box is not None and _intersects(box, region):
                unrelated = True
                break
        if unrelated:
            continue
        if pn not in scans:
            scans[pn] = _path_scopes(reader.pages[pn-1])
        ops, scopes = scans[pn]
        included = [scope for scope in scopes if scope['safe'] and _inside(scope['bounds'], region)]
        if any(_intersects(scope['bounds'], region) and (not scope['safe'] or not _inside(scope['bounds'], region)) for scope in scopes):
            continue
        groups = _groups(ops, included)
        if not 1 <= len(groups) <= MAX_GROUPS or sum(group['paintCount'] for group in groups) < 5:
            continue
        plot = _union(group['bounds'] for group in groups)
        if plot[2]-plot[0] < 40 or plot[3]-plot[1] < 40:
            continue
        related = [tag['id'] for tag in tags if tag['id'] in selected_ids]
        negative_ids = [identifier for tag in selected for identifier in _negative_list(tag, by_id)]
        public = {'kind': 'describe_chart', 'tagId': caption['id'], 'relatedTagIds': related,
            'pageNumber': pn,
            'text': normalized(caption['text']),
            'preview': 'Describe this vector chart using its visible data and accompanying source text. Existing labels: '
                + ' | '.join(_text(tag, by_id) for tag in selected)[:3500]}
        detail = {'parentId': parent_id, 'bounds': region, 'roots': [tag['id'] for tag in selected],
            'negativeIds': negative_ids, 'groups': groups}
        public['candidateId'] = _hash({'source': source_hash, **public,
            'bounds': region, 'graphics': [group['identity'] for group in groups], 'negativeIds': negative_ids})
        output.append((public, detail))
        require(len(output) <= MAX_CANDIDATES, 'pdf_complexity_limit')
    return output, inventory, native


def discover_candidates(reader, *, _inspection=None):
    return [public for public, _ in _discover(reader, _inspection)[0]]


def _reference(writer, node):
    return getattr(node, 'indirect_reference', None) or writer._add_object(node)


class _MetadataCanonicalizer(v.Canonicalizer):
    def value(self, item, active=None, depth=0):
        value = v.resolved(item)
        if self.owned_reference(item) in self.page_refs or id(value) in self.pages:
            return super().value(item, active, depth)
        if isinstance(value, TextStringObject):
            item = ByteStringObject(value.original_bytes)
        elif isinstance(value, dict):
            item = ('native_dictionary', [(str(key), value[key]) for key in sorted(value)])
        elif isinstance(value, ArrayObject):
            item = ('native_array', list(value))
        return super().value(item, active, depth)


def _paint_hash(operations):
    # Safe earlier repairs may partition Tj/TJ while retaining every encoded
    # byte and adjustment. The shared drawing comparison normalizes only that.
    return v.drawing_fingerprint(operations, v.Canonicalizer())


def _shape(node, pages):
    """Compare exact retained native subtrees without changed parent pointers."""
    page_ids = {v.reference_key(page): index+1 for index, page in enumerate(pages)}
    seen = set()
    def visit(value, depth=0):
        require(depth <= 64)
        value = v.resolved(value)
        if isinstance(value, ArrayObject):
            return [visit(item, depth+1) for item in value]
        if isinstance(value, DictionaryObject) and '/S' in value:
            require(id(value) not in seen)
            seen.add(id(value))
            attrs = {key: item for key, item in value.items() if key not in ('/P', '/Pg', '/K')}
            return {'attributes': _MetadataCanonicalizer(list(pages)).hash(attrs),
                    'page': page_ids.get(v.reference_key(value.get('/Pg'))),
                    'children': visit(value.get('/K'), depth+1)}
        return {'content': _MetadataCanonicalizer(list(pages)).hash(value)}
    return visit(node)


class _ChartVerification:
    __slots__ = ('_entries',)
    def __init__(self, entries):
        self._entries = copy.deepcopy(entries)


def _memberships(operations, wanted):
    """Bind MCIDs to exact paint occurrences, including repeated equal text.

    Mark wrappers never advance the occurrence counter. Text is counted by
    its original encoded bytes, so earlier safe TJ splits keep this identity.
    The accompanying full paint fingerprint binds each occurrence's program.
    """
    result, stack, occurrence = {mcid: [] for mcid in wanted}, [], 0
    for args, operator in operations:
        if operator in (b'BMC', b'BDC'):
            properties = v.resolved(args[1]) if operator == b'BDC' and len(args) == 2 else None
            mcid = v.integer(properties.get('/MCID')) if isinstance(properties, dict) else None
            stack.append(mcid if mcid is not None else stack[-1] if stack else None)
            require(len(stack) <= 64)
            continue
        if operator == b'EMC':
            require(bool(stack)); stack.pop(); continue
        count = 0
        if operator in SHOW:
            pieces = args[0] if operator == b'TJ' else args[-1:]
            for piece in pieces:
                if isinstance(piece, (str, bytes)):
                    count += len(piece.original_bytes if isinstance(piece, TextStringObject) else bytes(piece))
        elif operator in PAINT | {b'Do', b'sh', b'INLINE IMAGE'}:
            count = 1
        if stack and stack[-1] in result:
            result[stack[-1]].extend(range(occurrence, occurrence + count))
        occurrence += count
        require(occurrence <= 2_000_000, 'pdf_complexity_limit')
    require(not stack and all(result.values()))
    return result


def _check_retained_tree(node, parent, inventory_by_native):
    """Recheck native reciprocal parents and marked-content ownership."""
    pending, seen = [(node, parent)], set()
    while pending:
        item, owner = pending.pop()
        require(id(item) not in seen and len(seen) <= 500, 'native_pdf_preservation')
        seen.add(id(item))
        require(v.resolved(item.get('/P')) is owner, 'native_pdf_preservation')
        tag = inventory_by_native.get(id(item))
        parent_tag = inventory_by_native.get(id(owner))
        require(tag is not None and parent_tag is not None and tag.get('parentId') == parent_tag['id'], 'native_pdf_preservation')
        for entry in tag.get('contentSequence', []):
            require(entry.get('resolved') is True and (entry['kind'] == 'childTag'
                or entry['kind'] == 'markedContent' and entry.get('parentTreeVerified') is True), 'native_pdf_preservation')
        for child in _children(item):
            child = v.resolved(child)
            if isinstance(child, DictionaryObject) and '/S' in child:
                pending.append((child, item))


def apply_operations(source_reader, writer, operations, *, _inspection=None, _source_nodes=None, _target_nodes=None):
    require(isinstance(operations, list) and len(operations) <= MAX_CANDIDATES)
    candidates, inventory, actual_source = _discover(source_reader, _inspection)
    expected = {tag['id']: node for tag, node in zip(inventory['tags'], actual_source)}
    source_nodes = expected if _source_nodes is None else _source_nodes
    writer_nodes = nodes(writer)
    require(_target_nodes is not None or len(writer_nodes) == len(actual_source))
    targets = {tag['id']: node for tag, node in zip(inventory['tags'], writer_nodes)} if _target_nodes is None else _target_nodes
    require(type(source_nodes) is dict and type(targets) is dict and set(source_nodes) == set(targets) == set(expected)
            and all(source_nodes[key] is node for key, node in expected.items()))
    reachable = {id(node) for node in nodes(writer)}
    require(all(id(node) in reachable for node in targets.values()) and len({id(node) for node in targets.values()}) == len(targets))
    original, current = source_nodes, targets
    options = {public['candidateId']: (public, detail) for public, detail in candidates}
    used, selected = set(), []
    for operation in operations:
        require(isinstance(operation, dict) and set(operation) == {'type', 'tagId', 'candidateId', 'alt'}
                and operation.get('type') == 'repair_structure' and operation.get('candidateId') in options)
        public, detail = options[operation['candidateId']]
        alt = operation['alt']
        require(operation['tagId'] == public['tagId'] and isinstance(alt, str) and 30 <= len(alt.strip()) <= 8000
                and not any(ord(char) < 32 and char not in '\n\t' for char in alt))
        participants = {public['tagId'], *public['relatedTagIds']}
        require(not used.intersection(participants))
        used.update(participants)
        for identifier in participants:
            require(_shape(original[identifier], source_reader.pages) == _shape(current[identifier], writer.pages))
        selected.append((operation, public, detail))
    root = v.resolved(writer.root_object['/StructTreeRoot'])
    parents = v.number_tree(root.get('/ParentTree'))
    edits, changes, proofs = {}, [], []
    lineage = [{'node': node, 'sourceTagId': identifier} for identifier, node in targets.items()]
    for operation, public, detail in selected:
        pn, page = public['pageNumber'], writer.pages[public['pageNumber']-1]
        parent, caption = current[detail['parentId']], current[public['tagId']]
        labels = [current[identifier] for identifier in detail['roots']]
        kids = _children(parent)
        at = next((index for index, child in enumerate(kids) if v.resolved(child) is caption), None)
        require(at is not None and all(v.resolved(item) is label for item, label in zip(kids[at+1:at+1+len(labels)], labels))
                and len(kids[at+1:at+1+len(labels)]) == len(labels))
        if pn not in edits:
            ops, scopes = _path_scopes(page)
            key = v.integer(page.get('/StructParents'))
            array = parents.get(key)
            require(isinstance(array, ArrayObject))
            edits[pn] = {'ops': ops, 'scopes': scopes, 'parentArray': array, 'replacements': {},
                         'next': max(len(array), max((v.integer(v.resolved(args[1]).get('/MCID')) or 0
                             for args, operator in ops if operator == b'BDC' and len(args) == 2 and isinstance(v.resolved(args[1]), dict)), default=-1)+1)}
        edit = edits[pn]
        retained_ids = {public['tagId'], *public['relatedTagIds']}
        retained_mcids = [entry['mcid'] for tag in inventory['tags'] if tag['id'] in retained_ids
                          for entry in tag['contentSequence'] if entry['kind'] == 'markedContent']
        original_membership = _memberships(v.operations(source_reader.pages[pn-1]), retained_mcids)
        resources = v.Canonicalizer().hash(source_reader.pages[pn-1].get('/Resources', {}))
        require(_paint_hash(v.operations(source_reader.pages[pn-1])) == _paint_hash(edit['ops'])
                and resources == v.Canonicalizer().hash(page.get('/Resources', {}))
                and _memberships(edit['ops'], retained_mcids) == original_membership, 'native_pdf_preservation')
        region = detail['bounds']
        matching_groups = _groups(edit['ops'], [scope for scope in edit['scopes'] if scope['safe'] and _inside(scope['bounds'], region)])
        require([group['identity'] for group in matching_groups] == [group['identity'] for group in detail['groups']])
        figure = DictionaryObject({NameObject('/Type'): NameObject('/StructElem'), NameObject('/S'): NameObject('/Figure'),
            NameObject('/P'): _reference(writer, parent), NameObject('/Pg'): page.indirect_reference,
            NameObject('/Alt'): TextStringObject(operation['alt'].strip())})
        figure_ref = writer._add_object(figure)
        mcids, paint_proofs = [], []
        for group in matching_groups:
            require(group['start'] not in edit['replacements'])
            mcid = edit['next']; edit['next'] += 1
            require(mcid <= 100_000, 'pdf_complexity_limit')
            while len(edit['parentArray']) <= mcid:
                edit['parentArray'].append(NullObject())
            edit['parentArray'][mcid] = figure_ref
            removed = {index for scope in group['scopes'] for index in (scope['start'], scope['end'])}
            body = [item for index, item in enumerate(edit['ops'][group['start']:group['end']+1], group['start']) if index not in removed]
            replacement = [([NameObject('/Figure'), DictionaryObject({NameObject('/MCID'): NumberObject(mcid)})], b'BDC'), *body, ([], b'EMC')]
            edit['replacements'][group['start']] = (group['end'], replacement)
            mcids.append(mcid)
            paint_proofs.append({'mcid': mcid, 'identity': group['identity']})
        for identifier in detail['negativeIds']:
            node = current[identifier]
            role = str(node['/S'])
            node[NameObject('/S')] = NameObject('/Div' if role in ('/L', '/LI') else '/Span')
            if role == '/L' and '/A' in node:
                attrs = v.resolved(node['/A'])
                attrs = list(attrs) if isinstance(attrs, ArrayObject) else [attrs]
                require(all(isinstance(v.resolved(attr), DictionaryObject) for attr in attrs))
                kept = [attr for attr in attrs if v.resolved(attr).get('/O') != '/List']
                if kept:
                    node[NameObject('/A')] = ArrayObject(kept)
                else:
                    del node['/A']
        caption[NameObject('/S')] = NameObject('/Caption')
        caption[NameObject('/P')] = figure_ref
        for label in labels:
            label[NameObject('/P')] = figure_ref
        figure[NameObject('/K')] = ArrayObject([_reference(writer, caption)] + [NumberObject(mcid) for mcid in mcids] + [_reference(writer, label) for label in labels])
        parent[NameObject('/K')] = ArrayObject(kids[:at] + [figure_ref] + kids[at+1+len(labels):])
        proofs.append({'pageNumber': pn, 'alt': operation['alt'].strip(), 'mcids': mcids, 'paint': paint_proofs,
            'caption': _shape(caption, writer.pages), 'labels': [_shape(label, writer.pages) for label in labels],
            'originalMembership': original_membership, 'pagePaint': _paint_hash(edit['ops']), 'resources': resources})
        lineage.append({'node': figure, 'sourceTagId': public['tagId']})
        changes.append({'code': 'describe_chart', 'tagId': public['tagId'], 'pageNumber': pn,
            'candidateId': public['candidateId'], 'relatedTagIds': public['relatedTagIds'],
            'message': 'Added a description for this chart and grouped its original graphics and labels without changing the page.'})
    for pn, edit in edits.items():
        changed, index = [], 0
        while index < len(edit['ops']):
            if index in edit['replacements']:
                end, replacement = edit['replacements'][index]
                changed.extend(replacement)
                index = end + 1
            else:
                args, operator = edit['ops'][index]
                changed.append(([_freeze(arg) for arg in args] if operator in SHOW else args, operator)); index += 1
        require(v.drawing_fingerprint(changed, v.Canonicalizer()) == v.drawing_fingerprint(edit['ops'], v.Canonicalizer()), 'native_pdf_preservation')
        stream = ContentStream(None, writer); stream.operations = changed
        writer.pages[pn-1][NameObject('/Contents')] = writer._add_object(stream)
    return {'changes': changes, 'lineage': lineage, 'verification': _ChartVerification(proofs)}


def verify_saved(reader, verification, *, _inspection=None):
    require(type(verification) is _ChartVerification, 'native_pdf_preservation')
    inventory = _inventory(reader, _inspection)
    native = nodes(reader)
    require(len(native) == len(inventory['tags']), 'native_pdf_preservation')
    by_native = {id(node): tag for node, tag in zip(native, inventory['tags'])}
    scans = {}
    for entry in verification._entries:
        pn = entry['pageNumber']
        matches = []
        for node in native:
            direct = [v.integer(child) for child in _children(node) if v.integer(child) is not None]
            if node.get('/S') == '/Figure' and v.reference_key(node.get('/Pg')) == v.reference_key(reader.pages[pn-1]) and direct == entry['mcids']:
                matches.append(node)
        require(len(matches) == 1, 'native_pdf_preservation')
        figure = matches[0]
        require(figure.get('/Alt') == entry['alt'] and set(figure) == {'/Type', '/S', '/P', '/Pg', '/Alt', '/K'}, 'native_pdf_preservation')
        children = _children(figure)
        caption = v.resolved(children[0]) if children else None
        require(isinstance(caption, DictionaryObject) and caption.get('/S') == '/Caption'
                and _shape(caption, reader.pages) == entry['caption'], 'native_pdf_preservation')
        labels = [v.resolved(child) for child in children[1:] if isinstance(v.resolved(child), DictionaryObject)]
        require(len(children) == 1 + len(entry['mcids']) + len(labels)
                and [v.integer(child) for child in children[1:1+len(entry['mcids'])]] == entry['mcids'], 'native_pdf_preservation')
        require([_shape(label, reader.pages) for label in labels] == entry['labels']
                and all(v.resolved(label.get('/P')) is figure for label in labels), 'native_pdf_preservation')
        parent = v.resolved(figure.get('/P'))
        kids = _children(parent)
        positions = [index for index, child in enumerate(kids) if v.resolved(child) is figure]
        require(len(positions) == 1, 'native_pdf_preservation')
        _check_retained_tree(figure, parent, by_native)
        if pn not in scans:
            ops, scopes = _path_scopes(reader.pages[pn-1], semantic=True)
            scans[pn] = (ops, scopes)
        ops, scopes = scans[pn]
        require(_paint_hash(ops) == entry['pagePaint']
                and v.Canonicalizer().hash(reader.pages[pn-1].get('/Resources', {})) == entry['resources']
                and _memberships(ops, entry['originalMembership']) == entry['originalMembership'], 'native_pdf_preservation')
        for expected in entry['paint']:
            matches = [scope for scope in scopes if scope['mcid'] == expected['mcid']]
            require(len(matches) == 1 and matches[0]['safe'] and _groups(ops, matches)[0]['identity'] == expected['identity'], 'native_pdf_preservation')
        page_key = v.integer(reader.pages[pn-1].get('/StructParents'))
        array = v.number_tree(v.resolved(reader.root_object['/StructTreeRoot']).get('/ParentTree')).get(page_key)
        require(isinstance(array, ArrayObject) and all(mcid < len(array) and v.resolved(array[mcid]) is figure for mcid in entry['mcids']), 'native_pdf_preservation')
