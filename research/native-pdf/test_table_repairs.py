import copy
import hashlib
import json
from pathlib import Path
import tempfile
import unittest

from pypdf import PdfReader,PdfWriter
from pypdf.generic import ArrayObject,BooleanObject,DecodedStreamObject,DictionaryObject,NameObject,NumberObject,TextStringObject
from semantic_repairs import _tag_nodes
from table_repairs import apply_table_header_plan,table_snapshots,digest,_table_attributes,FOOTNOTE_DIRECTION
from verify_pdf import compare_pdfs,structure_inventory


def fixture(path,direction=None):
    writer=PdfWriter();root=DictionaryObject({NameObject('/Type'):NameObject('/StructTreeRoot')});root_ref=writer._add_object(root)
    doc=DictionaryObject({NameObject('/Type'):NameObject('/StructElem'),NameObject('/S'):NameObject('/Document'),NameObject('/P'):root_ref});doc_ref=writer._add_object(doc);root[NameObject('/K')]=doc_ref
    table=DictionaryObject({NameObject('/Type'):NameObject('/StructElem'),NameObject('/S'):NameObject('/Table'),NameObject('/P'):doc_ref});table_ref=writer._add_object(table);doc[NameObject('/K')]=table_ref
    rows=[];parent_nums=[]
    font=writer._add_object(DictionaryObject({NameObject('/Type'):NameObject('/Font'),NameObject('/Subtype'):NameObject('/Type1'),NameObject('/BaseFont'):NameObject('/Helvetica')}))
    for page_number,data in enumerate([
      [[('Label','TH',2,1),('Scores','TH',1,2)],[('2020','TH',1,1),('2021','TH',1,1)],[('North campuses','TD',1,3)],[('Oak','TD',1,1),('10','TD',1,1),('12','TD',1,1)]],
      [[('Label','TH',2,1),('Scores','TH',1,2)],[('2020','TH',1,1),('2021','TH',1,1)],[('Pine','TD',1,1),('20','TD',1,1),('22','TD',1,1)],[('Numbers are fictional.','TD',1,3)]]]):
        page=writer.add_blank_page(300,300);page[NameObject('/Resources')]=DictionaryObject({NameObject('/Font'):DictionaryObject({NameObject('/F1'):font})});page[NameObject('/StructParents')]=NumberObject(page_number)
        owners=[];ops=[]
        for ri,row_data in enumerate(data):
            row=DictionaryObject({NameObject('/Type'):NameObject('/StructElem'),NameObject('/S'):NameObject('/TR'),NameObject('/P'):table_ref});row_ref=writer._add_object(row);rows.append(row_ref);cells=[]
            for ci,(text,role,rs,cs) in enumerate(row_data):
                cell=DictionaryObject({NameObject('/Type'):NameObject('/StructElem'),NameObject('/S'):NameObject('/'+role),NameObject('/P'):row_ref,NameObject('/Pg'):page.indirect_reference,NameObject('/K'):NumberObject(len(owners))});cell_ref=writer._add_object(cell);owners.append(cell_ref);cells.append(cell_ref)
                attr=DictionaryObject({NameObject('/O'):NameObject('/Table')})
                if rs!=1:attr[NameObject('/RowSpan')]=NumberObject(rs)
                if cs!=1:attr[NameObject('/ColSpan')]=NumberObject(cs)
                if role=='TH':attr[NameObject('/Scope')]=NameObject('/Both')
                if len(attr)>1:cell[NameObject('/A')]=attr
                paragraph=DictionaryObject({NameObject('/Type'):NameObject('/StructElem'),NameObject('/S'):NameObject('/P'),NameObject('/P'):cell_ref,NameObject('/Pg'):page.indirect_reference,NameObject('/K'):NumberObject(len(owners)-1)})
                paragraph_ref=writer._add_object(paragraph);cell[NameObject('/K')]=paragraph_ref;owners[-1]=paragraph_ref
                ops.append(f'/{role} <</MCID {len(owners)-1}>> BDC BT /F1 10 Tf {10+ci*80} {250-ri*30} Td ({text}) Tj ET EMC')
            row[NameObject('/K')]=ArrayObject(cells)
        stream=DecodedStreamObject();stream.set_data('\n'.join(ops).encode());page[NameObject('/Contents')]=writer._add_object(stream);parent_nums.extend([NumberObject(page_number),ArrayObject(owners)])
    table[NameObject('/K')]=ArrayObject(rows);root[NameObject('/ParentTree')]=DictionaryObject({NameObject('/Nums'):ArrayObject(parent_nums)})
    if direction is not None:
        page_number,text=direction;page=writer.pages[page_number];owners=parent_nums[page_number*2+1];mcid=len(owners)
        paragraph=DictionaryObject({NameObject('/Type'):NameObject('/StructElem'),NameObject('/S'):NameObject('/P'),NameObject('/P'):doc_ref,NameObject('/Pg'):page.indirect_reference,NameObject('/K'):NumberObject(mcid)})
        ref=writer._add_object(paragraph);owners.append(ref);doc[NameObject('/K')]=ArrayObject([table_ref,ref])
        stream=DecodedStreamObject();stream.set_data(page.get_contents().get_data()+f'\n/P <</MCID {mcid}>> BDC BT /F1 8 Tf 10 20 Td ({text}) Tj ET EMC'.encode())
        page[NameObject('/Contents')]=writer._add_object(stream)
    writer.root_object[NameObject('/StructTreeRoot')]=root_ref;writer.root_object[NameObject('/Lang')]=TextStringObject('en-US');writer.root_object[NameObject('/MarkInfo')]=DictionaryObject({NameObject('/Marked'):BooleanObject(True)})
    with path.open('xb') as handle:writer.write(handle)


