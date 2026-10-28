"""Replace an untagged-input generator's exact generic Link alternatives.

The immutable original must have no structure tree and no authored annotation
description at the selected location. Only the generated native Link /Alt is
removed and its annotation /Contents receives exact normalized visible text.
Neither link targets nor the meaning of a numeric citation is inferred.
"""
from __future__ import annotations

import hashlib
import json
import math
import re
import unicodedata

import pypdfium2 as pdfium
from pypdf.generic import ArrayObject, DictionaryObject, NameObject as N, TextStringObject

import bounded_semantic_structure as semantic
import verify_pdf as v

MAX_LINKS = 200
MAX_ANNOTATIONS = 2000
MAX_SCAN_OPERATIONS = 8_000_000
_PROOF_TOKEN = object()


class GeneratedLinkLabelError(semantic.SemanticStructureError):
    """A controlled diagnostic without source text."""


def require(condition, code='native_pdf_preservation'):
    if not condition:
        raise GeneratedLinkLabelError(code)


def _bytes(reader):
    position = reader.stream.tell()
    try:
        reader.stream.seek(0)
        data = reader.stream.read(v.MAX_FILE_BYTES + 1)
    finally:
        reader.stream.seek(position)
    require(0 < len(data) <= v.MAX_FILE_BYTES)
    return data


def _sha(reader):
    return hashlib.sha256(_bytes(reader)).hexdigest()


def _key(node):
    key = v.reference_key(node)
    require(key is not None)
    return list(key)


def _label(value):
    if not isinstance(value, str) or len(value) > 20_000 or any(
            unicodedata.category(char) in {'Cf', 'Co', 'Cs'} or char == '\ufffd'
            or unicodedata.category(char) == 'Cc' and not char.isspace() for char in value):
        return None
    label = re.sub(r'\s+', ' ', value).strip()
    if not 1 <= len(label) <= 200 or label.casefold() in {'annotation', 'link', 'image', 'here', 'click here'}:
        return None
    return label


def _glyphs(value):
    return re.sub(r'\s+', '', value)


def _annotation_rows(reader):
    canonical, rows = v._NavigationCanonicalizer(list(reader.pages)), []
    for pn, page in enumerate(reader.pages, 1):
        annotations = v.resolved(page.get('/Annots', ArrayObject()))
        require(isinstance(annotations, ArrayObject))
        for index, reference in enumerate(annotations, 1):
            annotation = v.resolved(reference)
            require(isinstance(annotation, DictionaryObject))
            rows.append({'page': pn, 'index': index,
                'state': {str(key): canonical.hash(value) for key, value in annotation.items()}})
            require(len(rows) <= MAX_ANNOTATIONS, 'pdf_complexity_limit')
    return rows


def _comparable(row):
    return {key: value for key, value in row['state'].items() if key not in ('/Contents', '/StructParent', '/StructParents')}


def _node_state(node, pages):
    canonical = v.Canonicalizer(list(pages))
    return {str(key): canonical.hash(value) for key, value in node.items() if key not in ('/P', '/Alt')}


def _ancestors_clear(node):
    seen = set()
    for _ in range(64):
        node = v.resolved(node)
        if not isinstance(node, DictionaryObject) or id(node) in seen:
            return False
        seen.add(id(node))
        if any(key in node for key in ('/Alt', '/ActualText', '/E', '/Ref', '/AA', '/AF')):
            return False
        if node.get('/Type') == '/StructTreeRoot':
            return True
        node = node.get('/P')
    return False


class _VisibleText:
    def __init__(self, reader):
        self.document, self.pages, self.owners = pdfium.PdfDocument(_bytes(reader)), {}, {}

    def close(self):
        for page, text in self.pages.values():
            text.close(); page.close()
        self.document.close()

    def matches(self, pn, rectangle, label, mcids):
        if pn not in self.pages:
            page = self.document[pn - 1]
            text = page.get_textpage()
            self.pages[pn] = (page, text)
            self.owners[pn] = {}
            if text.count_chars() > 200_000 or pdfium.raw.FPDFPage_CountObjects(page) > 100_000:
                return False
            for obj in page.get_objects(filter=[pdfium.raw.FPDF_PAGEOBJ_TEXT], max_depth=1, textpage=text):
                mcid = pdfium.raw.FPDFPageObj_GetMarkedContentID(obj)
                if mcid >= 0:
                    self.owners[pn].setdefault(mcid, []).append((obj.extract(), obj.get_bounds()))
        groups = self.owners[pn]
        if any(mcid not in groups for mcid in mcids):
            return False
        pieces = [item for mcid in mcids for item in groups[mcid]]
        # Native export rectangles may end before the visual edge of a closing
        # bracket/comma. Require actual overlap and cap glyph overhang at two
        # points (also at one quarter of the original rectangle's height).
        tolerance = min(2., (rectangle[3] - rectangle[1]) * .25)
        if any(not all(math.isfinite(value) for value in bounds)
                or not rectangle[0] - tolerance <= bounds[0] <= bounds[2] <= rectangle[2] + tolerance
                or not rectangle[1] - tolerance <= bounds[1] <= bounds[3] <= rectangle[3] + tolerance
                or bounds[2] <= rectangle[0] or bounds[0] >= rectangle[2]
                or bounds[3] <= rectangle[1] or bounds[1] >= rectangle[3] for _, bounds in pieces):
            return False
        value = ''.join(text for text, _ in pieces)
        return len(value) <= 2000 and _glyphs(value) == _glyphs(label)


