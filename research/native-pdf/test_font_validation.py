"""Adversarial, local regressions for the opt-in font preservation gate."""
import copy
import io
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen
from pypdf import PdfReader, PdfWriter
from pypdf.generic import ArrayObject, DecodedStreamObject, DictionaryObject, NameObject, NumberObject
from reportlab.pdfbase import pdfmetrics

import font_validation as f
import verify_pdf as v
from test_native_pdf_validation import pdf_bytes


def tiny_font(*, missing_glyph=False):
    builder = FontBuilder(1000, isTTF=True)
    order = [".notdef", "space", "A"]
    builder.setupGlyphOrder(order)
    builder.setupCharacterMap({32: "space", **({} if missing_glyph else {65: "A"})})
    glyphs = {}
    for name in order:
        pen = TTGlyphPen(None)
        if name == "A":
            pen.moveTo((0, 0)); pen.lineTo((600, 0)); pen.lineTo((300, 700)); pen.closePath()
        glyphs[name] = pen.glyph()
    builder.setupGlyf(glyphs)
    builder.setupHorizontalMetrics({".notdef": (500, 0), "space": (278, 0), "A": (667, 0)})
    builder.setupHorizontalHeader(ascent=800, descent=-200)
    builder.setupNameTable({"familyName": "Liberation Sans", "styleName": "Regular", "uniqueFontIdentifier": "Synthetic fixture only", "fullName": "Synthetic fixture", "psName": "LiberationSans"})
    builder.setupOS2(sTypoAscender=800, sTypoDescender=-200, usWinAscent=800, usWinDescent=200)
    builder.setupPost()
    builder.setupMaxp()
    builder.font.recalcTimestamp = False
    builder.font["head"].created = builder.font["head"].modified = 3400000000
    buffer = io.BytesIO()
    builder.save(buffer)
    return buffer.getvalue()


def font_pair(*, missing_glyph=False, wrong_width=False):
    before = DictionaryObject({NameObject("/Type"): NameObject("/Font"), NameObject("/Subtype"): NameObject("/Type1"), NameObject("/BaseFont"): NameObject("/Helvetica"), NameObject("/Encoding"): NameObject("/WinAnsiEncoding")})
    program = DecodedStreamObject()
    program.set_data(tiny_font(missing_glyph=missing_glyph))
    unicode_map = DecodedStreamObject()
    unicode_map.set_data(b"1 beginbfchar <41> <0041> endbfchar")
    descriptor = DictionaryObject({NameObject("/FontFile2"): program})
    after = DictionaryObject({NameObject("/Type"): NameObject("/Font"), NameObject("/Subtype"): NameObject("/TrueType"), NameObject("/BaseFont"): NameObject("/LiberationSans"), NameObject("/Encoding"): NameObject("/WinAnsiEncoding"), NameObject("/FirstChar"): NumberObject(65), NameObject("/LastChar"): NumberObject(65), NameObject("/Widths"): ArrayObject([NumberObject(668 if wrong_width else 667)]), NameObject("/FontDescriptor"): descriptor, NameObject("/ToUnicode"): unicode_map})
    entry = {"sourceBaseFont": "Helvetica", "targetBaseFont": "LiberationSans", "sourceFontSha256": v.Canonicalizer().hash(before), "targetFontSha256": v.Canonicalizer().hash(after), "fontProgramSha256": v.digest(program.get_data()), "usedCharacterCodes": [65]}
    return before, after, entry


def changed_pdf(data, mutation):
    writer = PdfWriter(clone_from=PdfReader(io.BytesIO(data)))
    mutation(writer)
    output = io.BytesIO()
    writer.write(output)
    return output.getvalue()


class FontProgramChecks(unittest.TestCase):
    def setUp(self):
        # Test-only tiny programs exercise parser/metrics failures without
        # changing the production allowlist of audited Liberation binaries.
        self.approval = patch.dict(f.APPROVED_FONT_PROGRAMS, {"LiberationSans": v.digest(tiny_font())})
        self.approval.start()
        self.addCleanup(self.approval.stop)

    def test_used_program_glyph_and_pdf_advances_verified(self):
        before, after, entry = font_pair()
        report = f.validate_font_pair(before, after, entry, [65])
        self.assertTrue(report["usedGlyphCoverageVerified"])
        self.assertTrue(report["usedAdvanceWidthsVerified"])

    def test_missing_used_glyph_is_rejected(self):
        before, after, entry = font_pair(missing_glyph=True)
        with patch.dict(f.APPROVED_FONT_PROGRAMS, {"LiberationSans": entry["fontProgramSha256"]}), self.assertRaisesRegex(v.InspectionError, "missing_used_glyph"):
            f.validate_font_pair(before, after, entry, [65])

    def test_a_matching_manifest_cannot_approve_an_unknown_program(self):
        before, after, entry = font_pair()
        with patch.dict(f.APPROVED_FONT_PROGRAMS, {"LiberationSans": "f" * 64}), self.assertRaisesRegex(v.InspectionError, "not_independently_approved"):
            f.validate_font_pair(before, after, entry, [65])

    def test_changed_advance_is_rejected_even_with_matching_manifest(self):
        before, after, entry = font_pair(wrong_width=True)
        with self.assertRaisesRegex(v.InspectionError, "advance_width_changed"):
            f.validate_font_pair(before, after, entry, [65])

    def test_manifest_cannot_hide_an_unlisted_character(self):
        before, after, entry = font_pair()
        with self.assertRaisesRegex(v.InspectionError, "character_codes_mismatch"):
            f.validate_font_pair(before, after, entry, [32, 65])

    def test_changed_program_hash_is_rejected(self):
        before, after, entry = font_pair()
        entry["fontProgramSha256"] = "0" * 64
        with self.assertRaisesRegex(v.InspectionError, "program_hash_mismatch"):
            f.validate_font_pair(before, after, entry, [65])

    def test_custom_font_encoding_is_not_silently_waived(self):
        before, after, entry = font_pair()
        before[NameObject("/Encoding")] = DictionaryObject({NameObject("/Differences"): ArrayObject([NumberObject(65), NameObject("/B")])})
        with self.assertRaisesRegex(v.InspectionError, "encoding_unsupported"):
            f.validate_font_pair(before, after, entry, [65])


