"""A styled note must not interrupt two native fragments of one title."""
import io
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'research/native-pdf'))

from pypdf import PdfReader, PdfWriter
from pypdf.generic import (ArrayObject, BooleanObject, DecodedStreamObject,
    DictionaryObject, NameObject as N, NumberObject as I, TextStringObject)

import native_structure_pipeline as pipeline
import bounded_interrupted_text as repair
import bounded_artifact_reading as artifacts
import verify_pdf as v


def saved(writer):
    result = io.BytesIO(); writer.write(result)
    return result.getvalue()


def fixture(container=False):
    writer = PdfWriter(); page = writer.add_blank_page(width=600, height=400)
    page[N('/StructParents')] = I(0)
    fonts = {}
    for key, name in (('Regular', 'Helvetica'), ('Italic', 'Helvetica-Oblique')):
        fonts[N('/' + key)] = writer._add_object(DictionaryObject({N('/Type'): N('/Font'),
            N('/Subtype'): N('/Type1'), N('/BaseFont'): N('/' + name)}))
    page[N('/Resources')] = DictionaryObject({N('/Font'): DictionaryObject(fonts)})
    root = DictionaryObject({N('/Type'): N('/StructTreeRoot')}); root_ref = writer._add_object(root)
    parent = root
    if container:
        parent = DictionaryObject({N('/Type'): N('/StructElem'), N('/S'): N('/Document'), N('/P'): root_ref})
        root[N('/K')] = writer._add_object(parent)
    nodes = []
    for index in range(4):
        node = DictionaryObject({N('/Type'): N('/StructElem'), N('/S'): N('/P'),
            N('/P'): parent.indirect_reference, N('/Pg'): page.indirect_reference,
            N('/K'): I(index), N('/ID'): TextStringObject('native-%d' % index),
            N('/C'): N('/SourceParagraph')})
        writer._add_object(node); nodes.append(node)
    parent[N('/K')] = ArrayObject([node.indirect_reference for node in nodes])
    root[N('/ParentTree')] = writer._add_object(DictionaryObject({N('/Nums'):
        ArrayObject([I(0), ArrayObject([node.indirect_reference for node in nodes])])}))
    root[N('/ParentTreeNextKey')] = I(1)
    root[N('/ClassMap')] = DictionaryObject({N('/SourceParagraph'): DictionaryObject({N('/O'): N('/Layout')})})
    root[N('/IDTree')] = writer._add_object(DictionaryObject({N('/Names'): ArrayObject([
        item for node in nodes for item in (node.raw_get('/ID'), node.indirect_reference)])}))
    writer.root_object[N('/StructTreeRoot')] = root_ref
    writer.root_object[N('/Lang')] = TextStringObject('en-US')
    writer.root_object[N('/MarkInfo')] = DictionaryObject({N('/Marked'): BooleanObject(True)})
    content = DecodedStreamObject(); content.set_data(b'''BT /Regular 10 Tf
/P << /MCID 0 >> BDC 1 0 0 1 40 300 Tm (A comprehensive introduction to scientific) Tj 0 -12 Td (research and practical analytical) Tj EMC
/P << /MCID 1 >> BDC /Italic 10 Tf 1 0 0 1 40 276 Tm (Separate course note) Tj EMC
/P << /MCID 2 >> BDC /Regular 10 Tf 1 0 0 1 40 264 Tm (methods) Tj EMC
/P << /MCID 3 >> BDC 1 0 0 1 40 200 Tm (A separate paragraph stays in its original position.) Tj EMC
ET''')
    page[N('/Contents')] = writer._add_object(content)
    return writer, nodes


