"""Regression contract for repairing an exact generic source image label.

These exercise the real saved-file worker boundary. Only the external veraPDF
executable is substituted; source hashes, painted content and ownership remain
subject to the normal worker checks. No public PDF or model output is a fixture.
"""
import base64
import copy
from dataclasses import replace
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from pypdf import PdfWriter
from pypdf.generic import DictionaryObject, NameObject, TextStringObject

import worker
import native_image_alternatives as alternatives
from test_native_pdf_validation import figure_reader


def figure_bytes(description, *, actual_text=None):
    reader = figure_reader(kind="vector", alts=(description,))
    writer = PdfWriter(clone_from=reader)
    if actual_text is not None:
        worker.native_nodes(writer)[1][NameObject("/ActualText")] = TextStringObject(actual_text)
    stream = io.BytesIO()
    writer.write(stream)
    return stream.getvalue()


class SourcePlaceholderDescriptionRegressions(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.directory = Path(temporary.name)

    def repair(self, source, operations, *, candidate=None):
        candidate = source if candidate is None else candidate
        request = self.directory / "request.json"
        request.write_text(json.dumps({
            "sourcePdfBase64": base64.b64encode(source).decode("ascii"),
            "candidatePdfBase64": base64.b64encode(candidate).decode("ascii"),
            "plan": {"schemaVersion": 1, "candidateSha256": worker.digest(candidate), "operations": operations},
        }), encoding="utf-8")
        validator = {"completed": True, "compliant": False, "failedRules": 1, "failedChecks": 1,
                     "rules": [{"clause": "5", "testNumber": 1, "failedChecks": 1,
                                "description": "PDF/UA identification declaration is absent"}]}
        with patch.object(worker, "validate_ua", return_value=validator):
            return worker.process("repair", request, self.directory, {})

    def operation(self, source, *, proposed="A filled black rectangle with the visible label Label0."):
        original = worker.open_pdf(source)
        tag = worker.enrich_inventory(original, original)["tags"][1]
        return {"type": "set_alt", "tagId": tag["id"], "expected": tag["snapshot"], "alt": proposed}

    def test_exact_placeholder_source_label_is_editable_on_its_verified_figure(self):
        for placeholder in ("image 1", "Figure 2", " annotation ", ""):
            with self.subTest(placeholder=placeholder):
                source = worker.open_pdf(figure_bytes(placeholder))
                tag = worker.enrich_inventory(source, source)["tags"][1]
                self.assertTrue(tag["editable"]["alt"], "An exact empty/generic label should not prevent the available obvious repair")

    def test_authorized_placeholder_replacement_survives_saved_worker_preservation_checks(self):
        source = figure_bytes("image 1")
        operation = self.operation(source)
        result = self.repair(source, [operation])
        delivered = worker.open_pdf(base64.b64decode(result["pdfBase64"]))
        self.assertEqual(operation["alt"], worker.enrich_inventory(delivered, worker.open_pdf(source))["tags"][1]["alt"])
        self.assertEqual(worker.digest(source), result["sourceSha256"])
        self.assertEqual(source, (self.directory / "source.pdf").read_bytes())
        self.assertTrue(result["machineChecks"]["preservationPassed"])
        self.assertTrue(result["machineChecks"]["pixelsIdentical"])
        self.assertTrue(result["machineChecks"]["inspectionComplete"])
        self.assertFalse(any(item["code"] == "placeholder_alternative" for item in result["findings"]))

    def test_useful_authored_description_is_retained_and_not_model_editable(self):
        source = figure_bytes("Image 1: the left panel records a filled black rectangle.")
        original = worker.open_pdf(source)
        tag = worker.enrich_inventory(original, original)["tags"][1]
        self.assertFalse(tag["editable"]["alt"])
        result = self.repair(source, [])
        self.assertEqual(tag["alt"], result["inventory"]["tags"][1]["alt"])
        with self.assertRaisesRegex(worker.WorkerError, "invalid_plan"):
            self.repair(source, [self.operation(source)])

    def test_authored_actual_text_cannot_be_bypassed_by_a_generic_alt(self):
        source = figure_bytes("image 1", actual_text="Authored replacement wording")
        original = worker.open_pdf(source)
        tag = worker.enrich_inventory(original, original)["tags"][1]
        self.assertFalse(tag["editable"]["alt"])
        with self.assertRaisesRegex(worker.WorkerError, "invalid_plan"):
            self.repair(source, [self.operation(source)])

    def test_wrong_before_description_or_unowned_target_cannot_authorize_a_replacement(self):
        source = figure_bytes("image 1")
        for change in ("snapshot", "target"):
            operation = self.operation(source)
            if change == "snapshot":
                operation["expected"]["alt"] = "A different image label"
            else:
                operation["tagId"] = "tag-1"
            with self.subTest(change=change), self.assertRaisesRegex(worker.WorkerError, "invalid_plan"):
                self.repair(source, [operation])

    def test_useful_source_description_cannot_be_smuggled_through_the_candidate(self):
        source = figure_bytes("A filled black rectangle with label Label0.")
        candidate = figure_bytes("image 1")
        with self.assertRaisesRegex(worker.WorkerError, "preservation"):
            self.repair(source, [self.operation(candidate)], candidate=candidate)

    def test_description_updates_reject_raw_pdf_operations_and_duplicate_targets(self):
        source = figure_bytes("image 1")
        operation = self.operation(source)
        variants = []
        unexpected = copy.deepcopy(operation)
        unexpected["type"] = "replace_pdf"
        variants.append([unexpected])
        extra = copy.deepcopy(operation)
        extra["file"] = "/outside/document.pdf"
        variants.append([extra])
        variants.append([operation, copy.deepcopy(operation)])
        for operations in variants:
            with self.subTest(operations=operations), self.assertRaisesRegex(worker.WorkerError, "invalid_plan"):
                self.repair(source, operations)


class ExactAlternativeProofTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.directory = Path(temporary.name)

    def planned(self, source):
        reader = worker.open_pdf(source)
        tag = worker.verify_pdf.structure_inventory(reader)["tags"][1]
        operation = {"type": "set_alt", "tagId": tag["id"], "expected": worker.snapshot(tag),
                     "alt": "A filled black rectangle with visible label Label0."}
        proof = alternatives.approve_replacements(reader, reader, [operation])
        return reader, operation, proof

    def edited(self, reader, callback):
        writer = PdfWriter(clone_from=reader)
        callback(writer)
        stream = io.BytesIO()
        writer.write(stream)
        return stream.getvalue()

    def compare(self, source, output, proof=None):
        original = self.directory / "source.pdf"
        delivered = self.directory / "output.pdf"
        original.write_bytes(source)
        delivered.write_bytes(output)
        return worker.verify_pdf.compare_pdfs(original, delivered, _approved_figure_alternatives=proof)

    def test_only_exact_approved_update_passes_and_equality_flags_remain_truthful(self):
        source = figure_bytes("image 1")
        reader, operation, proof = self.planned(source)
        output = self.edited(reader, lambda writer: worker.native_nodes(writer)[1].__setitem__(NameObject("/Alt"), TextStringObject(operation["alt"])))
        self.assertFalse(self.compare(source, output)["preservation"]["passed"])
        approved = self.compare(source, output, proof)
        self.assertTrue(approved["preservation"]["passed"])
        self.assertTrue(approved["figure_associations"]["passed"])
        row = approved["figure_associations"]["comparisons"][0]
        self.assertFalse(row["descriptionsIdentical"])
        self.assertTrue(row["descriptionReplacementVerified"])
        self.assertFalse(approved["structure"]["authored_alternative_strings_retained"])

    def test_changed_source_or_wrong_description_cannot_reuse_an_approval(self):
        source = figure_bytes("image 1")
        reader, operation, proof = self.planned(source)
        for replacement in ("Unexpected guessed replacement", "image 1"):
            output = self.edited(reader, lambda writer: worker.native_nodes(writer)[1].__setitem__(NameObject("/Alt"), TextStringObject(replacement)))
            self.assertFalse(self.compare(source, output, proof)["preservation"]["passed"])
        source_other = figure_bytes("Figure 2")
        output = self.edited(reader, lambda writer: worker.native_nodes(writer)[1].__setitem__(NameObject("/Alt"), TextStringObject(operation["alt"])))
        self.assertFalse(self.compare(source_other, output, proof)["preservation"]["passed"])

    def test_an_approval_never_authorizes_actual_text_or_ancestor_description_overrides(self):
        source = figure_bytes("image 1")
        reader, operation, proof = self.planned(source)
        for target, key in ((1, "/ActualText"), (0, "/ActualText"), (0, "/Alt")):
            def mutate(writer):
                worker.native_nodes(writer)[1][NameObject("/Alt")] = TextStringObject(operation["alt"])
                worker.native_nodes(writer)[target][NameObject(key)] = TextStringObject("A hidden override")
            output = self.edited(reader, mutate)
            self.assertFalse(self.compare(source, output, proof)["preservation"]["passed"])

    def test_unrelated_useful_description_and_the_paint_cannot_change(self):
        original_reader = figure_reader(kind="vector", alts=("image 1", "A useful authored second description."))
        writer = PdfWriter(clone_from=original_reader)
        data = io.BytesIO()
        writer.write(data)
        source = data.getvalue()
        reader, operation, proof = self.planned(source)
        def mutate(writer):
            worker.native_nodes(writer)[1][NameObject("/Alt")] = TextStringObject(operation["alt"])
            worker.native_nodes(writer)[2][NameObject("/Alt")] = TextStringObject("Changed unrelated description")
        output = self.edited(reader, mutate)
        self.assertFalse(self.compare(source, output, proof)["preservation"]["passed"])
        def move_paint(writer):
            worker.native_nodes(writer)[1][NameObject("/Alt")] = TextStringObject(operation["alt"])
            content = writer.pages[0]["/Contents"].get_object()
            content.set_data(content.get_data().replace(b"20 20 30 20 re", b"21 20 30 20 re"))
        output = self.edited(reader, move_paint)
        self.assertFalse(self.compare(source, output, proof)["preservation"]["passed"])

    def test_untrusted_dictionary_and_useful_authored_description_cannot_mint_approval(self):
        source = figure_bytes("image 1")
        reader, operation, proof = self.planned(source)
        output = self.edited(reader, lambda writer: worker.native_nodes(writer)[1].__setitem__(NameObject("/Alt"), TextStringObject(operation["alt"])))
        self.assertFalse(self.compare(source, output, {"allow": True})["preservation"]["passed"])
        useful = figure_bytes("A useful original image description")
        useful_reader = worker.open_pdf(useful)
        useful_tag = worker.verify_pdf.structure_inventory(useful_reader)["tags"][1]
        operation["expected"] = worker.snapshot(useful_tag)
        with self.assertRaises(alternatives.AlternativeReplacementError):
            alternatives.approve_replacements(useful_reader, useful_reader, [operation])

    def test_shared_image_bytes_do_not_make_the_two_paint_occurrences_interchangeable(self):
        original_reader = figure_reader(kind="image", alts=("image 1", "image 1"))
        source = self.edited(original_reader, lambda writer: None)
        reader, operation, proof = self.planned(source)
        correct = self.edited(reader, lambda writer: worker.native_nodes(writer)[1].__setitem__(NameObject("/Alt"), TextStringObject(operation["alt"])))
        self.assertTrue(self.compare(source, correct, proof)["preservation"]["passed"])
        wrong_occurrence = self.edited(reader, lambda writer: worker.native_nodes(writer)[2].__setitem__(NameObject("/Alt"), TextStringObject(operation["alt"])))
        self.assertFalse(self.compare(source, wrong_occurrence, proof)["preservation"]["passed"])

    def test_saved_owner_must_remain_a_literal_native_figure(self):
        source = figure_bytes("image 1")
        reader, operation, proof = self.planned(source)
        def mutate(writer):
            worker.native_nodes(writer)[1][NameObject("/Alt")] = TextStringObject(operation["alt"])
            worker.native_nodes(writer)[1][NameObject("/S")] = NameObject("/CustomFigure")
            writer.root_object["/StructTreeRoot"][NameObject("/RoleMap")] = DictionaryObject({NameObject("/CustomFigure"): NameObject("/Figure")})
        output = self.edited(reader, mutate)
        self.assertFalse(self.compare(source, output, proof)["preservation"]["passed"])

    def test_private_proof_does_not_skip_replacement_value_bounds(self):
        source = figure_bytes("image 1")
        reader, operation, proof = self.planned(source)
        for value in ("", "image 1", "a" * 8001, "Meaningful\x01description", None):
            forged = replace(proof, replacements=(replace(proof.replacements[0], new_alt=value),))
            with self.subTest(value=repr(value)[:50]), self.assertRaises(alternatives.AlternativeReplacementError):
                alternatives.verify_replacements(forged, reader, reader)


if __name__ == "__main__":
    unittest.main()
