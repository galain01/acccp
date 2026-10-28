"""Percentages split into integer list labels remain ordinary source prose."""
import io
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'research/native-pdf'))

from pypdf import PdfReader, PdfWriter
from pypdf.generic import (ArrayObject, BooleanObject, DecodedStreamObject,
    DictionaryObject, NameObject as N, NumberObject as I, TextStringObject)

import native_structure_pipeline as pipeline
import bounded_false_list as repair
import verify_pdf as v


def saved(writer):
    result = io.BytesIO(); writer.write(result)
    return result.getvalue()


def fixture():
    writer = PdfWriter(); page = writer.add_blank_page(width=600, height=500)
    page[N('/StructParents')] = I(0)
    fonts = {}
    for name in ('Helvetica', 'Helvetica-Oblique'):
        fonts[N('/F' if name == 'Helvetica' else '/Other')] = writer._add_object(DictionaryObject({
            N('/Type'): N('/Font'), N('/Subtype'): N('/Type1'), N('/BaseFont'): N('/' + name)}))
    page[N('/Resources')] = DictionaryObject({N('/Font'): DictionaryObject(fonts)})
    root = DictionaryObject({N('/Type'): N('/StructTreeRoot')}); root_ref = writer._add_object(root)
    named, owners = {}, []

    def tag(name, role, parent, mcid=None):
        node = DictionaryObject({N('/Type'): N('/StructElem'), N('/S'): N('/' + role),
            N('/P'): parent.indirect_reference, N('/Pg'): page.indirect_reference,
            N('/ID'): TextStringObject(name)})
        writer._add_object(node); named[name] = node
        if mcid is not None:
            node[N('/K')] = I(mcid); owners.append(node.indirect_reference)
        return node

    document = tag('document', 'Document', root)
    listing = tag('list', 'L', document)
    first = tag('item-a', 'LI', listing)
    label = tag('label-a', 'Lbl', first, 0)
    body = tag('body-a', 'LBody', first, 1)
    paragraph = tag('paragraph', 'P', body, 2)
    second = tag('item-b', 'LI', listing)
    second_label = tag('label-b', 'Lbl', second, 3)
    second_body = tag('body-b', 'LBody', second, 4)
    document[N('/K')] = ArrayObject([listing.indirect_reference])
    listing[N('/K')] = ArrayObject([first.indirect_reference, second.indirect_reference])
    first[N('/K')] = ArrayObject([label.indirect_reference, body.indirect_reference])
    body[N('/K')] = ArrayObject([I(1), paragraph.indirect_reference])
    second[N('/K')] = ArrayObject([second_label.indirect_reference, second_body.indirect_reference])
    listing[N('/A')] = ArrayObject([
        DictionaryObject({N('/O'): N('/Layout'), N('/Placement'): N('/Block')}), I(0),
        DictionaryObject({N('/O'): N('/List'), N('/ListNumbering'): N('/Decimal')}), I(0)])
    root[N('/K')] = document.indirect_reference
    root[N('/ParentTree')] = writer._add_object(DictionaryObject({N('/Nums'): ArrayObject([I(0), ArrayObject(owners)])}))
    root[N('/ParentTreeNextKey')] = I(1)
    root[N('/IDTree')] = writer._add_object(DictionaryObject({N('/Names'): ArrayObject([
        item for name in sorted(named) for item in (TextStringObject(name), named[name].indirect_reference)])}))
    writer.root_object[N('/StructTreeRoot')] = root_ref
    writer.root_object[N('/Lang')] = TextStringObject('en-US')
    writer.root_object[N('/MarkInfo')] = DictionaryObject({N('/Marked'): BooleanObject(True)})
    stream = DecodedStreamObject(); stream.set_data(b'''BT /F 10 Tf 1 0 0 1 40 400 Tm
/Lbl << /MCID 0 >> BDC (19) Tj EMC
/LBody << /MCID 1 >> BDC (.4% of documents were available and the remaining documents had different access arrangements.) Tj EMC
1 0 0 1 40 360 Tm /P << /MCID 2 >> BDC (A separate paragraph describes the subject areas and their percentages.) Tj EMC
1 0 0 1 40 320 Tm /Lbl << /MCID 3 >> BDC (20) Tj EMC
/LBody << /MCID 4 >> BDC (.0% appeared in a second category with the remaining documents in other categories.) Tj EMC ET''')
    page[N('/Contents')] = writer._add_object(stream)
    return writer, named


