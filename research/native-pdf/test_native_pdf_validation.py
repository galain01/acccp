"""Synthetic, local tests of the independent preservation checker."""
import io
from pathlib import Path
import tempfile
import unittest

from pypdf import PdfReader, PdfWriter
from pypdf.generic import ArrayObject, BooleanObject, DecodedStreamObject, DictionaryObject, NameObject, NumberObject, TextStringObject

import verify_pdf as v


def pdf_bytes(*, tagged=False, text="Hello", marked=True, artifact=False, fake_tree=False, alt=None, bad_parent=False, link=None):
    writer = PdfWriter()
    page = writer.add_blank_page(width=200, height=100)
    font = writer._add_object(DictionaryObject({NameObject("/Type"): NameObject("/Font"), NameObject("/Subtype"): NameObject("/Type1"), NameObject("/BaseFont"): NameObject("/Helvetica")}))
    page[NameObject("/Resources")] = DictionaryObject({NameObject("/Font"): DictionaryObject({NameObject("/F1"): font})})
    content = f"BT /F1 12 Tf 20 40 Td ({text}) Tj ET"
    if tagged and not fake_tree:
        content = ("/Artifact BMC " if artifact else "/P << /MCID 0 >> BDC ") + content + " EMC"
    stream = DecodedStreamObject()
    stream.set_data(content.encode("ascii"))
    page[NameObject("/Contents")] = writer._add_object(stream)
    if link:
        annotation = DictionaryObject({NameObject("/Type"): NameObject("/Annot"), NameObject("/Subtype"): NameObject("/Link"), NameObject("/Rect"): ArrayObject([NumberObject(20), NumberObject(40), NumberObject(60), NumberObject(55)]), NameObject("/Border"): ArrayObject([NumberObject(0)] * 3), NameObject("/A"): DictionaryObject({NameObject("/S"): NameObject("/URI"), NameObject("/URI"): TextStringObject(link)})})
        page[NameObject("/Annots")] = ArrayObject([writer._add_object(annotation)])
    if tagged:
        root = DictionaryObject({NameObject("/Type"): NameObject("/StructTreeRoot")})
        root_ref = writer._add_object(root)
        document = DictionaryObject({NameObject("/Type"): NameObject("/StructElem"), NameObject("/S"): NameObject("/Document"), NameObject("/P"): root_ref})
        document_ref = writer._add_object(document)
        paragraph = DictionaryObject({NameObject("/Type"): NameObject("/StructElem"), NameObject("/S"): NameObject("/Figure" if alt is not None else "/P"), NameObject("/P"): document_ref, NameObject("/Pg"): page.indirect_reference, NameObject("/K"): NumberObject(0)})
        if alt is not None:
            paragraph[NameObject("/Alt")] = TextStringObject(alt)
        paragraph_ref = writer._add_object(paragraph)
        document[NameObject("/K")] = ArrayObject([paragraph_ref])
        root[NameObject("/K")] = ArrayObject([document_ref])
        root[NameObject("/ParentTree")] = writer._add_object(DictionaryObject({NameObject("/Nums"): ArrayObject([NumberObject(0), ArrayObject([document_ref if bad_parent else paragraph_ref])])}))
        page[NameObject("/StructParents")] = NumberObject(0)
        writer._root_object[NameObject("/StructTreeRoot")] = root_ref
        writer._root_object[NameObject("/MarkInfo")] = DictionaryObject({NameObject("/Marked"): BooleanObject(marked)})
        writer._root_object[NameObject("/Lang")] = TextStringObject("en-US")
    data = io.BytesIO()
    writer.write(data)
    return data.getvalue()


def edited_reader(callback, *, link=False):
    writer = PdfWriter(clone_from=PdfReader(io.BytesIO(pdf_bytes(tagged=True, link="https://example.org/read" if link else None))))
    root = writer.root_object["/StructTreeRoot"]
    document = root["/K"][0].get_object()
    paragraph_ref = document["/K"][0]
    callback(writer, root, document, paragraph_ref, paragraph_ref.get_object())
    data = io.BytesIO()
    writer.write(data)
    return PdfReader(io.BytesIO(data.getvalue()))


