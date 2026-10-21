"""Independent, opt-in verification of exact authored form-label copies.

The ledger is a request to check an exception, never evidence that its labels
are correct. Every allowed string is resolved again from the original field,
widget, or Form owner. All saved native objects are compared after undoing only
the declared labels in memory. This does not test keyboard or screen-reader UX.
"""
from __future__ import annotations

import io
import json
import math
from pathlib import Path

from pypdf import PdfReader
from pypdf.generic import DictionaryObject, StreamObject, NameObject, TextStringObject

import verify_pdf as v
from font_validation import verify_other_content
from pdf_safety import reject_signed_pdf

MAX_MANIFEST_BYTES = 512_000
MAX_WIDGETS = 500
LEDGER_KEYS = {'schemaVersion', 'operation', 'sourcePath', 'inputPath', 'sourceSha256',
               'inputSha256', 'outputSha256', 'changes', 'reviewItems', 'widgetEvidence',
               'requiresRevalidation', 'certification'}
CHANGE_KEYS = {'target', 'fieldPath', 'widgetRefs', 'tagId', 'beforePresent',
               'beforeValue', 'afterValue', 'evidenceKind'}


def require(value, code):
    if not value:
        raise v.InspectionError(code)


def _text(value):
    value = v.resolved(value)
    if value is None:
        return None
    require(isinstance(value, TextStringObject) and len(value) <= 2000
            and all(ord(c) >= 32 or c in '\t\r\n' for c in value), 'form_label_text_unsupported')
    return str(value)


def _meaningful(value):
    return bool(value and value.strip() and value.strip().casefold() != 'annotation')


def _snapshot(path):
    path = Path(path)
    require(path.is_file() and path.stat().st_size <= v.MAX_FILE_BYTES, 'form_label_file_limit')
    data = path.read_bytes()
    require(len(data) <= v.MAX_FILE_BYTES, 'form_label_file_limit')
    reader = PdfReader(io.BytesIO(data), strict=True)
    require(not reader.is_encrypted and 1 <= len(reader.pages) <= v.MAX_PAGES, 'form_label_unsupported_pdf')
    reject_signed_pdf(reader)
    form = v.resolved(reader.root_object.get('/AcroForm'))
    require(isinstance(form, dict) and '/XFA' not in form, 'form_label_native_acroform_required')
    return reader, v.digest(data)


class ExactGraph(v.Canonicalizer):
    """Retain labels, structure ownership, and full stream bytes in comparisons.

    The general preservation canonicalizer intentionally ignores widget
    Contents and marked-content wrappers. That exception is inappropriate for
    checking this label-only operation's immutable input against its output.
    """
    def __init__(self, pages, *, field_comparison=False):
        super().__init__(pages)
        self.field_comparison = field_comparison
        self.converted = {}

    def value(self, item, active=None, depth=0):
        raw = v.resolved(item)
        if self.owned_reference(item) in self.page_refs or id(raw) in self.pages:
            return super().value(item, active, depth)
        if isinstance(raw, dict):
            if id(raw) not in self.converted:
                # A list of pairs bypasses general annotation exceptions while
                # retaining shared/cyclic references through this stable proxy.
                pairs = []
                self.converted[id(raw)] = pairs
                skipped = {'/Length', '/Filter', '/DecodeParms'} if isinstance(raw, StreamObject) else set()
                if self.field_comparison:
                    skipped |= {'/StructParent', '/StructParents'}
                    if raw.get('/Subtype') == '/Widget':
                        skipped.add('/Contents')
                pairs.extend((str(key), value) for key, value in sorted(raw.items()) if key not in skipped)
                if isinstance(raw, StreamObject):
                    data = raw.get_data()
                    self.stream_bytes += len(data)
                    require(len(data) <= v.MAX_STREAM_BYTES and self.stream_bytes <= v.MAX_TOTAL_STREAM_BYTES,
                            'form_label_stream_limit')
                    pairs.append(('decoded_stream_sha256', v.digest(data)))
            return super().value(self.converted[id(raw)], active, depth)
        return super().value(item, active, depth)


def _document_graph(reader):
    # Separate instances ensure each root has a deterministic shared-object map.
    roots = [reader.root_object, *[dict(page) for page in reader.pages], reader.trailer.get('/Info')]
    return [ExactGraph(list(reader.pages)).hash(root) for root in roots]


