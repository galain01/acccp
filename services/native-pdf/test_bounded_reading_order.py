"""Synthetic wrap-around callouts, source binding and saved-owner proofs."""
import io
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'research/native-pdf'))

from pypdf import PdfReader, PdfWriter
from pypdf.generic import (ArrayObject, BooleanObject, DecodedStreamObject,
    DictionaryObject, NameObject as N, NumberObject as I, TextStringObject)

import bounded_reading_order as b


def saved(writer):
    stream = io.BytesIO()
    writer.write(stream)
    return stream.getvalue()


def fixture():
    writer = PdfWriter()
    page = writer.add_blank_page(width=600, height=400)
    page[N('/StructParents')] = I(0)
    font = writer._add_object(DictionaryObject({N('/Type'): N('/Font'),
        N('/Subtype'): N('/Type1'), N('/BaseFont'): N('/Helvetica')}))
    page[N('/Resources')] = DictionaryObject({N('/Font'): DictionaryObject({N('/F'): font})})
    root = DictionaryObject({N('/Type'): N('/StructTreeRoot')})
    root_ref = writer._add_object(root)
    doc = DictionaryObject({N('/Type'): N('/StructElem'), N('/S'): N('/Document'), N('/P'): root_ref})
    doc_ref = writer._add_object(doc)
    root[N('/K')] = doc_ref
    writer.root_object[N('/StructTreeRoot')] = root_ref
    writer.root_object[N('/Lang')] = TextStringObject('en-US')
    writer.root_object[N('/MarkInfo')] = DictionaryObject({N('/Marked'): BooleanObject(True)})
    named, owners = {'doc': doc}, []
    def node(name, role, parent, mcid):
        value = DictionaryObject({N('/Type'): N('/StructElem'), N('/S'): N('/'+role),
            N('/P'): parent.indirect_reference, N('/Pg'): page.indirect_reference, N('/K'): I(mcid)})
        ref = writer._add_object(value)
        named[name] = value
        owners.append(ref)
        return value
    first = node('first', 'P', doc, 0)
    callout = node('callout', 'H2', doc, 1)
    link = node('link', 'Link', callout, 2)
    last = node('last', 'P', doc, 3)
    tail = node('tail', 'P', doc, 4)
    annot = DictionaryObject({N('/Type'): N('/Annot'), N('/Subtype'): N('/Link'),
        N('/Rect'): ArrayObject([I(40), I(175), I(100), I(185)]),
        N('/P'): page.indirect_reference, N('/StructParent'): I(1),
        N('/A'): DictionaryObject({N('/S'): N('/URI'), N('/URI'): TextStringObject('https://example.org/reading')})})
    annotation_ref = writer._add_object(annot)
    named['annotation'] = annot
    page[N('/Annots')] = ArrayObject([annotation_ref])
    link[N('/Alt')] = TextStringObject('Related reading')
    link[N('/K')] = ArrayObject([DictionaryObject({N('/Type'): N('/OBJR'),
        N('/Obj'): annotation_ref, N('/Pg'): page.indirect_reference}), I(2)])
    callout[N('/K')] = ArrayObject([I(1), link.indirect_reference])
    doc[N('/K')] = ArrayObject([item.indirect_reference for item in (first, callout, last, tail)])
    root[N('/ParentTree')] = writer._add_object(DictionaryObject({N('/Nums'): ArrayObject([
        I(0), ArrayObject(owners), I(1), link.indirect_reference])}))
    root[N('/ParentTreeNextKey')] = I(2)
    content = DecodedStreamObject()
    content.set_data(b'''BT /F 10 Tf
/P << /MCID 0 >> BDC 1 0 0 1 160 200 Tm (This first paragraph starts alongside the linked box and) Tj 0 -12 Td (continues with an unfinished) Tj EMC
/P << /MCID 1 >> BDC /F 8 Tf 1 0 0 1 40 192 Tm (Related article) Tj EMC
/Link << /MCID 2 >> BDC 1 0 0 1 40 180 Tm (Read more) Tj EMC
/P << /MCID 3 >> BDC /F 10 Tf 1 0 0 1 40 176 Tm (sentence below the callout before this paragraph reaches its conclusion.) Tj EMC
/P << /MCID 4 >> BDC 1 0 0 1 40 150 Tm (A separate paragraph remains in its original reading position.) Tj EMC
ET''')
    page[N('/Contents')] = writer._add_object(content)
    return writer, named


