"""Semantic text views may discard inert paint, never source indices or state."""
import copy
import io
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

from pypdf import PdfReader, PdfWriter
from pypdf.generic import DictionaryObject, NameObject

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "research/native-pdf"))
import bounded_semantic_structure as semantic
import verify_pdf as v
from test_text_extraction import fixture
from test_native_pdf_validation import pdf_bytes


PAINT = b"0.1 0.2 0.3 rg 0.7 G 2 w 1 1 m 10 10 l S 1 1 4 5 re f\n"


class SemanticGraphicsExtractionTests(unittest.TestCase):
    def reader(self):
        program = (PAINT * 4 +
            b"q 1 0 0 1 4 6 cm /GS1 gs BT /F1 12 Tf 1 0 0 1 20 70 Tm "
            b"/P << /MCID 0 >> BDC (First unselected) Tj EMC ET " + PAINT * 3 +
            b"BT /F1 11 Tf 1 Tc 90 Tz 13 TL 20 45 Td "
            b"/P << /MCID 1 >> BDC [(Selected) -300 (passage)] TJ EMC ET " + PAINT * 2 +
            b"BT /F1 10 Tf 20 20 Td /P << /MCID 2 >> BDC (Last unselected) Tj EMC ET Q")
        reader = PdfReader(io.BytesIO(fixture(program)), strict=True)
        reader.pages[0]["/Resources"][NameObject("/ExtGState")] = DictionaryObject({NameObject("/GS1"):
            DictionaryObject({NameObject("/Type"): NameObject("/ExtGState")})})
        return reader

    def test_single_show_paragraph_without_note_candidates_needs_no_isolated_decode(self):
        writer = PdfWriter(clone_from=PdfReader(io.BytesIO(pdf_bytes(tagged=True))))
        writer.pages[0]["/Contents"].get_object().set_data(
            b"BT /F1 12 Tf 20 40 Td /P << /MCID 0 >> BDC (Ordinary prose with no note reference) Tj EMC ET")
        output = io.BytesIO()
        writer.write(output)
        reader = PdfReader(io.BytesIO(output.getvalue()), strict=True)
        with patch.object(semantic, "_show_text", side_effect=AssertionError("unnecessary paragraph decode")):
            candidates = semantic.discover_candidates(reader)
        self.assertEqual(candidates, [])

    def test_text_view_omits_graphics_and_wrappers_before_decoding(self):
        reader = self.reader()
        page = reader.pages[0]
        operations = v.operations(page)
        selected = {index for index, (_, operator) in enumerate(operations) if operator == b"TJ"}
        with patch.object(v, "extraction_stream", wraps=v.extraction_stream) as decoder:
            text = semantic._show_text(reader, page, operations, selected)
        sent = decoder.call_args.args[0]
        sent_operators = {operator for _, operator in sent}
        self.assertTrue(sent_operators.isdisjoint({b"rg", b"G", b"w", b"m", b"l", b"S", b"re", b"f", b"BDC", b"EMC"}))
        self.assertIn("Selected", text)
        self.assertIn("passage", text)
        self.assertNotIn("unselected", text)
        self.assertEqual([operation for operation in sent if operation[1] in semantic.SHOW],
                         [operations[index] for index in sorted(selected)])

    def test_text_state_stack_matrices_and_unknown_operations_are_retained(self):
        reader = self.reader()
        page = reader.pages[0]
        operations = v.operations(page)
        operations.insert(0, ([], b"UNRECOGNIZED"))
        selected = {index for index, (_, operator) in enumerate(operations) if operator in semantic.SHOW}
        with patch.object(v, "extraction_stream", wraps=v.extraction_stream) as decoder:
            semantic._show_text(reader, page, operations, selected)
        sent = decoder.call_args.args[0]
        expected_state = [operation for operation in operations
                          if operation[1] in {b"q", b"Q", b"cm", b"gs", b"BT", b"ET", b"Tf", b"Tm", b"Td", b"Tc", b"Tz", b"TL", b"UNRECOGNIZED"}]
        self.assertEqual([operation for operation in sent if operation[1] in {item[1] for item in expected_state}], expected_state)

    def test_filtered_text_matches_unfiltered_decoder_without_mutating_source(self):
        reader = self.reader()
        page = reader.pages[0]
        original_content = page.get_contents().get_data()
        original_resources = v.Canonicalizer().hash(page["/Resources"])
        operations = v.operations(page)
        original_paint = v.drawing_fingerprint(operations, v.Canonicalizer())
        indices = {index for index, (_, operator) in enumerate(operations) if operator in semantic.SHOW}
        reference = copy.copy(page)
        reference[NameObject("/Contents")] = v.extraction_stream(operations, reader, page["/Resources"])
        self.assertEqual(semantic._show_text(reader, page, operations, indices), reference.extract_text().strip())
        self.assertEqual(page.get_contents().get_data(), original_content)
        self.assertEqual(v.Canonicalizer().hash(page["/Resources"]), original_resources)
        self.assertEqual(v.drawing_fingerprint(operations, v.Canonicalizer()), original_paint)


if __name__ == "__main__":
    unittest.main()
