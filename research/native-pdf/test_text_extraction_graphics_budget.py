"""Disposable text extraction must not repeatedly charge irrelevant painting."""
import copy
import io
import unittest
from unittest.mock import patch

from pypdf import PdfReader, PdfWriter
from pypdf.generic import (ArrayObject, BooleanObject, DecodedStreamObject, DictionaryObject,
                          NameObject, NumberObject, TextStringObject)

import verify_pdf as v
from test_text_extraction import fixture as text_fixture


PAINT = b"0.2 g 0.1 0.2 0.3 rg 2 w 0 0 m 10 10 l S 1 1 4 5 re f\n"


def fixture(*, paint_repetitions=0, graphics_scopes=0, state_repetitions=0, form=False, artifact=False):
    writer = PdfWriter()
    page = writer.add_blank_page(240, 180)
    font = writer._add_object(DictionaryObject({NameObject("/Type"): NameObject("/Font"),
        NameObject("/Subtype"): NameObject("/Type1"), NameObject("/BaseFont"): NameObject("/Helvetica")}))
    resources = DictionaryObject({NameObject("/Font"): DictionaryObject({NameObject("/F1"): font})})
    page[NameObject("/Resources")] = resources
    program = PAINT * paint_repetitions + b"1 0 0 1 0 0 cm\n" * state_repetitions
    words = ["First passage", "Second passage", "Third passage"]
    for index, text in enumerate(words):
        program += (f"/P << /MCID {index} >> BDC BT /F1 12 Tf 20 {140-index*20} Td ({text}) Tj ET EMC\n").encode()
    for index in range(graphics_scopes):
        program += f"/Figure << /MCID {index+len(words)} >> BDC ".encode() + PAINT + b"EMC\n"
    if artifact:
        program += b"/Artifact BMC BT /F1 10 Tf 20 10 Td (Page footer) Tj ET EMC\n"
    stream = DecodedStreamObject()
    stream.set_data(program)
    stream_ref = writer._add_object(stream)
    if form:
        stream.update({NameObject("/Type"): NameObject("/XObject"), NameObject("/Subtype"): NameObject("/Form"),
            NameObject("/BBox"): ArrayObject([NumberObject(n) for n in (0, 0, 240, 180)]),
            NameObject("/Resources"): resources, NameObject("/StructParents"): NumberObject(1)})
        page[NameObject("/Resources")] = DictionaryObject({NameObject("/Font"): resources["/Font"],
            NameObject("/XObject"): DictionaryObject({NameObject("/F0"): stream_ref})})
        invocation = DecodedStreamObject()
        invocation.set_data(b"q /F0 Do Q")
        page[NameObject("/Contents")] = writer._add_object(invocation)
    else:
        page[NameObject("/Contents")] = stream_ref
    root = DictionaryObject({NameObject("/Type"): NameObject("/StructTreeRoot")})
    root_ref = writer._add_object(root)
    document = DictionaryObject({NameObject("/Type"): NameObject("/StructElem"),
        NameObject("/S"): NameObject("/Document"), NameObject("/P"): root_ref})
    document_ref = writer._add_object(document)
    refs = []
    for index in range(len(words) + graphics_scopes):
        content = NumberObject(index)
        if form:
            content = DictionaryObject({NameObject("/Type"): NameObject("/MCR"),
                NameObject("/Pg"): page.indirect_reference, NameObject("/Stm"): stream_ref,
                NameObject("/MCID"): NumberObject(index)})
        tag = DictionaryObject({NameObject("/Type"): NameObject("/StructElem"),
            NameObject("/S"): NameObject("/P" if index < len(words) else "/Figure"),
            NameObject("/P"): document_ref, NameObject("/Pg"): page.indirect_reference,
            NameObject("/K"): content})
        if index >= len(words):
            tag[NameObject("/Alt")] = TextStringObject("Synthetic square")
        refs.append(writer._add_object(tag))
    document[NameObject("/K")] = ArrayObject(refs)
    root[NameObject("/K")] = ArrayObject([document_ref])
    nums = [NumberObject(0), ArrayObject([] if form else refs)]
    if form:
        nums.extend([NumberObject(1), ArrayObject(refs)])
    root[NameObject("/ParentTree")] = DictionaryObject({NameObject("/Nums"): ArrayObject(nums)})
    page[NameObject("/StructParents")] = NumberObject(0)
    writer.root_object[NameObject("/StructTreeRoot")] = root_ref
    writer.root_object[NameObject("/MarkInfo")] = DictionaryObject({NameObject("/Marked"): BooleanObject(True)})
    writer.root_object[NameObject("/Lang")] = TextStringObject("en-US")
    output = io.BytesIO()
    writer.write(output)
    return output.getvalue(), words


