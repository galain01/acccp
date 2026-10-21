"""Independently verify a Unicode editing font while retaining saved appearances.

This proof checks the exact PDF change and its complete source character mapping.
Actual interactive viewer behavior is separate evidence, not inferred from a
static appearance render or from a successful standards check.
"""
from __future__ import annotations

import copy
import io
import re
from pathlib import Path

from pypdf.generic import ContentStream, DecodedStreamObject, NameObject, StreamObject, TextStringObject

import verify_pdf as v
import form_label_validation as labels
from form_font_validation import FONT_SHA256, FONT_NAME, original_encoding
from form_requirement_validation import compare_with_authorized_form_requirement, read_bound_json

require = labels.require
LEDGER_KEYS = {'schemaVersion', 'operation', 'sourcePath', 'sourceSha256', 'inputPath', 'inputSha256',
               'outputSha256', 'requirementLedgerPath', 'requirementLedgerSha256', 'fontResourceName',
               'defaultAppearances', 'requiresFreshAudit', 'certification'}
DA_KEYS = {'target', 'fieldPath', 'beforeValue', 'afterValue'}


def _unicode_map(stream):
    require(isinstance(stream, StreamObject) and set(stream) <= {'/Length', '/Filter', '/DecodeParms'},
            'form_default_unicode_stream_unsupported')
    data = stream.get_data()
    require(len(data) <= 32768, 'form_default_unicode_limit')
    text = data.decode('ascii', 'strict')
    blocks = re.findall(r'([0-9]+)\s+beginbfchar\s*(.*?)\s*endbfchar', text, re.S)
    require(1 <= len(blocks) <= 4, 'form_default_unicode_blocks_invalid')
    mapping = {}
    for count, body in blocks:
        pairs = re.findall(r'<([0-9A-Fa-f]{4})>\s*<([0-9A-Fa-f]{4})>', body)
        require(1 <= int(count) <= 100 and len(pairs) == int(count)
                and not re.sub(r'<[0-9A-Fa-f]{4}>\s*<[0-9A-Fa-f]{4}>', '', body).strip(),
                'form_default_unicode_pairs_invalid')
        for code, unicode in pairs:
            code = int(code, 16)
            require(code not in mapping, 'form_default_unicode_duplicate_code')
            mapping[code] = int(unicode, 16)
    stripped = re.sub(r'[0-9]+\s+beginbfchar\s*.*?\s*endbfchar', '', text, flags=re.S)
    grammar = (r'/CIDInit\s+/ProcSet\s+findresource\s+begin\s+12\s+dict\s+begin\s+begincmap\s+'
               r'/CIDSystemInfo\s*<<\s*/Registry\s*\(Adobe\)\s*/Ordering\s*\(UCS\)\s*/Supplement\s+0\s*>>\s*def\s+'
               r'/CMapName\s+/[A-Za-z0-9_-]{1,64}\s+def\s+/CMapType\s+2\s+def\s+'
               r'1\s+begincodespacerange\s*<0000>\s*<FFFF>\s*endcodespacerange\s*'
               r'endcmap\s+CMapName\s+currentdict\s+/CMap\s+defineresource\s+pop\s+end\s+end\s*')
    require(re.fullmatch(grammar, stripped), 'form_default_unicode_program_unsupported')
    return mapping


def _widths(value):
    values = v.resolved(value)
    require(isinstance(values, list) and len(values) <= 768, 'form_default_widths_invalid')
    result = {}; index = 0
    while index < len(values):
        require(index + 1 < len(values), 'form_default_widths_invalid')
        start = v.integer(values[index]); entries = v.resolved(values[index + 1])
        require(start is not None and 0 <= start <= 65535 and isinstance(entries, list)
                and 1 <= len(entries) <= 256, 'form_default_widths_invalid')
        for offset, width in enumerate(entries):
            code = start + offset; width = v.integer(width)
            require(code <= 65535 and code not in result and width is not None and 0 <= width <= 2000,
                    'form_default_width_duplicate_or_invalid')
            result[code] = width
        index += 2
    return result


