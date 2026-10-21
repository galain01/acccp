"""Local synthetic safety and preservation tests for the metadata experiment."""
from __future__ import annotations

import hashlib
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from xml.etree import ElementTree

import pypdfium2 as pdfium
from pypdf import PdfReader, PdfWriter
from pypdf.generic import (
    ArrayObject,
    BooleanObject,
    DecodedStreamObject,
    DictionaryObject,
    NameObject,
    NumberObject,
    TextStringObject,
)

import repair_metadata as metadata
import evaluate


def source_pdf(*, title="Study guide & examples <2026>", language=None,
               xmp=None, signature=None, password=None, display_title=None):
    """Generate a small PDF with visible text and optional existing properties."""
    writer = PdfWriter()
    page = writer.add_blank_page(width=240, height=120)
    font = writer._add_object(DictionaryObject({
        NameObject("/Type"): NameObject("/Font"),
        NameObject("/Subtype"): NameObject("/Type1"),
        NameObject("/BaseFont"): NameObject("/Helvetica"),
    }))
    page[NameObject("/Resources")] = DictionaryObject({
        NameObject("/Font"): DictionaryObject({NameObject("/F1"): font}),
    })
    stream = DecodedStreamObject()
    stream.set_data(b"BT /F1 14 Tf 20 60 Td (Preserve this text.) Tj ET\n0 0 1 rg 20 20 100 10 re f")
    page[NameObject("/Contents")] = writer._add_object(stream)
    if title is not None:
        writer.add_metadata({"/Title": title, "/Author": "Original author"})
    if language is not None:
        writer.root_object[NameObject("/Lang")] = TextStringObject(language)
    if xmp is not None:
        xml = DecodedStreamObject()
        xml[NameObject("/Type")] = NameObject("/Metadata")
        xml[NameObject("/Subtype")] = NameObject("/XML")
        xml.set_data(xmp)
        writer.root_object[NameObject("/Metadata")] = writer._add_object(xml)
    if display_title is not None:
        writer.root_object[NameObject("/ViewerPreferences")] = DictionaryObject({
            NameObject("/DisplayDocTitle"): BooleanObject(display_title),
            NameObject("/HideToolbar"): BooleanObject(True),
        })
    if signature == "perms":
        writer.root_object[NameObject("/Perms")] = DictionaryObject({
            NameObject("/DocMDP"): writer._add_object(DictionaryObject({
                NameObject("/Type"): NameObject("/Sig"),
            })),
        })
    if signature in {"field", "orphan-widget", "inherited-widget", "value-widget", "cyclic-widget"}:
        signature_field = writer._add_object(DictionaryObject({
            NameObject("/Type"): NameObject("/Annot"),
            NameObject("/Subtype"): NameObject("/Widget"),
            NameObject("/FT"): NameObject("/Sig"),
            NameObject("/T"): TextStringObject("Approval"),
            NameObject("/Rect"): ArrayObject([NumberObject(0)] * 4),
        }))
        field_object = signature_field.get_object()
        if signature in {"inherited-widget", "value-widget", "cyclic-widget"}:
            del field_object["/FT"]
        if signature == "inherited-widget":
            parent = writer._add_object(DictionaryObject({NameObject("/FT"): NameObject("/Sig")}))
            field_object[NameObject("/Parent")] = parent
        if signature == "value-widget":
            field_object[NameObject("/V")] = writer._add_object(DictionaryObject({NameObject("/Type"): NameObject("/Sig")}))
        if signature == "cyclic-widget":
            field_object[NameObject("/Parent")] = signature_field
        page[NameObject("/Annots")] = ArrayObject([signature_field])
        if signature == "field":
            writer.root_object[NameObject("/AcroForm")] = writer._add_object(
                DictionaryObject({NameObject("/Fields"): ArrayObject([signature_field])})
            )
    if password is not None:
        writer.encrypt(password)
    data = io.BytesIO()
    writer.write(data)
    return data.getvalue()


def rendered_pixels(path):
    """Independent PDFium rendering, including painted text and graphics."""
    document = pdfium.PdfDocument(str(path))
    pages = []
    try:
        for index in range(len(document)):
            page = document[index]
            bitmap = page.render(scale=2)
            try:
                image = bitmap.to_pil()
                pages.append((image.size, image.mode, hashlib.sha256(image.tobytes()).hexdigest()))
            finally:
                bitmap.close()
                page.close()
    finally:
        document.close()
    return pages


