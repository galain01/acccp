import copy
import hashlib
import json
from pathlib import Path
import tempfile
import unittest

from pypdf import PdfReader, PdfWriter
from pypdf.generic import ArrayObject, BooleanObject, DecodedStreamObject, DictionaryObject, NameObject, NumberObject, TextStringObject

from structure_repairs import apply_structure_plan, snapshot
from semantic_repairs import _tag_nodes
from verify_pdf import compare_pdfs, structure_inventory


def fixture(path, merged_label=False):
    writer = PdfWriter()
    page = writer.add_blank_page(300, 300)
    font = DictionaryObject({NameObject('/Type'): NameObject('/Font'), NameObject('/Subtype'): NameObject('/Type1'), NameObject('/BaseFont'): NameObject('/Helvetica')})
    page[NameObject('/Resources')] = DictionaryObject({NameObject('/Font'): DictionaryObject({NameObject('/F1'): writer._add_object(font)})})
    page[NameObject('/StructParents')] = NumberObject(0)
    root = DictionaryObject({NameObject('/Type'): NameObject('/StructTreeRoot')})
    root_ref = writer._add_object(root)
    doc = DictionaryObject({NameObject('/Type'): NameObject('/StructElem'), NameObject('/S'): NameObject('/Document'), NameObject('/P'): root_ref})
    doc_ref = writer._add_object(doc)
    root[NameObject('/K')] = doc_ref
    refs, owners, stream = [], [], []
    for index, (role, texts) in enumerate([('H1', ['References']), ('P', ['1. Combined' if merged_label else '1. ', 'Alpha citation.']), ('P', ['2. ', 'Beta citation.'])]):
        node = DictionaryObject({NameObject('/Type'): NameObject('/StructElem'), NameObject('/S'): NameObject('/' + role), NameObject('/P'): doc_ref, NameObject('/Pg'): page.indirect_reference})
        ref = writer._add_object(node); refs.append(ref); mcids = []
        for text in texts:
            mcid = len(owners); owners.append(ref); mcids.append(NumberObject(mcid))
            stream.append(f'/P <</MCID {mcid}>> BDC BT /F1 12 Tf {20 + 30 * (len(mcids)-1)} {250 - index * 30} Td ({text}) Tj ET EMC')
        node[NameObject('/K')] = ArrayObject(mcids)
    doc[NameObject('/K')] = ArrayObject(refs)
    root[NameObject('/ParentTree')] = DictionaryObject({NameObject('/Nums'): ArrayObject([NumberObject(0), ArrayObject(owners)])})
    content = DecodedStreamObject(); content.set_data('\n'.join(stream).encode())
    page[NameObject('/Contents')] = writer._add_object(content)
    writer.root_object[NameObject('/StructTreeRoot')] = root_ref
    writer.root_object[NameObject('/MarkInfo')] = DictionaryObject({NameObject('/Marked'): BooleanObject(True)})
    writer.root_object[NameObject('/Lang')] = TextStringObject('en-US')
    with path.open('xb') as handle: writer.write(handle)


class StructureRepairTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(); self.addCleanup(temp.cleanup)
        self.source = Path(temp.name) / 'source.pdf'; self.output = self.source.with_name('output.pdf')
        self.audit = self.source.with_name('audit.json')
        fixture(self.source)
        self.reset_plan()

    def reset_plan(self):
        tags = structure_inventory(PdfReader(self.source))['tags']
        digest = hashlib.sha256(self.source.read_bytes()).hexdigest()
        self.audit.write_text(json.dumps({'status': 'complete', 'outputSha256': digest, 'reviewedTagIds': [t['id'] for t in tags], 'findings': [{'code': 'list-structure', 'tagIds': ['tag-3','tag-4']}, {'code': 'heading-relationships','tagIds':['tag-2']}, {'code':'reading-order','tagIds':['tag-2','tag-3']}]}))
        self.plan = {'schemaVersion':1, 'inputSha256':digest, 'auditReportSha256':hashlib.sha256(self.audit.read_bytes()).hexdigest(), 'snapshots':{t['id']:snapshot(t) for t in tags}, 'operations':[{'kind':'list','tagId':'tag-1','items':['tag-3','tag-4'],'findingCode':'list-structure','reason':'The numbered references are a list.'}]}

    def run_plan(self):
        return apply_structure_plan(self.source, self.output, self.plan, audit_report=self.audit)

    def test_list_has_native_labels_bodies_and_exact_paint(self):
        original = self.source.read_bytes(); result = self.run_plan()
        tags = structure_inventory(PdfReader(self.output))['tags']
        self.assertEqual([t['role'] for t in tags], ['Document','H1','L','LI','Lbl','LBody','P','LI','Lbl','LBody','P'])
        self.assertEqual([t['text'].strip() for t in tags if t['role']=='Lbl'], ['1.','2.'])
        self.assertEqual([t['text'].strip() for t in tags if t['role']=='P'], ['Alpha citation.','Beta citation.'])
        self.assertTrue(all(c['parentTreeVerified'] for t in tags for c in t['contentSequence'] if c['kind']=='markedContent'))
        self.assertEqual(original, self.source.read_bytes())
        self.assertTrue(compare_pdfs(self.source,self.output)['preservation']['passed'])
        self.assertFalse(result['certification'])

    def test_order_and_heading_change_preserve_content(self):
        self.plan['operations'] = [{'kind':'order','tagId':'tag-1','order':[1,0,2],'findingCode':'reading-order','reason':'Place content in verified order.'}, {'kind':'role','tagId':'tag-2','role':'H2','findingCode':'heading-relationships','reason':'Section below article title.'}]
        self.run_plan()
        tags=structure_inventory(PdfReader(self.output))['tags']
        self.assertEqual([t['role'] for t in tags], ['Document','P','H2','P'])
        self.assertTrue(compare_pdfs(self.source,self.output)['preservation']['passed'])

    def test_rejects_stale_snapshots_and_hashes(self):
        for field in ('inputSha256','auditReportSha256','snapshots'):
            saved=copy.deepcopy(self.plan)
            if field=='snapshots':self.plan[field]['tag-3']['text']='Altered'
            else:self.plan[field]='0'*64
            with self.assertRaises(ValueError):self.run_plan()
            self.assertFalse(self.output.exists()); self.plan=saved

    def test_rejects_deletion_duplication_and_cross_parent_permutations(self):
        for order in ([0,1],[0,1,1],[0,1,3],[False,1,2]):
            self.plan['operations']=[{'kind':'order','tagId':'tag-1','order':order,'findingCode':'reading-order','reason':'Invalid permutation.'}]
            with self.assertRaises(ValueError):self.run_plan()
            self.assertFalse(self.output.exists())

    def test_merged_label_is_not_split_by_guessing(self):
        second=self.source.with_name('merged.pdf');fixture(second,True);self.source=second;self.reset_plan()
        with self.assertRaisesRegex(ValueError,'separate_exact_number_label_required'):self.run_plan()
        self.assertFalse(self.output.exists())

    def test_requires_complete_audit_and_matching_finding(self):
        self.plan['operations'][0]['findingCode']='missing-content'
        with self.assertRaisesRegex(ValueError,'audit_finding_required'):self.run_plan()
        self.assertFalse(self.output.exists())

    def test_rejects_role_that_excludes_content(self):
        self.plan['operations']=[{'kind':'role','tagId':'tag-2','role':'Artifact','findingCode':'heading-relationships','reason':'Invalid exclusion.'}]
        with self.assertRaisesRegex(ValueError,'unsupported_role_change'):self.run_plan()
        self.assertFalse(self.output.exists())

    def test_list_rejects_replacement_text_and_prior_role_change(self):
        for key in ('/Alt','/ActualText'):
            writer=PdfWriter(clone_from=self.source)
            _tag_nodes(writer)[2][NameObject(key)]=TextStringObject('1. Replacement citation')
            altered=self.source.with_name(key[1:]+'.pdf')
            with altered.open('xb') as handle:writer.write(handle)
            previous=self.source;self.source=altered;self.reset_plan()
            with self.assertRaisesRegex(ValueError,'unsupported_list_paragraph'):self.run_plan()
            self.assertFalse(self.output.exists());self.source=previous
        self.reset_plan()
        self.plan['operations'].insert(0,{'kind':'role','tagId':'tag-3','role':'H2','findingCode':'list-structure','reason':'Unsupported combined operations.'})
        with self.assertRaisesRegex(ValueError,'unsupported_list_paragraph'):self.run_plan()
        self.assertFalse(self.output.exists())


if __name__=='__main__':unittest.main()
