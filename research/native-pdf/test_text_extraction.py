"""Text evidence must not turn horizontal tightening into authored spaces."""
import copy
import io
import tempfile
import unittest
from pathlib import Path

from pypdf import PdfReader, PdfWriter
from pypdf.generic import DictionaryObject, NameObject, DecodedStreamObject

import verify_pdf as v


def fixture(program, *, vertical=False):
    writer = PdfWriter()
    page = writer.add_blank_page(width=200, height=100)
    font = DictionaryObject({NameObject('/Type'): NameObject('/Font'),
        NameObject('/Subtype'): NameObject('/Type0' if vertical else '/Type1'),
        NameObject('/BaseFont'): NameObject('/Helvetica')})
    if vertical:
        font[NameObject('/Encoding')] = NameObject('/Identity-V')
    page[NameObject('/Resources')] = DictionaryObject({NameObject('/Font'):
        DictionaryObject({NameObject('/F1'): font})})
    stream = DecodedStreamObject()
    stream.set_data(program)
    page[NameObject('/Contents')] = writer._add_object(stream)
    output = io.BytesIO()
    writer.write(output)
    return output.getvalue()


def extract(reader):
    page = reader.pages[0]
    view = copy.copy(page)
    view[NameObject('/Contents')] = v.extraction_stream(
        page.get_contents().operations, reader, page['/Resources'])
    return view.extract_text()


class TextExtractionTests(unittest.TestCase):
    def test_positive_horizontal_kerning_does_not_invent_a_word_gap(self):
        reader = PdfReader(io.BytesIO(fixture(b'BT /F1 12 Tf 10 50 Td [(T) 400 (erisa)] TJ ET')))
        self.assertEqual(reader.pages[0].extract_text(), 'T erisa')
        self.assertEqual(extract(reader), 'Terisa')

    def test_negative_adjustment_remains_a_real_gap(self):
        reader = PdfReader(io.BytesIO(fixture(b'BT /F1 12 Tf 10 50 Td [(Two) -400 (words)] TJ ET')))
        self.assertEqual(extract(reader), 'Two words')

    def test_literal_space_is_preserved_with_positive_kerning(self):
        reader = PdfReader(io.BytesIO(fixture(b'BT /F1 12 Tf 10 50 Td [(T) 400 (erisa F. Rutledge)] TJ ET')))
        self.assertEqual(extract(reader), 'Terisa F. Rutledge')
        reader = PdfReader(io.BytesIO(fixture(b'BT /F1 12 Tf 10 50 Td [(T ) 400 (erisa)] TJ ET')))
        self.assertEqual(extract(reader), 'T erisa')

    def test_literal_space_and_negative_gap_survive_adjacent_plus_120(self):
        reader = PdfReader(io.BytesIO(fixture(
            b'BT /F1 12 Tf 10 50 Td [(T) 120 (erisa F. ) 120 (Rutledge) -400 (Editor)] TJ ET')))
        self.assertEqual(extract(reader), 'Terisa F. Rutledge Editor')

    def test_filtered_view_cannot_mutate_original_operands_or_saved_bytes(self):
        data = fixture(b'BT /F1 12 Tf 10 50 Td [(T) 400 (erisa F.) -400 (Rutledge)] TJ ET')
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'source.pdf'
            path.write_bytes(data)
            reader = PdfReader(path)
            page = reader.pages[0]
            operations = page.get_contents().operations
            contents_before = page.get_contents().get_data()
            resource_hash = v.Canonicalizer().hash(page['/Resources'])
            op_hash = v.drawing_fingerprint(operations, v.Canonicalizer())
            self.assertEqual(extract(reader), 'Terisa F. Rutledge')
            self.assertEqual(v.drawing_fingerprint(operations, v.Canonicalizer()), op_hash)
            self.assertEqual(page.get_contents().get_data(), contents_before)
            self.assertEqual(v.Canonicalizer().hash(page['/Resources']), resource_hash)
            self.assertEqual(path.read_bytes(), data)
            self.assertEqual(page.extract_text(), 'T erisa F. Rutledge')

    def test_vertical_kerning_is_explicitly_unsupported(self):
        reader = PdfReader(io.BytesIO(fixture(b'BT /F1 12 Tf [(A) 400 (B)] TJ ET', vertical=True)))
        with self.assertRaisesRegex(v.InspectionError, 'unsupported_kerning_writing_mode'):
            extract(reader)

    def test_graphics_state_restores_horizontal_font_after_q(self):
        reader = PdfReader(io.BytesIO(fixture(b'BT /F1 12 Tf q /F2 12 Tf Q [(T) 400 (erisa)] TJ ET')))
        self.assertEqual(extract(reader), 'Terisa')

    def test_missing_font_mode_is_not_silently_assumed_horizontal(self):
        reader = PdfReader(io.BytesIO(fixture(b'BT /Missing 12 Tf [(A) 400 (B)] TJ ET')))
        with self.assertRaisesRegex(v.InspectionError, 'unsupported_kerning_writing_mode'):
            extract(reader)


if __name__ == '__main__':
    unittest.main()
