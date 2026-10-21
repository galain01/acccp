import copy
import hashlib
from pathlib import Path
import tempfile
import unittest
from pypdf import PdfReader,PdfWriter
from pypdf.generic import ArrayObject,BooleanObject,DecodedStreamObject,DictionaryObject,NameObject,NumberObject,TextStringObject
from pagination_artifacts import mark_redundant_table_pagination
from structure_repairs import snapshot
from semantic_repairs import _tag_nodes
from verify_pdf import structure_inventory,compare_pdfs


def fixture(path):
    w=PdfWriter();pages=[w.add_blank_page(400,400) for _ in range(2)]
    root=DictionaryObject({NameObject('/Type'):NameObject('/StructTreeRoot')});rr=w._add_object(root)
    def node(role,parent,kids=None,page=None):
        n=DictionaryObject({NameObject('/Type'):NameObject('/StructElem'),NameObject('/S'):NameObject('/'+role),NameObject('/P'):parent})
        w._add_object(n)
        if kids is not None:n[NameObject('/K')]=ArrayObject(kids)
        if page is not None:n[NameObject('/Pg')]=pages[page].indirect_reference
        return n
    doc=node('Document',rr,[]);root[NameObject('/K')]=doc.indirect_reference
    cap=node('P',doc.indirect_reference,[NumberObject(0)],0)
    table=node('Table',doc.indirect_reference,[])
    data=[]
    for i in range(2):
        row=node('TR',table.indirect_reference,[]);cell=node('TD',row.indirect_reference,[NumberObject(1)],i)
        row['/K'].append(cell.indirect_reference);table['/K'].append(row.indirect_reference);data.append(cell)
    direction=node('P',doc.indirect_reference,[NumberObject(2)],0)
    repeat=node('P',doc.indirect_reference,[NumberObject(0)],1)
    doc['/K'].extend(n.indirect_reference for n in (cap,table,direction,repeat))
    footnote='Footnote: percentages are illustrative test data. Values describe each group in the table. This explanation must remain reachable after pagination cleanup.'
    texts=[['TABLE 1. Example data','25','See table footnotes on the next page.'],['TABLE 1. (Continued) Example data',footnote]]
    owners=[[cap,data[0],direction],[repeat,data[1]]];nums=ArrayObject()
    for i,p in enumerate(pages):
        f=DictionaryObject({NameObject('/Type'):NameObject('/Font'),NameObject('/Subtype'):NameObject('/Type1'),NameObject('/BaseFont'):NameObject('/Helvetica')})
        p[NameObject('/Resources')]=DictionaryObject({NameObject('/Font'):DictionaryObject({NameObject('/F1'):w._add_object(f)})})
        p[NameObject('/StructParents')]=NumberObject(i)
        stream=DecodedStreamObject();stream.set_data('\n'.join(f'/P <</MCID {j}>> BDC BT /F1 8 Tf 20 {350-j*30} Td ({text.replace("(",r"\(").replace(")",r"\)")}) Tj ET EMC' for j,text in enumerate(texts[i])).encode())
        p[NameObject('/Contents')]=w._add_object(stream)
        nums.extend([NumberObject(i),ArrayObject(n.indirect_reference for n in owners[i])])
    root[NameObject('/ParentTree')]=DictionaryObject({NameObject('/Nums'):nums})
    w.root_object[NameObject('/StructTreeRoot')]=rr;w.root_object[NameObject('/Lang')]=TextStringObject('en-US')
    w.root_object[NameObject('/MarkInfo')]=DictionaryObject({NameObject('/Marked'):BooleanObject(True)})
    with path.open('xb') as h:w.write(h)


