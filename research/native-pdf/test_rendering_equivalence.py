"""Bounded multiscale evidence never substitutes for saved PDF preservation.

Synthetic image differences make the numerical boundaries deterministic. Saved
PDF mutations exercise the real content/resource/behavior gates independently of
those renders; the documents and all generated artifacts remain temporary.
"""
from pathlib import Path
import tempfile
import unittest
from unittest.mock import MagicMock, Mock, patch

from PIL import Image
from pypdf import PdfReader, PdfWriter
from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject, NumberObject

import verify_pdf as v
from test_native_pdf_validation import pdf_bytes


class RenderingEquivalenceTests(unittest.TestCase):
    def setUp(self):
        self.documents = [MagicMock(name="source_document"), MagicMock(name="output_document")]
        self.images = []

    def image(self, size=(1000, 1000), changed=0):
        image = Image.new("RGB", size, "white")
        for index in range(changed):
            image.putpixel((index % size[0], index // size[0]), (254, 255, 255))
        image.close = Mock(wraps=image.close)
        self.images.append(image)
        return image

    def run_evidence(self, *, changed=1, size=(1000, 1000),
                     changed_secondary=None, changed_size_scale=None, pages=None):
        def render(document, page_number, scale):
            output = document is self.documents[1]
            dimensions = (size[0] + 1, size[1]) if output and scale == changed_size_scale else size
            difference = changed if scale == v.RENDER_SCALE else (1 if scale == changed_secondary else 0)
            return self.image(dimensions, difference if output else 0)

        with patch("pypdfium2.PdfDocument", side_effect=self.documents) as open_document, \
                patch.object(v, "rendered_page_image", side_effect=render) as render_image:
            result = v.verify_rendering_equivalence(Path("source.pdf"), Path("output.pdf"), pages or [1])
        for document in self.documents:
            document.close.assert_called_once_with()
        for image in self.images:
            image.close.assert_called_once_with()
        return result, open_document, render_image

    def test_tiny_primary_difference_requires_both_exact_secondary_renders(self):
        result, _, render = self.run_evidence(changed=100)
        self.assertEqual(result, {1: {"pageNumber": 1, "changedPixels": 100,
            "totalPixels": 1000000, "verificationScales": [1, 2]}})
        self.assertEqual([call.args[2] for call in render.call_args_list], [1.5, 1.5, 1, 1, 2, 2])

    def test_absolute_threshold_accepts_128_but_rejects_129_pixels(self):
        for changed, accepted in ((128, True), (129, False)):
            with self.subTest(changed=changed):
                self.setUp()
                result, _, _ = self.run_evidence(changed=changed, size=(2000, 1000))
                self.assertEqual(bool(result), accepted)

    def test_fraction_threshold_is_not_replaced_by_absolute_threshold(self):
        result, _, render = self.run_evidence(changed=101)
        self.assertEqual(result, {})
        self.assertEqual(render.call_count, 2)

    def test_one_pixel_on_too_small_a_page_is_not_eligible(self):
        result, _, render = self.run_evidence(changed=1, size=(99, 99))
        self.assertEqual(result, {})
        self.assertEqual(render.call_count, 2)

    def test_exact_primary_pixels_do_not_claim_a_drift_exception(self):
        result, _, render = self.run_evidence(changed=0)
        self.assertEqual(result, {})
        self.assertEqual(render.call_count, 2)

    def test_any_difference_at_either_secondary_scale_rejects(self):
        for scale in (1, 2):
            with self.subTest(scale=scale):
                self.setUp()
                result, _, render = self.run_evidence(changed_secondary=scale)
                self.assertEqual(result, {})
                self.assertEqual(render.call_count, 4 if scale == 1 else 6)

    def test_size_change_at_any_scale_rejects(self):
        for scale in (1.5, 1, 2):
            with self.subTest(scale=scale):
                self.setUp()
                result, _, _ = self.run_evidence(changed_size_scale=scale)
                self.assertEqual(result, {})

    def test_zero_or_more_than_eight_pages_does_not_start_rendering(self):
        for pages in ([], list(range(1, 10))):
            with self.subTest(pages=pages), patch("pypdfium2.PdfDocument") as open_document, \
                    patch.object(v, "rendered_page_image") as render:
                self.assertEqual(v.verify_rendering_equivalence(Path("source.pdf"), Path("output.pdf"), pages), {})
                open_document.assert_not_called()
                render.assert_not_called()

    def test_eight_pages_are_checked_and_numbering_is_preserved(self):
        result, _, render = self.run_evidence(pages=list(range(1, 9)), size=(100, 100))
        self.assertEqual(list(result), list(range(1, 9)))
        self.assertEqual(render.call_count, 48)
        self.assertEqual([call.args[1] for call in render.call_args_list[::6]], list(range(8)))

    def test_second_document_open_failure_closes_first_document(self):
        with patch("pypdfium2.PdfDocument", side_effect=[self.documents[0], RuntimeError("test")]):
            with self.assertRaises(RuntimeError):
                v.verify_rendering_equivalence(Path("source.pdf"), Path("output.pdf"), [1])
        self.documents[0].close.assert_called_once_with()

    def test_partial_render_failure_closes_images_and_both_documents(self):
        for fail_after in (1, 3, 5):
            with self.subTest(fail_after=fail_after):
                self.setUp()
                images = [self.image(changed=1 if index == 1 else 0) for index in range(fail_after)]
                with patch("pypdfium2.PdfDocument", side_effect=self.documents), \
                        patch.object(v, "rendered_page_image", side_effect=[*images, v.InspectionError("render_pixel_limit")]):
                    with self.assertRaises(v.InspectionError):
                        v.verify_rendering_equivalence(Path("source.pdf"), Path("output.pdf"), [1])
                for document in self.documents:
                    document.close.assert_called_once_with()
                for image in images:
                    image.close.assert_called_once_with()


class BoundedPageRenderingTests(unittest.TestCase):
    def page_document(self, size):
        page = MagicMock()
        page.get_size.return_value = size
        document = MagicMock()
        document.__getitem__.return_value = page
        return page, document

    def test_pixel_limit_is_checked_before_native_render_and_page_always_closes(self):
        for size in ((1001, 1000), (float("inf"), 1000), (float("nan"), 1000), (0, 1000), (-1, 1000)):
            with self.subTest(size=size):
                page, document = self.page_document(size)
                with self.assertRaisesRegex(v.InspectionError, "render_pixel_limit"):
                    v.rendered_page_image(document, 0, 2)
                page.render.assert_not_called()
                page.close.assert_called_once_with()

    def test_exact_four_million_pixel_boundary_is_allowed_and_resources_close(self):
        page, document = self.page_document((1000, 1000))
        bitmap = page.render.return_value
        pil = bitmap.to_pil.return_value
        result = v.rendered_page_image(document, 0, 2)
        self.assertIs(result, pil.convert.return_value)
        page.render.assert_called_once_with(scale=2, rotation=0, draw_annots=True)
        pil.close.assert_called_once_with()
        bitmap.close.assert_called_once_with()
        page.close.assert_called_once_with()

    def test_bitmap_and_page_close_on_pil_conversion_failure(self):
        page, document = self.page_document((200, 100))
        bitmap = page.render.return_value
        bitmap.to_pil.side_effect = RuntimeError("test")
        with self.assertRaises(RuntimeError):
            v.rendered_page_image(document, 0, 1.5)
        bitmap.close.assert_called_once_with()
        page.close.assert_called_once_with()

    def test_pil_bitmap_and_page_close_on_rgb_conversion_failure(self):
        page, document = self.page_document((200, 100))
        bitmap = page.render.return_value
        pil = bitmap.to_pil.return_value
        pil.convert.side_effect = RuntimeError("test")
        with self.assertRaises(RuntimeError):
            v.rendered_page_image(document, 0, 1.5)
        pil.close.assert_called_once_with()
        bitmap.close.assert_called_once_with()
        page.close.assert_called_once_with()


class SavedPdfPreservationGateTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.source = Path(temp.name) / "source.pdf"
        self.output = Path(temp.name) / "output.pdf"
        self.source.write_bytes(pdf_bytes(tagged=True))
        self.output.write_bytes(self.source.read_bytes())

    def mutate(self, mutation):
        writer = PdfWriter(clone_from=PdfReader(self.source))
        mutation(writer)
        with self.output.open("wb") as output:
            writer.write(output)

    def compare_with_drift(self):
        source_hash = [{"width": 1000, "height": 1000, "sha256": "source"}]
        output_hash = [{"width": 1000, "height": 1000, "sha256": "output"}]
        evidence = {1: {"pageNumber": 1, "changedPixels": 1, "totalPixels": 1000000, "verificationScales": [1, 2]}}
        with patch.object(v, "rendered_page_hashes", side_effect=[source_hash, output_hash]), \
                patch.object(v, "verify_rendering_equivalence", return_value=evidence) as equivalence:
            report = v.compare_pdfs(self.source, self.output)
        return report, equivalence

    def test_explicit_evidence_passes_without_falsely_claiming_pixel_identity(self):
        report, equivalence = self.compare_with_drift()
        self.assertTrue(report["passed"], report["findings"])
        self.assertTrue(report["preservation"]["passed"])
        page = report["preservation"]["pages"][0]
        self.assertFalse(page["pixels_identical"])
        self.assertEqual(page["rendering_equivalence"]["changedPixels"], 1)
        self.assertEqual(report["preservation"]["rendering_equivalence"]["method"], "identical-paint-multiscale-v1")
        self.assertFalse(report["certification"])
        equivalence.assert_called_once_with(self.source, self.output, [1])

    def test_changed_saved_paint_resources_or_behavior_cannot_use_exception(self):
        def paint(writer):
            page = writer.pages[0]
            stream = DecodedStreamObject()
            stream.set_data(page.get_contents().get_data() + b" 0 g")
            page[NameObject("/Contents")] = writer._add_object(stream)

        def resource(writer):
            writer.pages[0]["/Resources"][NameObject("/ExtGState")] = DictionaryObject({
                NameObject("/Unused"): DictionaryObject({NameObject("/Type"): NameObject("/ExtGState")})})

        def behavior(writer):
            writer.pages[0][NameObject("/Dur")] = NumberObject(10)

        for mutation, finding in ((paint, "drawing_operators_changed"),
                                  (resource, "resources_changed"), (behavior, "page_properties_changed")):
            with self.subTest(mutation=mutation.__name__):
                self.mutate(mutation)
                report, equivalence = self.compare_with_drift()
                self.assertFalse(report["preservation"]["passed"])
                self.assertIn(finding, [item["code"] for item in report["findings"]])
                self.assertIn("page_pixels_changed", [item["code"] for item in report["findings"]])
                self.assertNotIn("rendering_equivalence", report["preservation"])
                equivalence.assert_not_called()

    def test_changed_text_cannot_use_exception(self):
        self.output.write_bytes(pdf_bytes(tagged=True, text="Other"))
        report, equivalence = self.compare_with_drift()
        self.assertFalse(report["preservation"]["passed"])
        self.assertIn("extracted_text_changed", [item["code"] for item in report["findings"]])
        equivalence.assert_not_called()

    def test_same_pixel_hashes_do_not_override_changed_saved_paint(self):
        self.output.write_bytes(pdf_bytes(tagged=True, text="Other"))
        pixels = [{"width": 300, "height": 150, "sha256": "same"}]
        with patch.object(v, "rendered_page_hashes", return_value=pixels), \
                patch.object(v, "verify_rendering_equivalence") as equivalence:
            report = v.compare_pdfs(self.source, self.output)
        self.assertTrue(report["preservation"]["pages"][0]["pixels_identical"])
        self.assertFalse(report["preservation"]["passed"])
        equivalence.assert_not_called()

    def test_real_equal_renders_do_not_override_changed_paint_or_unused_resource(self):
        def paint(writer):
            page = writer.pages[0]
            stream = DecodedStreamObject()
            stream.set_data(page.get_contents().get_data() + b" 0 g")
            page[NameObject("/Contents")] = writer._add_object(stream)

        def resource(writer):
            writer.pages[0]["/Resources"][NameObject("/ExtGState")] = DictionaryObject({
                NameObject("/Unused"): DictionaryObject({NameObject("/Type"): NameObject("/ExtGState")})})

        for mutation in (paint, resource):
            with self.subTest(mutation=mutation.__name__):
                self.mutate(mutation)
                with patch.object(v, "verify_rendering_equivalence") as equivalence:
                    report = v.compare_pdfs(self.source, self.output)
                self.assertTrue(report["preservation"]["pages"][0]["pixels_identical"])
                self.assertFalse(report["preservation"]["passed"])
                equivalence.assert_not_called()

    def test_later_structure_failures_cannot_be_dismissed_by_render_evidence(self):
        self.output.write_bytes(pdf_bytes(tagged=True, bad_parent=True))
        report, equivalence = self.compare_with_drift()
        self.assertTrue(equivalence.called)
        self.assertFalse(report["passed"])
        self.assertFalse(report["structure"]["machine_checks_passed"])
        self.assertIn("parent_tree_owner_mismatch", [item["code"] for item in report["structure"]["findings"]])

    def test_lost_authored_description_still_fails_after_render_evidence(self):
        self.source.write_bytes(pdf_bytes(tagged=True, alt="Original description"))
        self.output.write_bytes(pdf_bytes(tagged=True, alt="Changed description"))
        report, equivalence = self.compare_with_drift()
        self.assertTrue(equivalence.called)
        self.assertFalse(report["passed"])
        self.assertFalse(report["preservation"]["passed"])
        self.assertIn("authored_alternative_lost_or_changed", [item["code"] for item in report["findings"]])

    def test_missing_equivalence_evidence_keeps_pixel_failure(self):
        with patch.object(v, "rendered_page_hashes", side_effect=[[{"sha256": "source"}], [{"sha256": "output"}]]), \
                patch.object(v, "verify_rendering_equivalence", return_value={}):
            report = v.compare_pdfs(self.source, self.output)
        self.assertFalse(report["preservation"]["passed"])
        self.assertIn("page_pixels_changed", [item["code"] for item in report["findings"]])


if __name__ == "__main__":
    unittest.main()
