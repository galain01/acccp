"""Immutable source inspection reuse must stay private, bound and exact."""
import base64
from collections import Counter
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

from pypdf import PdfReader

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "research/native-pdf"))
import bounded_semantic_structure as semantic
import native_structure_repairs as ids
import worker
from test_native_pdf_validation import pdf_bytes
from test_hybrid_worker import build_fixture
from test_repair_inspection_budget import VALIDATION


v = worker.verify_pdf


class OriginalInspectionReuseTests(unittest.TestCase):
    def readers(self):
        data = pdf_bytes(tagged=True)
        original, inspection = semantic._DiscoveryInspection._from_saved_pdf(v._PdfInspection(data))
        candidate = PdfReader(io.BytesIO(data), strict=True)
        return original, candidate, inspection

    def plan(self, candidate):
        return {"schemaVersion": 1, "candidateSha256": worker.digest(candidate.stream.getvalue()), "operations": []}

    def test_authored_ids_and_enrichment_reuse_exact_original_evidence(self):
        original, candidate, evidence = self.readers()
        expected = worker.enrich_inventory(candidate, original)
        candidate_evidence = semantic._DiscoveryInspection(candidate)
        with patch.object(v, "structure_inventory", side_effect=AssertionError("unexpected rescan")), \
             patch.object(ids, "structure_inventory", side_effect=AssertionError("unexpected rescan")):
            ids.verify_authored_ids(original, candidate, _original_inspection=evidence,
                                    _candidate_inspection=candidate_evidence)
            actual = worker.enrich_inventory(candidate, original, _original_inspection=evidence,
                                             _inspection=candidate_evidence)
        self.assertEqual(actual, expected)

    def test_raw_dict_subclass_or_other_reader_cannot_supply_original_evidence(self):
        class Fake(semantic._DiscoveryInspection):
            pass
        original, candidate, evidence = self.readers()
        values = (evidence.copy_for(original), Fake(original), semantic._DiscoveryInspection(candidate))
        for value in values:
            with self.subTest(value=type(value).__name__):
                with self.assertRaises(ids.NoteIdError):
                    ids.verify_authored_ids(original, candidate, _original_inspection=value)
                with self.assertRaises(worker.WorkerError):
                    worker.enrich_inventory(candidate, original, _original_inspection=value)

    def test_changed_original_bytes_cannot_reuse_old_evidence(self):
        original, candidate, evidence = self.readers()
        data = original.stream.getvalue()
        changed = data.replace(b"%PDF-1.3", b"%PDF-1.4", 1)
        self.assertNotEqual(changed, data)
        original.stream.seek(0)
        original.stream.write(changed)
        with self.assertRaises(ids.NoteIdError):
            ids.verify_authored_ids(original, candidate, _original_inspection=evidence)
        with self.assertRaises(worker.WorkerError):
            worker.enrich_inventory(candidate, original, _original_inspection=evidence)

    def test_plan_rejects_nonprivate_original_evidence_without_writing(self):
        original, candidate, evidence = self.readers()
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "output.pdf"
            with self.assertRaises(worker.WorkerError):
                worker.apply_plan(original, candidate, self.plan(candidate), target,
                                  _original_inspection=evidence.copy_for(original))
            self.assertFalse(target.exists())

    def test_hybrid_repair_inspects_exact_normalized_original_only_once(self):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            source = build_fixture.synthetic_hybrid_pdf()
            request = folder / "source.pdf"
            request.write_bytes(source)
            with patch.object(worker, "validate_ua", return_value=VALIDATION):
                prepared = worker.process("prepare", request, folder, {})
            reference_folder = folder / "reference"
            reference_folder.mkdir()
            _, reference_path, _, _ = worker.prepared_source(source, reference_folder / "source.pdf", reference_folder)
            reference_sha = worker.digest(reference_path.read_bytes())
            candidate = base64.b64decode(prepared["pdfBase64"])
            repair_folder = folder / "repair"
            repair_folder.mkdir()
            repair_request = repair_folder / "request.json"
            repair_request.write_text(json.dumps({"sourcePdfBase64": base64.b64encode(source).decode(),
                "candidatePdfBase64": base64.b64encode(candidate).decode(),
                "plan": {"schemaVersion": 1, "candidateSha256": worker.digest(candidate), "operations": []}}))
            counts = Counter()
            scan = v.structure_inventory
            def measured(reader):
                counts[worker.digest(reader.stream.getvalue())] += 1
                return scan(reader)
            with patch.object(v, "structure_inventory", side_effect=measured), \
                 patch.object(ids, "structure_inventory", side_effect=measured), \
                 patch.object(v, "compare_pdfs", wraps=v.compare_pdfs) as compared, \
                 patch.object(worker, "validate_ua", return_value=VALIDATION):
                result = worker.process("repair", repair_request, repair_folder, {})
            self.assertEqual(counts[reference_sha], 1, dict(counts))
            self.assertEqual(compared.call_count, 2)
            self.assertTrue(result["machineChecks"]["preservationPassed"])

    def test_hybrid_preparation_inspects_each_saved_version_only_once(self):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            source = build_fixture.synthetic_hybrid_pdf()
            reference_folder = folder / "reference"
            reference_folder.mkdir()
            _, reference_path, _, _ = worker.prepared_source(source, reference_folder / "source.pdf", reference_folder)
            reference_sha = worker.digest(reference_path.read_bytes())
            prepare_folder = folder / "prepare"
            prepare_folder.mkdir()
            request = prepare_folder / "input.pdf"
            request.write_bytes(source)
            counts = Counter()
            scan = v.structure_inventory
            def measured(reader):
                counts[worker.digest(reader.stream.getvalue())] += 1
                return scan(reader)
            with patch.object(v, "structure_inventory", side_effect=measured), \
                 patch.object(ids, "structure_inventory", side_effect=measured), \
                 patch.object(v, "compare_pdfs", wraps=v.compare_pdfs) as compared, \
                 patch.object(worker, "validate_ua", return_value=VALIDATION):
                result = worker.process("prepare", request, prepare_folder, {})
            self.assertEqual(counts[reference_sha], 1, dict(counts))
            self.assertEqual(counts[result["candidateSha256"]], 1, dict(counts))
            # The raw hybrid has no authored native Alt/ActualText. Its
            # bounded absence proof avoids a redundant text extraction while
            # the normalized source and delivered candidate stay independent.
            self.assertEqual(counts[worker.digest(source)], 0, dict(counts))
            self.assertEqual(compared.call_count, 1)
            self.assertTrue(result["machineChecks"]["preservationPassed"])


if __name__ == "__main__":
    unittest.main()
