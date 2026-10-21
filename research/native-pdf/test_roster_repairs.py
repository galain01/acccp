import copy
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from pypdf import PdfReader,PdfWriter
from pypdf.generic import ArrayObject,BooleanObject,DecodedStreamObject,DictionaryObject,NameObject,NumberObject,TextStringObject
from roster_repairs import apply_roster_plan,roster_snapshot
from table_repairs import digest
from semantic_repairs import _tag_nodes
import verify_pdf as v


def fixture(path):
    w=PdfWriter();page=w.add_blank_page(400,400);root=DictionaryObject({NameObject('/Type'):NameObject('/StructTreeRoot')});rr=w._add_object(root)
    document=DictionaryObject({NameObject('/Type'):NameObject('/StructElem'),NameObject('/S'):NameObject('/Document'),NameObject('/P'):rr,NameObject('/K'):ArrayObject()});dr=w._add_object(document);root[NameObject('/K')]=dr
    font=w._add_object(DictionaryObject({NameObject('/Type'):NameObject('/Font'),NameObject('/Subtype'):NameObject('/Type1'),NameObject('/BaseFont'):NameObject('/Helvetica')}))
    texts=['Alice Doe,','Director','Bob Roe,','Editor','Carol Poe,','David Moe,','Communication Specialists','Erin Loe,','Designer']
    form=DecodedStreamObject();form.update({NameObject('/Type'):NameObject('/XObject'),NameObject('/Subtype'):NameObject('/Form'),NameObject('/BBox'):ArrayObject([NumberObject(x) for x in (0,0,400,400)]),NameObject('/Resources'):DictionaryObject({NameObject('/Font'):DictionaryObject({NameObject('/F1'):font})}),NameObject('/StructParents'):NumberObject(1)})
    form.set_data('\n'.join(f'/P <</MCID {i}>> BDC BT /F1 10 Tf 20 {350-i*25} Td ({text}) Tj ET EMC' for i,text in enumerate(texts)).encode());fr=w._add_object(form)
    owners=ArrayObject()
    for group in ([0,1,2,3],[4,5],[6,7,8]):
        p=DictionaryObject({NameObject('/Type'):NameObject('/StructElem'),NameObject('/S'):NameObject('/P'),NameObject('/P'):dr,NameObject('/Pg'):page.indirect_reference,NameObject('/K'):ArrayObject()});pr=w._add_object(p);document['/K'].append(pr)
        for mcid in group:
            p['/K'].append(DictionaryObject({NameObject('/Type'):NameObject('/MCR'),NameObject('/Pg'):page.indirect_reference,NameObject('/Stm'):fr,NameObject('/MCID'):NumberObject(mcid)}));owners.append(pr)
    root[NameObject('/ParentTree')]=DictionaryObject({NameObject('/Nums'):ArrayObject([NumberObject(0),ArrayObject(),NumberObject(1),owners])})
    stream=DecodedStreamObject();stream.set_data(b'/Fm0 Do');page[NameObject('/Contents')]=w._add_object(stream)
    page[NameObject('/Resources')]=DictionaryObject({NameObject('/XObject'):DictionaryObject({NameObject('/Fm0'):fr})});page[NameObject('/StructParents')]=NumberObject(0)
    w.root_object[NameObject('/StructTreeRoot')]=rr;w.root_object[NameObject('/Lang')]=TextStringObject('en-US');w.root_object[NameObject('/MarkInfo')]=DictionaryObject({NameObject('/Marked'):BooleanObject(True)})
    with path.open('xb') as f:w.write(f)


