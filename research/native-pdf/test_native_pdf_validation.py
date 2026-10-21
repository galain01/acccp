"""Synthetic, local tests of the independent preservation checker."""
import io
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from pypdf import PdfReader, PdfWriter
from pypdf.generic import ArrayObject, BooleanObject, DecodedStreamObject, DictionaryObject, FloatObject, IndirectObject, NameObject, NullObject, NumberObject, TextStringObject

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


def named_link_reader(*, legacy=False, missing=False, direct=False, duplicate=False, broken_page=False):
    writer = PdfWriter(clone_from=inline_link_reader())
    page = writer.pages[0]
    annotation = page["/Annots"][0].get_object()
    name = NameObject("/chapter") if legacy else TextStringObject("chapter")
    destination = ArrayObject([page.indirect_reference, NameObject("/Fit")])
    if broken_page:
        destination[0] = writer._add_object(DictionaryObject({NameObject("/Type"): NameObject("/Page")}))
    if direct:
        del annotation[NameObject("/A")]
        annotation[NameObject("/Dest")] = name
    else:
        annotation[NameObject("/A")] = DictionaryObject({NameObject("/S"): NameObject("/GoTo"), NameObject("/D"): name})
    if not missing:
        if legacy:
            writer.root_object[NameObject("/Dests")] = DictionaryObject({name: DictionaryObject({NameObject("/D"): destination})})
        else:
            values = ArrayObject([name, destination])
            if duplicate:
                values.extend([name, destination])
            leaf = writer._add_object(DictionaryObject({NameObject("/Names"): values}))
            writer.root_object[NameObject("/Names")] = DictionaryObject({NameObject("/Dests"): DictionaryObject({NameObject("/Kids"): ArrayObject([leaf])})})
    data = io.BytesIO()
    writer.write(data)
    return PdfReader(io.BytesIO(data.getvalue()))


def figure_reader(*, kind="image", alts=("Left figure", "Right figure"), callback=None):
    """Two distinct occurrences sharing the same image/Form resource when used."""
    writer = PdfWriter(clone_from=PdfReader(io.BytesIO(pdf_bytes(tagged=True))))
    page = writer.pages[0]
    root = writer.root_object["/StructTreeRoot"]
    document = root["/K"][0].get_object()
    asset = DecodedStreamObject()
    if kind == "image":
        asset.update({NameObject("/Type"): NameObject("/XObject"), NameObject("/Subtype"): NameObject("/Image"), NameObject("/Width"): NumberObject(1), NameObject("/Height"): NumberObject(1), NameObject("/ColorSpace"): NameObject("/DeviceGray"), NameObject("/BitsPerComponent"): NumberObject(8)})
        asset.set_data(b"\x80")
    elif kind == "form":
        asset.update({NameObject("/Type"): NameObject("/XObject"), NameObject("/Subtype"): NameObject("/Form"), NameObject("/BBox"): ArrayObject([NumberObject(n) for n in (0, 0, 30, 20)]), NameObject("/Resources"): DictionaryObject()})
        asset.set_data(b"0 0 30 20 re f")
    asset_ref = writer._add_object(asset) if kind in ("image", "form") else None
    if asset_ref is not None:
        page["/Resources"][NameObject("/XObject")] = DictionaryObject({NameObject("/Im0"): asset_ref})
    refs = []
    bodies = []
    for number, alt in enumerate(alts):
        tag = DictionaryObject({NameObject("/Type"): NameObject("/StructElem"), NameObject("/S"): NameObject("/Figure"), NameObject("/P"): document.indirect_reference, NameObject("/Pg"): page.indirect_reference, NameObject("/K"): NumberObject(number), NameObject("/Alt"): TextStringObject(alt)})
        refs.append(writer._add_object(tag))
        if kind in ("image", "form"):
            body = f"q 30 0 0 30 {20 + number * 70} 20 cm /Im0 Do Q"
        else:
            body = f"q 0 0 0 rg {20 + number * 70} 20 30 20 re f BT /F1 10 Tf {20 + number * 70} 45 Td (Label{number}) Tj ET Q"
        bodies.append(f"/Figure << /MCID {number} >> BDC {body} EMC")
    document[NameObject("/K")] = ArrayObject(refs)
    root["/ParentTree"][NameObject("/Nums")] = ArrayObject([NumberObject(0), ArrayObject(refs)])
    stream = DecodedStreamObject()
    stream.set_data(" ".join(bodies).encode("ascii"))
    page[NameObject("/Contents")] = writer._add_object(stream)
    if callback:
        callback(writer, page, root, document, refs, stream, asset_ref)
    data = io.BytesIO()
    writer.write(data)
    return PdfReader(io.BytesIO(data.getvalue()))


