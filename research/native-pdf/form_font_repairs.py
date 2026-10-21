"""Embed an intact open font for bounded editable forms.

This local experiment supports unembedded standard Helvetica in AcroForm /DR
and direct normal appearances of text/choice widgets. Original single-byte
code-to-Unicode mappings, current text advances, page operators, field values
and behavior are retained. Five explicit future-input metric differences are allowed. An independent font/layout validator and fresh audit are required.
"""
from __future__ import annotations

import hashlib
import io
import json
import math
from pathlib import Path
import re

from pypdf import PdfReader, PdfWriter
from pypdf.generic import (ArrayObject, ContentStream, DecodedStreamObject, DictionaryObject,
    FloatObject, NameObject, NumberObject, StreamObject, IndirectObject)
from reportlab.pdfbase import pdfmetrics, _fontdata
from reportlab.pdfbase._glyphlist import _glyphname2unicode
from reportlab.pdfbase.ttfonts import TTFontFace

from form_label_repairs import _open, _field_widgets
from form_label_validation import ExactGraph, _document_graph
from form_order_validation import compare_with_authorized_form_order
from verify_pdf import resolved, Canonicalizer

# Filled only from the official, immutable distribution inspected for this task.
FONT_FILE_SHA256 = '76d04c18ea243f426b7de1f3ad208e927008f961dc5945e5aad352d0dfde8ee8'
FONT_PROGRAM_SHA256 = FONT_FILE_SHA256
FONT_POSTSCRIPT_NAME = 'LiberationSans'
FONT_RELEASE_URL = 'https://github.com/liberationfonts/liberation-fonts/releases/tag/2.1.5'
FONT_LICENSE = 'OFL-1.1'
FUTURE_WIDTH_CHANGES = {0xAF: (333, 552), 0xB1: (584, 549), 0xB5: (556, 576), 0xB7: (278, 333), 0xF7: (584, 549)}


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def encoding_map(font):
    """Resolve a Type1 encoding without assuming that Differences mean WinAnsi."""
    if (font.get('/Subtype') != '/Type1' or font.get('/BaseFont') != '/Helvetica'
            or set(font) - {'/Type', '/Subtype', '/BaseFont', '/Encoding', '/Name'}):
        raise ValueError('bounded_unembedded_helvetica_required')
    encoding = resolved(font.get('/Encoding'))
    if isinstance(encoding, NameObject):
        base, differences = str(encoding).lstrip('/'), []
    elif isinstance(encoding, DictionaryObject):
        if set(encoding) - {'/Type', '/BaseEncoding', '/Differences'}:
            raise ValueError('unsupported_form_encoding_dictionary')
        if '/Type' in encoding and encoding['/Type'] != '/Encoding':
            raise ValueError('invalid_form_encoding_type')
        base = str(encoding.get('/BaseEncoding', '/StandardEncoding')).lstrip('/')
        differences = resolved(encoding.get('/Differences', []))
    elif encoding is None:
        base, differences = 'StandardEncoding', []
    else:
        raise ValueError('unsupported_form_encoding')
    if base not in ('StandardEncoding', 'WinAnsiEncoding') or not isinstance(differences, list) or len(differences) > 512:
        raise ValueError('supported_single_byte_encoding_required')
    vector = list(_fontdata.encodings[base]); code = None; written = set()
    for item in differences:
        if isinstance(item, NumberObject):
            code = int(item)
            if not 0 <= code <= 255: raise ValueError('encoding_code_out_of_range')
        elif isinstance(item, NameObject):
            if code is None or code > 255 or code in written:
                raise ValueError('ambiguous_encoding_differences')
            vector[code] = str(item).lstrip('/'); written.add(code); code += 1
        else:
            raise ValueError('invalid_encoding_difference')
    widths = pdfmetrics.getFont('Helvetica').face.glyphWidths
    entries = []
    for code, glyph in enumerate(vector):
        if glyph in (None, '.notdef'): continue
        point, width = _glyphname2unicode.get(glyph), widths.get(glyph)
        if point is None or width is None or not 0 < point <= 0xFFFF:
            raise ValueError('unverified_form_glyph_or_width')
        entries.append({'code': code, 'glyphName': glyph, 'unicode': point, 'width': width})
    if not entries: raise ValueError('empty_form_font_encoding')
    return entries, [code for code in range(256) if vector[code] in (None, '.notdef')]


