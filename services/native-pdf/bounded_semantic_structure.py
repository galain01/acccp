"""Selected structure repairs at existing text-operator boundaries.

Discovery exposes possibilities, never a claim that a visual prefix is a heading
or a paragraph is a list continuation. The caller's semantic planner selects a
candidate bound to the complete input. Painting operations and original text
bytes are preserved. Unsupported structures stay available for human review.
"""
from __future__ import annotations

import copy
from decimal import Decimal
import hashlib
import json
import re

from pypdf import PdfReader, PdfWriter
from pypdf.generic import (ArrayObject, BooleanObject, ByteStringObject, ContentStream, FloatObject,
    DictionaryObject, IndirectObject, NameObject, NullObject, NumberObject,
    TextStringObject)

import verify_pdf as v

SHOW = {b'Tj', b'TJ', b"'", b'"'}
MARK = {b'BDC', b'BMC', b'EMC'}
TEXT_ONLY = SHOW | {b'Tf', b'Tm', b'Td', b'TD', b'T*', b'Tc', b'Tw', b'Tz',
    b'TL', b'Tr', b'Ts', b'i', b'g', b'G', b'rg', b'RG', b'k', b'K'}
SIMPLE_KEYS = {'/Type', '/S', '/P', '/Pg', '/K', '/A', '/Lang'}
MAX_CANDIDATES = 300
MAX_EXTRACTION_WORK = 8_000_000


class SemanticStructureError(Exception):
    """Controlled diagnostic only; no document content in exception messages."""


def fail():
    raise SemanticStructureError('native_pdf_invalid_plan')


def nodes(pdf):
    catalog = pdf.root_object if isinstance(pdf, PdfWriter) else pdf.trailer['/Root']
    root = v.resolved(catalog.get('/StructTreeRoot'))
    if not isinstance(root, DictionaryObject):
        return []
    found, seen = [], set()
    def walk(value, depth=0):
        value = v.resolved(value)
        if depth > 64 or len(seen) > 20000:
            fail()
        if isinstance(value, (DictionaryObject, ArrayObject)):
            if id(value) in seen:
                fail()
            seen.add(id(value))
        if isinstance(value, ArrayObject):
            for child in value:
                walk(child, depth + 1)
        elif isinstance(value, DictionaryObject) and value.get('/Type') not in ('/MCR', '/OBJR'):
            found.append(value)
            walk(value.get('/K'), depth + 1)
    walk(root.get('/K'))
    return found


def source_digest(reader):
    position = reader.stream.tell()
    try:
        reader.stream.seek(0)
        digest = hashlib.sha256()
        while block := reader.stream.read(1024 * 1024):
            digest.update(block)
        return digest.hexdigest()
    finally:
        reader.stream.seek(position)


def raw(value):
    """Paint comparisons retain encoded text bytes, not PDFDocEncoding guesses."""
    if isinstance(value, TextStringObject):
        return {'bytes': value.original_bytes.hex()}
    if isinstance(value, (ByteStringObject, bytes)):
        return {'bytes': bytes(value).hex()}
    if isinstance(value, (ArrayObject, list, tuple)):
        return [raw(item) for item in value]
    if isinstance(value, dict):
        return {str(key): raw(item) for key, item in sorted(value.items())}
    if isinstance(value, NameObject):
        return str(value)
    if isinstance(value, BooleanObject):
        return bool(value.value)
    if isinstance(value, IndirectObject):
        fail()
    if isinstance(value, (int, float, str)):
        return value
    if isinstance(value, NullObject):
        return None
    fail()


def paint_fingerprint(ops, allow_tj_partition=False):
    selected = []
    for args, operator in ops:
        if operator in MARK:
            continue
        # A selected simple-font suffix split adds only consecutive Tj calls.
        # Their exact encoded concatenation must equal the original Tj bytes;
        # every other operator, including TJ adjustments, remains a hard bound.
        if allow_tj_partition and operator == b'Tj' and len(args) == 1 and isinstance(args[0], (TextStringObject, ByteStringObject)):
            data = args[0].original_bytes if isinstance(args[0], TextStringObject) else bytes(args[0])
            if selected and selected[-1][1] == b'Tj' and len(selected[-1][0]) == 1 and isinstance(selected[-1][0][0], ByteStringObject):
                selected[-1] = ([ByteStringObject(bytes(selected[-1][0][0]) + data)], b'Tj')
            else:
                selected.append(([ByteStringObject(data)], b'Tj'))
        else:
            selected.append((args, operator))
    return hashlib.sha256(json.dumps([(operator.decode('ascii'), raw(args))
        for args, operator in selected], sort_keys=True,
        separators=(',', ':')).encode()).hexdigest()


def _freeze(value):
    if isinstance(value, TextStringObject):
        return ByteStringObject(value.original_bytes)
    if isinstance(value, (ArrayObject, list)):
        return ArrayObject([_freeze(child) for child in value])
    return value


class _PreciseContentFloat(FloatObject):
    """Serialize one existing operand without pypdf's display rounding."""

    def myrepr(self):
        # PDF numbers cannot use exponent notation. The shortest round-trip
        # decimal retains the original parsed float without global settings.
        value = format(Decimal(repr(float(self))), 'f')
        return value.rstrip('0').rstrip('.') if '.' in value else value


def preserved_content_stream(writer, operations):
    """Rewrite tag wrappers while retaining every parsed numeric operand."""
    def exact(value):
        if isinstance(value, FloatObject):
            return _PreciseContentFloat(float(value))
        if isinstance(value, ArrayObject):
            return ArrayObject([exact(item) for item in value])
        if isinstance(value, DictionaryObject):
            return DictionaryObject({key: exact(item) for key, item in value.items()})
        if isinstance(value, list):
            return [exact(item) for item in value]
        if isinstance(value, dict):
            return {key: exact(item) for key, item in value.items()}
        return value
    content = ContentStream(None, writer)
    content.operations = [(exact(args), operator) for args, operator in operations]
    return content


