"""Verify an audited, geometry-grounded permutation of form-label siblings.

This authorizes no text, widget, or layout changes. The prior label ledger stays
bound to its original output; a separate chain proves the new ordering only.
"""
from __future__ import annotations

import copy
import json
import math
from pathlib import Path

from pypdf.generic import ArrayObject, NameObject
import pypdfium2 as pdfium
import pypdfium2.raw as raw

import verify_pdf as v
import form_label_validation as labels

KEYS = {'schemaVersion', 'operation', 'sourcePath', 'sourceSha256', 'inputPath', 'inputSha256',
        'outputSha256', 'labelLedgerPath', 'labelLedgerSha256', 'auditPath', 'auditSha256',
        'parentTagId', 'beforeOrder', 'afterOrder', 'pairs', 'requiresRevalidation', 'certification'}
PAIR_KEYS = {'labelTagId', 'formTagId', 'fieldPath', 'widgetRef', 'labelText', 'labelRect', 'widgetRect', 'position'}
require = labels.require


def _json(path, expected, limit=512_000):
    require(isinstance(path, str) and Path(path).is_absolute(), 'form_order_path_invalid')
    path = Path(path)
    require(path.is_file() and path.stat().st_size <= limit, 'form_order_evidence_limit')
    data = path.read_bytes()
    require(len(data) <= limit and v.digest(data) == expected, 'form_order_evidence_hash_mismatch')
    value = json.loads(data)
    require(isinstance(value, dict), 'form_order_evidence_invalid')
    return value


def _nodes(reader):
    found, seen = [], set()
    def walk(item, depth=0):
        item = v.resolved(item)
        require(depth <= 32, 'form_order_structure_depth')
        if isinstance(item, list):
            for child in item: walk(child, depth + 1)
        elif isinstance(item, dict) and item.get('/Type') not in ('/MCR', '/OBJR'):
            require('/S' in item and id(item) not in seen and len(found) < 2000, 'form_order_structure_invalid')
            seen.add(id(item)); found.append(item)
            if '/K' in item: walk(item['/K'], depth + 1)
    walk(v.resolved(reader.root_object['/StructTreeRoot']).get('/K', []))
    inventory = v.structure_inventory(reader)
    require(len(found) == len(inventory['tags']) and all(str(n['/S']).lstrip('/') == t['sourceRole']
            for n, t in zip(found, inventory['tags'])), 'form_order_inventory_mismatch')
    return {t['id']: n for n, t in zip(found, inventory['tags'])}, {t['id']: t for t in inventory['tags']}


def _rect(value):
    require(isinstance(value, (list, tuple)) and len(value) == 4
            and all(isinstance(n, (int, float)) and not isinstance(n, bool) and math.isfinite(float(n)) for n in value),
            'form_order_rectangle_invalid')
    result = tuple(float(n) for n in value)
    require(result[2] > result[0] and result[3] > result[1], 'form_order_rectangle_invalid')
    return result


def _near(left, right):
    return max(abs(a-b) for a, b in zip(_rect(left), _rect(right))) <= 0.02


def _visible_label_rect(source, page_number, text):
    require(isinstance(text, str) and 0 < len(text) <= 500 and text == text.strip()
            and '\n' not in text and '\r' not in text, 'form_order_label_text_invalid')
    document = pdfium.PdfDocument(str(source))
    try:
        page = document[page_number - 1]
        try:
            require(page.get_rotation() == 0, 'form_order_rotated_page_unsupported')
            textpage = page.get_textpage()
            try:
                count = textpage.count_chars()
                require(count <= 100000, 'form_order_text_limit')
                characters = ''.join(chr(raw.FPDFText_GetUnicode(textpage, i)) for i in range(count))
                require(characters.count(text) == 1, 'form_order_visible_label_not_unique')
                start = characters.index(text)
                boxes = [textpage.get_charbox(i) for i in range(start, start + len(text)) if not characters[i].isspace()]
                require(boxes, 'form_order_visible_label_empty')
                return (min(b[0] for b in boxes), min(b[1] for b in boxes), max(b[2] for b in boxes), max(b[3] for b in boxes))
            finally:
                textpage.close()
        finally:
            page.close()
    finally:
        document.close()


