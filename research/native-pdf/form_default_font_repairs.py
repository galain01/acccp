"""Add a Unicode editing font while retaining existing native appearances.

Acrobat's interactive form text can differ from its static appearance rendering.
This bounded repair uses a separate embedded Identity-H font for future editing,
retaining the exact original repertoire and genuine pinned font advances. The
current appearances and every field behavior are unchanged. Actual viewer and
assistive-technology tests remain required.
"""
from __future__ import annotations

import hashlib
import io
import json
import math
from pathlib import Path
import re

from pypdf import PdfReader, PdfWriter
from pypdf.generic import (ArrayObject, ContentStream, DecodedStreamObject,
    DictionaryObject, NameObject, NumberObject, TextStringObject)

from form_font_repairs import FONT_FILE_SHA256, FONT_POSTSCRIPT_NAME, encoding_map
from form_label_repairs import _open, _field_widgets
from form_label_validation import _document_graph
from form_requirement_repairs import _pixels
from form_requirement_validation import compare_with_authorized_form_requirement
from verify_pdf import resolved


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def _da(value):
    if not isinstance(value, TextStringObject) or not 1 <= len(value) <= 256:
        raise ValueError('bounded_local_default_appearance_required')
    text = str(value)
    try: data = text.encode('ascii')
    except UnicodeEncodeError as error: raise ValueError('ascii_default_appearance_required') from error
    stream = DecodedStreamObject(); stream.set_data(data)
    operations = ContentStream(stream, None).operations
    if len(operations) > 4: raise ValueError('simple_default_appearance_required')
    selected = 0
    for args, op in operations:
        if op == b'Tf':
            if len(args) != 2 or args[0] != '/Helv': raise ValueError('single_known_default_font_required')
            values = args[1:]; selected += 1
            if not isinstance(args[1], (int, float)) or not 0 <= float(args[1]) <= 72:
                raise ValueError('bounded_default_font_size_required')
        elif op in (b'g', b'rg'):
            if len(args) != {b'g': 1, b'rg': 3}[op]: raise ValueError('simple_default_color_required')
            values = args
        else: raise ValueError('simple_default_appearance_required')
        if any(not isinstance(x, (int, float)) or not math.isfinite(float(x)) for x in values):
            raise ValueError('finite_default_appearance_numbers_required')
    if selected != 1: raise ValueError('single_known_default_font_required')
    pattern = r'(?<!\S)/Helv(?=\s+[+-]?(?:\d+(?:\.\d*)?|\.\d+)\s+Tf(?:\s|$))'
    changed, count = re.subn(pattern, '/UniForm', text)
    if count != 1: raise ValueError('exact_default_font_token_required')
    return changed


def _plan(reader):
    form = reader.root_object['/AcroForm']
    resources = resolved(form.get('/DR')); fonts = resolved(resources.get('/Font')) if isinstance(resources, dict) else None
    if not isinstance(fonts, DictionaryObject) or '/UniForm' in fonts or '/Helv' not in fonts:
        raise ValueError('new_unicode_default_font_resource_required')
    records = [{'target': 'document', 'fieldPath': [], 'beforeValue': str(form.get('/DA', '')),
        'afterValue': _da(form.get('/DA'))}]
    for field in _field_widgets(reader):
        if field['type'] == '/Btn': continue
        if (field['type'] not in ('/Tx', '/Ch') or len(field['widgets']) != 1
                or field['flags'] & (4096 | 8192 | 262144 | 2097152 | 4194304 | 16777216 | 33554432)
                or (field['type'] == '/Ch' and not field['flags'] & 131072)
                or '/DA' not in field['node'] or '/DR' in field['node']):
            raise ValueError('simple_local_editable_field_required')
        value = field['node']['/DA']
        records.append({'target': 'field', 'fieldPath': field['fieldPath'],
            'beforeValue': str(value), 'afterValue': _da(value)})
    if not 2 <= len(records) <= 9: raise ValueError('bounded_editable_fields_required')
    return records