def _resource_name(name):
    if not isinstance(name, NameObject) or not re.fullmatch(r'/[A-Za-z0-9_.+-]{1,64}', str(name)):
        raise ValueError('bounded_font_resource_name_required')
    return str(name).lstrip('/')


def font_at(reader, resource_path):
    parts = resource_path.split('/')
    if len(parts) == 4 and parts[:3] == ['AcroForm', 'DR', 'Font']:
        return resolved(reader.root_object['/AcroForm']['/DR']['/Font']['/' + parts[3]])
    if (len(parts) == 9 and parts[0] == 'page' and parts[2] == 'Annots'
            and parts[4:8] == ['AP', 'N', 'Resources', 'Font']):
        return resolved(reader.pages[int(parts[1]) - 1]['/Annots'][int(parts[3]) - 1]
                        .get_object()['/AP']['/N']['/Resources']['/Font']['/' + parts[8]])
    raise ValueError('invalid_resource_path')


def _used_codes(stream, reader, name):
    ops = ContentStream(stream, reader, 'bytes').operations
    if len(ops) > 20000: raise ValueError('appearance_operator_limit')
    current = None; stack = []; used = set()
    for args, op in ops:
        if op == b'q': stack.append(current)
        elif op == b'Q':
            if not stack: raise ValueError('unbalanced_appearance_state')
            current = stack.pop()
        elif op == b'Tf':
            if len(args) != 2: raise ValueError('invalid_appearance_font')
            current = str(args[0])
        elif op in (b'gs', b'Do', b'BI'):
            raise ValueError('complex_appearance_fonts_unsupported')
        elif op in (b'Tj', b'TJ', b"'", b'"') and current == name:
            chunks = args[0] if op == b'TJ' else args[-1:]
            for chunk in chunks:
                if isinstance(chunk, bytes): used.update(chunk)
                elif isinstance(chunk, str): raise ValueError('raw_appearance_codes_required')
    if stack: raise ValueError('unbalanced_appearance_state')
    return sorted(used)