def authorize_form_order(original, final, ledger):
    require(isinstance(ledger, dict) and set(ledger) == KEYS and len(json.dumps(ledger).encode()) <= 128_000
            and type(ledger['schemaVersion']) is int and ledger['schemaVersion'] == 1
            and ledger['operation'] == 'native-form-reading-order' and ledger['requiresRevalidation'] is True
            and ledger['certification'] is False, 'form_order_ledger_invalid')
    require(isinstance(ledger['sourcePath'], str) and Path(ledger['sourcePath']).resolve() == Path(original).resolve()
            and isinstance(ledger['inputPath'], str) and Path(ledger['inputPath']).is_absolute(), 'form_order_pdf_paths_mismatch')
    before_path = Path(ledger['inputPath'])
    require(before_path.resolve() != Path(final).resolve(), 'form_order_input_output_alias')
    source, source_sha = labels._snapshot(original)
    before, input_sha = labels._snapshot(before_path)
    after, output_sha = labels._snapshot(final)
    require((source_sha, input_sha, output_sha) == (ledger['sourceSha256'], ledger['inputSha256'], ledger['outputSha256']),
            'form_order_pdf_hash_mismatch')
    label_ledger = _json(ledger['labelLedgerPath'], ledger['labelLedgerSha256'])
    prior = labels.compare_with_authorized_form_labels(original, before_path, label_ledger)
    require(prior['form_label_validation']['passed'] and prior['preservation']['passed']
            and prior['mechanical_checks_passed'] and not prior['form_label_validation']['reviewItems'],
            'form_order_prior_labels_unverified')
    audit = _json(ledger['auditPath'], ledger['auditSha256'])
    nodes, tags = _nodes(before)
    output_nodes, output_tags = _nodes(after)
    require(audit.get('status') == 'complete' and audit.get('sourceSha256') == source_sha
            and audit.get('outputSha256') == input_sha and audit.get('machineFindingsRetained') is True
            and audit.get('completedBatchCount') == audit.get('plannedBatchCount')
            and type(audit.get('completedBatchCount')) is int and audit['completedBatchCount'] > 0
            and isinstance(audit.get('reviewedTagIds'), list) and set(audit['reviewedTagIds']) == set(tags)
            and len(audit['reviewedTagIds']) == len(tags)
            and audit.get('reviewedPages') == list(range(1, len(before.pages) + 1)), 'form_order_audit_incomplete_or_mismatched')
    parent_id = ledger['parentTagId']
    require(parent_id in nodes and parent_id in output_nodes and tags[parent_id]['role'] == 'Document'
            and output_tags[parent_id]['role'] == 'Document' and len(nodes) == len(output_nodes), 'form_order_document_parent_required')
    parent, output_parent = nodes[parent_id], output_nodes[parent_id]
    children, output_children = v.resolved(parent.get('/K')), v.resolved(output_parent.get('/K'))
    require(isinstance(children, list) and isinstance(output_children, list), 'form_order_sibling_array_required')
    ids = {id(node): tag_id for tag_id, node in nodes.items()}
    before_order = [ids.get(id(v.resolved(child))) for child in children]
    after_order = ledger['afterOrder']
    require(before_order == ledger['beforeOrder'] and None not in before_order and len(set(before_order)) == len(before_order)
            and isinstance(after_order, list) and len(after_order) == len(before_order) == len(output_children)
            and set(after_order) == set(before_order), 'form_order_exact_permutation_required')
    pairs = ledger['pairs']
    require(isinstance(pairs, list) and 1 <= len(pairs) <= 100, 'form_order_pair_limit')
    source_fields = labels._owners(source)
    before_fields = labels._owners(before)
    before_forms, before_owners, _ = labels._native_forms(before, required=True)
    output_fields = labels._owners(after)
    output_forms = labels._native_forms(after, required=True)
    saved_evidence = labels._saved_widget_evidence(output_fields, output_forms)
    referenced, row_bands = set(), []
    for pair in pairs:
        require(isinstance(pair, dict) and set(pair) == PAIR_KEYS, 'form_order_pair_invalid')
        label_id, form_id = pair['labelTagId'], pair['formTagId']
        require(label_id in before_order and form_id in before_order and label_id != form_id
                and not ({label_id, form_id} & referenced), 'form_order_pair_overlap_or_missing')
        referenced.update((label_id, form_id))
        label = tags[label_id]; control = tags[form_id]
        require(label['role'] == 'P' and control['role'] == 'Form' and not label.get('textIncomplete')
                and label.get('text', '').strip() == pair['labelText']
                and not any(key in nodes[label_id] for key in ('/ActualText', '/Alt'))
                and all(ref['kind'] == 'markedContent' and ref.get('resolved') is True for ref in label['contentSequence']),
                'form_order_simple_native_label_required')
        keys = labels._refs([pair['widgetRef']]); key = keys[0]
        require(key in source_fields and before_owners.get(key) == form_id
                and before_forms[form_id]['keys'] == [key], 'form_order_single_widget_owner_required')
        field, widget = source_fields[key]
        require(list(field['path']) == pair['fieldPath'] and before_fields[key][0]['path'] == field['path']
                and label['pageNumber'] == control['pageNumber'] == key[0]
                and all(ref.get('pageNumber') == key[0] for ref in label['contentSequence']), 'form_order_pair_page_or_field_mismatch')
        label_box = _visible_label_rect(original, key[0], pair['labelText'])
        widget_box = _rect(v.resolved(widget['/Rect']))
        require(_near(pair['labelRect'], label_box) and _near(pair['widgetRect'], widget_box), 'form_order_geometry_evidence_mismatch')
        require(min(label_box[3], widget_box[3]) > max(label_box[1], widget_box[1]), 'form_order_label_row_ambiguous')
        if field['type'] in ('/Tx', '/Ch'):
            require(-.02 <= widget_box[0] - label_box[2] <= 180 and pair['position'] == 'labelThenControl', 'form_order_left_label_required')
            adjacent = [label_id, form_id]
        else:
            require(field['type'] == '/Btn' and not (field['flags'] & (32768 | 65536))
                    and len(field['widgets']) == 1 and -.02 <= label_box[0] - widget_box[2] <= 180
                    and pair['position'] == 'controlThenLabel', 'form_order_right_checkbox_label_required')
            adjacent = [form_id, label_id]
        index = after_order.index(adjacent[0])
        require(after_order[index:index+2] == adjacent, 'form_order_pair_not_adjacent')
        row_bands.append((key[0], min(label_box[1], widget_box[1]), max(label_box[3], widget_box[3])))
        require(any(finding.get('code') == 'reading-order' and finding.get('pageNumber') == key[0]
                    and {label_id, form_id}.issubset(set(finding.get('tagIds', [])))
                    for finding in audit.get('findings', [])), 'form_order_pair_not_in_audit_finding')
    for index, (page, bottom, top) in enumerate(row_bands):
        require(all(page != other_page or min(top, other_top) <= max(bottom, other_bottom)
                    for other_page, other_bottom, other_top in row_bands[index+1:]), 'form_order_rows_overlap')
    pair_pages = {p['widgetRef']['pageNumber'] for p in pairs}
    pair_widgets = {(p['widgetRef']['pageNumber'], p['widgetRef']['annotationIndex']) for p in pairs}
    require(len(pair_pages) == 1 and pair_widgets == {key for key in source_fields if key[0] in pair_pages},
            'form_order_complete_page_widget_pairs_required')
    moved_indexes = sorted(before_order.index(tag_id) for tag_id in referenced)
    require(moved_indexes == list(range(moved_indexes[0], moved_indexes[-1] + 1))
            and before_order[:moved_indexes[0]] == after_order[:moved_indexes[0]]
            and before_order[moved_indexes[-1]+1:] == after_order[moved_indexes[-1]+1:],
            'form_order_unrelated_sibling_position_changed')
    # Only paired members move; all other siblings retain their original order.
    require([item for item in before_order if item not in referenced] ==
            [item for item in after_order if item not in referenced], 'form_order_unrelated_siblings_reordered')
    # Rows themselves retain top-to-bottom page order, grounded by their source geometry.
    paired_sequence = [item for item in after_order if item in {p['formTagId'] for p in pairs}]
    expected_rows = [pair['formTagId'] for _, pair in sorted(zip(row_bands, pairs), key=lambda item: (item[0][0], -item[0][2]))]
    require(paired_sequence == expected_rows, 'form_order_visual_row_sequence_changed')
    by_form = {pair['formTagId']: pair for pair in pairs}
    ordered_block = []
    for form_id in expected_rows:
        pair = by_form[form_id]
        ordered_block.extend([pair['labelTagId'], form_id] if pair['position'] == 'labelThenControl'
                             else [form_id, pair['labelTagId']])
    require(after_order == before_order[:moved_indexes[0]] + ordered_block + before_order[moved_indexes[-1]+1:],
            'form_order_exact_grounded_order_required')
    output_by_original_id = dict(zip(after_order, output_children))
    output_parent[NameObject('/K')] = ArrayObject([output_by_original_id[tag_id] for tag_id in before_order])
    require(labels._document_graph(before) == labels._document_graph(after), 'form_order_unlisted_native_change')
    require(labels.initialized_form_pixels(before_path) == labels.initialized_form_pixels(final), 'form_order_widget_pixels_changed')
    for path, expected in ((original, source_sha), (before_path, input_sha), (final, output_sha),
                           (ledger['labelLedgerPath'], ledger['labelLedgerSha256']), (ledger['auditPath'], ledger['auditSha256'])):
        require(v.digest(Path(path).read_bytes()) == expected, 'form_order_input_changed_during_check')
    return {'passed': True, 'checksComplete': True, 'sourceSha256': source_sha, 'inputSha256': input_sha,
            'outputSha256': output_sha, 'pairCount': len(pairs), 'exactSiblingPermutationVerified': True,
            'visibleLabelWidgetGeometryVerified': True, 'allOtherNativeObjectsUnchanged': True,
            'widgetInclusivePixelsIdentical': True, 'widgetEvidence': saved_evidence,
            'labelLedgerSha256': ledger['labelLedgerSha256'], 'auditSha256': ledger['auditSha256'],
            'requiresFreshAudit': True, 'certification': False}, prior


