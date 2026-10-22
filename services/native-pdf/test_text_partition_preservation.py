"""Independent saved-PDF evidence for splitting an exact encoded text suffix.

These checks exercise the production preservation verifier, independently of the
semantic helper's candidate discovery, font gate, and content-stream rewriting.
"""
import io
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "research" / "native-pdf"))

from pypdf import PdfReader, PdfWriter
from pypdf.generic import (ArrayObject, ByteStringObject, DecodedStreamObject,
                          DictionaryObject, NameObject, NumberObject)

import verify_pdf as v
from test_native_pdf_validation import pdf_bytes


def fixture(*, split=False, marker=b"**", prefix=b"Existing reference", middle=b"", font_change=False):
    writer = PdfWriter(clone_from=PdfReader(io.BytesIO(pdf_bytes(tagged=True))))
    page = writer.pages[0]
    font = page["/Resources"]["/Font"]["/F1"]
    font[NameObject("/Encoding")] = NameObject("/WinAnsiEncoding")
    if font_change:
        font[NameObject("/BaseFont")] = NameObject("/Courier")
    start = b"BT /F1 12 Tf 1.1 Tc 2.2 Tw 97 Tz 1 Ts 20 40 Td /P << /MCID 0 >> BDC "
    if not split:
        content = start + b"<" + (prefix + marker).hex().encode() + b"> Tj EMC ET"
    else:
        content = (start + b"<" + prefix.hex().encode() + b"> Tj EMC " + middle
                   + b"/Span << /MCID 1 >> BDC <" + marker.hex().encode() + b"> Tj EMC ET")
        root = writer.root_object["/StructTreeRoot"]
        paragraph = root["/K"][0]["/K"][0].get_object()
        reference = DictionaryObject({NameObject("/Type"): NameObject("/StructElem"),
            NameObject("/S"): NameObject("/Reference"), NameObject("/P"): paragraph.indirect_reference,
            NameObject("/Pg"): page.indirect_reference})
        reference_ref = writer._add_object(reference)
        label = DictionaryObject({NameObject("/Type"): NameObject("/StructElem"),
            NameObject("/S"): NameObject("/Lbl"), NameObject("/P"): reference_ref,
            NameObject("/Pg"): page.indirect_reference, NameObject("/K"): NumberObject(1)})
        label_ref = writer._add_object(label)
        reference[NameObject("/K")] = label_ref
        paragraph[NameObject("/K")] = ArrayObject([NumberObject(0), reference_ref])
        root["/ParentTree"]["/Nums"][1].append(label_ref)
    stream = DecodedStreamObject()
    stream.set_data(content)
    page[NameObject("/Contents")] = writer._add_object(stream)
    output = io.BytesIO()
    writer.write(output)
    return output.getvalue()


