"""Copy verified native form labels into missing/generated descriptions.

The owning terminal field's /TU supplies an authored accessible name. It is
not inherited from an arbitrary ancestor field. Pushbutton /MK /CA is another
explicit native name; internal /T names and appearance-state codes are never
invented into user-facing labels. See W3C PDF12 and ISO 32000-1 Table 220.
https://www.w3.org/WAI/WCAG22/Techniques/pdf/PDF12

This local helper preserves all field behavior and rendering. Radio option
meaning and missing authored labels require review. It does not certify a PDF.
"""
from __future__ import annotations

import hashlib
from pathlib import Path

from pypdf import PdfReader, PdfWriter
from pypdf.generic import ArrayObject, DictionaryObject, NameObject, TextStringObject
import pypdfium2 as pdfium

from pdf_safety import reject_signed_pdf
from semantic_repairs import _tag_nodes
from verify_pdf import Canonicalizer, resolved, rendered_page_hashes, structure_inventory

MAX_BYTES = 4 * 1024 * 1024
MAX_WIDGETS = 500
MAX_FIELDS = 500


def _sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _text(value, *, name=False):
    if value is None:
        return None
    value = resolved(value)
    if not isinstance(value, TextStringObject) or len(value) > (200 if name else 2000):
        raise ValueError('bounded_native_text_string_required')
    text = str(value)
    if any(ord(c) < 32 and c not in '\t\r\n' for c in text):
        raise ValueError('invalid_label_control_character')
    if name and (not text or '.' in text):
        raise ValueError('unambiguous_partial_field_name_required')
    return text


def _meaningful(value):
    return bool(value and value.strip() and value.strip().casefold() != 'annotation')


def _open(path):
    if not path.is_file() or path.stat().st_size > MAX_BYTES:
        raise ValueError('bounded_pdf_input_required')
    reader = PdfReader(path, strict=True)
    if reader.is_encrypted or not 1 <= len(reader.pages) <= 60:
        raise ValueError('encrypted_or_page_limit_input_unsupported')
    reject_signed_pdf(reader)
    form = resolved(reader.root_object.get('/AcroForm'))
    if not isinstance(form, DictionaryObject):
        raise ValueError('native_acroform_required')
    if '/XFA' in form:
        raise ValueError('xfa_form_labels_unsupported')
    return reader


def _field_widgets(reader):
    """Resolve actual canonical terminal owners, retaining duplicate label text."""
    form = resolved(reader.root_object['/AcroForm'])
    roots = resolved(form.get('/Fields'))
    if not isinstance(roots, ArrayObject) or not roots:
        raise ValueError('canonical_field_tree_required')
    page_widgets = {}
    for page_number, page in enumerate(reader.pages, 1):
        annots = resolved(page.get('/Annots', []))
        if not isinstance(annots, list):
            raise ValueError('annotation_array_required')
        for ordinal, reference in enumerate(annots, 1):
            widget = resolved(reference)
            if not isinstance(widget, DictionaryObject):
                raise ValueError('annotation_dictionary_required')
            if widget.get('/Subtype') != '/Widget':
                continue
            if id(widget) in page_widgets or len(page_widgets) >= MAX_WIDGETS:
                raise ValueError('unique_bounded_widget_occurrences_required')
            if '/P' in widget and Canonicalizer.owned_reference(widget.raw_get('/P')) != Canonicalizer.owned_reference(page):
                raise ValueError('widget_page_reference_mismatch')
            page_widgets[id(widget)] = {'node': widget, 'ref': {'pageNumber': page_number, 'annotationIndex': ordinal}}
    fields = []
    seen, names, assigned = set(), set(), set()

    def visit(value, parent, prefix, inherited, depth=0):
        node = resolved(value)
        if not isinstance(node, DictionaryObject) or id(node) in seen or depth > 16 or len(seen) >= MAX_FIELDS:
            raise ValueError('bounded_unique_field_tree_required')
        seen.add(id(node))
        if (parent is None and '/Parent' in node) or (parent is not None and resolved(node.get('/Parent')) is not parent):
            raise ValueError('canonical_field_parent_mismatch')
        partial = _text(node.get('/T'), name=True)
        if partial is None:
            raise ValueError('canonical_field_name_required')
        path = (*prefix, partial)
        properties = dict(inherited)
        for key in ('/FT', '/Ff', '/V', '/DV'):
            if key in node: properties[key] = resolved(node[key])
        kids = resolved(node.get('/Kids', []))
        if not isinstance(kids, list) or len(kids) > MAX_WIDGETS:
            raise ValueError('bounded_field_children_required')
        if node.get('/Subtype') == '/Widget':
            if kids:
                raise ValueError('merged_widget_with_children_unsupported')
            widgets = [node]
        elif kids and all(isinstance(resolved(k), DictionaryObject) and resolved(k).get('/Subtype') == '/Widget'
                          and '/T' not in resolved(k) for k in kids):
            widgets = [resolved(k) for k in kids]
            for widget in widgets:
                if resolved(widget.get('/Parent')) is not node or '/Kids' in widget:
                    raise ValueError('terminal_widget_parent_mismatch')
                if any(key in widget for key in ('/FT', '/Ff', '/V', '/DV', '/TU')):
                    raise ValueError('widget_field_override_unsupported')
        elif kids:
            if any(not isinstance(resolved(k), DictionaryObject) or '/T' not in resolved(k) for k in kids):
                raise ValueError('mixed_field_widget_children_unsupported')
            for child in kids:
                visit(child, node, path, properties, depth + 1)
            return
        else:
            raise ValueError('terminal_field_without_widget_unsupported')
        if path in names:
            raise ValueError('duplicate_fully_qualified_field_name')
        names.add(path)
        field_type = str(properties.get('/FT', ''))
        flags = properties.get('/Ff', 0)
        if field_type not in ('/Tx', '/Ch', '/Btn') or type(flags).__name__ not in ('int', 'NumberObject') or int(flags) < 0:
            raise ValueError('unsupported_field_type_or_flags')
        owned = []
        for widget in widgets:
            if id(widget) not in page_widgets or id(widget) in assigned:
                raise ValueError('unique_canonical_widget_owner_required')
            assigned.add(id(widget))
            owned.append(page_widgets[id(widget)])
        fields.append({'node': node, 'fieldPath': list(path), 'type': field_type,
            'flags': int(flags), 'tooltip': _text(node.get('/TU')), 'widgets': owned,
            'value': properties.get('/V'), 'options': resolved(node.get('/Opt'))})
    for item in roots:
        visit(item, None, (), {})
    if assigned != set(page_widgets):
        raise ValueError('orphan_widget_outside_canonical_fields')
    return fields


