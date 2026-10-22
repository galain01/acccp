"""Reopened-PDF tests of narrow semantic edits and refusal boundaries."""
import io
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'research/native-pdf'))

from pypdf import PdfReader, PdfWriter
from pypdf.generic import (ArrayObject, DecodedStreamObject, DictionaryObject,
    NameObject as N, NumberObject as I, TextStringObject)

import bounded_semantic_structure as b
import hybrid_form_verification as hybrid
from test_hybrid_form_verification import fixture as form_fixture


def saved(writer):
    stream = io.BytesIO()
    writer.write(stream)
    return stream.getvalue()


def fixture():
    writer = PdfWriter(clone_from=PdfReader(io.BytesIO(form_fixture(rights=False))))
    page = writer.pages[0]
    fonts = {}
    for key, face in (('/Regular', '/Helvetica'), ('/Bold', '/Helvetica-Bold')):
        fonts[N(key)] = writer._add_object(DictionaryObject({N('/Type'): N('/Font'),
            N('/Subtype'): N('/Type1'), N('/BaseFont'): N(face)}))
    page[N('/Resources')] = DictionaryObject({N('/Font'): DictionaryObject(fonts)})
    page[N('/StructParents')] = I(0)
    root = DictionaryObject({N('/Type'): N('/StructTreeRoot')})
    root_ref = writer._add_object(root)
    doc = DictionaryObject({N('/Type'): N('/StructElem'), N('/S'): N('/Document'), N('/P'): root_ref})
    doc_ref = writer._add_object(doc)
    root[N('/K')] = doc_ref
    writer.root_object[N('/StructTreeRoot')] = root_ref
    writer.root_object[N('/Lang')] = TextStringObject('en-US')
    from pypdf.generic import BooleanObject
    writer.root_object[N('/MarkInfo')] = DictionaryObject({N('/Marked'): BooleanObject(True)})
    parents, named = [], {}
    def node(name, role, parent, mcid=None):
        result = DictionaryObject({N('/Type'): N('/StructElem'), N('/S'): N('/' + role),
            N('/P'): parent.indirect_reference, N('/Pg'): page.indirect_reference})
        ref = writer._add_object(result)
        if mcid is not None:
            result[N('/K')] = I(mcid)
            while len(parents) <= mcid:
                parents.append(None)
            parents[mcid] = ref
        named[name] = result
        return result
    wrapper = node('wrapper', 'Div', doc)
    heading = node('heading', 'P', wrapper, 0)
    wrapper[N('/K')] = heading.indirect_reference  # exercise single-child references
    listing = node('list', 'L', doc)
    li = node('li', 'LI', listing)
    body = node('body', 'LBody', li, 1)
    li[N('/K')] = body.indirect_reference
    listing[N('/K')] = li.indirect_reference
    continuation_wrapper = node('continuation_wrapper', 'Div', doc)
    continuation = node('continuation', 'P', continuation_wrapper, 2)
    continuation_wrapper[N('/K')] = continuation.indirect_reference
    reference = node('reference', 'P', doc, 3)
    second_reference = node('second_reference', 'P', doc, 4)
    note = node('note', 'P', doc, 5)
    doc[N('/K')] = ArrayObject([item.indirect_reference for item in
        (wrapper, listing, continuation_wrapper, reference, second_reference, note)])
    root[N('/ParentTree')] = writer._add_object(DictionaryObject({N('/Nums'): ArrayObject([I(0), ArrayObject(parents)])}))
    root[N('/ParentTreeNextKey')] = I(1)
    content = DecodedStreamObject()
    content.set_data(b'''q 0 0 1 RG 20 20 m 200 20 l S Q
BT /Regular 10 Tf
/Content << /MCID 0 >> BDC /Bold 10 Tf 1 0 0 1 20 170 Tm (Section title. ) Tj /Regular 10 Tf (The original paragraph is retained.) Tj EMC
/Content << /MCID 1 >> BDC 1 0 0 1 20 150 Tm (The final list item ends with an) Tj EMC
/Content << /MCID 2 >> BDC 1 0 0 1 20 140 Tm (example that belongs to that list.) Tj EMC
/Content << /MCID 3 >> BDC 1 0 0 1 20 120 Tm (A threshold of $5000) Tj /Regular 6 Tf 1 0 0 1 130 124 Tm (1) Tj EMC
/Content << /MCID 4 >> BDC /Regular 10 Tf 1 0 0 1 20 100 Tm (Another reference) Tj /Regular 6 Tf 1 0 0 1 130 104 Tm (1) Tj EMC
/Content << /MCID 5 >> BDC /Regular 6 Tf 1 0 0 1 20 74 Tm (1) Tj /Regular 10 Tf 1 0 0 1 26 70 Tm ( The original note text.) Tj EMC
ET''')
    page[N('/Contents')] = writer._add_object(content)
    return writer, named