def font_inventory(reader):
    form = reader.root_object['/AcroForm']; fields = _field_widgets(reader)
    defaults = resolved(resolved(form.get('/DR', {})).get('/Font', {}))
    if not isinstance(defaults, DictionaryObject): raise ValueError('native_default_fonts_required')
    records = []
    def consider(font, path, used):
        font = resolved(font)
        if not isinstance(font, DictionaryObject): raise ValueError('font_dictionary_required')
        if font.get('/Subtype') == '/Type0': raise ValueError('composite_form_fonts_unsupported')
        descriptor = resolved(font.get('/FontDescriptor'))
        if descriptor is not None:
            if isinstance(descriptor, DictionaryObject) and any(isinstance(resolved(descriptor.get(k)), StreamObject) for k in ('/FontFile', '/FontFile2', '/FontFile3')): return
            raise ValueError('unembedded_nonstandard_form_font_unsupported')
        entries, undefined = encoding_map(font)
        if not set(used) <= {e['code'] for e in entries}: raise ValueError('undefined_appearance_character')
        records.append({'node': font, 'resourcePath': path, 'encoding': entries,
                        'undefinedCodes': undefined, 'currentUsedCodes': used})
    for name, font in defaults.items():
        consider(font, f'AcroForm/DR/Font/{_resource_name(name)}', [])
    default_names = set(defaults)
    for field in fields:
        node = field['node']
        if '/DR' in node: raise ValueError('field_local_default_fonts_unsupported')
        if field['type'] in ('/Tx', '/Ch'):
            # Existing widgets must resolve their editable appearance font from
            # the unchanged AcroForm resources. Arbitrary fallback is unsafe.
            owner = node; da = None
            for _ in range(17):
                if '/DA' in owner: da = owner['/DA']; break
                owner = resolved(owner.get('/Parent'))
                if owner is None: break
                if '/DR' in owner: raise ValueError('field_local_default_fonts_unsupported')
            if da is None: da = form.get('/DA')
            if not isinstance(da, str) or len(da) > 1000: raise ValueError('native_default_appearance_required')
            data = DecodedStreamObject(); data.set_data(da.encode('ascii'))
            chosen = [args[0] for args, op in ContentStream(data, reader).operations if op == b'Tf' and len(args) == 2]
            if len(chosen) != 1 or chosen[0] not in default_names:
                raise ValueError('unambiguous_editable_default_font_required')
        for owned in field['widgets']:
            widget = owned['node']; ref = owned['ref']
            appearances = resolved(widget.get('/AP', {}))
            if not isinstance(appearances, DictionaryObject): raise ValueError('appearance_dictionary_required')
            for kind, appearance in appearances.items():
                appearance = resolved(appearance)
                streams = [appearance] if isinstance(appearance, StreamObject) else list(appearance.values()) if isinstance(appearance, DictionaryObject) else []
                for stream in streams:
                    stream = resolved(stream)
                    if not isinstance(stream, StreamObject): raise ValueError('appearance_stream_required')
                    resources = resolved(stream.get('/Resources', {})); fonts = resolved(resources.get('/Font', {}))
                    for name, font in fonts.items():
                        if kind != '/N' or not isinstance(appearance, StreamObject):
                            raise ValueError('state_or_rollover_appearance_fonts_unsupported')
                        rectangle = [float(x) for x in widget['/Rect']]
                        bbox = [float(x) for x in stream.get('/BBox', [])]
                        matrix = [float(x) for x in stream.get('/Matrix', [1, 0, 0, 1, 0, 0])]
                        if (len(bbox) != 4 or bbox[:2] != [0, 0] or matrix != [1, 0, 0, 1, 0, 0]
                                or any(not math.isfinite(x) for x in rectangle + bbox)
                                or abs(bbox[2] - (rectangle[2] - rectangle[0])) > .001
                                or abs(bbox[3] - (rectangle[3] - rectangle[1])) > .001):
                            raise ValueError('untransformed_widget_appearance_required')
                        consider(font, f"page/{ref['pageNumber']}/Annots/{ref['annotationIndex']}/AP/N/Resources/Font/{_resource_name(name)}",
                                 _used_codes(stream, reader, str(name)))
    if not records: raise ValueError('no_supported_unembedded_form_fonts')
    target_ids = {id(r['node']) for r in records}
    # A font used on the visible page cannot be silently swept into form-only
    # authorization through a shared dictionary.
    for page in reader.pages:
        resources = resolved(page.get('/Resources', {}))
        if resources.get('/Pattern') or resources.get('/ExtGState'):
            raise ValueError('complex_page_resource_aliases_unsupported')
        for asset in resolved(resources.get('/XObject', {})).values():
            if resolved(asset).get('/Subtype') == '/Form':
                raise ValueError('page_form_resource_aliases_unsupported')
        fonts = resolved(resolved(page.get('/Resources', {})).get('/Font', {}))
        if any(id(resolved(font)) in target_ids for font in fonts.values()):
            raise ValueError('form_font_shared_with_page_unsupported')
    return records


def _program(path):
    from fontTools.ttLib import TTFont
    path = Path(path)
    if not path.is_file() or path.stat().st_size > 2 * 1024 * 1024 or sha(path) != FONT_FILE_SHA256:
        raise ValueError('pinned_official_font_required')
    program = path.read_bytes()
    font = TTFont(io.BytesIO(program), lazy=False)
    if 'glyf' not in font or font['OS/2'].fsType != 0:
        raise ValueError('editable_embedding_permission_required')
    face = TTFontFace(str(path), validate=1)
    if face.name.decode('ascii') != FONT_POSTSCRIPT_NAME:
        raise ValueError('matching_font_name_required')
    return face, program