def native_form_reader(*, bad_parent=False, reused=False, artifact=False, detached=False, orphan=False, malformed=None):
    def edit(writer, root, document, ref, tag):
        page = writer.pages[0]
        form = DecodedStreamObject()
        form.update({NameObject("/Type"): NameObject("/XObject"), NameObject("/Subtype"): NameObject("/Form"), NameObject("/BBox"): ArrayObject([NumberObject(n) for n in (0, 0, 200, 100)]), NameObject("/Resources"): DictionaryObject({NameObject("/Font"): page["/Resources"]["/Font"]})})
        form.set_data((b"/Artifact BMC " if artifact else b"/P << /MCID 0 >> BDC ") + b"BT /F1 12 Tf 20 40 Td (Form text) Tj ET EMC")
        if malformed == "nested":
            form.set_data(form.get_data().replace(b"BT ", b"/Span << /MCID 1 >> BDC BT ") + b" EMC")
        elif malformed == "negative":
            form.set_data(form.get_data().replace(b"/MCID 0", b"/MCID -1"))
        elif malformed == "properties":
            form.set_data(form.get_data().replace(b"<< /MCID 0 >>", b"/MissingProperties"))
        form_ref = writer._add_object(form)
        page["/Resources"][NameObject("/XObject")] = DictionaryObject({NameObject("/Fm0"): form_ref})
        stream = DecodedStreamObject()
        stream.set_data(b"/Fm0 Do /Fm0 Do" if reused else b"/Fm0 Do")
        page[NameObject("/Contents")] = writer._add_object(stream)
        if artifact:
            tag[NameObject("/K")] = ArrayObject()
            root["/ParentTree"][NameObject("/Nums")] = ArrayObject([NumberObject(0), ArrayObject()])
        else:
            form[NameObject("/StructParents")] = NumberObject(2)
            target = writer._add_object(DecodedStreamObject()) if detached else form_ref
            tag[NameObject("/K")] = ArrayObject() if orphan else DictionaryObject({NameObject("/Type"): NameObject("/MCR"), NameObject("/Pg"): page.indirect_reference, NameObject("/Stm"): target, NameObject("/MCID"): NumberObject(0)})
            root["/ParentTree"][NameObject("/Nums")] = ArrayObject([NumberObject(0), ArrayObject(), NumberObject(2), ArrayObject([document.indirect_reference if bad_parent else ref])])
    return edited_reader(edit)


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

    def test_equivalent_numeric_serialization_is_identical(self):
        self.assertEqual(v.Canonicalizer().hash([FloatObject(1.0), FloatObject(0.5)]), v.Canonicalizer().hash([NumberObject(1), FloatObject(0.5)]))

    def test_binary_float_noise_is_normalized_but_geometry_changes_are_not(self):
        self.assertEqual(v.Canonicalizer().hash(FloatObject(208.88400000000001)), v.Canonicalizer().hash(FloatObject(208.884)))
        self.assertNotEqual(v.Canonicalizer().hash(FloatObject(208.88401)), v.Canonicalizer().hash(FloatObject(208.884)))

    def test_page_reference_identity_includes_owning_reader(self):
        source = PdfReader(io.BytesIO(pdf_bytes()))
        output = PdfReader(io.BytesIO(pdf_bytes()))
        page_ref = output.pages[0].indirect_reference
        foreign = DictionaryObject({NameObject("/Meaning"): NameObject("/Font")})
        foreign.indirect_reference = IndirectObject(page_ref.idnum, page_ref.generation, source)
        self.assertEqual(v.Canonicalizer(list(output.pages)).value(foreign), {"/Meaning": "/Font"})

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
    def test_filtered_text_uses_font_tounicode_in_tags_and_artifacts(self):
        def edit(writer, root, document, ref, tag):
            font = writer.pages[0]["/Resources"]["/Font"]["/F1"]
            mapping = DecodedStreamObject()
            mapping.set_data(b"/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def /CMapName /NativeTest def /CMapType 2 def 1 begincodespacerange <00> <ff> endcodespacerange 2 beginbfchar <80> <2265> <81> <2020> endbfchar endcmap CMapName currentdict /CMap defineresource pop end end")
            font[NameObject("/ToUnicode")] = writer._add_object(mapping)
            stream = DecodedStreamObject()
            stream.set_data(b"/P << /MCID 0 >> BDC BT /F1 12 Tf 20 40 Td <80> Tj ET EMC /Artifact BMC BT /F1 12 Tf 20 10 Td <81> Tj ET EMC")
            writer.pages[0][NameObject("/Contents")] = writer._add_object(stream)
        info = v.structure_inventory(edited_reader(edit))
        self.assertEqual(next(tag for tag in info["tags"] if tag["role"] == "P")["text"].strip(), "\u2265")
        self.assertEqual(info["page_content"][0]["artifactText"].strip(), "\u2020")

    def test_artifact_text_is_decoded_and_separate_from_tag_text(self):
        def edit(writer, root, document, ref, tag):
            stream = DecodedStreamObject()
            stream.set_data(b"/P << /MCID 0 >> BDC BT /F1 12 Tf 20 40 Td (Meaningful text) Tj ET /Artifact BMC BT /F1 10 Tf 20 10 Td (Page 1) Tj ET EMC EMC")
            writer.pages[0][NameObject("/Contents")] = writer._add_object(stream)
        info = v.structure_inventory(edited_reader(edit))
        self.assertEqual(info["page_content"][0]["artifactText"].strip(), "Page 1")
        self.assertTrue(info["page_content"][0]["artifactTextComplete"])
        self.assertEqual(next(tag for tag in info["tags"] if tag["role"] == "P")["text"].strip(), "Meaningful text")

    def test_artifact_text_bounds_cannot_silently_pass(self):
        info = v.structure_inventory(PdfReader(io.BytesIO(pdf_bytes(tagged=True, artifact=True, text="X" * (v.MAX_ARTIFACT_TEXT_CHARS + 1)))))
        self.assertEqual(len(info["page_content"][0]["artifactText"]), v.MAX_ARTIFACT_TEXT_CHARS)
        self.assertFalse(info["page_content"][0]["artifactTextComplete"])
        self.assertFalse(info["checks_complete"])

    def test_leaf_vector_form_has_complete_empty_artifact_text(self):
        info = v.structure_inventory(figure_reader(kind="form"))
        self.assertTrue(info["page_content"][0]["artifactTextComplete"])
        self.assertEqual(info["page_content"][0]["artifactText"], "")

    def test_unique_form_mcr_resolves_actual_text_and_parent_tree(self):
        info = v.structure_inventory(native_form_reader())
        tag = next(tag for tag in info["tags"] if tag["role"] == "P")
        self.assertEqual(tag["text"].strip(), "Form text")
        self.assertTrue(tag["contentSequence"][0]["resolved"])
        self.assertTrue(tag["contentSequence"][0]["parentTreeVerified"])
        self.assertEqual(tag["contentSequence"][0]["streamId"], "form-1")
        self.assertEqual(info["unresolved_content_references"], 0)
        self.assertTrue(info["checks_complete"])

    def test_wrong_form_parent_tree_does_not_pass(self):
        info = v.structure_inventory(native_form_reader(bad_parent=True))
        self.assertFalse(info["machine_checks_passed"])
        self.assertIn("parent_tree_owner_mismatch", [f["code"] for f in info["findings"]])

    def test_semantic_form_reuse_is_an_explicit_gap(self):
        info = v.structure_inventory(native_form_reader(reused=True))
        self.assertFalse(info["page_content"][0]["artifactTextComplete"])
        self.assertFalse(info["checks_complete"])
        self.assertIn("ambiguous_form_content_invocation", [f["code"] for f in info["findings"]])

    def test_repeated_artifact_form_text_is_exposed_for_each_occurrence(self):
        info = v.structure_inventory(native_form_reader(artifact=True, reused=True))
        self.assertEqual(info["page_content"][0]["artifactText"].count("Form text"), 2)
        self.assertEqual(info["page_content"][0]["form_artifact_text_operators"], 2)
        self.assertTrue(info["page_content"][0]["artifactTextComplete"])

    def test_detached_form_stream_mcr_is_unresolved(self):
        info = v.structure_inventory(native_form_reader(detached=True))
        self.assertEqual(info["unresolved_content_references"], 1)
        self.assertFalse(info["checks_complete"])

    def test_form_mcid_without_structure_owner_is_rejected(self):
        info = v.structure_inventory(native_form_reader(orphan=True))
        self.assertIn("unowned_form_marked_content", [f["code"] for f in info["findings"]])

    def test_malformed_or_nested_form_mcids_remain_explicit_gaps(self):
        for mutation, code in [("nested", "nested_form_mcid_scope_unsupported"), ("negative", "invalid_form_mcid"), ("properties", "invalid_form_marked_content_properties")]:
            with self.subTest(mutation=mutation):
                info = v.structure_inventory(native_form_reader(malformed=mutation))
                self.assertFalse(info["checks_complete"])
                self.assertIn(code, [f["code"] for f in info["findings"]])

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
            cell_ref = writer._add_object(cell)
            table = DictionaryObject({NameObject('/Type'): NameObject('/StructElem'), NameObject('/S'): NameObject('/Table'), NameObject('/P'): document.indirect_reference})
            table_ref = writer._add_object(table)
            row = DictionaryObject({NameObject('/Type'): NameObject('/StructElem'), NameObject('/S'): NameObject('/TR'), NameObject('/P'): table_ref, NameObject('/K'): ArrayObject([ref, cell_ref])})
            row_ref = writer._add_object(row)
            table[NameObject('/K')] = ArrayObject([row_ref])
            tag[NameObject('/P')] = row_ref
            cell[NameObject('/P')] = row_ref
            document[NameObject('/K')] = ArrayObject([table_ref if child == ref else child for child in document['/K']])
            root[NameObject('/IDTree')] = DictionaryObject({NameObject('/Names'): ArrayObject([TextStringObject('header-a'), ref])})
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
        self.assertEqual(info["unresolved_local_destinations"], 0)
        self.assertNotIn("destinationResolved", objr)

    def test_named_destinations_resolve_native_name_tree_and_legacy_dictionary(self):
        for legacy in (False, True):
            for direct in (False, True):
                with self.subTest(legacy=legacy, direct=direct):
                    info = v.structure_inventory(named_link_reader(legacy=legacy, direct=direct))
                    objr = next(tag for tag in info["tags"] if tag["role"] == "Link")["contentSequence"][0]
                    self.assertTrue(info["checks_complete"], info["findings"])
                    self.assertTrue(info["machine_checks_passed"])
                    self.assertTrue(objr["destinationResolved"])
                    self.assertEqual(objr["destinationPageNumber"], 1)
                    self.assertEqual(objr["destinationView"], "Fit")

    def test_missing_named_destination_blocks_completion_even_when_objr_resolves(self):
        for legacy in (False, True):
            with self.subTest(legacy=legacy):
                info = v.structure_inventory(named_link_reader(legacy=legacy, missing=True))
                objr = next(tag for tag in info["tags"] if tag["role"] == "Link")["contentSequence"][0]
                self.assertTrue(objr["resolved"])
                self.assertFalse(objr["destinationResolved"])
                self.assertFalse(info["checks_complete"])
                self.assertFalse(info["machine_checks_passed"])
                self.assertEqual(info["unresolved_local_destinations"], 1)
                self.assertIn("local_link_destination_unresolved", [finding["code"] for finding in info["findings"]])

    def test_ambiguous_named_destination_is_not_guessed(self):
        info = v.structure_inventory(named_link_reader(duplicate=True))
        self.assertFalse(info["checks_complete"])
        self.assertEqual(next(f for f in info["findings"] if f["code"] == "local_link_destination_unresolved")["reason"], "ambiguous_named_destination")

    def test_named_destination_must_point_to_a_real_document_page(self):
        info = v.structure_inventory(named_link_reader(broken_page=True))
        self.assertFalse(info["checks_complete"])
        self.assertEqual(next(f for f in info["findings"] if f["code"] == "local_link_destination_unresolved")["reason"], "destination_page_missing")

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