def select(candidates):
    return [{'type': 'repair_structure', 'tagId': item['tagId'], 'candidateId': item['candidateId']}
        for item in candidates]


def continuation_fixture():
    from test_bounded_chart_structure import fixture as chart_fixture
    writer, named = chart_fixture()
    chart_page = writer.pages[0]
    writer.insert_blank_page(width=400, height=600, index=0)
    first_page = writer.pages[0]
    first_page[N('/StructParents')] = I(1)
    first_page[N('/Resources')] = chart_page['/Resources']
    bold = writer._add_object(DictionaryObject({N('/Type'): N('/Font'),
        N('/Subtype'): N('/Type1'), N('/BaseFont'): N('/Helvetica-Bold')}))
    first_page['/Resources']['/Font'][N('/Bold')] = bold
    doc = named['document']
    anchor = DictionaryObject({N('/Type'): N('/StructElem'), N('/S'): N('/P'),
        N('/P'): doc.indirect_reference, N('/Pg'): first_page.indirect_reference, N('/K'): I(0)})
    anchor_ref = writer._add_object(anchor); named['anchor'] = anchor
    doc['/K'].insert(0, anchor_ref)
    root = writer.root_object['/StructTreeRoot']
    root['/ParentTree']['/Nums'].extend([I(1), ArrayObject([anchor_ref])])
    root[N('/ParentTreeNextKey')] = I(2)
    stream = DecodedStreamObject()
    stream.set_data(b'BT /P << /MCID 0 >> BDC /Bold 10 Tf 1 0 0 1 40 70 Tm (Section. ) Tj /F1 10 Tf '
        b'(The original paragraph has an unfinished) Tj 0 -12 Td (sentence that crosses the page boundary) Tj EMC ET')
    first_page[N('/Contents')] = writer._add_object(stream)
    old = b'This paragraph remains outside the chart. ' * 7
    lines = [b'continuation of the unfinished section appears', b'below the chart while its physical location',
        b'remains exactly where the author placed it.', b'The remaining sentences provide more detail',
        b'and keep their original words and text scopes.', b'Nothing in this paragraph describes the chart.']
    replacement = b') Tj 0 -12 Td ('.join(lines)
    stream = chart_page['/Contents']
    stream.set_data(stream.get_data().replace(old, replacement))
    return writer, named