def _target_entries(entries, face):
    result = []
    for entry in entries:
        point = entry['unicode']
        if point not in face.charToGlyph or face.charToGlyph[point] == 0:
            raise ValueError('full_encoding_unicode_coverage_required')
        target = int(math.floor(face.charWidths[point] + .5))
        if target != entry['width'] and FUTURE_WIDTH_CHANGES.get(point) != (entry['width'], target):
            raise ValueError('unreviewed_future_width_difference')
        result.append(dict(entry, targetWidth=target))
    return result


def _replacement(writer, old, entries, program, face):
    stream = DecodedStreamObject(); stream.set_data(program)
    stream[NameObject('/Length1')] = NumberObject(len(program))
    descriptor = DictionaryObject({NameObject('/Type'): NameObject('/FontDescriptor'),
        NameObject('/FontName'): NameObject('/' + FONT_POSTSCRIPT_NAME), NameObject('/Flags'): NumberObject((face.flags & ~4) | 32),
        NameObject('/FontBBox'): ArrayObject([FloatObject(x) for x in face.bbox]),
        NameObject('/Ascent'): FloatObject(face.ascent), NameObject('/Descent'): FloatObject(face.descent),
        NameObject('/CapHeight'): FloatObject(face.capHeight), NameObject('/ItalicAngle'): FloatObject(face.italicAngle),
        NameObject('/StemV'): NumberObject(face.stemV), NameObject('/FontFile2'): writer._add_object(stream)})
    cmap = ['/CIDInit /ProcSet findresource begin', '12 dict begin', 'begincmap',
        '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def',
        '/CMapName /ACCCPFormUnicode def', '/CMapType 2 def', '1 begincodespacerange', '<00> <FF>', 'endcodespacerange']
    for offset in range(0, len(entries), 100):
        block = entries[offset:offset + 100]; cmap.append(f'{len(block)} beginbfchar')
        cmap.extend(f"<{entry['code']:02X}> <{entry['unicode']:04X}>" for entry in block); cmap.append('endbfchar')
    cmap.extend(['endcmap', 'CMapName currentdict /CMap defineresource pop', 'end', 'end'])
    unicode_stream = DecodedStreamObject(); unicode_stream.set_data(('\n'.join(cmap) + '\n').encode('ascii'))
    widths = {entry['code']: entry['targetWidth'] for entry in entries}
    names = {entry['code']: entry['glyphName'] for entry in entries}
    encoding = DictionaryObject({NameObject('/Type'): NameObject('/Encoding'), NameObject('/BaseEncoding'): NameObject('/WinAnsiEncoding'),
        NameObject('/Differences'): ArrayObject([NumberObject(0)] + [NameObject('/' + names.get(code, '.notdef')) for code in range(256)])})
    replacement = DictionaryObject({NameObject('/Type'): NameObject('/Font'), NameObject('/Subtype'): NameObject('/TrueType'), NameObject('/Encoding'): encoding,
        NameObject('/BaseFont'): NameObject('/' + FONT_POSTSCRIPT_NAME), NameObject('/FirstChar'): NumberObject(0),
        NameObject('/LastChar'): NumberObject(255), NameObject('/Widths'): ArrayObject([NumberObject(widths.get(code, 0)) for code in range(256)]),
        NameObject('/FontDescriptor'): writer._add_object(descriptor), NameObject('/ToUnicode'): writer._add_object(unicode_stream)})
    for key in ('/Name',):
        if key in old: replacement[NameObject(key)] = old.raw_get(key)
    return replacement


def planned_inventory(reader, face):
    records = font_inventory(reader)
    for record in records:
        record['encoding'] = _target_entries(record['encoding'], face)
        changed = {e['code'] for e in record['encoding'] if e['width'] != e['targetWidth']}
        if changed.intersection(record['currentUsedCodes']):
            raise ValueError('changed_advance_in_current_appearance')
        record['widthChanges'] = [{'code': e['code'], 'glyphName': e['glyphName'], 'unicode': e['unicode'],
            'sourceWidth': e['width'], 'targetWidth': e['targetWidth']} for e in record['encoding'] if e['code'] in changed]
    return records