class GraphicsExtractionBudgetTests(unittest.TestCase):
    def test_pure_graphics_do_not_exhaust_text_budget_for_page_or_leaf_form(self):
        for form in (False, True):
            with self.subTest(form=form):
                data, words = fixture(paint_repetitions=100, artifact=True, form=form)
                reader = PdfReader(io.BytesIO(data), strict=True)
                with patch.object(v, "MAX_TEXT_EXTRACTION_OPERATORS", 150):
                    inventory = v.structure_inventory(reader)
                paragraphs = [tag for tag in inventory["tags"] if tag["role"] == "P"]
                self.assertEqual([tag["text"].strip() for tag in paragraphs], words)
                self.assertFalse(any(tag.get("textIncomplete") for tag in inventory["tags"]))
                self.assertTrue(inventory["page_content"][0]["artifactTextComplete"])
                self.assertIn("Page footer", inventory["page_content"][0]["artifactText"])

    def test_graphics_only_mcids_use_proved_empty_text_without_replaying_page(self):
        for form in (False, True):
            with self.subTest(form=form):
                data, words = fixture(graphics_scopes=60, form=form)
                with patch.object(v, "MAX_TEXT_EXTRACTION_OPERATORS", 150):
                    inventory = v.structure_inventory(PdfReader(io.BytesIO(data), strict=True))
                paragraphs = [tag for tag in inventory["tags"] if tag["role"] == "P"]
                figures = [tag for tag in inventory["tags"] if tag["role"] == "Figure"]
                self.assertEqual([tag["text"].strip() for tag in paragraphs], words)
                self.assertEqual(len(figures), 60)
                self.assertTrue(all(tag["text"] == "" for tag in figures))
                self.assertFalse(any(tag.get("textIncomplete") for tag in inventory["tags"]))

    def test_real_text_state_work_still_hits_existing_limit(self):
        data, _ = fixture(state_repetitions=100)
        with patch.object(v, "MAX_TEXT_EXTRACTION_OPERATORS", 150):
            inventory = v.structure_inventory(PdfReader(io.BytesIO(data), strict=True))
        self.assertTrue(any(tag.get("textIncomplete") for tag in inventory["tags"]))
        self.assertFalse(inventory["checks_complete"])

    def test_scoped_filter_keeps_text_state_graphics_stack_and_unknown_operators(self):
        required = (b"q", b"Q", b"cm", b"gs", b"BT", b"ET", b"Tf", b"Tm", b"Td", b"TD",
                    b"TL", b"Ts", b"Tc", b"Tw", b"Tz", b"Tr", b"T*", b"Tj", b"TJ", b"'", b'"',
                    b"UNRECOGNIZED")
        operations = [([], operator) for operator in required]
        owners = [index % 3 for index in range(len(operations))]
        artifacts = [index % 2 == 0 for index in range(len(operations))]
        scoped = v.scoped_text_operations(operations, owners, artifacts)
        self.assertEqual(scoped, list(zip(operations, owners, artifacts)))

    def test_graphics_filter_preserves_mixed_text_positions_fonts_and_decoder_output(self):
        program = (b"q 1 0 0 1 5 7 cm /GS1 gs "
                   b"BT /F1 12 Tf 1 0 0 1 20 140 Tm 14 TL (First) Tj "
                   b"q /F1 9 Tf 3 Tc ( small) Tj Q ( restored) Tj ET "
                   + PAINT * 3 +
                   b"BT /F1 11 Tf 20 50 Td 90 Tz 1 Tw 2 Ts 13 TL "
                   b"[(Second) -300 (line)] TJ (Third line) ' 0 0 (Fourth line) \" ET Q")
        reader = PdfReader(io.BytesIO(text_fixture(program)), strict=True)
        page = reader.pages[0]
        page["/Resources"][NameObject("/ExtGState")] = DictionaryObject({NameObject("/GS1"):
            DictionaryObject({NameObject("/Type"): NameObject("/ExtGState")})})
        operations = v.operations(page)
        filtered = [operation for operation, _, _ in v.scoped_text_operations(
            operations, [0] * len(operations), [False] * len(operations))]
        def decoded(items):
            view = copy.copy(page)
            view[NameObject("/Contents")] = v.extraction_stream(items, reader, page["/Resources"])
            return view.extract_text()
        self.assertEqual(decoded(operations), decoded(filtered))
        self.assertIn("First", decoded(filtered))
        self.assertIn("Fourth line", decoded(filtered))

    def test_disposable_extraction_never_changes_source_content_resources_or_paint(self):
        data, _ = fixture(paint_repetitions=30, graphics_scopes=12, artifact=True)
        reader = PdfReader(io.BytesIO(data), strict=True)
        page = reader.pages[0]
        content_before = page.get_contents().get_data()
        resources_before = v.Canonicalizer().hash(page["/Resources"])
        paint_before = v.drawing_fingerprint(v.operations(page), v.Canonicalizer())
        v.structure_inventory(reader)
        self.assertEqual(page.get_contents().get_data(), content_before)
        self.assertEqual(v.Canonicalizer().hash(page["/Resources"]), resources_before)
        self.assertEqual(v.drawing_fingerprint(v.operations(page), v.Canonicalizer()), paint_before)


if __name__ == "__main__":
    unittest.main()