def _inspect_links(reader, *, visible_paint, allow_generic):
    inventory = v.structure_inventory(reader)
    native = semantic.nodes(reader)
    require(len(native) == len(inventory['tags']))
    tags = inventory['tags']; nodes = {tag['id']: node for tag, node in zip(tags, native)}
    owners = {}
    for tag in tags:
        for part in tag.get('contentSequence', []):
            if part.get('kind') == 'objectReference':
                owners.setdefault(part.get('annotationId'), []).append(tag['id'])
    result, page_ops, work = [], {}, 0
    for tag in tags:
        node = nodes[tag['id']]
        if (tag.get('role') != 'Link' or tag.get('sourceRole') != 'Link'
                or tag.get('textIncomplete') or tag.get('attributeGaps')
                or any(key in node for key in ('/ActualText', '/E', '/Ref', '/AA', '/AF'))
                or not _ancestors_clear(node.get('/P'))
                or ('/ID' in node and tag.get('idTreeVerified') is not True)):
            continue
        if allow_generic:
            if not isinstance(node.get('/Alt'), TextStringObject) or node['/Alt'] != 'Annotation':
                continue
        elif '/Alt' in node:
            continue
        sequence = tag.get('contentSequence', [])
        refs = [part for part in sequence if part.get('kind') == 'objectReference']
        marks = [part for part in sequence if part.get('kind') == 'markedContent']
        if (len(refs) != 1 or not marks or len(sequence) != len(marks) + 1 or len(sequence) > 64
                or any(part.get('resolved') is not True or part.get('parentTreeVerified') is not True for part in sequence)
                or any('streamId' in part for part in marks)
                or len({part.get('mcid') for part in marks}) != len(marks)):
            continue
        reference = refs[0]; pn, index = reference.get('pageNumber'), reference.get('annotationIndex')
        if (type(pn) is not int or type(index) is not int or reference.get('subtype') != 'Link'
                or reference.get('navigationInspected') is not True
                or any(part.get('pageNumber') != pn for part in marks)
                or owners.get(reference.get('annotationId')) != [tag['id']]):
            continue
        page = reader.pages[pn - 1]; annotation = v.resolved(page['/Annots'][index - 1])
        if any(key in annotation for key in ('/Alt', '/ActualText', '/OC')):
            continue
        if allow_generic and '/Contents' in annotation and (
                not isinstance(annotation['/Contents'], TextStringObject) or annotation['/Contents'] != 'Annotation'):
            continue
        try:
            rectangle, crop = [float(value) for value in v.resolved(annotation.get('/Rect', ArrayObject()))], list(map(float, page.cropbox))
            flags = int(annotation.get('/F', 0))
            if (len(rectangle) != 4 or not all(math.isfinite(value) for value in rectangle + crop)
                    or flags & (1 | 2 | 32) or not crop[0] <= rectangle[0] < rectangle[2] <= crop[2]
                    or not crop[1] <= rectangle[1] < rectangle[3] <= crop[3]):
                continue
        except (ValueError, TypeError):
            continue
        label = _label(tag.get('text'))
        if label is None or label != _label(''.join(part.get('text') or '' for part in marks)):
            continue
        if pn not in page_ops:
            page_ops[pn] = v.operations(page)
        work += len(page_ops[pn])
        if work > MAX_SCAN_OPERATIONS or len(result) >= MAX_LINKS:
            break
        if not visible_paint(page, {part['mcid'] for part in marks}, rectangle, page_ops[pn]):
            continue
        result.append({'tagId': tag['id'], 'page': pn, 'index': index, 'label': label, 'rectangle': rectangle,
            'mcids': [part['mcid'] for part in marks], 'node': node,
            'shape': _node_state(node, reader.pages), 'parent': _key(v.resolved(node['/P']))})
    return result


class _GeneratedLinkProof:
    __slots__ = ('_payload',)

    def __init__(self, token, payload):
        require(token is _PROOF_TOKEN)
        object.__setattr__(self, '_payload', json.dumps(payload, sort_keys=True, separators=(',', ':')))

    def __setattr__(self, key, value):
        require(False)

    @property
    def payload(self):
        return json.loads(self._payload)


