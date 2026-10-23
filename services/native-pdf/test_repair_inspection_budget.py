"""Bound repeated repair inspections to unchanged source and saved-output bytes."""
from collections import Counter
import io
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from pypdf import PdfReader, PdfWriter
from pypdf.generic import NameObject, TextStringObject

import bounded_semantic_structure as structure
import native_structure_repairs as ids
import worker
from test_native_pdf_validation import pdf_bytes


VALIDATION = {'completed': True, 'compliant': False, 'failedRules': 1, 'failedChecks': 1,
              'rules': [{'clause': '7.21.4', 'testNumber': 1, 'failedChecks': 1,
                         'description': 'Missing embedded font'}]}


def reader_bytes(reader):
    position = reader.stream.tell()
    try:
        reader.stream.seek(0)
        return reader.stream.read()
    finally:
        reader.stream.seek(position)


class RepairInspectionBudgetTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.folder = Path(self.temporary.name)
        self.source_path = self.folder / 'source.pdf'
        self.output_path = self.folder / 'output.pdf'
        self.source_bytes = pdf_bytes(tagged=False)
        self.candidate_bytes = pdf_bytes(tagged=True)
        self.source_path.write_bytes(self.source_bytes)
        self.original = worker.open_pdf(self.source_bytes)
        self.candidate = worker.open_pdf(self.candidate_bytes)
        self.plan = {'schemaVersion': 1, 'candidateSha256': worker.digest(self.candidate_bytes),
                     'operations': []}
        self.capture = worker._SavedOutputCapture()

    def apply(self):
        return worker.apply_plan(self.original, self.candidate, self.plan, self.output_path,
                                 _saved_output=self.capture)

    def response(self):
        return worker.response(self.source_path, self.output_path, [], {},
                               _saved_output=self.capture.inspection)

    def test_repair_scans_candidate_and_saved_output_once_each(self):
        scans = Counter()
        real_scan = worker.verify_pdf.structure_inventory
        def scan(reader):
            scans[worker.digest(reader_bytes(reader))] += 1
            return real_scan(reader)
        with patch.object(worker.verify_pdf, 'structure_inventory', side_effect=scan), \
             patch.object(ids, 'structure_inventory', side_effect=scan), \
             patch.object(worker, 'validate_ua', return_value=VALIDATION) as validate, \
             patch.object(worker.verify_pdf, 'compare_pdfs', wraps=worker.verify_pdf.compare_pdfs) as compare:
            self.apply()
            result = self.response()
        self.assertEqual(scans[worker.digest(self.candidate_bytes)], 1)
        # Fresh saved-byte evidence is shared with the independent comparison;
        # its painting/resources/association/render checks still run in full.
        self.assertEqual(scans[worker.digest(self.output_path.read_bytes())], 1)
        compare.assert_called_once_with(self.source_path, self.output_path,
            _output_inspection=self.capture.inspection.saved_pdf_for(self.output_path.read_bytes()))
        validate.assert_called_once()
        self.assertTrue(result['machineChecks']['preservationPassed'])
        self.assertFalse(result['machineChecks']['conformanceClaim'])

    def test_saved_bundle_matches_fresh_response_and_does_not_share_mutable_inventory(self):
        self.apply()
        copied = self.capture.inspection.copy_for(self.source_bytes, self.output_path.read_bytes())
        copied['tags'].clear()
        with patch.object(worker, 'validate_ua', return_value=VALIDATION):
            reused = self.response()
            fresh = worker.response(self.source_path, self.output_path, [], {})
        self.assertEqual(reused, fresh)
        self.assertTrue(reused['inventory']['tags'])

    def test_changed_output_after_capture_is_rejected_before_comparison(self):
        self.apply()
        self.output_path.write_bytes(self.output_path.read_bytes() + b'\n')
        with patch.object(worker.verify_pdf, 'compare_pdfs') as compare:
            with self.assertRaises(worker.WorkerError) as caught:
                self.response()
        self.assertEqual(str(caught.exception), 'native_pdf_preservation')
        compare.assert_not_called()

    def test_changed_output_during_validation_is_not_returned(self):
        self.apply()
        def validate(path, _tools):
            path.write_bytes(path.read_bytes() + b'\n')
            return VALIDATION
        with patch.object(worker, 'validate_ua', side_effect=validate):
            with self.assertRaises(worker.WorkerError) as caught:
                self.response()
        self.assertEqual(str(caught.exception), 'native_pdf_preservation')

    def test_independent_preservation_failure_cannot_be_waived_by_saved_bundle(self):
        self.apply()
        with patch.object(worker.verify_pdf, 'compare_pdfs', return_value={
                'preservation': {'passed': False}, 'findings': [{'code': 'page_pixels_changed'}]}) as compare:
            with self.assertRaises(worker.WorkerError) as caught:
                self.response()
        self.assertEqual(str(caught.exception), 'native_pdf_preservation')
        compare.assert_called_once_with(self.source_path, self.output_path,
            _output_inspection=self.capture.inspection.saved_pdf_for(self.output_path.read_bytes()))

    def test_changed_source_context_requires_fresh_enrichment(self):
        self.apply()
        # Exact source bytes matter even when the PDF itself remains unchanged.
        # This also exercises the fallback used for verified hybrid preparation.
        self.source_path.write_bytes(self.source_bytes + b'\n')
        with patch.object(worker, 'enrich_inventory', wraps=worker.enrich_inventory) as enrich, \
             patch.object(worker, 'validate_ua', return_value=VALIDATION):
            result = self.response()
        enrich.assert_called_once()
        self.assertTrue(result['machineChecks']['preservationPassed'])

    def test_raw_response_bundle_cannot_supply_passed_inventory(self):
        self.apply()
        with self.assertRaises(worker.WorkerError) as caught:
            worker.response(self.source_path, self.output_path, [], {},
                            _saved_output={'inventory': {'checks_complete': True}})
        self.assertEqual(str(caught.exception), 'native_pdf_preservation')
        with self.assertRaises(worker.WorkerError):
            worker._SavedOutputInspection(self.original, self.candidate, {'tags': []})

    def test_authored_id_check_rejects_wrong_reader_and_raw_inventory(self):
        inspection = structure._DiscoveryInspection(self.candidate)
        other = PdfReader(io.BytesIO(self.candidate_bytes))
        for value, candidate in ((inspection, other), (inspection.copy_for(self.candidate), self.candidate)):
            with self.subTest(candidate=candidate), self.assertRaises(ids.NoteIdError):
                ids.verify_authored_ids(self.original, candidate, _candidate_inspection=value)

    def test_untagged_source_does_not_skip_invalid_candidate_id_tree(self):
        writer = PdfWriter(clone_from=self.candidate)
        worker.native_nodes(writer)[1][NameObject('/ID')] = TextStringObject('unindexed-authored-id')
        output = io.BytesIO()
        writer.write(output)
        candidate = PdfReader(io.BytesIO(output.getvalue()))
        inspection = structure._DiscoveryInspection(candidate)
        self.assertFalse(inspection.copy_for(candidate)['native_id_tree']['verified'])
        with self.assertRaises(ids.NoteIdError):
            ids.verify_authored_ids(self.original, candidate, _candidate_inspection=inspection)

    def test_candidate_scan_failure_retains_preservation_diagnostic(self):
        for error in (worker.verify_pdf.InspectionError, KeyError, IndexError, AttributeError, TypeError):
            with self.subTest(error=error), patch.object(worker.verify_pdf, 'structure_inventory',
                                                       side_effect=error('private parser details')):
                with self.assertRaises(worker.WorkerError) as caught:
                    self.apply()
            self.assertEqual(str(caught.exception), 'native_pdf_preservation')
            self.assertIsNone(self.capture.inspection)

    def test_reopened_scan_failure_retains_preservation_diagnostic(self):
        real_scan = worker.verify_pdf.structure_inventory
        for error in (worker.verify_pdf.InspectionError, KeyError, IndexError, AttributeError, TypeError):
            self.output_path = self.folder / (error.__name__ + '.pdf')
            def scan(reader):
                if reader is not self.original and reader is not self.candidate:
                    raise error('private parser details')
                return real_scan(reader)
            with self.subTest(error=error), patch.object(worker.verify_pdf, 'structure_inventory', side_effect=scan):
                with self.assertRaises(worker.WorkerError) as caught:
                    self.apply()
            self.assertEqual(str(caught.exception), 'native_pdf_preservation')
            self.assertIsNone(self.capture.inspection)

    def test_enrichment_rejects_wrong_reader_and_raw_inventory(self):
        inspection = structure._DiscoveryInspection(self.candidate)
        other = PdfReader(io.BytesIO(self.candidate_bytes))
        for value, candidate in ((inspection, other), (inspection.copy_for(self.candidate), self.candidate)):
            with self.subTest(candidate=candidate), self.assertRaises(worker.WorkerError) as caught:
                worker.enrich_inventory(candidate, self.original, _inspection=value)
            self.assertEqual(str(caught.exception), 'native_pdf_preservation')

    def test_no_source_links_or_explicit_empty_targets_do_not_scan_candidate(self):
        with patch.object(worker, 'native_link_descriptions', return_value={}) as descriptions:
            self.assertEqual(worker.add_link_descriptions(self.original, self.candidate, None), [])
        descriptions.assert_called_once_with(self.original)
        with patch.object(worker.verify_pdf, 'structure_inventory', side_effect=AssertionError('unneeded scan')):
            self.assertEqual(worker.native_link_descriptions(self.candidate, targets={}), {})

    def test_invalid_plan_never_publishes_saved_inspection(self):
        self.plan['operations'] = [{'type': 'set_role', 'tagId': 'tag-2', 'role': 'H2', 'expected': {}}]
        with self.assertRaises(worker.WorkerError):
            self.apply()
        self.assertIsNone(self.capture.inspection)
        self.assertFalse(self.output_path.exists())


if __name__ == '__main__':
    unittest.main()