class RosterRepairTests(unittest.TestCase):
    def setUp(self):
        temp=tempfile.TemporaryDirectory();self.addCleanup(temp.cleanup);self.folder=Path(temp.name)
        self.source=self.folder/'source.pdf';self.candidate=self.folder/'candidate.pdf';self.output=self.folder/'output.pdf';self.audit=self.folder/'audit.json'
        fixture(self.source);self.candidate.write_bytes(self.source.read_bytes());self.ids=['tag-2','tag-3','tag-4']
        sha=hashlib.sha256(self.source.read_bytes()).hexdigest()
        self.audit.write_text(json.dumps({'status':'complete','sourceSha256':sha,'outputSha256':sha,'reviewedPages':[1],'reviewedTagIds':self.ids,'findings':[{'code':'list-structure','pageNumber':1,'tagIds':self.ids}]}))
        snap=roster_snapshot(PdfReader(self.candidate),self.ids,1,'/Fm0')
        self.plan={'schemaVersion':1,'originalSha256':sha,'inputSha256':sha,'auditCandidateSha256':sha,'auditReportSha256':hashlib.sha256(self.audit.read_bytes()).hexdigest(),
                   'rosters':[{'tagIds':self.ids,'auditedTagIds':self.ids,'pageNumber':1,'formResource':'/Fm0','snapshotSha256':digest(snap),'items':[[0,1],[2,3],[4,5,6],[7,8]],'reason':'Reviewed separate people and the two names sharing one existing role line.'}]}
    def apply(self):return apply_roster_plan(self.source,self.candidate,self.output,self.plan,audit_candidate=self.source,audit_report=self.audit)
    def test_whole_chunks_become_items_with_same_text_paint_and_native_owners(self):
        source_bytes=self.source.read_bytes();candidate_bytes=self.candidate.read_bytes();result=self.apply();r=PdfReader(self.output);nodes=_tag_nodes(r);tags=v.structure_inventory(r)['tags']
        self.assertEqual(1,sum(t['role']=='L' for t in tags));self.assertEqual(4,sum(t['role']=='LI' for t in tags));self.assertEqual(4,sum(t['role']=='LBody' for t in tags))
        paragraphs=[t for t in tags if t['role']=='P'];self.assertEqual([0,1,2,3,4,5,6,7,8],[c['mcid'] for p in paragraphs for c in p['contentSequence']])
        self.assertEqual('Carol Poe, David Moe, Communication Specialists',' '.join(paragraphs[2]['text'].split()))
        self.assertTrue(all(c['parentTreeVerified'] and c['resolved'] for p in paragraphs for c in p['contentSequence']))
        parents=r.root_object['/StructTreeRoot']['/ParentTree']['/Nums'][3]
        for node in [n for n in nodes if n.get('/S')=='/P']:
            for ref in node['/K']:self.assertIs(parents[int(ref['/MCID'])].get_object(),node)
        old=PdfReader(self.source);self.assertEqual(old.pages[0].get_contents().get_data(),r.pages[0].get_contents().get_data())
        self.assertEqual(old.pages[0]['/Resources']['/XObject']['/Fm0'].get_data(),r.pages[0]['/Resources']['/XObject']['/Fm0'].get_data())
        self.assertTrue(v.compare_pdfs(self.source,self.output)['preservation']['passed']);self.assertEqual(source_bytes,self.source.read_bytes());self.assertEqual(candidate_bytes,self.candidate.read_bytes());self.assertTrue(result['requiresFreshAuditAndValidation'])
    def test_missing_duplicate_reordered_and_partial_chunks_are_rejected(self):
        original=copy.deepcopy(self.plan)
        for groups in ([[0,1],[2,3],[4,5],[7,8]],[[0,1],[2,3],[4,5,6],[6,7,8]],[[2,3],[0,1],[4,5,6],[7,8]],[[0,1],[2,3],[4,5,6],[7,8.5]]):
            self.plan=copy.deepcopy(original);self.plan['rosters'][0]['items']=groups
            with self.assertRaisesRegex(ValueError,'whole_chunk_partition'):self.apply()
            self.assertFalse(self.output.exists())
    def test_stale_snapshot_hash_and_incomplete_audit_rejected(self):
        original=copy.deepcopy(self.plan)
        for field in ('originalSha256','inputSha256','auditCandidateSha256','auditReportSha256'):
            self.plan=copy.deepcopy(original);self.plan[field]='0'*64
            with self.assertRaises(ValueError):self.apply()
        self.plan=copy.deepcopy(original);self.plan['rosters'][0]['snapshotSha256']='0'*64
        with self.assertRaisesRegex(ValueError,'snapshot'):self.apply()
        self.plan=original;a=json.loads(self.audit.read_text());a['status']='partial';self.audit.write_text(json.dumps(a));self.plan['auditReportSha256']=hashlib.sha256(self.audit.read_bytes()).hexdigest()
        with self.assertRaisesRegex(ValueError,'complete_roster_audit'):self.apply()
    def test_changed_form_font_and_reused_form_are_rejected(self):
        w=PdfWriter(clone_from=self.candidate);w.pages[0]['/Resources']['/XObject']['/Fm0']['/Resources']['/Font']['/F1'][NameObject('/BaseFont')]=NameObject('/Courier')
        with self.candidate.open('wb') as f:w.write(f)
        self.plan['inputSha256']=hashlib.sha256(self.candidate.read_bytes()).hexdigest()
        with self.assertRaisesRegex(ValueError,'snapshot_changed'):self.apply()
        w=PdfWriter(clone_from=self.source);stream=DecodedStreamObject();stream.set_data(b'/Fm0 Do /Fm0 Do');w.pages[0][NameObject('/Contents')]=w._add_object(stream)
        with self.candidate.open('wb') as f:w.write(f)
        self.plan['inputSha256']=hashlib.sha256(self.candidate.read_bytes()).hexdigest()
        with self.assertRaisesRegex(ValueError,'unique_direct_form'):self.apply()
    def test_unreviewed_roster_and_extra_semantic_properties_rejected(self):
        a=json.loads(self.audit.read_text());a['reviewedTagIds']=self.ids[:2];self.audit.write_text(json.dumps(a));self.plan['auditReportSha256']=hashlib.sha256(self.audit.read_bytes()).hexdigest()
        with self.assertRaisesRegex(ValueError,'audit_finding'):self.apply()
        w=PdfWriter(clone_from=self.candidate);_tag_nodes(w)[1][NameObject('/ActualText')]=TextStringObject('Existing replacement text')
        with self.candidate.open('wb') as f:w.write(f)
        self.plan['inputSha256']=hashlib.sha256(self.candidate.read_bytes()).hexdigest()
        with self.assertRaisesRegex(ValueError,'simple_roster_paragraph'):self.apply()
    def test_overwrite_and_signed_files_are_rejected(self):
        self.output.write_bytes(b'keep')
        with self.assertRaises(ValueError):self.apply()
        self.assertEqual(b'keep',self.output.read_bytes());self.output=self.folder/'fresh.pdf'
        w=PdfWriter(clone_from=self.source);w.root_object[NameObject('/Perms')]=DictionaryObject({NameObject('/DocMDP'):w._add_object(DictionaryObject({NameObject('/Type'):NameObject('/Sig')}))})
        with self.source.open('wb') as f:w.write(f)
        with self.assertRaises(ValueError):self.apply()

    def test_extra_parent_tree_reference_cannot_point_to_a_removed_paragraph(self):
        w=PdfWriter(clone_from=self.candidate);node=_tag_nodes(w)[1]
        w.root_object['/StructTreeRoot']['/ParentTree']['/Nums'][3].append(node.indirect_reference)
        with self.candidate.open('wb') as f:w.write(f)
        self.plan['inputSha256']=hashlib.sha256(self.candidate.read_bytes()).hexdigest()
        with self.assertRaisesRegex(ValueError,'unlisted_form_parent_owner'):self.apply()
        self.assertFalse(self.output.exists())

    def test_inspector_and_native_roles_must_align_before_mapping_tags(self):
        reader=PdfReader(self.candidate);inventory=v.structure_inventory(reader)
        inventory['tags'][1]['sourceRole']='Span'
        with self.assertRaisesRegex(ValueError,'roster_inventory_mismatch'):
            roster_snapshot(reader,self.ids,1,'/Fm0',inventory)
        self.assertFalse(self.output.exists())


if __name__=='__main__':unittest.main()
