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


def link_bytes(text="Course reading guide", mutate=None):
    writer = PdfWriter(clone_from=PdfReader(io.BytesIO(pdf_bytes(tagged=True, text=text, link="https://example.edu/course"))))
    page = writer.pages[0]
    root = writer.root_object["/StructTreeRoot"]
    link = worker.native_nodes(writer)[1]
    link[NameObject("/S")] = NameObject("/Link")
    annotation_ref = page["/Annots"][0]
    annotation = annotation_ref.get_object()
    annotation[NameObject("/StructParent")] = NumberObject(1)
    annotation[NameObject("/Rect")] = ArrayObject([NumberObject(value) for value in (15, 35, 190, 60)])
    link[NameObject("/K")] = ArrayObject([NumberObject(0), DictionaryObject({NameObject("/Type"): NameObject("/OBJR"),
        NameObject("/Obj"): annotation_ref, NameObject("/Pg"): page.indirect_reference})])
    root["/ParentTree"]["/Nums"].extend([NumberObject(1), link.indirect_reference])
    if mutate:
        mutate(writer, link, annotation)
    output = io.BytesIO(); writer.write(output); return output.getvalue()


def many_link_bytes(count):
    writer = PdfWriter(clone_from=PdfReader(io.BytesIO(link_bytes())))
    page = writer.pages[0]; root = writer.root_object["/StructTreeRoot"]
    document = worker.native_nodes(writer)[0]
    links, annotations, numbers, paint = [], [], [], []
    for index in range(count):
        annotation = DictionaryObject({NameObject("/Type"): NameObject("/Annot"), NameObject("/Subtype"): NameObject("/Link"),
            NameObject("/Rect"): ArrayObject([NumberObject(value) for value in (15, 35, 190, 60)]),
            NameObject("/StructParent"): NumberObject(index+1),
            NameObject("/A"): DictionaryObject({NameObject("/S"): NameObject("/URI"), NameObject("/URI"): TextStringObject("https://example.edu/course")})})
        annotation_ref = writer._add_object(annotation); annotations.append(annotation_ref)
        link = DictionaryObject({NameObject("/Type"): NameObject("/StructElem"), NameObject("/S"): NameObject("/Link"),
            NameObject("/P"): document.indirect_reference, NameObject("/Pg"): page.indirect_reference,
            NameObject("/K"): ArrayObject([NumberObject(index), DictionaryObject({NameObject("/Type"): NameObject("/OBJR"),
                NameObject("/Obj"): annotation_ref, NameObject("/Pg"): page.indirect_reference})])})
        link_ref = writer._add_object(link); links.append(link_ref); numbers.extend([NumberObject(index+1), link_ref])
        paint.append(f"/Link <</MCID {index}>> BDC BT /F1 12 Tf 20 40 Td (Course reading guide) Tj ET EMC")
    page[NameObject("/Annots")] = ArrayObject(annotations)
    document[NameObject("/K")] = ArrayObject(links)
    root["/ParentTree"][NameObject("/Nums")] = ArrayObject([NumberObject(0), ArrayObject(links), *numbers])
    stream = DecodedStreamObject(); stream.set_data("\n".join(paint).encode())
    page[NameObject("/Contents")] = writer._add_object(stream)
    output = io.BytesIO(); writer.write(output); return output.getvalue()


class NativeLinkDescriptionTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.folder = Path(temporary.name)
        self.source = self.folder / "source.pdf"
        self.output = self.folder / "output.pdf"

    def repair(self, data):
        self.source.write_bytes(data)
        original = worker.open_pdf(data)
        plan = {"schemaVersion": 1, "candidateSha256": worker.digest(data), "operations": []}
        changes = worker.apply_plan(original, original, plan, self.output)
        return original, worker.open_pdf(self.output.read_bytes()), changes

    def test_missing_description_is_added_with_identical_pixels_content_and_destination(self):
        data = link_bytes()
        original, saved, changes = self.repair(data)
        self.assertEqual("Course reading guide", saved.pages[0]["/Annots"][0].get_object()["/Contents"])
        self.assertEqual(["link_description_added"], [item["code"] for item in changes])
        checks = worker.verify_pdf.compare_pdfs(self.source, self.output)
        self.assertTrue(checks["preservation"]["passed"])
        self.assertTrue(checks["preservation"]["pages"][0]["pixels_identical"])
        self.assertEqual(original.pages[0]["/Annots"][0].get_object()["/A"], saved.pages[0]["/Annots"][0].get_object()["/A"])
        self.assertEqual(original.get_fields(), saved.get_fields())
        self.assertEqual(original.pages[0].extract_text(), saved.pages[0].extract_text())
        self.assertEqual(data, self.source.read_bytes())

    def test_prepare_repairs_before_model_and_repair_is_idempotent(self):
        request = self.folder / "request.pdf"; request.write_bytes(link_bytes())
        with patch.object(worker, "response", side_effect=lambda source, result, changes, tools, **verification: changes):
            changes = worker.process("prepare", request, self.folder, {})
        self.assertEqual("link_description_added", changes[0]["code"])
        original, candidate = worker.open_pdf(request.read_bytes()), worker.open_pdf(self.output.read_bytes())
        plan = {"schemaVersion": 1, "candidateSha256": worker.digest(self.output.read_bytes()), "operations": []}
        next_output = self.folder / "again.pdf"
        self.assertEqual([], worker.apply_plan(original, candidate, plan, next_output))
        self.assertEqual(worker.annotation_states(candidate), worker.annotation_states(worker.open_pdf(next_output.read_bytes())))

    def test_resolved_internal_destination_is_retained(self):
        def destination(writer, link, annotation):
            annotation.pop("/A")
            annotation[NameObject("/Dest")] = ArrayObject([writer.pages[0].indirect_reference, NameObject("/Fit")])
        original, saved, changes = self.repair(link_bytes(mutate=destination))
        self.assertEqual("link_description_added", changes[0]["code"])
        old = worker.annotation_states(original)[(1, 1)]
        new = worker.annotation_states(saved)[(1, 1)]
        self.assertEqual(old["/Dest"], new["/Dest"])
        self.assertTrue(worker.verify_pdf.compare_pdfs(self.source, self.output)["preservation"]["passed"])

    def test_form_field_labels_values_and_widget_dictionary_stay_unchanged(self):
        def add_form(writer, link, annotation):
            page = writer.pages[0]; root = writer.root_object["/StructTreeRoot"]
            document = worker.native_nodes(writer)[0]
            widget = DictionaryObject({NameObject("/Type"): NameObject("/Annot"), NameObject("/Subtype"): NameObject("/Widget"),
                NameObject("/FT"): NameObject("/Tx"), NameObject("/T"): TextStringObject("comments"),
                NameObject("/TU"): TextStringObject("Optional comments"), NameObject("/V"): TextStringObject("Existing answer"),
                NameObject("/Rect"): ArrayObject([NumberObject(n) for n in (20, 10, 180, 30)]), NameObject("/StructParent"): NumberObject(2)})
            widget_ref = writer._add_object(widget); page["/Annots"].append(widget_ref)
            form = DictionaryObject({NameObject("/Type"): NameObject("/StructElem"), NameObject("/S"): NameObject("/Form"),
                NameObject("/P"): document.indirect_reference, NameObject("/Pg"): page.indirect_reference,
                NameObject("/K"): DictionaryObject({NameObject("/Type"): NameObject("/OBJR"), NameObject("/Obj"): widget_ref, NameObject("/Pg"): page.indirect_reference})})
            form_ref = writer._add_object(form); document["/K"].append(form_ref)
            root["/ParentTree"]["/Nums"].extend([NumberObject(2), form_ref])
            writer.root_object[NameObject("/AcroForm")] = DictionaryObject({NameObject("/Fields"): ArrayObject([widget_ref])})
        original, saved, changes = self.repair(link_bytes(mutate=add_form))
        self.assertEqual("link_description_added", changes[0]["code"])
        self.assertEqual(worker.annotation_states(original)[(1, 2)], worker.annotation_states(saved)[(1, 2)])
        self.assertEqual(original.get_fields(), saved.get_fields())
        self.assertEqual("Existing answer", saved.get_fields()["comments"]["/V"])
        self.assertTrue(worker.verify_pdf.compare_pdfs(self.source, self.output)["preservation"]["passed"])

    def test_existing_descriptions_including_blank_numeric_and_placeholder_are_preserved(self):
        for description in ("Existing authored explanation", "", "1", "Annotation"):
            with self.subTest(description=description):
                data = link_bytes(mutate=lambda w, link, annotation: annotation.__setitem__(NameObject("/Contents"), TextStringObject(description)))
                original = worker.open_pdf(data); writer = PdfWriter(clone_from=original)
                self.assertEqual([], worker.add_link_descriptions(original, original, writer))
                self.assertEqual(description, writer.pages[0]["/Annots"][0].get_object()["/Contents"])

    def test_authored_overrides_on_link_annotation_or_ancestor_are_not_bypassed(self):
        for position in ("link", "annotation", "ancestor"):
            for name in ("/Alt", "/ActualText"):
                def mutate(writer, link, annotation):
                    target = {"link": link, "annotation": annotation, "ancestor": worker.native_nodes(writer)[0]}[position]
                    target[NameObject(name)] = TextStringObject("Authored meaning")
                with self.subTest(position=position, name=name):
                    original = worker.open_pdf(link_bytes(mutate=mutate))
                    self.assertEqual({}, worker.native_link_descriptions(original))

    def test_generic_numeric_empty_and_private_use_labels_are_skipped(self):
        for text in ("1", "", "Click here", "Link", "Read more"):
            self.assertEqual({}, worker.native_link_descriptions(worker.open_pdf(link_bytes(text))))
        for text in ("bad\ue123label", "bad\ufffdlabel", "bad\u202elabel"):
            self.assertIsNone(worker.link_label(text))

    def test_ambiguous_structure_hidden_geometry_and_missing_actions_are_skipped(self):
        mutations = {
            "bad parent": lambda w, link, a: a.__setitem__(NameObject("/StructParent"), NumberObject(99)),
            "duplicate annotation alias": lambda w, link, a: w.pages[0]["/Annots"].append(w.pages[0]["/Annots"][0]),
            "duplicate owner": lambda w, link, a: link["/K"].append(link["/K"][1]),
            "duplicate MCID": lambda w, link, a: link["/K"].insert(0, NumberObject(0)),
            "hidden": lambda w, link, a: a.__setitem__(NameObject("/F"), NumberObject(2)),
            "off page": lambda w, link, a: a.__setitem__(NameObject("/Rect"), ArrayObject([NumberObject(n) for n in (500, 500, 600, 600)])),
            "missing action": lambda w, link, a: a.pop("/A"),
            "unresolved destination": lambda w, link, a: a.__setitem__(NameObject("/A"), DictionaryObject({NameObject("/S"): NameObject("/GoTo"), NameObject("/D"): TextStringObject("missing")})),
        }
        for name, mutate in mutations.items():
            with self.subTest(name=name):
                self.assertEqual({}, worker.native_link_descriptions(worker.open_pdf(link_bytes(mutate=mutate))))

    def test_mixed_graphics_invisible_text_and_inline_replacement_are_skipped(self):
        for addition in (b" 30 30 10 10 re f ", b" /Span <</ActualText (Other)>> BDC (Visible) Tj EMC "):
            def mutate(writer, link, annotation):
                stream = writer.pages[0].get_contents()
                stream.set_data(stream.get_data().replace(b" EMC", addition + b" EMC"))
                writer.pages[0][NameObject("/Contents")] = writer._add_object(stream)
            self.assertEqual({}, worker.native_link_descriptions(worker.open_pdf(link_bytes(mutate=mutate))))
        def invisible(writer, link, annotation):
            stream = writer.pages[0].get_contents(); stream.set_data(stream.get_data().replace(b"BT ", b"BT 3 Tr "))
            writer.pages[0][NameObject("/Contents")] = writer._add_object(stream)
        self.assertEqual({}, worker.native_link_descriptions(worker.open_pdf(link_bytes(mutate=invisible))))
        def restored_invisible(writer, link, annotation):
            stream = writer.pages[0].get_contents(); stream.set_data(stream.get_data().replace(b"BT ", b"3 Tr q 0 Tr Q BT "))
            writer.pages[0][NameObject("/Contents")] = writer._add_object(stream)
        self.assertEqual({}, worker.native_link_descriptions(worker.open_pdf(link_bytes(mutate=restored_invisible))))
        for prefix in (b"0 0 0 0 re W n ", b"0 0 0 0 re W* n ", b"4 Tr "):
            def clipped(writer, link, annotation):
                stream = writer.pages[0].get_contents(); stream.set_data(prefix + stream.get_data())
                writer.pages[0][NameObject("/Contents")] = writer._add_object(stream)
            self.assertEqual({}, worker.native_link_descriptions(worker.open_pdf(link_bytes(mutate=clipped))))

    def test_simple_underlined_text_is_allowed_but_complex_graphic_strokes_are_not(self):
        def with_stroke(program):
            def mutate(writer, link, annotation):
                stream = writer.pages[0].get_contents()
                stream.set_data(stream.get_data().replace(b" EMC", program + b" EMC"))
                writer.pages[0][NameObject("/Contents")] = writer._add_object(stream)
            return worker.open_pdf(link_bytes(mutate=mutate))
        normal = with_stroke(b" q 1 0 0 1 20 38 cm 0.9 w 0 0 m 160 0 l S Q ")
        self.assertEqual("Course reading guide", worker.native_link_descriptions(normal)[(1, 1)]["label"])
        for path in (b" 20 38 m 180 44 l S ", b" 20 38 m 100 38 l 180 38 l S ",
                     b" 20 38 m 180 38 l 5 w S ", b" 20 58 m 180 58 l S ",
                     b" 20 38 m 180 38 l 20 38 m 180 38 l S "):
            self.assertEqual({}, worker.native_link_descriptions(with_stroke(path)))
        for prefix in (b"0 0 200 100 re W n ", b"q 0 0 0 0 re W n Q "):
            def safe_crop(writer, link, annotation):
                stream = writer.pages[0].get_contents(); stream.set_data(prefix + stream.get_data())
                writer.pages[0][NameObject("/Contents")] = writer._add_object(stream)
            self.assertEqual(1, len(worker.native_link_descriptions(worker.open_pdf(link_bytes(mutate=safe_crop)))))

    def test_changed_native_text_or_destination_does_not_authorize_label_copy(self):
        original = worker.open_pdf(link_bytes())
        different_text = worker.open_pdf(link_bytes("Other reading guide"))
        different_uri = worker.open_pdf(link_bytes(mutate=lambda w, link, a: a["/A"].__setitem__(NameObject("/URI"), TextStringObject("https://example.edu/other"))))
        for candidate in (different_text, different_uri):
            self.assertEqual([], worker.add_link_descriptions(original, candidate, PdfWriter(clone_from=candidate)))

    def test_saved_wrong_label_unrelated_annotation_mutation_and_authored_overwrite_fail(self):
        original, saved, _ = self.repair(link_bytes())
        def change(name, value):
            return worker.open_pdf(modified(self.output.read_bytes(), lambda w: w.pages[0]["/Annots"][0].get_object().__setitem__(NameObject(name), value)))
        bad = [change("/Contents", TextStringObject("Invented explanation")), change("/F", NumberObject(4)),
               change("/Contents", NameObject("/Course-reading-guide"))]
        for candidate in bad:
            with self.assertRaisesRegex(worker.WorkerError, "preservation"):
                worker.verify_saved_annotations(original, original, candidate)
        authored = worker.open_pdf(link_bytes(mutate=lambda w, link, a: a.__setitem__(NameObject("/Contents"), TextStringObject("Authored"))))
        with self.assertRaisesRegex(worker.WorkerError, "preservation"):
            worker.verify_saved_annotations(authored, authored, saved)

    def test_unknown_added_description_is_rejected_on_repair_input(self):
        original = worker.open_pdf(link_bytes())
        candidate_data = modified(original.stream.getvalue(), lambda w: w.pages[0]["/Annots"][0].get_object().__setitem__(NameObject("/Contents"), TextStringObject("Wrong label")))
        candidate = worker.open_pdf(candidate_data)
        with self.assertRaisesRegex(worker.WorkerError, "preservation"):
            worker.apply_plan(original, candidate, {"schemaVersion": 1, "candidateSha256": worker.digest(candidate_data), "operations": []}, self.output)

    def test_untagged_sources_and_incomplete_text_are_not_guessed(self):
        original = worker.open_pdf(pdf_bytes(link="https://example.edu/course"))
        self.assertEqual({}, worker.native_link_descriptions(original))
        original = worker.open_pdf(link_bytes())
        inventory = worker.verify_pdf.structure_inventory(original)
        inventory["tags"][1]["textIncomplete"] = True
        with patch.object(worker.verify_pdf, "structure_inventory", return_value=inventory):
            self.assertEqual({}, worker.native_link_descriptions(original))

    def test_automatic_link_fix_has_its_own_bound(self):
        original = worker.open_pdf(link_bytes())
        with patch.object(worker, "MAX_LINK_DESCRIPTIONS", 0), patch.object(worker, "simple_link_paint") as paint:
            self.assertEqual([], worker.add_link_descriptions(original, original, PdfWriter(clone_from=original)))
            paint.assert_not_called()

    def test_201_links_repairs_200_and_leaves_remaining_link_unchanged(self):
        original = worker.open_pdf(many_link_bytes(201)); writer = PdfWriter(clone_from=original)
        with patch.object(worker, "simple_link_paint", wraps=worker.simple_link_paint) as paint:
            changes = worker.add_link_descriptions(original, original, writer)
        self.assertEqual(200, len(changes))
        self.assertEqual(400, paint.call_count)  # 200 source and 200 exact candidate matches.
        self.assertTrue(all("/Contents" in value.get_object() for value in writer.pages[0]["/Annots"][:200]))
        self.assertNotIn("/Contents", writer.pages[0]["/Annots"][200].get_object())
        saved = worker.write_pdf(writer, self.output)
        worker.verify_saved_annotations(original, original, saved)
        changed = modified(self.output.read_bytes(), lambda w: w.pages[0]["/Annots"][200].get_object().__setitem__(NameObject("/Contents"), TextStringObject("Course reading guide")))
        with self.assertRaisesRegex(worker.WorkerError, "complexity_limit"):
            worker.verify_added_link_descriptions(original, worker.open_pdf(changed))

    def test_complex_page_scan_budget_leaves_links_for_review(self):
        original = worker.open_pdf(many_link_bytes(3))
        count = len(worker.verify_pdf.operations(original.pages[0]))
        with patch.object(worker, "MAX_LINK_SCAN_OPERATIONS", count), patch.object(worker, "simple_link_paint", wraps=worker.simple_link_paint) as paint:
            result = worker.native_link_descriptions(original)
        self.assertEqual(1, len(result)); self.assertEqual(1, paint.call_count)


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
