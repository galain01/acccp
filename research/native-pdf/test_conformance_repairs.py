import hashlib
from pathlib import Path
import tempfile
import unittest

from pypdf import PdfReader, PdfWriter
from pypdf.generic import (ArrayObject, BooleanObject, DecodedStreamObject, DictionaryObject,
                           NameObject, NumberObject, TextStringObject)
import pypdfium2 as pdfium

from conformance_repairs import (font_resources, repair_conformance_details,
                                 stage_pdfua1_declaration, UA)


def fixture(path, *, linked=True, zapf=False, signed=False, xmp=True):
    writer = PdfWriter()
    page = writer.add_blank_page(width=200, height=200)
    font = DictionaryObject({NameObject('/Type'): NameObject('/Font'),
                             NameObject('/Subtype'): NameObject('/Type1'),
                             NameObject('/BaseFont'): NameObject('/ZapfDingbats' if zapf else '/Helvetica')})
    page[NameObject('/Resources')] = DictionaryObject({NameObject('/Font'): DictionaryObject({NameObject('/F1'): writer._add_object(font)})})
    content = DecodedStreamObject()
    content.set_data(b'BT /F1 12 Tf 20 100 Td (4) Tj ET')
    page[NameObject('/Contents')] = writer._add_object(content)
    annotation = DictionaryObject({NameObject('/Type'): NameObject('/Annot'), NameObject('/Subtype'): NameObject('/Link'),
                                   NameObject('/Rect'): ArrayObject([NumberObject(i) for i in (20,90,30,110)]),
                                   NameObject('/StructParent'): NumberObject(0)})
    annotation_ref = writer._add_object(annotation)
    page[NameObject('/Annots')] = ArrayObject([annotation_ref])
    structure = DictionaryObject({NameObject('/Type'): NameObject('/StructTreeRoot')})
    structure_ref = writer._add_object(structure)
    owner = DictionaryObject({NameObject('/Type'): NameObject('/StructElem'), NameObject('/S'): NameObject('/Link'),
                              NameObject('/P'): structure_ref, NameObject('/Pg'): page.indirect_reference})
    owner_ref = writer._add_object(owner)
    owner[NameObject('/K')] = DictionaryObject({NameObject('/Type'): NameObject('/OBJR'),
                                               NameObject('/Obj'): annotation_ref, NameObject('/Pg'): page.indirect_reference})
    structure[NameObject('/K')] = ArrayObject([owner_ref])
    structure[NameObject('/ParentTree')] = DictionaryObject({NameObject('/Nums'): ArrayObject([NumberObject(0), owner_ref if linked else structure_ref])})
    writer.root_object[NameObject('/StructTreeRoot')] = structure_ref
    writer.root_object[NameObject('/Lang')] = TextStringObject('en-US')
    writer.root_object[NameObject('/ViewerPreferences')] = DictionaryObject({NameObject('/HideToolbar'): BooleanObject(True)})
    writer.add_metadata({'/Title': 'Real authored title'})
    if xmp:
        metadata = DecodedStreamObject()
        metadata.set_data(b'<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:custom="urn:custom" custom:unchanged="yes"/></rdf:RDF></x:xmpmeta>')
        metadata[NameObject('/Type')] = NameObject('/Metadata')
        metadata[NameObject('/Subtype')] = NameObject('/XML')
        writer.root_object[NameObject('/Metadata')] = writer._add_object(metadata)
    if signed:
        writer.root_object[NameObject('/Perms')] = DictionaryObject()
    with path.open('xb') as stream:
        writer.write(stream)


def pixels(path):
    with pdfium.PdfDocument(str(path)) as pdf:
        page = pdf[0]
        bitmap = page.render(scale=1)
        try:
            return hashlib.sha256(bitmap.to_pil().tobytes()).hexdigest()
        finally:
            bitmap.close()
            page.close()


class ConformanceRepairsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.source = Path(self.temp.name) / 'source.pdf'
        self.output = Path(self.temp.name) / 'candidate.pdf'

    def test_safe_details_preserve_pixels_metadata_fonts_and_source(self):
        fixture(self.source)
        source_bytes = self.source.read_bytes()
        report = repair_conformance_details(self.source, self.output)
        self.assertEqual(source_bytes, self.source.read_bytes())
        self.assertEqual(pixels(self.source), pixels(self.output))
        out = PdfReader(self.output)
        self.assertEqual(out.pages[0]['/Tabs'], '/S')
        self.assertTrue(out.trailer['/Root']['/ViewerPreferences']['/HideToolbar'].value)
        self.assertTrue(out.trailer['/Root']['/ViewerPreferences']['/DisplayDocTitle'].value)
        metadata = out.trailer['/Root']['/Metadata'].get_data()
        self.assertIn(b'custom:unchanged="yes"', metadata)
        self.assertIn(b'Real authored title', metadata)
        self.assertNotIn(UA.encode(), metadata)
        self.assertFalse(report['conformance_declaration_added'])
        self.assertFalse(report['certification'])
        self.assertFalse(report['font_resources'][0]['embedded_program'])
        self.assertEqual('/Helvetica', report['font_resources'][0]['base_font'])

    def test_unlinked_annotations_are_not_given_structure_tab_order(self):
        fixture(self.source, linked=False)
        report = repair_conformance_details(self.source, self.output)
        self.assertNotIn('/Tabs', PdfReader(self.output).pages[0])
        self.assertIn({'code': 'annotation_structure_unverified', 'page': 1}, report['unresolved'])

    def test_canonical_zapf_unicode_mapping_preserves_glyph_rendering(self):
        fixture(self.source, zapf=True)
        report = repair_conformance_details(self.source, self.output)
        cmap = PdfReader(self.output).pages[0]['/Resources']['/Font']['/F1']['/ToUnicode'].get_data()
        self.assertIn(b'<34> <2714>', cmap)
        self.assertEqual(pixels(self.source), pixels(self.output))
        self.assertFalse(report['font_resources'][0]['embedded_program'])

    def test_font_inventory_includes_appearance_and_default_resources(self):
        fixture(self.source)
        writer = PdfWriter(clone_from=self.source)
        font = DictionaryObject({NameObject('/Type'): NameObject('/Font'), NameObject('/BaseFont'): NameObject('/DefaultOnly'), NameObject('/Subtype'): NameObject('/Type1')})
        writer.root_object[NameObject('/AcroForm')] = DictionaryObject({NameObject('/DR'): DictionaryObject({NameObject('/Font'): DictionaryObject({NameObject('/Extra'): writer._add_object(font)})})})
        inventory = font_resources(writer.root_object)
        self.assertTrue(any(item['base_font'] == '/DefaultOnly' and '/AcroForm/DR' in item['location'] for item in inventory))

    def test_custom_zapf_encoding_is_left_for_review(self):
        fixture(self.source, zapf=True)
        writer = PdfWriter(clone_from=self.source)
        writer.pages[0]['/Resources']['/Font']['/F1'][NameObject('/Encoding')] = DictionaryObject({NameObject('/Differences'): ArrayObject([NumberObject(52), NameObject('/space')])})
        custom = self.source.with_name('custom.pdf')
        with custom.open('xb') as stream:
            writer.write(stream)
        report = repair_conformance_details(custom, self.output)
        self.assertNotIn('/ToUnicode', PdfReader(self.output).pages[0]['/Resources']['/Font']['/F1'])
        self.assertFalse(any(change['code'] == 'standard_zapfdingbats_unicode_map' for change in report['changes']))

    def test_existing_xmp_title_is_not_replaced(self):
        fixture(self.source)
        first = self.output.with_name('first.pdf')
        repair_conformance_details(self.source, first)
        metadata = PdfReader(first).trailer['/Root']['/Metadata'].get_data()
        repair_conformance_details(first, self.output)
        self.assertEqual(metadata, PdfReader(self.output).trailer['/Root']['/Metadata'].get_data())

    def test_missing_metadata_adds_real_title_without_declaration(self):
        fixture(self.source, xmp=False)
        repair_conformance_details(self.source, self.output)
        metadata = PdfReader(self.output).trailer['/Root']['/Metadata'].get_data()
        self.assertIn(b'Real authored title', metadata)
        self.assertNotIn(UA.encode(), metadata)

    def test_staged_declaration_requires_explicit_flag_and_matching_hash(self):
        fixture(self.source)
        digest = hashlib.sha256(self.source.read_bytes()).hexdigest()
        with self.assertRaisesRegex(ValueError, 'explicit_staged'):
            stage_pdfua1_declaration(self.source, self.output, expected_sha256=digest)
        with self.assertRaisesRegex(ValueError, 'candidate_hash'):
            stage_pdfua1_declaration(self.source, self.output, expected_sha256='0' * 64, evaluation_only=True)
        self.assertFalse(self.output.exists())
        report = stage_pdfua1_declaration(self.source, self.output, expected_sha256=digest, evaluation_only=True)
        self.assertEqual(pixels(self.source), pixels(self.output))
        self.assertTrue(report['requires_revalidation'])
        self.assertFalse(report['certification'])
        self.assertIn(b'<pdfuaid:part>1</pdfuaid:part>', PdfReader(self.output).trailer['/Root']['/Metadata'].get_data())
        with self.assertRaisesRegex(ValueError, 'existing_pdfua'):
            stage_pdfua1_declaration(self.output, self.output.with_name('second.pdf'), expected_sha256=report['output_sha256'], evaluation_only=True)

    def test_signed_pdf_rejected_by_both_writers(self):
        fixture(self.source, signed=True)
        with self.assertRaisesRegex(ValueError, 'signed_pdf'):
            repair_conformance_details(self.source, self.output)
        with self.assertRaisesRegex(ValueError, 'signed_pdf'):
            stage_pdfua1_declaration(self.source, self.output, expected_sha256=hashlib.sha256(self.source.read_bytes()).hexdigest(), evaluation_only=True)
        self.assertFalse(self.output.exists())

    def test_existing_output_and_source_overwrite_rejected(self):
        fixture(self.source)
        with self.assertRaises(ValueError):
            repair_conformance_details(self.source, self.source)
        self.output.write_bytes(b'keep')
        with self.assertRaises(ValueError):
            repair_conformance_details(self.source, self.output)
        self.assertEqual(b'keep', self.output.read_bytes())


if __name__ == '__main__':
    unittest.main()
