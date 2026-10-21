"""Bounded local regressions for explicitly authorized font substitution."""
from __future__ import annotations

import hashlib
import io
import os
from pathlib import Path
import tempfile
import unittest

from pypdf import PdfReader,PdfWriter
from pypdf.generic import ArrayObject,DictionaryObject,NameObject,NumberObject
from reportlab.pdfgen import canvas

import font_repairs as fonts
from verify_pdf import Canonicalizer

FONT_DIR=Path(os.environ.get('NATIVE_PDF_FONT_DIR',str(Path(__file__).resolve().parents[4]/'work/pdf-native-tools/fonts/liberation-fonts-ttf-2.1.5')))


def fixture(path):
    buffer=io.BytesIO();pdf=canvas.Canvas(buffer,pagesize=(300,220))
    pdf.setFont('Helvetica',12);pdf.drawString(20,180,'Readable café: 2–4; “quotes.”')
    pdf.setFont('Helvetica-Bold',16);pdf.drawString(20,145,'Original heading')
    pdf.setFont('Courier',10);pdf.drawString(20,110,'Code: a = 1; b = 2.')
    pdf.linkURL('https://example.org',rect=(20,170,200,190),relative=0)
    pdf.showPage();pdf.setFont('Helvetica',12);pdf.drawString(20,180,'The second page uses the shared font.')
    pdf.save();path.write_bytes(buffer.getvalue())


@unittest.skipUnless((FONT_DIR/'LiberationSans-Regular.ttf').exists(),'Local pinned Liberation font fixture not installed')
class FontRepairs(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.folder=Path(self.temp.name);self.source=self.folder/'source.pdf';self.output=self.folder/'output.pdf'
        fixture(self.source)

    def repair(self):
        return fonts.substitute_fonts(self.source,self.output,FONT_DIR,allow_font_substitution=True)

    def test_real_program_embedding_and_exact_text_layout(self):
        original=self.source.read_bytes();report=self.repair();source=PdfReader(self.source);output=PdfReader(self.output)
        self.assertEqual(self.source.read_bytes(),original)
        self.assertEqual(report['inputSha256'],hashlib.sha256(original).hexdigest())
        self.assertEqual(report['outputSha256'],hashlib.sha256(self.output.read_bytes()).hexdigest())
        self.assertEqual(report['layout']['maxCharacterOriginOrFontSizeDifferencePt'],0)
        self.assertTrue(report['layout']['unicodeSequenceIdentical'])
        self.assertFalse(report['certification'])
        for a,b in zip(source.pages,output.pages):
            self.assertEqual(a.get_contents().get_data(),b.get_contents().get_data())
            self.assertEqual(a.extract_text(),b.extract_text())
            self.assertEqual(Canonicalizer().hash(a.get('/Annots')),Canonicalizer().hash(b.get('/Annots')))
        for row in report['substitutions']:
            font=output.pages[row['pageNumber']-1]['/Resources']['/Font'][row['resourceName']]
            self.assertEqual(font['/Subtype'],'/TrueType')
            self.assertEqual(Canonicalizer().hash(font),row['targetFontSha256'])
            program=font['/FontDescriptor']['/FontFile2'].get_data()
            self.assertGreater(len(program),100_000)
            self.assertEqual(hashlib.sha256(program).hexdigest(),row['fontProgramSha256'])
            self.assertIn(b'beginbfchar',font['/ToUnicode'].get_data())
            self.assertTrue(row['usedAdvanceWidthsMatched'])
        self.assertNotIn(b'pdfuaid',self.output.read_bytes())

    def test_requires_explicit_substitution_authorization(self):
        with self.assertRaisesRegex(ValueError,'explicit_font_substitution_required'):
            fonts.substitute_fonts(self.source,self.output,FONT_DIR)
        self.assertFalse(self.output.exists())

    def test_wrong_font_program_hash_rejected(self):
        directory=self.folder/'fonts';directory.mkdir()
        for filename,_,_ in fonts.FONTS.values():
            (directory/filename).write_bytes((FONT_DIR/filename).read_bytes()+b'changed')
        with self.assertRaisesRegex(ValueError,'font_program_hash_mismatch'):
            fonts.substitute_fonts(self.source,self.output,directory,allow_font_substitution=True)
        self.assertFalse(self.output.exists())

    def test_custom_encoding_is_not_guessed(self):
        writer=PdfWriter(clone_from=self.source)
        target=next(iter(writer.pages[0]['/Resources']['/Font'].values())).get_object()
        target[NameObject('/Encoding')]=DictionaryObject({NameObject('/Differences'):ArrayObject([NumberObject(65),NameObject('/Omega')])})
        writer.write(self.source)
        with self.assertRaisesRegex(ValueError,'unsupported_source_font_encoding_or_metrics'):self.repair()
        self.assertFalse(self.output.exists())

    def test_custom_advance_metrics_are_not_replaced(self):
        writer=PdfWriter(clone_from=self.source)
        target=next(iter(writer.pages[0]['/Resources']['/Font'].values())).get_object()
        target[NameObject('/Widths')]=ArrayObject([NumberObject(400)])
        writer.write(self.source)
        with self.assertRaisesRegex(ValueError,'unsupported_source_font_encoding_or_metrics'):self.repair()

    def test_signatures_are_rejected(self):
        writer=PdfWriter(clone_from=self.source);writer.root_object[NameObject('/Perms')]=DictionaryObject();writer.write(self.source)
        with self.assertRaisesRegex(ValueError,'signed_pdf_not_supported'):self.repair()

    def test_forms_require_separate_scope_validation(self):
        writer=PdfWriter(clone_from=self.source)
        writer.root_object[NameObject('/AcroForm')]=DictionaryObject({NameObject('/Fields'):ArrayObject()});writer.write(self.source)
        with self.assertRaisesRegex(ValueError,'form_fonts_unsupported'):self.repair()

    def test_original_and_existing_output_cannot_be_overwritten(self):
        original=self.source.read_bytes()
        with self.assertRaisesRegex(ValueError,'new_output_and_bounded_source_required'):
            fonts.substitute_fonts(self.source,self.source,FONT_DIR,allow_font_substitution=True)
        self.output.write_bytes(b'keep')
        with self.assertRaisesRegex(ValueError,'new_output_and_bounded_source_required'):self.repair()
        self.assertEqual(self.output.read_bytes(),b'keep');self.assertEqual(self.source.read_bytes(),original)

    def test_geometry_gate_rejects_unicode_or_origin_drift(self):
        baseline=[{'size':(300,220),'chars':[(65,20.0,180.0,12.0)]}]
        with self.assertRaisesRegex(ValueError,'font_substitution_changed_unicode'):
            fonts.measure_layout(baseline,[{'size':(300,220),'chars':[(66,20.0,180.0,12.0)]}])
        with self.assertRaisesRegex(ValueError,'font_substitution_moved_text'):
            fonts.measure_layout(baseline,[{'size':(300,220),'chars':[(65,20.1,180.0,12.0)]}])


if __name__=='__main__':unittest.main()
