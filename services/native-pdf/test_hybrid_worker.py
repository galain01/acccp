"""Hybrid admission/repair integration using a synthetic, tagged fillable PDF."""
import base64
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from pypdf import PdfReader, PdfWriter
from pypdf.generic import NameObject, TextStringObject

import worker
from form_interaction_fingerprint import form_interaction_fingerprint


spec = importlib.util.spec_from_file_location("native_pdf_build_fixture", Path(__file__).with_name("build-smoke.py"))
build_fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(build_fixture)


def result_bytes(writer):
    out = io.BytesIO()
    writer.write(out)
    return out.getvalue()


class HybridWorkerTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.folder = Path(temporary.name)
        self.source = build_fixture.synthetic_hybrid_pdf()
        self.request = self.folder / "input.pdf"
        self.request.write_bytes(self.source)
        # External validator execution is covered by the actual build smoke.
        # Keep worker admission, preservation, native inspection and repair real.
        validator = patch.object(worker, "validate_ua", return_value={
            "completed": True, "compliant": False, "failedRules": 1, "failedChecks": 1,
            "rules": [{"clause": "5", "testNumber": 1, "failedChecks": 1,
                       "description": "No conformance declaration"}],
        })
        validator.start()
        self.addCleanup(validator.stop)

    def prepared(self):
        return worker.process("prepare", self.request, self.folder, {})

    def repair(self, prepared, candidate=None):
        candidate = candidate if candidate is not None else base64.b64decode(prepared["pdfBase64"])
        payload = {"sourcePdfBase64": base64.b64encode(self.source).decode(),
                   "candidatePdfBase64": base64.b64encode(candidate).decode(),
                   "plan": {"schemaVersion": 1, "candidateSha256": worker.digest(candidate), "operations": []}}
        folder = self.folder / "repair"
        folder.mkdir()
        request = folder / "repair.json"
        request.write_text(json.dumps(payload), encoding="utf-8")
        return worker.process("repair", request, folder, {})

    def test_prepare_and_repair_keep_original_identity_with_verified_reference(self):
        prepared = self.prepared()
        self.assertEqual(prepared["sourceSha256"], worker.digest(self.source))
        self.assertEqual(self.request.read_bytes(), self.source)
        output = PdfReader(io.BytesIO(base64.b64decode(prepared["pdfBase64"])))
        self.assertNotIn("/Perms", output.trailer["/Root"])
        self.assertEqual(output.get_fields()["workshop[0].name[0]"]["/TU"], "Fictional workshop name")
        self.assertEqual(output.trailer["/Root"]["/AcroForm"]["/SigFlags"], 2)
        hybrid = prepared["inventory"]["forms"]["hybrid"]
        self.assertTrue(hybrid["verification"]["passed"])
        self.assertEqual(hybrid["nativeFieldDescriptionsAdded"], 1)
        self.assertEqual(hybrid["speechPromptsEnabled"], ["workshop[0].name[0]"])
        self.assertTrue(hybrid["verifiedMetadataOnly"])
        self.assertNotIn("xfaPreserved", hybrid)
        form = prepared["inventory"]["forms"]
        self.assertEqual(form["interactionFingerprint"], form_interaction_fingerprint(output))
        self.assertRegex(form["interactionFingerprint"]["sha256"], r"^[a-f0-9]{64}$")
        self.assertEqual(form["field_count"], 1)
        self.assertEqual(len(form["fields"]), 1)
        self.assertFalse(form["fields"][0]["speech"]["disabled"])
        self.assertEqual(form["fields"][0]["pageNumbers"], [1])
        self.assertTrue(prepared["machineChecks"]["pixelsIdentical"])
        self.assertFalse(prepared["machineChecks"]["conformanceClaim"])
        self.assertIn("legacy_form_interaction_review", [item["code"] for item in prepared["findings"]])
        repaired = self.repair(prepared)
        self.assertEqual(repaired["sourceSha256"], worker.digest(self.source))
        self.assertTrue(repaired["machineChecks"]["preservationPassed"])
        self.assertTrue(repaired["inventory"]["forms"]["hybrid"]["verification"]["passed"])
        saved_reader = PdfReader(io.BytesIO(base64.b64decode(repaired["pdfBase64"])), strict=True)
        self.assertEqual(repaired["inventory"]["forms"]["interactionFingerprint"], form_interaction_fingerprint(saved_reader))
        self.assertEqual(form["interactionFingerprint"], repaired["inventory"]["forms"]["interactionFingerprint"])
        source_packets = PdfReader(io.BytesIO(self.source)).trailer["/Root"]["/AcroForm"]["/XFA"]
        result_packets = PdfReader(io.BytesIO(base64.b64decode(repaired["pdfBase64"]))).trailer["/Root"]["/AcroForm"]["/XFA"]
        for index in range(1, len(source_packets), 2):
            expected = source_packets[index].get_object().get_data()
            if str(source_packets[index - 1]) == "template":
                expected = expected.replace(b'<speak disable="1">', b'<speak disable="0">')
            self.assertEqual(expected, result_packets[index].get_object().get_data())

    def test_disabled_speech_cannot_be_reintroduced_by_candidate(self):
        prepared = self.prepared()
        writer = PdfWriter(clone_from=PdfReader(io.BytesIO(base64.b64decode(prepared["pdfBase64"]))))
        packet = writer.root_object["/AcroForm"]["/XFA"][3].get_object()
        packet.set_data(packet.get_data().replace(b'disable="0"', b'disable="1"'))
        with self.assertRaisesRegex(worker.WorkerError, "native_pdf_preservation"):
            self.repair(prepared, result_bytes(writer))

    def test_unavailable_optional_fingerprint_leaves_conversion_and_review_intact(self):
        with patch.object(worker, "form_interaction_fingerprint", return_value=None):
            prepared = self.prepared()
            self.assertNotIn("interactionFingerprint", prepared["inventory"]["forms"])
            self.assertIn("legacy_form_interaction_review", [item["code"] for item in prepared["findings"]])
            self.assertTrue(prepared["machineChecks"]["preservationPassed"])

    def test_changed_native_tooltip_rejected_even_with_matching_candidate_hash(self):
        prepared = self.prepared()
        writer = PdfWriter(clone_from=PdfReader(io.BytesIO(base64.b64decode(prepared["pdfBase64"]))))
        writer.pages[0]["/Annots"][0].get_object()[NameObject("/TU")] = TextStringObject("Different authored label")
        with self.assertRaisesRegex(worker.WorkerError, "native_pdf_preservation"):
            self.repair(prepared, result_bytes(writer))

    def test_changed_xfa_description_rejected_even_with_matching_candidate_hash(self):
        prepared = self.prepared()
        writer = PdfWriter(clone_from=PdfReader(io.BytesIO(base64.b64decode(prepared["pdfBase64"]))))
        packet = writer.root_object["/AcroForm"]["/XFA"][3].get_object()
        packet.set_data(packet.get_data().replace(b"Fictional workshop name", b"Different workshop name"))
        with self.assertRaisesRegex(worker.WorkerError, "native_pdf_preservation"):
            self.repair(prepared, result_bytes(writer))

    def test_changed_xfa_data_rejected_even_with_matching_candidate_hash(self):
        prepared = self.prepared()
        writer = PdfWriter(clone_from=PdfReader(io.BytesIO(base64.b64decode(prepared["pdfBase64"]))))
        packet = writer.root_object["/AcroForm"]["/XFA"][5].get_object()
        packet.set_data(packet.get_data().replace(b"<name/>", b"<name>Different value</name>"))
        with self.assertRaisesRegex(worker.WorkerError, "native_pdf_preservation"):
            self.repair(prepared, result_bytes(writer))


if __name__ == "__main__":
    unittest.main()