def inline_link_reader(*, bad_parent=False, wrong_page=False, missing_object=False):
    def edit(writer, root, document, paragraph_ref, paragraph):
        page = writer.pages[0]
        annotation_ref = page["/Annots"][0]
        annotation_ref.get_object()[NameObject("/StructParent")] = NumberObject(1)
        link = DictionaryObject({NameObject("/Type"): NameObject("/StructElem"), NameObject("/S"): NameObject("/Link"), NameObject("/P"): paragraph_ref, NameObject("/Pg"): page.indirect_reference})
        link_ref = writer._add_object(link)
        objr = DictionaryObject({NameObject("/Type"): NameObject("/OBJR"), NameObject("/Obj"): annotation_ref, NameObject("/Pg"): page.indirect_reference})
        if wrong_page:
            objr[NameObject("/Pg")] = writer.add_blank_page(width=200, height=100).indirect_reference
        if missing_object:
            objr[NameObject("/Obj")] = writer._add_object(DictionaryObject({NameObject("/Type"): NameObject("/Annot"), NameObject("/Subtype"): NameObject("/Link")}))
        link[NameObject("/K")] = ArrayObject([objr, NumberObject(1)])
        paragraph[NameObject("/K")] = ArrayObject([NumberObject(0), link_ref, NumberObject(2)])
        root["/ParentTree"][NameObject("/Nums")] = ArrayObject([NumberObject(0), ArrayObject([paragraph_ref, link_ref, paragraph_ref]), NumberObject(1), paragraph_ref if bad_parent else link_ref])
        stream = DecodedStreamObject()
        stream.set_data(b"/P << /MCID 0 >> BDC BT /F1 12 Tf 20 40 Td (Before) Tj ET EMC /Link << /MCID 1 >> BDC BT /F1 12 Tf 60 40 Td (Link) Tj ET EMC /P << /MCID 2 >> BDC BT /F1 12 Tf 90 40 Td (After) Tj ET EMC")
        page[NameObject("/Contents")] = writer._add_object(stream)
    return edited_reader(edit, link=True)


class OperatorChecks(unittest.TestCase):
    def fingerprint(self, ops):
        return v.drawing_fingerprint(ops, v.Canonicalizer())

    def test_marked_wrappers_do_not_change_drawing(self):
        original = [([TextStringObject("abc")], b"Tj")]
        tagged = [([NameObject("/P"), DictionaryObject({NameObject("/MCID"): NumberObject(0)})], b"BDC"), *original, ([], b"EMC")]
        self.assertEqual(self.fingerprint(original), self.fingerprint(tagged))

    def test_split_text_show_is_equivalent(self):
        self.assertEqual(self.fingerprint([([b"abc"], b"Tj")]), self.fingerprint([([b"a"], b"Tj"), ([ArrayObject([b"bc"])], b"TJ")]))

    def test_changed_kerning_is_not_equivalent(self):
        self.assertNotEqual(self.fingerprint([([[b"a", 10, b"b"]], b"TJ")]), self.fingerprint([([[b"a", 20, b"b"]], b"TJ")]))

    def test_changed_text_is_not_equivalent(self):
        self.assertNotEqual(self.fingerprint([([b"abc"], b"Tj")]), self.fingerprint([([b"abd"], b"Tj")]))

    def test_duplicate_mcid_rejected(self):
        sequence = [([NameObject("/P"), DictionaryObject({NameObject("/MCID"): NumberObject(0)})], b"BDC"), ([], b"EMC")]
        with self.assertRaisesRegex(v.InspectionError, "duplicate"):
            v.scan_marked_content(sequence + sequence)

    def test_unbalanced_wrapper_rejected(self):
        with self.assertRaisesRegex(v.InspectionError, "unbalanced"):
            v.scan_marked_content([([], b"EMC")])

    def test_duplicate_parent_key_rejected(self):
        with self.assertRaises(v.InspectionError):
            v.number_tree({"/Nums": [0, [], 0, []]})