class FalseListTests(unittest.TestCase):
    def source(self):
        return PdfReader(io.BytesIO(saved(fixture()[0])))

    def operation(self, source):
        candidate = repair.discover_candidates(source)[0]
        return {'type': 'repair_structure', 'tagId': candidate['tagId'], 'candidateId': candidate['candidateId']}

    def apply(self, source):
        writer = PdfWriter(clone_from=source)
        result = repair.apply_operations(source, writer, [self.operation(source)])
        data = saved(writer); reopened = PdfReader(io.BytesIO(data))
        self.assertTrue(repair.verify_saved(reopened, result['verification']))
        return reopened, result, data

    def test_decimal_percent_prose_has_a_bounded_repair_candidate(self):
        source = PdfReader(io.BytesIO(saved(fixture()[0])))
        self.assertTrue(v.structure_inventory(source)['checks_complete'])
        candidates = [item for item in pipeline.discover_candidates(source)
            if item['kind'] == 'restore_decimal_paragraphs']
        self.assertEqual(len(candidates), 1,
            'The checker reports decimal percentage prose as a numbered list without a supported repair')
        self.assertEqual(candidates[0]['tagId'], 'tag-2')

    def test_saved_paragraphs_keep_every_node_id_word_owner_and_pixel(self):
        import pypdfium2 as pdfium
        for rotation in (0, 90, 180, 270):
            with self.subTest(rotation=rotation):
                writer, _ = fixture(); writer.pages[0][N('/Rotate')] = I(rotation)
                source_bytes = saved(writer); source = PdfReader(io.BytesIO(source_bytes))
                output, result, data = self.apply(source)
                inv = v.structure_inventory(output)
                self.assertTrue(inv['checks_complete'])
                self.assertEqual([tag['role'] for tag in inv['tags']],
                    ['Document', 'Div', 'P', 'Span', 'Span', 'P', 'P', 'Span', 'Span'])
                div = next(tag for tag in inv['tags'] if tag['role'] == 'Div')
                self.assertEqual([item['tagId'] for item in div['contentSequence']], ['tag-3', 'tag-6', 'tag-7'])
                self.assertEqual([tag['mcids'] for tag in inv['tags'] if tag.get('text')], [[0], [1], [2], [3], [4]])
                self.assertEqual(source.pages[0].extract_text(), output.pages[0].extract_text())
                self.assertEqual(source.pages[0]['/Contents'].get_data(), output.pages[0]['/Contents'].get_data())
                self.assertEqual(repair.common._id_owners(source), repair.common._id_owners(output))
                self.assertEqual(len(repair.semantic.nodes(source)), len(repair.semantic.nodes(output)))
                self.assertEqual(result['lineage'], [])
                attrs = repair.common._root(output)['/K']['/K'][0]['/A']
                self.assertEqual(len(attrs), 2)
                self.assertEqual(attrs[0]['/O'], '/Layout')
                self.assertEqual(int(attrs[1]), 0)
                pixels = []
                for raw in (source_bytes, data):
                    document = pdfium.PdfDocument(raw); page = document[0]; bitmap = page.render(scale=1)
                    try:
                        pixels.append(bitmap.to_pil().convert('RGB').tobytes())
                    finally:
                        bitmap.close(); page.close(); document.close()
                self.assertEqual(pixels[0], pixels[1])

    def test_true_lists_nonadjacent_numbers_and_mixed_fonts_are_not_offered(self):
        cases = (
            (b'(19) Tj', b'(19.) Tj'),
            (b'(.4% of', b'(First instruction of'),
            (b'(.4% of', b'(.4 of'),
            (b'(19) Tj', b'(100) Tj'),
            (b'(.4% of', b'(.12345% of'),
            (b'EMC\n/LBody << /MCID 1', b'EMC 0 -12 Td\n/LBody << /MCID 1'),
            (b'EMC\n/LBody << /MCID 1', b'EMC /Other 10 Tf\n/LBody << /MCID 1'),
            (b'EMC\n/LBody << /MCID 1', b'EMC 1 0 0 1 60 400 Tm\n/LBody << /MCID 1'),
            (b'(.0% appeared', b'(A genuine instruction appeared'),
        )
        for original, replacement in cases:
            writer, _ = fixture(); stream = writer.pages[0]['/Contents']
            self.assertIn(original, stream.get_data())
            stream.set_data(stream.get_data().replace(original, replacement))
            with self.subTest(replacement=replacement):
                self.assertEqual(repair.discover_candidates(PdfReader(io.BytesIO(saved(writer)))), [])

    def test_percentage_endpoints_are_supported(self):
        for label, fraction in (('0', '0'), ('100', '0')):
            writer, _ = fixture(); stream = writer.pages[0]['/Contents']
            stream.set_data(stream.get_data().replace(b'(19) Tj', ('(%s) Tj' % label).encode())
                .replace(b'(.4% of', ('(.%s%% of' % fraction).encode()))
            with self.subTest(label=label, fraction=fraction):
                self.assertEqual(len(repair.discover_candidates(PdfReader(io.BytesIO(saved(writer))))), 1)

    def test_only_plain_terminal_paragraphs_and_supported_attributes_can_be_moved(self):
        for kind in ('heading', 'nonterminal', 'alternative', 'list-attribute'):
            writer, nodes = fixture()
            if kind == 'heading':
                nodes['paragraph'][N('/S')] = N('/H2')
            elif kind == 'nonterminal':
                nodes['body-a']['/K'].reverse()
            elif kind == 'alternative':
                nodes['body-a'][N('/ActualText')] = TextStringObject('Authored prose')
            else:
                nodes['list']['/A'][2][N('/UnknownListProperty')] = I(1)
            with self.subTest(kind=kind):
                self.assertEqual(repair.discover_candidates(PdfReader(io.BytesIO(saved(writer)))), [])

    def test_exact_plan_and_complete_source_are_required(self):
        source = self.source(); operation = self.operation(source)
        for invalid in ({**operation, 'candidateId': '0' * 64}, {**operation, 'tagId': 'tag-99'},
            {**operation, 'order': ['tag-3', 'tag-6']}, {**operation, 'text': 'Replacement content'}):
            with self.subTest(invalid=invalid), self.assertRaises(repair.FalseListError):
                repair.apply_operations(source, PdfWriter(clone_from=source), [invalid])
        with self.assertRaises(repair.FalseListError):
            repair.apply_operations(source, PdfWriter(clone_from=source), [operation, operation])
        changed = PdfWriter(clone_from=source); changed.add_metadata({'/Subject': 'Another original'})
        changed = PdfReader(io.BytesIO(saved(changed)))
        with self.assertRaises(repair.FalseListError):
            repair.apply_operations(changed, PdfWriter(clone_from=changed), [operation])
        writer = PdfWriter(clone_from=source)
        stream = writer.pages[0]['/Contents']; stream.set_data(stream.get_data().replace(b'.4%', b'.5%'))
        with self.assertRaises(repair.FalseListError):
            repair.apply_operations(source, writer, [operation])

    def test_saved_role_order_owner_id_attribute_and_glyph_mutations_are_rejected(self):
        source = self.source()
        for corruption in ('role', 'order', 'parent', 'owner', 'id-tree', 'attributes', 'glyph'):
            writer = PdfWriter(clone_from=source)
            result = repair.apply_operations(source, writer, [self.operation(source)])
            nodes = repair.semantic.nodes(writer)
            if corruption == 'role':
                nodes[3][N('/S')] = N('/Lbl')
            elif corruption == 'order':
                nodes[1]['/K'].reverse()
            elif corruption == 'parent':
                nodes[5][N('/P')] = nodes[4].indirect_reference
            elif corruption == 'owner':
                v.number_tree(repair.common._root(writer)['/ParentTree'])[0][0] = nodes[4].indirect_reference
            elif corruption == 'id-tree':
                repair.common._root(writer)['/IDTree']['/Names'][1] = nodes[3].indirect_reference
            elif corruption == 'attributes':
                nodes[1]['/A'].append(DictionaryObject({N('/O'): N('/List'), N('/ListNumbering'): N('/Decimal')}))
            else:
                stream = writer.pages[0]['/Contents']
                self.assertIn(b'.4%', stream.get_data())
                stream.set_data(stream.get_data().replace(b'.4%', b'.5%'))
            with self.subTest(corruption=corruption), self.assertRaises(repair.FalseListError):
                repair.verify_saved(PdfReader(io.BytesIO(saved(writer))), result['verification'])


if __name__ == '__main__':
    unittest.main()
