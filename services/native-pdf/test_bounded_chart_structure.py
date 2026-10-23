"""Source-bound chart membership, reopened output, and refusal regressions."""
import io
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'research/native-pdf'))
from pypdf import PdfReader, PdfWriter
from pypdf.generic import (ArrayObject, BooleanObject, DecodedStreamObject, DictionaryObject,
    NameObject as N, NumberObject as I, TextStringObject)
import bounded_chart_structure as c
import bounded_semantic_structure as semantic
import hybrid_form_verification as hybrid


ALT = 'A bar chart compares enrollment in cohorts A, B, and C. Cohort B has the tallest bar and cohort A has the shortest. The vertical axis counts students.'


def saved(writer):
    output = io.BytesIO(); writer.write(output)
    return output.getvalue()


def fixture():
    writer = PdfWriter(); page = writer.add_blank_page(width=400, height=600)
    font = writer._add_object(DictionaryObject({N('/Type'): N('/Font'), N('/Subtype'): N('/Type1'), N('/BaseFont'): N('/Helvetica')}))
    page[N('/Resources')] = DictionaryObject({N('/Font'): DictionaryObject({N('/F1'): font})})
    page[N('/StructParents')] = I(0)
    root = DictionaryObject({N('/Type'): N('/StructTreeRoot')}); root_ref = writer._add_object(root)
    doc = DictionaryObject({N('/Type'): N('/StructElem'), N('/S'): N('/Document'), N('/P'): root_ref})
    doc_ref = writer._add_object(doc); root[N('/K')] = doc_ref
    writer.root_object[N('/StructTreeRoot')] = root_ref
    writer.root_object[N('/Lang')] = TextStringObject('en-US')
    writer.root_object[N('/MarkInfo')] = DictionaryObject({N('/Marked'): BooleanObject(True)})
    parents, named, paint = [], {'document': doc}, []
    def node(name, role, parent, text=None, x=45, y=400):
        item = DictionaryObject({N('/Type'): N('/StructElem'), N('/S'): N('/'+role), N('/P'): parent.indirect_reference, N('/Pg'): page.indirect_reference})
        ref = writer._add_object(item); named[name] = item
        if text is not None:
            mcid = len(parents); parents.append(ref); item[N('/K')] = I(mcid)
            paint.append(f'/Content << /MCID {mcid} >> BDC BT /F1 10 Tf 1 0 0 1 {x} {y} Tm ({text}) Tj ET EMC')
        return item
    caption = node('caption', 'H2', doc, 'Figure 7. Enrollment by student cohort in 2025', 40, 550)
    top = node('top', 'P', doc, '100', 45, 500)
    ylabel = node('ylabel', 'P', doc, 'Students', 60, 480)
    middle = node('middle', 'P', doc, '50', 45, 450)
    low = node('low', 'P', doc, '0', 45, 400)
    listing = node('list', 'L', doc); li = node('li', 'LI', listing)
    minus = node('minus', 'Lbl', li, '-', 45, 425)
    negative = node('negative', 'LBody', li, '25', 50, 425)
    listing[N('/K')] = li.indirect_reference
    li[N('/K')] = ArrayObject([minus.indirect_reference, negative.indirect_reference])
    listing[N('/A')] = DictionaryObject({N('/O'): N('/List'), N('/ListNumbering'): N('/Disc')})
    categories = node('categories', 'P', doc, 'A   B   C', 80, 380)
    xlabel = node('xlabel', 'P', doc, 'Cohort', 100, 360)
    prose = node('prose', 'P', doc, 'This paragraph remains outside the chart. ' * 7, 40, 330)
    doc[N('/K')] = ArrayObject([item.indirect_reference for item in (caption, top, ylabel, middle, low, listing, categories, xlabel, prose)])
    root[N('/ParentTree')] = writer._add_object(DictionaryObject({N('/Nums'): ArrayObject([I(0), ArrayObject(parents)])}))
    root[N('/ParentTreeNextKey')] = I(1)
    for path in ('70 400 m 220 400 l S', '70 400 m 70 500 l S', '80 400 25 25 re f', '125 400 25 75 re f', '170 400 25 50 re f'):
        paint.append('q /Artifact BMC ' + path + ' EMC Q')
    stream = DecodedStreamObject(); stream.set_data(('\n'.join(paint)).encode('ascii'))
    page[N('/Contents')] = writer._add_object(stream)
    return writer, named


def selection(reader):
    return [{'type': 'repair_structure', 'tagId': item['tagId'], 'candidateId': item['candidateId'], 'alt': ALT}
            for item in c.discover_candidates(reader)]


