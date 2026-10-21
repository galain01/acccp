"""Synthetic temp-file tests of authored raster/vector Figure restoration."""
from __future__ import annotations

import io
from pathlib import Path
import tempfile
import unittest

from pypdf import PdfReader, PdfWriter
from pypdf.generic import (ArrayObject, BooleanObject, DecodedStreamObject,
    DictionaryObject, NameObject, NullObject, NumberObject, TextStringObject)

import preserve_figures as repair
import verify_pdf as verify


def fixture(*, candidate=False, changed_paint=False, changed_image=False,
            actual_text=True, form=False, repeated_image=False, merged_boundary=False,
            placed_metadata=False):
    writer = PdfWriter()
    page = writer.add_blank_page(width=250, height=180)
    font = writer._add_object(DictionaryObject({NameObject('/Type'):NameObject('/Font'),
        NameObject('/Subtype'):NameObject('/Type1'), NameObject('/BaseFont'):NameObject('/Helvetica')}))
    image = DecodedStreamObject()
    image.update({NameObject('/Type'):NameObject('/XObject'), NameObject('/Subtype'):NameObject('/Image'),
        NameObject('/Width'):NumberObject(1), NameObject('/Height'):NumberObject(1),
        NameObject('/ColorSpace'):NameObject('/DeviceRGB'), NameObject('/BitsPerComponent'):NumberObject(8)})
    image.set_data(b'\xff\x00\x00' if not changed_image else b'\x00\xff\x00')
    if form:
        image = DecodedStreamObject()
        image.update({NameObject('/Type'):NameObject('/XObject'), NameObject('/Subtype'):NameObject('/Form'),
            NameObject('/BBox'):ArrayObject([NumberObject(x) for x in (0,0,1,1)]),
            NameObject('/Resources'):DictionaryObject()})
        image.set_data(b'1 0 0 rg 0 0 1 1 re f')
    page[NameObject('/Resources')] = DictionaryObject({NameObject('/Font'):DictionaryObject({NameObject('/F1'):font}),
        NameObject('/XObject'):DictionaryObject({NameObject('/Im1'):writer._add_object(image)})})
    if placed_metadata:
        metadata=DecodedStreamObject();metadata.set_data(b'<metadata>Authored placed graphic metadata</metadata>')
        metadata[NameObject('/Type')]=NameObject('/Metadata');metadata[NameObject('/Subtype')]=NameObject('/XML')
        page['/Resources'][NameObject('/Properties')]=DictionaryObject({NameObject('/PlacedSource'):DictionaryObject({NameObject('/Metadata'):writer._add_object(metadata)})})
    root = DictionaryObject({NameObject('/Type'):NameObject('/StructTreeRoot')})
    root_ref = writer._add_object(root)
    document = DictionaryObject({NameObject('/Type'):NameObject('/StructElem'), NameObject('/S'):NameObject('/Document'), NameObject('/P'):root_ref})
    doc_ref = writer._add_object(document)
    elements=[]
    def element(role, mcid, alt=None, actual=None):
        elem = DictionaryObject({NameObject('/Type'):NameObject('/StructElem'), NameObject('/S'):NameObject(role),
            NameObject('/P'):doc_ref, NameObject('/Pg'):page.indirect_reference, NameObject('/K'):NumberObject(mcid)})
        if alt is not None: elem[NameObject('/Alt')]=TextStringObject(alt)
        if actual is not None: elem[NameObject('/ActualText')]=TextStringObject(actual)
        ref=writer._add_object(elem); elements.append(ref); return ref
    before=element('/P',0)
    raster=element('/Figure',1,'image 1' if candidate else 'Authored raster: red square, café ≥ 1.')
    vector=None if candidate else element('/Figure',2,'Authored vector: two bars.', 'Exact vector alternative.' if actual_text else None)
    after=element('/P',3)
    start='/P << /MCID 0 >> BDC BT /F1 12 Tf 20 150 Td (Before) Tj ET EMC '
    raster_ops='/Figure << /MCID 1 >> BDC q 20 0 0 20 20 100 cm /Im1 Do Q EMC '
    vector_ops=('0 0 1 rg 80 100 10 '+('30' if changed_paint else '20')+' re f 100 100 10 40 re f BT /F1 12 Tf 80 80 Td '+ ('(a) Tj (b) Tj (c) Tj' if candidate else '(abc) Tj')+' ET ')
    if placed_metadata and not candidate:
        vector_ops='/PlacedPDF /PlacedSource BDC '+vector_ops+' EMC '
    vector_ops=('/Artifact BMC ' if candidate else '/Figure << /MCID 2 >> BDC ')+vector_ops+'EMC '
    end='/P << /MCID 3 >> BDC BT /F1 12 Tf 20 30 Td (After) Tj ET EMC'
    if repeated_image:
        # Same image resource, two distinct occurrence positions/descriptions.
        vector_ops=('/Artifact BMC ' if candidate else '/Figure << /MCID 2 >> BDC ')+'q 20 0 0 20 100 100 cm /Im1 Do Q EMC '
    if merged_boundary:
        # Source splits the visible string across a Figure boundary; candidate
        # combines it into one Tj. Writer must reject instead of reallocating it.
        start='/P << /MCID 0 >> BDC BT /F1 12 Tf 20 150 Td (Be) Tj EMC '
        raster_ops='/Figure << /MCID 1 >> BDC (fore) Tj EMC ET '
        if candidate:
            start='/P << /MCID 0 >> BDC BT /F1 12 Tf 20 150 Td (Before) Tj ET EMC '
            raster_ops=''
    stream=DecodedStreamObject(); stream.set_data((start+raster_ops+vector_ops+end).encode('ascii'))
    page[NameObject('/Contents')]=writer._add_object(stream)
    page[NameObject('/StructParents')]=NumberObject(0)
    document[NameObject('/K')]=ArrayObject(elements)
    root[NameObject('/K')]=ArrayObject([doc_ref])
    root[NameObject('/ParentTree')]=writer._add_object(DictionaryObject({NameObject('/Nums'):ArrayObject([NumberObject(0),ArrayObject([before,raster,vector if vector else before,after])])}))
    writer.root_object[NameObject('/StructTreeRoot')]=root_ref
    writer.root_object[NameObject('/MarkInfo')]=DictionaryObject({NameObject('/Marked'):BooleanObject(True)})
    writer.root_object[NameObject('/Lang')]=TextStringObject('en-US')
    data=io.BytesIO();writer.write(data);return data.getvalue()