class AuthoredFigureAssociation(unittest.TestCase):
    def compare(self, source=None, output=None):
        return v.compare_figure_associations(source or figure_reader(), output or figure_reader())

    def test_identical_image_payloads_are_distinguished_by_occurrence(self):
        self.assertTrue(self.compare()["passed"])
        changed = figure_reader(alts=("Right figure", "Left figure"))
        result = self.compare(output=changed)
        self.assertFalse(result["passed"])
        self.assertTrue(all(row["membershipVerified"] for row in result["comparisons"]))
        self.assertEqual({row["failureCode"] for row in result["comparisons"]}, {"authored_figure_description_changed"})

    def test_mcid_renumbering_preserves_figure_identity(self):
        def change(writer, page, root, document, refs, stream, asset):
            stream.set_data(stream.get_data().replace(b"MCID 0", b"MCID 2").replace(b"MCID 1", b"MCID 3"))
            for number, ref in enumerate(refs, 2):
                ref.get_object()[NameObject("/K")] = NumberObject(number)
            root["/ParentTree"][NameObject("/Nums")] = ArrayObject([NumberObject(0), ArrayObject([NullObject(), NullObject(), *refs])])
        self.assertTrue(self.compare(output=figure_reader(callback=change))["passed"])

    def test_vector_paths_and_text_are_both_members(self):
        result = self.compare(figure_reader(kind="vector"), figure_reader(kind="vector"))
        self.assertTrue(result["passed"])
        self.assertEqual(result["comparisons"][0]["sourcePaintCount"], 7)

    def test_split_tj_and_tj_array_preserve_membership(self):
        def change(writer, page, root, document, refs, stream, asset):
            stream.set_data(stream.get_data().replace(b"(Label0) Tj", b"(La) Tj [(bel0)] TJ"))
        self.assertTrue(self.compare(figure_reader(kind="vector"), figure_reader(kind="vector", callback=change))["passed"])

    def test_vector_path_hidden_as_artifact_is_rejected(self):
        def change(writer, page, root, document, refs, stream, asset):
            stream.set_data(stream.get_data().replace(b"30 20 re f", b"30 20 re /Artifact BMC f EMC", 1))
        result = self.compare(figure_reader(kind="vector"), figure_reader(kind="vector", callback=change))
        self.assertFalse(result["passed"])
        self.assertEqual(result["comparisons"][0]["failureCode"], "source_figure_hidden_as_artifact")

    def test_text_removed_from_vector_figure_is_rejected(self):
        def change(writer, page, root, document, refs, stream, asset):
            stream.set_data(stream.get_data().replace(b"(Label0) Tj", b"EMC (Label0) Tj /Figure BMC"))
        result = self.compare(figure_reader(kind="vector"), figure_reader(kind="vector", callback=change))
        self.assertFalse(result["passed"])
        self.assertEqual(result["comparisons"][0]["failureCode"], "source_figure_membership_changed")

    def test_copied_alt_on_empty_tag_does_not_preserve_authored_figure(self):
        def change(writer, page, root, document, refs, stream, asset):
            refs[0].get_object()[NameObject("/K")] = ArrayObject()
        self.assertFalse(self.compare(output=figure_reader(callback=change))["passed"])

    def test_exact_punctuation_and_actual_text_are_retained(self):
        authored = 'Chart "A" [group] & <value>'
        def exact(writer, page, root, document, refs, stream, asset):
            refs[0].get_object()[NameObject("/ActualText")] = TextStringObject("Authored replacement & detail")
        source = figure_reader(alts=(authored, "Right figure"), callback=exact)
        self.assertTrue(self.compare(source, figure_reader(alts=(authored, "Right figure"), callback=exact))["passed"])
        self.assertFalse(self.compare(source, figure_reader(alts=("Chart A group value", "Right figure"), callback=exact))["passed"])
        self.assertFalse(self.compare(source, figure_reader(alts=(authored, "Right figure")))["passed"])

    def test_reused_form_is_explicitly_unsupported(self):
        result = self.compare(figure_reader(kind="form"), figure_reader(kind="form"))
        self.assertFalse(result["passed"])
        self.assertFalse(result["checksComplete"])
        self.assertIn("reused_form_figure_unsupported", result["comparisons"][0]["gaps"])

    def test_internal_form_mcid_is_explicitly_unsupported(self):
        def change(writer, page, root, document, refs, stream, asset):
            refs[0].get_object()[NameObject("/K")] = DictionaryObject({NameObject("/Type"): NameObject("/MCR"), NameObject("/Pg"): page.indirect_reference, NameObject("/Stm"): asset, NameObject("/MCID"): NumberObject(0)})
        source = figure_reader(kind="form", callback=change)
        result = self.compare(source, source)
        self.assertFalse(result["passed"])
        self.assertIn("internal_form_mcid_unsupported", result["comparisons"][0]["gaps"])