def prepare_generated_link_labels(original, candidate, writer, *, visible_paint):
    require('/StructTreeRoot' not in original.trailer['/Root'] and callable(visible_paint))
    require(len(original.pages) == len(candidate.pages) == len(writer.pages))
    original_rows, before = _annotation_rows(original), _annotation_rows(candidate)
    require(len(original_rows) == len(before) and all(left['page'] == right['page'] and left['index'] == right['index']
        and _comparable(left) == _comparable(right) for left, right in zip(original_rows, before)))
    require(_annotation_rows(writer) == before)
    originals = {(row['page'], row['index']): row for row in original_rows}
    candidate_nodes, target_nodes = semantic.nodes(candidate), semantic.nodes(writer)
    require(len(candidate_nodes) == len(target_nodes))
    targets = {id(source): target for source, target in zip(candidate_nodes, target_nodes)}
    visible_candidate = _VisibleText(candidate)
    selected, page_checks = [], {}
    try:
        for item in _inspect_links(candidate, visible_paint=visible_paint, allow_generic=True):
            if '/Contents' in originals[(item['page'], item['index'])]['state']:
                continue
            pn = item['page']
            if pn not in page_checks:
                old, new = original.pages[pn - 1], candidate.pages[pn - 1]
                page_checks[pn] = (v.drawing_fingerprint(v.operations(old), v.Canonicalizer()) == v.drawing_fingerprint(v.operations(new), v.Canonicalizer())
                    and v.Canonicalizer().hash(old.get('/Resources', {})) == v.Canonicalizer().hash(new.get('/Resources', {})))
            # Exact original/candidate paint and resources bind these native
            # MCID text objects to the same immutable source glyphs. Object
            # bounds avoid capturing adjacent punctuation outside this owner.
            if not page_checks[pn] or not visible_candidate.matches(pn, item['rectangle'], item['label'], item['mcids']):
                continue
            target = targets[id(item['node'])]
            require(_node_state(target, writer.pages) == item['shape'] and target.get('/Alt') == 'Annotation')
            selected.append((item, target))
    finally:
        visible_candidate.close()
    changes, entries = [], []
    for item, target in selected:
        del target['/Alt']
        annotation = v.resolved(writer.pages[item['page'] - 1]['/Annots'][item['index'] - 1])
        annotation[N('/Contents')] = TextStringObject(item['label'])
        entries.append({key: value for key, value in item.items() if key not in ('node', 'parent')}
            | {'node': _key(target), 'parent': _key(v.resolved(target['/P']))})
        changes.append({'code': 'generated_link_label_restored', 'tagId': item['tagId'], 'pageNumber': item['page'],
            'message': 'Replaced a generated generic link label with its exact existing visible wording.'})
    pages = {item['page'] for item, _ in selected}
    payload = {'sourceSha256': _sha(original), 'candidateSha256': _sha(candidate),
        'pages': [{'page': pn, 'paint': v.drawing_fingerprint(v.operations(candidate.pages[pn - 1]), v.Canonicalizer()),
            'resources': v.Canonicalizer().hash(candidate.pages[pn - 1].get('/Resources', {}))} for pn in sorted(pages)],
        'annotations': _annotation_rows(writer), 'entries': entries}
    return {'changes': changes, 'verification': _GeneratedLinkProof(_PROOF_TOKEN, payload)}


def verify_saved(original, reader, verification, *, visible_paint):
    require(type(verification) is _GeneratedLinkProof and callable(visible_paint)
        and '/StructTreeRoot' not in original.trailer['/Root'])
    proof = verification.payload
    require(proof['sourceSha256'] == _sha(original) and _annotation_rows(reader) == proof['annotations'])
    for page_proof in proof['pages']:
        page = reader.pages[page_proof['page'] - 1]
        require(v.drawing_fingerprint(v.operations(page), v.Canonicalizer()) == page_proof['paint']
            and v.Canonicalizer().hash(page.get('/Resources', {})) == page_proof['resources'])
    actual = _inspect_links(reader, visible_paint=visible_paint, allow_generic=False)
    eligible = {(item['page'], item['index']): item for item in actual}
    visibility = _VisibleText(reader)
    try:
        for expected in proof['entries']:
            item = eligible.get((expected['page'], expected['index']))
            require(item is not None and item['label'] == expected['label'] and item['mcids'] == expected['mcids']
                and item['rectangle'] == expected['rectangle'] and item['shape'] == expected['shape']
                and _key(item['node']) == expected['node'] and item['parent'] == expected['parent']
                and visibility.matches(item['page'], item['rectangle'], item['label'], item['mcids']))
            annotation = v.resolved(reader.pages[item['page'] - 1]['/Annots'][item['index'] - 1])
            require(isinstance(annotation.get('/Contents'), TextStringObject) and annotation['/Contents'] == expected['label'])
    finally:
        visibility.close()
    return True
