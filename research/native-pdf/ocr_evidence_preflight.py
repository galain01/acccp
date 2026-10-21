"""Prove every OCR review image is a render of the supplied PDF before upload.

Default is read only. An optional new external directory receives fresh RGB
renders for upload, so unrelated PNG metadata is never sent to the model.
No credentials, model calls, PDF writes or approval decisions.
"""
from __future__ import annotations
import argparse
import hashlib
import json
import math
from pathlib import Path
import sys

from PIL import Image
import pypdfium2 as pdfium
from scan_ocr import inspect_scan, file_hash, DPI, MAX_RENDER_PIXELS


def verify_review_images(source, evidence_path, render_directory=None):
    source, evidence_path = Path(source), Path(evidence_path)
    if not evidence_path.is_file() or evidence_path.stat().st_size > 4*1024*1024:
        raise ValueError('bounded_ocr_evidence_required')
    snapshot = evidence_path.read_bytes()
    evidence = json.loads(snapshot)
    inspection = inspect_scan(source)
    if render_directory is not None:
        render_directory=Path(render_directory).resolve()
        if render_directory.exists() or render_directory.is_relative_to(Path(__file__).resolve().parents[2]):
            raise ValueError('new_external_review_render_directory_required')
        render_directory.mkdir()
    if (evidence.get('schemaVersion') != 1 or evidence.get('sourceSha256') != inspection['sourceSha256']
            or evidence.get('dpi') != DPI or evidence.get('language') != 'eng'
            or not isinstance(evidence.get('pages'), list) or len(evidence['pages']) != len(inspection['pages'])):
        raise ValueError('ocr_source_evidence_mismatch')
    checked = [];renders=[]
    with pdfium.PdfDocument(str(source)) as pdf:
        for actual, declared in zip(inspection['pages'], evidence['pages']):
            if any(declared.get(key) != value for key, value in actual.items()):
                raise ValueError('ocr_source_geometry_mismatch')
            expected = (math.ceil(actual['widthPt']*(DPI/72)), math.ceil(actual['heightPt']*(DPI/72)))
            path = Path(declared['imagePath'])
            if (not path.is_absolute() or not path.is_file() or path.stat().st_size > 20*1024*1024
                    or expected[0]*expected[1] > MAX_RENDER_PIXELS or file_hash(path) != declared['imageSha256']):
                raise ValueError('ocr_source_image_limit_or_hash')
            with Image.open(path) as png:
                if png.format != 'PNG' or png.mode != 'RGB' or png.size != expected or 'transparency' in png.info:
                    raise ValueError('ocr_source_image_geometry')
                pixels = png.convert('RGB').tobytes()
            page = pdf[actual['pageNumber']-1]
            bitmap = page.render(scale=DPI/72)
            try:
                image = bitmap.to_pil().convert('RGB')
                if (image.size != expected or pixels != image.tobytes()
                        or hashlib.sha256(pixels).hexdigest() != declared['pixelSha256']
                        or (declared['widthPixels'],declared['heightPixels']) != expected):
                    raise ValueError('review_image_not_source_render')
                if render_directory is not None:
                    output=render_directory/f"page-{actual['pageNumber']}.png"
                    # Copy RGB pixels only, dropping all source-container metadata.
                    Image.frombytes('RGB',image.size,image.tobytes()).save(output,format='PNG')
                    renders.append({'pageNumber':actual['pageNumber'],'path':str(output),'sha256':file_hash(output)})
            finally:
                bitmap.close();page.close()
            checked.append((path,declared['imageSha256']))
    if (file_hash(source) != inspection['sourceSha256'] or evidence_path.read_bytes() != snapshot
            or any(file_hash(path) != digest for path,digest in checked)):
        raise ValueError('ocr_evidence_changed_during_preflight')
    return {'passed':True,'sourceSha256':inspection['sourceSha256'],
            'ocrEvidenceSha256':hashlib.sha256(snapshot).hexdigest(),'pages':len(checked),
            **({'renders':renders} if render_directory is not None else {})}


if __name__ == '__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source',type=Path);parser.add_argument('evidence',type=Path)
    parser.add_argument('--render-directory',type=Path)
    args=parser.parse_args()
    try:
        print(json.dumps(verify_review_images(args.source,args.evidence,args.render_directory)))
    except Exception:
        print(json.dumps({'passed':False,'reason':'original_pdf_render_identity_not_verified'}))
        sys.exit(1)