def replacement_reader(values=('\u00ad','Other & <word>'), *, hide_first=False, wrong_owner=False):
    def change(writer,page,root,document,refs,stream,asset):
        bodies=[]
        for index,ref in enumerate(refs):
            node=ref.get_object();node[NameObject('/S')]=NameObject('/Span');node.pop('/Alt',None)
            if values[index] is not None:node[NameObject('/ActualText')]=TextStringObject(values[index])
            prefix='/Artifact BMC' if hide_first and index==0 else f'/Span << /MCID {index} >> BDC'
            bodies.append(prefix+f' BT /F1 12 Tf {20+index*70} 40 Td (-) Tj ET EMC')
        stream.set_data(' '.join(bodies).encode('ascii'))
        if wrong_owner:root['/ParentTree']['/Nums'][1][0]=refs[1]
    return figure_reader(kind='text',callback=change)


def inline_replacement_reader(values=('\t','\u00a0'), *, nested=False, artifact=False, painted_space=False):
    writer=PdfWriter(clone_from=replacement_reader((None,None)))
    page=writer.pages[0];stream=page.get_contents();changed=[];index=0
    for args,operator in stream.operations:
        if operator==b'Tj':
            if painted_space:args=[TextStringObject(' ')]
            value=values[index]
            if artifact and index==0:changed.append(([NameObject('/Artifact')],b'BMC'))
            if value is not None:
                entry=([NameObject('/Span'),DictionaryObject({NameObject('/ActualText'):TextStringObject(value)})],b'BDC')
                changed.append(entry)
                if nested and index==0:changed.append(entry)
            changed.append((args,operator))
            if value is not None:
                if nested and index==0:changed.append(([],b'EMC'))
                changed.append(([],b'EMC'))
            if artifact and index==0:changed.append(([],b'EMC'))
            index+=1
        else:changed.append((args,operator))
    stream.operations=changed;page.replace_contents(stream)
    data=io.BytesIO();writer.write(data);return PdfReader(io.BytesIO(data.getvalue()),strict=True)


