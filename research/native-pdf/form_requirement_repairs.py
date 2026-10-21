"""Apply one explicit author decision to the synthetic registration checkbox.

The document author has confirmed that receiving workshop materials is optional.
Only that exact terminal field's Required bit may change. Its value, other flags,
appearance, labels and native structure remain intact, with a separately bound
font-repair chain and an independent saved-file validator still required.
"""
from __future__ import annotations

import hashlib
import io
import json
from pathlib import Path

from pypdf import PdfReader, PdfWriter
from pypdf.generic import DictionaryObject, NameObject, NumberObject
import pypdfium2 as pdfium

from form_font_validation import compare_with_authorized_form_fonts
from form_label_repairs import _open, _field_widgets, _forms
from form_label_validation import _document_graph
from verify_pdf import resolved


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def _json(path, limit):
    path = Path(path)
    if not path.is_file() or path.stat().st_size > limit:
        raise ValueError('bounded_author_evidence_required')
    data = path.read_bytes()
    value = json.loads(data.decode('utf-8-sig'))
    if not isinstance(value, dict): raise ValueError('author_evidence_object_required')
    return value, hashlib.sha256(data).hexdigest()


def _target(reader):
    matches = [field for field in _field_widgets(reader) if field['fieldPath'] == ['materials']]
    if len(matches) != 1: raise ValueError('unique_materials_checkbox_required')
    field = matches[0]; node = field['node']
    if (field['type'] != '/Btn' or field['flags'] & (32768 | 65536)
            or field['tooltip'] != 'Send workshop materials' or len(field['widgets']) != 1
            or '/Ff' not in node or not isinstance(node['/Ff'], NumberObject)
            or int(node['/Ff']) != field['flags'] or not 0 <= field['flags'] <= 0xFFFFFFFF
            or '/Opt' in node):
        raise ValueError('local_ordinary_materials_checkbox_required')
    owned = field['widgets'][0]; widget = owned['node']; key = (owned['ref']['pageNumber'], owned['ref']['annotationIndex'])
    states = resolved(resolved(widget.get('/AP', {})).get('/N'))
    if (not isinstance(states, DictionaryObject) or '/Off' not in states or len(states) != 2
            or field['value'] not in states or widget.get('/AS') != field['value']):
        raise ValueError('ordinary_checkbox_appearance_states_required')
    _, owners = _forms(reader, required=True)
    owner = owners.get(key)
    if (owner is None or owner['widgets'] != [owned['ref']] or owner['alt'] != field['tooltip']
            or widget.get('/Contents') != field['tooltip']):
        raise ValueError('exact_authored_checkbox_label_and_owner_required')
    return field, owned['ref'], owner['tagId']


def _pixels(data):
    """Render initialized form controls while keeping all test bytes in memory."""
    result = []
    with pdfium.PdfDocument(data) as document:
        document.init_forms()
        for page in document:
            try:
                width, height = page.get_size()
                if width <= 0 or height <= 0 or width * height * 2.25 > 40_000_000:
                    raise ValueError('form_render_size_limit')
                bitmap = page.render(scale=1.5, draw_annots=True, may_draw_forms=True)
                try:
                    pixels = bitmap.to_pil()
                    result.append((pixels.size, hashlib.sha256(pixels.tobytes()).hexdigest()))
                finally: bitmap.close()
            finally: page.close()
    return result


def repair_optional_materials(original, candidate, output, *, font_ledger, author_decision,
        expected_original_sha256, expected_candidate_sha256):
    original, candidate, output, font_ledger, author_decision = map(Path,
        (original, candidate, output, font_ledger, author_decision))
    if output.exists() or output.resolve() in {p.resolve() for p in (original, candidate, font_ledger, author_decision)}:
        raise ValueError('new_output_required')
    if (sha(original), sha(candidate)) != (expected_original_sha256, expected_candidate_sha256):
        raise ValueError('exact_input_hashes_required')
    _open(original); reader = _open(candidate)
    decision, decision_hash = _json(author_decision, 16_000)
    expected_decision = {'schemaVersion': 1, 'candidateSha256': expected_candidate_sha256,
        'fieldPath': ['materials'], 'tooltip': 'Send workshop materials', 'clearRequired': True}
    if decision != expected_decision or type(decision.get('schemaVersion')) is not int or decision.get('clearRequired') is not True:
        raise ValueError('exact_explicit_author_decision_required')
    prior_ledger, ledger_hash = _json(font_ledger, 512_000)
    prior = compare_with_authorized_form_fonts(original, candidate, prior_ledger)
    if prior.get('passed') is not True:
        raise ValueError('verified_prior_form_fonts_required')
    field, widget_ref, tag_id = _target(reader)
    before_flags = field['flags']
    if not before_flags & 2: raise ValueError('checkbox_already_optional')
    after_flags = before_flags & ~2
    writer = PdfWriter(clone_from=reader)
    targets = [value for value in _field_widgets(writer) if value['fieldPath'] == ['materials']]
    if len(targets) != 1: raise ValueError('cloned_checkbox_identity_changed')
    target = targets[0]
    if (target['flags'] != before_flags or [w['ref'] for w in target['widgets']] != [widget_ref]):
        raise ValueError('cloned_checkbox_identity_changed')
    target['node'][NameObject('/Ff')] = NumberObject(after_flags)
    buffer = io.BytesIO(); writer.write(buffer); output_data = buffer.getvalue()
    if len(output_data) > 4 * 1024 * 1024: raise ValueError('candidate_size_limit')
    saved = PdfReader(io.BytesIO(output_data), strict=True)
    actual, actual_ref, actual_tag = _target(saved)
    if (actual['flags'], actual_ref, actual_tag) != (after_flags, widget_ref, tag_id):
        raise ValueError('saved_checkbox_identity_changed')
    actual['node'][NameObject('/Ff')] = NumberObject(before_flags)
    if _document_graph(reader) != _document_graph(saved):
        raise ValueError('unlisted_checkbox_requirement_change')
    if _pixels(candidate.read_bytes()) != _pixels(output_data):
        raise ValueError('checkbox_requirement_changed_appearance')
    for path, expected in ((original, expected_original_sha256), (candidate, expected_candidate_sha256),
            (font_ledger, ledger_hash), (author_decision, decision_hash)):
        if sha(path) != expected: raise ValueError('requirement_evidence_changed')
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open('xb') as stream: stream.write(output_data)
    return {'schemaVersion': 1, 'operation': 'native-form-requirement',
        'sourcePath': str(original.resolve()), 'sourceSha256': expected_original_sha256,
        'inputPath': str(candidate.resolve()), 'inputSha256': expected_candidate_sha256,
        'outputSha256': hashlib.sha256(output_data).hexdigest(),
        'fontLedgerPath': str(font_ledger.resolve()), 'fontLedgerSha256': ledger_hash,
        'authorDecisionPath': str(author_decision.resolve()), 'authorDecisionSha256': decision_hash,
        'fieldPath': ['materials'], 'widgetRef': widget_ref, 'tagId': tag_id,
        'beforeFlags': before_flags, 'afterFlags': after_flags,
        'requiresFreshAudit': True, 'certification': False}