def selection(candidates, kind=None):
    return [{'type': 'repair_structure', 'tagId': item['tagId'], 'candidateId': item['candidateId'],
        **({'role': 'H2'} if item['kind'] == 'split_heading' else {})}
        for item in candidates if kind is None or item['kind'] == kind]


class BoundedSemanticTests(unittest.TestCase):
    def source(self):
        writer, _ = fixture()
        return PdfReader(io.BytesIO(saved(writer)))

    def repair(self, reader, operations):
        writer = PdfWriter(clone_from=reader)
        result = b.apply_operations(reader, writer, operations)
        output = saved(writer)
        return PdfReader(io.BytesIO(output)), result, output

    def test_all_three_kinds_preserve_paint_text_graph_and_pixels(self):
        source = self.source()
        candidates = b.discover_candidates(source)
        self.assertEqual([item['kind'] for item in candidates].count('mark_note_reference'), 2)
        self.assertEqual(set(item['kind'] for item in candidates), {'split_heading', 'mark_note_reference', 'join_list_continuation'})
        output, result, output_bytes = self.repair(source, selection(candidates))
        original_bytes = source.stream.getvalue()
        self.assertEqual(b.paint_fingerprint(b.v.operations(source.pages[0])), b.paint_fingerprint(b.v.operations(output.pages[0])))
        self.assertEqual(source.pages[0].extract_text(), output.pages[0].extract_text())
        self.assertEqual(hybrid.form_pixels(original_bytes), hybrid.form_pixels(output_bytes))
        self.assertEqual(b.v.Canonicalizer(list(source.pages)).hash(source.trailer['/Root']['/AcroForm']),
            b.v.Canonicalizer(list(output.pages)).hash(output.trailer['/Root']['/AcroForm']))
        inventory = b.v.structure_inventory(output)
        errors = [item['code'] for item in inventory['findings'] if item['severity'] == 'error']
        self.assertEqual(errors, ['missing_note_identifier'])  # worker adds the newly required ID next
        headings = [tag for tag in inventory['tags'] if tag['role'] == 'H2']
        self.assertEqual(len(headings), 1)
        self.assertEqual(headings[0]['text'].strip(), 'Section title.')
        notes = [tag for tag in inventory['tags'] if tag['role'] == 'Note']
        self.assertEqual(len(notes), 1)
        self.assertEqual(len([tag for tag in inventory['tags'] if tag['role'] == 'Reference']), 2)
        note_labels = [tag for tag in inventory['tags'] if tag['role'] == 'Lbl' and tag['parentId'] == notes[0]['id']]
        self.assertEqual(len(note_labels), 1)
        self.assertEqual(note_labels[0]['text'].strip(), '1')
        continuation = next(tag for tag in inventory['tags'] if tag['text'].startswith('example'))
        self.assertEqual(next(tag for tag in inventory['tags'] if tag['id'] == continuation['parentId'])['role'], 'LBody')
        self.assertEqual(len(result['lineage']), len(inventory['tags']))
        self.assertTrue(all(change['message'] for change in result['changes']))
        self.assertNotIn(b'/ActualText', output_bytes)
        self.assertNotIn(b'/Ref ', output_bytes)

    def test_empty_selection_preserves_all_original_nodes(self):
        source = self.source()
        output, result, _ = self.repair(source, [])
        self.assertEqual(result['changes'], [])
        self.assertEqual(len(result['lineage']), len(b.nodes(source)))
        self.assertEqual(b.v.structure_inventory(source), b.v.structure_inventory(output))

    def test_candidate_hash_binds_entire_source(self):
        source = self.source()
        operations = selection(b.discover_candidates(source), 'split_heading')
        other = PdfWriter(clone_from=source)
        other.add_metadata({'/Subject': 'different source'})
        changed = PdfReader(io.BytesIO(saved(other)))
        with self.assertRaises(b.SemanticStructureError):
            self.repair(changed, operations)

    def test_mutated_candidate_hash_and_duplicate_rejected(self):
        source = self.source()
        operation = selection(b.discover_candidates(source), 'split_heading')[0]
        for invalid in ([{**operation, 'candidateId': '0' * 64}], [operation, operation], [{**operation, 'role': 'H1'}], [{**operation, 'extra': 'value'}]):
            with self.subTest(invalid=invalid), self.assertRaises(b.SemanticStructureError):
                self.repair(source, invalid)

    def test_writer_role_or_content_change_rejected(self):
        source = self.source()
        operation = selection(b.discover_candidates(source), 'split_heading')[0]
        for key, value in (('/S', N('/H3')), ('/K', I(1))):
            writer = PdfWriter(clone_from=source)
            b.nodes(writer)[int(operation['tagId'][4:]) - 1][N(key)] = value
            with self.assertRaises(b.SemanticStructureError):
                b.apply_operations(source, writer, [operation])

    def test_authored_overrides_on_leaf_or_owner_skip_candidate(self):
        for owner in ('heading', 'wrapper'):
            for key in ('/ActualText', '/Alt', '/ID', '/E'):
                with self.subTest(owner=owner, key=key):
                    writer, named = fixture()
                    named[owner][N(key)] = TextStringObject('Authored value')
                    candidates = b.discover_candidates(PdfReader(io.BytesIO(saved(writer))))
                    self.assertFalse(any(item['kind'] == 'split_heading' for item in candidates))

    def test_nested_marked_content_or_ambiguous_font_is_not_split(self):
        for variant in ('nested', 'font'):
            writer, _ = fixture()
            page = writer.pages[0]
            if variant == 'nested':
                data = page['/Contents'].get_data().replace(b'(Section title. ) Tj', b'/Span BMC (Section title. ) Tj EMC')
                page['/Contents'].set_data(data)
            else:
                page['/Resources']['/Font']['/Bold'].get_object()[N('/BaseFont')] = N('/Helvetica')
            candidates = b.discover_candidates(PdfReader(io.BytesIO(saved(writer))))
            self.assertFalse(any(item['kind'] == 'split_heading' for item in candidates))

    def test_regular_size_number_is_not_a_footnote_candidate(self):
        writer, _ = fixture()
        page = writer.pages[0]
        page['/Contents'].set_data(page['/Contents'].get_data().replace(b'/Regular 6 Tf', b'/Regular 10 Tf'))
        candidates = b.discover_candidates(PdfReader(io.BytesIO(saved(writer))))
        self.assertFalse(any(item['kind'] == 'mark_note_reference' for item in candidates))

    def test_finished_list_sentence_is_not_continuation_candidate(self):
        writer, _ = fixture()
        page = writer.pages[0]
        page['/Contents'].set_data(page['/Contents'].get_data().replace(b'ends with an)', b'ends with an.)'))
        candidates = b.discover_candidates(PdfReader(io.BytesIO(saved(writer))))
        self.assertFalse(any(item['kind'] == 'join_list_continuation' for item in candidates))

    def test_duplicate_mcid_with_extra_properties_refuses_page(self):
        writer, _ = fixture()
        page = writer.pages[0]
        page['/Contents'].set_data(page['/Contents'].get_data() +
            b' BT /Content << /MCID 0 /ActualText (ambiguous) >> BDC (Another run) Tj EMC ET')
        self.assertEqual(b.discover_candidates(PdfReader(io.BytesIO(saved(writer)))), [])

    def test_existing_authored_note_identifier_prevents_splitting(self):
        writer, named = fixture()
        named['note'][N('/S')] = N('/Note')
        named['note'][N('/ID')] = TextStringObject('existing-note')
        candidates = b.discover_candidates(PdfReader(io.BytesIO(saved(writer))))
        self.assertFalse(any(item['kind'] == 'mark_note_reference' for item in candidates))

    def test_conflicting_candidate_primary_and_note_target_rejected(self):
        source = self.source()
        candidates = b.discover_candidates(source)
        operation = selection(candidates, 'mark_note_reference')[0]
        with self.assertRaises(b.SemanticStructureError):
            self.repair(source, [operation, operation])

    def numbered_fixture(self, separator=b'. ', third=False):
        writer, named = fixture()
        page = writer.pages[0]
        content = page['/Contents'].get_data()
        content = content.replace(b'A threshold of $5000', b'1' + separator + b'First existing code')
        content = content.replace(b'Another reference', b'2' + separator + b'Second existing code')
        # Remove the isolated superscripts from these source paragraphs.
        content = content.replace(b'/Regular 6 Tf 1 0 0 1 130 124 Tm (1) Tj', b'')
        content = content.replace(b'/Regular 6 Tf 1 0 0 1 130 104 Tm (1) Tj', b'')
        page['/Contents'].set_data(content)
        if separator == b'\x97':
            page['/Resources']['/Font']['/Regular'][N('/Encoding')] = N('/WinAnsiEncoding')
        return writer, named

    def test_numbered_list_preserves_paragraphs_labels_forms_and_order(self):
        writer, _ = self.numbered_fixture()
        source = PdfReader(io.BytesIO(saved(writer)))
        candidates = b.discover_candidates(source)
        lists = [item for item in candidates if item['kind'] == 'convert_list']
        self.assertEqual(len(lists), 1)
        output, _, output_bytes = self.repair(source, selection(lists))
        inventory = b.v.structure_inventory(output)
        paragraphs = [tag for tag in inventory['tags'] if 'existing code' in tag['text']]
        self.assertEqual(len(paragraphs), 2)
        by_id = {tag['id']: tag for tag in inventory['tags']}
        parents = [by_id[tag['parentId']] for tag in paragraphs]
        self.assertTrue(all(tag['role'] == 'P' for tag in paragraphs))
        self.assertTrue(all(tag['role'] == 'LBody' for tag in parents))
        items = [by_id[tag['parentId']] for tag in parents]
        self.assertTrue(all(tag['role'] == 'LI' for tag in items))
        self.assertEqual(items[0]['parentId'], items[1]['parentId'])
        self.assertEqual(by_id[items[0]['parentId']]['role'], 'L')
        self.assertEqual(source.pages[0].extract_text(), output.pages[0].extract_text())
        self.assertEqual(b.paint_fingerprint(b.v.operations(source.pages[0])), b.paint_fingerprint(b.v.operations(output.pages[0])))
        self.assertEqual(hybrid.form_pixels(source.stream.getvalue()), hybrid.form_pixels(output_bytes))
        self.assertFalse(any(item['severity'] == 'error' for item in inventory['findings']))

    def test_winansi_dash_requires_the_original_font_encoding(self):
        writer, _ = self.numbered_fixture(b'\x97')
        source = PdfReader(io.BytesIO(saved(writer)))
        self.assertEqual(len(selection(b.discover_candidates(source), 'convert_list')), 1)
        writer.pages[0]['/Resources']['/Font']['/Regular'].pop(N('/Encoding'))
        source = PdfReader(io.BytesIO(saved(writer)))
        self.assertEqual(selection(b.discover_candidates(source), 'convert_list'), [])

    def test_missing_list_successor_does_not_group_arbitrary_paragraphs(self):
        writer, _ = self.numbered_fixture()
        page = writer.pages[0]
        page['/Contents'].set_data(page['/Contents'].get_data().replace(b'2. Second', b'8. Second'))
        self.assertFalse(selection(b.discover_candidates(PdfReader(io.BytesIO(saved(writer)))), 'convert_list'))

    def test_list_candidate_rejects_conflicting_participant(self):
        writer, _ = self.numbered_fixture()
        source = PdfReader(io.BytesIO(saved(writer)))
        operation = selection(b.discover_candidates(source), 'convert_list')[0]
        clone = PdfWriter(clone_from=source)
        b.nodes(clone)[int(operation['tagId'][4:]) - 1][N('/S')] = N('/H3')
        with self.assertRaises(b.SemanticStructureError):
            b.apply_operations(source, clone, [operation])

    def test_more_than_500_operations_are_rejected_before_discovery(self):
        source = self.source()
        from unittest.mock import patch
        with patch.object(b, '_discover', side_effect=AssertionError('must not run')):
            with self.assertRaises(b.SemanticStructureError):
                b.apply_operations(source, PdfWriter(clone_from=source), [{}] * 501)

    def test_twenty_two_items_are_bounded_without_dropping_last_item(self):
        writer, _ = fixture()
        page = writer.pages[0]
        root = writer.root_object['/StructTreeRoot']
        doc = root['/K']
        parents = root['/ParentTree']['/Nums'][1]
        content = page['/Contents'].get_data() + b' BT /Regular 10 Tf '
        for number in range(1, 23):
            mcid = len(parents)
            paragraph = DictionaryObject({N('/Type'): N('/StructElem'), N('/S'): N('/P'),
                N('/P'): doc.indirect_reference, N('/Pg'): page.indirect_reference, N('/K'): I(mcid)})
            ref = writer._add_object(paragraph)
            doc['/K'].append(ref)
            parents.append(ref)
            content += f'/Content << /MCID {mcid} >> BDC 1 0 0 1 20 {80-number} Tm ({number}. Existing code text.) Tj EMC '.encode()
        content += b' ET'
        page['/Contents'].set_data(content)
        source = PdfReader(io.BytesIO(saved(writer)))
        candidates = [item for item in b.discover_candidates(source) if item['kind'] == 'convert_list']
        self.assertEqual([1 + len(item['relatedTagIds']) for item in candidates], [21, 1])
        output, _, _ = self.repair(source, selection(candidates))
        self.assertEqual(source.pages[0].extract_text(), output.pages[0].extract_text())

    def star_fixture(self, marker=b'*'):
        writer, named = fixture()
        page = writer.pages[0]
        page['/Resources']['/Font']['/Regular'][N('/Encoding')] = N('/WinAnsiEncoding')
        data = page['/Contents'].get_data()
        data = data.replace(b'(A threshold of $5000) Tj /Regular 6 Tf 1 0 0 1 130 124 Tm (1) Tj', b'(A threshold of $5000' + marker + b') Tj')
        data = data.replace(b'(Another reference) Tj /Regular 6 Tf 1 0 0 1 130 104 Tm (1) Tj', b'(Another reference' + marker + b') Tj')
        data = data.replace(b'1 0 0 1 20 74 Tm (1) Tj', b'1 0 0 1 20 74 Tm (' + marker + b') Tj')
        page['/Contents'].set_data(data)
        return writer, named

    def test_ascii_star_partitions_preserve_encoded_paint_text_and_pixels(self):
        for marker in (b'*', b'**'):
            with self.subTest(marker=marker):
                writer, _ = self.star_fixture(marker)
                source = PdfReader(io.BytesIO(saved(writer)))
                candidates = [item for item in b.discover_candidates(source) if item['kind'] == 'mark_note_reference']
                self.assertEqual(len(candidates), 2)
                output, _, output_bytes = self.repair(source, selection(candidates))
                self.assertEqual(source.pages[0].extract_text(), output.pages[0].extract_text())
                self.assertEqual(b.paint_fingerprint(b.v.operations(source.pages[0]), True), b.paint_fingerprint(b.v.operations(output.pages[0]), True))
                self.assertNotEqual(b.paint_fingerprint(b.v.operations(source.pages[0])), b.paint_fingerprint(b.v.operations(output.pages[0])))
                self.assertEqual(hybrid.form_pixels(source.stream.getvalue()), hybrid.form_pixels(output_bytes))
                inventory = b.v.structure_inventory(output)
                labels = [tag for tag in inventory['tags'] if tag['role'] == 'Lbl']
                self.assertEqual(len(labels), 3)
                self.assertTrue(all(tag['text'].strip() == marker.decode() for tag in labels))
                self.assertEqual({item['code'] for item in inventory['findings'] if item['severity'] == 'error'}, {'missing_note_identifier'})

    def test_star_suffix_refuses_custom_encoding_type3_unicode_map_or_three_stars(self):
        for variant in ('encoding', 'type3', 'unicode', 'three'):
            writer, _ = self.star_fixture(b'***' if variant == 'three' else b'*')
            font = writer.pages[0]['/Resources']['/Font']['/Regular']
            if variant == 'encoding':
                font[N('/Encoding')] = N('/MacRomanEncoding')
            elif variant == 'type3':
                font[N('/Subtype')] = N('/Type3')
            elif variant == 'unicode':
                cmap = DecodedStreamObject(); cmap.set_data(b'')
                font[N('/ToUnicode')] = writer._add_object(cmap)
            source = PdfReader(io.BytesIO(saved(writer)))
            with self.subTest(variant=variant):
                self.assertEqual(selection(b.discover_candidates(source), 'mark_note_reference'), [])

    def test_graphics_state_invalidates_suffix_font_evidence_until_explicit_tf(self):
        writer, _ = self.star_fixture()
        page = writer.pages[0]
        page['/Resources'][N('/ExtGState')] = DictionaryObject({N('/Hidden'): DictionaryObject()})
        page['/Contents'].set_data(page['/Contents'].get_data().replace(b'/Content << /MCID 3 >>', b'/Hidden gs /Content << /MCID 3 >>'))
        source = PdfReader(io.BytesIO(saved(writer)))
        candidates = selection(b.discover_candidates(source), 'mark_note_reference')
        # MCID4 restores /Regular using an explicit Tf; MCID3 cannot rely on it.
        self.assertEqual(len(candidates), 1)
        inventory = b.v.structure_inventory(source)
        self.assertIn('Another reference', next(tag['text'] for tag in inventory['tags'] if tag['id'] == candidates[0]['tagId']))


if __name__ == '__main__':
    unittest.main()