class ChartTests(unittest.TestCase):
    def source(self):
        return PdfReader(io.BytesIO(saved(fixture()[0])))

    def repaired(self):
        source = self.source(); writer = PdfWriter(clone_from=source)
        operations = selection(source); self.assertEqual(len(operations), 1)
        result = c.apply_operations(source, writer, operations)
        output = PdfReader(io.BytesIO(saved(writer)))
        c.verify_saved(output, result['verification'])
        return source, output, result

    def test_chart_contains_real_vectors_and_original_labels_with_identical_pixels(self):
        source, output, result = self.repaired()
        self.assertEqual(source.pages[0].extract_text(), output.pages[0].extract_text())
        self.assertEqual(semantic.paint_fingerprint(c.v.operations(source.pages[0])), semantic.paint_fingerprint(c.v.operations(output.pages[0])))
        self.assertEqual(hybrid.form_pixels(source.stream.getvalue()), hybrid.form_pixels(output.stream.getvalue()))
        inventory = c.v.structure_inventory(output)
        figures = [tag for tag in inventory['tags'] if tag['role'] == 'Figure']
        self.assertEqual(len(figures), 1)
        self.assertEqual(figures[0]['alt'], ALT)
        captions = [tag for tag in inventory['tags'] if tag['role'] == 'Caption']
        self.assertEqual(len(captions), 1)
        self.assertEqual(captions[0]['parentId'], figures[0]['id'])
        self.assertEqual(captions[0]['text'].strip(), 'Figure 7. Enrollment by student cohort in 2025')
        self.assertEqual(len([entry for entry in figures[0]['contentSequence'] if entry['kind'] == 'markedContent']), 1)
        self.assertFalse([tag for tag in inventory['tags'] if tag['role'] in ('L', 'LI', 'Lbl', 'LBody')])
        self.assertEqual(len(result['lineage']), len(inventory['tags']))
        self.assertEqual(result['changes'][0]['code'], 'describe_chart')
        self.assertFalse([item for item in inventory['findings'] if item['severity'] == 'error'])

    def test_repair_is_not_rediscovered(self):
        _, output, _ = self.repaired()
        self.assertEqual(c.discover_candidates(output), [])

    def test_unknown_stale_and_overlapping_operations_rejected(self):
        source = self.source(); op = selection(source)[0]
        for ops in ([{**op, 'candidateId': '0'*64}], [op, op], [{**op, 'bounds': [1, 2, 3, 4]}], [{k: v for k, v in op.items() if k != 'alt'}], [{**op, 'alt': 'x'*8001}], [{**op, 'alt': 'x\x00' * 30}]):
            with self.subTest(ops=ops), self.assertRaises(c.ChartStructureError):
                c.apply_operations(source, PdfWriter(clone_from=source), ops)
        writer = PdfWriter(clone_from=source); writer.add_metadata({'/Subject': 'Other bytes'})
        other = PdfReader(io.BytesIO(saved(writer)))
        with self.assertRaises(c.ChartStructureError): c.apply_operations(other, PdfWriter(clone_from=other), [op])

    def test_authored_alternatives_links_and_ids_remain_untouched(self):
        for name in ('caption', 'top', 'list', 'document'):
            for key in ('/Alt', '/ActualText', '/ID', '/Ref', '/E'):
                with self.subTest(name=name, key=key):
                    writer, names = fixture(); names[name][N(key)] = TextStringObject('Authored information')
                    self.assertEqual(c.discover_candidates(PdfReader(io.BytesIO(saved(writer)))), [])
        writer, names = fixture(); names['top'][N('/S')] = N('/Link')
        self.assertEqual(c.discover_candidates(PdfReader(io.BytesIO(saved(writer)))), [])

    def test_private_inspection_and_proof_reject_external_inventory(self):
        source, output, result = self.repaired()
        with self.assertRaises(c.ChartStructureError): c.discover_candidates(source, _inspection={'tags': []})
        with self.assertRaises(semantic.SemanticStructureError): c.discover_candidates(output, _inspection=semantic._DiscoveryInspection(source))
        with self.assertRaises(c.ChartStructureError): c.verify_saved(output, {'_entries': []})
        c.verify_saved(output, result['verification'], _inspection=semantic._DiscoveryInspection(output))

    def test_saved_description_membership_caption_and_parent_tree_tampering_rejected(self):
        _, output, result = self.repaired()
        for mode in ('alt', 'actual', 'extra_child', 'order', 'caption', 'label', 'parent_tree', 'label_parent_tree', 'nested_parent', 'metadata', 'font', 'paint'):
            writer = PdfWriter(clone_from=output); native = c.nodes(writer)
            figure = next(node for node in native if node.get('/S') == '/Figure')
            caption = next(node for node in native if node.get('/S') == '/Caption')
            if mode == 'alt': figure[N('/Alt')] = TextStringObject('Wrong chart description')
            elif mode == 'actual': figure[N('/ActualText')] = TextStringObject('Hide original information')
            elif mode == 'extra_child': figure['/K'].append(I(99))
            elif mode == 'order': figure['/K'].reverse()
            elif mode == 'caption': caption[N('/S')] = N('/P')
            elif mode == 'label': c.v.resolved(figure['/K'][2])[N('/ActualText')] = TextStringObject('Wrong')
            elif mode == 'parent_tree':
                parents = c.v.number_tree(writer.root_object['/StructTreeRoot']['/ParentTree']); parents[0][int(figure['/K'][1])] = caption.indirect_reference
            elif mode == 'label_parent_tree':
                parents = c.v.number_tree(writer.root_object['/StructTreeRoot']['/ParentTree'])
                label = c.v.resolved(figure['/K'][2]); parents[0][int(label['/K'])] = caption.indirect_reference
            elif mode == 'nested_parent':
                next(node for node in native if node.get('/S') == '/Span')[N('/P')] = figure.indirect_reference
            elif mode == 'metadata':
                c.v.resolved(figure['/K'][2])[N('/A')] = DictionaryObject({N('/O'): N('/Layout'), N('/StructParents'): I(99)})
            elif mode == 'font':
                writer.pages[0]['/Resources']['/Font']['/F1'][N('/BaseFont')] = N('/Courier')
            elif mode == 'paint':
                stream = DecodedStreamObject(); stream.set_data(writer.pages[0].get_contents().get_data().replace(b'25 75 re', b'25 35 re'))
                writer.pages[0][N('/Contents')] = writer._add_object(stream)
            with self.subTest(mode=mode), self.assertRaises(c.ChartStructureError):
                c.verify_saved(PdfReader(io.BytesIO(saved(writer))), result['verification'])

    def test_equal_text_cannot_exchange_painted_occurrence(self):
        writer, _ = fixture(); stream = DecodedStreamObject()
        stream.set_data(writer.pages[0].get_contents().get_data().replace(b'(100)', b'(50)'))
        writer.pages[0][N('/Contents')] = writer._add_object(stream)
        source = PdfReader(io.BytesIO(saved(writer))); writer = PdfWriter(clone_from=source)
        result = c.apply_operations(source, writer, selection(source))
        tags = c.v.structure_inventory(source)['tags']
        mcids = [tag['contentSequence'][0]['mcid'] for tag in tags if tag['text'].strip() == '50']
        self.assertEqual(len(mcids), 2)
        from pypdf.generic import ContentStream
        ops = c.v.operations(writer.pages[0])
        for args, op in ops:
            if op == b'BDC' and len(args) == 2 and isinstance(args[1], dict) and args[1].get('/MCID') in mcids:
                args[1][N('/MCID')] = I(mcids[1] if args[1]['/MCID'] == mcids[0] else mcids[0])
        stream = ContentStream(None, writer); stream.operations = ops
        writer.pages[0][N('/Contents')] = writer._add_object(stream)
        with self.assertRaises(c.ChartStructureError):
            c.verify_saved(PdfReader(io.BytesIO(saved(writer))), result['verification'])

    def test_source_node_maps_bind_real_objects_and_writer_content(self):
        source = self.source(); writer = PdfWriter(clone_from=source); op = selection(source)
        smap = {f'tag-{i+1}': node for i, node in enumerate(c.nodes(source))}
        tmap = {f'tag-{i+1}': node for i, node in enumerate(c.nodes(writer))}
        result = c.apply_operations(source, writer, op, _source_nodes=smap, _target_nodes=tmap)
        c.verify_saved(PdfReader(io.BytesIO(saved(writer))), result['verification'])
        for sm, tm in ((list(smap), tmap), ({**smap, 'tag-2': smap['tag-3']}, tmap), (smap, smap)):
            with self.assertRaises(c.ChartStructureError):
                c.apply_operations(source, PdfWriter(clone_from=source), op, _source_nodes=sm, _target_nodes=tm)

    def test_unrelated_text_inside_plot_prevents_grouping(self):
        writer, names = fixture()
        stream = writer.pages[0].get_contents(); data = stream.get_data().replace(b'40 330 Tm', b'80 430 Tm')
        replacement = DecodedStreamObject(); replacement.set_data(data)
        writer.pages[0][N('/Contents')] = writer._add_object(replacement)
        self.assertEqual(c.discover_candidates(PdfReader(io.BytesIO(saved(writer)))), [])

    def test_rotated_pages_and_unsupported_or_nested_paint_are_skipped(self):
        writer, _ = fixture(); writer.pages[0].rotate(90)
        self.assertEqual(c.discover_candidates(PdfReader(io.BytesIO(saved(writer)))), [])
        for extra in (b'80 405 m 200 490 l S',
                      b'/Artifact BMC /Artifact BMC 80 405 m 200 490 l S EMC EMC',
                      b'/Artifact << /ActualText (Authored alternative) >> BDC 80 405 m 200 490 l S EMC',
                      b'/Artifact BMC 80 405 m 200 490 l S BT /F1 10 Tf (Data) Tj ET EMC'):
            with self.subTest(extra=extra):
                writer, _ = fixture(); stream = DecodedStreamObject()
                stream.set_data(writer.pages[0].get_contents().get_data() + b'\n' + extra)
                writer.pages[0][N('/Contents')] = writer._add_object(stream)
                self.assertEqual(c.discover_candidates(PdfReader(io.BytesIO(saved(writer)))), [])

    def test_source_invalid_parent_or_custom_axis_roles_are_not_reinterpreted(self):
        writer, names = fixture(); names['top'][N('/P')] = names['caption'].indirect_reference
        self.assertEqual(c.discover_candidates(PdfReader(io.BytesIO(saved(writer)))), [])
        writer, names = fixture(); names['list'][N('/S')] = N('/CustomAxis')
        writer.root_object['/StructTreeRoot'][N('/RoleMap')] = DictionaryObject({N('/CustomAxis'): N('/L')})
        self.assertEqual(c.discover_candidates(PdfReader(io.BytesIO(saved(writer)))), [])

    def test_chart_with_image_or_form_paint_is_not_treated_as_vector_only(self):
        for subtype in ('/Image', '/Form'):
            with self.subTest(subtype=subtype):
                writer, _ = fixture(); graphic = DecodedStreamObject()
                graphic[N('/Type')] = N('/XObject'); graphic[N('/Subtype')] = N(subtype)
                if subtype == '/Image':
                    graphic[N('/Width')] = I(1); graphic[N('/Height')] = I(1)
                    graphic[N('/BitsPerComponent')] = I(8); graphic[N('/ColorSpace')] = N('/DeviceRGB')
                    graphic.set_data(b'\xff\x00\x00')
                else:
                    graphic[N('/BBox')] = ArrayObject([I(0), I(0), I(1), I(1)])
                    graphic[N('/Resources')] = DictionaryObject(); graphic.set_data(b'0 0 1 1 re f')
                writer.pages[0]['/Resources'][N('/XObject')] = DictionaryObject({N('/Graphic'): writer._add_object(graphic)})
                stream = DecodedStreamObject(); stream.set_data(writer.pages[0].get_contents().get_data() + b'\nq 10 0 0 10 100 420 cm /Graphic Do Q')
                writer.pages[0][N('/Contents')] = writer._add_object(stream)
                self.assertEqual(c.discover_candidates(PdfReader(io.BytesIO(saved(writer)))), [])

    def test_unrelated_text_encoding_and_shifted_operator_indexes_preserved(self):
        writer, _ = fixture(); stream = DecodedStreamObject()
        stream.set_data(writer.pages[0].get_contents().get_data().replace(b'This paragraph', b'\x80his paragraph'))
        writer.pages[0][N('/Contents')] = writer._add_object(stream)
        source = PdfReader(io.BytesIO(saved(writer))); operation = selection(source)
        self.assertEqual(len(operation), 1)
        target = PdfWriter(clone_from=source); stream = DecodedStreamObject()
        # An earlier structure operation can add harmless marked wrappers;
        # source graphic identity never depends on mutable operator offsets.
        stream.set_data(b'/Artifact BMC EMC\n' + target.pages[0].get_contents().get_data())
        target.pages[0][N('/Contents')] = target._add_object(stream)
        result = c.apply_operations(source, target, operation)
        output = PdfReader(io.BytesIO(saved(target))); c.verify_saved(output, result['verification'])
        self.assertEqual(semantic.paint_fingerprint(c.v.operations(source.pages[0])), semantic.paint_fingerprint(c.v.operations(output.pages[0])))
        self.assertEqual(source.pages[0].extract_text(), output.pages[0].extract_text())


if __name__ == '__main__': unittest.main()