def repair_form_fonts(original, candidate, output, *, font_path, order_ledger,
                      expected_original_sha256, expected_candidate_sha256, allow_font_substitution=False):
    original, candidate, output, font_path, order_ledger = map(Path, (original, candidate, output, font_path, order_ledger))
    if allow_font_substitution is not True: raise ValueError('explicit_font_substitution_required')
    if output.exists() or output.resolve() in {original.resolve(), candidate.resolve()}:
        raise ValueError('new_output_required')
    if (sha(original), sha(candidate)) != (expected_original_sha256, expected_candidate_sha256):
        raise ValueError('exact_input_hashes_required')
    reader = _open(candidate); _open(original)
    if order_ledger.stat().st_size > 512000: raise ValueError('bounded_prior_order_ledger_required')
    ledger_hash = sha(order_ledger)
    prior = compare_with_authorized_form_order(original, candidate, json.loads(order_ledger.read_text(encoding='utf-8')))
    if not prior.get('passed'): raise ValueError('verified_prior_form_repairs_required')
    face, program = _program(font_path)
    records = planned_inventory(reader, face)
    writer = PdfWriter(clone_from=reader); modified = set(); substitutions = []; backups = {}
    for record in records:
        current = font_at(writer, record['resourcePath']); old = record['node']
        if id(current) not in modified:
            backups[record['resourcePath']] = dict(current)
            replacement = _replacement(writer, current, record['encoding'], program, face)
            current.clear(); current.update(replacement); modified.add(id(current))
        substitutions.append({key: value for key, value in record.items() if key != 'node'} | {
            'sourceFontSha256': ExactGraph([]).hash(old), 'sourceEncodingSha256': Canonicalizer().hash(old.get('/Encoding'))})
    buffer = io.BytesIO(); writer.write(buffer); data = buffer.getvalue()
    if len(data) > 4 * 1024 * 1024: raise ValueError('candidate_size_limit')
    saved = PdfReader(io.BytesIO(data), strict=True)
    for record in substitutions:
        current = font_at(saved, record['resourcePath'])
        record['targetFontSha256'] = ExactGraph([]).hash(current)
        record['targetEncodingSha256'] = Canonicalizer().hash(current.get('/Encoding'))
    # Restore only font dictionary contents in the reopened candidate; every
    # other native object, shared reference, stream, field and tag must match.
    def rebound(value):
        if isinstance(value, IndirectObject):
            return IndirectObject(value.idnum, value.generation, saved)
        if isinstance(value, DictionaryObject):
            return DictionaryObject({key: rebound(val) for key, val in value.items()})
        if isinstance(value, ArrayObject): return ArrayObject([rebound(val) for val in value])
        return value
    for path, backup in backups.items():
        current = font_at(saved, path)
        current.clear(); current.update({key: rebound(val) for key, val in backup.items()})
    if _document_graph(reader) != _document_graph(saved): raise ValueError('unlisted_form_font_change')
    if (sha(original), sha(candidate), sha(order_ledger), sha(font_path)) != (
            expected_original_sha256, expected_candidate_sha256, ledger_hash, FONT_FILE_SHA256):
        raise ValueError('font_repair_evidence_changed')
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open('xb') as stream: stream.write(data)
    return {'schemaVersion': 1, 'operation': 'native-form-fonts', 'sourcePath': str(original.resolve()),
        'sourceSha256': expected_original_sha256, 'inputPath': str(candidate.resolve()), 'inputSha256': expected_candidate_sha256,
        'outputSha256': hashlib.sha256(data).hexdigest(), 'orderLedgerPath': str(order_ledger.resolve()), 'orderLedgerSha256': ledger_hash,
        'authorization': {'fontSubstitution': True, 'glyphAppearanceMayChange': True, 'futureInputMetricDifferences': True},
        'fontSource': {'path': str(font_path.resolve()), 'sha256': FONT_FILE_SHA256, 'postscriptName': FONT_POSTSCRIPT_NAME,
            'programSha256': FONT_PROGRAM_SHA256, 'releaseUrl': FONT_RELEASE_URL, 'license': FONT_LICENSE},
        'substitutions': substitutions, 'requiresFreshAudit': True, 'certification': False}
