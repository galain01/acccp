"""Independent hostile saved-file tests for the exact form-order permission."""
import copy
import json
import tempfile
import unittest
from pathlib import Path

from pypdf import PdfReader, PdfWriter
from pypdf.generic import ArrayObject, DecodedStreamObject, NameObject, NumberObject, TextStringObject
import verify_pdf as v
import form_order_validation as o
from test_form_label_validation import D, form_fixture, save, tag


class FormOrderValidationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='independent-form-order-')
        self.addCleanup(self.temp.cleanup); self.root = Path(self.temp.name)
        raw = self.root/'raw.pdf'; form_fixture(raw)
        writer = PdfWriter(clone_from=PdfReader(raw))
        font = writer._add_object(D(Type=NameObject('/Font'), Subtype=NameObject('/Type1'), BaseFont=NameObject('/Helvetica')))
        writer.pages[0][NameObject('/Resources')] = D(Font=D(F1=font))
        content = DecodedStreamObject(); content.set_data(b'BT /F1 12 Tf 20 370 Td (Registration) Tj ET\nBT /F1 12 Tf 20 306 Td (Name:) Tj ET\nBT /F1 12 Tf 20 266 Td (Session:) Tj ET')
        writer.pages[0][NameObject('/Contents')] = writer._add_object(content)
        for index, widget in enumerate(writer.pages[0]['/Annots']):
            widget.get_object()[NameObject('/Rect')] = ArrayObject([NumberObject(n) for n in (150, 300-index*40, 270, 320-index*40)])
        self.source = self.root/'source.pdf'; save(writer, self.source)
        tag(writer)
        root = writer.root_object['/StructTreeRoot']; document = root['/K']
        form_refs = list(document['/K'])
        heading = writer._add_object(D(Type=NameObject('/StructElem'), S=NameObject('/H1'), P=document.indirect_reference,
                                        Pg=writer.pages[0].indirect_reference, K=NumberObject(0)))
        paragraphs = [writer._add_object(D(Type=NameObject('/StructElem'), S=NameObject('/P'), P=document.indirect_reference,
                                            Pg=writer.pages[0].indirect_reference, K=NumberObject(i+1))) for i in range(2)]
        document[NameObject('/K')] = ArrayObject([heading]+paragraphs+form_refs)
        root['/ParentTree']['/Nums'].extend([NumberObject(2), ArrayObject([heading]+paragraphs)])
        root[NameObject('/ParentTreeNextKey')] = NumberObject(3)
        writer.pages[0][NameObject('/StructParents')] = NumberObject(2)
        content.set_data(b'/H1 <</MCID 0>> BDC BT /F1 12 Tf 20 370 Td (Registration) Tj ET EMC\n/P <</MCID 1>> BDC BT /F1 12 Tf 20 306 Td (Name:) Tj ET EMC\n/P <</MCID 2>> BDC BT /F1 12 Tf 20 266 Td (Session:) Tj ET EMC')
        # clone_from owns its stream; update the actual page's referenced object.
        writer.pages[0]['/Contents'].set_data(content.get_data())
        for widget in writer.pages[0]['/Annots']:
            widget.get_object()[NameObject('/Contents')] = TextStringObject('Annotation')
        prepared = self.root/'prepared.pdf'; save(writer, prepared)
        changes = []
        for index, form in enumerate(form_refs):
            label = ('Participant name','Preferred session')[index]
            for target, node, prop in [('formAlt',form.get_object(),'/Alt'),('widgetContents',writer.pages[0]['/Annots'][index].get_object(),'/Contents')]:
                node[NameObject(prop)] = TextStringObject(label)
                changes.append({'target':target,'fieldPath':[f'field{index}'],'widgetRefs':[{'pageNumber':1,'annotationIndex':index+1}],
                                'tagId':f'tag-{index+5}','beforePresent':True,'beforeValue':'Annotation','afterValue':label,'evidenceKind':'terminalFieldTooltip'})
        self.before = self.root/'labeled.pdf'; save(writer,self.before)
        label_ledger = {'schemaVersion':1,'operation':'native-form-labels','sourcePath':str(self.source),'inputPath':str(prepared),
                        'sourceSha256':v.digest(self.source.read_bytes()),'inputSha256':v.digest(prepared.read_bytes()),'outputSha256':v.digest(self.before.read_bytes()),
                        'changes':changes,'reviewItems':[],'widgetEvidence':[],'requiresRevalidation':True,'certification':False}
        label_path = self.root/'labels.json'; label_path.write_text(json.dumps(label_ledger),encoding='utf-8')
        audit = {'status':'complete','sourceSha256':label_ledger['sourceSha256'],'outputSha256':label_ledger['outputSha256'],
                 'machineFindingsRetained':True,'plannedBatchCount':1,'completedBatchCount':1,'reviewedPages':[1],
                 'reviewedTagIds':[f'tag-{i}' for i in range(1,7)],
                 'findings':[{'code':'reading-order','pageNumber':1,'tagIds':['tag-3','tag-4','tag-5','tag-6']}]}
        self.audit_path = self.root/'audit.json'; self.audit_path.write_text(json.dumps(audit),encoding='utf-8')
        document[NameObject('/K')] = ArrayObject([heading,paragraphs[0],form_refs[0],paragraphs[1],form_refs[1]])
        self.final = self.root/'ordered.pdf'; save(writer,self.final)
        pairs = []
        for index, text in enumerate(('Name:','Session:')):
            pairs.append({'labelTagId':f'tag-{index+3}','formTagId':f'tag-{index+5}','fieldPath':[f'field{index}'],
                          'widgetRef':{'pageNumber':1,'annotationIndex':index+1},'labelText':text,
                          'labelRect':list(o._visible_label_rect(self.source,1,text)),
                          'widgetRect':[150,300-index*40,270,320-index*40],'position':'labelThenControl'})
        self.ledger = {'schemaVersion':1,'operation':'native-form-reading-order','sourcePath':str(self.source),
                       'sourceSha256':v.digest(self.source.read_bytes()),'inputPath':str(self.before),
                       'inputSha256':v.digest(self.before.read_bytes()),'outputSha256':v.digest(self.final.read_bytes()),
                       'labelLedgerPath':str(label_path),'labelLedgerSha256':v.digest(label_path.read_bytes()),
                       'auditPath':str(self.audit_path),'auditSha256':v.digest(self.audit_path.read_bytes()),'parentTagId':'tag-1',
                       'beforeOrder':['tag-2','tag-3','tag-4','tag-5','tag-6'],'afterOrder':['tag-2','tag-3','tag-5','tag-4','tag-6'],
                       'pairs':pairs,'requiresRevalidation':True,'certification':False}

    def reject(self, fragment):
        with self.assertRaisesRegex(v.InspectionError,fragment):
            o.authorize_form_order(self.source,self.final,self.ledger)

    def mutate(self, fn):
        writer=PdfWriter(clone_from=PdfReader(self.final));fn(writer)
        self.final=self.root/'mutated.pdf';save(writer,self.final)
        self.ledger['outputSha256']=v.digest(self.final.read_bytes())

    def test_saved_exact_order_passes_and_exposes_current_tag_ids(self):
        hashes=[v.digest(p.read_bytes()) for p in (self.source,self.before,self.final)]
        report=o.compare_with_authorized_form_order(self.source,self.final,self.ledger)
        self.assertTrue(report['form_order_validation']['passed'],report['form_order_validation'])
        self.assertTrue(report['passed'])
        self.assertEqual(report['form_label_validation']['widgetEvidence'][0]['tagId'],'tag-4')
        self.assertEqual(hashes,[v.digest(p.read_bytes()) for p in (self.source,self.before,self.final)])

    def test_wrong_or_incomplete_audit_cannot_authorize_order(self):
        audit=json.loads(self.audit_path.read_text());audit['reviewedTagIds'].pop()
        path=self.root/'incomplete-audit.json';path.write_text(json.dumps(audit))
        self.ledger.update(auditPath=str(path),auditSha256=v.digest(path.read_bytes()))
        self.reject('audit_incomplete_or_mismatched')

    def test_label_geometry_claim_is_independently_measured(self):
        self.ledger['pairs'][0]['labelRect'][0]+=1
        self.reject('geometry_evidence_mismatch')

    def test_wrong_field_pair_cannot_be_justified_by_nearby_text(self):
        self.ledger['pairs'][0]['widgetRef']['annotationIndex']=2
        self.reject('single_widget_owner_required')

    def test_revised_pdf_without_actual_order_change_is_rejected(self):
        self.final=self.before;self.ledger['outputSha256']=v.digest(self.final.read_bytes())
        self.reject('input_output_alias')

    def test_extra_description_change_is_not_covered_by_order_permission(self):
        self.mutate(lambda w:w.pages[0]['/Annots'][0].get_object().__setitem__(NameObject('/Contents'),TextStringObject('Changed')))
        self.reject('unlisted_native_change')

    def test_actual_child_swap_cannot_be_hidden_by_expected_permutation(self):
        self.mutate(lambda w:w.root_object['/StructTreeRoot']['/K'].__setitem__(NameObject('/K'),ArrayObject(list(reversed(w.root_object['/StructTreeRoot']['/K']['/K'])))))
        self.reject('unlisted_native_change')

    def test_duplicate_or_missing_order_id_is_rejected(self):
        self.ledger['afterOrder'][1]='tag-2'
        self.reject('exact_permutation_required')

    def test_moving_heading_after_correct_pairs_is_not_authorized(self):
        self.ledger['afterOrder'] = ['tag-3','tag-5','tag-4','tag-6','tag-2']
        self.mutate(lambda w:w.root_object['/StructTreeRoot']['/K'].__setitem__(NameObject('/K'),ArrayObject(
            list(w.root_object['/StructTreeRoot']['/K']['/K'])[1:] + list(w.root_object['/StructTreeRoot']['/K']['/K'])[:1])))
        self.reject('unrelated_sibling_position_changed')

    def test_omitting_a_control_pair_is_not_partial_permission(self):
        self.ledger['pairs'].pop()
        self.reject('complete_page_widget_pairs_required')


if __name__=='__main__':unittest.main()