def _check_font(source_font, verified_prior_font, final_font):
    from fontTools.ttLib import TTFont
    require(isinstance(final_font, dict) and set(final_font) == {
        '/Type', '/Subtype', '/BaseFont', '/Encoding', '/DescendantFonts', '/ToUnicode'}
        and final_font.get('/Type') == '/Font' and final_font.get('/Subtype') == '/Type0'
        and final_font.get('/BaseFont') == '/' + FONT_NAME and final_font.get('/Encoding') == '/Identity-H',
        'form_default_type0_font_invalid')
    descendants = v.resolved(final_font.get('/DescendantFonts'))
    require(isinstance(descendants, list) and len(descendants) == 1, 'form_default_descendant_invalid')
    cid = v.resolved(descendants[0])
    require(isinstance(cid, dict) and set(cid) == {'/Type', '/Subtype', '/BaseFont', '/CIDSystemInfo',
        '/FontDescriptor', '/CIDToGIDMap', '/DW', '/W'} and cid.get('/Type') == '/Font'
        and cid.get('/Subtype') == '/CIDFontType2' and cid.get('/BaseFont') == '/' + FONT_NAME
        and v.integer(cid.get('/DW')) == 0, 'form_default_cid_font_invalid')
    system = v.resolved(cid.get('/CIDSystemInfo'))
    require(isinstance(system, dict) and set(system) == {'/Registry', '/Ordering', '/Supplement'}
            and system.get('/Registry') == 'Adobe' and system.get('/Ordering') == 'Identity'
            and v.integer(system.get('/Supplement')) == 0, 'form_default_cid_system_invalid')
    descriptor = v.resolved(cid.get('/FontDescriptor'))
    require(labels.ExactGraph([]).hash(descriptor) == labels.ExactGraph([]).hash(verified_prior_font['/FontDescriptor']),
            'form_default_descriptor_or_program_changed')
    program = descriptor['/FontFile2'].get_data()
    require(v.digest(program) == FONT_SHA256, 'form_default_program_not_approved')
    rows, _ = original_encoding(source_font)
    codes = {row['unicode'] for row in rows}
    require(len(codes) == len(rows) and codes and max(codes) <= 65535,
            'form_default_source_unicode_ambiguous')
    require(cid.get('/CIDToGIDMap') == '/Identity' and isinstance(cid.get('/CIDToGIDMap'), NameObject),
            'form_default_identity_gid_map_required')
    widths = _widths(cid.get('/W')); expected_mapping = {}; expected_widths = {}
    font = TTFont(io.BytesIO(program), lazy=False)
    try:
        cmap = font.getBestCmap(); units = int(font['head'].unitsPerEm)
        for code in sorted(codes):
            glyph = cmap.get(code)
            require(glyph and glyph != '.notdef', 'form_default_source_glyph_missing')
            gid = font.getGlyphID(glyph)
            require(0 < gid <= 65535 and gid not in expected_mapping, 'form_default_source_glyph_ambiguous')
            expected_mapping[gid] = code
            expected_widths[gid] = round(font['hmtx'].metrics[glyph][0] * 1000 / units)
    finally:
        font.close()
    require(widths == expected_widths, 'form_default_width_mapping_changed')
    require(_unicode_map(v.resolved(final_font.get('/ToUnicode'))) == expected_mapping,
            'form_default_unicode_mapping_changed')
    return {'sourceCharactersCovered': len(codes), 'unicodeCharacters': sorted(codes),
            'embeddedProgramSha256': FONT_SHA256, 'allSourceGlyphsAndGenuineWidthsVerified': True,
            'glyphIdsAreCharacterIds': True, 'charactersOutsideOriginalRepertoireNotClaimed': True}