class ActualTextAssociationChecks(unittest.TestCase):
    def test_exact_authored_soft_hyphen_and_escaped_text_stay_on_same_paint(self):
        result=v.compare_actual_text_associations(replacement_reader(),replacement_reader())
        self.assertTrue(result['passed']);self.assertEqual(result['sourceReplacementCount'],2)
    def test_plain_hyphen_cannot_replace_authored_soft_hyphen(self):
        result=v.compare_actual_text_associations(replacement_reader(),replacement_reader(('-', 'Other & <word>')))
        self.assertFalse(result['passed']);self.assertEqual(result['comparisons'][0]['failureCode'],'authored_actual_text_changed')
    def test_lost_actual_text_fails_even_when_all_painted_bytes_are_unchanged(self):
        source=replacement_reader();output=replacement_reader((None,None))
        with tempfile.TemporaryDirectory() as directory:
            before=Path(directory)/'source.pdf';after=Path(directory)/'output.pdf'
            before.write_bytes(source.stream.getvalue());after.write_bytes(output.stream.getvalue())
            result=v.compare_pdfs(before,after)
        self.assertTrue(result['preservation']['pages'][0]['pixels_identical'])
        self.assertTrue(result['preservation']['pages'][0]['drawing_operators_identical'])
        self.assertFalse(result['preservation']['passed'])
        self.assertIn('authored_actual_text_membership_lost',[f['code'] for f in result['findings']])
    def test_same_strings_swapped_between_identical_glyphs_do_not_pass(self):
        result=v.compare_actual_text_associations(replacement_reader(),replacement_reader(('Other & <word>','\u00ad')))
        self.assertFalse(result['passed']);self.assertTrue(all(r['failureCode']=='authored_actual_text_changed' for r in result['comparisons']))
    def test_copying_missing_span_value_elsewhere_does_not_restore_original_membership(self):
        result=v.compare_actual_text_associations(replacement_reader(('\u00ad','\u00ad')),replacement_reader((None,'\u00ad')))
        self.assertFalse(result['passed']);self.assertEqual(result['comparisons'][0]['candidateCount'],0)
    def test_hidden_span_is_explicitly_reported(self):
        result=v.compare_actual_text_associations(replacement_reader(),replacement_reader(hide_first=True))
        self.assertFalse(result['passed']);self.assertEqual(result['comparisons'][0]['failureCode'],'authored_actual_text_hidden_as_artifact')
    def test_wrong_native_owner_is_not_proof_of_retained_replacement(self):
        result=v.compare_actual_text_associations(replacement_reader(),replacement_reader(wrong_owner=True))
        self.assertFalse(result['passed']);self.assertEqual(result['comparisons'][0]['candidateCount'],0)
    def test_internal_form_replacement_remains_explicitly_unverified(self):
        reader=native_form_reader();writer=PdfWriter(clone_from=reader)
        writer.root_object['/StructTreeRoot']['/K'][0].get_object()['/K'][0].get_object()[NameObject('/ActualText')]=TextStringObject('Form replacement')
        out=io.BytesIO();writer.write(out);source=PdfReader(io.BytesIO(out.getvalue()))
        result=v.compare_actual_text_associations(source,source)
        self.assertFalse(result['passed']);self.assertFalse(result['checksComplete'])
        self.assertIn('internal_form_mcid_unsupported',result['comparisons'][0]['gaps'])
    def test_authorized_change_wrapper_cannot_hide_missing_actual_text(self):
        from font_validation import verify_other_content
        self.assertTrue(verify_other_content(replacement_reader(),replacement_reader())['actualTextAssociations']['passed'])
        with self.assertRaisesRegex(v.InspectionError,'authored_actual_text_association_changed'):
            verify_other_content(replacement_reader(),replacement_reader((None,None)))
    def test_marked_content_property_override_is_not_silently_stripped(self):
        source=replacement_reader();writer=PdfWriter(clone_from=source);page=writer.pages[0]
        stream=DecodedStreamObject();stream.set_data(page.get_contents().get_data().replace(b'/MCID 0',b'/MCID 0 /ActualText (Different hidden text)'))
        page[NameObject('/Contents')]=writer._add_object(stream);out=io.BytesIO();writer.write(out)
        result=v.compare_actual_text_associations(source,PdfReader(io.BytesIO(out.getvalue())))
        self.assertFalse(result['passed']);self.assertFalse(result['checksComplete'])
        self.assertEqual(len(result['unexpectedOutputInlineReplacements']),1)
    def test_inline_authored_whitespace_keeps_exact_occurrence_and_value(self):
        result=v.compare_actual_text_associations(inline_replacement_reader(),inline_replacement_reader())
        self.assertTrue(result['passed']);self.assertTrue(result['checksComplete'])
        self.assertEqual(result['sourceInlineReplacementCount'],2)
        self.assertTrue(all(row['membershipVerified'] for row in result['markedContentComparisons']))
    def test_inline_replacements_cannot_be_dropped_or_swapped(self):
        source=inline_replacement_reader()
        for output in (inline_replacement_reader((None,'\u00a0')),inline_replacement_reader(('\u00a0','\t'))):
            self.assertFalse(v.compare_actual_text_associations(source,output)['passed'])
    def test_extra_inline_replacement_is_not_authorized_by_a_matching_native_span(self):
        result=v.compare_actual_text_associations(inline_replacement_reader((None,None)),inline_replacement_reader())
        self.assertFalse(result['passed']);self.assertFalse(result['checksComplete'])
        self.assertEqual(len(result['unexpectedOutputInlineReplacements']),2)
    def test_nested_inline_replacement_scopes_are_explicitly_unsupported(self):
        result=v.compare_actual_text_associations(inline_replacement_reader(nested=True),inline_replacement_reader(nested=True))
        self.assertFalse(result['passed']);self.assertFalse(result['checksComplete'])
        self.assertEqual(result['unsupportedMarkedContentActualText']['sourcePages'],[1])
    def test_inline_replacement_cannot_be_silently_hidden_as_artifact(self):
        result=v.compare_actual_text_associations(inline_replacement_reader(),inline_replacement_reader(artifact=True))
        self.assertFalse(result['passed'])
        self.assertEqual(result['markedContentComparisons'][0]['failureCode'],'authored_inline_actual_text_artifact_membership_changed')
    def test_same_inline_replacement_in_original_artifact_stays_verified(self):
        result=v.compare_actual_text_associations(inline_replacement_reader(artifact=True),inline_replacement_reader(artifact=True))
        self.assertTrue(result['passed'])
    def test_only_reviewed_source_bound_spacing_can_change_artifact_ancestry(self):
        source=inline_replacement_reader(painted_space=True);output=inline_replacement_reader(artifact=True,painted_space=True)
        scope=v.figure_association_inventory(source)['inlineReplacementTexts'][0]
        policy={v.digest(source.stream.getvalue()):{scope['membershipHash']:'reviewed blank paragraph'}}
        self.assertFalse(v.compare_actual_text_associations(source,output)['passed'])
        with patch.object(v,'REVIEWED_WHITESPACE_ARTIFACTS',policy):
            result=v.compare_actual_text_associations(source,output)
            self.assertTrue(result['passed'])
            self.assertTrue(result['markedContentComparisons'][0]['reviewedWhitespaceArtifactChange']['allowed'])
        with patch.object(v,'REVIEWED_WHITESPACE_ARTIFACTS',{'0'*64:policy[next(iter(policy))]}):
            self.assertFalse(v.compare_actual_text_associations(source,output)['passed'])
    def test_reviewed_spacing_rule_never_allows_hidden_meaningful_replacement_or_glyph(self):
        for values,painted_space in [(('meaningful word','\u00a0'),True),(('\t','\u00a0'),False)]:
            source=inline_replacement_reader(values,painted_space=painted_space)
            output=inline_replacement_reader(values,artifact=True,painted_space=painted_space)
            scope=v.figure_association_inventory(source)['inlineReplacementTexts'][0]
            policy={v.digest(source.stream.getvalue()):{scope['membershipHash']:'reviewed blank paragraph'}}
            with patch.object(v,'REVIEWED_WHITESPACE_ARTIFACTS',policy):
                self.assertFalse(v.compare_actual_text_associations(source,output)['passed'])
    def test_native_replacement_language_must_stay_the_same(self):
        source=replacement_reader();writer=PdfWriter(clone_from=source)
        node=writer.root_object['/StructTreeRoot']['/K'][0].get_object()['/K'][0].get_object()
        node[NameObject('/Lang')]=TextStringObject('fr')
        data=io.BytesIO();writer.write(data)
        result=v.compare_actual_text_associations(source,PdfReader(io.BytesIO(data.getvalue()),strict=True))
        self.assertFalse(result['passed'])
        self.assertEqual(result['comparisons'][0]['failureCode'],'authored_actual_text_language_changed')
    def test_inline_scopes_are_checked_even_without_a_native_structure_tree(self):
        def untag(reader):
            writer=PdfWriter(clone_from=reader);writer.root_object.pop('/StructTreeRoot')
            data=io.BytesIO();writer.write(data);return PdfReader(io.BytesIO(data.getvalue()),strict=True)
        source=untag(inline_replacement_reader())
        self.assertEqual(v.compare_actual_text_associations(source,source)['sourceInlineReplacementCount'],2)
        self.assertFalse(v.compare_actual_text_associations(source,untag(inline_replacement_reader((None,None))))['passed'])
    def test_incomplete_semantic_inspection_cannot_leave_preservation_true(self):
        with tempfile.TemporaryDirectory() as root:
            source=Path(root)/'source.pdf';source.write_bytes(pdf_bytes(tagged=True))
            with patch.object(v,'compare_actual_text_associations',side_effect=v.InspectionError('bounded_association_failure')):
                report=v.compare_pdfs(source,source)
            self.assertTrue(report['inspection_incomplete'])
            self.assertFalse(report['preservation']['passed']);self.assertFalse(report['mechanical_checks_passed'])


if __name__ == "__main__":
    unittest.main()
