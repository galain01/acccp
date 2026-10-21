"""Pair audited form labels and controls by moving existing native siblings.

Only distinct single-row text/choice fields with left labels, or single check
boxes with right labels, are supported. Original text and geometry establish
the pair; a completed audit must identify both tags as a reading-order problem.
The prior label ledger remains bound to its original immutable output.
"""
from __future__ import annotations
import hashlib
import json
import math
from pathlib import Path

import pypdfium2 as pdfium
from pypdf import PdfReader
from pypdf.generic import ArrayObject, NameObject

from form_label_repairs import _open, _field_widgets, _forms, _form_page_hashes
from form_label_validation import compare_with_authorized_form_labels, _document_graph
from semantic_repairs import _tag_nodes
from structure_repairs import apply_structure_plan, snapshot, children
from verify_pdf import resolved, structure_inventory


def _sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def visible_label_rect(path, page_number, text):
    if not isinstance(text, str) or not 1 <= len(text) <= 200 or '\n' in text or '\r' in text:
        raise ValueError('simple_single_line_label_required')
    with pdfium.PdfDocument(str(path)) as document:
        page = document[page_number - 1]
        try:
            textpage = page.get_textpage()
            try:
                search = textpage.search(text, match_case=True)
                try:
                    match = search.get_next()
                    if match is None or search.get_next() is not None:
                        raise ValueError('unique_exact_visible_label_required')
                finally:
                    search.close()
                start, count = match
                if textpage.get_text_range(start, count) != text or textpage.count_rects(start, count) != 1:
                    raise ValueError('exact_single_line_visible_label_required')
                rectangle = list(textpage.get_rect(0))
            finally:
                textpage.close()
        finally:
            page.close()
    if not all(math.isfinite(v) for v in rectangle) or rectangle[2] <= rectangle[0] or rectangle[3] <= rectangle[1]:
        raise ValueError('valid_visible_label_rectangle_required')
    return rectangle