def _da_change(value):
    require(isinstance(value, TextStringObject) and len(value) <= 256, 'form_default_da_unsupported')
    stream = DecodedStreamObject(); stream.set_data(str(value).encode('ascii', 'strict'))
    operations = ContentStream(stream, None).operations
    require(len(operations) <= 4 and all(op in (b'Tf', b'g', b'rg') for _, op in operations),
            'form_default_da_unsupported')
    fonts = [args for args, op in operations if op == b'Tf']
    require(len(fonts) == 1 and len(fonts[0]) == 2 and fonts[0][0] == '/Helv'
            and 0 <= float(fonts[0][1]) <= 72, 'form_default_da_font_unsupported')
    changed, count = re.subn(r'/Helv(?=\s)', '/UniForm', str(value))
    require(count == 1, 'form_default_da_selection_ambiguous')
    return changed


def _appearance_slots(reader):
    form = reader.root_object['/AcroForm']
    slots = [('document', [], form)]
    seen = set()
    for field, _ in labels._owners(reader).values():
        path = tuple(field['path'])
        if path in seen: continue
        seen.add(path)
        if field['type'] not in ('/Tx', '/Ch'): continue
        require(len(field['widgets']) == 1 and '/DA' in field['node'] and '/DR' not in field['node']
                and not (field['flags'] & (4096 | 8192 | 262144 | 2097152 | 4194304 | 16777216 | 33554432))
                and (field['type'] != '/Ch' or field['flags'] & 131072),
                'form_default_field_type_unsupported')
        slots.append(('field', list(path), field['node']))
    require(1 < len(slots) <= 9, 'form_default_field_count_unsupported')
    return slots


def authorize_form_default_font(original, final, ledger):
    require(isinstance(ledger, dict) and set(ledger) == LEDGER_KEYS
            and type(ledger.get('schemaVersion')) is int and ledger['schemaVersion'] == 1
            and ledger.get('operation') == 'native-form-default-font' and ledger.get('fontResourceName') == 'UniForm'
            and ledger.get('requiresFreshAudit') is True and ledger.get('certification') is False,
            'form_default_ledger_invalid')
    original, final, input_path = Path(original), Path(final), Path(ledger['inputPath'])
    source, sh = labels._snapshot(original); before, bh = labels._snapshot(input_path); after, ah = labels._snapshot(final)
    require(original.resolve() == Path(ledger['sourcePath']).resolve()
            and final.resolve() not in (original.resolve(), input_path.resolve())
            and (sh, bh, ah) == (ledger['sourceSha256'], ledger['inputSha256'], ledger['outputSha256']),
            'form_default_file_binding_mismatch')
    prior_ledger = read_bound_json(ledger['requirementLedgerPath'], ledger['requirementLedgerSha256'])
    prior = compare_with_authorized_form_requirement(original, input_path, prior_ledger)
    require(prior.get('passed') is True and prior.get('form_requirement_validation', {}).get('checksComplete') is True,
            'form_default_prior_chain_unverified')
    old_fonts = before.root_object['/AcroForm']['/DR']['/Font']
    new_fonts = after.root_object['/AcroForm']['/DR']['/Font']
    require('/UniForm' not in old_fonts and '/UniForm' in new_fonts and set(new_fonts) == set(old_fonts) | {'/UniForm'},
            'form_default_added_resource_invalid')
    font_proof = _check_font(source.root_object['/AcroForm']['/DR']['/Font']['/Helv'],
                             old_fonts['/Helv'], new_fonts['/UniForm'])
    old_slots = _appearance_slots(before); new_slots = _appearance_slots(after)
    require([(kind, path) for kind, path, _ in old_slots] == [(kind, path) for kind, path, _ in new_slots],
            'form_default_field_owners_changed')
    expected = []
    for (kind, path, old), (_, _, new) in zip(old_slots, new_slots):
        require('/DA' in old and '/DA' in new, 'form_default_local_da_required')
        replacement = _da_change(old['/DA'])
        require(isinstance(new['/DA'], TextStringObject) and str(new['/DA']) == replacement,
                'form_default_da_unlisted_change')
        expected.append({'target': kind, 'fieldPath': path, 'beforeValue': str(old['/DA']), 'afterValue': replacement})
        new[NameObject('/DA')] = old.raw_get('/DA')
    require(isinstance(ledger['defaultAppearances'], list)
            and all(isinstance(x, dict) and set(x) == DA_KEYS for x in ledger['defaultAppearances'])
            and ledger['defaultAppearances'] == expected, 'form_default_da_evidence_mismatch')
    del new_fonts['/UniForm']
    require(labels._document_graph(before) == labels._document_graph(after), 'form_default_unlisted_native_change')
    pixels = [labels.initialized_form_pixels(path) for path in (input_path, final)]
    require(pixels[0] == pixels[1], 'form_default_static_appearance_pixels_changed')
    saved, _ = labels._snapshot(final)
    saved_evidence = labels._saved_widget_evidence(labels._owners(saved), labels._native_forms(saved, required=True))
    for path, digest in ((original, sh), (input_path, bh), (final, ah),
                         (Path(ledger['requirementLedgerPath']), ledger['requirementLedgerSha256'])):
        require(v.digest(path.read_bytes()) == digest, 'form_default_evidence_changed_during_check')
    return {'passed': True, 'checksComplete': True, 'sourceSha256': sh, 'inputSha256': bh, 'outputSha256': ah,
            'priorRequirementLedgerSha256': ledger['requirementLedgerSha256'], 'fontResourceName': 'UniForm',
            'defaultAppearances': expected, 'fontMapping': font_proof, 'widgetEvidence': saved_evidence,
            'originalAppearanceStreamsAndAllOtherObjectsUnchanged': True, 'initializedStaticPixelsIdentical': True,
            'interactiveViewerBehaviorVerifiedByThisCheck': False,
            'interactiveViewerReviewRequired': True, 'requiresFreshAudit': True, 'certification': False}, prior


