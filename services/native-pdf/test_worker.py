import base64
import copy
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

import worker
from pypdf import PdfReader, PdfWriter
from pypdf.generic import ArrayObject, BooleanObject, DecodedStreamObject, DictionaryObject, NameObject, NumberObject, TextStringObject

sys.path.insert(0, str(worker.REPO / "research/native-pdf"))
from test_native_pdf_validation import pdf_bytes, inline_link_reader


def modified(data, mutate):
    writer = PdfWriter(clone_from=PdfReader(io.BytesIO(data)))
    mutate(writer)
    output = io.BytesIO()
    writer.write(output)
    return output.getvalue()


def validation(path, compliant=False):
    return {"report": {"jobs": [{"itemDetails": {"name": str(path), "size": path.stat().st_size},
        "validationResult": [{"jobEndStatus": "normal", "profileName": "PDF/UA-1 validation profile", "compliant": compliant,
            "details": {"passedRules": 30, "passedChecks": 100, "failedRules": 0 if compliant else 1, "failedChecks": 0 if compliant else 2,
                "ruleSummaries": [] if compliant else [{"ruleStatus": "FAILED", "clause": "7.21.4", "testNumber": 1, "failedChecks": 2, "description": "Font program missing"}]}}]}],
        "batchSummary": {"totalJobs": 1, "validationSummary": {"successfulJobCount": 1, "failedJobCount": 0}}}}


def table_bytes(merged=False):
    writer = PdfWriter()
    page = writer.add_blank_page(240, 160)
    root = DictionaryObject({NameObject("/Type"): NameObject("/StructTreeRoot")})
    root_ref = writer._add_object(root)
    table = DictionaryObject({NameObject("/Type"): NameObject("/StructElem"), NameObject("/S"): NameObject("/Table"), NameObject("/P"): root_ref})
    table_ref = writer._add_object(table)
    root[NameObject("/K")] = table_ref
    rows, owners, paint = [], [], []
    font = writer._add_object(DictionaryObject({NameObject("/Type"): NameObject("/Font"), NameObject("/Subtype"): NameObject("/Type1"), NameObject("/BaseFont"): NameObject("/Helvetica")}))
    page[NameObject("/Resources")] = DictionaryObject({NameObject("/Font"): DictionaryObject({NameObject("/F1"): font})})
    for row_index, labels in enumerate((("Week", "Topic"), ("1", "Introduction"))):
        row = DictionaryObject({NameObject("/Type"): NameObject("/StructElem"), NameObject("/S"): NameObject("/TR"), NameObject("/P"): table_ref})
        row_ref = writer._add_object(row); rows.append(row_ref); cells = []
        for column, label in enumerate(labels):
            cell = DictionaryObject({NameObject("/Type"): NameObject("/StructElem"), NameObject("/S"): NameObject("/TD"), NameObject("/P"): row_ref, NameObject("/Pg"): page.indirect_reference})
            cell_ref = writer._add_object(cell); cells.append(cell_ref)
            if merged and row_index == 0 and column == 0:
                cell[NameObject("/A")] = DictionaryObject({NameObject("/O"): NameObject("/Table"), NameObject("/ColSpan"): NumberObject(2)})
            paragraph = DictionaryObject({NameObject("/Type"): NameObject("/StructElem"), NameObject("/S"): NameObject("/P"), NameObject("/P"): cell_ref, NameObject("/Pg"): page.indirect_reference, NameObject("/K"): NumberObject(len(owners))})
            paragraph_ref = writer._add_object(paragraph); cell[NameObject("/K")] = paragraph_ref
            paint.append(f'/P <</MCID {len(owners)}>> BDC BT /F1 12 Tf {20+column*100} {120-row_index*40} Td ({label}) Tj ET EMC')
            owners.append(paragraph_ref)
        row[NameObject("/K")] = ArrayObject(cells)
    table[NameObject("/K")] = ArrayObject(rows)
    root[NameObject("/ParentTree")] = DictionaryObject({NameObject("/Nums"): ArrayObject([NumberObject(0), ArrayObject(owners)])})
    page[NameObject("/StructParents")] = NumberObject(0)
    content = DecodedStreamObject(); content.set_data("\n".join(paint).encode()); page[NameObject("/Contents")] = writer._add_object(content)
    writer.root_object[NameObject("/StructTreeRoot")] = root_ref
    writer.root_object[NameObject("/Lang")] = TextStringObject("en-US")
    writer.root_object[NameObject("/MarkInfo")] = DictionaryObject({NameObject("/Marked"): BooleanObject(True)})
    output = io.BytesIO(); writer.write(output); return output.getvalue()