class PreservationChecks(unittest.TestCase):
    def compare(self, source, output, strict=False):
        with tempfile.TemporaryDirectory(prefix="native-pdf-check-") as directory:
            source_path, output_path = Path(directory) / "source.pdf", Path(directory) / "output.pdf"
            source_path.write_bytes(source)
            output_path.write_bytes(output)
            return v.compare_pdfs(source_path, output_path, strict)

    def test_valid_tagging_preserves_pixels_and_source(self):
        report = self.compare(pdf_bytes(), pdf_bytes(tagged=True), strict=True)
        self.assertTrue(report["passed"], report)
        self.assertTrue(report["preservation"]["fonts_identical"])
        self.assertTrue(report["preservation"]["pages"][0]["pixels_identical"])
        self.assertFalse(report["accessibility_ready"])
        self.assertFalse(report["certification"])
        tag = next(tag for tag in report["structure"]["tags"] if tag["role"] == "P")
        self.assertEqual(tag["pageNumber"], 1)
        self.assertEqual(tag["text"], "Hello")

    def test_changed_text_and_pixels_rejected(self):
        report = self.compare(pdf_bytes(), pdf_bytes(tagged=True, text="Changed"))
        self.assertFalse(report["passed"])
        self.assertFalse(report["preservation"]["pages"][0]["extracted_text_identical"])
        self.assertFalse(report["preservation"]["pages"][0]["pixels_identical"])

    def test_fake_tree_does_not_pass(self):
        report = self.compare(pdf_bytes(), pdf_bytes(tagged=True, fake_tree=True))
        self.assertTrue(report["preservation"]["passed"])
        self.assertFalse(report["structure"]["passed"])

    def test_missing_marked_flag_does_not_pass(self):
        report = self.compare(pdf_bytes(), pdf_bytes(tagged=True, marked=False))
        self.assertFalse(report["passed"])
        self.assertIn("missing_marked_flag", [finding["code"] for finding in report["structure"]["findings"]])

    def test_artifact_text_does_not_pass(self):
        report = self.compare(pdf_bytes(), pdf_bytes(tagged=True, artifact=True))
        self.assertFalse(report["passed"])

    def test_placeholder_alternative_does_not_pass(self):
        report = self.compare(pdf_bytes(), pdf_bytes(tagged=True, alt="image 1"))
        self.assertFalse(report["passed"])
        self.assertIn("placeholder_alternative", [finding["code"] for finding in report["structure"]["findings"]])

    def test_wrong_parent_tree_owner_does_not_pass(self):
        report = self.compare(pdf_bytes(), pdf_bytes(tagged=True, bad_parent=True))
        self.assertFalse(report["passed"])
        self.assertIn("parent_tree_owner_mismatch", [finding["code"] for finding in report["structure"]["findings"]])

    def test_changed_link_destination_rejected_even_when_pixels_match(self):
        report = self.compare(pdf_bytes(link="https://example.org/a"), pdf_bytes(tagged=True, link="https://example.org/b"))
        self.assertFalse(report["passed"])
        self.assertTrue(report["preservation"]["pages"][0]["pixels_identical"])
        self.assertFalse(report["preservation"]["pages"][0]["page_properties_identical"])

    def test_authored_alternative_change_is_reported(self):
        report = self.compare(pdf_bytes(tagged=True, alt="Authored description"), pdf_bytes(tagged=True, alt="Changed description"))
        self.assertFalse(report["structure"]["authored_alternative_strings_retained"])
        self.assertIn("authored_alternative_lost_or_changed", [finding["code"] for finding in report["findings"]])

    def test_missing_input_returns_controlled_diagnostic(self):
        report = v.compare_pdfs(Path("nonexistent-native-source.pdf"), Path("nonexistent-native-output.pdf"))
        self.assertTrue(report["inspection_incomplete"])
        self.assertEqual(report["findings"][0]["code"], "file_missing_or_too_large")


