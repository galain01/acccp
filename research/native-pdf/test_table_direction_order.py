import copy
import hashlib
import json
from pathlib import Path
import tempfile
import unittest

from pypdf import PdfReader, PdfWriter
from pypdf.generic import ArrayObject, BooleanObject, DecodedStreamObject, DictionaryObject, NameObject, NumberObject, TextStringObject
from semantic_repairs import _tag_nodes
from table_direction_order import move_table_directions
from opening_order_repairs import digest, subtree_snapshot
from table_repairs import FOOTNOTE_DIRECTION
from verify_pdf import structure_inventory, compare_pdfs


def fixture(path):
    writer=PdfWriter();root=DictionaryObject({NameObject('/Type'):NameObject('/StructTreeRoot')});root_ref=writer._add_object(root)
    def node(role,parent,page=None):
        item=DictionaryObject({NameObject('/Type'):NameObject('/StructElem'),NameObject('/S'):NameObject('/'+role),NameObject('/P'):parent})
        if page is not None:item[NameObject('/Pg')]=page.indirect_reference
        writer._add_object(item);return item
    doc=node('Document',root_ref);root[NameObject('/K')]=doc.indirect_reference;blocks=[];parent_nums=[]
    font=writer._add_object(DictionaryObject({NameObject('/Type'):NameObject('/Font'),NameObject('/Subtype'):NameObject('/Type1'),NameObject('/BaseFont'):NameObject('/Helvetica')}))
    for index in range(2):
        pages=[];owners=[];programs=[]
        for part in range(2):
            page=writer.add_blank_page(300,300);page[NameObject('/Resources')]=DictionaryObject({NameObject('/Font'):DictionaryObject({NameObject('/F1'):font})})
            page[NameObject('/StructParents')]=NumberObject(index*2+part)
            pages.append(page);owners.append([]);programs.append([])
        def text(item,value,part,y):
            mcid=len(owners[part]);owners[part].append(item.indirect_reference);item[NameObject('/K')]=NumberObject(mcid)
            programs[part].append(f'/P <</MCID {mcid}>> BDC BT /F1 10 Tf 10 {y} Td ({value}) Tj ET EMC')
        title=node('P',doc.indirect_reference,pages[0]);text(title,f'TABLE {index+1}. Fictional scores',0,270)
        table=node('Table',doc.indirect_reference,pages[0]);rows=[]
        for part in range(2):
            row=node('TR',table.indirect_reference,pages[part]);cell=node('TH' if part==0 else 'TD',row.indirect_reference,pages[part])
            text(cell,'Scores' if part==0 else 'Ten',part,210)
            row[NameObject('/K')]=ArrayObject([cell.indirect_reference]);rows.append(row.indirect_reference)
        table[NameObject('/K')]=ArrayObject(rows)
        direction=node('P',doc.indirect_reference,pages[0]);text(direction,FOOTNOTE_DIRECTION,0,20)
        note=node('Note',doc.indirect_reference,pages[1]);paragraph=node('P',note.indirect_reference,pages[1]);text(paragraph,'Fictional footnote.',1,20)
        note[NameObject('/K')]=ArrayObject([paragraph.indirect_reference]);note[NameObject('/ID')]=TextStringObject('note-'+str(index))
        blocks.extend([title.indirect_reference,table.indirect_reference,direction.indirect_reference,note.indirect_reference])
        for part,page in enumerate(pages):
            stream=DecodedStreamObject();stream.set_data('\n'.join(programs[part]).encode());page[NameObject('/Contents')]=writer._add_object(stream)
            parent_nums.extend([NumberObject(index*2+part),ArrayObject(owners[part])])
    doc[NameObject('/K')]=ArrayObject(blocks);root[NameObject('/ParentTree')]=DictionaryObject({NameObject('/Nums'):ArrayObject(parent_nums)})
    writer.root_object[NameObject('/StructTreeRoot')]=root_ref;writer.root_object[NameObject('/Lang')]=TextStringObject('en-US')
    writer.root_object[NameObject('/MarkInfo')]=DictionaryObject({NameObject('/Marked'):BooleanObject(True)})
    with path.open('xb') as out:writer.write(out)


