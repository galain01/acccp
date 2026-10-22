"""Optional structure discovery cannot disable the main native-PDF checks."""
import base64
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from pypdf import PdfReader

import worker
from test_native_pdf_validation import pdf_bytes


class StructureLimitTests(unittest.TestCase):
    def test_discovery_limit_survives_prepare_and_noop_repair_as_warning(self):
        source = pdf_bytes(tagged=True)
        validator = {"completed": True, "compliant": False, "failedRules": 1, "failedChecks": 1,
                     "rules": [{"clause": "7.21.4.1", "testNumber": 1, "failedChecks": 1, "description": "Missing embedded font"}]}
        with tempfile.TemporaryDirectory() as temporary:
            folder = Path(temporary)
            first, second = folder / "prepare", folder / "repair"
            first.mkdir(); second.mkdir()
            request = folder / "input.pdf"
            request.write_bytes(source)
            with patch.object(worker, "discover_candidates", side_effect=worker.SemanticStructureError("pdf_complexity_limit")), \
                 patch.object(worker, "validate_ua", return_value=validator), \
                 patch.object(worker, "apply_operations") as apply:
                prepared = worker.process("prepare", request, first, {})
                repair_request = folder / "request.json"
                repair_request.write_text(json.dumps({"sourcePdfBase64": base64.b64encode(source).decode(),
                    "candidatePdfBase64": prepared["pdfBase64"], "plan": {"schemaVersion": 1,
                    "candidateSha256": prepared["candidateSha256"], "operations": []}}))
                repaired = worker.process("repair", repair_request, second, {})
                apply.assert_not_called()
            for result in (prepared, repaired):
                self.assertTrue(result["machineChecks"]["preservationPassed"])
                self.assertTrue(result["machineChecks"]["inspectionComplete"])
                self.assertFalse(result["machineChecks"]["conformanceClaim"])
                self.assertEqual(result["inventory"]["structureCandidates"], [])
                warnings = [item for item in result["findings"] if item["code"] == "structure_candidates_limited"]
                self.assertEqual(len(warnings), 1)
                self.assertIn("processing limit", warnings[0]["message"])
                self.assertTrue(any(item["code"].startswith("pdf_ua_rule_") for item in result["findings"]))
            self.assertEqual(repaired["inventory"]["sourceTagLineage"], {"tag-1": "tag-1", "tag-2": "tag-2"})

    def test_requested_semantic_error_codes_fail_closed_without_raw_details(self):
        source = pdf_bytes(tagged=True)
        reader = worker.open_pdf(source)
        tag = worker.enrich_inventory(reader, reader)["tags"][1]
        plan = {"schemaVersion": 1, "candidateSha256": worker.digest(source), "operations": [{
            "type": "repair_structure", "tagId": tag["id"], "expected": tag["snapshot"], "candidateId": "a" * 64}]}
        with tempfile.TemporaryDirectory() as temporary:
            for code, expected in (("pdf_complexity_limit", "pdf_complexity_limit"),
                                   ("native_pdf_preservation", "native_pdf_preservation"),
                                   ("native_pdf_invalid_plan", "native_pdf_invalid_plan"),
                                   ("private document error", "native_pdf_worker_failed")):
                with self.subTest(code=code), patch.object(worker, "apply_operations", side_effect=worker.SemanticStructureError(code)):
                    with self.assertRaises(worker.WorkerError) as caught:
                        worker.apply_plan(reader, reader, plan, Path(temporary) / "output.pdf")
                    self.assertEqual(str(caught.exception), expected)

    def test_unexpected_discovery_failure_is_not_downgraded_to_success(self):
        reader = PdfReader(io.BytesIO(pdf_bytes(tagged=True)))
        with patch.object(worker, "discover_candidates", side_effect=worker.SemanticStructureError("private document error")):
            with self.assertRaises(worker.WorkerError) as caught:
                worker.enrich_inventory(reader, reader)
            self.assertEqual(str(caught.exception), "native_pdf_worker_failed")

    def test_binding_failure_has_preservation_diagnostic(self):
        data = pdf_bytes(tagged=True)
        reader = worker.open_pdf(data)
        plan = {"schemaVersion": 1, "candidateSha256": worker.digest(data), "operations": []}
        with tempfile.TemporaryDirectory() as temporary, patch.object(worker, "authored_id_bindings", side_effect=worker.NoteIdError("private document error")):
            with self.assertRaises(worker.WorkerError) as caught:
                worker.apply_plan(reader, reader, plan, Path(temporary) / "output.pdf")
            self.assertEqual(str(caught.exception), "native_pdf_preservation")

    def test_missing_operation_tag_id_is_a_controlled_invalid_plan(self):
        data = pdf_bytes(tagged=True)
        reader = worker.open_pdf(data)
        with tempfile.TemporaryDirectory() as temporary:
            for operation_type in ("set_role", "repair_structure"):
                with self.subTest(operation_type=operation_type):
                    plan = {"schemaVersion": 1, "candidateSha256": worker.digest(data),
                            "operations": [{"type": operation_type}]}
                    with self.assertRaises(worker.WorkerError) as caught:
                        worker.apply_plan(reader, reader, plan, Path(temporary) / "output.pdf")
                    self.assertEqual(str(caught.exception), "native_pdf_invalid_plan")


if __name__ == "__main__":
    unittest.main()
