"""Explicit, source-pinned repair of four verified CDC TOC destinations.

The standalone verifier remains strict by default. This opt-in ledger permits
only the exact thirteen broken named GoTo actions in the inspected CDC source,
with independently pinned replacements on the publisher's site. It never treats
an arbitrary URL supplied in a manifest as permission to change navigation.
"""
from __future__ import annotations

import argparse
import copy
import io
import json
import logging
from pathlib import Path

from pypdf import PdfReader
from pypdf.generic import DictionaryObject, NameObject, TextStringObject
from conformance_repairs import _open, _save
from pdf_safety import reject_signed_pdf
from semantic_repairs import _tag_nodes
import verify_pdf as v

POLICY_SOURCE_SHA256 = 'a399c70cb22e7a0c07ad0c8cbeef33e49894a2de133d997b1fb57faabf4b61d8'
GROUPS = [
    (range(1, 4), 'mm7309-H.indd:.10807:36427', 'https://www.cdc.gov/mmwr/volumes/73/wr/mm7309a2.htm', 'Years of Potential Life Lost and Mean Age of Adults Experiencing Nontraumatic, Out-of-Hospital Cardiac Arrests — Chicago, 2014–2021', '199–203'),
    (range(4, 8), 'mm7309-H.indd:.10811:36428', 'https://www.cdc.gov/mmwr/volumes/73/wr/mm7309a3.htm', 'Racial and Ethnic Differences in Social Determinants of Health and Health-Related Social Needs Among Adults — Behavioral Risk Factor Surveillance System, United States, 2022', '204–208'),
    (range(8, 13), 'mm7309-H.indd:.10815:36429', 'https://www.cdc.gov/mmwr/volumes/73/wr/mm7309a4.htm', 'Early Estimate of Nirsevimab Effectiveness for Prevention of Respiratory Syncytial Virus–Associated Hospitalization Among Infants Entering Their First Respiratory Syncytial Virus Season — New Vaccine Surveillance Network, October 2023–February 2024', '209–214'),
    (range(13, 14), 'mm7309-H.indd:.10819:36430', 'https://www.cdc.gov/mmwr/volumes/73/wr/mm7309a5.htm', 'Notes from the Field: Emergency Department Visits for Unsupervised Pediatric Melatonin Ingestion — United States, 2019–2022', '215–217'),
]
POLICY_ROWS = {index: {'oldDestination': destination, 'uri': uri, 'title': title,
                     'printedPages': pages, 'publicationDate': '2024-03-07',
                     'publisherEvidenceUrl': uri, 'verifiedOn': '2026-10-21'}
               for indexes, destination, uri, title, pages in GROUPS for index in indexes}
MAX_MANIFEST_BYTES = 128_000


def require(condition, code):
    if not condition:
        raise v.InspectionError(code)


def _snapshot(path):
    require(path.is_file() and path.stat().st_size <= v.MAX_FILE_BYTES, 'navigation_file_limit')
    data = path.read_bytes()
    require(len(data) <= v.MAX_FILE_BYTES, 'navigation_file_limit')
    reader = PdfReader(io.BytesIO(data), strict=True)
    require(not reader.is_encrypted and 1 <= len(reader.pages) <= v.MAX_PAGES, 'navigation_unsupported_pdf')
    reject_signed_pdf(reader)
    return reader, v.digest(data)


def _annotation(reader, index):
    annotations = v.resolved(reader.pages[0].get('/Annots', []))
    require(isinstance(annotations, list) and 1 <= index <= len(annotations), 'navigation_annotation_missing')
    annotation = v.resolved(annotations[index - 1])
    require(isinstance(annotation, dict) and annotation.get('/Subtype') == '/Link'
            and '/Dest' not in annotation and '/AA' not in annotation,
            'navigation_link_shape_unsupported')
    return annotation


def _static_hash(reader, annotation):
    # List pairs avoid Canonicalizer's annotation-label allowance: this ledger
    # also binds the candidate's generated description and every rectangle.
    values = [(str(key), value) for key, value in sorted(annotation.items()) if key not in {'/A', '/StructParent'}]
    return v.Canonicalizer(list(reader.pages)).hash(values)


def _old_action(annotation, policy):
    action = v.resolved(annotation.get('/A'))
    require(isinstance(action, dict) and set(action) == {'/S', '/D'}
            and action.get('/S') == '/GoTo' and isinstance(action.get('/D'), TextStringObject)
            and action['/D'] == policy['oldDestination'], 'navigation_original_action_mismatch')
    return action


def _new_action(policy):
    return DictionaryObject({NameObject('/S'): NameObject('/URI'), NameObject('/URI'): TextStringObject(policy['uri'])})