def _owners(reader):
    """Read field ownership independently of get_fields() and repair discovery."""
    occurrences, assigned, fields, seen, paths = {}, set(), {}, set(), set()
    for page_number, page in enumerate(reader.pages, 1):
        annots = v.resolved(page.get('/Annots', []))
        require(isinstance(annots, list), 'form_label_annotations_invalid')
        for ordinal, item in enumerate(annots, 1):
            node = v.resolved(item)
            require(isinstance(node, dict), 'form_label_annotation_invalid')
            if node.get('/Subtype') != '/Widget':
                continue
            require(id(node) not in occurrences and len(occurrences) < MAX_WIDGETS, 'form_label_widget_reused')
            require('/P' not in node or v.Canonicalizer.owned_reference(node['/P']) == v.Canonicalizer.owned_reference(page),
                    'form_label_widget_page_mismatch')
            occurrences[id(node)] = ((page_number, ordinal), node)

    def walk(item, parent, path, inherited, depth):
        node = v.resolved(item)
        require(isinstance(node, dict) and id(node) not in seen and depth <= 16 and len(seen) < 1000,
                'form_label_field_tree_invalid')
        seen.add(id(node))
        require(('/Parent' not in node if parent is None else v.resolved(node.get('/Parent')) is parent),
                'form_label_field_parent_mismatch')
        name = _text(node.get('/T'))
        require(name and len(name) <= 200 and '.' not in name, 'form_label_partial_name_ambiguous')
        path = (*path, name)
        state = {**inherited, **{key: v.resolved(node[key]) for key in ('/FT', '/Ff', '/V', '/DV') if key in node}}
        kids = v.resolved(node.get('/Kids', []))
        require(isinstance(kids, list) and len(kids) <= MAX_WIDGETS, 'form_label_kids_invalid')
        if node.get('/Subtype') == '/Widget':
            require(not kids, 'form_label_merged_widget_children')
            widgets = [node]
        elif kids and all(isinstance(v.resolved(k), dict) and '/T' not in v.resolved(k)
                          and v.resolved(k).get('/Subtype') == '/Widget' for k in kids):
            widgets = [v.resolved(k) for k in kids]
            for widget in widgets:
                require(v.resolved(widget.get('/Parent')) is node and '/Kids' not in widget
                        and not any(key in widget for key in ('/FT', '/Ff', '/V', '/DV', '/TU')),
                        'form_label_widget_field_override')
        else:
            require(kids and all(isinstance(v.resolved(k), dict) and '/T' in v.resolved(k) for k in kids),
                    'form_label_terminal_owner_missing')
            for child in kids:
                walk(child, node, path, state, depth + 1)
            return
        require(path not in paths, 'form_label_duplicate_field_path')
        paths.add(path)
        flags = state.get('/Ff', 0)
        require(state.get('/FT') in ('/Tx', '/Ch', '/Btn') and v.integer(flags) is not None,
                'form_label_field_type_unsupported')
        field = {'path': path, 'node': node, 'type': str(state['/FT']), 'flags': int(flags),
                 'tooltip': _text(node.get('/TU')), 'value': state.get('/V'),
                 'defaultValue': state.get('/DV'), 'options': v.resolved(node.get('/Opt')), 'widgets': []}
        for widget in widgets:
            require(id(widget) in occurrences and id(widget) not in assigned, 'form_label_widget_owner_ambiguous')
            assigned.add(id(widget))
            key, widget = occurrences[id(widget)]
            fields[key] = (field, widget)
            field['widgets'].append(key)
    roots = v.resolved(v.resolved(reader.root_object['/AcroForm']).get('/Fields'))
    require(isinstance(roots, list) and roots, 'form_label_roots_invalid')
    for item in roots:
        walk(item, None, (), {}, 0)
    require(assigned == set(occurrences), 'form_label_orphan_widget')
    return fields


