"""Source-bound table recovery, preservation and adversarial replay tests."""
import io
import re
from pathlib import Path
import tempfile
import unittest

from pypdf import PdfReader, PdfWriter
from pypdf.generic import (ArrayObject, DecodedStreamObject, DictionaryObject,
    NameObject as N, NumberObject as I, TextStringObject, FloatObject as F)

import bounded_semantic_structure as b
import bounded_table_structure as t
import verify_pdf as v


def saved(writer):
    stream=io.BytesIO();writer.write(stream);return stream.getvalue()


def fixture(*, override=None, rotate=False, three_columns=False):
    writer=PdfWriter();page=writer.add_blank_page(320,240)
    fonts={}
    for name,face in (('/Regular','/Helvetica'),('/Bold','/Helvetica-Bold')):
        fonts[N(name)]=writer._add_object(DictionaryObject({N('/Type'):N('/Font'),N('/Subtype'):N('/Type1'),
            N('/BaseFont'):N(face),N('/Encoding'):N('/WinAnsiEncoding'),N('/FirstChar'):I(32),N('/LastChar'):I(126),
            N('/Widths'):ArrayObject([I(500)]*95)}))
    page[N('/Resources')]=DictionaryObject({N('/Font'):DictionaryObject(fonts)})
    root=DictionaryObject({N('/Type'):N('/StructTreeRoot')});root_ref=writer._add_object(root)
    document=DictionaryObject({N('/Type'):N('/StructElem'),N('/S'):N('/Document'),N('/P'):root_ref})
    doc_ref=writer._add_object(document);root[N('/K')]=doc_ref
    paragraphs=[];owners=[]
    for mcids in ([0],[1,2],[3,4]):
        node=DictionaryObject({N('/Type'):N('/StructElem'),N('/S'):N('/P'),N('/P'):doc_ref,
            N('/Pg'):page.indirect_reference,N('/K'):ArrayObject([I(m) for m in mcids])})
        ref=writer._add_object(node);paragraphs.append(ref);owners.extend(ref for _ in mcids)
    document[N('/K')]=ArrayObject(paragraphs)
    if override:document[N(override)]=TextStringObject('authored protected description')
    root[N('/ParentTree')]=writer._add_object(DictionaryObject({N('/Nums'):ArrayObject([I(0),ArrayObject(owners)])}))
    root[N('/ParentTreeNextKey')]=I(1);page[N('/StructParents')]=I(0)
    writer.root_object[N('/StructTreeRoot')]=root_ref;writer.root_object[N('/Lang')]=TextStringObject('en-US')
    def pair(label,value):
        gap=-(140-len(label)*5)*100
        return f'[({label}) {gap} ({value})'+(' -10000 (Extra)' if three_columns else '')+'] TJ'
    contents=(('0 1 -1 0 240 0 cm\n' if rotate else '')+f'''/P << /MCID 0 >> BDC
BT /Bold 10 Tf 1 0 0 1 40 180 Tm {pair('Measure','Value')}
1 0 0 1 40 164 Tm (Group A) Tj
/Regular 10 Tf 1 0 0 1 40 148 Tm (Subgroup A) Tj ET EMC
/P << /MCID 1 >> BDC BT /Regular 10 Tf 1 0 0 1 40 132 Tm {pair('First','1')} ET EMC
/P << /MCID 2 >> BDC BT /Regular 10 Tf 1 0 0 1 40 116 Tm {pair('Second','2')} ET EMC
/P << /MCID 3 >> BDC BT /Regular 10 Tf 1 0 0 1 40 100 Tm {pair('Third','3')} ET EMC
/P << /MCID 4 >> BDC BT /Regular 10 Tf 1 0 0 1 40 80 Tm (Footnote kept) Tj ET EMC''').encode()
    stream=DecodedStreamObject();stream.set_data(contents);page[N('/Contents')]=writer._add_object(stream)
    return writer


def selected(candidate):
    return {'type':'repair_structure','tagId':candidate['tagId'],'candidateId':candidate['candidateId']}