def _composite_font(writer, original_font, embedded_font):
    from fontTools.ttLib import TTFont
    entries, _ = encoding_map(original_font)
    points = [entry['unicode'] for entry in entries]
    if len(set(points)) != len(points): raise ValueError('unambiguous_original_unicode_repertoire_required')
    descriptor = resolved(embedded_font.get('/FontDescriptor'))
    program_stream = resolved(descriptor.get('/FontFile2')) if isinstance(descriptor, dict) else None
    if (embedded_font.get('/Subtype') != '/TrueType' or embedded_font.get('/BaseFont') != '/' + FONT_POSTSCRIPT_NAME
            or program_stream is None or hashlib.sha256(program_stream.get_data()).hexdigest() != FONT_FILE_SHA256):
        raise ValueError('verified_existing_full_font_required')
    parsed = TTFont(io.BytesIO(program_stream.get_data()), lazy=False)
    try:
        if parsed['OS/2'].fsType != 0: raise ValueError('editable_embedding_permission_required')
        cmap = parsed.getBestCmap(); units = parsed['head'].unitsPerEm
        mappings = []; used_gids = set()
        for point in sorted(points):
            glyph = cmap.get(point)
            if glyph is None or glyph == '.notdef': raise ValueError('original_character_not_covered')
            gid = parsed.getGlyphID(glyph)
            if not 0 < gid <= 65535: raise ValueError('bounded_glyph_index_required')
            if gid in used_gids: raise ValueError('unambiguous_original_glyph_ids_required')
            used_gids.add(gid)
            width = int(math.floor(parsed['hmtx'].metrics[glyph][0] * 1000 / units + .5))
            mappings.append((gid, point, width))
    finally: parsed.close()
    mappings.sort()
    widths = []
    for gid, _, width in mappings:
        widths.extend([NumberObject(gid), ArrayObject([NumberObject(width)])])
    descendant = DictionaryObject({NameObject('/Type'): NameObject('/Font'), NameObject('/Subtype'): NameObject('/CIDFontType2'),
        NameObject('/BaseFont'): NameObject('/' + FONT_POSTSCRIPT_NAME),
        NameObject('/CIDSystemInfo'): DictionaryObject({NameObject('/Registry'): TextStringObject('Adobe'),
            NameObject('/Ordering'): TextStringObject('Identity'), NameObject('/Supplement'): NumberObject(0)}),
        NameObject('/FontDescriptor'): embedded_font.raw_get('/FontDescriptor'),
        NameObject('/CIDToGIDMap'): NameObject('/Identity'), NameObject('/DW'): NumberObject(0), NameObject('/W'): ArrayObject(widths)})
    lines = ['/CIDInit /ProcSet findresource begin', '12 dict begin', 'begincmap',
        '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def',
        '/CMapName /ACCCPFormUnicodeDefault def', '/CMapType 2 def', '1 begincodespacerange', '<0000> <FFFF>', 'endcodespacerange']
    for start in range(0, len(mappings), 100):
        group = mappings[start:start + 100]
        lines.append(f'{len(group)} beginbfchar'); lines.extend(f'<{gid:04X}> <{point:04X}>' for gid, point, _ in group); lines.append('endbfchar')
    lines.extend(['endcmap', 'CMapName currentdict /CMap defineresource pop', 'end', 'end'])
    unicode_stream = DecodedStreamObject(); unicode_stream.set_data(('\n'.join(lines) + '\n').encode('ascii'))
    return DictionaryObject({NameObject('/Type'): NameObject('/Font'), NameObject('/Subtype'): NameObject('/Type0'),
        NameObject('/BaseFont'): NameObject('/' + FONT_POSTSCRIPT_NAME), NameObject('/Encoding'): NameObject('/Identity-H'),
        NameObject('/DescendantFonts'): ArrayObject([writer._add_object(descendant)]),
        NameObject('/ToUnicode'): writer._add_object(unicode_stream)})


def repair_unicode_form_defaults(original, candidate, output, *, requirement_ledger,
        expected_original_sha256, expected_candidate_sha256):
    original, candidate, output, requirement_ledger = map(Path, (original, candidate, output, requirement_ledger))
    if output.exists() or output.resolve() in {p.resolve() for p in (original, candidate, requirement_ledger)}:
        raise ValueError('new_output_required')
    if (sha(original), sha(candidate)) != (expected_original_sha256, expected_candidate_sha256):
        raise ValueError('exact_input_hashes_required')
    source, before = _open(original), _open(candidate)
    if not requirement_ledger.is_file() or requirement_ledger.stat().st_size > 512000:
        raise ValueError('bounded_requirement_ledger_required')
    ledger_hash = sha(requirement_ledger)
    prior = compare_with_authorized_form_requirement(original, candidate, json.loads(requirement_ledger.read_text(encoding='utf-8-sig')))
    if prior.get('passed') is not True: raise ValueError('verified_prior_requirement_repair_required')
    records = _plan(before)
    writer = PdfWriter(clone_from=before); form = writer.root_object['/AcroForm']; fonts = form['/DR']['/Font']
    composite = _composite_font(writer, source.root_object['/AcroForm']['/DR']['/Font']['/Helv'], fonts['/Helv'])
    fonts[NameObject('/UniForm')] = writer._add_object(composite)
    fields = {tuple(field['fieldPath']): field['node'] for field in _field_widgets(writer)}
    for record in records:
        node = form if record['target'] == 'document' else fields[tuple(record['fieldPath'])]
        node[NameObject('/DA')] = TextStringObject(record['afterValue'])
    buffer = io.BytesIO(); writer.write(buffer); data = buffer.getvalue()
    if len(data) > 4 * 1024 * 1024: raise ValueError('candidate_size_limit')
    saved = PdfReader(io.BytesIO(data), strict=True)
    saved_fields = {tuple(field['fieldPath']): field['node'] for field in _field_widgets(saved)}
    for record in records:
        node = saved.root_object['/AcroForm'] if record['target'] == 'document' else saved_fields[tuple(record['fieldPath'])]
        if node['/DA'] != record['afterValue']: raise ValueError('saved_default_appearance_mismatch')
        node[NameObject('/DA')] = TextStringObject(record['beforeValue'])
    del saved.root_object['/AcroForm']['/DR']['/Font']['/UniForm']
    if _document_graph(before) != _document_graph(saved): raise ValueError('unlisted_default_font_change')
    if _pixels(candidate.read_bytes()) != _pixels(data): raise ValueError('default_font_changed_static_appearance')
    for path, expected in ((original, expected_original_sha256), (candidate, expected_candidate_sha256), (requirement_ledger, ledger_hash)):
        if sha(path) != expected: raise ValueError('default_font_evidence_changed')
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open('xb') as stream: stream.write(data)
    return {'schemaVersion': 1, 'operation': 'native-form-default-font',
        'sourcePath': str(original.resolve()), 'sourceSha256': expected_original_sha256,
        'inputPath': str(candidate.resolve()), 'inputSha256': expected_candidate_sha256,
        'outputSha256': hashlib.sha256(data).hexdigest(), 'requirementLedgerPath': str(requirement_ledger.resolve()),
        'requirementLedgerSha256': ledger_hash, 'fontResourceName': 'UniForm', 'defaultAppearances': records,
        'requiresFreshAudit': True, 'certification': False}