def _fourth_link_context(reader, policy, *, require_order=True):
    inventory = v.structure_inventory(reader)
    tags = {tag['id']: tag for tag in inventory['tags']}
    links = [tag for tag in tags.values() if tag['role'] == 'Link' and any(
        ref.get('kind') == 'objectReference' and ref.get('pageNumber') == 1
        and ref.get('annotationIndex') == 13 and ref.get('resolved') is True
        for ref in tag['contentSequence'])]
    require(len(links) == 1, 'navigation_fourth_link_owner_ambiguous')
    link = links[0]; parent = link
    for _ in range(8):
        if parent['role'] == 'TOCI': break
        parent = tags.get(parent['parentId'], {})
        require(bool(parent), 'navigation_fourth_title_context_missing')
    require(parent['role'] == 'TOCI', 'navigation_fourth_title_context_missing')
    def text(tag, depth=0):
        require(depth <= 8 and not tag.get('textIncomplete'), 'navigation_title_text_incomplete')
        parts = []
        for ref in tag['contentSequence']:
            require(ref.get('resolved') is True, 'navigation_title_content_unresolved')
            if ref['kind'] == 'childTag': parts.append(text(tags[ref['tagId']], depth + 1))
            elif ref['kind'] == 'markedContent': parts.append(ref.get('text', ''))
        return ''.join(parts)
    compact = lambda value: ''.join(value.split())
    title = compact(text(parent))
    prefix = '215NotesfromtheField:'
    expected = compact('215 ' + policy['title'])
    # The original TOC inserts this one prefix midway through its own title.
    # The independently reviewed reading-order repair puts it first. Both
    # contexts must contain the same exact body, with the prefix exactly once.
    source_match = title.count(prefix) == 1 and title.replace(prefix, '', 1) == expected.removeprefix(prefix)
    require(title == expected if require_order else source_match, 'navigation_verified_title_not_in_source_context')
    require(compact(link['text']) == '215NotesfromtheField:', 'navigation_fourth_visible_label_changed')
    return link


def repair_verified_navigation(original: Path, candidate: Path, output: Path) -> dict:
    """Write only the pinned actions; return the final-hash-bound manifest."""
    source, source_hash = _snapshot(original)
    require(source_hash == POLICY_SOURCE_SHA256, 'navigation_source_not_authorized')
    reader, writer = _open(candidate, output)
    require(len(reader.pages) == len(source.pages), 'navigation_page_count_changed')
    changes = []
    for index, policy in sorted(POLICY_ROWS.items()):
        old = _old_action(_annotation(source, index), policy)
        before = _annotation(reader, index)
        current = _old_action(before, policy)
        require(v.Canonicalizer().hash(current) == v.Canonicalizer().hash(old), 'navigation_candidate_action_changed')
        # This writer cannot introduce an action through a shared action object.
        # It replaces only the selected annotation's own /A dictionary.
        saved = _annotation(writer, index)
        saved[NameObject('/A')] = _new_action(policy)
        generated_label = None
        if index == 13:
            source_link = _fourth_link_context(source, policy, require_order=False)
            candidate_link = _fourth_link_context(reader, policy)
            require(source_link.get('alt') is None and source_link.get('actualText') is None,
                    'navigation_authored_link_description_requires_review')
            require(candidate_link.get('alt') in (None, '215 Notes from the Field:')
                    and candidate_link.get('actualText') is None, 'navigation_existing_link_label_requires_review')
            _tag_nodes(writer)[int(candidate_link['id'][4:]) - 1][NameObject('/Alt')] = TextStringObject(policy['title'])
            generated_label = policy['title']
        changes.append({'pageNumber': 1, 'annotationIndex': index,
                        'originalActionSha256': v.Canonicalizer().hash(old),
                        'unchangedAnnotationSha256': _static_hash(reader, before),
                        'generatedLinkLabel': generated_label,
                        **policy})
    output_hash = _save(writer, output)
    manifest = {'schemaVersion': 1, 'sourceSha256': source_hash,
                'inputSha256': v.digest(reader.stream.getvalue()), 'candidateSha256': output_hash,
                'authorization': {'verifiedCdcTocDestinations': True}, 'changes': changes}
    authorize_navigation(original, output, manifest)
    return manifest