def repair_form_reading_order(original: Path, candidate: Path, output: Path, *, audit_report: Path,
        label_ledger: Path, pairs: list, expected_original_sha256: str, expected_candidate_sha256: str):
    original, candidate, output = map(Path, (original, candidate, output))
    audit_report, label_ledger = Path(audit_report), Path(label_ledger)
    if output.exists() or output.resolve() in {original.resolve(), candidate.resolve()}:
        raise ValueError('new_output_required')
    if (_sha(original), _sha(candidate)) != (expected_original_sha256, expected_candidate_sha256):
        raise ValueError('exact_input_hashes_required')
    source, current = _open(original), _open(candidate)
    if label_ledger.stat().st_size > 512000 or audit_report.stat().st_size > 2 * 1024 * 1024:
        raise ValueError('bounded_evidence_required')
    label_hash, audit_hash = _sha(label_ledger), _sha(audit_report)
    label_report = compare_with_authorized_form_labels(original, candidate, json.loads(label_ledger.read_text(encoding='utf-8')))
    if (not label_report.get('passed') or label_report['form_label_validation'].get('reviewItems')):
        raise ValueError('independently_verified_prior_labels_required')
    audit = json.loads(audit_report.read_text(encoding='utf-8'))
    if (audit.get('status') != 'complete' or audit.get('outputSha256') != expected_candidate_sha256
            or audit.get('sourceSha256') != expected_original_sha256):
        raise ValueError('complete_matching_audit_required')
    if not isinstance(pairs, list) or not 1 <= len(pairs) <= 20:
        raise ValueError('bounded_explicit_form_pairs_required')
    inventory = structure_inventory(current)
    tags = {tag['id']: tag for tag in inventory['tags']}
    if (sorted(audit.get('reviewedPages', [])) != list(range(1, len(current.pages) + 1))
            or sorted(audit.get('reviewedTagIds', [])) != sorted(tags)):
        raise ValueError('complete_matching_audit_coverage_required')
    nodes = _tag_nodes(current)
    if len(nodes) != len(tags) or any(str(node.get('/S', '')).lstrip('/') != tag['sourceRole'] for node, tag in zip(nodes, tags.values())):
        raise ValueError('native_tag_inventory_mismatch')
    native = dict(zip(tags, nodes))
    _, owners = _forms(current, required=True)
    fields = { (w['ref']['pageNumber'], w['ref']['annotationIndex']): (field, w['node'])
               for field in _field_widgets(source) for w in field['widgets'] }
    approved, used, pages, parents = [], set(), set(), set()
    for pair in pairs:
        if not isinstance(pair, dict) or set(pair) != {'labelTagId', 'formTagId'}:
            raise ValueError('explicit_pair_identities_required')
        label_id, form_id = pair['labelTagId'], pair['formTagId']
        if label_id not in tags or form_id not in tags or label_id in used or form_id in used:
            raise ValueError('unique_known_pair_targets_required')
        used.update((label_id, form_id))
        label, form = tags[label_id], tags[form_id]
        refs = form['contentSequence']
        if (label['role'] != 'P' or label['sourceRole'] != 'P' or form['role'] != 'Form' or form['sourceRole'] != 'Form'
            or len(refs) != 1 or refs[0].get('kind') != 'objectReference'
            or any(r.get('kind') != 'markedContent' or r.get('resolved') is not True or r.get('parentTreeVerified') is not True
                   for r in label['contentSequence'])
            or not label['contentSequence'] or label.get('textIncomplete') or form.get('textIncomplete')
            or label['parentId'] != form['parentId']
            or any(key in native[label_id] for key in ('/ActualText', '/Alt'))):
            raise ValueError('simple_native_label_widget_pair_required')
        ref = refs[0]
        key = (ref['pageNumber'], ref['annotationIndex'])
        if (key not in fields or owners[key]['tagId'] != form_id or label['pageNumber'] != key[0]
            or any(r.get('pageNumber') != key[0] for r in label['contentSequence'])
            or key[0] not in audit.get('reviewedPages', [])
            or not {label_id, form_id} <= set(audit.get('reviewedTagIds', []))
            or not any(f.get('code') == 'reading-order' and f.get('pageNumber') == key[0]
                       and {label_id, form_id} <= set(f.get('tagIds', [])) for f in audit.get('findings', []))):
            raise ValueError('matching_audited_form_pair_required')
        field, widget = fields[key]
        if len(field['widgets']) != 1 or field['type'] not in ('/Tx', '/Ch', '/Btn') or field['flags'] & (32768 | 65536):
            raise ValueError('simple_individual_control_required')
        text = label['text'].strip()
        label_rect = visible_label_rect(original, key[0], text)
        if visible_label_rect(candidate, key[0], text) != label_rect:
            raise ValueError('visible_label_geometry_changed')
        rectangle = resolved(widget.get('/Rect'))
        if not isinstance(rectangle, list) or len(rectangle) != 4:
            raise ValueError('valid_widget_rectangle_required')
        widget_rect = [float(v) for v in rectangle]
        if (not all(math.isfinite(v) for v in widget_rect) or widget_rect[2] <= widget_rect[0]
                or widget_rect[3] <= widget_rect[1]
                or min(label_rect[3], widget_rect[3]) <= max(label_rect[1], widget_rect[1])):
            raise ValueError('same_visible_row_required')
        if field['type'] == '/Btn':
            position, gap = 'controlThenLabel', label_rect[0] - widget_rect[2]
        else:
            position, gap = 'labelThenControl', widget_rect[0] - label_rect[2]
        if not 0 <= gap <= 180:
            raise ValueError('unambiguous_adjacent_control_required')
        pages.add(key[0]); parents.add(label['parentId'])
        approved.append({**pair, 'fieldPath': field['fieldPath'],
            'widgetRef': {'pageNumber': key[0], 'annotationIndex': key[1]},
            'labelText': text, 'labelRect': label_rect, 'widgetRect': widget_rect, 'position': position})
    if len(pages) != 1 or len(parents) != 1:
        raise ValueError('same_page_parent_pairs_required')
    parent_id = next(iter(parents))
    if parent_id not in tags or tags[parent_id]['role'] != 'Document' or tags[parent_id]['sourceRole'] != 'Document':
        raise ValueError('direct_document_children_required')
    before = [item['tagId'] for item in tags[parent_id]['contentSequence'] if item.get('kind') == 'childTag']
    if len(before) != len(tags[parent_id]['contentSequence']) or not used <= set(before) or len(before) != len(set(before)):
        raise ValueError('exact_native_sibling_set_required')
    approved.sort(key=lambda p: -max(p['labelRect'][3], p['widgetRect'][3]))
    rows = [(min(p['labelRect'][1], p['widgetRect'][1]), max(p['labelRect'][3], p['widgetRect'][3])) for p in approved]
    if any(lower[1] >= upper[0] for upper, lower in zip(rows, rows[1:])):
        raise ValueError('distinct_nonoverlapping_rows_required')
    # A partial set of fields cannot authorize skipping an intervening control.
    page = next(iter(pages))
    if {(p['widgetRef']['pageNumber'], p['widgetRef']['annotationIndex']) for p in approved} != {key for key in fields if key[0] == page}:
        raise ValueError('all_page_controls_must_be_paired')
    ordered = []
    for pair in approved:
        ids = [pair['labelTagId'], pair['formTagId']]
        ordered.extend(ids if pair['position'] == 'labelThenControl' else reversed(ids))
    selected_positions = [i for i, tag_id in enumerate(before) if tag_id in used]
    if selected_positions != list(range(selected_positions[0], selected_positions[-1] + 1)):
        raise ValueError('consecutive_pair_block_required')
    after = before[:selected_positions[0]] + ordered + before[selected_positions[-1] + 1:]
    if before == after:
        raise ValueError('already_paired_order')
    plan = {'schemaVersion': 1, 'inputSha256': expected_candidate_sha256, 'auditReportSha256': audit_hash,
        'snapshots': {identity: snapshot(tags[identity]) for identity in [parent_id, *before]},
        'operations': [{'kind': 'order', 'tagId': parent_id, 'order': [before.index(identity) for identity in after], 'findingCode': 'reading-order',
                        'reason': 'Pair each exact visible source label with its native control in the audited single-column form.'}]}
    apply_structure_plan(candidate, output, plan, audit_report=audit_report)
    saved = PdfReader(output, strict=True)
    saved_nodes = _tag_nodes(saved)
    # This writer changes only a sibling array. Verify every saved object after
    # restoring that array in memory; no field, text, or parent pointer may change.
    saved_info = structure_inventory(saved)
    if len(saved_nodes) != len(saved_info['tags']) or any(str(n.get('/S', '')).lstrip('/') != t['sourceRole']
                                                        for n, t in zip(saved_nodes, saved_info['tags'])):
        raise ValueError('saved_native_inventory_mismatch')
    # The parent itself precedes its permuted children, so its preorder identity
    # is stable even when clone serialization renumbers native object IDs.
    saved_parent = dict(zip([t['id'] for t in saved_info['tags']], saved_nodes))[parent_id]
    expected_roles = [tags[identity]['sourceRole'] for identity in after]
    saved_children = children(saved_parent)
    if [str(resolved(k)['/S']).lstrip('/') for k in saved_children] != expected_roles:
        raise ValueError('saved_form_order_mismatch')
    by_before_id = {identity: child for identity, child in zip(after, saved_children)}
    saved_parent[NameObject('/K')] = ArrayObject([by_before_id[identity] for identity in before])
    if _document_graph(saved) != _document_graph(current):
        raise ValueError('unlisted_form_order_change')
    if _form_page_hashes(candidate) != _form_page_hashes(output):
        raise ValueError('form_order_appearance_changed')
    if (_sha(original), _sha(candidate), _sha(label_ledger), _sha(audit_report)) != (
        expected_original_sha256, expected_candidate_sha256, label_hash, audit_hash):
        raise ValueError('form_order_evidence_changed')
    return {'schemaVersion': 1, 'operation': 'native-form-reading-order',
        'sourcePath': str(original.resolve()), 'sourceSha256': expected_original_sha256,
        'inputPath': str(candidate.resolve()), 'inputSha256': expected_candidate_sha256,
        'outputSha256': _sha(output), 'labelLedgerPath': str(label_ledger.resolve()),
        'labelLedgerSha256': label_hash, 'auditPath': str(audit_report.resolve()), 'auditSha256': audit_hash,
        'parentTagId': parent_id, 'beforeOrder': before, 'afterOrder': after, 'pairs': approved,
        'requiresRevalidation': True, 'certification': False}