def _show_text(reader, page, ops, indices):
    indexed = v.scoped_text_operations(ops, list(range(len(ops))), [False] * len(ops))
    selected = [(args, operator) for (args, operator), index, _ in indexed
        if operator not in SHOW or index in indices]
    page_copy = copy.copy(page)
    page_copy[NameObject('/Contents')] = v.extraction_stream(selected, reader, page.get('/Resources', {}))
    return (page_copy.extract_text() or '').strip()


def _states(page, ops):
    """Conservative horizontal text state for visual candidate discovery only."""
    fonts = v.resolved(v.resolved(page.get('/Resources', {})).get('/Font', {}))
    font, size, matrix, leading = None, 0, None, 0
    saved, result = [], {}
    for index, (args, operator) in enumerate(ops):
        if operator == b'q':
            saved.append((font, size, matrix, leading))
        elif operator == b'Q':
            if not saved:
                return {}
            font, size, matrix, leading = saved.pop()
        elif operator == b'Tf' and len(args) == 2:
            font, size = str(args[0]), float(args[1])
        elif operator == b'gs':
            # ExtGState can replace the active font. Do not infer one-byte
            # encoding from an earlier Tf across an uninspected graphics state.
            font, size = None, 0
        elif operator == b'BT':
            matrix = (1., 0., 0., 1., 0., 0.)
        elif operator == b'Tm' and len(args) == 6:
            matrix = tuple(float(item) for item in args)
        elif operator in (b'Td', b'TD') and len(args) == 2 and matrix is not None:
            a, b, c, d, x, y = matrix
            tx, ty = map(float, args)
            matrix = a, b, c, d, x + tx * a + ty * c, y + tx * b + ty * d
            if operator == b'TD':
                leading = -ty
        elif operator == b'TL' and len(args) == 1:
            leading = float(args[0])
        elif operator == b'T*' and matrix is not None:
            a, b, c, d, x, y = matrix
            matrix = a, b, c, d, x - leading * c, y - leading * d
        if operator in SHOW:
            resource = v.resolved(fonts.get(font, {}))
            font_name = str(resource.get('/BaseFont', ''))
            horizontal = matrix is not None and abs(matrix[1]) < 1e-8 and abs(matrix[2]) < 1e-8
            result[index] = {'font': font, 'bold': bool(re.search(r'Bold|Black|Demi|Heavy|[-,]Bd(?:It)?$', font_name, re.I)),
                'fontName': re.sub(r'^/[A-Z]{6}\+', '/', font_name),
                'size': abs(size * matrix[3]) if horizontal else 0,
                'y': matrix[5] if horizontal else None}
    return result


def _scopes(ops, *, allow_text_boundaries=False):
    result, stack, bad, seen_mcids = {}, [], set(), set()
    for index, (args, operator) in enumerate(ops):
        if operator in (b'BDC', b'BMC'):
            valid = operator == b'BDC' and len(args) == 2 and args[0] != '/Artifact' and isinstance(args[1], DictionaryObject) and set(args[1]) == {'/MCID'}
            mcid = v.integer(args[1].get('/MCID')) if operator == b'BDC' and len(args) == 2 and isinstance(args[1], dict) else None
            if mcid is not None:
                if mcid in seen_mcids:
                    bad.add(mcid)
                seen_mcids.add(mcid)
            if stack:
                for entry in stack:
                    entry['valid'] = False
            stack.append({'mcid': mcid, 'start': index, 'valid': valid and not stack})
        elif operator == b'EMC':
            if not stack:
                return {}
            entry = stack.pop()
            if entry['mcid'] is not None:
                mcid = entry['mcid']
                if mcid in result:
                    bad.add(mcid)
                inside = list(range(entry['start'] + 1, index))
                allowed = (TEXT_ONLY - {b"'", b'"'}) | ({b'BT', b'ET'} if allow_text_boundaries else set())
                if entry['valid'] and all(ops[i][1] in allowed for i in inside):
                    result[mcid] = {'start': entry['start'], 'end': index,
                        'shows': [i for i in inside if ops[i][1] in (b'Tj', b'TJ')]}
    if stack:
        return {}
    return {key: value for key, value in result.items() if key not in bad}


def _simple(tag, node):
    content = tag.get('contentSequence', [])
    return (not tag.get('textIncomplete') and not tag.get('attributeGaps')
        and set(node) <= SIMPLE_KEYS
        and len(content) == 1 and content[0].get('kind') == 'markedContent'
        and content[0].get('resolved') is True and content[0].get('parentTreeVerified') is True
        and 'streamId' not in content[0] and isinstance(tag.get('pageNumber'), int))


def _heading_leaf(tag, node):
    """A paragraph with direct, verified text owners and no authored override."""
    if _simple(tag, node):
        return True
    content = tag.get('contentSequence', [])
    native_content = _children(node)
    return (not tag.get('textIncomplete') and not tag.get('attributeGaps')
        and set(node) <= SIMPLE_KEYS and isinstance(tag.get('pageNumber'), int)
        and bool(content) and len(content) <= 200 and len(native_content) == len(content)
        and all(item.get('kind') == 'markedContent' and item.get('resolved') is True
            and item.get('parentTreeVerified') is True and 'streamId' not in item
            and item.get('pageNumber') == tag['pageNumber']
            and v.integer(native_item) == item.get('mcid')
            for item, native_item in zip(content, native_content)))


def _children(parent):
    value = parent.get('/K')
    resolved = v.resolved(value)
    return list(resolved) if isinstance(resolved, ArrayObject) else [] if value is None else [value]