def authorize_navigation(original: Path, final: Path, manifest: dict):
    """Return source, normalized final reader, ledger after independent checks.

    The returned final reader has only authorized /A dictionaries restored in
    memory, so a composing appendix validator can still perform strict checks
    on every original page. The saved PDF is never changed by this function.
    """
    source, source_hash = _snapshot(original)
    after, final_hash = _snapshot(final)
    require(isinstance(manifest, dict) and set(manifest) == {'schemaVersion', 'sourceSha256', 'inputSha256', 'candidateSha256', 'authorization', 'changes'}
            and manifest.get('schemaVersion') == 1, 'navigation_manifest_invalid')
    require(source_hash == POLICY_SOURCE_SHA256 == manifest.get('sourceSha256')
            and final_hash == manifest.get('candidateSha256'), 'navigation_manifest_file_binding_mismatch')
    require(isinstance(manifest.get('inputSha256'), str) and len(manifest['inputSha256']) == 64
            and all(char in '0123456789abcdef' for char in manifest['inputSha256']), 'navigation_input_hash_invalid')
    require(manifest.get('authorization') == {'verifiedCdcTocDestinations': True}, 'navigation_explicit_authorization_required')
    changes = manifest.get('changes')
    require(isinstance(changes, list) and len(changes) == len(POLICY_ROWS), 'navigation_exact_change_set_required')
    require(len(after.pages) >= len(source.pages), 'navigation_original_pages_missing')
    by_index = {}
    for entry in changes:
        require(isinstance(entry, dict) and set(entry) == {'pageNumber', 'annotationIndex', 'originalActionSha256', 'unchangedAnnotationSha256', 'generatedLinkLabel', 'oldDestination', 'uri', 'title', 'printedPages', 'publicationDate', 'publisherEvidenceUrl', 'verifiedOn'}, 'navigation_entry_invalid')
        index = entry.get('annotationIndex')
        require(type(index) is int and index in POLICY_ROWS and index not in by_index
                and entry.get('pageNumber') == 1, 'navigation_unlisted_or_repeated_annotation')
        by_index[index] = entry
    require(set(by_index) == set(POLICY_ROWS), 'navigation_exact_change_set_required')
    verified = []
    for index, policy in sorted(POLICY_ROWS.items()):
        entry = by_index[index]
        require(all(entry.get(key) == value for key, value in policy.items()), 'navigation_target_or_evidence_not_authorized')
        old_annotation = _annotation(source, index)
        old = _old_action(old_annotation, policy)
        current = _annotation(after, index)
        require(entry['originalActionSha256'] == v.Canonicalizer().hash(old), 'navigation_original_action_hash_mismatch')
        require(entry['unchangedAnnotationSha256'] == _static_hash(after, current), 'navigation_other_annotation_fields_changed')
        actual_action = v.resolved(current.get('/A'))
        require(isinstance(actual_action, dict) and set(actual_action) == {'/S', '/URI'}
                and actual_action.get('/S') == '/URI' and actual_action.get('/URI') == policy['uri'], 'navigation_saved_action_not_authorized')
        require(entry['generatedLinkLabel'] == (policy['title'] if index == 13 else None), 'navigation_generated_label_not_authorized')
        if index == 13:
            original_link = _fourth_link_context(source, policy, require_order=False)
            final_link = _fourth_link_context(after, policy)
            require(original_link.get('alt') is None and original_link.get('actualText') is None
                    and final_link.get('alt') == policy['title'] and final_link.get('actualText') is None,
                    'navigation_generated_link_label_unverified')
        current[NameObject('/A')] = copy.deepcopy(old)
        verified.append({'pageNumber': 1, 'annotationIndex': index, 'uri': policy['uri'],
                         'publisherEvidenceUrl': policy['publisherEvidenceUrl'],
                         'generatedLinkLabel': entry['generatedLinkLabel'],
                         'sourceIdentityVerified': True, 'otherAnnotationFieldsUnchanged': True})
    require(v.digest(original.read_bytes()) == source_hash and v.digest(final.read_bytes()) == final_hash, 'navigation_input_changed_during_validation')
    return source, after, verified