def compare_with_authorized_form_order(original, final, ledger):
    report = v.compare_pdfs(Path(original), Path(final))
    evidence = {'passed': False, 'checksComplete': False, 'findings': [], 'certification': False}
    report['form_order_validation'] = evidence
    try:
        require(not report.get('inspection_incomplete'), 'form_order_strict_inspection_incomplete')
        checked, prior = authorize_form_order(original, final, ledger)
        evidence.update(checked)
        explained = prior['form_label_validation']['strictFindingsExplainedByAuthoredLabels']
        report['findings'] = [finding for finding in report['findings'] if finding not in explained]
        report['form_label_validation'] = copy.deepcopy(prior['form_label_validation'])
        report['form_label_validation']['widgetEvidence'] = checked['widgetEvidence']
        report['form_label_validation']['evidenceAppliesToOutputSha256'] = checked['outputSha256']
        report['form_label_validation']['validatedIntermediateOutputSha256'] = checked['inputSha256']
        report['structure']['authored_alternative_associations_verified'] = prior['structure']['authored_alternative_associations_verified']
        report['preservation']['authorized_form_labels_verified'] = True
        report['preservation']['authorized_form_reading_order_verified'] = True
        report['preservation']['passed'] = not report['findings']
        report['mechanical_checks_passed'] = report['preservation']['passed'] and report['structure'].get('passed', False)
        report['passed'] = (report['mechanical_checks_passed'] and report['structure'].get('checks_complete', False)
                            and not report['structure'].get('findings')
                            and report['structure']['authored_alternative_associations_verified'])
    except Exception as error:
        evidence.update({'passed': False, 'checksComplete': False})
        evidence['findings'].append({'severity': 'error', 'code': str(error) if isinstance(error, v.InspectionError) else 'form_order_validation_failed'})
        report['passed'] = report['mechanical_checks_passed'] = report['preservation']['passed'] = False
    return report
