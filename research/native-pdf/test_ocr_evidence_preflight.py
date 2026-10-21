"""Image identity must be established before an OCR model receives any bytes."""
import hashlib
import json
from pathlib import Path
import tempfile
import unittest

from PIL import Image, PngImagePlugin

from ocr_evidence_preflight import verify_review_images
import ocr_evidence_preflight as preflight
from test_scan_ocr import create_source, evidence_and_plan, FONT_DIR


@unittest.skipUnless((FONT_DIR/'LiberationSans-Regular.ttf').is_file(), 'Pinned local font fixture unavailable')
class OcrEvidencePreflightTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='ocr-upload-preflight-')
        self.addCleanup(self.temp.cleanup)
        self.folder = Path(self.temp.name)
        self.source = create_source(self.folder)
        _, self.evidence_path, _ = evidence_and_plan(self.source, self.folder)
        self.evidence = json.loads(self.evidence_path.read_text())
        self.image_path = Path(self.evidence['pages'][0]['imagePath'])

    def save_evidence(self):
        self.evidence_path.write_text(json.dumps(self.evidence), encoding='utf-8')

    def rebind_image(self, *, pixels=True):
        page = self.evidence['pages'][0]
        page['imageSha256'] = hashlib.sha256(self.image_path.read_bytes()).hexdigest()
        if pixels:
            with Image.open(self.image_path) as image:
                page['pixelSha256'] = hashlib.sha256(image.convert('RGB').tobytes()).hexdigest()
        self.save_evidence()

    def assert_clean_canonical_render(self):
        directory = self.folder/'canonical-source-renders'
        snapshots = [path.read_bytes() for path in (self.source,self.evidence_path,self.image_path)]
        result = verify_review_images(self.source,self.evidence_path,render_directory=directory)
        self.assertTrue(result['passed']); self.assertEqual(len(result['renders']),1)
        saved = Path(result['renders'][0]['path'])
        self.assertEqual(saved.parent,directory)
        self.assertNotEqual(saved,self.image_path)
        data = saved.read_bytes()
        self.assertEqual(hashlib.sha256(data).hexdigest(),result['renders'][0]['sha256'])
        with Image.open(saved) as image:
            self.assertEqual(image.mode,'RGB'); self.assertFalse(image.info)
            self.assertEqual(hashlib.sha256(image.tobytes()).hexdigest(),self.evidence['pages'][0]['pixelSha256'])
        # Decode PNG framing independently: fresh output contains only image
        # chunks and stops immediately after IEND, with no uploaded extra bytes.
        self.assertEqual(data[:8],b'\x89PNG\r\n\x1a\n')
        offset=8; types=[]
        while offset<len(data):
            length=int.from_bytes(data[offset:offset+4],'big'); kind=data[offset+4:offset+8]
            types.append(kind); offset+=12+length
            if kind==b'IEND':break
        self.assertEqual(offset,len(data)); self.assertEqual(types[-1],b'IEND')
        self.assertTrue(set(types)<={b'IHDR',b'IDAT',b'IEND'})
        self.assertNotIn(b'Fictional unrelated',data)
        self.assertEqual(snapshots,[path.read_bytes() for path in (self.source,self.evidence_path,self.image_path)])

    def test_exact_source_render_passes_without_changing_any_file(self):
        paths = (self.source, self.evidence_path, self.image_path)
        snapshots = [p.read_bytes() for p in paths]
        result = verify_review_images(self.source, self.evidence_path)
        self.assertTrue(result['passed'])
        self.assertEqual(result['sourceSha256'], hashlib.sha256(snapshots[0]).hexdigest())
        self.assertEqual(result['ocrEvidenceSha256'], hashlib.sha256(snapshots[1]).hexdigest())
        self.assertEqual(result['pages'], 1)
        self.assertEqual(snapshots, [p.read_bytes() for p in paths])

    def test_unrelated_png_with_rebound_file_and_pixel_hashes_is_rejected(self):
        with Image.open(self.image_path) as original:
            dimensions = original.size
        Image.new('RGB', dimensions, (17, 43, 91)).save(self.image_path)
        self.rebind_image()
        target=self.folder/'rejected-render'
        with self.assertRaisesRegex(ValueError, 'review_image_not_source_render'):
            verify_review_images(self.source, self.evidence_path,render_directory=target)
        self.assertEqual(list(target.iterdir()),[])

    def test_one_changed_pixel_is_detected_even_with_rebound_hashes(self):
        with Image.open(self.image_path) as original:
            changed = original.convert('RGB')
        changed.putpixel((10, 10), (0, 0, 0)); changed.save(self.image_path)
        self.rebind_image()
        with self.assertRaisesRegex(ValueError, 'review_image_not_source_render'):
            verify_review_images(self.source, self.evidence_path)

    def test_wrong_source_hash_is_rejected(self):
        self.evidence['sourceSha256'] = '0'*64; self.save_evidence()
        with self.assertRaisesRegex(ValueError, 'ocr_source_evidence_mismatch'):
            verify_review_images(self.source, self.evidence_path)

    def test_different_pdf_cannot_use_the_original_evidence(self):
        other_folder = self.folder/'other'; other_folder.mkdir()
        other = create_source(other_folder, hidden=['Different hidden text.'])
        with self.assertRaisesRegex(ValueError, 'ocr_source_evidence_mismatch'):
            verify_review_images(other, self.evidence_path)

    def test_changed_actual_png_dimensions_rejected_before_render_upload(self):
        with Image.open(self.image_path) as original:
            image = original.convert('RGB')
        image = image.crop((0, 0, image.width-1, image.height)); image.save(self.image_path)
        self.evidence['pages'][0]['widthPixels'] = image.width
        self.rebind_image()
        with self.assertRaisesRegex(ValueError, 'ocr_source_image_geometry'):
            verify_review_images(self.source, self.evidence_path)

    def test_declared_dimensions_and_source_geometry_cannot_be_rebound(self):
        self.evidence['pages'][0]['widthPt'] += 1; self.save_evidence()
        with self.assertRaisesRegex(ValueError, 'ocr_source_geometry_mismatch'):
            verify_review_images(self.source, self.evidence_path)

    def test_source_rgb_values_do_not_authorize_transparent_upload(self):
        with Image.open(self.image_path) as original:
            image = original.convert('RGBA')
        image.putalpha(0); image.save(self.image_path); self.rebind_image()
        with self.assertRaises(ValueError):
            verify_review_images(self.source, self.evidence_path)

    def test_unrelated_png_metadata_is_excluded_from_canonical_upload(self):
        with Image.open(self.image_path) as original:
            image = original.convert('RGB')
        info = PngImagePlugin.PngInfo(); info.add_text('PrivateUnrelatedNote', 'Fictional unrelated private file payload')
        image.save(self.image_path, pnginfo=info); self.rebind_image()
        self.assert_clean_canonical_render()

    def test_trailing_png_payload_is_excluded_from_canonical_upload(self):
        self.image_path.write_bytes(self.image_path.read_bytes()+b'Fictional unrelated trailing file payload')
        self.rebind_image()
        self.assert_clean_canonical_render()

    def test_existing_render_directory_is_not_overwritten(self):
        directory=self.folder/'existing';directory.mkdir()
        marker=directory/'retain.txt';marker.write_text('Keep this file')
        with self.assertRaisesRegex(ValueError,'new_external_review_render_directory_required'):
            verify_review_images(self.source,self.evidence_path,render_directory=directory)
        self.assertEqual(marker.read_text(),'Keep this file')

    def test_canonical_renders_cannot_be_saved_in_repository(self):
        directory=Path(preflight.__file__).resolve().parents[2]/'uncreated-preflight-test-directory'
        self.assertFalse(directory.exists())
        with self.assertRaisesRegex(ValueError,'new_external_review_render_directory_required'):
            verify_review_images(self.source,self.evidence_path,render_directory=directory)
        self.assertFalse(directory.exists())


if __name__ == '__main__':
    unittest.main()