def _widget_key(ref):
    return ref['pageNumber'], ref['annotationIndex']


def _forms(reader, *, required):
    if '/StructTreeRoot' not in reader.root_object:
        if required: raise ValueError('native_form_tags_required')
        return [], {}
    info = structure_inventory(reader)
    nodes = _tag_nodes(reader)
    if len(nodes) != len(info['tags']) or any(str(n.get('/S', '')).lstrip('/') != t['sourceRole'] for n, t in zip(nodes, info['tags'])):
        raise ValueError('native_tag_inventory_mismatch')
    forms, owners = [], {}
    for node, tag in zip(nodes, info['tags']):
        if tag['role'] != 'Form':
            continue
        refs = tag.get('contentSequence', [])
        if (not refs or any(r.get('kind') != 'objectReference' or r.get('subtype') != 'Widget'
                or r.get('resolved') is not True or r.get('parentTreeVerified') is not True for r in refs)
                or tag.get('textIncomplete') or '/ActualText' in node):
            raise ValueError('simple_verified_widget_form_tags_required')
        record = {'node': node, 'tagId': tag['id'], 'widgets': [], 'alt': _text(node.get('/Alt'))}
        for ref in refs:
            key = (ref['pageNumber'], ref['annotationIndex'])
            if key in owners:
                raise ValueError('widget_has_multiple_form_owners')
            owners[key] = record
            record['widgets'].append({'pageNumber': key[0], 'annotationIndex': key[1]})
        forms.append(record)
    return forms, owners


def _catalog_fields_hash(reader):
    return Canonicalizer(list(reader.pages)).hash(reader.root_object['/AcroForm'])


def _document_snapshot(reader):
    canonical = Canonicalizer(list(reader.pages))
    return [canonical.hash(reader.root_object),
        *[Canonicalizer(list(reader.pages)).hash(dict(page)) for page in reader.pages],
        Canonicalizer().hash(reader.trailer.get('/Info'))]


def _form_page_hashes(path):
    """Include interactive widget appearances, which need a form environment."""
    results = []
    with pdfium.PdfDocument(str(path)) as document:
        document.init_forms()
        for number in range(len(document)):
            page = document[number]
            try:
                width, height = page.get_size()
                if width <= 0 or height <= 0 or width * height * 2.25 > 40_000_000:
                    raise ValueError('form_render_size_limit')
                bitmap = page.render(scale=1.5, draw_annots=True, may_draw_forms=True)
                try:
                    pixels = bitmap.to_pil()
                    results.append((pixels.size, hashlib.sha256(pixels.tobytes()).hexdigest()))
                finally:
                    bitmap.close()
            finally:
                page.close()
    return results