class MetadataRepairChecks(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="native-pdf-metadata-")
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        self.source = self.directory / "source.pdf"
        self.output = self.directory / "candidate.pdf"

    def prepare(self, **options):
        original = source_pdf(**options)
        self.source.write_bytes(original)
        return original

    def repair(self, language="en-US"):
        changes = metadata.repair_metadata(self.source, self.output, language)
        return changes, PdfReader(self.output, strict=True)

    def test_repairs_missing_metadata_without_changing_source_or_rendering(self):
        original = self.prepare()
        pixels_before = rendered_pixels(self.source)
        changes, result = self.repair()
        self.assertEqual(self.source.read_bytes(), original)
        self.assertEqual(rendered_pixels(self.output), pixels_before)
        self.assertEqual(result.pages[0].extract_text(), "Preserve this text.")
        self.assertEqual(result.trailer["/Root"]["/Lang"], "en-US")
        self.assertTrue(result.trailer["/Root"]["/ViewerPreferences"]["/DisplayDocTitle"].value)
        self.assertEqual(len(changes), 3)

    def test_xmp_escapes_existing_title_and_never_adds_pdfua_claim(self):
        self.prepare()
        _, result = self.repair()
        raw = result.trailer["/Root"]["/Metadata"].get_data()
        root = ElementTree.fromstring(raw)
        ns = {"dc": "http://purl.org/dc/elements/1.1/", "rdf": "http://www.w3.org/1999/02/22-rdf-syntax-ns#"}
        self.assertEqual(root.find(".//dc:title/rdf:Alt/rdf:li", ns).text, "Study guide & examples <2026>")
        self.assertEqual(root.find(".//dc:language/rdf:Bag/rdf:li", ns).text, "en-US")
        self.assertNotIn(b"pdfua", raw.lower())
        self.assertEqual(result.metadata["/Author"], "Original author")

    def test_existing_language_and_xmp_bytes_are_retained(self):
        xmp = b'<x:xmpmeta xmlns:x="adobe:ns:meta/"><existing>Author metadata</existing></x:xmpmeta>'
        self.prepare(language="fr-FR", xmp=xmp)
        changes, result = self.repair(language="en-US")
        self.assertEqual(result.trailer["/Root"]["/Lang"], "fr-FR")
        self.assertEqual(result.trailer["/Root"]["/Metadata"].get_data(), xmp)
        self.assertEqual(len(changes), 1)

    def test_existing_language_is_used_in_new_xmp(self):
        self.prepare(language="fr-CA")
        _, result = self.repair(language="en-US")
        xmp = result.trailer["/Root"]["/Metadata"].get_data()
        self.assertIn(b"fr-CA", xmp)
        self.assertNotIn(b"en-US", xmp)

    def test_existing_viewer_preferences_are_retained(self):
        self.prepare(display_title=False)
        _, result = self.repair()
        preferences = result.trailer["/Root"]["/ViewerPreferences"]
        self.assertTrue(preferences["/DisplayDocTitle"].value)
        self.assertTrue(preferences["/HideToolbar"].value)

    def test_no_title_is_invented(self):
        self.prepare(title=None)
        changes, result = self.repair()
        self.assertEqual(len(changes), 1)
        self.assertNotIn("/Metadata", result.trailer["/Root"])
        self.assertNotIn("/ViewerPreferences", result.trailer["/Root"])
        self.assertNotIn("/Title", result.metadata or {})

    def test_title_with_xml_control_character_does_not_create_invalid_metadata(self):
        original = self.prepare(title="Title with forbidden XML character \x01")
        with self.assertRaisesRegex(ValueError, "invalid_xmp_text"):
            self.repair()
        self.assertEqual(self.source.read_bytes(), original)
        self.assertFalse(self.output.exists())

    def test_unknown_or_invalid_language_never_uses_locale(self):
        self.prepare()
        for language in ["", "en_US", "English", "en-", "<en>"]:
            with self.subTest(language=language):
                with self.assertRaisesRegex(ValueError, "invalid_language"):
                    self.repair(language=language)
                self.assertFalse(self.output.exists())

    def test_second_repair_has_no_additional_changes(self):
        self.prepare()
        self.repair()
        second = self.directory / "second.pdf"
        changes = metadata.repair_metadata(self.output, second, "en-US")
        self.assertEqual(changes, [])
        self.assertEqual(rendered_pixels(second), rendered_pixels(self.output))

    def test_same_path_is_rejected_without_writing(self):
        original = self.prepare()
        with self.assertRaisesRegex(ValueError, "new_output_and_bounded_source_required"):
            metadata.repair_metadata(self.source, self.source, "en-US")
        self.assertEqual(self.source.read_bytes(), original)

    def test_existing_output_is_not_overwritten(self):
        self.prepare()
        existing = b"Keep this existing file"
        self.output.write_bytes(existing)
        with self.assertRaisesRegex(ValueError, "new_output_and_bounded_source_required"):
            self.repair()
        self.assertEqual(self.output.read_bytes(), existing)

    def test_oversized_source_is_rejected(self):
        self.prepare()
        with patch.object(metadata, "MAX_BYTES", 10):
            with self.assertRaisesRegex(ValueError, "new_output_and_bounded_source_required"):
                self.repair()
        self.assertFalse(self.output.exists())

    def test_encrypted_source_is_rejected(self):
        original = self.prepare(password="test-fixture-only")
        with self.assertRaisesRegex(ValueError, "unsupported_source"):
            self.repair()
        self.assertEqual(self.source.read_bytes(), original)
        self.assertFalse(self.output.exists())

    def test_signed_source_is_rejected(self):
        for signature in ["field", "perms", "orphan-widget", "inherited-widget", "value-widget"]:
            with self.subTest(signature=signature):
                original = self.prepare(signature=signature)
                with self.assertRaisesRegex(ValueError, "signed_pdf_not_supported"):
                    self.repair()
                self.assertEqual(self.source.read_bytes(), original)
                self.assertFalse(self.output.exists())

    def test_cyclic_widget_parent_fails_closed(self):
        self.prepare(signature="cyclic-widget")
        with self.assertRaisesRegex(ValueError, "signature_structure_invalid"):
            self.repair()
        self.assertFalse(self.output.exists())

    def test_evaluation_rejects_orphan_signature_before_running_tools(self):
        self.prepare(signature="orphan-widget")
        tools = self.directory / "toolchain.json"
        tools.write_text(json.dumps({"openDataLoader": {}, "veraPdf": {}}), encoding="utf-8")
        evaluation_output = self.directory / "evaluation"
        arguments = ["evaluate.py", "--toolchain", str(tools), "--output", str(evaluation_output), str(self.source)]
        with patch("sys.argv", arguments), patch.object(evaluate, "run_tool") as run_tool:
            with self.assertRaisesRegex(ValueError, "signed_pdf_not_supported"):
                evaluate.main()
            run_tool.assert_not_called()
        self.assertFalse(evaluation_output.exists())


if __name__ == "__main__":
    unittest.main()