def _native_forms(reader, *, required):
    if '/StructTreeRoot' not in reader.root_object:
        require(not required, 'form_label_tags_missing')
        return {}, {}, []
    root = v.resolved(reader.root_object['/StructTreeRoot'])
    nodes, visited = [], set()
    def visit(value, depth=0):
        value = v.resolved(value)
        require(depth <= v.MAX_DEPTH, 'form_label_structure_depth')
        if isinstance(value, list):
            for child in value: visit(child, depth + 1)
        elif isinstance(value, dict) and value.get('/Type') not in ('/MCR', '/OBJR'):
            require('/S' in value and id(value) not in visited and len(nodes) < 20000,
                    'form_label_structure_reused')
            visited.add(id(value)); nodes.append(value)
            if '/K' in value: visit(value['/K'], depth + 1)
    visit(root.get('/K', []))
    inventory = v.structure_inventory(reader)
    require(len(nodes) == len(inventory['tags']), 'form_label_structure_inventory_mismatch')
    tags, owners = {}, {}
    for node, tag in zip(nodes, inventory['tags']):
        require(str(node['/S']).lstrip('/') == tag['sourceRole'], 'form_label_structure_inventory_mismatch')
        if tag['role'] != 'Form': continue
        sequence = tag['contentSequence']
        require(sequence and '/ActualText' not in node and not tag.get('textIncomplete'), 'form_label_form_shape_unsupported')
        keys = []
        for ref in sequence:
            require(ref.get('kind') == 'objectReference' and ref.get('subtype') == 'Widget'
                    and ref.get('resolved') is True and ref.get('parentTreeVerified') is True,
                    'form_label_objr_unverified')
            key = (ref['pageNumber'], ref['annotationIndex'])
            require(key not in owners, 'form_label_multiple_tag_owners')
            keys.append(key); owners[key] = tag['id']
        tags[tag['id']] = {'node': node, 'keys': keys, 'alt': _text(node.get('/Alt'))}
    return tags, owners, inventory['tags']


def _refs(refs):
    require(isinstance(refs, list) and 1 <= len(refs) <= MAX_WIDGETS, 'form_label_widget_refs_invalid')
    result = []
    for item in refs:
        require(isinstance(item, dict) and set(item) == {'pageNumber', 'annotationIndex'}
                and type(item['pageNumber']) is int and type(item['annotationIndex']) is int
                and item['pageNumber'] > 0 and item['annotationIndex'] > 0, 'form_label_widget_refs_invalid')
        result.append((item['pageNumber'], item['annotationIndex']))
    require(len(set(result)) == len(result), 'form_label_widget_refs_duplicate')
    return result


def initialized_form_pixels(path):
    """Include AcroForm widget appearances; draw_annots alone omits widgets."""
    import pypdfium2 as pdfium
    document = pdfium.PdfDocument(str(path))
    result = []
    try:
        document.init_forms()
        for index in range(len(document)):
            page = document[index]
            try:
                width, height = page.get_size()
                require(math.isfinite(width + height) and width > 0 and height > 0
                        and math.ceil(width * v.RENDER_SCALE) * math.ceil(height * v.RENDER_SCALE) <= v.MAX_PAGE_PIXELS,
                        'form_label_render_limit')
                bitmap = page.render(scale=v.RENDER_SCALE, draw_annots=True, may_draw_forms=True)
                try:
                    image = bitmap.to_pil().convert('RGB')
                    result.append({'pageNumber': index + 1, 'width': image.width, 'height': image.height,
                                   'sha256': v.digest(image.tobytes())})
                finally:
                    bitmap.close()
            finally:
                page.close()
    finally:
        document.close()
    return result


def _saved_widget_evidence(fields, forms):
    rows = []
    for key, (field, widget) in sorted(fields.items()):
        flags = field['flags']
        tag_id = forms[1][key]
        appearance = v.resolved(widget.get('/AP', {}))
        normal = v.resolved(appearance.get('/N')) if isinstance(appearance, dict) else None
        states = sorted(str(state) for state in normal) if isinstance(normal, dict) and not isinstance(normal, StreamObject) else []
        canonical = v.Canonicalizer()
        rows.append({'pageNumber': key[0], 'annotationIndex': key[1], 'fieldPath': list(field['path']),
                     'fieldType': field['type'], 'flags': flags, 'required': bool(flags & 2),
                     'readOnly': bool(flags & 1), 'noExport': bool(flags & 4),
                     'radio': field['type'] == '/Btn' and bool(flags & 32768),
                     'pushbutton': field['type'] == '/Btn' and bool(flags & 65536),
                     'combo': field['type'] == '/Ch' and bool(flags & 131072),
                     'editableChoice': field['type'] == '/Ch' and bool(flags & 262144),
                     'multiSelect': field['type'] == '/Ch' and bool(flags & 2097152),
                     'value': canonical.value(field['value']), 'defaultValue': canonical.value(field['defaultValue']),
                     'options': canonical.value(field['options']), 'tooltip': field['tooltip'],
                     'appearanceState': canonical.value(widget.get('/AS')), 'availableAppearanceStates': states,
                     'annotationFlags': canonical.value(widget.get('/F')), 'rect': canonical.value(widget.get('/Rect')),
                     'tagId': tag_id, 'formAlt': forms[0][tag_id]['alt'],
                     'widgetContents': _text(widget.get('/Contents')), 'parentTreeAndOBJRVerified': True})
    return rows


