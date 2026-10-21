import hashlib
from pathlib import Path
import tempfile
import unittest
from pypdf import PdfReader,PdfWriter
from pypdf.generic import ArrayObject,BooleanObject,DecodedStreamObject,DictionaryObject,NameObject,NumberObject,TextStringObject
from cross_page_repairs import repair_cross_page_paragraph,_paragraph
from semantic_repairs import _tag_nodes
from verify_pdf import compare_pdfs,structure_inventory


def fixture(original,candidate,*,changed=False,wrong_owner=False,layout_class=False,extra_scope=False,distinct_scope=False):
    writer=PdfWriter()
    font=writer._add_object(DictionaryObject({NameObject('/Type'):NameObject('/Font'),NameObject('/Subtype'):NameObject('/Type1'),NameObject('/BaseFont'):NameObject('/Helvetica')}))
    for index,text in enumerate(['Paragraph begins.','Paragraph continues with real data: 425,417.']):
        page=writer.add_blank_page(300,200);page[NameObject('/Resources')]=DictionaryObject({NameObject('/Font'):DictionaryObject({NameObject('/F1'):font})})
        stream=DecodedStreamObject();stream.set_data(('/P <</MCID 0>> BDC BT /F1 12 Tf 20 100 Td ('+text+') Tj ET EMC').encode())
        page[NameObject('/Contents')]=writer._add_object(stream);page[NameObject('/StructParents')]=NumberObject(index)
    root=DictionaryObject({NameObject('/Type'):NameObject('/StructTreeRoot')});root_ref=writer._add_object(root)
    tag=DictionaryObject({NameObject('/Type'):NameObject('/StructElem'),NameObject('/S'):NameObject('/P'),NameObject('/P'):root_ref,NameObject('/Pg'):writer.pages[0].indirect_reference})
    tag_ref=writer._add_object(tag);root[NameObject('/K')]=tag_ref
    if layout_class:
        tag[NameObject('/S')]=NameObject('/Paragraph');tag[NameObject('/C')]=NameObject('/Pa7')
        root[NameObject('/RoleMap')]=DictionaryObject({NameObject('/Paragraph'):NameObject('/P')})
        root[NameObject('/ClassMap')]=DictionaryObject({NameObject('/Pa7'):DictionaryObject({NameObject('/O'):NameObject('/Layout'),NameObject('/LineHeight'):NumberObject(11),NameObject('/TextAlign'):NameObject('/Justify'),NameObject('/TextIndent'):NumberObject(9)})})
    tag[NameObject('/K')]=ArrayObject([NumberObject(0),DictionaryObject({NameObject('/Type'):NameObject('/MCR'),NameObject('/Pg'):writer.pages[1].indirect_reference,NameObject('/MCID'):NumberObject(0)})])
    root[NameObject('/ParentTree')]=DictionaryObject({NameObject('/Nums'):ArrayObject([NumberObject(0),ArrayObject([tag_ref]),NumberObject(1),ArrayObject([tag_ref])])})
    writer.root_object[NameObject('/StructTreeRoot')]=root_ref;writer.root_object[NameObject('/Lang')]=TextStringObject('en-US');writer.root_object[NameObject('/MarkInfo')]=DictionaryObject({NameObject('/Marked'):BooleanObject(True)})
    with original.open('xb') as stream:writer.write(stream)
    writer=PdfWriter(clone_from=original);tag=_tag_nodes(writer)[0];tag[NameObject('/K')]=ArrayObject([NumberObject(0),NumberObject(1)])
    if layout_class:tag[NameObject('/S')]=NameObject('/P');tag.pop('/C')
    nums=writer.root_object['/StructTreeRoot']['/ParentTree']['/Nums'];nums[1].append(tag.indirect_reference);nums[3]=ArrayObject()
    content=writer.pages[1].get_contents().get_data().replace(b'/P <<\n/MCID 0\n>> BDC',b'/Artifact BMC').replace(b'/P <</MCID 0>> BDC',b'/Artifact BMC')
    if changed:content=content.replace(b'425,417',b'999,999')
    if extra_scope:
        content+=b'\n/Artifact <</Type /Pagination>> BDC 0 0 m 5 5 l S EMC'
        source=PdfWriter(clone_from=original);stream=DecodedStreamObject();stream.set_data(source.pages[1].get_contents().get_data()+b'\n/Artifact BMC 0 0 m 5 5 l S EMC')
        source.pages[1][NameObject('/Contents')]=source._add_object(stream)
        with original.open('wb') as handle:source.write(handle)
    if wrong_owner:
        other=DictionaryObject({NameObject('/Type'):NameObject('/StructElem'),NameObject('/S'):NameObject('/P'),NameObject('/P'):writer.root_object['/StructTreeRoot'].indirect_reference,NameObject('/Pg'):writer.pages[1].indirect_reference,NameObject('/K'):NumberObject(0)})
        other_ref=writer._add_object(other);writer.root_object['/StructTreeRoot'][NameObject('/K')]=ArrayObject([tag.indirect_reference,other_ref]);nums[3]=ArrayObject([other_ref]);content=content.replace(b'/Artifact BMC',b'/P <</MCID 0>> BDC')
    if distinct_scope:
        other=DictionaryObject({NameObject('/Type'):NameObject('/StructElem'),NameObject('/S'):NameObject('/P'),NameObject('/P'):writer.root_object['/StructTreeRoot'].indirect_reference,NameObject('/Pg'):writer.pages[1].indirect_reference,NameObject('/K'):NumberObject(0)})
        other_ref=writer._add_object(other);writer.root_object['/StructTreeRoot'][NameObject('/K')]=ArrayObject([tag.indirect_reference,other_ref]);nums[3]=ArrayObject([other_ref]);content+=b'\n/Span <</MCID 0>> BDC BT /F1 12 Tf 20 70 Td (Unrelated.) Tj ET EMC'
        source=PdfWriter(clone_from=original);stream=DecodedStreamObject();stream.set_data(source.pages[1].get_contents().get_data()+b'\n/Artifact BMC BT /F1 12 Tf 20 70 Td (Unrelated.) Tj ET EMC');source.pages[1][NameObject('/Contents')]=source._add_object(stream)
        with original.open('wb') as handle:source.write(handle)
    stream=DecodedStreamObject();stream.set_data(content);writer.pages[1][NameObject('/Contents')]=writer._add_object(stream)
    with candidate.open('xb') as stream:writer.write(stream)


