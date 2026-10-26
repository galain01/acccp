"""Source-proven removal of a generator's generic Annotation alternatives."""
import io
from pathlib import Path
import tempfile
import unittest

from pypdf import PdfReader, PdfWriter
from pypdf.generic import (ArrayObject, BooleanObject, DecodedStreamObject,
    DictionaryObject, NameObject as N, NumberObject as I, TextStringObject as S)

import worker
import bounded_semantic_structure as semantic
import native_generated_link_labels as labels


def saved(writer):
    data = io.BytesIO(); writer.write(data)
    return data.getvalue()


def fixture(*, text='12 ]', source_contents=None, candidate_contents='Annotation', alt='Annotation', callback=None):
    writer = PdfWriter(); page = writer.add_blank_page(width=200, height=100)
    page[N('/StructParents')] = I(0)
    font = writer._add_object(DictionaryObject({N('/Type'): N('/Font'), N('/Subtype'): N('/Type1'), N('/BaseFont'): N('/Helvetica')}))
    page[N('/Resources')] = DictionaryObject({N('/Font'): DictionaryObject({N('/F'): font})})
    root = DictionaryObject({N('/Type'): N('/StructTreeRoot')}); root_ref = writer._add_object(root)
    doc = DictionaryObject({N('/Type'): N('/StructElem'), N('/S'): N('/Document'), N('/P'): root_ref}); doc_ref = writer._add_object(doc)
    link = DictionaryObject({N('/Type'): N('/StructElem'), N('/S'): N('/Link'), N('/P'): doc_ref,
        N('/Pg'): page.indirect_reference, N('/Alt'): S(alt), N('/ID'): S('generated-link-0')})
    link_ref = writer._add_object(link)
    annotation = DictionaryObject({N('/Type'): N('/Annot'), N('/Subtype'): N('/Link'),
        N('/Rect'): ArrayObject([I(29), I(47), I(55), I(61)]), N('/P'): page.indirect_reference,
        N('/StructParent'): I(5), N('/A'): DictionaryObject({N('/S'): N('/GoTo'), N('/D'): S('missing-citation')})})
    if candidate_contents is not None: annotation[N('/Contents')] = S(candidate_contents)
    annotation_ref = writer._add_object(annotation); page[N('/Annots')] = ArrayObject([annotation_ref])
    link[N('/K')] = ArrayObject([I(0), DictionaryObject({N('/Type'): N('/OBJR'), N('/Obj'): annotation_ref, N('/Pg'): page.indirect_reference})])
    doc[N('/K')] = ArrayObject([link_ref]); root[N('/K')] = doc_ref
    root[N('/ParentTree')] = DictionaryObject({N('/Nums'): ArrayObject([I(0), ArrayObject([link_ref]), I(5), link_ref])})
    root[N('/IDTree')] = DictionaryObject({N('/Names'): ArrayObject([S('generated-link-0'), link_ref])})
    writer.root_object[N('/StructTreeRoot')] = root_ref
    writer.root_object[N('/MarkInfo')] = DictionaryObject({N('/Marked'): BooleanObject(True)})
    writer.root_object[N('/Lang')] = S('en-US')
    stream = DecodedStreamObject(); stream.set_data(b'BT /F 10 Tf /Link << /MCID 0 >> BDC 1 0 0 1 30 50 Tm (' + text.encode('ascii') + b') Tj EMC ET')
    page[N('/Contents')] = writer._add_object(stream)
    candidate = PdfReader(io.BytesIO(saved(writer)))
    source_writer = PdfWriter(clone_from=candidate)
    del source_writer.root_object['/StructTreeRoot']; del source_writer.root_object['/MarkInfo']
    source_annotation = source_writer.pages[0]['/Annots'][0].get_object()
    source_annotation.pop(N('/Contents'), None); source_annotation.pop(N('/StructParent'), None)
    if source_contents is not None: source_annotation[N('/Contents')] = S(source_contents)
    source_writer.pages[0].pop(N('/StructParents'), None)
    original = PdfReader(io.BytesIO(saved(source_writer)))
    if callback:
        edited = PdfWriter(clone_from=candidate)
        callback(edited)
        candidate = PdfReader(io.BytesIO(saved(edited)))
    return original, candidate