def authorize_form_labels(original: Path, final: Path, ledger: dict):
    """Return independently checked evidence; never write or repair a PDF."""
    require(isinstance(ledger, dict) and set(ledger) == LEDGER_KEYS
            and len(json.dumps(ledger, ensure_ascii=True).encode()) <= MAX_MANIFEST_BYTES
            and type(ledger['schemaVersion']) is int and ledger['schemaVersion'] == 1
            and ledger['operation'] == 'native-form-labels'
            and ledger['requiresRevalidation'] is True and ledger['certification'] is False,
            'form_label_ledger_invalid')
    require(isinstance(ledger['sourcePath'], str) and Path(ledger['sourcePath']).resolve() == Path(original).resolve()
            and isinstance(ledger['inputPath'], str) and Path(ledger['inputPath']).is_absolute(), 'form_label_paths_mismatch')
    input_path = Path(ledger['inputPath'])
    require(input_path.resolve() != Path(final).resolve(), 'form_label_input_output_alias')
    source, sh = _snapshot(original); before, bh = _snapshot(input_path); after, ah = _snapshot(final)
    require((sh, bh, ah) == (ledger['sourceSha256'], ledger['inputSha256'], ledger['outputSha256']),
            'form_label_hash_mismatch')
    readers = (source, before, after)
    fields = [_owners(reader) for reader in readers]
    require(set(fields[0]) == set(fields[1]) == set(fields[2]), 'form_label_widget_set_changed')
    require(len(source.pages) == len(before.pages) == len(after.pages), 'form_label_page_count_changed')
    for key in fields[0]:
        require(fields[0][key][0]['path'] == fields[1][key][0]['path'] == fields[2][key][0]['path'],
                'form_label_widget_field_changed')
    source_form_hash = ExactGraph(list(source.pages), field_comparison=True).hash(source.root_object['/AcroForm'])
    require(all(ExactGraph(list(reader.pages), field_comparison=True).hash(reader.root_object['/AcroForm']) == source_form_hash
                for reader in (before, after)), 'form_label_original_field_behavior_changed')
    forms = [_native_forms(reader, required=index > 0) for index, reader in enumerate(readers)]
    require(set(forms[1][1]) == set(fields[1]) == set(forms[2][1]), 'form_label_form_coverage_incomplete')
    saved_widget_evidence = _saved_widget_evidence(fields[2], forms[2])
    options, reviews = {}, []
    for key, (field, widget) in fields[0].items():
        contents = _text(widget.get('/Contents'))
        source_form = forms[0][0].get(forms[0][1].get(key))
        alt = source_form['alt'] if source_form else None
        for index in (1, 2):
            target_contents = _text(fields[index][key][1].get('/Contents'))
            target_alt = forms[index][0][forms[index][1][key]]['alt']
            require(not _meaningful(contents) or not _meaningful(target_contents) or contents == target_contents,
                    'form_label_authored_contents_changed')
            require(not _meaningful(alt) or not _meaningful(target_alt) or alt == target_alt,
                    'form_label_authored_alt_changed')
            if index == 2:
                require(not _meaningful(contents) or contents == target_contents, 'form_label_authored_contents_lost')
                require(not _meaningful(alt) or alt == target_alt, 'form_label_authored_alt_lost')
        blocked = field['type'] == '/Btn' and (field['flags'] & 32768 or len(field['widgets']) > 1)
        values = {}
        if not blocked:
            if _meaningful(field['tooltip']): values['terminalFieldTooltip'] = field['tooltip']
            if _meaningful(contents): values['authoredWidgetContents'] = contents
            if _meaningful(alt): values['authoredFormAlt'] = alt
            if field['type'] == '/Btn' and field['flags'] & 65536:
                appearance = v.resolved(widget.get('/MK', {}))
                caption = _text(appearance.get('/CA')) if isinstance(appearance, dict) else None
                if _meaningful(caption): values['pushbuttonCaption'] = caption
        options[key] = values
        if blocked or not values:
            reviews.append({'code': 'button_option_labels_need_review' if blocked else 'authored_form_label_missing',
                            'pageNumber': key[0], 'annotationIndex': key[1], 'fieldPath': list(field['path'])})
        if not _meaningful(_text(fields[2][key][1].get('/Contents'))) and not blocked:
            reviews.append({'code': 'form_widget_description_unresolved', 'pageNumber': key[0],
                            'annotationIndex': key[1], 'fieldPath': list(field['path'])})
    for tag_id, form in forms[2][0].items():
        if _meaningful(form['alt']):
            continue
        paths = {fields[0][key][0]['path'] for key in form['keys']}
        shared_labels = set.intersection(*(set(options[key].values()) for key in form['keys']))
        reviews.append({'code': 'form_tag_label_ambiguous' if len(paths) != 1 or not shared_labels else 'form_tag_label_unresolved',
                        'pageNumber': form['keys'][0][0], 'tagId': tag_id,
                        'widgetRefs': [{'pageNumber': key[0], 'annotationIndex': key[1]} for key in form['keys']]})
    changes = ledger['changes']
    require(isinstance(changes, list) and len(changes) <= 2 * MAX_WIDGETS, 'form_label_change_limit')
    seen = set()
    for change in changes:
        require(isinstance(change, dict) and set(change) == CHANGE_KEYS
                and change['target'] in ('formAlt', 'widgetContents')
                and type(change['beforePresent']) is bool and isinstance(change['afterValue'], str)
                and _meaningful(change['afterValue']), 'form_label_change_invalid')
        keys = _refs(change['widgetRefs']); tag_id = change['tagId']; target = change['target']
        require(isinstance(tag_id, str) and tag_id in forms[1][0] and tag_id in forms[2][0]
                and all(key in fields[0] for key in keys), 'form_label_target_unknown')
        require(all(list(fields[0][key][0]['path']) == change['fieldPath'] for key in keys), 'form_label_field_path_mismatch')
        require(all(forms[1][1][key] == tag_id == forms[2][1][key] for key in keys), 'form_label_wrong_form_owner')
        require(all(options[key].get(change['evidenceKind']) == change['afterValue'] for key in keys),
                'form_label_value_not_authored_for_widget')
        identity = (target, tag_id if target == 'formAlt' else keys[0])
        require(identity not in seen, 'form_label_duplicate_change'); seen.add(identity)
        if target == 'formAlt':
            require(keys == forms[1][0][tag_id]['keys'] == forms[2][0][tag_id]['keys'], 'form_label_partial_form_membership')
            old, new, prop = forms[1][0][tag_id]['node'], forms[2][0][tag_id]['node'], '/Alt'
        else:
            require(len(keys) == 1, 'form_label_widget_change_must_be_single')
            old, new, prop = fields[1][keys[0]][1], fields[2][keys[0]][1], '/Contents'
        require((prop in old) == change['beforePresent'] and _text(old.get(prop)) == change['beforeValue']
                and not _meaningful(change['beforeValue']), 'form_label_original_description_not_replaceable')
        require(_text(new.get(prop)) == change['afterValue'], 'form_label_saved_value_mismatch')
        if change['beforePresent']:
            require(isinstance(change['beforeValue'], str), 'form_label_before_value_invalid')
            new[NameObject(prop)] = TextStringObject(change['beforeValue'])
        else:
            new.pop(prop, None)
    require(_document_graph(before) == _document_graph(after), 'form_label_unlisted_native_change')
    require(v.rendered_page_hashes(input_path) == v.rendered_page_hashes(final), 'form_label_pixels_changed')
    # Source-to-candidate preservation also remains strict; normalization above
    # returns exactly the immutable candidate, not a caller-designed substitute.
    preserved = verify_other_content(source, before)
    require(v.rendered_page_hashes(original) == v.rendered_page_hashes(final), 'form_label_original_pixels_changed')
    form_pixels = [initialized_form_pixels(path) for path in (original, input_path, final)]
    require(form_pixels[0] == form_pixels[1] == form_pixels[2], 'form_label_initialized_widget_pixels_changed')
    for path, expected in ((original, sh), (input_path, bh), (final, ah)):
        require(v.digest(Path(path).read_bytes()) == expected, 'form_label_input_changed_during_check')
    unrelated_alts = [tag['id'] for tag in forms[0][2] if 'alt' in tag and tag['role'] not in ('Figure', 'Form')]
    return {'passed': True, 'checksComplete': True, 'sourceSha256': sh, 'inputSha256': bh, 'outputSha256': ah,
            'changeCount': len(changes), 'widgetCount': len(fields[0]), 'originalBehaviorPreserved': True,
            'pixelsIdentical': True, 'sourceLabelsIndependentlyMatched': True, 'nativeChangesExactlyMatched': True,
            'initializedFormAppearancePixelsIdentical': True, 'renderedPagesWithForms': form_pixels[2],
            'widgetEvidence': saved_widget_evidence,
            'reviewItems': reviews, 'unverifiedNonFormAlternativeTagIds': unrelated_alts,
            'preservedContent': preserved, 'certification': False}


