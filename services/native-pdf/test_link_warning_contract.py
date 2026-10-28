import unittest
import worker

class BrokenLinkWarningContract(unittest.TestCase):
    def test_original_broken_link_has_its_page_and_visible_label(self):
        inventory={'tags':[{'id':'tag-42','role':'Link','text':'Figure\n 2','contentSequence':[{'annotationId':'p5-a3'}]}]}
        result=worker.normalized_finding({'code':'local_link_destination_unresolved','page':5,'annotationId':'p5-a3','reason':'ambiguous_named_destination'},inventory)
        self.assertEqual(result['severity'],'warning')
        self.assertEqual(result['pageNumber'],5)
        self.assertEqual(result['tagId'],'tag-42')
        self.assertEqual(result['location'],'Page 5 · Link “Figure 2”')
        self.assertIn('original PDF',result['message'])
        self.assertIn('more than one possible destination',result['message'])
        self.assertIn('reconnect',result['suggestion'])

    def test_unowned_link_still_identifies_its_page_and_annotation(self):
        result=worker.normalized_finding({'code':'local_link_destination_unresolved','page':8,'annotationId':'p8-a7','reason':'named_destination_missing'},{'tags':[]})
        self.assertEqual(result['location'],'Page 8 · Link 7')
        self.assertNotIn('tagId',result)

    def test_heading_around_an_inspected_broken_link_can_be_repaired(self):
        import io,tempfile
        from pathlib import Path
        from pypdf import PdfWriter
        from pypdf.generic import DictionaryObject,NameObject,TextStringObject
        from test_worker import inline_heading_bytes
        writer=PdfWriter(clone_from=worker.open_pdf(inline_heading_bytes()))
        annotation=writer.pages[0]['/Annots'][0].get_object()
        annotation[NameObject('/A')]=DictionaryObject({NameObject('/S'):NameObject('/GoTo'),NameObject('/D'):TextStringObject('missing-reference')})
        buffer=io.BytesIO();writer.write(buffer);data=buffer.getvalue();original=worker.open_pdf(data)
        inventory=worker.enrich_inventory(original,original);paragraph=inventory['tags'][1]
        self.assertTrue(inventory['checks_complete'])
        self.assertTrue(paragraph['editable']['role'])
        plan={'schemaVersion':1,'candidateSha256':worker.digest(data),'operations':[{'type':'set_role','tagId':paragraph['id'],'expected':paragraph['snapshot'],'role':'H2'}]}
        with tempfile.TemporaryDirectory() as temporary:
            source=Path(temporary)/'source.pdf';source.write_bytes(data);output=Path(temporary)/'output.pdf'
            worker.apply_plan(original,original,plan,output)
            checks=worker.verify_pdf.compare_pdfs(source,output)
            self.assertTrue(checks['preservation']['passed'])
            self.assertTrue(checks['navigation']['passed'])
            self.assertEqual(len(checks['navigation']['outputFindings']),1)

    def test_verified_link_label_survives_unrelated_tag_ordinal_changes(self):
        import io
        from pypdf import PdfWriter
        from pypdf.generic import ArrayObject,DictionaryObject,NameObject
        from test_worker import link_bytes
        original=worker.open_pdf(link_bytes())
        writer=PdfWriter(clone_from=original)
        self.assertEqual(len(worker.add_link_descriptions(original,original,writer)),1)
        document,link=worker.native_nodes(writer)[:2]
        wrapper=DictionaryObject({NameObject('/Type'):NameObject('/StructElem'),NameObject('/S'):NameObject('/Div'),NameObject('/P'):document.indirect_reference,NameObject('/K'):link.indirect_reference})
        reference=writer._add_object(wrapper)
        document[NameObject('/K')]=ArrayObject([reference]);link[NameObject('/P')]=reference
        data=io.BytesIO();writer.write(data);after=worker.open_pdf(data.getvalue())
        self.assertNotEqual(worker.native_link_descriptions(original)[(1,1)]['tagId'],worker.native_link_descriptions(after,include_existing=True)[(1,1)]['tagId'])
        worker.verify_added_link_descriptions(original,after)
        worker.verify_saved_annotations(original,original,after)