class GeneratedLinkLabelRegressions(unittest.TestCase):
    def prepare(self, original, candidate):
        writer = PdfWriter(clone_from=candidate)
        result = labels.prepare_generated_link_labels(original, candidate, writer, visible_paint=worker.simple_link_paint)
        return PdfReader(io.BytesIO(saved(writer))), result

    def test_numeric_broken_citation_uses_only_its_existing_visible_wording(self):
        original, candidate = fixture()
        source_bytes = original.stream.getvalue()
        output, result = self.prepare(original, candidate)
        self.assertEqual(1, len(result['changes']))
        link = semantic.nodes(output)[1]
        self.assertNotIn('/Alt', link)
        self.assertEqual('12 ]', output.pages[0]['/Annots'][0].get_object()['/Contents'])
        self.assertTrue(labels.verify_saved(original, output, result['verification'], visible_paint=worker.simple_link_paint))
        self.assertEqual(source_bytes, original.stream.getvalue())
        self.assertTrue(worker.verify_pdf.structure_inventory(output)['tags'][1]['idTreeVerified'])
        with tempfile.TemporaryDirectory() as folder:
            before, after = Path(folder) / 'source.pdf', Path(folder) / 'output.pdf'
            before.write_bytes(source_bytes); after.write_bytes(output.stream.getvalue())
            report = worker.verify_pdf.compare_pdfs(before, after)
        self.assertTrue(report['preservation']['passed'])
        self.assertTrue(report['navigation']['passed'])
        self.assertTrue(all(page['pixels_identical'] for page in report['preservation']['pages']))
        self.assertFalse(report['navigation']['comparisons'][0]['originalDestinationUnresolved'] is False)

    def test_missing_candidate_contents_can_receive_exact_visible_label(self):
        original, candidate = fixture(candidate_contents=None)
        output, result = self.prepare(original, candidate)
        self.assertEqual(1, len(result['changes']))
        self.assertEqual('12 ]', output.pages[0]['/Annots'][0].get_object()['/Contents'])

    def test_useful_generated_alt_and_every_authored_source_contents_are_preserved(self):
        for contents, alt in ((None, 'The course reading'), ('Annotation', 'Annotation'),
                ('Authored description', 'Annotation'), ('', 'Annotation')):
            with self.subTest(contents=contents, alt=alt):
                original, candidate = fixture(source_contents=contents, alt=alt)
                output, result = self.prepare(original, candidate)
                self.assertEqual([], result['changes'])
                self.assertEqual(alt, semantic.nodes(output)[1]['/Alt'])

    def test_original_tagged_source_is_not_eligible(self):
        _, candidate = fixture()
        with self.assertRaises(labels.GeneratedLinkLabelError):
            self.prepare(candidate, candidate)

    def test_hidden_or_outside_rectangle_text_and_ancestor_overrides_are_skipped(self):
        def hidden(writer):
            stream = writer.pages[0]['/Contents']; stream.set_data(stream.get_data().replace(b'BT ', b'BT 3 Tr ', 1))
        def outside(writer):
            stream = writer.pages[0]['/Contents']; stream.set_data(stream.get_data().replace(b'30 50 Tm', b'130 50 Tm'))
        def actual(writer): semantic.nodes(writer)[0][N('/ActualText')] = S('An override')
        def alt(writer): semantic.nodes(writer)[0][N('/Alt')] = S('An override')
        def expansion(writer): semantic.nodes(writer)[0][N('/E')] = S('An expansion')
        for edit in (hidden, outside, actual, alt, expansion):
            with self.subTest(edit=edit.__name__):
                original, candidate = fixture(callback=edit)
                output, result = self.prepare(original, candidate)
                self.assertEqual([], result['changes'])
                self.assertEqual('Annotation', semantic.nodes(output)[1]['/Alt'])

    def test_changed_navigation_is_never_authorized_by_a_matching_placeholder(self):
        def edit(writer): writer.pages[0]['/Annots'][0].get_object()['/A'][N('/D')] = S('a-different-target')
        original, candidate = fixture(callback=edit)
        with self.assertRaises(labels.GeneratedLinkLabelError):
            self.prepare(original, candidate)

    def test_bad_objr_ownership_or_useful_annotation_description_are_skipped(self):
        def wrong_owner(writer): writer.root_object['/StructTreeRoot']['/ParentTree']['/Nums'][3] = semantic.nodes(writer)[0].indirect_reference
        for contents, callback in (('Annotation', wrong_owner), ('Existing useful generated description', None)):
            with self.subTest(contents=contents):
                original, candidate = fixture(candidate_contents=contents, callback=callback)
                output, result = self.prepare(original, candidate)
                self.assertEqual([], result['changes'])
                self.assertIn('/Alt', semantic.nodes(output)[1])

    def test_saved_check_rejects_changed_description_alt_id_actions_parenttree_and_paint(self):
        original, candidate = fixture()
        output, result = self.prepare(original, candidate)
        for change in ('contents', 'alt', 'id', 'action', 'owner', 'paint'):
            writer = PdfWriter(clone_from=output)
            node = semantic.nodes(writer)[1]; annotation = writer.pages[0]['/Annots'][0].get_object()
            if change == 'contents': annotation[N('/Contents')] = S('Reference 12')
            elif change == 'alt': node[N('/Alt')] = S('Annotation')
            elif change == 'id': node[N('/ID')] = S('other-id')
            elif change == 'action': annotation['/A'][N('/D')] = S('guessed-target')
            elif change == 'owner': writer.root_object['/StructTreeRoot']['/ParentTree']['/Nums'][3] = semantic.nodes(writer)[0].indirect_reference
            else:
                stream = writer.pages[0]['/Contents']; stream.set_data(stream.get_data().replace(b'(12 ])', b'(13 ])'))
            changed = PdfReader(io.BytesIO(saved(writer)))
            with self.subTest(change=change), self.assertRaises(labels.GeneratedLinkLabelError):
                labels.verify_saved(original, changed, result['verification'], visible_paint=worker.simple_link_paint)
        with self.assertRaises(labels.GeneratedLinkLabelError):
            labels.verify_saved(original, output, {'approved': True}, visible_paint=worker.simple_link_paint)

    def test_small_original_glyph_overhang_is_supported_but_unrelated_visible_duplicates_are_not_evidence(self):
        for variant in ('overhang', 'duplicate'):
            original, candidate = fixture()
            changed = []
            for reader in (original, candidate):
                writer = PdfWriter(clone_from=reader)
                if variant == 'overhang':
                    writer.pages[0]['/Annots'][0].get_object()['/Rect'][2] = I(47)
                else:
                    stream = writer.pages[0]['/Contents']
                    stream.set_data(stream.get_data().replace(b'30 50 Tm', b'130 50 Tm')
                        + b' BT /F 10 Tf 1 0 0 1 30 50 Tm (12 ]) Tj ET')
                changed.append(PdfReader(io.BytesIO(saved(writer))))
            with self.subTest(variant=variant):
                output, result = self.prepare(*changed)
                self.assertEqual(1 if variant == 'overhang' else 0, len(result['changes']))


if __name__ == '__main__':
    unittest.main()