class InterruptedTextTests(unittest.TestCase):
    def source(self, container=False):
        return PdfReader(io.BytesIO(saved(fixture(container=container)[0])))

    def operation(self, source):
        candidate = repair.discover_candidates(source)[0]
        return {'type': 'repair_structure', 'tagId': candidate['tagId'], 'candidateId': candidate['candidateId']}

    def apply(self, source):
        writer = PdfWriter(clone_from=source)
        result = repair.apply_operations(source, writer, [self.operation(source)])
        data = saved(writer); reopened = PdfReader(io.BytesIO(data))
        self.assertTrue(repair.verify_saved(reopened, result['verification']))
        return reopened, result, data

    def test_native_root_triplet_has_a_source_bound_candidate(self):
        source = PdfReader(io.BytesIO(saved(fixture()[0])))
        self.assertTrue(v.structure_inventory(source)['checks_complete'])
        candidates = [item for item in pipeline.discover_candidates(source)
            if item['kind'] == 'join_interrupted_text']
        self.assertEqual(len(candidates), 1,
            'Native styled text interruption is unsupported and is only reported by the auditor')
        self.assertEqual(candidates[0]['tagId'], 'tag-1')
        self.assertEqual(candidates[0]['relatedTagIds'], ['tag-2', 'tag-3'])

    def test_native_ids_class_attributes_owners_words_order_and_pixels_survive(self):
        import pypdfium2 as pdfium
        for container in (False, True):
            for rotation in (0, 90, 180, 270):
                with self.subTest(container=container, rotation=rotation):
                    writer, _ = fixture(container)
                    writer.pages[0][N('/Rotate')] = I(rotation)
                    source_bytes = saved(writer); source = PdfReader(io.BytesIO(source_bytes))
                    output, result, data = self.apply(source)
                    inv = v.structure_inventory(output)
                    self.assertTrue(inv['checks_complete'])
                    leaves = [tag for tag in inv['tags'] if tag.get('text')]
                    self.assertEqual([tag['mcids'] for tag in leaves], [[0], [2], [1], [3]])
                    self.assertEqual([tag['role'] for tag in leaves], ['Span', 'Span', 'P', 'P'])
                    self.assertEqual(source.pages[0].extract_text(), output.pages[0].extract_text())
                    self.assertEqual(source.pages[0]['/Contents'].get_data(), output.pages[0]['/Contents'].get_data())
                    self.assertEqual({str(node['/ID']) for node in repair.semantic.nodes(output) if '/ID' in node},
                        {'native-0', 'native-1', 'native-2', 'native-3'})
                    self.assertEqual(len(v.structure_id_tree(repair._root(output))), 4)
                    self.assertEqual(len(result['lineage']), 1)
                    pixels = []
                    for item in (source_bytes, data):
                        document = pdfium.PdfDocument(item); page = document[0]; bitmap = page.render(scale=1)
                        try:
                            pixels.append(bitmap.to_pil().convert('RGB').tobytes())
                        finally:
                            bitmap.close(); page.close(); document.close()
                    self.assertEqual(pixels[0], pixels[1])

    def test_only_the_exact_styled_adjacent_pattern_is_offered(self):
        replacements = (
            (b'/Italic 10 Tf', b'/Regular 10 Tf'),
            (b'/Regular 10 Tf 1 0 0 1 40 264', b'/Italic 10 Tf 1 0 0 1 40 264'),
            (b'1 0 0 1 40 264', b'1 0 0 1 100 264'),
            (b'1 0 0 1 40 264', b'1 0 0 1 40 220'),
            (b'(Separate course note) Tj', b'(Separate course note) Tj 0 -12 Td (Another note line) Tj'),
            (b'(methods) Tj', b'(A new unrelated paragraph with many independent words.) Tj'),
            (b'(research and practical analytical) Tj', b'(research and practical analytical.) Tj'),
        )
        for original, changed in replacements:
            writer, _ = fixture(); stream = writer.pages[0]['/Contents']
            self.assertIn(original, stream.get_data())
            stream.set_data(stream.get_data().replace(original, changed))
            with self.subTest(changed=changed):
                self.assertEqual(repair.discover_candidates(PdfReader(io.BytesIO(saved(writer)))), [])

    def test_authored_alternatives_and_unverified_native_ids_are_not_reinterpreted(self):
        for key in ('/Alt', '/ActualText', '/E', '/Ref'):
            writer, nodes = fixture(); nodes[0][N(key)] = TextStringObject('Authored content')
            with self.subTest(key=key):
                self.assertEqual(repair.discover_candidates(PdfReader(io.BytesIO(saved(writer)))), [])
        writer, nodes = fixture()
        repair._root(writer)['/IDTree']['/Names'][1] = nodes[1].indirect_reference
        self.assertEqual(repair.discover_candidates(PdfReader(io.BytesIO(saved(writer)))), [])

    def test_no_model_order_or_replacement_text_is_accepted_and_ids_bind_the_source(self):
        source = self.source(); operation = self.operation(source)
        for invalid in ({**operation, 'candidateId': '0' * 64}, {**operation, 'tagId': 'tag-99'},
            {**operation, 'order': ['tag-1', 'tag-3', 'tag-2']}, {**operation, 'text': 'New wording'}):
            with self.subTest(invalid=invalid), self.assertRaises(repair.InterruptedTextError):
                repair.apply_operations(source, PdfWriter(clone_from=source), [invalid])
        with self.assertRaises(repair.InterruptedTextError):
            repair.apply_operations(source, PdfWriter(clone_from=source), [operation, operation])
        changed = PdfWriter(clone_from=source); changed.add_metadata({'/Subject': 'A different source'})
        changed = PdfReader(io.BytesIO(saved(changed)))
        with self.assertRaises(repair.InterruptedTextError):
            repair.apply_operations(changed, PdfWriter(clone_from=changed), [operation])

    def test_saved_role_order_parent_tree_and_id_tree_corruption_is_detected(self):
        source = self.source()
        for corruption in ('role', 'order', 'outside-order', 'parent', 'owner', 'id-tree', 'class-map', 'paint'):
            writer = PdfWriter(clone_from=source)
            result = repair.apply_operations(source, writer, [self.operation(source)])
            nodes = repair.semantic.nodes(writer)
            if corruption == 'role':
                nodes[1][N('/S')] = N('/P')
            elif corruption == 'order':
                nodes[0]['/K'].reverse()
            elif corruption == 'outside-order':
                children = repair._root(writer)['/K']
                children.insert(0, children.pop())
            elif corruption == 'parent':
                nodes[1][N('/P')] = repair._root(writer).indirect_reference
            elif corruption == 'owner':
                v.number_tree(repair._root(writer)['/ParentTree'])[0][0] = nodes[2].indirect_reference
            elif corruption == 'id-tree':
                repair._root(writer)['/IDTree']['/Names'][1] = nodes[2].indirect_reference
            elif corruption == 'class-map':
                repair._root(writer)['/ClassMap']['/SourceParagraph'][N('/Placement')] = N('/Block')
            else:
                stream = writer.pages[0]['/Contents']; stream.set_data(stream.get_data().replace(b'methods', b'METHODS'))
            with self.subTest(corruption=corruption), self.assertRaises(repair.InterruptedTextError):
                repair.verify_saved(PdfReader(io.BytesIO(saved(writer))), result['verification'])

    def artifact_source(self, inside=False):
        writer, nodes = fixture(container=True)
        del nodes[-1]['/ID']; del nodes[-1]['/C']
        del repair._root(writer)['/IDTree']['/Names'][-2:]
        stream = writer.pages[0]['/Contents']
        content = stream.get_data()
        artifact = b'\n/Artifact BMC 1 0 0 1 40 180 Tm (Existing appendix direction.) Tj EMC\n'
        if inside:
            content = content.replace(b'/P << /MCID 1 >> BDC', artifact + b'/P << /MCID 1 >> BDC')
        else:
            content = content.replace(b'ET', artifact + b'ET')
        stream.set_data(content)
        return PdfReader(io.BytesIO(saved(writer)))

    def join_and_restore(self, source):
        writer = PdfWriter(clone_from=source)
        source_nodes = {f'tag-{i + 1}': node for i, node in enumerate(repair.semantic.nodes(source))}
        target_nodes = {f'tag-{i + 1}': node for i, node in enumerate(repair.semantic.nodes(writer))}
        joined = repair.apply_operations(source, writer, [self.operation(source)])
        candidate = artifacts.discover_candidates(source)[0]
        restored = artifacts.apply_operations(source, writer, [{'type': 'repair_structure',
            'tagId': candidate['tagId'], 'candidateId': candidate['candidateId'], 'selections': [
                {'scopeId': item['scopeId'], 'role': 'P'} for item in candidate['textScopes']]}],
            _source_nodes=source_nodes, _target_nodes=target_nodes,
            _prior_verifications=((repair, joined['verification']),))
        output = PdfReader(io.BytesIO(saved(writer)))
        repair.verify_saved(output, joined['verification'])
        artifacts.verify_saved(output, restored['verification'])
        return output

    def test_disjoint_artifact_restoration_keeps_the_joined_group_intact(self):
        source = self.artifact_source()
        output = self.join_and_restore(source)
        self.assertEqual(output.pages[0].extract_text(), source.pages[0].extract_text())

    def test_artifact_restoration_cannot_split_the_joined_group(self):
        with self.assertRaises(artifacts.ArtifactReadingError):
            self.join_and_restore(self.artifact_source(inside=True))


if __name__ == '__main__':
    unittest.main()