def plan_for(source,candidate,audit):
    table=table_snapshots(PdfReader(candidate))[0];rows=table['rows'];row_headers=[rows[3]['cells'][0]['tagId'],rows[6]['cells'][0]['tagId']]
    entry={'tagId':table['tagId'],'sourceTableIndex':0,'snapshotSha256':digest(table),'columnHeaderRows':[rows[i]['tagId'] for i in (0,1,4,5)],'rowHeaders':row_headers,
           'groups':[{'tagId':rows[2]['cells'][0]['tagId'],'rowHeaders':row_headers}],'noteCells':[rows[7]['cells'][0]['tagId']],'reason':'Reviewed native labels and repeated headers; retain the category across the page break.'}
    return {'schemaVersion':1,'originalSha256':hashlib.sha256(source.read_bytes()).hexdigest(),'inputSha256':hashlib.sha256(candidate.read_bytes()).hexdigest(),
            'auditCandidateSha256':hashlib.sha256(candidate.read_bytes()).hexdigest(),'auditReportSha256':hashlib.sha256(audit.read_bytes()).hexdigest(),'tables':[entry]}


class TableRepairs(unittest.TestCase):
    def setUp(self):
        tmp=tempfile.TemporaryDirectory();self.addCleanup(tmp.cleanup);root=Path(tmp.name)
        self.source=root/'source.pdf';self.candidate=root/'candidate.pdf';self.output=root/'output.pdf';self.audit=root/'audit.json'
        fixture(self.source);self.refresh_audit()
    def refresh_audit(self):
        self.candidate.write_bytes(self.source.read_bytes());tags=structure_inventory(PdfReader(self.candidate))['tags']
        self.audit.write_text(json.dumps({'status':'complete','sourceSha256':hashlib.sha256(self.source.read_bytes()).hexdigest(),'outputSha256':hashlib.sha256(self.candidate.read_bytes()).hexdigest(),
            'reviewedPages':[1,2],'reviewedTagIds':[t['id'] for t in tags],'findings':[{'code':'table-headers','tagIds':[t['id'] for t in tags if t['role']=='TD']}]}))
        self.plan=plan_for(self.source,self.candidate,self.audit)
    def add_direction(self,page=0):
        self.source=self.source.with_name('source-with-direction.pdf');fixture(self.source,direction=(page,FOOTNOTE_DIRECTION));self.refresh_audit()
    def apply(self,plan=None,**kw):return apply_table_header_plan(self.source,self.candidate,self.output,plan or self.plan,audit_report=self.audit,**kw)
    def test_real_header_graph_spans_values_and_pixels_preserved(self):
        original=self.source.read_bytes();before=self.candidate.read_bytes();report=self.apply();reader=PdfReader(self.output);tables=table_snapshots(reader);nodes=_tag_nodes(reader)
        tree=reader.root_object['/StructTreeRoot']['/IDTree']['/Names'];ids={str(tree[i]):tree[i+1].get_object() for i in range(0,len(tree),2)}
        cell=tables[0]['rows'][6]['cells'][2];node=nodes[int(cell['tagId'][4:])-1];attrs=_table_attributes(node)
        # A second-page value receives both column levels, the prior-page category,
        # and its row label; follow saved IDTree entries independently.
        names={id(n):f'tag-{i+1}' for i,n in enumerate(nodes)};texts={c['tagId']:c['text'] for r in tables[0]['rows'] for c in r['cells']}
        labels=[texts[names[id(ids[str(key)])]] for key in attrs['/Headers']]
        self.assertEqual(['Scores','2021','North campuses','Pine'],labels);self.assertEqual('TD',str(node['/S'])[1:])
        self.assertEqual(3,_table_attributes(nodes[int(self.plan['tables'][0]['groups'][0]['tagId'][4:])-1])['/ColSpan'])
        self.assertEqual('Row',str(_table_attributes(nodes[int(self.plan['tables'][0]['rowHeaders'][1][4:])-1])['/Scope'])[1:])
        self.assertTrue(compare_pdfs(self.candidate,self.output)['preservation']['passed']);self.assertEqual(original,self.source.read_bytes());self.assertEqual(before,self.candidate.read_bytes());self.assertTrue(report['requires_revalidation'])
    def test_stale_input_or_audit_and_incomplete_audit_rejected(self):
        for key in ('inputSha256','originalSha256','auditReportSha256','auditCandidateSha256'):
            plan=copy.deepcopy(self.plan);plan[key]='0'*64
            with self.assertRaises(ValueError):self.apply(plan)
        report=json.loads(self.audit.read_text());report['status']='partial';self.audit.write_text(json.dumps(report));self.plan['auditReportSha256']=hashlib.sha256(self.audit.read_bytes()).hexdigest()
        with self.assertRaisesRegex(ValueError,'complete_matching'):self.apply()
        self.assertFalse(self.output.exists())
    def test_wrong_snapshot_and_missing_audited_cell_rejected(self):
        plan=copy.deepcopy(self.plan);plan['tables'][0]['snapshotSha256']='0'*64
        with self.assertRaisesRegex(ValueError,'snapshot'):self.apply(plan)
        audit=json.loads(self.audit.read_text());audit['reviewedTagIds']=[];self.audit.write_text(json.dumps(audit));self.plan['auditReportSha256']=hashlib.sha256(self.audit.read_bytes()).hexdigest()
        with self.assertRaisesRegex(ValueError,'matching_table_audit'):self.apply()
    def test_incomplete_row_classification_and_noncontiguous_groups_rejected(self):
        plan=copy.deepcopy(self.plan);plan['tables'][0]['rowHeaders'].pop()
        with self.assertRaises(ValueError):self.apply(plan)
        plan=copy.deepcopy(self.plan);plan['tables'][0]['groups'][0]['rowHeaders'].reverse()
        with self.assertRaisesRegex(ValueError,'category_order'):self.apply(plan)
        self.assertFalse(self.output.exists())
    def test_source_cell_content_changes_are_rejected(self):
        writer=PdfWriter(clone_from=self.candidate);stream=DecodedStreamObject();stream.set_data(writer.pages[1].get_contents().get_data().replace(b'(22)',b'(99)'));writer.pages[1][NameObject('/Contents')]=writer._add_object(stream)
        with self.candidate.open('wb') as handle:writer.write(handle)
        self.plan['inputSha256']=hashlib.sha256(self.candidate.read_bytes()).hexdigest()
        with self.assertRaisesRegex(ValueError,'source_table_content'):self.apply(audit_candidate=self.source)
        self.assertFalse(self.output.exists())
    def test_existing_output_and_signed_original_are_rejected(self):
        self.output.write_bytes(b'keep')
        with self.assertRaises(ValueError):self.apply()
        self.assertEqual(b'keep',self.output.read_bytes());self.output.unlink()
        writer=PdfWriter(clone_from=self.source);writer.root_object[NameObject('/Perms')]=DictionaryObject({NameObject('/DocMDP'):writer._add_object(DictionaryObject({NameObject('/Type'):NameObject('/Sig')}))})
        with self.source.open('wb') as handle:writer.write(handle)
        with self.assertRaises(ValueError):self.apply()
    def test_tag_only_rebase_requires_exact_audited_table(self):
        writer=PdfWriter(clone_from=self.candidate);writer.add_metadata({'/Title':'Unrelated metadata change'})
        with self.candidate.open('wb') as handle:writer.write(handle)
        self.plan['inputSha256']=hashlib.sha256(self.candidate.read_bytes()).hexdigest()
        result=self.apply(audit_candidate=self.source)
        self.assertNotEqual(result['inputSha256'],result['auditCandidateSha256'])
    def test_changed_font_resource_is_not_treated_as_same_source_content(self):
        writer=PdfWriter(clone_from=self.candidate);writer.pages[0]['/Resources']['/Font']['/F1'][NameObject('/BaseFont')]=NameObject('/Courier')
        with self.candidate.open('wb') as handle:writer.write(handle)
        self.plan['inputSha256']=hashlib.sha256(self.candidate.read_bytes()).hexdigest()
        with self.assertRaisesRegex(ValueError,'source_table_content'):self.apply(audit_candidate=self.source)
        self.assertFalse(self.output.exists())
    def test_existing_identifiers_are_not_replaced(self):
        writer=PdfWriter(clone_from=self.candidate);_tag_nodes(writer)[0][NameObject('/ID')]=TextStringObject('authored-id')
        with self.candidate.open('wb') as handle:writer.write(handle)
        self.plan['inputSha256']=hashlib.sha256(self.candidate.read_bytes()).hexdigest()
        with self.assertRaisesRegex(ValueError,'existing_element_identifiers'):self.apply(audit_candidate=self.source)
        self.assertFalse(self.output.exists())
    def test_footnote_is_a_bound_note_after_table_with_same_paragraph_ownership(self):
        result=self.apply();reader=PdfReader(self.output);nodes=_tag_nodes(reader);note=next(n for n in nodes if n.get('/S')=='/Note')
        self.assertIn('/ID',note);self.assertNotIn('/A',note)
        parent=note['/P'];siblings=[n.get_object() for n in parent['/K']]
        self.assertEqual(['/Table','/Note'],[n['/S'] for n in siblings]);self.assertIs(siblings[1],note)
        paragraph=note['/K'];self.assertIs(paragraph['/P'],note)
        mcid=int(paragraph['/K']);owners=reader.root_object['/StructTreeRoot']['/ParentTree']['/Nums'][3]
        self.assertIs(owners[mcid].get_object(),paragraph)
        tags=structure_inventory(reader)['tags'];record=next(t for t in tags if t['role']=='Note')
        child=next(t for t in tags if t['parentId']==record['id'])
        self.assertEqual('Numbers are fictional.',' '.join(child['text'].split()))
        self.assertTrue(all(x.get('parentTreeVerified') for x in child['contentSequence']))
        self.assertEqual(1,result['footnoteContainersPromoted'])

    def test_direction_stays_native_between_table_and_full_footnote(self):
        self.add_direction();source_bytes=self.source.read_bytes();candidate_bytes=self.candidate.read_bytes();result=self.apply()
        reader=PdfReader(self.output);nodes=_tag_nodes(reader);parent=nodes[0];siblings=[n.get_object() for n in parent['/K']]
        self.assertEqual(['/Table','/P','/Note'],[n['/S'] for n in siblings])
        tags=structure_inventory(reader)['tags'];direction=next(t for t in tags if t['text'].strip()==FOOTNOTE_DIRECTION)
        self.assertEqual(1,direction['pageNumber']);self.assertTrue(all(c['parentTreeVerified'] for c in direction['contentSequence']))
        self.assertEqual(1,len(result['retainedFootnoteDirections']));self.assertEqual(FOOTNOTE_DIRECTION,result['retainedFootnoteDirections'][0]['text'])
        self.assertTrue(compare_pdfs(self.source,self.output)['preservation']['passed'])
        self.assertEqual(source_bytes,self.source.read_bytes());self.assertEqual(candidate_bytes,self.candidate.read_bytes())

    def test_direction_cannot_claim_footnotes_on_an_unrelated_page(self):
        self.add_direction(page=1)
        with self.assertRaisesRegex(ValueError,'direction_footnote_page_association'):self.apply()
        self.assertFalse(self.output.exists())

    def test_direction_requires_audited_native_membership(self):
        self.add_direction();audit=json.loads(self.audit.read_text())
        direction=next(t for t in structure_inventory(PdfReader(self.candidate))['tags'] if t['text'].strip()==FOOTNOTE_DIRECTION)
        audit['reviewedTagIds'].remove(direction['id']);self.audit.write_text(json.dumps(audit));self.plan['auditReportSha256']=hashlib.sha256(self.audit.read_bytes()).hexdigest()
        with self.assertRaisesRegex(ValueError,'audited_direction_changed'):self.apply()
        self.assertFalse(self.output.exists())

    def test_direction_text_cannot_change_from_the_original_page(self):
        self.add_direction();writer=PdfWriter(clone_from=self.candidate);page=writer.pages[0]
        stream=DecodedStreamObject();stream.set_data(page.get_contents().get_data().replace(FOOTNOTE_DIRECTION.encode(),b'See unrelated content on a different page.'));page[NameObject('/Contents')]=writer._add_object(stream)
        with self.candidate.open('wb') as handle:writer.write(handle)
        self.plan['inputSha256']=hashlib.sha256(self.candidate.read_bytes()).hexdigest()
        with self.assertRaisesRegex(ValueError,'source_table_content'):self.apply(audit_candidate=self.source)
        self.assertFalse(self.output.exists())


if __name__=='__main__':unittest.main()
