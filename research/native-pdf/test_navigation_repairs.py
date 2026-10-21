"""A navigation ledger permits only the reviewed action, never general PDF changes."""
import copy
import io
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from pypdf import PdfReader, PdfWriter
from pypdf.generic import ArrayObject, DictionaryObject, NameObject, NumberObject, TextStringObject
import navigation_repairs as n
from test_link_grouping_repairs import fixture
import verify_pdf as v


class NavigationTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='native-nav-');self.root=Path(self.temp.name)
        self.source=self.root/'source.pdf';self.final=self.root/'final.pdf'
        writer=PdfWriter(clone_from=PdfReader(io.BytesIO(fixture())))
        writer.pages[0]['/Annots'][0].get_object()[NameObject('/A')]=DictionaryObject({NameObject('/S'):NameObject('/GoTo'),NameObject('/D'):TextStringObject('source:missing')})
        with self.source.open('wb') as stream:writer.write(stream)
        self.policy={1:{'oldDestination':'source:missing','uri':'https://www.cdc.gov/mmwr/volumes/73/wr/mm7309a2.htm','title':'Verified report','printedPages':'199–203','publicationDate':'2024-03-07','publisherEvidenceUrl':'https://www.cdc.gov/mmwr/volumes/73/wr/mm7309a2.htm','verifiedOn':'2026-10-21'}}
        self.hash_patch=patch.object(n,'POLICY_SOURCE_SHA256',v.digest(self.source.read_bytes()));self.hash_patch.start()
        self.rows_patch=patch.object(n,'POLICY_ROWS',self.policy);self.rows_patch.start()
        self.manifest=n.repair_verified_navigation(self.source,self.source,self.final)
    def tearDown(self):self.rows_patch.stop();self.hash_patch.stop();self.temp.cleanup()
    def mutate(self,fn):
        writer=PdfWriter(clone_from=PdfReader(self.final));fn(writer)
        changed=self.root/'changed.pdf'
        with changed.open('wb') as stream:writer.write(stream)
        manifest=copy.deepcopy(self.manifest);manifest['candidateSha256']=v.digest(changed.read_bytes())
        return changed,manifest
    def test_only_explicit_bound_action_can_pass_strict_preservation(self):
        self.assertFalse(v.compare_pdfs(self.source,self.final)['preservation']['passed'])
        report=n.compare_with_authorized_navigation(self.source,self.final,self.manifest)
        self.assertTrue(report['navigation_validation']['passed'],report['navigation_validation'])
        self.assertTrue(report['preservation']['passed']);self.assertTrue(report['passed'])
        self.assertEqual(report['structure']['unresolved_local_destinations'],0)
    def test_unknown_replacement_url_is_not_authorized_by_editing_manifest(self):
        changed,manifest=self.mutate(lambda w:w.pages[0]['/Annots'][0].get_object()['/A'].__setitem__(NameObject('/URI'),TextStringObject('https://example.org/evil')))
        manifest['changes'][0]['uri']='https://example.org/evil'
        with self.assertRaisesRegex(v.InspectionError,'target_or_evidence_not_authorized'):n.authorize_navigation(self.source,changed,manifest)
    def test_extra_action_key_is_rejected(self):
        changed,manifest=self.mutate(lambda w:w.pages[0]['/Annots'][0].get_object()['/A'].__setitem__(NameObject('/Next'),DictionaryObject({NameObject('/S'):NameObject('/JavaScript'),NameObject('/JS'):TextStringObject('bad')})))
        with self.assertRaisesRegex(v.InspectionError,'saved_action_not_authorized'):n.authorize_navigation(self.source,changed,manifest)
    def test_geometry_and_description_are_bound(self):
        changed,manifest=self.mutate(lambda w:w.pages[0]['/Annots'][0].get_object().__setitem__(NameObject('/Rect'),ArrayObject([NumberObject(x) for x in (1,2,3,4)])))
        with self.assertRaisesRegex(v.InspectionError,'other_annotation_fields_changed'):n.authorize_navigation(self.source,changed,manifest)
        manifest['changes'][0]['unchangedAnnotationSha256']=n._static_hash(PdfReader(changed),n._annotation(PdfReader(changed),1))
        self.assertFalse(n.compare_with_authorized_navigation(self.source,changed,manifest)['navigation_validation']['passed'])
    def test_unlisted_annotation_change_fails_independent_comparison(self):
        changed,manifest=self.mutate(lambda w:w.pages[0]['/Annots'][1].get_object()['/A'].__setitem__(NameObject('/URI'),TextStringObject('https://example.org/other')))
        report=n.compare_with_authorized_navigation(self.source,changed,manifest)
        self.assertFalse(report['navigation_validation']['passed']);self.assertFalse(report['preservation']['passed'])
    def test_final_bytes_and_source_hash_are_required(self):
        manifest=copy.deepcopy(self.manifest);manifest['candidateSha256']='0'*64
        with self.assertRaisesRegex(v.InspectionError,'file_binding_mismatch'):n.authorize_navigation(self.source,self.final,manifest)
    def test_missing_or_duplicate_changes_are_rejected(self):
        for rows in ([],self.manifest['changes']*2):
            manifest=copy.deepcopy(self.manifest);manifest['changes']=rows
            with self.assertRaisesRegex(v.InspectionError,'exact_change_set_required'):n.authorize_navigation(self.source,self.final,manifest)
    def test_appendix_requires_separate_validator(self):
        changed,manifest=self.mutate(lambda w:w.add_blank_page(width=300,height=160))
        _,normalized,_=n.authorize_navigation(self.source,changed,manifest)
        self.assertEqual(len(normalized.pages),2)
        self.assertFalse(n.compare_with_authorized_navigation(self.source,changed,manifest)['navigation_validation']['passed'])
    def test_authorization_cannot_be_disabled(self):
        manifest=copy.deepcopy(self.manifest);manifest['authorization']={}
        with self.assertRaisesRegex(v.InspectionError,'explicit_authorization_required'):n.authorize_navigation(self.source,self.final,manifest)
    def test_revalidate_semantic_stage_keeps_prior_ledger_and_provenance(self):
        from semantic_repairs import _tag_nodes
        changed,_=self.mutate(lambda w:_tag_nodes(w)[0].__setitem__(NameObject('/Lang'),TextStringObject('en-GB')))
        before=copy.deepcopy(self.manifest)
        result=n.revalidate_navigation_manifest(self.source,self.final,changed,self.manifest)
        self.assertEqual(self.manifest,before)
        self.assertEqual(result['manifest']['inputSha256'],before['inputSha256'])
        self.assertEqual(result['manifest']['changes'],before['changes'])
        self.assertEqual(result['manifest']['candidateSha256'],v.digest(changed.read_bytes()))
        self.assertEqual(result['lineage']['priorCandidateSha256'],before['candidateSha256'])
        self.assertTrue(result['lineage']['freshSemanticAuditRequired'])
        self.assertTrue(result['verification']['preservation']['passed'])
    def test_revalidate_requires_the_immutable_prior_candidate(self):
        manifest=copy.deepcopy(self.manifest);manifest['candidateSha256']='0'*64
        with self.assertRaisesRegex(v.InspectionError,'file_binding_mismatch'):
            n.revalidate_navigation_manifest(self.source,self.final,self.final,manifest)
    def test_revalidate_does_not_reauthorize_changed_annotation_fields(self):
        changed,_=self.mutate(lambda w:w.pages[0]['/Annots'][0].get_object().__setitem__(NameObject('/Rect'),ArrayObject([NumberObject(x) for x in (1,2,3,4)])))
        with self.assertRaisesRegex(v.InspectionError,'revalidation_preservation_failed'):
            n.revalidate_navigation_manifest(self.source,self.final,changed,self.manifest)
    def test_revalidate_does_not_authorize_unlisted_action_or_page_change(self):
        changed,_=self.mutate(lambda w:w.pages[0]['/Annots'][1].get_object()['/A'].__setitem__(NameObject('/URI'),TextStringObject('https://example.org/changed')))
        with self.assertRaisesRegex(v.InspectionError,'revalidation_preservation_failed'):
            n.revalidate_navigation_manifest(self.source,self.final,changed,self.manifest)
        changed,_=self.mutate(lambda w:w.pages[0].__setitem__(NameObject('/Rotate'),NumberObject(90)))
        with self.assertRaisesRegex(v.InspectionError,'revalidation_preservation_failed'):
            n.revalidate_navigation_manifest(self.source,self.final,changed,self.manifest)
    def test_revalidate_cannot_hide_lost_authored_replacement_text(self):
        from test_native_pdf_validation import replacement_reader
        from semantic_repairs import _tag_nodes
        source=self.root/'replacement-source.pdf';prior=self.root/'replacement-prior.pdf'
        current=self.root/'replacement-current.pdf'
        source.write_bytes(replacement_reader().stream.getvalue())
        with patch.object(n,'POLICY_SOURCE_SHA256',v.digest(source.read_bytes())),patch.object(n,'POLICY_ROWS',{}):
            manifest=n.repair_verified_navigation(source,source,prior)
            writer=PdfWriter(clone_from=PdfReader(prior))
            next(node for node in _tag_nodes(writer) if '/ActualText' in node).pop('/ActualText')
            with current.open('wb') as stream:writer.write(stream)
            with self.assertRaisesRegex(v.InspectionError,'revalidation_preservation_failed'):
                n.revalidate_navigation_manifest(source,prior,current,manifest)
    def test_full_generated_title_requires_exact_source_words_and_repaired_order(self):
        link={'id':'tag-2','parentId':'tag-1','role':'Link','text':'215 Notes from the Field:',
            'contentSequence':[{'kind':'objectReference','resolved':True,'pageNumber':1,'annotationIndex':13},
                               {'kind':'markedContent','resolved':True,'text':'215 Notes from the Field:'}]}
        prefix={'kind':'childTag','resolved':True,'tagId':'tag-2'}
        body={'kind':'markedContent','resolved':True,'text':'A reviewed report'}
        parent={'id':'tag-1','parentId':None,'role':'TOCI','contentSequence':[body,prefix]}
        policy={'title':'Notes from the Field: A reviewed report'}
        with patch.object(n.v,'structure_inventory',return_value={'tags':[parent,link]}):
            self.assertEqual(n._fourth_link_context(None,policy,require_order=False)['id'],'tag-2')
            with self.assertRaisesRegex(v.InspectionError,'verified_title_not_in_source_context'):n._fourth_link_context(None,policy)
            parent['contentSequence']=[prefix,body]
            self.assertEqual(n._fourth_link_context(None,policy)['id'],'tag-2')
            body['text']='A different report'
            with self.assertRaisesRegex(v.InspectionError,'verified_title_not_in_source_context'):n._fourth_link_context(None,policy)


if __name__=='__main__':unittest.main()
