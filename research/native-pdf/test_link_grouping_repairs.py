"""Source-grounded Link regrouping keeps every painted byte and annotation."""
import io
from pathlib import Path
import tempfile
import unittest

from pypdf import PdfReader, PdfWriter
from pypdf.generic import ArrayObject, BooleanObject, DecodedStreamObject, DictionaryObject, NameObject, NullObject, NumberObject, TextStringObject
from link_grouping_repairs import restore_source_uri_groups, compact
from verify_pdf import compare_pdfs, structure_inventory, resolved


def fixture(*, fragmented=False, target='https://example.org/a', source_alt=None, changed_action=False, intervening=False, bad_prefix=False):
    writer=PdfWriter();page=writer.add_blank_page(width=300,height=160)
    font=writer._add_object(DictionaryObject({NameObject('/Type'):NameObject('/Font'),NameObject('/Subtype'):NameObject('/Type1'),NameObject('/BaseFont'):NameObject('/Helvetica')}))
    page[NameObject('/Resources')]=DictionaryObject({NameObject('/Font'):DictionaryObject({NameObject('/F1'):font})})
    root=DictionaryObject({NameObject('/Type'):NameObject('/StructTreeRoot')});root_ref=writer._add_object(root)
    document=DictionaryObject({NameObject('/Type'):NameObject('/StructElem'),NameObject('/S'):NameObject('/Document'),NameObject('/P'):root_ref});doc_ref=writer._add_object(document)
    parent=DictionaryObject({NameObject('/Type'):NameObject('/StructElem'),NameObject('/S'):NameObject('/P'),NameObject('/P'):doc_ref,NameObject('/Pg'):page.indirect_reference});parent_ref=writer._add_object(parent)
    address=target.removeprefix('mailto:');prefix=address[0];cut=len(address)//2
    pieces=[prefix,address[1:cut],address[cut:]]
    bodies=[f'BT /F1 10 Tf {20 if i!=1 else 26} {120 if i<2 else 106} Td ({part}) Tj ET' for i,part in enumerate(pieces)]
    label='BT /F1 10 Tf 20 140 Td (See ) Tj ET'
    content='/P << /MCID 3 >> BDC '+label+' EMC '
    if fragmented:
        for i,body in enumerate(bodies):content+=f'/{"P" if i==0 else "Link"} << /MCID {i} >> BDC '+body+' EMC '
    else:content+='/Link << /MCID 0 >> BDC '+' '.join(bodies)+' EMC '
    if bad_prefix:content=content.replace(f'({prefix}) Tj','(x) Tj')
    stream=DecodedStreamObject();stream.set_data(content.encode('ascii'));page[NameObject('/Contents')]=writer._add_object(stream)
    annotations=[]
    for index,y in enumerate((120,106)):
        action_uri=target+'bad' if changed_action and index==1 else target
        ann=DictionaryObject({NameObject('/Type'):NameObject('/Annot'),NameObject('/Subtype'):NameObject('/Link'),NameObject('/Rect'):ArrayObject([NumberObject(v) for v in (20,y,180,y+10)]),NameObject('/Border'):ArrayObject([NumberObject(0)]*3),NameObject('/StructParent'):NumberObject(index+1),NameObject('/A'):DictionaryObject({NameObject('/S'):NameObject('/URI'),NameObject('/URI'):TextStringObject(action_uri)})})
        annotations.append(writer._add_object(ann))
    page[NameObject('/Annots')]=ArrayObject(annotations)
    links=[]
    for index in range(2 if fragmented else 1):
        link=DictionaryObject({NameObject('/Type'):NameObject('/StructElem'),NameObject('/S'):NameObject('/Link'),NameObject('/P'):parent_ref,NameObject('/Pg'):page.indirect_reference})
        if source_alt is not None:link[NameObject('/Alt')]=TextStringObject(source_alt)
        elif fragmented:link[NameObject('/Alt')]=TextStringObject(target)
        ref=writer._add_object(link);links.append(ref)
        chosen=annotations[index:index+1] if fragmented else annotations
        objrs=[DictionaryObject({NameObject('/Type'):NameObject('/OBJR'),NameObject('/Pg'):page.indirect_reference,NameObject('/Obj'):ann}) for ann in chosen]
        link[NameObject('/K')]=ArrayObject([*objrs,NumberObject(index+1 if fragmented else 0)])
    parent[NameObject('/K')]=ArrayObject([NumberObject(3),NumberObject(0),links[0],*([NumberObject(3)] if intervening else []),links[1]]) if fragmented else ArrayObject([NumberObject(3),links[0]])
    document[NameObject('/K')]=ArrayObject([parent_ref]);root[NameObject('/K')]=ArrayObject([doc_ref])
    owners=ArrayObject([parent_ref,links[0],links[1],parent_ref]) if fragmented else ArrayObject([links[0],NullObject(),NullObject(),parent_ref])
    root[NameObject('/ParentTree')]=writer._add_object(DictionaryObject({NameObject('/Nums'):ArrayObject([NumberObject(0),owners,NumberObject(1),links[0],NumberObject(2),links[-1]])}))
    page[NameObject('/StructParents')]=NumberObject(0)
    writer.root_object[NameObject('/StructTreeRoot')]=root_ref
    writer.root_object[NameObject('/MarkInfo')]=DictionaryObject({NameObject('/Marked'):BooleanObject(True)})
    writer.root_object[NameObject('/Lang')]=TextStringObject('en-US')
    buffer=io.BytesIO();writer.write(buffer);return buffer.getvalue()


class LinkGroupingTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='native-link-groups-');self.root=Path(self.temp.name)
    def tearDown(self):self.temp.cleanup()
    def run_repair(self,source=None,candidate=None):
        self.source=self.root/'source.pdf';self.candidate=self.root/'candidate.pdf';self.output=self.root/'grouped.pdf'
        self.source.write_bytes(source or fixture());self.candidate.write_bytes(candidate or fixture(fragmented=True))
        return restore_source_uri_groups(self.source,self.candidate,self.output)
    def test_wrapped_address_and_stray_initial_character_rejoin_one_source_link(self):
        result=self.run_repair()
        self.assertEqual(len(result['changes']),1);self.assertEqual(result['unresolved'],[])
        inventory=structure_inventory(PdfReader(self.output));links=[t for t in inventory['tags'] if t['role']=='Link']
        self.assertEqual(len(links),1);self.assertEqual(compact(links[0]['text']),'https://example.org/a')
        self.assertEqual(links[0]['objectReferences'],2);self.assertTrue(inventory['checks_complete'])
        self.assertTrue(compare_pdfs(self.source,self.output)['preservation']['passed'])
        self.assertEqual(PdfReader(self.candidate).pages[0].get_contents().get_data(),PdfReader(self.output).pages[0].get_contents().get_data())
    def test_email_prefix_uses_exact_source_paint_membership(self):
        result=self.run_repair(fixture(target='mailto:someone@example.org'),fixture(fragmented=True,target='mailto:someone@example.org'))
        self.assertEqual(len(result['changes']),1)
        tag=next(t for t in structure_inventory(PdfReader(self.output))['tags'] if t['role']=='Link')
        self.assertEqual(compact(tag['text']),'someone@example.org')
    def test_authored_alternative_with_special_characters_is_retained_verbatim(self):
        alt='Study A & B <2026> "download"'
        result=self.run_repair(fixture(source_alt=alt),fixture(fragmented=True,source_alt=alt))
        self.assertEqual(len(result['changes']),1)
        self.assertEqual(next(t for t in structure_inventory(PdfReader(self.output))['tags'] if t['role']=='Link')['alt'],alt)
    def test_changed_destination_is_rejected(self):
        with self.assertRaisesRegex(ValueError,'annotation_behavior_changed'):self.run_repair(candidate=fixture(fragmented=True,changed_action=True))
        self.assertFalse(self.output.exists())
    def test_same_text_in_wrong_paint_location_cannot_replace_source_prefix(self):
        with self.assertRaisesRegex(ValueError,'source_page_content_changed'):self.run_repair(candidate=fixture(fragmented=True,bad_prefix=True))
    def test_intervening_parent_content_is_not_silently_moved(self):
        result=self.run_repair(candidate=fixture(fragmented=True,intervening=True))
        self.assertEqual(result['changes'],[])
        self.assertIn('intervening_content_requires_review',[r['code'] for r in result['unresolved']])
    def test_already_complete_source_link_does_not_create_duplicate_group(self):
        result=self.run_repair(candidate=fixture())
        self.assertEqual(result['changes'],[]);self.assertEqual(result['unresolved'],[])
    def test_unchanged_annotation_parent_tree_owner_remains_indirect(self):
        def add_unrelated(data):
            writer=PdfWriter(clone_from=PdfReader(io.BytesIO(data)));page=writer.pages[0]
            root=writer.root_object['/StructTreeRoot'];parent=root['/K'][0].get_object()['/K'][0].get_object()
            ann=DictionaryObject({NameObject('/Type'):NameObject('/Annot'),NameObject('/Subtype'):NameObject('/Link'),NameObject('/Rect'):ArrayObject([NumberObject(n) for n in (20,20,90,30)]),NameObject('/StructParent'):NumberObject(3),NameObject('/A'):DictionaryObject({NameObject('/S'):NameObject('/URI'),NameObject('/URI'):TextStringObject('https://example.org/other')})})
            ann_ref=writer._add_object(ann);page['/Annots'].append(ann_ref)
            link=DictionaryObject({NameObject('/Type'):NameObject('/StructElem'),NameObject('/S'):NameObject('/Link'),NameObject('/P'):parent.indirect_reference,NameObject('/Pg'):page.indirect_reference,NameObject('/K'):ArrayObject([NumberObject(4),DictionaryObject({NameObject('/Type'):NameObject('/OBJR'),NameObject('/Obj'):ann_ref,NameObject('/Pg'):page.indirect_reference})])})
            link_ref=writer._add_object(link);parent['/K'].append(link_ref)
            nums=root['/ParentTree']['/Nums'];nums[1].append(link_ref);nums.extend([NumberObject(3),link_ref])
            stream=DecodedStreamObject();stream.set_data(page.get_contents().get_data()+b' /Link << /MCID 4 >> BDC BT /F1 10 Tf 20 20 Td (Other page) Tj ET EMC');page[NameObject('/Contents')]=writer._add_object(stream)
            out=io.BytesIO();writer.write(out);return out.getvalue()
        result=self.run_repair(add_unrelated(fixture()),add_unrelated(fixture(fragmented=True)))
        self.assertEqual(len(result['changes']),1)
        inventory=structure_inventory(PdfReader(self.output));self.assertEqual(inventory['unresolved_content_references'],0)
        self.assertTrue(inventory['checks_complete'])
    def test_source_proven_goto_title_rejoins_without_changing_destination(self):
        def local_title(data,fragmented=False):
            writer=PdfWriter(clone_from=PdfReader(io.BytesIO(data)));page=writer.pages[0]
            for ann in page['/Annots']:
                ann.get_object()[NameObject('/A')]=DictionaryObject({NameObject('/S'):NameObject('/GoTo'),NameObject('/D'):TextStringObject('missing-toc-entry')})
            root=writer.root_object['/StructTreeRoot'];parent=root['/K'][0].get_object()['/K'][0].get_object()
            if fragmented:
                # Both complete-source Link spans must already belong to the
                # fragmented native Links; no arbitrary adjacent title added.
                first=parent['/K'][2].get_object();first['/K'].append(NumberObject(0))
                parent[NameObject('/K')]=ArrayObject([parent['/K'][0],parent['/K'][2],parent['/K'][3]])
                root['/ParentTree']['/Nums'][1][0]=first.indirect_reference
                for child in parent['/K'][1:]:child.get_object().pop('/Alt',None)
                # First glyph goes before the rest of this native Link.
                first[NameObject('/K')]=ArrayObject([NumberObject(0),*first['/K'][:-1]])
            out=io.BytesIO();writer.write(out);return out.getvalue()
        result=self.run_repair(local_title(fixture()),local_title(fixture(fragmented=True),True))
        self.assertEqual(len(result['changes']),1);self.assertEqual(result['changes'][0]['kind'],'sourceTitle')
        self.assertTrue(compare_pdfs(self.source,self.output)['preservation']['passed'])
        inventory=structure_inventory(PdfReader(self.output));self.assertEqual(inventory['unresolved_content_references'],0)
        self.assertEqual(inventory['unresolved_local_destinations'],2)


if __name__=='__main__':unittest.main()