def _single_child_index(parent, child):
    matches = [index for index, item in enumerate(_children(parent)) if v.resolved(item) is child]
    if len(matches) != 1:
        fail()
    return matches[0]


class _DiscoveryInspection:
    """One fresh reader inspection, shared by checks on that unchanged reader.

    No caller-provided inventory or writer state is accepted. The worker shares
    this with authored-ID checks, enrichment and discovery, with no intervening
    reader edits. Structural plan application always rediscovers candidates;
    every saved output receives new evidence. A comparison may transfer its
    fresh saved-byte evidence by minting a new reader, never by importing a
    caller's inventory or retaining a mutable reader from an earlier phase.
    """
    __slots__ = ('_reader', '_inventory', '_saved_pdf', '_source_sha256')

    def __init__(self, reader):
        if not isinstance(reader, PdfReader):
            fail()
        self._reader = reader
        self._inventory = v.structure_inventory(reader)
        self._saved_pdf = None
        self._source_sha256 = source_digest(reader)

    @classmethod
    def _from_saved_pdf(cls, evidence):
        if cls is not _DiscoveryInspection or type(evidence) is not v._PdfInspection:
            fail()
        result = object.__new__(cls)
        result._reader = evidence.fresh_reader()
        result._inventory = evidence.copy_for(result._reader.stream.getvalue())
        result._saved_pdf = evidence
        result._source_sha256 = source_digest(result._reader)
        return result._reader, result

    def copy_for(self, reader):
        if reader is not self._reader or source_digest(reader) != self._source_sha256:
            fail()
        # Worker enrichment adds editing flags and child indexes. Those must
        # never become part of the raw evidence used for candidate discovery.
        return copy.deepcopy(self._inventory)