def compare_with_authorized_navigation(original: Path, final: Path, manifest: dict) -> dict:
    report = v.compare_pdfs(original, final)
    evidence = {'passed': False, 'checksComplete': False, 'optIn': True, 'findings': []}
    report['navigation_validation'] = evidence
    try:
        require(not report.get('inspection_incomplete'), 'navigation_strict_inspection_incomplete')
        before, normalized, ledger = authorize_navigation(original, final, manifest)
        require(len(before.pages) == len(normalized.pages), 'navigation_standalone_page_count_changed')
        # Independently recheck all remaining fonts, resources, drawing, forms,
        # page geometry, catalog actions and authored Figure associations.
        from font_validation import verify_other_content
        unchanged = verify_other_content(before, normalized)
        require(all(page.get('pixels_identical') and page.get('extracted_text_identical') for page in report['preservation']['pages']), 'navigation_content_or_pixels_changed')
        allowed, retained = [], []
        for finding in report['findings']:
            (allowed if finding['code'] == 'page_properties_changed' and finding.get('page') == 1 else retained).append(finding)
        report['findings'] = retained
        evidence.update({'passed': True, 'checksComplete': True, 'changes': ledger,
                         'sourceSha256': manifest['sourceSha256'], 'candidateSha256': manifest['candidateSha256'],
                         'allOtherContentVerified': unchanged, 'strictFindingsExplainedByNavigation': allowed})
        report['preservation']['authorized_navigation_changes_verified'] = True
        report['preservation']['passed'] = not retained
        report['mechanical_checks_passed'] = not retained and report['structure'].get('passed', False)
        report['passed'] = report['mechanical_checks_passed'] and report['structure'].get('checks_complete', False) and not report['structure'].get('findings') and report['structure'].get('authored_alternative_associations_verified', False)
    except Exception as error:
        evidence['findings'].append({'code': str(error) if isinstance(error, v.InspectionError) else 'navigation_validation_failed', 'severity': 'error'})
        report['passed'] = report['mechanical_checks_passed'] = report['preservation']['passed'] = False
    return report


def revalidate_navigation_manifest(original: Path, prior_candidate: Path,
                                   current_candidate: Path, manifest: dict) -> dict:
    """Reverify the fixed actions after later, independently reviewed repairs.

    The old candidate and manifest remain immutable. Only the candidate hash in
    a copied authorization changes; the original input provenance, policy and
    annotation fingerprints are retained. This never rebinds an audit report.
    """
    # First prove that the supplied authorization actually describes the old
    # saved file. A caller cannot manufacture new annotation fingerprints while
    # pretending they originated in the earlier navigation stage.
    authorize_navigation(original, prior_candidate, manifest)
    _, current_hash = _snapshot(current_candidate)
    rebound = copy.deepcopy(manifest)
    rebound['candidateSha256'] = current_hash
    report = compare_with_authorized_navigation(original, current_candidate, rebound)
    require(report['navigation_validation']['passed']
            and report['navigation_validation']['checksComplete']
            and report['preservation']['passed']
            and not report.get('inspection_incomplete'),
            'navigation_revalidation_preservation_failed')
    # Verification reads bounded snapshots internally; refuse a file replaced
    # while those checks were running rather than returning a stale ledger.
    for path, expected in ((original, manifest['sourceSha256']),
                           (prior_candidate, manifest['candidateSha256']),
                           (current_candidate, current_hash)):
        _, actual = _snapshot(path)
        require(actual == expected, 'navigation_revalidation_input_changed')
    lineage = {
        'schemaVersion': 1,
        'sourceSha256': manifest['sourceSha256'],
        'originalNavigationInputSha256': manifest['inputSha256'],
        'priorCandidateSha256': manifest['candidateSha256'],
        'currentCandidateSha256': current_hash,
        'priorManifestSha256': v.digest(json.dumps(manifest, sort_keys=True,
            ensure_ascii=True, separators=(',', ':')).encode('utf-8')),
        'policyAndAnnotationFingerprintsUnchanged': True,
        'strictOriginalPreservationVerified': True,
        'freshSemanticAuditRequired': True,
    }
    return {'manifest': rebound, 'lineage': lineage, 'verification': report}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=['repair', 'verify'])
    parser.add_argument('original', type=Path); parser.add_argument('candidate', type=Path)
    parser.add_argument('--output', type=Path); parser.add_argument('--manifest', type=Path, required=True)
    parser.add_argument('--report', type=Path)
    args = parser.parse_args()
    logging.getLogger('pypdf').setLevel(logging.CRITICAL)
    if args.mode == 'repair':
        require(args.output is not None and not args.manifest.exists(), 'new_navigation_output_required')
        result = repair_verified_navigation(args.original, args.candidate, args.output)
        args.manifest.write_text(json.dumps(result, indent=2), encoding='utf-8')
        print(json.dumps({'actionsRepaired': len(result['changes'])}))
    else:
        require(args.report is not None and args.manifest.is_file() and args.manifest.stat().st_size <= MAX_MANIFEST_BYTES, 'navigation_manifest_or_report_invalid')
        result = compare_with_authorized_navigation(args.original, args.candidate, json.loads(args.manifest.read_text(encoding='utf-8')))
        args.report.write_text(json.dumps(result, indent=2), encoding='utf-8')
        print(json.dumps({'passed': result['passed'], 'navigationPassed': result['navigation_validation']['passed']}))
        raise SystemExit(0 if result['passed'] else 1)