class RenderedLayoutChecks(unittest.TestCase):
    def test_new_word_collision_is_rejected(self):
        with self.assertRaisesRegex(v.InspectionError, "word_collision"):
            f.verify_word_collisions([(0, 0, 10, 10), (11, 0, 20, 10)], [(0, 0, 11.5, 10), (11, 0, 20, 10)])

    def test_glyph_cannot_extend_far_beyond_original_advance(self):
        before = {"matrix": (1, 0, 0, 1, 0, 0), "codepoint": 49, "font": "Helvetica", "size": 12, "origin": (20, 20), "box": (21, 20, 25, 29)}
        with self.assertRaisesRegex(v.InspectionError, "advance_cell"):
            f.verify_advance_cell(before, {"box": (21, 20, 28, 29)})

    def paths(self, left, right):
        directory = tempfile.TemporaryDirectory(prefix="native-font-validation-")
        self.addCleanup(directory.cleanup)
        source, output = Path(directory.name) / "source.pdf", Path(directory.name) / "output.pdf"
        source.write_bytes(left); output.write_bytes(right)
        return source, output

    def test_identical_layout_and_pixels_pass(self):
        source, output = self.paths(pdf_bytes(), pdf_bytes())
        result = f.verify_rendered_layout(source, output, {})
        self.assertEqual(result[0]["changedPixels"], 0)
        self.assertEqual(result[0]["maxCharacterOriginDeltaPt"], 0)

    def test_changed_character_position_is_rejected(self):
        def move(writer):
            stream = DecodedStreamObject(); stream.set_data(b"BT /F1 12 Tf 21 40 Td (Hello) Tj ET")
            writer.pages[0][NameObject("/Contents")] = writer._add_object(stream)
        source, output = self.paths(pdf_bytes(), changed_pdf(pdf_bytes(), move))
        with self.assertRaisesRegex(v.InspectionError, "placement_changed"):
            f.verify_rendered_layout(source, output, {})

    def test_changed_unicode_is_rejected(self):
        source, output = self.paths(pdf_bytes(), pdf_bytes(text="Jello"))
        with self.assertRaisesRegex(v.InspectionError, "unicode_or_reading_order_changed"):
            f.verify_rendered_layout(source, output, {})

    def test_changed_nontext_pixels_outside_glyph_mask_are_rejected(self):
        def rectangle(writer):
            stream = DecodedStreamObject(); stream.set_data(b"BT /F1 12 Tf 20 40 Td (Hello) Tj ET 150 70 10 10 re f")
            writer.pages[0][NameObject("/Contents")] = writer._add_object(stream)
        source, output = self.paths(pdf_bytes(), changed_pdf(pdf_bytes(), rectangle))
        with self.assertRaisesRegex(v.InspectionError, "outside_authorized_glyphs"):
            f.verify_rendered_layout(source, output, {1: {"Helvetica": "Helvetica"}})

    def test_graphics_change_hidden_inside_text_region_is_rejected(self):
        def rectangle(writer):
            stream = DecodedStreamObject(); stream.set_data(b"BT /F1 12 Tf 20 40 Td (Hello) Tj ET 20 40 2 2 re f")
            writer.pages[0][NameObject("/Contents")] = writer._add_object(stream)
        source, output = self.paths(pdf_bytes(), changed_pdf(pdf_bytes(), rectangle))
        with self.assertRaisesRegex(v.InspectionError, "drawing_change"):
            f.verify_other_content(PdfReader(source), PdfReader(output))

    def test_manifest_must_bind_exact_files(self):
        source, output = self.paths(pdf_bytes(), pdf_bytes(tagged=True))
        with self.assertRaisesRegex(v.InspectionError, "source_hash_mismatch"):
            f.authorize_fonts(source, output, {"schemaVersion": 1, "sourceSha256": "0" * 64})

    def test_authorization_is_explicit(self):
        source, output = self.paths(pdf_bytes(), pdf_bytes(tagged=True))
        with self.assertRaisesRegex(v.InspectionError, "authorization_missing"):
            f.authorize_fonts(source, output, {"schemaVersion": 1, "sourceSha256": f.sha_file(source), "candidateSha256": f.sha_file(output)})


if __name__ == "__main__":
    unittest.main()