def compare_with_authorized_form_default_font(original, final, ledger):
    report = v.compare_pdfs(Path(original), Path(final))
    evidence = {'passed': False, 'checksComplete': False, 'findings': [], 'certification': False}
    report['form_default_font_validation'] = evidence
    try:
        require(not report.get('inspection_incomplete'), 'form_default_strict_inspection_incomplete')
        checked, prior = authorize_form_default_font(original, final, ledger); evidence.update(checked)
        previous = prior['form_requirement_validation']['strictFindingsExplainedByVerifiedChain']
        explained = [finding for finding in report['findings'] if finding in previous or finding['code'] in {
            'form_fields_changed', 'catalog_behavior_changed', 'page_properties_changed'}]
        report['findings'] = [finding for finding in report['findings'] if finding not in explained]
        evidence['strictFindingsExplainedByVerifiedChain'] = explained
        for name in ('form_label_validation', 'form_order_validation', 'form_font_validation', 'form_requirement_validation'):
            report[name] = copy.deepcopy(prior[name])
            report[name]['validatedIntermediateOutputSha256'] = checked['inputSha256']
            report[name]['widgetEvidence'] = checked['widgetEvidence']
            report[name]['widgetEvidenceAppliesToOutputSha256'] = checked['outputSha256']
        report['structure']['authored_alternative_associations_verified'] = prior['structure']['authored_alternative_associations_verified']
        report['preservation'].update(authorized_form_labels_verified=True, authorized_form_reading_order_verified=True,
            authorized_form_fonts_verified=True, authorized_form_requirement_verified=True,
            authorized_form_default_font_verified=True, passed=not report['findings'])
        report['mechanical_checks_passed'] = report['preservation']['passed'] and report['structure'].get('passed', False)
        report['passed'] = (report['mechanical_checks_passed'] and report['structure'].get('checks_complete', False)
                           and not report['structure'].get('findings') and report['structure']['authored_alternative_associations_verified'])
    except Exception as error:
        evidence.update(passed=False, checksComplete=False)
        evidence['findings'].append({'severity': 'error', 'code': str(error) if isinstance(error, v.InspectionError)
                                    else 'form_default_validation_failed'})
        report['passed'] = report['mechanical_checks_passed'] = report['preservation']['passed'] = False
    return report