def add_complete_anchor_with_figure_metadata(original,candidate,*,scope_language=None):
    """The candidate anchor is complete; its continuation alone was omitted."""
    for path in (original,candidate):
        writer=PdfWriter(clone_from=path);root=writer.root_object['/StructTreeRoot'];tag=_tag_nodes(writer)[0]
        if path==candidate:
            tag[NameObject('/K')]=ArrayObject([NumberObject(0)])
            root['/ParentTree']['/Nums'][1]=ArrayObject([tag.indirect_reference])
        if scope_language:
            writer.root_object[NameObject('/Lang')]=TextStringObject('en')
            if path==original:
                for page in writer.pages:
                    stream=DecodedStreamObject();stream.set_data(page.get_contents().get_data().replace(b'/MCID 0>>',f'/MCID 0 /Lang ({scope_language})>>'.encode()))
                    page[NameObject('/Contents')]=writer._add_object(stream)
        metadata=DecodedStreamObject();metadata.set_data(b'<metadata>authored Figure provenance</metadata>')
        writer.pages[0]['/Resources'][NameObject('/Properties')]=DictionaryObject({NameObject('/FigureMetadata'):DictionaryObject({NameObject('/Metadata'):writer._add_object(metadata)})})
        figure=DictionaryObject({NameObject('/Type'):NameObject('/StructElem'),NameObject('/S'):NameObject('/Figure'),NameObject('/P'):root.indirect_reference,NameObject('/Pg'):writer.pages[0].indirect_reference,NameObject('/K'):NumberObject(1),NameObject('/Alt'):TextStringObject('A short ascending line.')})
        figure_ref=writer._add_object(figure);root[NameObject('/K')]=ArrayObject([tag.indirect_reference,figure_ref]);root['/ParentTree']['/Nums'][1].append(figure_ref)
        stream=DecodedStreamObject();stream.set_data(writer.pages[0].get_contents().get_data()+b'\n/Figure <</MCID 1>> BDC /PlacedPDF /FigureMetadata BDC 10 10 m 20 20 l S EMC EMC')
        writer.pages[0][NameObject('/Contents')]=writer._add_object(stream)
        with path.open('wb') as handle:writer.write(handle)


