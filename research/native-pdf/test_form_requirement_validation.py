"""Saved-file adversarial tests for a single author-approved checkbox flag."""
import copy
import json
import logging
import unittest

from pypdf import PdfReader,PdfWriter
from pypdf.generic import NameObject,NumberObject,TextStringObject

import form_requirement_validation as f
import test_form_font_repairs as fixture_module
import verify_pdf as v


class FormRequirementValidationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):fixture_module.FormFontRepairTests.setUpClass()

    def setUp(self):
        self.fixture=fixture_module.FormFontRepairTests();self.fixture.setUp();self.addCleanup(self.fixture.doCleanups)
        font_ledger=self.fixture.repair();self.font_path=self.fixture.directory/'fonts.json'
        self.font_path.write_text(json.dumps(font_ledger),encoding='utf-8')
        self.decision_path=self.fixture.directory/'decision.json'
        self.decision={'schemaVersion':1,'candidateSha256':font_ledger['outputSha256'],
                       'fieldPath':['materials'],'tooltip':'Send workshop materials','clearRequired':True}
        self.decision_path.write_text(json.dumps(self.decision),encoding='utf-8')
        reader=PdfReader(self.fixture.output);forms,owners,_=f.labels._native_forms(reader,required=True)
        writer=PdfWriter(clone_from=reader);widget=writer.pages[0]['/Annots'][2].get_object()
        old=int(widget['/Ff']);widget[NameObject('/Ff')]=NumberObject(old&~2)
        self.output=self.fixture.directory/'optional.pdf'
        with self.output.open('xb') as handle:writer.write(handle)
        self.ledger={'schemaVersion':1,'operation':'native-form-requirement',
            'sourcePath':str(self.fixture.original),'sourceSha256':v.digest(self.fixture.original.read_bytes()),
            'inputPath':str(self.fixture.output),'inputSha256':v.digest(self.fixture.output.read_bytes()),
            'outputSha256':v.digest(self.output.read_bytes()),'fontLedgerPath':str(self.font_path),
            'fontLedgerSha256':v.digest(self.font_path.read_bytes()),'authorDecisionPath':str(self.decision_path),
            'authorDecisionSha256':v.digest(self.decision_path.read_bytes()),'fieldPath':['materials'],
            'widgetRef':{'pageNumber':1,'annotationIndex':3},'tagId':owners[(1,3)],
            'beforeFlags':old,'afterFlags':old&~2,'requiresFreshAudit':True,'certification':False}
        logging.getLogger('pypdf').setLevel(logging.ERROR)

    def check(self):return f.authorize_form_requirement(self.fixture.original,self.output,self.ledger)[0]

    def mutate(self,callback):
        writer=PdfWriter(clone_from=self.output);callback(writer)
        with self.output.open('wb') as handle:writer.write(handle)
        self.ledger['outputSha256']=v.digest(self.output.read_bytes())

    def change_decision(self,**changes):
        self.decision.update(changes);self.decision_path.write_text(json.dumps(self.decision),encoding='utf-8')
        self.ledger['authorDecisionSha256']=v.digest(self.decision_path.read_bytes())

    def test_exact_optional_flag_keeps_font_chain_pixels_and_other_controls(self):
        hashes=[v.digest(path.read_bytes()) for path in (self.fixture.original,self.fixture.output,self.output)]
        report=f.compare_with_authorized_form_requirement(self.fixture.original,self.output,self.ledger)
        self.assertTrue(report['passed'],report['form_requirement_validation'])
        proof=report['form_requirement_validation'];self.assertTrue(proof['onlyRequiredBitCleared'])
        self.assertTrue(proof['initializedWidgetPixelsIdentical']);self.assertEqual((2,0),(proof['beforeFlags'],proof['afterFlags']))
        for key in ('form_requirement_validation','form_font_validation','form_order_validation','form_label_validation'):
            self.assertFalse(report[key]['widgetEvidence'][2]['required'])
            self.assertEqual('/Off',report[key]['widgetEvidence'][2]['value'])
        self.assertEqual(hashes,[v.digest(path.read_bytes()) for path in (self.fixture.original,self.fixture.output,self.output)])

    def test_exact_author_decision_is_required_not_ledger_assertion(self):
        for changes in ({'clearRequired':False},{'clearRequired':1},{'schemaVersion':True},{'candidateSha256':'0'*64},
                        {'fieldPath':['participant']},{'tooltip':'Another checkbox'},{'allowOtherChanges':True}):
            with self.subTest(changes=changes):
                old=copy.deepcopy(self.decision);self.change_decision(**changes)
                with self.assertRaisesRegex(v.InspectionError,'exact_author_decision'):self.check()
                self.decision=old;self.change_decision()

    def test_other_flag_bits_cannot_change_even_if_manifest_claims_them(self):
        self.mutate(lambda w:w.pages[0]['/Annots'][2].get_object().__setitem__(NameObject('/Ff'),NumberObject(1)))
        self.ledger['afterFlags']=1
        with self.assertRaisesRegex(v.InspectionError,'only_required_bit'):self.check()

    def test_other_control_required_readonly_flags_cannot_change(self):
        self.mutate(lambda w:w.pages[0]['/Annots'][0].get_object().__setitem__(NameObject('/Ff'),NumberObject(3)))
        with self.assertRaisesRegex(v.InspectionError,'unlisted_native_change'):self.check()

    def test_checkbox_checked_state_and_value_are_preserved(self):
        def toggle(writer):
            widget=writer.pages[0]['/Annots'][2].get_object()
            widget[NameObject('/V')]=NameObject('/Yes');widget[NameObject('/AS')]=NameObject('/Yes')
        self.mutate(toggle)
        with self.assertRaisesRegex(v.InspectionError,'unlisted_native_change'):self.check()

    def test_wrong_native_owner_or_widget_ref_is_rejected(self):
        for field,value in [('tagId','tag-1'),('widgetRef',{'pageNumber':1,'annotationIndex':1}),('fieldPath',['participant'])]:
            with self.subTest(field=field):
                old=self.ledger[field];self.ledger[field]=value
                with self.assertRaises(v.InspectionError):self.check()
                self.ledger[field]=old

    def test_actual_label_cannot_be_changed_with_the_flag(self):
        self.mutate(lambda w:w.pages[0]['/Annots'][2].get_object().__setitem__(NameObject('/TU'),TextStringObject('Changed label')))
        with self.assertRaisesRegex(v.InspectionError,'label_owner_mismatch'):self.check()

    def test_appearance_and_metadata_changes_are_not_authorized(self):
        self.mutate(lambda w:w.pages[0]['/Annots'][2].get_object()['/AP']['/N']['/Off'].set_data(b'q 0 0 1 rg 0 0 18 18 re f Q'))
        with self.assertRaisesRegex(v.InspectionError,'unlisted_native_change'):self.check()

    def test_no_inherited_flag_guess_or_deleted_local_flag(self):
        self.mutate(lambda w:w.pages[0]['/Annots'][2].get_object().pop('/Ff'))
        with self.assertRaisesRegex(v.InspectionError,'local_flags_required'):self.check()

    def test_stale_prior_font_ledger_or_output_hash_cannot_pass(self):
        original=self.ledger['fontLedgerSha256'];self.ledger['fontLedgerSha256']='0'*64
        with self.assertRaisesRegex(v.InspectionError,'evidence_hash_mismatch'):self.check()
        self.ledger['fontLedgerSha256']=original;self.ledger['outputSha256']='0'*64
        with self.assertRaisesRegex(v.InspectionError,'file_binding_mismatch'):self.check()


if __name__=='__main__':unittest.main()