def heading_before_table(writer):
    page=writer.pages[0];root=writer.root_object['/StructTreeRoot'];document=root['/K']
    heading=DictionaryObject({N('/Type'):N('/StructElem'),N('/S'):N('/P'),
        N('/P'):document.indirect_reference,N('/Pg'):page.indirect_reference,N('/K'):I(5)})
    ref=writer._add_object(heading);document['/K'].insert(0,ref)
    root['/ParentTree']['/Nums'][1].append(ref)
    stream=DecodedStreamObject()
    stream.set_data(b'''BT /P << /MCID 5 >> BDC
/Bold 10 Tf 1 0 0 1 20 220 Tm (Section title. ) Tj
/Regular 10 Tf (The original paragraph stays.) Tj EMC ET
'''+page.get_contents().get_data())
    page[N('/Contents')]=writer._add_object(stream)
    return writer


def table_background(writer, *, gradient=False, marked=False, foreign_text=False,
                     large=False, opacity=False, sampled=False):
    page=writer.pages[0]
    if sampled:
        function=DecodedStreamObject();function.set_data(bytes([230,229 if gradient else 230]))
        function.update({N('/FunctionType'):I(0),N('/Domain'):ArrayObject([I(0),I(1)]),
            N('/Range'):ArrayObject([I(0),I(1)]),N('/Size'):ArrayObject([I(2)]),N('/BitsPerSample'):I(8)})
    else:
        function=DictionaryObject({N('/FunctionType'):I(2),N('/Domain'):ArrayObject([I(0),I(1)]),
            N('/C0'):ArrayObject([F(.9)]),N('/C1'):ArrayObject([F(.8 if gradient else .9)]),N('/N'):I(1)})
    shade=DictionaryObject({N('/ShadingType'):I(2),N('/ColorSpace'):N('/DeviceGray'),
        N('/Coords'):ArrayObject([I(36),I(194),I(36),I(96)]),N('/Function'):writer._add_object(function)})
    page['/Resources'][N('/Shading')]=DictionaryObject({N('/Fill'):writer._add_object(shade)})
    prefix=b'q\n'+(b'0 96 209 98 re' if large else b'36 96 173 98 re')+b' W n /Fill sh\nQ\n'
    if marked:prefix=b'/Artifact BMC\n'+prefix+b'EMC\n'
    if opacity:
        page['/Resources'][N('/ExtGState')]=DictionaryObject({N('/Alpha'):writer._add_object(DictionaryObject({N('/ca'):F(.5)}))})
        prefix=b'/Alpha gs\n'+prefix
    stream=DecodedStreamObject();content=prefix+page.get_contents().get_data()
    if foreign_text:content+=b'\nBT /Regular 10 Tf 1 0 0 1 100 110 Tm (Other content) Tj ET\n'
    stream.set_data(content);page[N('/Contents')]=writer._add_object(stream)
    return writer