class FigurePreservation(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.folder=Path(self.temp.name)
        self.source=self.folder/'source.pdf';self.candidate=self.folder/'candidate.pdf';self.output=self.folder/'output.pdf'

    def prepare(self, source=None, candidate=None):
        self.source.write_bytes(source or fixture())
        self.candidate.write_bytes(candidate or fixture(candidate=True))

    def run_repair(self):
        return repair.preserve_figures(self.source,self.candidate,self.output)

    def test_exact_descriptions_raster_vector_membership_and_pixels(self):
        self.prepare(); before=self.source.read_bytes(); candidate=self.candidate.read_bytes()
        result=self.run_repair()
        self.assertEqual(result['figuresRestored'],2)
        self.assertEqual(self.source.read_bytes(),before);self.assertEqual(self.candidate.read_bytes(),candidate)
        source,output=PdfReader(self.source),PdfReader(self.output)
        associations=verify.compare_figure_associations(source,output)
        self.assertTrue(associations['passed'],associations)
        self.assertEqual(verify.rendered_page_hashes(self.source),verify.rendered_page_hashes(self.output))
        self.assertEqual(verify.structure_inventory(output)['findings'],[])
        self.assertNotIn(b'pdfuaid',self.output.read_bytes())

    def test_repeated_image_payload_keeps_distinct_paint_occurrences(self):
        self.prepare(fixture(repeated_image=True),fixture(candidate=True,repeated_image=True))
        self.run_repair()
        associations=verify.compare_figure_associations(PdfReader(self.source),PdfReader(self.output))
        self.assertTrue(associations['passed'],associations)

    def test_actual_text_without_alt_is_retained_exactly(self):
        self.prepare()
        writer=PdfWriter(clone_from=self.source)
        figures=repair.structure(writer)[2]
        for index, figure in enumerate(figures):
            del figure['element']['/Alt']
            figure['element'][NameObject('/ActualText')]=TextStringObject('Authored replacement '+str(index)+' ≥ café')
        writer.write(self.source)
        self.run_repair()
        associations=verify.compare_figure_associations(PdfReader(self.source),PdfReader(self.output))
        self.assertTrue(associations['passed'],associations)
        for figure in repair.structure(PdfReader(self.output))[2]:
            self.assertNotIn('/Alt',figure['element'])

    def test_inherited_description_language_is_preserved(self):
        self.prepare();writer=PdfWriter(clone_from=self.source)
        document=writer.root_object['/StructTreeRoot']['/K'][0].get_object()
        document[NameObject('/Lang')]=TextStringObject('fr-FR');writer.write(self.source)
        self.run_repair()
        reader=PdfReader(self.output)
        for figure in repair.structure(reader)[2]:
            self.assertEqual(repair.effective_language(figure['element'],reader.trailer['/Root']),'fr-FR')

    def test_nonstandard_candidate_marked_properties_rejected(self):
        self.prepare()
        writer=PdfWriter(clone_from=self.candidate)
        content=writer.pages[0].get_contents()
        for args,operator in content.operations:
            if operator==b'BDC':
                args[1][NameObject('/ActualText')]=TextStringObject('Keep this replacement')
                break
        content.operations=content.operations
        writer.pages[0][NameObject('/Contents')]=writer._add_object(content)
        writer.write(self.candidate)
        with self.assertRaisesRegex(ValueError,'candidate_marked_properties_unsupported'):self.run_repair()
        self.assertFalse(self.output.exists())

    def test_preexisting_empty_tag_is_not_pruned(self):
        self.prepare();writer=PdfWriter(clone_from=self.candidate)
        document=writer.root_object['/StructTreeRoot']['/K'][0].get_object()
        empty=DictionaryObject({NameObject('/Type'):NameObject('/StructElem'),NameObject('/S'):NameObject('/P'),
            NameObject('/P'):document.indirect_reference,NameObject('/K'):ArrayObject(),NameObject('/ActualText'):TextStringObject('Retain me')})
        document['/K'].append(writer._add_object(empty));writer.write(self.candidate)
        self.run_repair()
        self.assertTrue(any(e.get('/ActualText')=='Retain me' for e in repair.structure(PdfReader(self.output))[3]))

    def test_invalid_explicit_page_reference_is_not_inherited(self):
        self.prepare();writer=PdfWriter(clone_from=self.source)
        figure=repair.structure(writer)[2][0]['element']
        figure[NameObject('/Pg')]=writer._add_object(DictionaryObject({NameObject('/Type'):NameObject('/Page')}))
        writer.write(self.source)
        with self.assertRaisesRegex(ValueError,'invalid_explicit_page_reference'):self.run_repair()

    def test_custom_attribute_references_are_rejected(self):
        self.prepare();writer=PdfWriter(clone_from=self.source)
        figure=repair.structure(writer)[2][0]['element']
        figure[NameObject('/A')]=DictionaryObject({NameObject('/O'):NameObject('/Custom'),NameObject('/Headers'):ArrayObject([TextStringObject('other-id')])})
        writer.write(self.source)
        with self.assertRaisesRegex(ValueError,'figure_attributes_unsupported'):self.run_repair()

    def test_figure_child_semantics_are_not_silently_flattened(self):
        self.prepare();writer=PdfWriter(clone_from=self.source)
        figure=repair.structure(writer)[2][0]['element']
        child=DictionaryObject({NameObject('/Type'):NameObject('/StructElem'),NameObject('/S'):NameObject('/Span'),
            NameObject('/P'):figure.indirect_reference,NameObject('/K'):figure['/K'],NameObject('/ActualText'):TextStringObject('Authored child meaning')})
        figure[NameObject('/K')]=writer._add_object(child);writer.write(self.source)
        with self.assertRaisesRegex(ValueError,'figure_semantic_descendants_unsupported'):self.run_repair()

    def test_inline_actual_text_inside_figure_is_not_silently_removed(self):
        self.prepare();writer=PdfWriter(clone_from=self.source)
        stream=writer.pages[0].get_contents();ops=stream.operations
        for args,operator in ops:
            if operator==b'BDC' and args[0]=='/Figure':
                args[1][NameObject('/ActualText')]=TextStringObject('Scoped author meaning')
                break
        stream.operations=ops;writer.pages[0][NameObject('/Contents')]=writer._add_object(stream)
        writer.write(self.source)
        with self.assertRaisesRegex(ValueError,'source_figure_scoped_properties_unsupported'):self.run_repair()

    def test_placed_graphic_metadata_scope_is_restored_exactly(self):
        self.prepare(fixture(placed_metadata=True),fixture(candidate=True,placed_metadata=True))
        self.run_repair();source=PdfReader(self.source);output=PdfReader(self.output)
        self.assertTrue(verify.compare_figure_associations(source,output)['passed'])
        self.assertEqual(verify.rendered_page_hashes(self.source),verify.rendered_page_hashes(self.output))
        selected=[args for args,op in output.pages[0].get_contents().operations if op==b'BDC' and args[0]=='/PlacedPDF']
        self.assertEqual(len(selected),1)
        source_metadata=source.pages[0]['/Resources']['/Properties']['/PlacedSource']['/Metadata'].get_data()
        self.assertEqual(repair.props(output.pages[0],selected[0][1])['/Metadata'].get_data(),source_metadata)

    def test_figure_order_uses_untouched_intervening_pages(self):
        def add_pages(data,candidate):
            writer=PdfWriter(clone_from=PdfReader(io.BytesIO(data)))
            root=writer.root_object['/StructTreeRoot'];document=root['/K'][0].get_object()
            document[NameObject('/K')]=ArrayObject([ref for ref in document['/K'] if ref.get_object().get('/K')!=3])
            root['/ParentTree']['/Nums'][1][3]=NullObject()
            stream=writer.pages[0].get_contents();operations=stream.operations
            for index,(args,op) in enumerate(operations):
                if op==b'BDC' and args[1].get('/MCID')==3:operations[index]=([NameObject('/Artifact')],b'BMC')
            stream.operations=operations;writer.pages[0][NameObject('/Contents')]=writer._add_object(stream)
            for index in (1,2):
                page=writer.add_blank_page(width=250,height=180)
                page[NameObject('/Resources')]=writer.pages[0]['/Resources']
                page[NameObject('/StructParents')]=NumberObject(index)
                page_refs=[]
                for mcid,role in ([(0,'/P')] if index==1 else [(0,'/P'),(1,'/Figure'),(2,'/P')]):
                    tag=DictionaryObject({NameObject('/Type'):NameObject('/StructElem'),NameObject('/S'):NameObject(role),
                        NameObject('/P'):document.indirect_reference,NameObject('/Pg'):page.indirect_reference,NameObject('/K'):NumberObject(mcid)})
                    if role=='/Figure':tag[NameObject('/Alt')]=TextStringObject('image 3' if candidate else 'Authored last-page square')
                    ref=writer._add_object(tag);page_refs.append(ref);document['/K'].append(ref)
                raw=b'/P << /MCID 0 >> BDC BT /F1 12 Tf 20 150 Td (Untouched intervening page) Tj ET EMC'
                if index==2:raw+=b' /Figure << /MCID 1 >> BDC q 20 0 0 20 20 100 cm /Im1 Do Q EMC /P << /MCID 2 >> BDC BT /F1 12 Tf 20 30 Td (Last page text) Tj ET EMC'
                content=DecodedStreamObject();content.set_data(raw);page[NameObject('/Contents')]=writer._add_object(content)
                root['/ParentTree']['/Nums'].extend([NumberObject(index),ArrayObject(page_refs)])
            data=io.BytesIO();writer.write(data);return data.getvalue()
        self.prepare(add_pages(fixture(),False),add_pages(fixture(candidate=True),True));self.run_repair()
        reader=PdfReader(self.output);document=reader.trailer['/Root']['/StructTreeRoot']['/K'][0].get_object()
        page_map={repair.refkey(page):i+1 for i,page in enumerate(reader.pages)}
        ordered=[(page_map.get(repair.refkey(ref.get_object().get('/Pg'))),ref.get_object().get('/S'),ref.get_object().get('/Alt')) for ref in document['/K']]
        next_page=next(i for i,item in enumerate(ordered) if item[0]==2)
        first_page_figures=[i for i,item in enumerate(ordered) if item[0]==1 and item[1]=='/Figure']
        self.assertEqual(len(first_page_figures),2)
        self.assertTrue(all(i<next_page for i in first_page_figures),ordered)
        self.assertIn('raster',ordered[first_page_figures[0]][2]);self.assertIn('vector',ordered[first_page_figures[1]][2])

    def test_changed_vector_paint_rejected_without_output(self):
        self.prepare(candidate=fixture(candidate=True,changed_paint=True))
        with self.assertRaisesRegex(ValueError,'painting_program_changed'):self.run_repair()
        self.assertFalse(self.output.exists())

    def test_changed_raster_payload_rejected_without_output(self):
        self.prepare(candidate=fixture(candidate=True,changed_image=True))
        with self.assertRaisesRegex(ValueError,'page_resources_changed'):self.run_repair()
        self.assertFalse(self.output.exists())

    def test_form_invocation_rejected_instead_of_guessed(self):
        self.prepare(fixture(form=True),fixture(candidate=True,form=True))
        with self.assertRaisesRegex(ValueError,'figure_form_invocation_unsupported'):self.run_repair()
        self.assertFalse(self.output.exists())

    def test_candidate_text_show_crossing_figure_boundary_rejected(self):
        self.prepare(fixture(merged_boundary=True),fixture(candidate=True,merged_boundary=True))
        with self.assertRaisesRegex(ValueError,'figure_boundary_inside_candidate_operation'):self.run_repair()
        self.assertFalse(self.output.exists())

    def test_existing_output_and_source_path_rejected(self):
        self.prepare();self.output.write_bytes(b'keep')
        with self.assertRaisesRegex(ValueError,'new_output_required'):self.run_repair()
        with self.assertRaisesRegex(ValueError,'new_output_required'):repair.preserve_figures(self.source,self.candidate,self.source)
        self.assertEqual(self.output.read_bytes(),b'keep')

    def test_encrypted_candidate_rejected(self):
        self.prepare(); writer=PdfWriter(clone_from=self.candidate);writer.encrypt('secret');writer.write(self.candidate)
        with self.assertRaisesRegex(ValueError,'unsupported_input'):self.run_repair()

    def test_signed_source_rejected(self):
        self.prepare(); writer=PdfWriter(clone_from=self.source)
        writer.root_object[NameObject('/Perms')]=DictionaryObject()
        writer.write(self.source)
        with self.assertRaisesRegex(ValueError,'signed_pdf_not_supported'):self.run_repair()


if __name__=='__main__':unittest.main()