def inline_heading_bytes(*, nested_role="Span", bad_owner=False, role_mapping=True):
    writer = PdfWriter(clone_from=inline_link_reader())
    root = writer.root_object["/StructTreeRoot"]
    document = root["/K"][0].get_object()
    paragraph_ref = document["/K"][0]
    paragraph = paragraph_ref.get_object()
    if role_mapping:
        root[NameObject("/RoleMap")] = DictionaryObject({NameObject("/CustomBody"): NameObject("/P")})
        paragraph[NameObject("/S")] = NameObject("/CustomBody")
    span = DictionaryObject({NameObject("/Type"): NameObject("/StructElem"), NameObject("/S"): NameObject("/" + nested_role),
                             NameObject("/P"): paragraph_ref, NameObject("/Pg"): writer.pages[0].indirect_reference,
                             NameObject("/K"): NumberObject(0), NameObject("/ActualText"): TextStringObject("Before")})
    span_ref = writer._add_object(span)
    paragraph["/K"][0] = span_ref
    root["/ParentTree"]["/Nums"][1][0] = paragraph_ref if bad_owner else span_ref
    data = io.BytesIO(); writer.write(data); return data.getvalue()


class NativePdfWorkerTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.folder = Path(temporary.name)
        self.source = self.folder / "source.pdf"
        self.source.write_bytes(pdf_bytes(tagged=True, text="Fictional chapter"))
        self.reader = worker.open_pdf(self.source.read_bytes())
        inventory = worker.enrich_inventory(self.reader, self.reader)
        self.tag = inventory["tags"][1]
        self.plan = {"schemaVersion": 1, "candidateSha256": worker.digest(self.source.read_bytes()),
                     "operations": [{"type": "set_role", "tagId": self.tag["id"], "expected": self.tag["snapshot"], "role": "H1"}]}
        self.output = self.folder / "output.pdf"

    def test_role_repair_preserves_pixels_text_and_source_bytes(self):
        source = self.source.read_bytes()
        changes = worker.apply_plan(self.reader, self.reader, self.plan, self.output)
        checks = worker.verify_pdf.compare_pdfs(self.source, self.output)
        self.assertEqual(source, self.source.read_bytes())
        self.assertTrue(checks["preservation"]["passed"])
        self.assertTrue(all(page["pixels_identical"] for page in checks["preservation"]["pages"]))
        self.assertEqual("H1", checks["structure"]["tags"][1]["role"])
        self.assertEqual("set_role", changes[-1]["code"])

    def test_mapped_paragraph_with_inline_span_link_and_actual_text_can_be_heading(self):
        data = inline_heading_bytes()
        self.source.write_bytes(data)
        original = worker.open_pdf(data)
        before = worker.enrich_inventory(original, original)
        paragraph = before["tags"][1]
        self.assertEqual("CustomBody", paragraph["sourceRole"])
        self.assertEqual("P", paragraph["role"])
        self.assertTrue(paragraph["editable"]["role"])
        plan = {"schemaVersion": 1, "candidateSha256": worker.digest(data), "operations": [
            {"type": "set_role", "tagId": paragraph["id"], "expected": paragraph["snapshot"], "role": "H1"}]}
        worker.apply_plan(original, original, plan, self.output)
        after = worker.open_pdf(self.output.read_bytes())
        checks = worker.verify_pdf.compare_pdfs(self.source, self.output)
        self.assertTrue(checks["preservation"]["passed"])
        self.assertTrue(checks["actual_text_associations"]["passed"])
        self.assertTrue(checks["preservation"]["pages"][0]["pixels_identical"])
        self.assertEqual("H1", checks["structure"]["tags"][1]["role"])
        self.assertEqual(before["tags"][1]["contentSequence"], checks["structure"]["tags"][1]["contentSequence"])
        self.assertEqual("Before", checks["structure"]["tags"][2]["actualText"])
        self.assertEqual(original.pages[0]["/Annots"][0].get_object()["/A"], after.pages[0]["/Annots"][0].get_object()["/A"])
        self.assertEqual(original.trailer["/Root"]["/StructTreeRoot"]["/RoleMap"], after.trailer["/Root"]["/StructTreeRoot"]["/RoleMap"])

    def test_nested_block_figure_or_table_is_not_an_editable_text_block(self):
        for role in ("P", "Figure", "Table"):
            original = worker.open_pdf(inline_heading_bytes(nested_role=role))
            paragraph = worker.enrich_inventory(original, original)["tags"][1]
            self.assertFalse(paragraph["editable"]["role"], role)

    def test_unverified_inline_owner_blocks_role_repair(self):
        original = worker.open_pdf(inline_heading_bytes(bad_owner=True))
        self.assertFalse(worker.enrich_inventory(original, original)["tags"][1]["editable"]["role"])

    def test_inline_role_eligibility_has_depth_and_node_limits(self):
        original = worker.open_pdf(inline_heading_bytes())
        inventory = worker.enrich_inventory(original, original)
        tags = {tag["id"]: tag for tag in inventory["tags"]}
        paragraph = tags["tag-2"]
        for depth in range(1, 19):
            identifier = f"tag-{100+depth}"
            next_identifier = f"tag-{101+depth}"
            tags[identifier] = {"id": identifier, "role": "Span", "text": "", "parentId": "tag-2" if depth == 1 else f"tag-{99+depth}",
                                "children": [next_identifier] if depth < 18 else [],
                                "contentSequence": [{"kind": "childTag", "tagId": next_identifier, "resolved": True}] if depth < 18 else
                                [{"kind": "markedContent", "pageNumber": 1, "resolved": True, "parentTreeVerified": True}]}
        paragraph["children"] = ["tag-101"]
        paragraph["contentSequence"] = [{"kind": "childTag", "tagId": "tag-101", "resolved": True}]
        self.assertFalse(worker.text_block_eligible(paragraph, tags))

    def test_stale_hash_wrong_snapshot_and_unknown_target_rejected(self):
        variants = []
        plan = copy.deepcopy(self.plan); plan["candidateSha256"] = "0" * 64; variants.append(plan)
        plan = copy.deepcopy(self.plan); plan["operations"][0]["expected"]["text"] = "Different source"; variants.append(plan)
        plan = copy.deepcopy(self.plan); plan["operations"][0]["tagId"] = "tag-999"; variants.append(plan)
        for plan in variants:
            with self.subTest(plan=plan), self.assertRaisesRegex(worker.WorkerError, "invalid_plan"):
                worker.apply_plan(self.reader, self.reader, plan, self.output)
            self.assertFalse(self.output.exists())

    def test_arbitrary_operations_paths_duplicate_tags_and_hiding_roles_rejected(self):
        variants = []
        for field, value in (("role", "Artifact"), ("role", "Figure"), ("type", "replace_pdf"), ("file", "/etc/passwd")):
            plan = copy.deepcopy(self.plan); plan["operations"][0][field] = value; variants.append(plan)
        plan = copy.deepcopy(self.plan); plan["operations"] *= 2; variants.append(plan)
        for plan in variants:
            with self.subTest(plan=plan), self.assertRaisesRegex(worker.WorkerError, "invalid_plan"):
                worker.apply_plan(self.reader, self.reader, plan, self.output)

    def test_existing_alt_cannot_be_replaced_even_when_its_words_look_generic(self):
        for description in ("Authored important information", "image 1", ""):
            original = worker.open_pdf(pdf_bytes(tagged=True, alt=description))
            tag = worker.enrich_inventory(original, original)["tags"][1]
            self.assertFalse(tag["editable"]["alt"])

    def test_new_missing_figure_alt_can_be_added_without_changing_paint(self):
        source = pdf_bytes(tagged=False)
        candidate = modified(pdf_bytes(tagged=True, alt="image 1"), lambda w: None)
        original, prepared = worker.open_pdf(source), worker.open_pdf(candidate)
        tag = worker.enrich_inventory(prepared, original)["tags"][1]
        self.assertTrue(tag["editable"]["alt"])
        plan = {"schemaVersion": 1, "candidateSha256": worker.digest(candidate), "operations": [
            {"type": "set_alt", "tagId": tag["id"], "expected": tag["snapshot"], "alt": "Hello appears in the diagram."}]}
        worker.apply_plan(original, prepared, plan, self.output)
        self.assertEqual("Hello appears in the diagram.", worker.enrich_inventory(worker.open_pdf(self.output.read_bytes()), original)["tags"][1]["alt"])

    def test_protected_active_embedded_and_xfa_inputs_rejected(self):
        mutations = [
            lambda w: w.root_object.__setitem__(NameObject("/Perms"), DictionaryObject()),
            lambda w: w.root_object.__setitem__(NameObject("/OpenAction"), ArrayObject()),
            lambda w: w.root_object.__setitem__(NameObject("/AA"), DictionaryObject()),
            lambda w: w.root_object.__setitem__(NameObject("/Names"), DictionaryObject({NameObject("/EmbeddedFiles"): DictionaryObject()})),
            lambda w: w.root_object.__setitem__(NameObject("/AcroForm"), DictionaryObject({NameObject("/XFA"): TextStringObject("form")})),
            lambda w: w.root_object.__setitem__(NameObject("/UnsafeAction"), DictionaryObject({NameObject("/S"): NameObject("/JavaScript"), NameObject("/JS"): TextStringObject("doSomething()")})),
        ]
        for mutation in mutations:
            with self.subTest(mutation=mutation), self.assertRaises(worker.WorkerError):
                worker.open_pdf(modified(self.source.read_bytes(), mutation))

    def test_bad_encrypted_and_large_files_rejected(self):
        writer = PdfWriter(clone_from=self.reader); writer.encrypt("secret"); stream = io.BytesIO(); writer.write(stream)
        for data, code in ((b"not pdf", "pdf_invalid"), (stream.getvalue(), "pdf_password"), (b"%PDF-" + b"x" * worker.MAX_PDF, "pdf_invalid")):
            with self.subTest(code=code), self.assertRaisesRegex(worker.WorkerError, code):
                worker.open_pdf(data)

    def test_decode_rejects_whitespace_noncanonical_and_oversize_base64(self):
        encoded = base64.b64encode(self.source.read_bytes()).decode()
        self.assertEqual(self.source.read_bytes(), worker.decode_pdf(encoded))
        for value in (encoded + "\n", encoded + "=", "!!!!", 123, "a" * (6 * 1024 * 1024)):
            with self.assertRaises(worker.WorkerError):
                worker.decode_pdf(value)

    def test_metadata_only_fills_missing_title_and_language(self):
        plan = {**self.plan, "operations": [], "title": "Fictional chapter", "language": "fr-CA"}
        worker.apply_plan(self.reader, self.reader, plan, self.output)
        reopened = worker.open_pdf(self.output.read_bytes())
        self.assertEqual("en-US", reopened.trailer["/Root"]["/Lang"])
        self.assertEqual("Fictional chapter", reopened.metadata["/Title"])
        self.assertNotIn(b"pdfuaid", reopened.trailer["/Root"]["/Metadata"].get_data())

    def test_table_header_on_native_cell_preserves_nested_paragraphs_and_pixels(self):
        data = table_bytes()
        self.source.write_bytes(data)
        reader = worker.open_pdf(data)
        tags = worker.enrich_inventory(reader, reader)["tags"]
        cell = next(tag for tag in tags if tag["role"] == "TD")
        self.assertEqual("", cell["text"])
        self.assertTrue(cell["editable"]["tableHeader"])
        plan = {"schemaVersion": 1, "candidateSha256": worker.digest(data), "operations": [
            {"type": "set_table_header", "tagId": cell["id"], "expected": cell["snapshot"], "scope": "Column"}]}
        worker.apply_plan(reader, reader, plan, self.output)
        checks = worker.verify_pdf.compare_pdfs(self.source, self.output)
        self.assertTrue(checks["preservation"]["passed"])
        saved_cell = next(tag for tag in checks["structure"]["tags"] if tag["id"] == cell["id"])
        self.assertEqual("TH", saved_cell["role"])
        self.assertEqual("Column", saved_cell["attributes"][-1]["scope"])

    def test_merged_or_complex_table_is_not_eligible_for_simple_scope_repair(self):
        reader = worker.open_pdf(table_bytes(merged=True))
        cells = [tag for tag in worker.enrich_inventory(reader, reader)["tags"] if tag["role"] == "TD"]
        self.assertTrue(cells)
        self.assertTrue(all(not tag["editable"]["tableHeader"] for tag in cells))

    def test_described_graphic_page_has_visual_text_evidence_without_invented_ocr_error(self):
        def graphic(writer):
            content = DecodedStreamObject()
            content.set_data(b"/Figure <</MCID 0>> BDC 20 20 40 20 re f EMC")
            writer.pages[0][NameObject("/Contents")] = writer._add_object(content)
        data = modified(pdf_bytes(tagged=True, alt="A filled rectangular example."), graphic)
        self.source.write_bytes(data)
        self.output.write_bytes(data)
        with patch.object(worker, "validate_ua", return_value={"completed": True, "compliant": True, "failedRules": 0, "failedChecks": 0, "rules": []}):
            result = worker.response(self.source, self.output, [], {})
        page = result["inventory"]["page_content"][0]
        self.assertFalse(page["selectableTextPresent"])
        self.assertTrue(page["requiresVisualTextReview"])
        self.assertFalse(any("ocr" in finding["code"] or "text_layer" in finding["code"] for finding in result["findings"]))

    def test_verapdf_exact_file_profile_completion_and_exit_required(self):
        toolchain = {"veraPdf": {"command": "fixed-java", "args": []}}
        valid = validation(self.source)
        with patch.object(worker, "run_bounded", return_value=(1, json.dumps(valid).encode())):
            self.assertEqual(2, worker.validate_ua(self.source, toolchain)["failedChecks"])
        variants = []
        for mutate in (
            lambda r: r["report"]["jobs"][0]["itemDetails"].update(name="other.pdf"),
            lambda r: r["report"]["jobs"][0]["itemDetails"].update(size=1),
            lambda r: r["report"]["jobs"][0]["validationResult"][0].update(profileName="PDF/A-1b validation profile"),
            lambda r: r["report"]["jobs"][0]["validationResult"][0].update(jobEndStatus="failed"),
            lambda r: r["report"]["batchSummary"].update(outOfMemory=1),
            lambda r: r["report"]["jobs"][0]["validationResult"][0]["details"].update(passedChecks=0),
        ):
            value = copy.deepcopy(valid); mutate(value); variants.append((0, value))
        variants.extend([(3, valid), (1, validation(self.source, compliant=True))])
        for code, value in variants:
            with self.subTest(code=code), patch.object(worker, "run_bounded", return_value=(code, json.dumps(value).encode())), self.assertRaisesRegex(worker.WorkerError, "worker_failed"):
                worker.validate_ua(self.source, toolchain)

    def test_environment_drops_secrets_and_runtime_injection(self):
        with patch.dict("os.environ", {"LITELLM_API_KEY": "secret", "SUPABASE_SERVICE_ROLE_KEY": "secret", "JAVA_TOOL_OPTIONS": "unsafe", "HTTPS_PROXY": "unsafe", "PYTHONPATH": "unsafe"}):
            environment = worker.clean_environment()
        for key in ("LITELLM_API_KEY", "SUPABASE_SERVICE_ROLE_KEY", "JAVA_TOOL_OPTIONS", "HTTPS_PROXY", "PYTHONPATH"):
            self.assertNotIn(key, environment)
        self.assertEqual({}, worker.verify_pdf.REVIEWED_WHITESPACE_ARTIFACTS)

    def test_both_java_tools_use_request_owned_scratch_directory(self):
        for tool in ({"command": "java", "args": ["-jar", "/opt/tagger.jar"]},
                     {"command": "java", "args": ["-classpath", "/opt/validator/*", "MainClass"]}):
            command = worker.java_command(tool, ["input.pdf"], self.folder)
            self.assertEqual("-Djava.io.tmpdir=" + str(self.folder.resolve()), command[1])
            self.assertEqual("input.pdf", command[-1])
            self.assertNotIn("JAVA_TOOL_OPTIONS", " ".join(command))

    def test_native_errors_do_not_contain_document_text(self):
        self.assertEqual("native_pdf_worker_failed", str(worker.WorkerError("private student name")))

    def test_findings_use_resolved_form_page_and_accessible_label(self):
        inventory = {"page_content": [{"pageNumber": 1}], "tags": [
            {"id": "tag-1", "role": "Form", "pageNumber": None, "text": "", "children": [],
             "annotationLabels": ["Participant name"], "contentSequence": [{"kind": "objectReference", "pageNumber": 1}]}]}
        finding = worker.normalized_finding({"code": "placeholder_alternative", "severity": "error", "tagId": "tag-1"}, inventory)
        self.assertEqual(1, finding["pageNumber"])
        self.assertIn("Participant name", finding["location"])
        self.assertIn("form control", finding["message"])
        self.assertNotIn("image", finding["message"])

    def test_multi_page_tag_does_not_guess_a_single_page(self):
        inventory = {"page_content": [{"pageNumber": 1}, {"pageNumber": 2}], "tags": [
            {"id": "tag-1", "role": "Table", "pageNumber": None, "text": "", "children": ["tag-2", "tag-3"]},
            {"id": "tag-2", "role": "TR", "pageNumber": 1, "text": "", "children": []},
            {"id": "tag-3", "role": "TR", "pageNumber": 2, "text": "", "children": []}]}
        finding = worker.normalized_finding({"code": "missing_table_headers", "tagId": "tag-1"}, inventory)
        self.assertNotIn("pageNumber", finding)
        self.assertIn("Pages 1, 2", finding["location"])


if __name__ == "__main__":
    unittest.main()