def make_plan(current,audited,audit_path):
    tags={t['id']:t for t in structure_inventory(PdfReader(current))['tags']}
    old={t['id']:t for t in structure_inventory(PdfReader(audited))['tags']}
    moves=[]
    for values in [tags,old]:
        siblings=[t for t in values.values() if t['parentId']=='tag-1']
        if values is tags:now=siblings
        else:previous=siblings
    for start in (0,4):
        entries={}
        for key,offset in [('title',0),('table',1),('direction',2),('note',3)]:
            entries[key]={'tagId':now[start+offset]['id'],'auditedTagId':previous[start+offset]['id'],
                'snapshotSha256':digest(subtree_snapshot(tags,now[start+offset]['id']))}
        moves.append(entries)
    return {'schemaVersion':1,'inputSha256':hashlib.sha256(current.read_bytes()).hexdigest(),
        'auditCandidateSha256':hashlib.sha256(audited.read_bytes()).hexdigest(),
        'auditReportSha256':hashlib.sha256(audit_path.read_bytes()).hexdigest(),'moves':moves}


class TableDirectionTests(unittest.TestCase):
    def setUp(self):
        tmp=tempfile.TemporaryDirectory();self.addCleanup(tmp.cleanup);self.folder=Path(tmp.name)
        self.current=self.folder/'current.pdf';fixture(self.current)
        self.audited=self.folder/'audited.pdf';writer=PdfWriter(clone_from=self.current);writer.add_blank_page(300,300);writer.write(self.audited)
        self.output=self.folder/'output.pdf';self.audit=self.folder/'audit.json'
        tags=structure_inventory(PdfReader(self.audited))['tags']
        direction=next(t for t in tags if t['text'].strip()==FOOTNOTE_DIRECTION)
        self.audit.write_text(json.dumps({'status':'complete','outputSha256':hashlib.sha256(self.audited.read_bytes()).hexdigest(),
            'reviewedPages':[1,2,3,4,5],'reviewedTagIds':[t['id'] for t in tags],
            'findings':[{'code':'reading-order','tagIds':[direction['id']]}]}))
        self.plan=make_plan(self.current,self.audited,self.audit)
    def run_plan(self):
        return move_table_directions(self.current,self.output,self.plan,audited_candidate=self.audited,audit_report=self.audit)
    def mutate_current(self,callback):
        writer=PdfWriter(clone_from=self.current);callback(writer);writer.write(self.current)
        self.plan=make_plan(self.current,self.audited,self.audit)
    def test_moves_only_two_direction_siblings_and_keeps_native_page_ownership(self):
        before=self.current.read_bytes();audited=self.audited.read_bytes();report=self.run_plan()
        tags=structure_inventory(PdfReader(self.output))['tags'];siblings=[t for t in tags if t['parentId']=='tag-1']
        self.assertEqual([t['role'] for t in siblings],['P','P','Table','Note']*2)
        for start,page in [(0,1),(4,3)]:
            self.assertEqual(siblings[start+1]['text'],FOOTNOTE_DIRECTION);self.assertEqual(siblings[start+1]['pageNumber'],page)
            self.assertTrue(siblings[start+1]['contentSequence'][0]['parentTreeVerified'])
        self.assertEqual(len(report['movedDirections']),2)
        self.assertTrue(compare_pdfs(self.current,self.output)['preservation']['passed'])
        self.assertEqual([p.get_contents().get_data() for p in PdfReader(self.current).pages],
                         [p.get_contents().get_data() for p in PdfReader(self.output).pages])
        self.assertEqual(self.current.read_bytes(),before);self.assertEqual(self.audited.read_bytes(),audited)
    def test_stale_or_partial_audit_rejected(self):
        for field in ('inputSha256','auditCandidateSha256','auditReportSha256'):
            plan=copy.deepcopy(self.plan);self.plan[field]='0'*64
            with self.assertRaises(ValueError):self.run_plan()
            self.plan=plan
        audit=json.loads(self.audit.read_text());audit['status']='partial';self.audit.write_text(json.dumps(audit))
        self.plan['auditReportSha256']=hashlib.sha256(self.audit.read_bytes()).hexdigest()
        with self.assertRaisesRegex(ValueError,'complete_matching'):self.run_plan()
    def test_changed_audited_table_subtree_cannot_rebase(self):
        def change(writer):
            cell=next(n for n in _tag_nodes(writer) if n['/S']=='/TH');cell[NameObject('/S')]=NameObject('/TD')
        self.mutate_current(change)
        with self.assertRaisesRegex(ValueError,'audited_subtree_changed'):self.run_plan()
    def test_changed_resource_or_geometry_invalidates_old_audit(self):
        self.mutate_current(lambda w:w.pages[0]['/Resources']['/Font']['/F1'].__setitem__(NameObject('/BaseFont'),NameObject('/Courier')))
        with self.assertRaisesRegex(ValueError,'audited_table_paint_changed'):self.run_plan()
    def test_changed_rotation_invalidates_the_reviewed_page_context(self):
        self.mutate_current(lambda w:w.pages[0].__setitem__(NameObject('/Rotate'),NumberObject(90)))
        with self.assertRaisesRegex(ValueError,'audited_table_geometry_changed'):self.run_plan()
    def test_same_subtrees_in_a_nonconsecutive_context_are_rejected(self):
        writer=PdfWriter(clone_from=self.current);doc=_tag_nodes(writer)[0]
        kids=list(doc['/K']);kids[2],kids[4]=kids[4],kids[2];doc[NameObject('/K')]=ArrayObject(kids)
        writer.write(self.current);self.plan['inputSha256']=hashlib.sha256(self.current.read_bytes()).hexdigest()
        tags={t['id']:t for t in structure_inventory(PdfReader(self.current))['tags']}
        for move in self.plan['moves']:
            for entry in move.values():
                matches=[key for key in tags if digest(subtree_snapshot(tags,key))==entry['snapshotSha256']]
                self.assertEqual(len(matches),1);entry['tagId']=matches[0]
        with self.assertRaisesRegex(ValueError,'consecutive_title_table_direction_note'):self.run_plan()
    def test_missing_reviewed_context_or_no_finding_is_rejected(self):
        audit=json.loads(self.audit.read_text());audit['reviewedTagIds'].remove(self.plan['moves'][1]['direction']['auditedTagId'])
        self.audit.write_text(json.dumps(audit));self.plan['auditReportSha256']=hashlib.sha256(self.audit.read_bytes()).hexdigest()
        with self.assertRaisesRegex(ValueError,'reviewed_table_context'):self.run_plan()
        audit['reviewedTagIds'].append(self.plan['moves'][1]['direction']['auditedTagId']);audit['findings']=[]
        self.audit.write_text(json.dumps(audit));self.plan['auditReportSha256']=hashlib.sha256(self.audit.read_bytes()).hexdigest()
        with self.assertRaisesRegex(ValueError,'matching_direction_order_finding'):self.run_plan()
    def test_duplicate_or_wrong_snapshot_targets_rejected(self):
        self.plan['moves'][1]=copy.deepcopy(self.plan['moves'][0])
        with self.assertRaisesRegex(ValueError,'unique_direction_targets'):self.run_plan()
    def test_outputs_are_not_overwritten(self):
        self.output.write_bytes(b'keep')
        with self.assertRaises(ValueError):self.run_plan()
        self.assertEqual(self.output.read_bytes(),b'keep')


if __name__=='__main__':unittest.main()