class PaginationTests(unittest.TestCase):
    def setUp(self):
        tmp=tempfile.TemporaryDirectory();self.addCleanup(tmp.cleanup)
        self.source=Path(tmp.name)/'source.pdf';self.output=self.source.with_name('output.pdf');fixture(self.source)
        tags=structure_inventory(PdfReader(self.source))['tags'];caption=tags[1];table=tags[2]
        self.plan={'schemaVersion':1,'inputSha256':hashlib.sha256(self.source.read_bytes()).hexdigest(),'repairs':[]}
        for t in tags:
            if '(Continued)' in t['text']:kind='continued-caption'
            else:continue
            self.plan['repairs'].append({'tagId':t['id'],'expected':snapshot(t),'firstCaptionId':caption['id'],'firstCaptionExpected':snapshot(caption),'tableId':table['id'],'tableExpected':snapshot(table),'kind':kind})

    def run_plan(self):return mark_redundant_table_pagination(self.source,self.output,self.plan)

    def test_only_duplicate_pagination_is_excluded(self):
        source_bytes=self.source.read_bytes();self.run_plan()
        checks=compare_pdfs(self.source,self.output)
        self.assertTrue(checks['preservation']['passed'])
        text=' '.join(t['text'] for t in checks['structure']['tags'])
        self.assertIn('Footnote:',text);self.assertIn('TABLE 1. Example data',text)
        self.assertNotIn('Continued',text);self.assertIn('See table footnotes on the next page.',text)
        self.assertEqual(self.source.read_bytes(),source_bytes)
        self.assertEqual(len(checks['structure']['tags']),8)

    def test_unique_footnote_direction_cannot_be_artifacted(self):
        tags=structure_inventory(PdfReader(self.source))['tags']
        direction=next(t for t in tags if t['text'].strip().startswith('See table'))
        repair=self.plan['repairs'][0]
        self.plan['repairs']=[{**repair,'tagId':direction['id'],'expected':snapshot(direction),'kind':'next-page-footnotes'}]
        with self.assertRaisesRegex(ValueError,'unsupported_pagination_kind'):self.run_plan()
        self.assertFalse(self.output.exists())

    def test_stale_snapshot_and_hash_rejected(self):
        saved=copy.deepcopy(self.plan);self.plan['inputSha256']='0'*64
        with self.assertRaises(ValueError):self.run_plan()
        self.plan=saved;self.plan['repairs'][0]['expected']['text']='Real paragraph'
        with self.assertRaises(ValueError):self.run_plan()
        self.assertFalse(self.output.exists())

    def test_cannot_exclude_the_original_caption_or_table(self):
        for key in ('firstCaptionId','tableId'):
            plan=copy.deepcopy(self.plan);self.plan['repairs'][0]['tagId']=self.plan['repairs'][0][key]
            with self.assertRaises(ValueError):self.run_plan()
            self.assertFalse(self.output.exists());self.plan=plan

    def test_cannot_hide_unique_graphics_with_a_duplicate_caption(self):
        writer=PdfWriter(clone_from=self.source)
        stream=DecodedStreamObject();stream.set_data(writer.pages[1].get_contents().get_data().replace(b'Tj ET EMC',b'Tj ET 0 0 10 10 re S EMC',1))
        writer.pages[1][NameObject('/Contents')]=writer._add_object(stream)
        altered=self.source.with_name('graphic.pdf')
        with altered.open('xb') as handle:writer.write(handle)
        self.source=altered;self.plan['inputSha256']=hashlib.sha256(altered.read_bytes()).hexdigest()
        with self.assertRaisesRegex(ValueError,'text_only'):self.run_plan()
        self.assertFalse(self.output.exists())

    def test_semantic_references_prevent_removal(self):
        writer=PdfWriter(clone_from=self.source)
        _tag_nodes(writer)[-1][NameObject('/ID')]=TextStringObject('referenced-caption')
        altered=self.source.with_name('identified.pdf')
        with altered.open('xb') as handle:writer.write(handle)
        self.source=altered;self.plan['inputSha256']=hashlib.sha256(altered.read_bytes()).hexdigest()
        with self.assertRaisesRegex(ValueError,'unsupported_pagination_target'):self.run_plan()
        self.assertFalse(self.output.exists())

    def test_cross_page_paragraph_cannot_be_removed_as_pagination(self):
        writer=PdfWriter(clone_from=self.source);target=_tag_nodes(writer)[-1]
        target['/K'].append(DictionaryObject({NameObject('/Type'):NameObject('/MCR'),NameObject('/Pg'):writer.pages[0].indirect_reference,NameObject('/MCID'):NumberObject(2)}))
        writer.root_object['/StructTreeRoot']['/ParentTree']['/Nums'][1][2]=target.indirect_reference
        altered=self.source.with_name('cross-page.pdf')
        with altered.open('xb') as handle:writer.write(handle)
        self.source=altered;self.plan['inputSha256']=hashlib.sha256(altered.read_bytes()).hexdigest()
        final_tag=structure_inventory(PdfReader(altered))['tags'][-1]
        self.plan['repairs']=[self.plan['repairs'][-1]];self.plan['repairs'][0]['expected']=snapshot(final_tag)
        with self.assertRaisesRegex(ValueError,'unsupported_pagination_target'):self.run_plan()
        self.assertFalse(self.output.exists())


if __name__=='__main__':unittest.main()
