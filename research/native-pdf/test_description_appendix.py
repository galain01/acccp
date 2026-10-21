import copy
import hashlib
import json
from pathlib import Path
import tempfile
import unittest

from pypdf import PdfReader,PdfWriter
from pypdf.generic import ArrayObject,DecodedStreamObject,DictionaryObject,NameObject,NumberObject,TextStringObject
from description_appendix import append_description_pages
from description_appendix_validation import compare_with_authorized_appendix
from test_native_pdf_validation import pdf_bytes
import verify_pdf as v

FONT_DIRECTORY=Path(__file__).resolve().parents[4]/'work/pdf-native-tools/fonts/liberation-fonts-ttf-2.1.5'


class DescriptionAppendixTests(unittest.TestCase):
    def setUp(self):
        if not FONT_DIRECTORY.exists():self.skipTest('Pinned local Liberation2.1.5 fonts are required for appendix integration tests.')
        temp=tempfile.TemporaryDirectory();self.addCleanup(temp.cleanup);root=Path(temp.name)
        self.source=root/'source.pdf';self.output=root/'output.pdf';self.source.write_bytes(pdf_bytes(tagged=True,alt='Original authored description.'))
        digest=hashlib.sha256(self.source.read_bytes()).hexdigest()
        self.manifest={'schemaVersion':1,'inputSha256':digest,'approved':True,'language':'en-US','headingLevel':2,'title':'Image description appendix',
            'evidence':[{'id':'source','sha256':digest}],
            'sections':[{'figureTagId':'tag-2','sourcePageNumber':1,'heading':'Figure on original page 1','paragraphs':['The source contains a short text example.','The comparison is 42.1%–46.9%; this is verified fixture data.'],'evidenceIds':['source']}]}
    def write(self):
        return append_description_pages(self.source,self.output,self.manifest,evidence_files={'source':self.source},font_directory=FONT_DIRECTORY)
    def test_embedded_native_appendix_preserves_original_and_exact_approved_text(self):
        original=self.source.read_bytes();ledger=self.write();report=compare_with_authorized_appendix(self.source,self.output,ledger)
        self.assertTrue(report['preservation']['passed'],report.get('findings'))
        self.assertTrue(report['appendix_validation']['passed'],report.get('findings'))
        self.assertEqual(2,len(PdfReader(self.output).pages));self.assertEqual(original,self.source.read_bytes())
        self.assertTrue(report['figure_associations']['passed']);self.assertFalse(report['certification'])
    def test_same_figure_sections_are_grouped_once(self):
        self.manifest['sections'].append({**self.manifest['sections'][0],'heading':'Additional context','paragraphs':['A second section belongs to the same image.']})
        ledger=self.write();report=compare_with_authorized_appendix(self.source,self.output,ledger)
        self.assertTrue(report['appendix_validation']['passed'],report['findings'])
        self.assertEqual(1,len(ledger['groups']))
        self.assertEqual(1,sum(tag['role']=='Sect' for tag in report['structure']['tags']))
    def test_explicit_section_depth_keeps_visible_rendering_and_nested_hierarchy(self):
        self.manifest['sections'].append({**self.manifest['sections'][0],'heading':'Population subgroup','paragraphs':['A subgroup belongs to the same image.']})
        first=self.write();original_pixels=v.rendered_page_hashes(self.output)
        self.output=self.output.with_name('nested.pdf');self.manifest['headingLevel']=3
        self.manifest['sections'][0]['headingLevel']=4;self.manifest['sections'][1]['headingLevel']=5
        ledger=self.write();report=compare_with_authorized_appendix(self.source,self.output,ledger)
        self.assertTrue(report['appendix_validation']['passed'],report['findings'])
        self.assertEqual(original_pixels,v.rendered_page_hashes(self.output))
        self.assertEqual(['H3','H4','H5'],[t['role'] for t in report['structure']['tags'] if t['role'].startswith('H')])
        writer=PdfWriter(clone_from=self.output);subgroup=next(n for n in __import__('semantic_repairs')._tag_nodes(writer) if n.get('/S')=='/H5')
        subgroup[NameObject('/S')]=NameObject('/H4')
        with self.output.open('wb') as handle:writer.write(handle)
        ledger['outputSha256']=hashlib.sha256(self.output.read_bytes()).hexdigest()
        self.assertFalse(compare_with_authorized_appendix(self.source,self.output,ledger)['appendix_validation']['passed'])
    def test_section_heading_skips_ancestors_and_out_of_range_are_rejected(self):
        for level in (2,4,7,True):
            self.manifest['sections'][0]['headingLevel']=level
            with self.assertRaisesRegex(ValueError,'invalid_appendix_heading_hierarchy'):self.write()
            self.assertFalse(self.output.exists())
        self.manifest['sections'][0]['headingLevel']=3
        self.manifest['sections'].append({**self.manifest['sections'][0],'headingLevel':5})
        with self.assertRaisesRegex(ValueError,'invalid_appendix_heading_hierarchy'):self.write()
    def test_uri_annotation_parent_tree_retains_same_indirect_owner(self):
        self.source.write_bytes(pdf_bytes(tagged=True,alt='Original authored description.',link='https://example.org/source'))
        writer=PdfWriter(clone_from=self.source);root=writer.root_object['/StructTreeRoot'];document=root['/K'][0].get_object();page=writer.pages[0]
        annotation_ref=page['/Annots'][0];annotation_ref.get_object()[NameObject('/StructParent')]=NumberObject(1)
        link=DictionaryObject({NameObject('/Type'):NameObject('/StructElem'),NameObject('/S'):NameObject('/Link'),NameObject('/P'):document.indirect_reference,NameObject('/Pg'):page.indirect_reference})
        link_ref=writer._add_object(link);link[NameObject('/K')]=ArrayObject([NumberObject(1),DictionaryObject({NameObject('/Type'):NameObject('/OBJR'),NameObject('/Pg'):page.indirect_reference,NameObject('/Obj'):annotation_ref})])
        document['/K'].append(link_ref);root['/ParentTree']['/Nums'][1].append(link_ref);root['/ParentTree']['/Nums'].extend([NumberObject(1),link_ref])
        stream=DecodedStreamObject();stream.set_data(page.get_contents().get_data()+b' /Link << /MCID 1 >> BDC BT /F1 12 Tf 20 20 Td (Source) Tj ET EMC');page[NameObject('/Contents')]=writer._add_object(stream)
        with self.source.open('wb') as handle:writer.write(handle)
        digest=hashlib.sha256(self.source.read_bytes()).hexdigest();self.manifest['inputSha256']=digest;self.manifest['evidence'][0]['sha256']=digest
        ledger=self.write();report=compare_with_authorized_appendix(self.source,self.output,ledger)
        self.assertTrue(report['preservation']['passed'],report['findings']);self.assertTrue(report['appendix_validation']['passed'],report['findings'])
        self.assertEqual(0,report['structure']['unresolved_content_references'])
        reader=PdfReader(self.output);parent_owner=reader.trailer['/Root']['/StructTreeRoot']['/ParentTree']['/Nums'][3].get_object()
        native_link=next(node for node in __import__('semantic_repairs')._tag_nodes(reader) if node.get('/S')=='/Link')
        self.assertIs(parent_owner,native_link)
    def test_signed_source_is_rejected(self):
        writer=PdfWriter(clone_from=self.source)
        field=writer._add_object(DictionaryObject({NameObject('/FT'):NameObject('/Sig'),NameObject('/T'):TextStringObject('Signature')}))
        writer.root_object[NameObject('/AcroForm')]=DictionaryObject({NameObject('/Fields'):ArrayObject([field])})
        with self.source.open('wb') as handle:writer.write(handle)
        with self.assertRaises(ValueError):self.write()
    def test_original_id_tree_targets_remain_bound_to_original_native_tags(self):
        writer=PdfWriter(clone_from=self.source);root=writer.root_object['/StructTreeRoot'];figure=root['/K'][0]['/K'][0]
        figure.get_object()[NameObject('/ID')]=TextStringObject('original-figure')
        root[NameObject('/IDTree')]=writer._add_object(DictionaryObject({NameObject('/Names'):ArrayObject([TextStringObject('original-figure'),figure])}))
        with self.source.open('wb') as handle:writer.write(handle)
        digest=hashlib.sha256(self.source.read_bytes()).hexdigest();self.manifest['inputSha256']=digest;self.manifest['evidence'][0]['sha256']=digest
        ledger=self.write();report=compare_with_authorized_appendix(self.source,self.output,ledger)
        self.assertTrue(report['appendix_validation']['passed'],report['findings'])
        writer=PdfWriter(clone_from=self.output);root=writer.root_object['/StructTreeRoot'];section=next(n for n in __import__('semantic_repairs')._tag_nodes(writer) if n.get('/S')=='/Sect')
        root['/IDTree']['/Names'][1]=section.indirect_reference
        with self.output.open('wb') as handle:writer.write(handle)
        ledger['outputSha256']=hashlib.sha256(self.output.read_bytes()).hexdigest()
        self.assertFalse(compare_with_authorized_appendix(self.source,self.output,ledger)['appendix_validation']['passed'])
    def test_appendix_crop_and_section_text_override_rejected(self):
        ledger=self.write();original_output=self.output.read_bytes()
        for change in ('crop','override','language'):
            self.output.write_bytes(original_output);writer=PdfWriter(clone_from=self.output)
            if change=='crop':writer.pages[-1][NameObject('/CropBox')]=ArrayObject([NumberObject(0),NumberObject(0),NumberObject(100),NumberObject(100)])
            elif change=='language':writer.root_object[NameObject('/Lang')]=TextStringObject('fr-FR')
            else:
                section=next(node for node in __import__('semantic_repairs')._tag_nodes(writer) if node.get('/S')=='/Sect')
                section[NameObject('/ActualText')]=TextStringObject('Different screen-reader text.')
            with self.output.open('wb') as handle:writer.write(handle)
            altered={**ledger,'outputSha256':hashlib.sha256(self.output.read_bytes()).hexdigest()}
            self.assertFalse(compare_with_authorized_appendix(self.source,self.output,altered)['appendix_validation']['passed'])
    def test_unused_continuation_page_font_must_still_be_pinned_and_embedded(self):
        self.manifest['sections'][0]['paragraphs']=['Long approved description. '*130]*2
        ledger=self.write();self.assertEqual(3,len(PdfReader(self.output).pages))
        baseline=compare_with_authorized_appendix(self.source,self.output,ledger)
        self.assertTrue(baseline['appendix_validation']['passed'],baseline['findings'])
        writer=PdfWriter(clone_from=self.output);page=writer.pages[-1]
        self.assertNotIn(b'/FB',page.get_contents().get_data())
        page['/Resources']['/Font'][NameObject('/FB')]=writer._add_object(DictionaryObject({NameObject('/Type'):NameObject('/Font'),NameObject('/Subtype'):NameObject('/Type1'),NameObject('/BaseFont'):NameObject('/Helvetica')}))
        with self.output.open('wb') as handle:writer.write(handle)
        ledger['outputSha256']=hashlib.sha256(self.output.read_bytes()).hexdigest()
        report=compare_with_authorized_appendix(self.source,self.output,ledger)
        self.assertFalse(report['appendix_validation']['passed']);self.assertIn('appendix_font_type_unsupported',[item['code'] for item in report['findings']])
    def test_false_approval_wrong_input_and_evidence_are_rejected(self):
        for field,value in [('approved',False),('inputSha256','0'*64)]:
            saved=copy.deepcopy(self.manifest);self.manifest[field]=value
            with self.assertRaises(ValueError):self.write()
            self.assertFalse(self.output.exists());self.manifest=saved
        self.manifest['evidence'][0]['sha256']='0'*64
        with self.assertRaisesRegex(ValueError,'evidence_hash_mismatch'):self.write()
    def test_original_page_change_cannot_be_approved_by_appendix_ledger(self):
        ledger=self.write();writer=PdfWriter(clone_from=self.output)
        stream=DecodedStreamObject();stream.set_data(writer.pages[0].get_contents().get_data().replace(b'Hello',b'World'));writer.pages[0][NameObject('/Contents')]=writer._add_object(stream)
        with self.output.open('wb') as handle:writer.write(handle)
        ledger['outputSha256']=hashlib.sha256(self.output.read_bytes()).hexdigest()
        report=compare_with_authorized_appendix(self.source,self.output,ledger)
        self.assertFalse(report['passed']);self.assertFalse(report['appendix_validation']['passed'])
    def test_changed_authored_alt_is_rejected(self):
        ledger=self.write();writer=PdfWriter(clone_from=self.output)
        figure=writer.root_object['/StructTreeRoot']['/K'][0]['/K'][0].get_object();figure[NameObject('/Alt')]=TextStringObject('Changed description.')
        with self.output.open('wb') as handle:writer.write(handle)
        ledger['outputSha256']=hashlib.sha256(self.output.read_bytes()).hexdigest();report=compare_with_authorized_appendix(self.source,self.output,ledger)
        self.assertFalse(report['passed']);self.assertIn('appendix_original_figure_association_changed',[f['code'] for f in report['findings']])
    def test_extra_unapproved_text_and_stale_output_hash_rejected(self):
        ledger=self.write();stale=copy.deepcopy(ledger);stale['outputSha256']='0'*64
        self.assertFalse(compare_with_authorized_appendix(self.source,self.output,stale)['passed'])
        writer=PdfWriter(clone_from=self.output);page=writer.pages[-1];stream=DecodedStreamObject()
        stream.set_data(page.get_contents().get_data()+b'\nBT /FR 11 Tf 1 0 0 1 42 42 Tm <0041> Tj ET');page[NameObject('/Contents')]=writer._add_object(stream)
        with self.output.open('wb') as handle:writer.write(handle)
        ledger['outputSha256']=hashlib.sha256(self.output.read_bytes()).hexdigest()
        self.assertFalse(compare_with_authorized_appendix(self.source,self.output,ledger)['appendix_validation']['passed'])
    def test_two_page_limit_and_original_overwrite_rejected(self):
        self.manifest['sections'][0]['paragraphs']=['Long approved description. '*100]*5
        with self.assertRaisesRegex(ValueError,'appendix_two_page_limit'):self.write()
        self.assertFalse(self.output.exists())
        self.output=self.source
        with self.assertRaises(ValueError):self.write()


if __name__=='__main__':unittest.main()