class ReadingOrderTests(unittest.TestCase):
    def source(self):
        return PdfReader(io.BytesIO(saved(fixture()[0])))

    def repair(self, source, operations=None):
        writer = PdfWriter(clone_from=source)
        result = b.apply_operations(source, writer, operations or select(b.discover_candidates(source)))
        data = saved(writer)
        reopened = PdfReader(io.BytesIO(data))
        self.assertTrue(b.verify_saved(reopened, result['verification']))
        return reopened, result, data

    def test_candidate_includes_all_descendant_owners(self):
        candidates = b.discover_candidates(self.source())
        self.assertEqual(len(candidates), 1)
        self.assertEqual(candidates[0]['kind'], 'move_callout')
        self.assertEqual(candidates[0]['tagId'], 'tag-2')
        self.assertEqual(candidates[0]['relatedTagIds'], ['tag-3', 'tag-4', 'tag-5'])

    def test_saved_structure_concatenates_body_preserving_native_owners_and_paint(self):
        source = self.source()
        out, result, _ = self.repair(source)
        before = b.v.structure_inventory(source)
        after = b.v.structure_inventory(out)
        self.assertEqual(len(after['tags']), len(before['tags'])+1)
        self.assertEqual([tag['role'] for tag in after['tags']], ['Document', 'P', 'Span', 'Span', 'P', 'Link', 'P'])
        self.assertEqual([item['tagId'] for item in after['tags'][1]['contentSequence']], ['tag-3', 'tag-4'])
        self.assertEqual(after['tags'][2]['text']+after['tags'][3]['text'], before['tags'][1]['text']+before['tags'][4]['text'])
        self.assertEqual(source.pages[0].extract_text(), out.pages[0].extract_text())
        self.assertEqual(b.semantic.paint_fingerprint(b.v.operations(source.pages[0])), b.semantic.paint_fingerprint(b.v.operations(out.pages[0])))
        self.assertEqual(b.v.Canonicalizer(list(source.pages)).hash(source.pages[0]['/Annots']), b.v.Canonicalizer(list(out.pages)).hash(out.pages[0]['/Annots']))
        self.assertEqual(after['tags'][5]['alt'], 'Related reading')
        self.assertFalse([finding for finding in after['findings'] if finding['severity'] == 'error'])
        self.assertEqual(len(result['lineage']), len(after['tags']))

    def test_source_hash_and_plan_shape_bound(self):
        source = self.source()
        operation = select(b.discover_candidates(source))[0]
        for invalid in ([{**operation, 'candidateId': '0'*64}], [operation, operation],
                        [{**operation, 'role': 'P'}], [{**operation, 'tagId': 'tag-5'}]):
            with self.subTest(invalid=invalid), self.assertRaises(b.ReadingOrderError):
                b.apply_operations(source, PdfWriter(clone_from=source), invalid)
        changed = PdfWriter(clone_from=source)
        changed.add_metadata({'/Subject': 'another source'})
        with self.assertRaises(b.ReadingOrderError):
            other = PdfReader(io.BytesIO(saved(changed)))
            b.apply_operations(other, PdfWriter(clone_from=other), [operation])

    def test_writer_mutation_rejected(self):
        source = self.source()
        operations = select(b.discover_candidates(source))
        for index, key, value in [(1, '/S', N('/H3')), (3, '/Alt', TextStringObject('Changed link')),
                                  (4, '/K', I(0))]:
            with self.subTest(index=index), self.assertRaises(b.ReadingOrderError):
                writer = PdfWriter(clone_from=source)
                b.semantic.nodes(writer)[index][N(key)] = value
                b.apply_operations(source, writer, operations)

    def test_plain_json_cannot_supply_verification(self):
        with self.assertRaises(b.ReadingOrderError):
            b.verify_saved(self.source(), {'nodes': {}, 'windows': [], 'owners': {}})

    def test_reopened_order_parent_role_and_annotation_owner_tampering_rejected(self):
        source = self.source()
        for mutation in ('order', 'parent', 'role', 'annotation'):
            with self.subTest(mutation=mutation):
                writer = PdfWriter(clone_from=source)
                result = b.apply_operations(source, writer, select(b.discover_candidates(source)))
                nodes = b.semantic.nodes(writer)
                if mutation == 'order':
                    nodes[1][N('/K')] = ArrayObject(list(reversed(nodes[1]['/K'])))
                elif mutation == 'parent':
                    nodes[2][N('/P')] = nodes[0].indirect_reference
                elif mutation == 'role':
                    nodes[3][N('/S')] = N('/P')
                else:
                    writer.pages[0]['/Annots'][0].get_object()[N('/StructParent')] = I(99)
                with self.assertRaises(b.ReadingOrderError):
                    b.verify_saved(PdfReader(io.BytesIO(saved(writer))), result['verification'])

    def test_uncertain_sentence_or_geometry_has_no_candidate(self):
        variants = [(b'(continues with an unfinished)', b'(ends with a complete sentence.)'),
            (b'(sentence below', b'(Sentence below'), (b'40 192 Tm', b'160 192 Tm'),
            (b'40 176 Tm', b'40 100 Tm'), (b'40 192 Tm', b'40 40 Tm')]
        for old, new in variants:
            with self.subTest(new=new):
                writer, _ = fixture()
                stream = writer.pages[0]['/Contents']
                stream.set_data(stream.get_data().replace(old, new))
                self.assertEqual(b.discover_candidates(PdfReader(io.BytesIO(saved(writer)))), [])

    def test_authored_body_or_ancestor_overrides_not_changed(self):
        for name in ('first', 'last', 'doc'):
            for key in ('/Alt', '/ActualText', '/ID', '/E', '/Ref'):
                with self.subTest(name=name, key=key):
                    writer, named = fixture()
                    named[name][N(key)] = TextStringObject('Authored meaning')
                    self.assertEqual(b.discover_candidates(PdfReader(io.BytesIO(saved(writer)))), [])

    def test_parent_tree_mismatch_and_unlinked_callout_not_candidates(self):
        for mutation in ('ownership', 'no-link'):
            writer, named = fixture()
            if mutation == 'ownership':
                named['annotation'][N('/StructParent')] = I(99)
            else:
                named['link'][N('/S')] = N('/Span')
            self.assertEqual(b.discover_candidates(PdfReader(io.BytesIO(saved(writer)))), [])

    def test_shared_inspection_avoids_second_structure_scan_and_rejects_other_reader(self):
        source = self.source()
        inspection = b.semantic._DiscoveryInspection(source)
        with patch.object(b.v, 'structure_inventory', side_effect=AssertionError('extra inventory')):
            candidates = b.discover_candidates(source, _inspection=inspection)
            result = b.apply_operations(source, PdfWriter(clone_from=source), select(candidates), _inspection=inspection)
        self.assertEqual(len(result['changes']), 1)
        with self.assertRaises(b.semantic.SemanticStructureError):
            b.discover_candidates(self.source(), _inspection=inspection)

    def test_initial_native_maps_survive_unrelated_new_nodes(self):
        source = self.source()
        writer = PdfWriter(clone_from=source)
        originals, targets = b.semantic.nodes(source), b.semantic.nodes(writer)
        doc, tail = targets[0], targets[-1]
        wrapper = DictionaryObject({N('/Type'): N('/StructElem'), N('/S'): N('/Div'),
            N('/P'): doc.indirect_reference, N('/K'): tail.indirect_reference})
        ref = writer._add_object(wrapper)
        tail[N('/P')] = ref
        doc['/K'][-1] = ref
        operations = select(b.discover_candidates(source))
        source_map = {f'tag-{i+1}': node for i, node in enumerate(originals)}
        target_map = {f'tag-{i+1}': node for i, node in enumerate(targets)}
        result = b.apply_operations(source, writer, operations, _source_nodes=source_map, _target_nodes=target_map)
        self.assertTrue(b.verify_saved(PdfReader(io.BytesIO(saved(writer))), result['verification']))

    def test_next_page_candidate_has_readonly_anchor(self):
        source = PdfReader(io.BytesIO(saved(continuation_fixture()[0])))
        candidates = [item for item in b.discover_candidates(source) if item['kind'] == 'move_page_continuation']
        self.assertEqual(len(candidates), 1)
        self.assertEqual(candidates[0]['pageNumber'], 2)
        self.assertEqual(candidates[0]['relatedTagIds'], ['tag-2'])
        self.assertEqual(candidates[0]['readonlyTagIds'], ['tag-2'])

    def test_next_page_move_composes_with_split_heading_and_chart(self):
        import bounded_chart_structure as charts
        from test_bounded_chart_structure import ALT
        source = PdfReader(io.BytesIO(saved(continuation_fixture()[0])))
        inspection = b.semantic._DiscoveryInspection(source)
        continuation = next(item for item in b.discover_candidates(source, _inspection=inspection)
            if item['kind'] == 'move_page_continuation')
        heading = next(item for item in b.semantic.discover_candidates(source, _inspection=inspection)
            if item['kind'] == 'split_heading')
        chart = charts.discover_candidates(source, _inspection=inspection)[0]
        writer = PdfWriter(clone_from=source)
        smap = {f'tag-{i+1}': node for i, node in enumerate(b.semantic.nodes(source))}
        tmap = {f'tag-{i+1}': node for i, node in enumerate(b.semantic.nodes(writer))}
        head_result = b.semantic.apply_operations(source, writer,
            [{**select([heading])[0], 'role': 'H2'}], _inspection=inspection)
        with self.assertRaises(b.ReadingOrderError):
            b.apply_operations(source, writer, select([continuation]), _inspection=inspection,
                _source_nodes=smap, _target_nodes=tmap)
        moved = b.apply_operations(source, writer, select([continuation]), _inspection=inspection,
            _source_nodes=smap, _target_nodes=tmap,
            _prior_verifications=((b.semantic, head_result['verification']),))
        chart_result = charts.apply_operations(source, writer, [{**select([chart])[0], 'alt': ALT}],
            _inspection=inspection, _source_nodes=smap, _target_nodes=tmap)
        output = PdfReader(io.BytesIO(saved(writer)))
        out_inspection = b.semantic._DiscoveryInspection(output)
        b.semantic.verify_saved(output, head_result['verification'], _inspection=out_inspection)
        self.assertTrue(b.verify_saved(output, moved['verification'], _inspection=out_inspection))
        charts.verify_saved(output, chart_result['verification'], _inspection=out_inspection)
        for original, after in zip(source.pages, output.pages):
            self.assertEqual(original.extract_text(), after.extract_text())
            self.assertEqual(b.semantic.paint_fingerprint(b.v.operations(original)), b.semantic.paint_fingerprint(b.v.operations(after)))

    def test_next_page_move_preserves_unsplit_anchor_and_rejects_order_tampering(self):
        source = PdfReader(io.BytesIO(saved(continuation_fixture()[0])))
        candidate = next(item for item in b.discover_candidates(source) if item['kind'] == 'move_page_continuation')
        writer = PdfWriter(clone_from=source)
        result = b.apply_operations(source, writer, select([candidate]))
        self.assertTrue(b.verify_saved(PdfReader(io.BytesIO(saved(writer))), result['verification']))
        doc = b.semantic.nodes(writer)[0]
        doc['/K'][0], doc['/K'][1] = doc['/K'][1], doc['/K'][0]
        with self.assertRaises(b.ReadingOrderError):
            b.verify_saved(PdfReader(io.BytesIO(saved(writer))), result['verification'])

    def test_next_page_uncertain_or_authored_continuations_are_not_proposed(self):
        for mutation in ('complete', 'uppercase', 'authored', 'unknown_chart'):
            with self.subTest(mutation=mutation):
                writer, named = continuation_fixture()
                if mutation == 'complete':
                    stream = writer.pages[0]['/Contents']
                    stream.set_data(stream.get_data().replace(b'page boundary)', b'page boundary.)'))
                elif mutation == 'uppercase':
                    stream = writer.pages[1]['/Contents']
                    stream.set_data(stream.get_data().replace(b'(continuation', b'(Continuation'))
                elif mutation == 'authored':
                    named['anchor'][N('/Alt')] = TextStringObject('Authored sentence')
                else:
                    named['caption'][N('/S')] = N('/Table')
                source = PdfReader(io.BytesIO(saved(writer)))
                self.assertFalse(any(item['kind'] == 'move_page_continuation' for item in b.discover_candidates(source)))


if __name__ == '__main__':
    unittest.main()
