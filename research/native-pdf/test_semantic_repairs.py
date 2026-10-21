import copy
import hashlib
import json
from pathlib import Path
import tempfile
import unittest

from pypdf import PdfReader, PdfWriter
from pypdf.generic import ArrayObject, BooleanObject, DecodedStreamObject, DictionaryObject, NameObject, NumberObject, TextStringObject

from semantic_repairs import apply_semantic_role_plan
from verify_pdf import compare_pdfs, structure_inventory


def fixture(path):
    writer = PdfWriter()
    page = writer.add_blank_page(200,200)
    font = DictionaryObject({NameObject('/Type'):NameObject('/Font'),NameObject('/Subtype'):NameObject('/Type1'),NameObject('/BaseFont'):NameObject('/Helvetica')})
    page[NameObject('/Resources')] = DictionaryObject({NameObject('/Font'):DictionaryObject({NameObject('/F1'):writer._add_object(font)})})
    content = DecodedStreamObject()
    content.set_data(b'/H3 <</MCID 0>> BDC BT /F1 12 Tf 20 100 Td (Consider the diagram.) Tj ET EMC')
    page[NameObject('/Contents')] = writer._add_object(content)
    page[NameObject('/StructParents')] = NumberObject(0)
    root = DictionaryObject({NameObject('/Type'):NameObject('/StructTreeRoot')})
    root_ref = writer._add_object(root)
    tag = DictionaryObject({NameObject('/Type'):NameObject('/StructElem'), NameObject('/S'):NameObject('/H3'),NameObject('/P'):root_ref,NameObject('/Pg'):page.indirect_reference,NameObject('/K'):NumberObject(0)})
    tag_ref = writer._add_object(tag)
    root[NameObject('/K')] = tag_ref
    root[NameObject('/ParentTree')] = DictionaryObject({NameObject('/Nums'):ArrayObject([NumberObject(0),ArrayObject([tag_ref])])})
    writer.root_object[NameObject('/StructTreeRoot')] = root_ref
    writer.root_object[NameObject('/MarkInfo')] = DictionaryObject({NameObject('/Marked'):BooleanObject(True)})
    writer.root_object[NameObject('/Lang')] = TextStringObject('en-US')
    with path.open('xb') as stream:writer.write(stream)


class SemanticRepairsTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.source=Path(temp.name)/'source.pdf';self.output=Path(temp.name)/'output.pdf';self.audit=Path(temp.name)/'audit.json'
        fixture(self.source)
        self.digest=hashlib.sha256(self.source.read_bytes()).hexdigest()
        tag=structure_inventory(PdfReader(self.source))['tags'][0]
        self.audit.write_text(json.dumps({'status':'complete','outputSha256':self.digest,'reviewedPages':[1],'reviewedTagIds':['tag-1'],'findings':[{'code':'heading-relationships','pageNumber':1,'tagIds':['tag-1']}]}))
        self.plan={'schemaVersion':1,'inputSha256':self.digest,'auditReportSha256':hashlib.sha256(self.audit.read_bytes()).hexdigest(),'repairs':[{'tagId':'tag-1','expected':{key:tag[key] for key in ('role','pageNumber','text','mcids')},'newRole':'P','findingCode':'heading-relationships','reason':'The reviewed sentence is an instruction, not a section heading.'}]}

    def test_exact_audited_role_change_preserves_everything_else(self):
        source_bytes=self.source.read_bytes()
        report=apply_semantic_role_plan(self.source,self.output,self.plan,audit_report=self.audit)
        self.assertEqual(source_bytes,self.source.read_bytes())
        self.assertEqual('P',structure_inventory(PdfReader(self.output))['tags'][0]['role'])
        self.assertEqual(PdfReader(self.source).pages[0].get_contents().get_data(),PdfReader(self.output).pages[0].get_contents().get_data())
        self.assertTrue(compare_pdfs(self.source,self.output)['preservation']['passed'])
        self.assertTrue(report['requires_revalidation'])
        self.assertFalse(report['certification'])

    def test_stale_hash_or_exact_text_or_mcid_rejected(self):
        for field,value in [('inputSha256','0'*64),('text','Different sentence'),('mcids',[1])]:
            plan=copy.deepcopy(self.plan)
            if field=='inputSha256':plan[field]=value
            else:plan['repairs'][0]['expected'][field]=value
            with self.assertRaises(ValueError):apply_semantic_role_plan(self.source,self.output,plan,audit_report=self.audit)
            self.assertFalse(self.output.exists())

    def test_audit_must_match_final_candidate_and_target(self):
        for delta in ({'status':'partial'},{'outputSha256':'0'*64},{'reviewedTagIds':[]},{'findings':[]}):
            audit=json.loads(self.audit.read_text());audit.update(delta)
            self.audit.write_text(json.dumps(audit))
            self.plan['auditReportSha256']=hashlib.sha256(self.audit.read_bytes()).hexdigest()
            with self.assertRaises(ValueError):apply_semantic_role_plan(self.source,self.output,self.plan,audit_report=self.audit)
            self.assertFalse(self.output.exists())

    def test_forbidden_roles_duplicate_targets_and_arbitrary_fields_rejected(self):
        plans=[]
        plan=copy.deepcopy(self.plan);plan['repairs'][0]['newRole']='Artifact';plans.append(plan)
        plan=copy.deepcopy(self.plan);plan['repairs']*=2;plans.append(plan)
        plan=copy.deepcopy(self.plan);plan['repairs'][0]['xml']='<P/>';plans.append(plan)
        for plan in plans:
            with self.assertRaises(ValueError):apply_semantic_role_plan(self.source,self.output,plan,audit_report=self.audit)
            self.assertFalse(self.output.exists())

    def test_signed_source_rejected(self):
        writer=PdfWriter(clone_from=self.source)
        writer.root_object[NameObject('/Perms')]=DictionaryObject()
        signed=self.source.with_name('signed.pdf')
        with signed.open('xb') as stream:writer.write(stream)
        with self.assertRaisesRegex(ValueError,'signed_pdf'):
            apply_semantic_role_plan(signed,self.output,self.plan,audit_report=self.audit)


if __name__=='__main__':unittest.main()