class SavedStructureEvidence(unittest.TestCase):
    def test_table_attributes_and_native_language_are_exposed(self):
        def edit(writer, root, document, ref, tag):
            tag[NameObject("/S")] = NameObject("/TH")
            tag[NameObject("/ID")] = TextStringObject("header-a")
            tag[NameObject("/Lang")] = TextStringObject("fr-FR")
            tag[NameObject("/A")] = DictionaryObject({NameObject("/O"): NameObject("/Table"), NameObject("/Scope"): NameObject("/Column"), NameObject("/RowSpan"): NumberObject(2), NameObject("/ColSpan"): NumberObject(3)})
        info = v.structure_inventory(edited_reader(edit))
        tag = next(tag for tag in info["tags"] if tag["role"] == "TH")
        self.assertEqual(tag["nativeId"], "header-a")
        self.assertEqual(tag["language"], "fr-FR")
        self.assertEqual(tag["effectiveLanguage"], "fr-FR")
        self.assertEqual(tag["attributes"][0], {"source": "direct", "owner": "Table", "scope": "Column", "rowSpan": 2, "colSpan": 3})

    def test_table_headers_resolve_to_actual_native_ids(self):
        def edit(writer, root, document, ref, tag):
            tag[NameObject("/S")] = NameObject("/TH")
            tag[NameObject("/ID")] = TextStringObject("header-a")
            cell = DictionaryObject({NameObject("/Type"): NameObject("/StructElem"), NameObject("/S"): NameObject("/TD"), NameObject("/P"): document.indirect_reference, NameObject("/K"): ArrayObject(), NameObject("/A"): DictionaryObject({NameObject("/O"): NameObject("/Table"), NameObject("/Headers"): ArrayObject([TextStringObject("header-a")])})})
            document["/K"].append(writer._add_object(cell))
        info = v.structure_inventory(edited_reader(edit))
        header = next(tag for tag in info["tags"] if tag["role"] == "TH")
        cell = next(tag for tag in info["tags"] if tag["role"] == "TD")
        self.assertTrue(cell["attributes"][0]["headersResolved"])
        self.assertEqual(cell["attributes"][0]["headerTagIds"], [header["id"]])

    def test_missing_header_id_is_an_explicit_gap(self):
        def edit(writer, root, document, ref, tag):
            tag[NameObject("/A")] = DictionaryObject({NameObject("/O"): NameObject("/Table"), NameObject("/Headers"): ArrayObject([TextStringObject("missing-header")])})
        info = v.structure_inventory(edited_reader(edit))
        self.assertFalse(info["checks_complete"])
        self.assertIn("unresolved_table_header_id", [finding["code"] for finding in info["findings"]])

    def test_class_based_table_scope_is_exposed(self):
        def edit(writer, root, document, ref, tag):
            root[NameObject("/ClassMap")] = DictionaryObject({NameObject("/HeaderStyle"): DictionaryObject({NameObject("/O"): NameObject("/Table"), NameObject("/Scope"): NameObject("/Both")})})
            tag[NameObject("/C")] = NameObject("/HeaderStyle")
        info = v.structure_inventory(edited_reader(edit))
        tag = next(tag for tag in info["tags"] if tag["role"] == "P")
        self.assertEqual(tag["attributes"][0], {"source": "class", "owner": "Table", "className": "HeaderStyle", "scope": "Both"})

    def test_inline_link_order_and_objr_identity_are_verified(self):
        info = v.structure_inventory(inline_link_reader())
        paragraph = next(tag for tag in info["tags"] if tag["role"] == "P")
        link = next(tag for tag in info["tags"] if tag["role"] == "Link")
        sequence = paragraph["contentSequence"]
        self.assertEqual([segment["kind"] for segment in sequence], ["markedContent", "childTag", "markedContent"])
        self.assertEqual(sequence[0]["text"].strip(), "Before")
        self.assertEqual(sequence[1]["tagId"], link["id"])
        self.assertEqual(sequence[2]["text"].strip(), "After")
        objr = link["contentSequence"][0]
        self.assertTrue(objr["resolved"])
        self.assertTrue(objr["parentTreeVerified"])
        self.assertEqual(objr["annotationId"], "p1-a1")
        self.assertEqual(objr["uri"], "https://example.org/read")
        self.assertEqual(link["contentSequence"][1]["text"].strip(), "Link")
        self.assertEqual(info["unresolved_content_references"], 0)

    def test_wrong_objr_parent_owner_remains_unresolved(self):
        info = v.structure_inventory(inline_link_reader(bad_parent=True))
        self.assertFalse(info["checks_complete"])
        self.assertIn("annotation_parent_tree_owner_mismatch", [finding["code"] for finding in info["findings"]])

    def test_objr_on_wrong_page_remains_unresolved(self):
        info = v.structure_inventory(inline_link_reader(wrong_page=True))
        self.assertFalse(info["checks_complete"])
        self.assertIn("object_reference_page_mismatch", [finding["code"] for finding in info["findings"]])

    def test_detached_annotation_does_not_pass_objr_resolution(self):
        info = v.structure_inventory(inline_link_reader(missing_object=True))
        self.assertFalse(info["checks_complete"])
        self.assertIn("annotation_object_not_uniquely_on_page", [finding["code"] for finding in info["findings"]])


if __name__ == "__main__":
    unittest.main()