def compare_with_authorized_form_labels(original: Path, final: Path, ledger: dict):
    report = v.compare_pdfs(Path(original), Path(final))
    evidence = {'passed': False, 'checksComplete': False, 'findings': [], 'certification': False}
    report['form_label_validation'] = evidence
    try:
        require(not report.get('inspection_incomplete'), 'form_label_strict_inspection_incomplete')
        evidence.update(authorize_form_labels(Path(original), Path(final), ledger))
        # A source placeholder may be replaced, but no genuine authored string
        # or unlisted description receives an exception. The authorization above
        # proves the exact source owner and input/output native graph first.
        removable = {'authored_alternative_lost_or_changed', 'authored_annotation_descriptions_retained'}
        explained = [f for f in report['findings'] if f['code'] in removable]
        if explained:
            source, _ = _snapshot(original); after, _ = _snapshot(final)
            source_fields, after_fields = _owners(source), _owners(after)
            sf, so, _ = _native_forms(source, required=False)
            af, ao, _ = _native_forms(after, required=True)
            for key, (_, widget) in source_fields.items():
                original_label = _text(widget.get('/Contents'))
                require(not _meaningful(original_label) or _text(after_fields[key][1].get('/Contents')) == original_label,
                        'form_label_original_contents_lost')
                if key in so and _meaningful(sf[so[key]]['alt']):
                    require(af[ao[key]]['alt'] == sf[so[key]]['alt'], 'form_label_original_alt_lost')
            for left, right in zip(source.pages, after.pages):
                for old, new in zip(v.resolved(left.get('/Annots', [])), v.resolved(right.get('/Annots', []))):
                    old, new = v.resolved(old), v.resolved(new)
                    require(old.get('/Subtype') == '/Widget' or old.get('/Contents') == new.get('/Contents'),
                            'form_label_unrelated_annotation_description_changed')
            require(not evidence['unverifiedNonFormAlternativeTagIds'], 'form_label_unrelated_alt_loss_unverified')
        report['findings'] = [f for f in report['findings'] if f not in explained]
        evidence['strictFindingsExplainedByAuthoredLabels'] = explained
        for review in evidence['reviewItems']:
            report['findings'].append({'severity': 'error', 'code': review['code'],
                                      'page': review['pageNumber'],
                                      'message': 'The saved form label remains unresolved and needs a source-grounded review.'})
        report['structure']['authored_alternative_associations_verified'] = (
            report['figure_associations']['passed'] and not evidence['unverifiedNonFormAlternativeTagIds'])
        report['preservation']['authorized_form_labels_verified'] = True
        report['preservation']['passed'] = not report['findings']
        report['mechanical_checks_passed'] = report['preservation']['passed'] and report['structure'].get('passed', False)
        report['passed'] = (report['mechanical_checks_passed'] and report['structure'].get('checks_complete', False)
                            and not report['structure'].get('findings')
                            and report['structure']['authored_alternative_associations_verified'] and not evidence['reviewItems'])
    except Exception as error:
        evidence.update({'passed': False, 'checksComplete': False})
        evidence['findings'].append({'code': str(error) if isinstance(error, v.InspectionError) else 'form_label_validation_failed', 'severity': 'error'})
        report['passed'] = report['mechanical_checks_passed'] = report['preservation']['passed'] = False
    return report