class CrossPageRepairsTests(unittest.TestCase):
    def setUp(self):
        temp=tempfile.TemporaryDirectory();self.addCleanup(temp.cleanup);root=Path(temp.name)
        self.original=root/'original.pdf';self.candidate=root/'candidate.pdf';self.output=root/'output.pdf'
    def repair(self,**overrides):
        options={'source_tag_id':'tag-1','candidate_tag_id':'tag-1','expected_original_sha256':hashlib.sha256(self.original.read_bytes()).hexdigest(),'expected_candidate_sha256':hashlib.sha256(self.candidate.read_bytes()).hexdigest()};options.update(overrides)
        return repair_cross_page_paragraph(self.original,self.candidate,self.output,**options)
    def test_restores_real_continuation_with_exact_paint_and_page_refs(self):
        fixture(self.original,self.candidate);source=self.original.read_bytes();before=structure_inventory(PdfReader(self.candidate))
        self.assertTrue(any(f['code']=='missing_marked_content' for f in before['findings']))
        report=self.repair();after=structure_inventory(PdfReader(self.output))
        self.assertTrue(after['checks_complete']);self.assertIn('425,417',after['tags'][0]['text'])
        self.assertEqual({1,2},{x['pageNumber'] for x in after['tags'][0]['content']})
        self.assertTrue(compare_pdfs(self.original,self.output)['preservation']['passed']);self.assertEqual(source,self.original.read_bytes())
        self.assertTrue(report['requires_revalidation'])
    def test_changed_paint_rejected(self):
        fixture(self.original,self.candidate,changed=True)
        with self.assertRaisesRegex(ValueError,'page_painting_changed'):self.repair()
        self.assertFalse(self.output.exists())
    def test_existing_other_semantic_owner_rejected(self):
        fixture(self.original,self.candidate,wrong_owner=True)
        with self.assertRaisesRegex(ValueError,'owned_by_other'):self.repair()
        self.assertFalse(self.output.exists())
    def test_stale_hash_and_overwrite_rejected(self):
        fixture(self.original,self.candidate)
        with self.assertRaisesRegex(ValueError,'hash_mismatch'):self.repair(expected_candidate_sha256='0'*64)
        self.output.write_bytes(b'keep')
        with self.assertRaises(ValueError):self.repair()
        self.assertEqual(b'keep',self.output.read_bytes())
    def test_preserves_resolved_native_paragraph_layout_class(self):
        fixture(self.original,self.candidate,layout_class=True)
        result=self.repair();tag,_=_paragraph(PdfReader(self.output),'tag-1')
        self.assertEqual(1,result['sourceLayoutAttributeSetsPreserved'])
        self.assertEqual('/Justify',tag['/A'][0]['/TextAlign']);self.assertEqual(9,tag['/A'][0]['/TextIndent'])
    def test_rejects_unrelated_scoped_metadata_instead_of_dropping_it(self):
        fixture(self.original,self.candidate,extra_scope=True)
        with self.assertRaisesRegex(ValueError,'candidate_marked_properties_unsupported'):self.repair()
        self.assertFalse(self.output.exists())
    def test_preserves_unrelated_original_marked_content_tag(self):
        fixture(self.original,self.candidate,distinct_scope=True);self.repair()
        operators=PdfReader(self.output).pages[1].get_contents().operations
        self.assertTrue(any(op==b'BDC' and args[0]=='/Span' and args[1].get('/MCID')==0 for args,op in operators))
    def test_preserves_authored_scope_language_and_inherited_paragraph_language(self):
        fixture(self.original,self.candidate)
        source=PdfWriter(clone_from=self.original);source.root_object[NameObject('/Lang')]=TextStringObject('en-GB')
        for page in source.pages:
            stream=DecodedStreamObject();stream.set_data(page.get_contents().get_data().replace(b'/MCID 0>>',b'/MCID 0 /Lang (en-GB)>>'))
            page[NameObject('/Contents')]=source._add_object(stream)
        with self.original.open('wb') as handle:source.write(handle)
        report=self.repair();reader=PdfReader(self.output)
        self.assertEqual('en-GB',_tag_nodes(reader)[0]['/Lang'])
        self.assertEqual('en-GB',report['sourceEffectiveLanguagePreserved'])
        for page in reader.pages:
            self.assertTrue(any(op==b'BDC' and args[1].get('/Lang')=='en-GB' for args,op in page.get_contents().operations))
    def test_rejects_authored_reading_order_that_differs_from_paint_order(self):
        fixture(self.original,self.candidate)
        source=PdfWriter(clone_from=self.original);tag=_tag_nodes(source)[0]
        stream=DecodedStreamObject();stream.set_data(source.pages[0].get_contents().get_data()+b'\n/P <</MCID 1>> BDC BT /F1 12 Tf 20 70 Td (Second physical line.) Tj ET EMC')
        source.pages[0][NameObject('/Contents')]=source._add_object(stream)
        tag['/K'].insert(0,NumberObject(1));source.root_object['/StructTreeRoot']['/ParentTree']['/Nums'][1].append(tag.indirect_reference)
        with self.original.open('wb') as handle:source.write(handle)
        with self.assertRaisesRegex(ValueError,'source_logical_order'):self.repair()
        self.assertFalse(self.output.exists())
    def test_rejects_source_nested_placed_metadata(self):
        fixture(self.original,self.candidate)
        source=PdfWriter(clone_from=self.original);metadata=DecodedStreamObject();metadata.set_data(b'<metadata>retain me</metadata>')
        properties=DictionaryObject({NameObject('/Metadata'):source._add_object(metadata)})
        source.pages[0]['/Resources'][NameObject('/Properties')]=DictionaryObject({NameObject('/PlacedMetadata'):properties})
        stream=DecodedStreamObject();stream.set_data(source.pages[0].get_contents().get_data().replace(b'BDC BT',b'BDC /PlacedPDF /PlacedMetadata BDC BT').replace(b'ET EMC',b'ET EMC EMC'))
        source.pages[0][NameObject('/Contents')]=source._add_object(stream)
        with self.original.open('wb') as handle:source.write(handle)
        # Match resources so the test reaches source-scope validation.
        candidate=PdfWriter(clone_from=self.candidate);candidate.pages[0]['/Resources'][NameObject('/Properties')]=source.pages[0]['/Resources']['/Properties'].clone(candidate)
        with self.candidate.open('wb') as handle:candidate.write(handle)
        with self.assertRaisesRegex(ValueError,'source_paragraph_scoped_properties_unsupported'):self.repair()
        self.assertFalse(self.output.exists())
    def test_keeps_complete_anchor_stream_and_figure_metadata_unchanged(self):
        fixture(self.original,self.candidate);add_complete_anchor_with_figure_metadata(self.original,self.candidate)
        before=PdfReader(self.candidate);source_bytes=self.original.read_bytes();candidate_bytes=self.candidate.read_bytes()
        result=self.repair();after=PdfReader(self.output)
        self.assertEqual([1],result['unchangedAnchorPageNumbers']);self.assertEqual([2],result['rewrittenPageNumbers'])
        self.assertEqual(before.pages[0].get_contents().get_data(),after.pages[0].get_contents().get_data())
        self.assertEqual(b'<metadata>authored Figure provenance</metadata>',after.pages[0]['/Resources']['/Properties']['/FigureMetadata']['/Metadata'].get_data())
        self.assertTrue(compare_pdfs(self.original,self.output)['preservation']['passed'])
        self.assertIn('425,417',structure_inventory(after)['tags'][0]['text'])
        self.assertEqual(source_bytes,self.original.read_bytes());self.assertEqual(candidate_bytes,self.candidate.read_bytes())
    def test_uniform_source_line_language_preserved_on_untouched_anchor(self):
        fixture(self.original,self.candidate);add_complete_anchor_with_figure_metadata(self.original,self.candidate,scope_language='en-GB')
        before=PdfReader(self.candidate).pages[0].get_contents().get_data();result=self.repair();after=PdfReader(self.output)
        self.assertEqual([1],result['unchangedAnchorPageNumbers']);self.assertEqual('en-GB',_tag_nodes(after)[0]['/Lang'])
        self.assertEqual(before,after.pages[0].get_contents().get_data())
        self.assertEqual('en-GB',result['outputParagraphLanguage'])
    def test_incomplete_anchor_cannot_skip_unsupported_metadata(self):
        fixture(self.original,self.candidate);add_complete_anchor_with_figure_metadata(self.original,self.candidate)
        writer=PdfWriter(clone_from=self.candidate);tag=_tag_nodes(writer)[0]
        tag['/K'].append(NumberObject(2));writer.root_object['/StructTreeRoot']['/ParentTree']['/Nums'][1].append(tag.indirect_reference)
        with self.candidate.open('wb') as handle:writer.write(handle)
        with self.assertRaisesRegex(ValueError,'candidate_marked_properties_unsupported'):self.repair()
        self.assertFalse(self.output.exists())
    def test_language_conflict_cannot_authorize_untouched_anchor(self):
        fixture(self.original,self.candidate);add_complete_anchor_with_figure_metadata(self.original,self.candidate,scope_language='en-GB')
        writer=PdfWriter(clone_from=self.candidate);stream=DecodedStreamObject();stream.set_data(writer.pages[0].get_contents().get_data().replace(b'/MCID 0>>',b'/MCID 0 /Lang (fr)>>'))
        writer.pages[0][NameObject('/Contents')]=writer._add_object(stream)
        with self.candidate.open('wb') as handle:writer.write(handle)
        with self.assertRaisesRegex(ValueError,'candidate_marked_properties_unsupported'):self.repair()
        self.assertFalse(self.output.exists())
    def test_anchor_can_keep_unchanged_text_state_outside_mcid_scope(self):
        fixture(self.original,self.candidate);add_complete_anchor_with_figure_metadata(self.original,self.candidate)
        writer=PdfWriter(clone_from=self.candidate);stream=DecodedStreamObject()
        stream.set_data(writer.pages[0].get_contents().get_data().replace(b'/P <</MCID 0>> BDC BT',b'BT /P <</MCID 0>> BDC').replace(b'Tj ET EMC',b'Tj EMC ET'))
        writer.pages[0][NameObject('/Contents')]=writer._add_object(stream)
        with self.candidate.open('wb') as handle:writer.write(handle)
        before=PdfReader(self.candidate).pages[0].get_contents().get_data();result=self.repair()
        self.assertEqual([1],result['unchangedAnchorPageNumbers'])
        self.assertEqual(before,PdfReader(self.output).pages[0].get_contents().get_data())


if __name__=='__main__':unittest.main()