class BoundedTableTests(unittest.TestCase):
    def source(self,**kwargs):return PdfReader(io.BytesIO(saved(fixture(**kwargs))))

    def repair(self,reader=None):
        reader=reader or self.source();candidate=t.discover_candidates(reader)[0]
        writer=PdfWriter(clone_from=reader);old=b.nodes(writer)
        result=t.apply_operations(reader,writer,[selected(candidate)])
        output=saved(writer);reopened=PdfReader(io.BytesIO(output))
        return reader,writer,old,result,reopened,output

    def test_candidate_derives_rows_and_headers_from_source_only(self):
        reader=self.source();candidates=t.discover_candidates(reader)
        self.assertEqual(len(candidates),1)
        candidate=candidates[0]
        self.assertEqual(candidate['kind'],'rebuild_table')
        self.assertEqual(candidate['tagId'],'tag-2')
        self.assertEqual(candidate['relatedTagIds'],['tag-3','tag-4'])
        self.assertIn('header: Measure | Value',candidate['preview'])
        self.assertIn('group: Group A\ngroup: Subgroup A',candidate['preview'])
        self.assertNotIn('Footnote',candidate['preview'])
        inspection=b._DiscoveryInspection(reader)
        self.assertEqual(t.discover_candidates(reader,_inspection=inspection),candidates)

    def test_saved_table_preserves_every_old_node_text_paint_and_pixels(self):
        source,writer,old,result,reopened,output=self.repair()
        self.assertTrue(t.verify_saved(reopened,result['verification']))
        current=b.nodes(writer)
        self.assertTrue(all(any(item is original for item in current) for original in old))
        self.assertEqual(len(result['lineage']),len(current))
        self.assertEqual(source.pages[0].extract_text(),reopened.pages[0].extract_text())
        self.assertEqual(v.drawing_fingerprint(v.operations(source.pages[0]),v.Canonicalizer(list(source.pages))),
                         v.drawing_fingerprint(v.operations(reopened.pages[0]),v.Canonicalizer(list(reopened.pages))))
        with tempfile.TemporaryDirectory() as directory:
            before,after=Path(directory)/'before.pdf',Path(directory)/'after.pdf'
            before.write_bytes(source.stream.getvalue());after.write_bytes(output)
            report=v.compare_pdfs(before,after)
        self.assertTrue(report['preservation']['passed'],report['findings'])
        self.assertTrue(report['preservation']['pages'][0]['pixels_identical'])
        self.assertEqual(report['findings'],[])

    def test_group_and_row_headers_are_explicit_and_footnote_stays_outside(self):
        _,_,_,result,reopened,_=self.repair();inventory=v.structure_inventory(reopened)
        tags={tag['id']:tag for tag in inventory['tags']}
        table=next(tag for tag in tags.values() if tag['role']=='Table')
        values=[tag for tag in tags.values() if tag['role']=='TD']
        self.assertEqual(len(values),3)
        for value in values:
            attrs=[attr for attr in value['attributes'] if attr['owner']=='Table'][0]
            self.assertEqual(len(attrs['headersHex']),4) # Value, Group A, Subgroup A, row label
        footnote=next(tag for tag in tags.values() if tag['text'].strip()=='Footnote kept')
        self.assertEqual(footnote['parentId'],table['parentId'])
        self.assertTrue(t.verify_saved(reopened,result['verification'],_inspection=b._DiscoveryInspection(reopened)))

    def test_model_cannot_supply_rows_roles_or_unbound_candidate(self):
        source=self.source();operation=selected(t.discover_candidates(source)[0])
        for invalid in ({**operation,'rows':[]},{**operation,'role':'TH'},{**operation,'candidateId':'0'*64}):
            with self.subTest(invalid=invalid),self.assertRaises(b.SemanticStructureError):
                t.apply_operations(source,PdfWriter(clone_from=source),[invalid])
        with self.assertRaises(b.SemanticStructureError):
            t.apply_operations(source,PdfWriter(clone_from=source),[operation,operation])
        other=PdfWriter(clone_from=source);other.add_metadata({'/Subject':'changed'})
        reader=PdfReader(io.BytesIO(saved(other)))
        with self.assertRaises(b.SemanticStructureError):
            t.apply_operations(reader,PdfWriter(clone_from=reader),[operation])

    def test_authored_overrides_rotated_and_three_column_layout_decline(self):
        for options in ({'override':'/ActualText'},{'override':'/Alt'},{'override':'/ID'},
                        {'rotate':True},{'three_columns':True}):
            with self.subTest(options=options):self.assertEqual(t.discover_candidates(self.source(**options)),[])

    def test_saved_header_scope_or_text_change_fails(self):
        _,_,_,result,reopened,_=self.repair()
        for change in ('scope','text','headers'):
            writer=PdfWriter(clone_from=reopened)
            if change=='scope':
                next(node for node in b.nodes(writer) if node['/S']=='/TH')['/A'][N('/Scope')]=N('/Row')
            elif change=='headers':
                next(node for node in b.nodes(writer) if node['/S']=='/TD')['/A'][N('/Headers')]=ArrayObject()
            else:
                page=writer.pages[0];stream=DecodedStreamObject()
                stream.set_data(page.get_contents().get_data().replace(b'4669727374',b'46616c7365'))
                page[N('/Contents')]=writer._add_object(stream)
            with self.subTest(change=change),self.assertRaises(b.SemanticStructureError):
                t.verify_saved(PdfReader(io.BytesIO(saved(writer))),result['verification'])

    def test_raw_proof_or_wrong_reader_inspection_cannot_authorize_saved_output(self):
        _,_,_,result,reopened,_=self.repair()
        with self.assertRaises(b.SemanticStructureError):t.verify_saved(reopened,{'tables':[]})
        with self.assertRaises(b.SemanticStructureError):
            t.verify_saved(reopened,result['verification'],_inspection=b._DiscoveryInspection(self.source()))

    def test_original_node_maps_survive_disjoint_preorder_insertions(self):
        source=self.source();candidate=t.discover_candidates(source)[0]
        source_nodes={f'tag-{i+1}':node for i,node in enumerate(b.nodes(source))}
        writer=PdfWriter(clone_from=source);target_nodes={f'tag-{i+1}':node for i,node in enumerate(b.nodes(writer))}
        parent=target_nodes['tag-1'];prefix=b._new_tag(writer,'Div',parent,writer.pages[0],ArrayObject())
        parent['/K'].insert(0,prefix.indirect_reference)
        result=t.apply_operations(source,writer,[selected(candidate)],_source_nodes=source_nodes,_target_nodes=target_nodes)
        reopened=PdfReader(io.BytesIO(saved(writer)))
        self.assertTrue(t.verify_saved(reopened,result['verification']))
        self.assertIs(parent['/K'][0].get_object(),prefix)

    def test_same_page_heading_split_can_precede_table_repair(self):
        source=PdfReader(io.BytesIO(saved(heading_before_table(fixture()))))
        candidate=t.discover_candidates(source)[0]
        heading=next(item for item in b.discover_candidates(source) if item['kind']=='split_heading')
        source_nodes={f'tag-{i+1}':node for i,node in enumerate(b.nodes(source))}
        writer=PdfWriter(clone_from=source);target_nodes={f'tag-{i+1}':node for i,node in enumerate(b.nodes(writer))}
        b.apply_operations(source,writer,[{**selected(heading),'role':'H2'}])
        result=t.apply_operations(source,writer,[selected(candidate)],
            _source_nodes=source_nodes,_target_nodes=target_nodes)
        output=saved(writer);reopened=PdfReader(io.BytesIO(output))
        self.assertTrue(t.verify_saved(reopened,result['verification']))
        self.assertTrue(any(tag['role']=='H2' and tag['text'].strip()=='Section title.'
                            for tag in v.structure_inventory(reopened)['tags']))
        with tempfile.TemporaryDirectory() as directory:
            before,after=Path(directory)/'before.pdf',Path(directory)/'after.pdf'
            before.write_bytes(source.stream.getvalue());after.write_bytes(output)
            report=v.compare_pdfs(before,after)
        self.assertTrue(report['preservation']['passed'],report['findings'])
        self.assertTrue(report['preservation']['pages'][0]['pixels_identical'])

    def test_changed_own_scope_is_rejected_after_unrelated_insertions(self):
        source=self.source();candidate=t.discover_candidates(source)[0]
        writer=PdfWriter(clone_from=source);page=writer.pages[0]
        stream=DecodedStreamObject()
        stream.set_data(page.get_contents().get_data().replace(
            b'/MCID 0 >> BDC',b'/MCID 0 >> BDC /Span BMC').replace(
            b'(Subgroup A) Tj ET EMC',b'(Subgroup A) Tj ET EMC EMC'))
        page[N('/Contents')]=writer._add_object(stream)
        with self.assertRaises(b.SemanticStructureError):
            t.apply_operations(source,writer,[selected(candidate)])

    def test_multiple_tables_on_one_page_keep_source_scope_identity(self):
        writer=fixture();page=writer.pages[0];page.mediabox.upper_right=(320,600)
        original=page.get_contents().get_data();root=writer.root_object['/StructTreeRoot'];document=root['/K']
        owners=root['/ParentTree']['/Nums'][1]
        for mcids in ([5],[6,7],[8,9]):
            node=DictionaryObject({N('/Type'):N('/StructElem'),N('/S'):N('/P'),
                N('/P'):document.indirect_reference,N('/Pg'):page.indirect_reference,
                N('/K'):ArrayObject([I(mcid) for mcid in mcids])})
            ref=writer._add_object(node);document['/K'].append(ref);owners.extend(ref for _ in mcids)
        stream=DecodedStreamObject()
        stream.set_data(b'q 1 0 0 1 0 300 cm\n'+original+b'\nQ\n'+
            re.sub(rb'/MCID (\d+)',lambda match:b'/MCID '+str(int(match[1])+5).encode(),original))
        page[N('/Contents')]=writer._add_object(stream)
        source=PdfReader(io.BytesIO(saved(writer)));candidates=t.discover_candidates(source)
        self.assertEqual(len(candidates),2)
        writer=PdfWriter(clone_from=source)
        result=t.apply_operations(source,writer,[selected(candidate) for candidate in candidates])
        reopened=PdfReader(io.BytesIO(saved(writer)))
        self.assertTrue(t.verify_saved(reopened,result['verification']))
        self.assertEqual(len([tag for tag in v.structure_inventory(reopened)['tags'] if tag['role']=='Table']),2)

    def test_saved_semantic_overrides_and_unapproved_metadata_are_rejected(self):
        _,_,_,result,reopened,_=self.repair()
        for role in ('Table','TR','TH','TD','P'):
            for key,value in (('/ActualText','This overrides table information.'),
                              ('/Alt','This substitutes another description.'),
                              ('/Lang','fr-FR'),('/E','Unexpected expansion')):
                writer=PdfWriter(clone_from=reopened)
                node=next(node for node in b.nodes(writer) if node['/S']=='/'+role)
                node[N(key)]=TextStringObject(value)
                with self.subTest(role=role,key=key),self.assertRaises(b.SemanticStructureError):
                    t.verify_saved(PdfReader(io.BytesIO(saved(writer))),result['verification'])
        writer=PdfWriter(clone_from=reopened)
        cell=next(node for node in b.nodes(writer) if node['/S']=='/TD')
        cell['/A'][N('/RowSpan')]=I(2)
        with self.assertRaises(b.SemanticStructureError):
            t.verify_saved(PdfReader(io.BytesIO(saved(writer))),result['verification'])
        writer=PdfWriter(clone_from=reopened)
        cell=next(node for node in b.nodes(writer) if node['/S']=='/TD')
        cell['/A'][N('/StructParents')]=I(7)
        with self.assertRaises(b.SemanticStructureError):
            t.verify_saved(PdfReader(io.BytesIO(saved(writer))),result['verification'])

    def test_identical_text_cannot_move_between_painted_cell_occurrences(self):
        writer=fixture();page=writer.pages[0];stream=DecodedStreamObject()
        stream.set_data(page.get_contents().get_data().replace(b'(2)',b'(1)').replace(b'(3)',b'(1)'))
        page[N('/Contents')]=writer._add_object(stream)
        source,writer,_,result,_,_=self.repair(PdfReader(io.BytesIO(saved(writer))))
        cells=[node for node in b.nodes(writer) if node['/S']=='/TD']
        first,second=[int(cell['/K'][0].get_object()['/K'][0]) for cell in cells[:2]]
        content=writer.pages[0].get_contents()
        for args,operator in content.operations:
            if operator==b'BDC':
                mcid=args[1].get('/MCID')
                if mcid==first:args[1][N('/MCID')]=I(second)
                elif mcid==second:args[1][N('/MCID')]=I(first)
        writer.pages[0][N('/Contents')]=writer._add_object(content)
        changed=PdfReader(io.BytesIO(saved(writer)))
        self.assertEqual(source.pages[0].extract_text(),changed.pages[0].extract_text())
        self.assertEqual(v.drawing_fingerprint(v.operations(source.pages[0]),v.Canonicalizer(list(source.pages))),
                         v.drawing_fingerprint(v.operations(changed.pages[0]),v.Canonicalizer(list(changed.pages))))
        with self.assertRaises(b.SemanticStructureError):t.verify_saved(changed,result['verification'])

    def test_authored_language_on_retained_and_split_leaves_is_preserved(self):
        writer=fixture()
        for node in b.nodes(writer):
            if node['/S']=='/P':node[N('/Lang')]=TextStringObject('en-GB')
        _,_,_,result,reopened,_=self.repair(PdfReader(io.BytesIO(saved(writer))))
        self.assertTrue(t.verify_saved(reopened,result['verification']))
        self.assertTrue(all(node.get('/Lang')=='en-GB' for node in b.nodes(reopened) if node['/S']=='/P'))

    def test_saved_native_parent_pointer_must_match_the_child_tree(self):
        _,_,_,result,reopened,_=self.repair()
        for role in ('Table','TR','TH','TD','P'):
            writer=PdfWriter(clone_from=reopened)
            node=next(node for node in b.nodes(writer) if node['/S']=='/'+role)
            node[N('/P')]=node.indirect_reference
            with self.subTest(role=role),self.assertRaises(b.SemanticStructureError):
                t.verify_saved(PdfReader(io.BytesIO(saved(writer))),result['verification'])

    def test_constant_table_background_gets_exact_artifact_scope(self):
        for sampled in (False,True):
            with self.subTest(sampled=sampled):
                reader=PdfReader(io.BytesIO(saved(table_background(fixture(),sampled=sampled))))
                self.assertIn('verified uniform table fill',t.discover_candidates(reader)[0]['preview'])
                source,_,_,result,reopened,output=self.repair(reader)
                self.assertEqual(len(result['verification'].tables[0]['backgrounds']),1)
                self.assertTrue(t.verify_saved(reopened,result['verification']))
                self.assertEqual(len(t._background_blocks(reopened.pages[0],v.operations(reopened.pages[0]),artifact=True)),1)
                with tempfile.TemporaryDirectory() as directory:
                    before,after=Path(directory)/'before.pdf',Path(directory)/'after.pdf'
                    before.write_bytes(source.stream.getvalue());after.write_bytes(output)
                    report=v.compare_pdfs(before,after)
                self.assertTrue(report['preservation']['passed'],report['findings'])
                self.assertTrue(report['preservation']['pages'][0]['pixels_identical'])

    def test_nonconstant_authored_oversized_or_ambiguous_backgrounds_are_not_reclassified(self):
        for options in ({'gradient':True},{'gradient':True,'sampled':True},{'marked':True},
                        {'foreign_text':True},{'large':True},{'opacity':True}):
            with self.subTest(options=options):
                source=PdfReader(io.BytesIO(saved(table_background(fixture(),**options))))
                candidates,_,_=t._discover(source)
                self.assertEqual(len(candidates),1)
                self.assertEqual(candidates[0][1]['backgrounds'],[])
                _,_,_,result,reopened,_=self.repair(source)
                self.assertEqual(result['verification'].tables[0]['backgrounds'],[])
                self.assertTrue(t.verify_saved(reopened,result['verification']))

    def test_saved_background_cannot_lose_its_verified_artifact_scope(self):
        _,_,_,result,reopened,_=self.repair(PdfReader(io.BytesIO(saved(table_background(fixture())))))
        for alteration in ('name','scope','resource'):
            writer=PdfWriter(clone_from=reopened);page=writer.pages[0];content=page.get_contents()
            if alteration=='name':
                next(args for args,op in content.operations if op==b'BMC')[0]=N('/Span')
            elif alteration=='scope':
                block=t._background_blocks(page,content.operations,artifact=True)[0]
                content.operations=[entry for i,entry in enumerate(content.operations) if i not in (block['start']-1,block['end']+1)]
            else:page['/Resources']['/Shading']['/Fill']['/Function'][N('/C1')]=ArrayObject([F(.8)])
            page[N('/Contents')]=writer._add_object(content)
            with self.subTest(alteration=alteration),self.assertRaises(b.SemanticStructureError):
                t.verify_saved(PdfReader(io.BytesIO(saved(writer))),result['verification'])

    def test_background_declines_inherited_paths_including_across_graphics_state(self):
        for prefix in (b'5 120 10 10 re\n',b'q 5 120 10 10 re Q\n'):
            with self.subTest(prefix=prefix):
                writer=table_background(fixture());page=writer.pages[0]
                stream=DecodedStreamObject();stream.set_data(prefix+page.get_contents().get_data())
                page[N('/Contents')]=writer._add_object(stream)
                source=PdfReader(io.BytesIO(saved(writer)))
                candidates,_,_=t._discover(source)
                self.assertEqual(len(candidates),1)
                self.assertEqual(candidates[0][1]['backgrounds'],[])
                _,_,_,result,reopened,_=self.repair(source)
                self.assertEqual(result['verification'].tables[0]['backgrounds'],[])
                self.assertTrue(t.verify_saved(reopened,result['verification']))

        writer=table_background(fixture());page=writer.pages[0]
        stream=DecodedStreamObject();stream.set_data(b'q 5 120 10 10 re Q n\n'+page.get_contents().get_data())
        page[N('/Contents')]=writer._add_object(stream)
        candidates,_,_=t._discover(PdfReader(io.BytesIO(saved(writer))))
        self.assertEqual(len(candidates[0][1]['backgrounds']),1)


if __name__=='__main__':unittest.main()