def repair_form_labels(original: Path, candidate: Path, output: Path, *,
        expected_original_sha256: str, expected_candidate_sha256: str):
    original, candidate, output = Path(original), Path(candidate), Path(output)
    if output.exists() or output.resolve() in (original.resolve(), candidate.resolve()):
        raise ValueError('new_output_required')
    source, proposed = _open(original), _open(candidate)
    if (_sha(original), _sha(candidate)) != (expected_original_sha256, expected_candidate_sha256):
        raise ValueError('exact_input_hashes_required')
    source_fields, proposed_fields = _field_widgets(source), _field_widgets(proposed)
    if len(source.pages) != len(proposed.pages) or _catalog_fields_hash(source) != _catalog_fields_hash(proposed):
        raise ValueError('authored_field_behavior_or_relationships_changed')
    source_forms, source_owners = _forms(source, required=False)
    proposed_forms, proposed_owners = _forms(proposed, required=True)
    source_by_widget = {_widget_key(w['ref']): (field, w) for field in source_fields for w in field['widgets']}
    proposed_by_widget = {_widget_key(w['ref']): (field, w) for field in proposed_fields for w in field['widgets']}
    if set(source_by_widget) != set(proposed_by_widget) or set(proposed_by_widget) != set(proposed_owners):
        raise ValueError('exact_widget_form_membership_required')
    for key, (field, _) in source_by_widget.items():
        if field['fieldPath'] != proposed_by_widget[key][0]['fieldPath']:
            raise ValueError('widget_field_path_changed')
    changes, reviews, evidence = [], [], []
    allowed_labels = {}
    blocked_widgets = set()
    for field in source_fields:
        refs = [w['ref'] for w in field['widgets']]
        keys = [_widget_key(ref) for ref in refs]
        is_radio = field['type'] == '/Btn' and bool(field['flags'] & 32768)
        is_push = field['type'] == '/Btn' and bool(field['flags'] & 65536)
        blocked = is_radio or (field['type'] == '/Btn' and len(refs) > 1)
        if blocked:
            blocked_widgets.update(keys)
            reviews.append({'code': 'button_option_labels_need_review', 'fieldPath': field['fieldPath'], 'widgetRefs': refs,
                'message': 'The shared field name does not identify each button option. Check the option labels before this form is considered accessible.'})
        evidence.append({'fieldPath': field['fieldPath'], 'type': field['type'], 'flags': field['flags'],
            'tooltip': field['tooltip'], 'widgetRefs': refs,
            'value': Canonicalizer().value(field['value']), 'options': Canonicalizer().value(field['options'])})
        for key, widget in zip(keys, field['widgets']):
            source_contents = _text(widget['node'].get('/Contents'))
            current_contents = _text(proposed_by_widget[key][1]['node'].get('/Contents'))
            source_form = source_owners.get(key)
            if _meaningful(source_contents) and _meaningful(current_contents) and source_contents != current_contents:
                raise ValueError('authored_widget_description_changed')
            current_alt = proposed_owners[key]['alt']
            if source_form and _meaningful(source_form['alt']) and _meaningful(current_alt) and current_alt != source_form['alt']:
                raise ValueError('authored_form_description_changed')
            if blocked:
                continue
            options = []
            if _meaningful(field['tooltip']): options.append(('terminalFieldTooltip', field['tooltip']))
            if _meaningful(source_contents): options.append(('authoredWidgetContents', source_contents))
            if source_form and _meaningful(source_form['alt']): options.append(('authoredFormAlt', source_form['alt']))
            if is_push:
                appearance = resolved(widget['node'].get('/MK', {}))
                caption = _text(appearance.get('/CA')) if isinstance(appearance, DictionaryObject) else None
                if _meaningful(caption): options.append(('pushbuttonCaption', caption))
            if not options:
                reviews.append({'code': 'authored_form_label_missing', 'fieldPath': field['fieldPath'], 'widgetRefs': [widget['ref']],
                    'message': 'This field has no clear authored tooltip or description. Provide its intended label; the internal field name is not used as a substitute.'})
                continue
            allowed_labels[key] = options
            # Existing authored annotation descriptions retain precedence over
            # copying the field name into that specific annotation property.
            evidence_kind, label = ('authoredWidgetContents', source_contents) if _meaningful(source_contents) else options[0]
            if not _meaningful(current_contents):
                changes.append({'target': 'widgetContents', 'fieldPath': field['fieldPath'], 'widgetRefs': [widget['ref']],
                    'tagId': proposed_owners[key]['tagId'], 'beforePresent': '/Contents' in proposed_by_widget[key][1]['node'],
                    'beforeValue': current_contents, 'afterValue': label, 'evidenceKind': evidence_kind})
    for form in proposed_forms:
        keys = [_widget_key(ref) for ref in form['widgets']]
        if _meaningful(form['alt']) or any(key in blocked_widgets or key not in allowed_labels for key in keys):
            continue
        paths = {tuple(source_by_widget[key][0]['fieldPath']) for key in keys}
        labels = []
        for key in keys:
            source_form = source_owners.get(key)
            labels.append(('authoredFormAlt', source_form['alt']) if source_form and _meaningful(source_form['alt']) else allowed_labels[key][0])
        if len(paths) != 1 or len(set(labels)) != 1:
            reviews.append({'code': 'form_tag_label_ambiguous', 'widgetRefs': form['widgets'], 'tagId': form['tagId'],
                'message': 'One Form tag covers controls with different labels. Their grouping needs review.'})
            continue
        kind, label = labels[0]
        changes.append({'target': 'formAlt', 'fieldPath': list(next(iter(paths))), 'widgetRefs': form['widgets'],
            'tagId': form['tagId'], 'beforePresent': '/Alt' in form['node'], 'beforeValue': form['alt'],
            'afterValue': label, 'evidenceKind': kind})
    writer = PdfWriter(clone_from=proposed)
    proposed_nodes, writer_nodes = _tag_nodes(proposed), _tag_nodes(writer)
    if (len(proposed_nodes) != len(writer_nodes) or
            any(a.get('/S') != b.get('/S') for a, b in zip(proposed_nodes, writer_nodes))):
        raise ValueError('cloned_tag_inventory_mismatch')
    node_positions = {id(node): i for i, node in enumerate(proposed_nodes)}
    tags = {form['tagId']: {'node': writer_nodes[node_positions[id(form['node'])]]}
            for form in proposed_forms}
    for change in changes:
        if change['target'] == 'formAlt':
            node, key = tags[change['tagId']]['node'], '/Alt'
        else:
            ref = change['widgetRefs'][0]
            node = resolved(writer.pages[ref['pageNumber'] - 1]['/Annots'][ref['annotationIndex'] - 1])
            key = '/Contents'
        node[NameObject(key)] = TextStringObject(change['afterValue'])
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open('xb') as handle:
        writer.write(handle)
    saved = _open(output)
    saved_forms, saved_owners = _forms(saved, required=True)
    saved_by_id = {f['tagId']: f for f in saved_forms}
    # Revert only declared edits in an in-memory reopened copy, then require
    # every catalog, page, resource and structural property to match the input.
    for change in changes:
        if change['target'] == 'formAlt':
            node, key = saved_by_id[change['tagId']]['node'], '/Alt'
        else:
            ref = change['widgetRefs'][0]
            node, key = resolved(saved.pages[ref['pageNumber'] - 1]['/Annots'][ref['annotationIndex'] - 1]), '/Contents'
        if _text(node.get(key)) != change['afterValue']:
            raise ValueError('saved_label_mismatch')
        if change['beforePresent']: node[NameObject(key)] = TextStringObject(change['beforeValue'])
        else: node.pop(key, None)
    if _document_snapshot(saved) != _document_snapshot(proposed):
        raise ValueError('unlisted_native_form_change')
    if rendered_page_hashes(candidate) != rendered_page_hashes(output):
        raise ValueError('form_label_repair_changed_pixels')
    if _form_page_hashes(candidate) != _form_page_hashes(output):
        raise ValueError('form_label_repair_changed_widget_appearances')
    if (_sha(original), _sha(candidate)) != (expected_original_sha256, expected_candidate_sha256):
        raise ValueError('input_changed_during_repair')
    return {'schemaVersion': 1, 'operation': 'native-form-labels', 'sourcePath': str(original.resolve()),
        'inputPath': str(candidate.resolve()), 'sourceSha256': expected_original_sha256,
        'inputSha256': expected_candidate_sha256, 'outputSha256': _sha(output),
        'changes': changes, 'reviewItems': reviews, 'widgetEvidence': evidence,
        'requiresRevalidation': True, 'certification': False}
