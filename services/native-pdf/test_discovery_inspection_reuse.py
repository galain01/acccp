"""Reuse one trusted scan without reusing mutable or caller-authored evidence."""
import io
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from pypdf import PdfReader, PdfWriter
from pypdf.generic import NameObject

import bounded_semantic_structure as structure
import worker
from test_bounded_semantic_structure import fixture, saved, selection


class DiscoveryInspectionReuseTests(unittest.TestCase):
    def source(self):
        writer, _ = fixture()
        # The structure fixture also carries intentionally incomplete XFA used
        # by its separate preservation tests; this suite exercises plain forms.
        writer.root_object['/AcroForm'].pop('/XFA', None)
        return PdfReader(io.BytesIO(saved(writer)))

    def test_enrichment_reuses_current_scan_and_keeps_discovery_identical(self):
        reader = self.source()
        expected = structure.discover_candidates(reader)
        raw = worker.verify_pdf.structure_inventory(reader)
        with patch.object(worker.verify_pdf, 'structure_inventory',
                          wraps=worker.verify_pdf.structure_inventory) as scan:
            enriched = worker.enrich_inventory(reader, reader)
        self.assertEqual(enriched['structureCandidates'], expected)
        # One current-PDF scan plus the existing independent original-PDF scan.
        # Candidate discovery must not perform a third whole-PDF extraction.
        self.assertEqual(scan.call_count, 2)
        self.assertTrue(all(call.args == (reader,) for call in scan.call_args_list))
        self.assertTrue(all('editable' in tag for tag in enriched['tags']))
        self.assertTrue(all('editable' not in tag for tag in raw['tags']))

    def test_enrichment_copies_cannot_mutate_raw_discovery_evidence(self):
        reader = self.source()
        inspection = structure._DiscoveryInspection(reader)
        expected = structure.discover_candidates(reader)
        copy = inspection.copy_for(reader)
        copy['tags'].clear()
        copy['findings'].append({'code': 'invented_caller_finding'})
        with patch.object(worker.verify_pdf, 'structure_inventory',
                          side_effect=AssertionError('unexpected rescan')):
            actual = structure.discover_candidates(reader, _inspection=inspection)
        self.assertEqual(actual, expected)
        self.assertTrue(inspection.copy_for(reader)['tags'])
        self.assertFalse(any(item['code'] == 'invented_caller_finding'
                             for item in inspection.copy_for(reader)['findings']))

    def test_reopened_saved_output_gets_new_inspection(self):
        original = self.source()
        old = worker.enrich_inventory(original, original)
        heading = next(item for item in old['structureCandidates']
                       if item['kind'] == 'split_heading')
        writer = PdfWriter(clone_from=original)
        structure.nodes(writer)[int(heading['tagId'][4:]) - 1][NameObject('/S')] = NameObject('/H3')
        reopened = PdfReader(io.BytesIO(saved(writer)))
        with patch.object(worker.verify_pdf, 'structure_inventory',
                          wraps=worker.verify_pdf.structure_inventory) as scan:
            current = worker.enrich_inventory(reopened, original)
        self.assertEqual([call.args[0] for call in scan.call_args_list], [reopened, original])
        self.assertEqual(current['structureCandidates'], structure.discover_candidates(reopened))
        self.assertFalse(any(item['kind'] == 'split_heading' for item in current['structureCandidates']))
        self.assertEqual(next(tag for tag in current['tags'] if tag['id'] == heading['tagId'])['role'], 'H3')
        self.assertEqual(next(tag for tag in old['tags'] if tag['id'] == heading['tagId'])['role'], 'P')

    def test_evidence_cannot_be_a_raw_inventory_writer_or_other_reader(self):
        reader = self.source()
        inspection = structure._DiscoveryInspection(reader)
        with self.assertRaises(structure.SemanticStructureError):
            structure.discover_candidates(reader, _inspection=inspection.copy_for(reader))
        with self.assertRaises(structure.SemanticStructureError):
            structure.discover_candidates(self.source(), _inspection=inspection)
        with self.assertRaises(structure.SemanticStructureError):
            structure._DiscoveryInspection(PdfWriter(clone_from=reader))

    def test_plan_application_always_rediscovers_from_current_source(self):
        reader = self.source()
        inspection = structure._DiscoveryInspection(reader)
        operations = selection(structure.discover_candidates(reader, _inspection=inspection), 'split_heading')
        writer = PdfWriter(clone_from=reader)
        with patch.object(worker.verify_pdf, 'structure_inventory',
                          wraps=worker.verify_pdf.structure_inventory) as scan:
            result = structure.apply_operations(reader, writer, operations)
        scan.assert_called_once_with(reader)
        self.assertEqual([item['code'] for item in result['changes']], ['split_heading'])

    def test_request_plan_cannot_supply_inspection_evidence(self):
        reader = self.source()
        plan = {'schemaVersion': 1, 'candidateSha256': worker.digest(reader.stream.getvalue()),
                'operations': [], '_inspection': {'tags': []}}
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / 'output.pdf'
            with self.assertRaises(worker.WorkerError) as caught:
                worker.apply_plan(reader, reader, plan, output)
            self.assertEqual(str(caught.exception), 'native_pdf_invalid_plan')
            self.assertFalse(output.exists())


if __name__ == '__main__':
    unittest.main()