class TextPartitionPreservationTests(unittest.TestCase):
    def compare(self, source, output):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            before, after = folder / "source.pdf", folder / "output.pdf"
            before.write_bytes(source)
            after.write_bytes(output)
            result = v.compare_pdfs(before, after)
            self.assertEqual(before.read_bytes(), source)
            self.assertEqual(after.read_bytes(), output)
            return result

    def fingerprint(self, operations):
        return v.drawing_fingerprint(operations, v.Canonicalizer())

    def test_exact_byte_partition_preserves_page_text_fonts_pixels_and_ownership(self):
        for prefix in (b"Existing reference", b"Existing reference with spaces", b"Existing \x96 reference"):
            with self.subTest(prefix=prefix):
                result = self.compare(fixture(prefix=prefix), fixture(split=True, prefix=prefix))
                self.assertTrue(result["passed"], result["findings"])
                self.assertTrue(result["preservation"]["fonts_identical"])
                self.assertTrue(result["preservation"]["pages"][0]["pixels_identical"])
                self.assertTrue(result["preservation"]["pages"][0]["extracted_text_identical"])
                self.assertTrue(result["structure"]["machine_checks_passed"])

    def test_lost_duplicated_reordered_or_changed_raw_bytes_are_rejected(self):
        original = [([ByteStringObject(b"Existing reference**")], b"Tj")]
        for pieces in ((b"Existing reference", b"*"), (b"Existing reference", b"***"),
                       (b"**", b"Existing reference"), (b"Existing reference", b"*+")):
            with self.subTest(pieces=pieces):
                candidate = [([ByteStringObject(piece)], b"Tj") for piece in pieces]
                self.assertNotEqual(self.fingerprint(original), self.fingerprint(candidate))
        for marker in (b"*", b"***", b"*+"):
            with self.subTest(marker=marker):
                result = self.compare(fixture(), fixture(split=True, marker=marker))
                self.assertFalse(result["preservation"]["passed"])
                self.assertFalse(result["preservation"]["pages"][0]["drawing_operators_identical"])

    def test_every_intervening_state_operation_prevents_text_coalescing(self):
        original = [([ByteStringObject(b"Existing reference**")], b"Tj")]
        states = [([NameObject("/F2"), 12], b"Tf"), ([1], b"Tc"), ([2], b"Tw"),
                  ([80], b"Tz"), ([1], b"Tr"), ([3], b"Ts"), ([12], b"TL"),
                  ([1, 0, 0, 1, 20, 40], b"Tm"), ([1, 0], b"Td"), ([0, -12], b"TD"),
                  ([], b"T*"), ([], b"q"), ([], b"Q"), ([1, 0, 0, 1, 1, 0], b"cm"),
                  ([], b"BT"), ([], b"ET"), ([0], b"g")]
        for state in states:
            with self.subTest(operator=state[1]):
                candidate = [([ByteStringObject(b"Existing reference")], b"Tj"), state,
                             ([ByteStringObject(b"**")], b"Tj")]
                self.assertNotEqual(self.fingerprint(original), self.fingerprint(candidate))

    def test_kerning_and_quote_operators_are_not_equivalent_to_adjacent_tj(self):
        original = [([ByteStringObject(b"Existing reference**")], b"Tj")]
        prefix = [([ByteStringObject(b"Existing reference")], b"Tj")]
        suffixes = [([ArrayObject([NumberObject(10), ByteStringObject(b"**")])], b"TJ"),
                    ([ByteStringObject(b"**")], b"'"), ([0, 0, ByteStringObject(b"**")], b'"')]
        for suffix in suffixes:
            with self.subTest(operator=suffix[1]):
                self.assertNotEqual(self.fingerprint(original), self.fingerprint(prefix + [suffix]))

    def test_changed_font_or_text_state_is_rejected_after_serialization(self):
        for kwargs in ({"font_change": True}, {"middle": b"/F1 13 Tf "},
                       {"middle": b"2 Tc "}, {"middle": b"1 0 Td "}):
            with self.subTest(change=kwargs):
                result = self.compare(fixture(), fixture(split=True, **kwargs))
                self.assertFalse(result["preservation"]["passed"])
                if kwargs.get("font_change"):
                    self.assertFalse(result["preservation"]["fonts_identical"])
                    self.assertFalse(result["preservation"]["pages"][0]["resources_identical"])
                else:
                    self.assertFalse(result["preservation"]["pages"][0]["drawing_operators_identical"])

    def test_actual_text_cannot_be_smuggled_in_as_an_ignored_wrapper(self):
        writer = PdfWriter(clone_from=PdfReader(io.BytesIO(fixture(split=True))))
        page = writer.pages[0]
        stream = DecodedStreamObject()
        stream.set_data(page.get_contents().get_data().replace(b"/MCID 1", b"/MCID 1 /ActualText (different)"))
        page[NameObject("/Contents")] = writer._add_object(stream)
        output = io.BytesIO()
        writer.write(output)
        result = self.compare(fixture(), output.getvalue())
        self.assertTrue(result["preservation"]["pages"][0]["drawing_operators_identical"])
        self.assertFalse(result["preservation"]["passed"])
        self.assertIn("unexpected_inline_actual_text", [finding["code"] for finding in result["findings"]])


if __name__ == "__main__":
    unittest.main()