def _discover(reader, *, _inspection=None):
    if _inspection is not None and type(_inspection) is not _DiscoveryInspection:
        fail()
    inventory = (_inspection.copy_for(reader) if _inspection is not None
                 else v.structure_inventory(reader))
    tags, objects = inventory['tags'], nodes(reader)
    if len(tags) != len(objects):
        fail()
    by_id = {tag['id']: tag for tag in tags}
    native = {tag['id']: node for tag, node in zip(tags, objects)}
    pages = list(reader.pages)
    page_ops = [v.operations(page) for page in pages]
    scopes = [_scopes(ops) for ops in page_ops]
    states = [_states(page, ops) for page, ops in zip(pages, page_ops)]
    unsafe_pages = {finding.get('page') for finding in inventory['findings']
        if finding['code'] in {'duplicate_mcid', 'invalid_mcid', 'unbalanced_marked_content',
            'nested_mcid_scope_unsupported', 'invalid_marked_content_properties',
            'duplicate_structure_content', 'parent_tree_owner_mismatch'}}
    pdf_hash, result = source_digest(reader), []
    extraction_work = 0
    def show_text(pi, indices):
        nonlocal extraction_work
        extraction_work += len(page_ops[pi])
        if extraction_work > MAX_EXTRACTION_WORK:
            raise SemanticStructureError('pdf_complexity_limit')
        return _show_text(reader, pages[pi], page_ops[pi], indices)
    def authored_override(tag):
        while tag:
            if any(key in native[tag['id']] for key in ('/ID', '/Alt', '/ActualText', '/E')):
                return True
            tag = by_id.get(tag.get('parentId'))
        return False
    def add(kind, tag, preview, related, details):
        public = {'kind': kind, 'tagId': tag['id'], 'pageNumber': tag['pageNumber'],
            'text': tag.get('text', '')[:20000], 'preview': preview[:20000], 'relatedTagIds': related}
        bound = {'source': pdf_hash, **public, 'details': details}
        public['candidateId'] = hashlib.sha256(json.dumps(bound, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
        result.append((public, details))
        if len(result) > MAX_CANDIDATES:
            raise SemanticStructureError('pdf_complexity_limit')
    eligible = {}
    for tag in tags:
        if tag['role'] not in ('P', 'Note') or not _simple(tag, native[tag['id']]) or authored_override(tag) or tag.get('pageNumber') in unsafe_pages:
            continue
        page_index = tag['pageNumber'] - 1
        mcid = tag['contentSequence'][0]['mcid']
        scope = scopes[page_index].get(mcid)
        if scope and len(scope['shows']) >= 1:
            eligible[tag['id']] = (page_index, mcid, scope)
    # A run-in heading may share only its first MCID with prose, while many
    # later MCIDs still belong to the same paragraph. Keep all later owners.
    for tag in tags:
        if (tag['role'] != 'P' or not _heading_leaf(tag, native[tag['id']])
            or authored_override(tag) or tag.get('pageNumber') in unsafe_pages):
            continue
        pi = tag['pageNumber'] - 1
        mcid = tag['contentSequence'][0]['mcid']
        scope = scopes[pi].get(mcid)
        if not scope or len(scope['shows']) < 2:
            continue
        show, state = scope['shows'], states[pi]
        first_plain = next((i for i in range(1, len(show)) if not state.get(show[i], {}).get('bold')), None)
        split_at, prefix, body = None, None, None
        if state.get(show[0], {}).get('bold') and first_plain is not None:
            prefix = show_text(pi, set(show[:first_plain]))
            body = show_text(pi, set(show[first_plain:]))
            if 4 <= len(prefix) <= 240 and len(body) >= 10 and prefix[-1] in '.:?!':
                split_at = first_plain
        if split_at is None and len(show) >= 3:
            first, separator, prose = [state.get(index, {}) for index in show[:3]]
            em = prose.get('size', 0)
            font_transition = (first.get('font') and first.get('font') == separator.get('font')
                and first.get('font') != prose.get('font') and em > 0
                and first.get('fontName') and prose.get('fontName')
                and first.get('fontName') != prose.get('fontName')
                and all(item.get('y') is not None and .8*em <= item.get('size', 0) <= 1.3*em
                    and abs(item['y']-prose['y']) <= .4*em for item in (first, separator)))
            if font_transition and show_text(pi, {show[1]}) == '|':
                label = show_text(pi, {show[0]})
                if (4 <= len(label) <= 80 and len(label.split()) <= 10
                    and re.fullmatch(r'[\w][\w /\-\u2013\u2014]*', label)
                    and any(character.isalpha() for character in label)):
                    prefix = show_text(pi, set(show[:2]))
                    body = show_text(pi, set(show[2:]))
                    if len(body) >= 10:
                        split_at = 2
        if split_at is not None:
            add('split_heading', tag, f'Heading: {prefix}\nParagraph: {body}', [],
                {'pageIndex': pi, 'mcid': mcid, 'split': show[split_at], 'scope': scope,
                 'prefix': prefix, 'body': body,
                 'additionalMcids': [item['mcid'] for item in tag['contentSequence'][1:]]})
    note_markers = {}
    for tag in tags:
        if tag['role'] not in ('P', 'Note') or tag['id'] not in eligible:
            continue
        pi, mcid, scope = eligible[tag['id']]
        if len(scope['shows']) < 2:
            continue
        marker = show_text(pi, {scope['shows'][0]})
        show = scope['shows']
        first = states[pi].get(show[0], {})
        # An authored Note is explicit evidence. A P is only a possible note
        # when its isolated leading marker is visibly superscripted too.
        body_states = [states[pi].get(index, {}) for index in show[1:]]
        raised = any(item.get('size', 0) > 0 and 0 < first.get('size', 0) <= item['size'] * .85
            and item.get('y') is not None and first.get('y') is not None
            and 0 < first['y'] - item['y'] <= item['size'] * 1.5 for item in body_states)
        if re.fullmatch(r'[1-9][0-9]{0,2}|\*{1,2}|[†‡]', marker) and (tag['role'] == 'Note' or raised or marker in ('*', '**')):
            note_markers.setdefault((pi, marker), []).append((tag, mcid, scope))
    note_pages = {page_index for page_index, _ in note_markers}
    for tag in tags:
        if tag['role'] != 'P' or tag['id'] not in eligible:
            continue
        pi, mcid, scope = eligible[tag['id']]
        ops, show = page_ops[pi], scope['shows']
        state = states[pi]
        marker = show_text(pi, {show[-1]}) if pi in note_pages else None
        matches = note_markers.get((pi, marker), [])
        previous, last = state.get(show[-2], {}) if len(show) >= 2 else {}, state.get(show[-1], {})
        raised = (previous.get('size', 0) > 0 and 0 < last.get('size', 0) <= previous['size'] * .85
            and previous.get('y') is not None and last.get('y') is not None
            and 0 < last['y'] - previous['y'] <= previous['size'] * 1.5)
        if len(matches) == 1 and raised:
            note, note_mcid, note_scope = matches[0]
            if int(note['id'][4:]) > int(tag['id'][4:]):
                add('mark_note_reference', tag, f'Footnote marker {marker}; note: {note["text"].strip()}', [note['id']],
                    {'pageIndex': pi, 'mcid': mcid, 'split': show[-1], 'scope': scope,
                     'noteTagId': note['id'], 'noteMcid': note_mcid, 'noteScope': note_scope,
                     'noteSplit': note_scope['shows'][1], 'marker': marker})
        # A strict one-byte suffix partition can preserve an inline asterisk
        # whose source Tj also contains prose. Never decode/re-encode a glyph or
        # partition variable-width/custom font codes.
        args, operator = ops[show[-1]]
        fonts = v.resolved(v.resolved(pages[pi].get('/Resources', {})).get('/Font', {}))
        font = v.resolved(fonts.get(state.get(show[-1], {}).get('font'), {}))
        data = (args[0].original_bytes if isinstance(args[0], TextStringObject) else bytes(args[0])) if operator == b'Tj' and len(args) == 1 and isinstance(args[0], (TextStringObject, ByteStringObject)) else None
        suffix = re.search(rb'(?<=[^*])(\*{1,2})$', data) if data and len(data) <= 4096 else None
        if suffix and font.get('/Subtype') in ('/Type1', '/TrueType') and font.get('/Encoding') == '/WinAnsiEncoding' and '/ToUnicode' not in font:
            marker = suffix.group(1).decode('ascii')
            matches = note_markers.get((pi, marker), [])
            if len(matches) == 1 and int(matches[0][0]['id'][4:]) > int(tag['id'][4:]):
                note, note_mcid, note_scope = matches[0]
                add('mark_note_reference', tag, f'Footnote marker {marker}; note: {note["text"].strip()}', [note['id']],
                    {'pageIndex': pi, 'mcid': mcid, 'split': show[-1], 'scope': scope,
                     'noteTagId': note['id'], 'noteMcid': note_mcid, 'noteScope': note_scope,
                     'noteSplit': note_scope['shows'][1], 'marker': marker,
                     'partitionPrefixHex': data[:suffix.start(1)].hex(), 'partitionMarkerHex': suffix.group(1).hex()})
    # Only the next meaningful leaf can be proposed as a continuation.
    leaves = [tag for tag in tags if tag.get('contentSequence') and any(item.get('kind') != 'childTag' for item in tag['contentSequence'])]
    for left, right in zip(leaves, leaves[1:]):
        if left['role'] != 'LBody' or right['role'] != 'P' or not _simple(left, native[left['id']]) or not _simple(right, native[right['id']]) or authored_override(left) or authored_override(right) or left.get('pageNumber') in unsafe_pages:
            continue
        li = by_id.get(left['parentId'], {})
        listing = by_id.get(li.get('parentId'), {})
        if li.get('role') != 'LI' or listing.get('role') != 'L' or left['pageNumber'] != right['pageNumber'] or left.get('effectiveLanguage') != right.get('effectiveLanguage'):
            continue
        # Last item/body only; no following sibling content may be crossed.
        if v.resolved(_children(native[li['id']])[-1]) is not native[left['id']] or v.resolved(_children(native[listing['id']])[-1]) is not native[li['id']]:
            continue
        ancestors, cursor = set(), left
        while cursor.get('parentId'):
            cursor = by_id[cursor['parentId']]
            ancestors.add(cursor['id'])
        cursor, path = right, []
        while cursor.get('parentId') and cursor['parentId'] not in ancestors:
            cursor = by_id[cursor['parentId']]
            path.append(cursor)
        if any(item['role'] not in ('Div', 'Sect') or set(native[item['id']]) - SIMPLE_KEYS for item in path):
            continue
        # Avoid offering a new sentence after a complete bullet as a default.
        if not left.get('text', '').rstrip().endswith(('.', '!', '?', ':', ';')) and right.get('text', '').lstrip()[:1].islower():
            add('join_list_continuation', right,
                f'Continue the preceding list item: {left["text"].strip()} {right["text"].strip()}', [left['id']],
                {'listBodyId': left['id']})
    # Existing labels are evidence for a possible list, not newly authored text.
    # Preserve whole paragraphs when a label shares its encoded text operator
    # with the prose; LBody may contain that unchanged paragraph without a Lbl.
    list_items, list_sections = {}, {}
    def list_marker(tag):
        text = tag.get('text', '').lstrip()
        match = re.match(r'([1-9][0-9]{0,2}|[A-Z])([.)\u2013\u2014-])(?:\s+|(?=[A-Z]))', text)
        if match:
            return match.group(1)
        # A missing ToUnicode map can obscure a native WinAnsi em dash in the
        # extraction. Verify its exact encoded prefix and original font encoding
        # instead of treating an arbitrary replacement character as punctuation.
        pi = tag['pageNumber'] - 1
        scope = scopes[pi].get(tag['contentSequence'][0]['mcid'])
        if not scope or not scope['shows']:
            return None
        index = scope['shows'][0]
        args, operator = page_ops[pi][index]
        if operator != b'Tj' or len(args) != 1 or not isinstance(args[0], (TextStringObject, ByteStringObject)):
            return None
        font_name = states[pi].get(index, {}).get('font')
        fonts = v.resolved(v.resolved(pages[pi].get('/Resources', {})).get('/Font', {}))
        font = v.resolved(fonts.get(font_name, {}))
        if font.get('/Encoding') != '/WinAnsiEncoding' or '/ToUnicode' in font:
            return None
        data = args[0].original_bytes if isinstance(args[0], TextStringObject) else bytes(args[0])
        match = re.match(rb'^\s*([1-9][0-9]{0,2}|[A-Z])\x97(?=[A-Z])', data)
        return match.group(1).decode('ascii') if match else None
    def neutral_path(tag, stop=None):
        while tag.get('parentId') and tag['parentId'] != stop:
            tag = by_id[tag['parentId']]
            if tag['role'] in ('Part', 'Document'):
                return True
            if tag['role'] not in ('Div', 'Sect') or set(native[tag['id']]) - SIMPLE_KEYS:
                return False
        return True
    for tag in leaves:
        if tag['role'] != 'P' or not _simple(tag, native[tag['id']]) or authored_override(tag) or tag['pageNumber'] in unsafe_pages or not neutral_path(tag):
            continue
        marker = list_marker(tag)
        if marker:
            list_items[tag['id']] = marker
            boundary = tag
            while boundary.get('parentId') and boundary['role'] not in ('Part', 'Document'):
                boundary = by_id[boundary['parentId']]
            list_sections[tag['id']] = boundary['id']
    def successor(left, right):
        a, z = list_items[left['id']], list_items[right['id']]
        return ((a.isdigit() and z.isdigit() and int(z) == int(a) + 1)
            or (len(a) == len(z) == 1 and a.isalpha() and z.isalpha() and ord(z) == ord(a) + 1))
    def emit_list(group):
        identifiers = [tag['id'] for tag in group]
        add('convert_list', group[0], 'List items, retaining their original labels:\n' + '\n'.join(tag['text'].strip() for tag in group), identifiers[1:],
            {'itemIds': identifiers, 'markers': [list_items[item] for item in identifiers]})
    groups, group = [], []
    for leaf in leaves:
        matches = (leaf['id'] in list_items and (not group or
            (group[-1]['pageNumber'] == leaf['pageNumber']
             and list_sections[group[-1]['id']] == list_sections[leaf['id']]
             and group[-1].get('effectiveLanguage') == leaf.get('effectiveLanguage')
             and successor(group[-1], leaf))))
        if not matches or len(group) >= 21:
            if group:
                groups.append(group)
            group = []
        if leaf['id'] in list_items:
            group.append(leaf)
    if group:
        groups.append(group)
    leaf_positions = {leaf['id']: index for index, leaf in enumerate(leaves)}
    for group_index, group in enumerate(groups):
        if len(group) >= 2:
            emit_list(group)
        elif group_index > 0 and len(groups[group_index - 1]) == 21 and (
            leaf_positions[group[0]['id']] == leaf_positions[groups[group_index - 1][-1]['id']] + 1
            and group[0]['pageNumber'] == groups[group_index - 1][-1]['pageNumber']
            and list_sections[group[0]['id']] == list_sections[groups[group_index - 1][-1]['id']]
            and group[0].get('effectiveLanguage') == groups[group_index - 1][-1].get('effectiveLanguage')
            and successor(groups[group_index - 1][-1], group[0])):
            emit_list(group)
        elif list_items[group[0]['id']] in ('1', 'A'):
            # A one-item fragment at a page boundary is offered only when the
            # next page has an independently verified multi-item continuation.
            # Page headers stay in place; do not move text to join the fragments.
            final_on_page = not any(leaf['pageNumber'] == group[0]['pageNumber']
                for leaf in leaves[leaf_positions[group[0]['id']] + 1:])
            following = [other for other in groups if final_on_page and len(other) >= 2
                and other[0]['pageNumber'] == group[0]['pageNumber'] + 1
                and group[0].get('effectiveLanguage') == other[0].get('effectiveLanguage')
                and successor(group[0], other[0])]
            # Page-header text remains exactly where it was. A longer preamble
            # or a section heading means the relationship is too uncertain to
            # offer this special one-item fragment candidate.
            following = [other for other in following if len(prefix := [leaf for leaf in
                leaves[leaf_positions[group[0]['id']] + 1:leaf_positions[other[0]['id']]]
                if leaf['pageNumber'] == other[0]['pageNumber']]) <= 2
                and all(leaf['role'] == 'P' and len(leaf.get('text', '').strip()) <= 100 for leaf in prefix)]
            if len(following) == 1:
                emit_list(group)
    return result, inventory, objects


def discover_candidates(reader, *, _inspection=None):
    return [public for public, _ in _discover(reader, _inspection=_inspection)[0]]


def _reference(writer, node):
    return getattr(node, 'indirect_reference', None) or writer._add_object(node)


def _new_tag(writer, role, parent, page, content):
    node = DictionaryObject({NameObject('/Type'): NameObject('/StructElem'),
        NameObject('/S'): NameObject('/' + role), NameObject('/P'): _reference(writer, parent),
        NameObject('/Pg'): page.indirect_reference, NameObject('/K'): content})
    writer._add_object(node)
    return node


_SPLIT_PROOF_TOKEN = object()


class _SplitHeadingVerification:
    """Only an applied source-bound plan can create this saved-file proof."""
    __slots__ = ('_payload',)

    def __init__(self, token, entries):
        if token is not _SPLIT_PROOF_TOKEN:
            fail()
        object.__setattr__(self, '_payload', json.dumps(entries, sort_keys=True, separators=(',', ':')))

    def __setattr__(self, name, value):
        fail()

    @property
    def entries(self):
        return json.loads(self._payload)


def _split_node_key(node):
    key = v.reference_key(node)
    if key is None:
        fail()
    return key


def _split_shape(node, pages):
    return {'parent': _split_node_key(v.resolved(node.get('/P'))),
        'attributes': v.Canonicalizer(pages).value(DictionaryObject({key: value
            for key, value in node.items() if key not in ('/P', '/K')})),
        'content': v.Canonicalizer(pages).value(node.get('/K'))}


def _split_text(text):
    return re.sub(r'\s+', ' ', text).strip()


def _verified_split_body(source_reader, writer, node, source_tag_id, proof):
    """Composition guard for a later repair that reads this split body anchor."""
    if type(proof) is not _SplitHeadingVerification:
        return False
    for entry in proof.entries:
        if (entry.get('sourceTagId') == source_tag_id
            and entry.get('sourceSha256') == source_digest(source_reader)
            and tuple(entry['body']) == _split_node_key(node)
            and json.dumps(_split_shape(node, list(writer.pages)), sort_keys=True)
                == json.dumps(entry['bodyShape'], sort_keys=True)):
            return True
    return False


def verify_saved(reader, verification, *, _inspection=None):
    """Check split headings against reopened hierarchy and MCID text owners."""
    if type(verification) is not _SplitHeadingVerification:
        fail()
    if not verification.entries:
        return True
    if _inspection is not None and type(_inspection) is not _DiscoveryInspection:
        fail()
    inventory = (_inspection.copy_for(reader) if _inspection is not None
        else v.structure_inventory(reader))
    native = nodes(reader)
    if len(native) != len(inventory['tags']):
        fail()
    indexed = {_split_node_key(node): node for node in native}
    tag_map = {_split_node_key(node): tag for node, tag in zip(native, inventory['tags'])}
    pages = list(reader.pages)
    for proof in verification.entries:
        for name in ('heading', 'body'):
            key = tuple(proof[name])
            if (key not in indexed or json.dumps(_split_shape(indexed[key], pages), sort_keys=True)
                != json.dumps(proof[name+'Shape'], sort_keys=True)):
                fail()
            content = tag_map[key]['contentSequence']
            expected = proof[name+'Text']
            if (len(content) != len(expected) or any(
                item.get('kind') != 'markedContent' or item.get('resolved') is not True
                or item.get('parentTreeVerified') is not True or 'streamId' in item
                or item.get('pageNumber') != proof['page'] or item.get('mcid') != mcid
                or _split_text(item.get('text', '')) != text
                for item, (mcid, text) in zip(content, expected))):
                fail()
        parent = indexed.get(tuple(proof['parent']))
        if parent is None:
            structure_root = v.resolved(reader.trailer['/Root'].get('/StructTreeRoot'))
            if v.reference_key(structure_root) == tuple(proof['parent']):
                parent = structure_root
        if parent is None:
            fail()
        siblings = [_split_node_key(v.resolved(item)) for item in _children(parent)]
        if sum(siblings[i:i+2] == [tuple(proof['heading']), tuple(proof['body'])]
               for i in range(len(siblings))) != 1:
            fail()
    return True


def apply_operations(source_reader, writer, operations, *, _inspection=None):
    """Apply only rediscovered, hash-bound candidates; return native-node lineage.

    The writer must be cloned from source_reader. Ordinary repairs can precede
    this call, but cannot change the roles of nodes participating in these ops.
    Caller still reopens and runs independent document preservation/pixel checks.
    """
    if not isinstance(operations, list) or len(operations) > 500:
        fail()
    candidates, inventory, original_nodes = _discover(source_reader, _inspection=_inspection)
    targets = nodes(writer)
    if len(targets) != len(original_nodes):
        fail()
    by_id = {tag['id']: node for tag, node in zip(inventory['tags'], targets)}
    source_nodes = {tag['id']: node for tag, node in zip(inventory['tags'], original_nodes)}
    lineage = [{'node': node, 'sourceTagId': tag['id']} for tag, node in zip(inventory['tags'], targets)]
    options = {public['candidateId']: (public, detail) for public, detail in candidates}
    selected, used, shared_notes = [], set(), set()
    for operation in operations:
        if not isinstance(operation, dict) or operation.get('type') != 'repair_structure' or operation.get('candidateId') not in options:
            fail()
        public, detail = options[operation['candidateId']]
        expected_keys = {'type', 'tagId', 'candidateId'} | ({'role'} if public['kind'] == 'split_heading' else set())
        if set(operation) != expected_keys or operation['tagId'] != public['tagId'] or ('role' in operation and operation['role'] not in ('H2', 'H3', 'H4', 'H5', 'H6')):
            fail()
        participants = {public['tagId'], *public['relatedTagIds']}
        note = detail.get('noteTagId') if public['kind'] == 'mark_note_reference' else None
        if (participants & used) - ({note} if note in shared_notes else set()):
            fail()
        used |= participants
        if note:
            shared_notes.add(note)
        for identifier in participants:
            # Ordinary tag edits must not change the assumptions of a split/join.
            if by_id[identifier].get('/S') != source_nodes[identifier].get('/S') or set(by_id[identifier]) != set(source_nodes[identifier]):
                fail()
            left = DictionaryObject({key: item for key, item in source_nodes[identifier].items() if key not in ('/P', '/Pg')})
            right = DictionaryObject({key: item for key, item in by_id[identifier].items() if key not in ('/P', '/Pg')})
            if v.Canonicalizer(list(source_reader.pages)).hash(left) != v.Canonicalizer(list(writer.pages)).hash(right):
                fail()
        selected.append((operation, public, detail))
    root = v.resolved(writer.root_object.get('/StructTreeRoot'))
    parents = v.number_tree(root.get('/ParentTree')) if selected else {}
    page_edits, changes, completed_notes, split_proofs = {}, [], set(), []
    def edit_page(pi):
        if pi not in page_edits:
            page = writer.pages[pi]
            ops = v.operations(page)
            original = v.operations(source_reader.pages[pi])
            if paint_fingerprint(ops) != paint_fingerprint(original) or raw([(args, operator.decode()) for args, operator in ops if operator in MARK]) != raw([(args, operator.decode()) for args, operator in original if operator in MARK]):
                fail()
            key = v.integer(page.get('/StructParents'))
            array = parents.get(key)
            if not isinstance(array, ArrayObject):
                fail()
            all_mcids = inventory['page_content'][pi]['mcids']
            page_edits[pi] = {'ops': ops, 'inserts': {}, 'replacements': {}, 'parentArray': array,
                'next': max([len(array) - 1, *all_mcids], default=-1) + 1,
                'paint': paint_fingerprint(ops)}
        return page_edits[pi]
    def allocate(edit, owner):
        mcid = edit['next']
        edit['next'] += 1
        if mcid > 100000:
            fail()
        array = edit['parentArray']
        while len(array) <= mcid:
            array.append(NullObject())
        array[mcid] = _reference(writer, owner)
        return mcid
    def split_scope(edit, detail, new_mcid, boundary=None, scope=None):
        boundary = detail['split'] if boundary is None else boundary
        scope = detail['scope'] if scope is None else scope
        if boundary in edit['inserts']:
            fail()
        args = edit['ops'][scope['start']][0]
        edit['inserts'][boundary] = [([], b'EMC'), ([args[0], DictionaryObject({NameObject('/MCID'): NumberObject(new_mcid)})], b'BDC')]
    for operation, public, detail in selected:
        target = by_id[public['tagId']]
        pi = public['pageNumber'] - 1
        page = writer.pages[pi]
        if public['kind'] == 'convert_list':
            first_parent = v.resolved(target['/P'])
            siblings = _children(first_parent)
            first_index = _single_child_index(first_parent, target)
            listing = _new_tag(writer, 'L', first_parent, page, ArrayObject())
            numbering = 'Decimal' if detail['markers'][0].isdigit() else 'UpperAlpha'
            listing[NameObject('/A')] = DictionaryObject({NameObject('/O'): NameObject('/List'),
                NameObject('/ListNumbering'): NameObject('/' + numbering)})
            siblings[first_index] = _reference(writer, listing)
            first_parent[NameObject('/K')] = ArrayObject(siblings)
            lineage.append({'node': listing, 'sourceTagId': public['tagId']})
            list_children = []
            for identifier in detail['itemIds']:
                paragraph = by_id[identifier]
                if paragraph is not target:
                    parent = v.resolved(paragraph['/P'])
                    siblings = _children(parent)
                    siblings.pop(_single_child_index(parent, paragraph))
                    parent[NameObject('/K')] = ArrayObject(siblings)
                item = _new_tag(writer, 'LI', listing, page, ArrayObject())
                body = _new_tag(writer, 'LBody', item, page, _reference(writer, paragraph))
                paragraph[NameObject('/P')] = _reference(writer, body)
                item[NameObject('/K')] = _reference(writer, body)
                list_children.append(_reference(writer, item))
                lineage.extend({'node': node, 'sourceTagId': identifier} for node in (item, body))
            listing[NameObject('/K')] = ArrayObject(list_children)
        elif public['kind'] == 'join_list_continuation':
            body = by_id[detail['listBodyId']]
            parent = v.resolved(target['/P'])
            siblings = _children(parent)
            siblings.pop(_single_child_index(parent, target))
            parent[NameObject('/K')] = ArrayObject(siblings)
            existing = _new_tag(writer, 'P', body, page, body['/K'])
            lineage.append({'node': existing, 'sourceTagId': detail['listBodyId']})
            edit = edit_page(pi)
            mcid = inventory['tags'][int(detail['listBodyId'][4:]) - 1]['contentSequence'][0]['mcid']
            edit['parentArray'][mcid] = _reference(writer, existing)
            body[NameObject('/K')] = ArrayObject([_reference(writer, existing), _reference(writer, target)])
            target[NameObject('/P')] = _reference(writer, body)
        elif public['kind'] == 'split_heading':
            parent = v.resolved(target['/P'])
            edit = edit_page(pi)
            heading = _new_tag(writer, operation['role'], parent, page, NumberObject(detail['mcid']))
            if '/Lang' in target:
                heading[NameObject('/Lang')] = target['/Lang']
            siblings = _children(parent)
            siblings.insert(_single_child_index(parent, target), _reference(writer, heading))
            parent[NameObject('/K')] = ArrayObject(siblings)
            edit['parentArray'][detail['mcid']] = _reference(writer, heading)
            new_mcid = allocate(edit, target)
            remaining = _children(target)[1:]
            target[NameObject('/K')] = (ArrayObject([NumberObject(new_mcid), *remaining])
                if remaining else NumberObject(new_mcid))
            split_scope(edit, detail, new_mcid)
            lineage.append({'node': heading, 'sourceTagId': public['tagId']})
            original_tag = next(tag for tag in inventory['tags'] if tag['id'] == public['tagId'])
            split_proofs.append({'heading': _split_node_key(heading), 'body': _split_node_key(target),
                'sourceTagId': public['tagId'], 'sourceSha256': source_digest(source_reader),
                'parent': _split_node_key(parent), 'page': pi+1,
                'headingShape': _split_shape(heading, list(writer.pages)),
                'bodyShape': _split_shape(target, list(writer.pages)),
                'headingText': [(detail['mcid'], _split_text(detail['prefix']))],
                'bodyText': [(new_mcid, _split_text(detail['body'])),
                    *[(item['mcid'], _split_text(item.get('text', '')))
                      for item in original_tag['contentSequence'][1:]]]})
        else:
            edit = edit_page(pi)
            reference = _new_tag(writer, 'Reference', target, page, ArrayObject())
            label = _new_tag(writer, 'Lbl', reference, page, NumberObject(0))
            new_mcid = allocate(edit, label)
            label[NameObject('/K')] = NumberObject(new_mcid)
            reference[NameObject('/K')] = _reference(writer, label)
            target[NameObject('/K')] = ArrayObject([target['/K'], _reference(writer, reference)])
            if 'partitionPrefixHex' in detail:
                index = detail['split']
                if index in edit['inserts'] or index in edit['replacements']:
                    fail()
                prefix = bytes.fromhex(detail['partitionPrefixHex'])
                marker = bytes.fromhex(detail['partitionMarkerHex'])
                source_args, source_operator = edit['ops'][index]
                source_data = source_args[0].original_bytes if isinstance(source_args[0], TextStringObject) else bytes(source_args[0])
                if source_operator != b'Tj' or prefix + marker != source_data:
                    fail()
                mark_name = edit['ops'][detail['scope']['start']][0][0]
                edit['replacements'][index] = [([ByteStringObject(prefix)], b'Tj'), ([], b'EMC'),
                    ([mark_name, DictionaryObject({NameObject('/MCID'): NumberObject(new_mcid)})], b'BDC'),
                    ([ByteStringObject(marker)], b'Tj')]
            else:
                split_scope(edit, detail, new_mcid)
            lineage.extend({'node': item, 'sourceTagId': public['tagId']} for item in (reference, label))
            if detail['noteTagId'] not in completed_notes:
                completed_notes.add(detail['noteTagId'])
                note = by_id[detail['noteTagId']]
                note[NameObject('/S')] = NameObject('/Note')
                note_label = _new_tag(writer, 'Lbl', note, page, note['/K'])
                note_body_mcid = allocate(edit, note)
                note[NameObject('/K')] = ArrayObject([_reference(writer, note_label), NumberObject(note_body_mcid)])
                edit['parentArray'][detail['noteMcid']] = _reference(writer, note_label)
                split_scope(edit, detail, note_body_mcid, detail['noteSplit'], detail['noteScope'])
                lineage.append({'node': note_label, 'sourceTagId': detail['noteTagId']})
        changes.append({'code': public['kind'], 'tagId': public['tagId'], 'pageNumber': public['pageNumber'],
            'candidateId': public['candidateId'], 'relatedTagIds': public['relatedTagIds'],
            'message': {'split_heading': 'Made the existing section title a separate heading while keeping its following paragraph.',
                'join_list_continuation': 'Kept the continuation paragraph inside its existing list item.',
                'convert_list': 'Identified these existing numbered or lettered paragraphs as list items, retaining their original labels and text.',
                'mark_note_reference': 'Separated the existing footnote marker from the surrounding text and identified its matching note.'}[public['kind']]})
    for pi, edit in page_edits.items():
        changed = []
        for index, (args, operator) in enumerate(edit['ops']):
            changed.extend(edit['inserts'].get(index, []))
            changed.extend(edit['replacements'].get(index, [([_freeze(arg) for arg in args] if operator in SHOW else args, operator)]))
        if paint_fingerprint(changed, bool(edit['replacements'])) != paint_fingerprint(edit['ops'], bool(edit['replacements'])):
            raise SemanticStructureError('native_pdf_preservation')
        content = preserved_content_stream(writer, changed)
        writer.pages[pi][NameObject('/Contents')] = writer._add_object(content)
    return {'changes': changes, 'lineage': lineage,
        'verification': _SplitHeadingVerification(_SPLIT_PROOF_TOKEN, split_proofs)}
