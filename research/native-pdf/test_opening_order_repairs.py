import copy,hashlib,json,tempfile,unittest
from pathlib import Path
from pypdf import PdfReader,PdfWriter
from pypdf.generic import NameObject, TextStringObject, NumberObject, ArrayObject
from test_structure_repairs import fixture
from semantic_repairs import _tag_nodes
from opening_order_repairs import move_reviewed_opening_blocks,subtree_snapshot,digest,native_attributes
from verify_pdf import structure_inventory


class OpeningOrderTests(unittest.TestCase):
    def setUp(self):
        temp=tempfile.TemporaryDirectory();self.addCleanup(temp.cleanup);self.folder=Path(temp.name)
        self.source=self.folder/'source.pdf';fixture(self.source)
        self.current=self.source;self.output=self.folder/'out.pdf';self.audit=self.folder/'audit.json'
        tags={t['id']:t for t in structure_inventory(PdfReader(self.source))['tags']}
        sha=hashlib.sha256(self.source.read_bytes()).hexdigest()
        self.audit.write_text(json.dumps({'status':'complete','outputSha256':sha,'reviewedPages':[1],
            'reviewedTagIds':list(tags),'findings':[{'code':'reading-order','tagIds':['tag-4']}]}))
        target=lambda key:{'tagId':key,'auditedTagId':key,'snapshotSha256':digest(subtree_snapshot(tags,key))}
        self.plan={'schemaVersion':1,'inputSha256':sha,'auditCandidateSha256':sha,
            'auditReportSha256':hashlib.sha256(self.audit.read_bytes()).hexdigest(),'blocks':[target('tag-4')],'before':target('tag-2')}

    def run_plan(self):
        return move_reviewed_opening_blocks(self.current,self.output,self.plan,audited_candidate=self.source,audit_report=self.audit)

    def test_changes_only_reviewed_order_and_preserves_source(self):
        source=self.source.read_bytes();self.run_plan()
        tags=structure_inventory(PdfReader(self.output))['tags']
        self.assertIn('Beta',tags[1]['text']);self.assertEqual(tags[2]['role'],'H1')
        self.assertIn('Alpha',tags[3]['text']);self.assertEqual(self.source.read_bytes(),source)

    def test_audit_can_follow_unrelated_metadata_change_with_exact_subtrees(self):
        writer=PdfWriter(clone_from=self.source);writer.add_metadata({'/Title':'Separate metadata fix'})
        self.current=self.folder/'current.pdf';writer.write(self.current)
        self.plan['inputSha256']=hashlib.sha256(self.current.read_bytes()).hexdigest()
        result=self.run_plan();self.assertNotEqual(result['inputSha256'],result['auditCandidateSha256'])

    def test_changed_target_cannot_use_old_audit_even_with_new_snapshot(self):
        writer=PdfWriter(clone_from=self.source);_tag_nodes(writer)[3][NameObject('/S')]=NameObject('/H2')
        self.current=self.folder/'changed.pdf';writer.write(self.current)
        self.plan['inputSha256']=hashlib.sha256(self.current.read_bytes()).hexdigest()
        tags={t['id']:t for t in structure_inventory(PdfReader(self.current))['tags']}
        self.plan['blocks'][0]['snapshotSha256']=digest(subtree_snapshot(tags,'tag-4'))
        with self.assertRaisesRegex(ValueError,'audited_subtree_changed'):self.run_plan()
        self.assertFalse(self.output.exists())

    def test_stale_audit_and_duplicate_targets_rejected(self):
        saved=copy.deepcopy(self.plan);self.plan['auditCandidateSha256']='0'*64
        with self.assertRaisesRegex(ValueError,'hash_mismatch'):self.run_plan()
        self.plan=saved;self.plan['blocks'].append(copy.deepcopy(self.plan['blocks'][0]))
        with self.assertRaisesRegex(ValueError,'unique_targets'):self.run_plan()

    def test_moved_block_must_have_audit_finding(self):
        self.plan['blocks'][0]['tagId']='tag-3';self.plan['blocks'][0]['auditedTagId']='tag-3'
        tags={t['id']:t for t in structure_inventory(PdfReader(self.current))['tags']}
        self.plan['blocks'][0]['snapshotSha256']=digest(subtree_snapshot(tags,'tag-3'))
        with self.assertRaisesRegex(ValueError,'matching_opening_order_finding_required'):self.run_plan()

    def test_renumbered_table_header_labels_keep_native_identity(self):
        base={'id':'tag-1','role':'TD','contentSequence':[], 'attributes':[{'headerTagIds':['tag-2'],'headersHex':['4142']}]}
        old={'tag-1':base,'tag-2':{'nativeIdHex':'4142'}}
        new=copy.deepcopy(old);new['tag-9']=new.pop('tag-2');new['tag-1']['attributes'][0]['headerTagIds']=['tag-9']
        self.assertEqual(subtree_snapshot(old,'tag-1'),subtree_snapshot(new,'tag-1'))
        new['tag-9']['nativeIdHex']='4344'
        self.assertNotEqual(subtree_snapshot(old,'tag-1'),subtree_snapshot(new,'tag-1'))

    def test_same_text_with_changed_font_is_not_covered_by_old_audit(self):
        writer=PdfWriter(clone_from=self.source)
        writer.pages[0]['/Resources']['/Font']['/F1'][NameObject('/BaseFont')]=NameObject('/Courier')
        self.current=self.folder/'font-changed.pdf';writer.write(self.current)
        self.plan['inputSha256']=hashlib.sha256(self.current.read_bytes()).hexdigest()
        with self.assertRaisesRegex(ValueError,'audited_opening_paint_changed'):self.run_plan()

    def test_native_properties_omitted_from_inspector_are_not_ignored(self):
        writer=PdfWriter(clone_from=self.source)
        _tag_nodes(writer)[3][NameObject('/T')]=TextStringObject('An unseen title')
        self.current=self.folder/'attr-changed.pdf';writer.write(self.current)
        self.plan['inputSha256']=hashlib.sha256(self.current.read_bytes()).hexdigest()
        with self.assertRaisesRegex(ValueError,'unsupported_opening_native_attributes'):self.run_plan()

    def test_changed_rotation_invalidates_prior_visual_review(self):
        writer=PdfWriter(clone_from=self.source);writer.pages[0][NameObject('/Rotate')]=NumberObject(90)
        self.current=self.folder/'rotated.pdf';writer.write(self.current)
        self.plan['inputSha256']=hashlib.sha256(self.current.read_bytes()).hexdigest()
        with self.assertRaisesRegex(ValueError,'audited_opening_geometry_changed'):self.run_plan()

    def test_empty_reference_list_retained_but_real_cross_reference_rejected(self):
        node=_tag_nodes(PdfReader(self.source))[3];node[NameObject('/Ref')]=ArrayObject()
        self.assertEqual(native_attributes(node)['attributes']['/Ref'],[])
        node[NameObject('/Ref')]=ArrayObject([node.indirect_reference])
        with self.assertRaisesRegex(ValueError,'unsupported_opening_native_attributes'):native_attributes(node)


if __name__=='__main__':unittest.main()
