"""Generic regressions for native Artifact owners of existing Figure paint."""
import io
from pathlib import Path
import tempfile
import unittest

from pypdf import PdfReader, PdfWriter
from pypdf.generic import (ArrayObject, DictionaryObject, NameObject as N,
    NumberObject as I, TextStringObject as S)

import worker
import bounded_semantic_structure as semantic
import bounded_excluded_figures as excluded
from test_native_pdf_validation import figure_reader


DESCRIPTION = "A filled black rectangle with the complete visible wording Label0."


def fixture(*, kind="vector", callback=None):
    def excluded_owner(writer, page, root, document, refs, stream, asset):
        owner = refs[0].get_object()
        owner[N('/S')] = N('/Artifact')
        del owner['/Alt']
        owner[N('/ID')] = S('asset-0')
        owner[N('/A')] = DictionaryObject({N('/O'): N('/Layout'),
            N('/BBox'): ArrayObject([I(n) for n in (20, 20, 50, 50)])})
        root[N('/IDTree')] = DictionaryObject({N('/Names'): ArrayObject([S('asset-0'), refs[0]])})
        if callback:
            callback(writer, page, root, document, refs, stream, asset)
    return figure_reader(kind=kind, alts=('unused', 'A useful unchanged authored description.'), callback=excluded_owner)


def bytes_of(reader):
    writer = PdfWriter(clone_from=reader)
    output = io.BytesIO()
    writer.write(output)
    return output.getvalue()


def subtree_fixture(callback=None):
    def descendants(writer, page, root, document, refs, stream, asset):
        owner = refs[0].get_object()
        caption = DictionaryObject({N('/Type'): N('/StructElem'), N('/S'): N('/Caption'),
            N('/P'): refs[0], N('/ID'): S('caption-0')})
        caption_ref = writer._add_object(caption)
        children = []
        for mcid, label in ((2, 'year-a'), (3, 'year-b')):
            child = DictionaryObject({N('/Type'): N('/StructElem'), N('/S'): N('/P'),
                N('/P'): caption_ref, N('/Pg'): page.indirect_reference,
                N('/K'): I(mcid), N('/ID'): S(label)})
            children.append(writer._add_object(child))
        caption[N('/K')] = ArrayObject(children)
        owner[N('/K')] = ArrayObject([I(0), caption_ref])
        root['/IDTree'][N('/Names')] = ArrayObject([S('asset-0'), refs[0],
            S('caption-0'), caption_ref, S('year-a'), children[0], S('year-b'), children[1]])
        root['/ParentTree']['/Nums'][1].extend(children)
        stream.set_data(stream.get_data() + b' /P << /MCID 2 >> BDC BT /F1 10 Tf 20 75 Td (2018 2019 2020) Tj ET EMC'
            b' /P << /MCID 3 >> BDC BT /F1 10 Tf 20 95 Td (2021 2022 2023) Tj ET EMC')
        if callback:
            callback(writer, page, root, owner, caption, children, stream)
    return fixture(callback=descendants)


class ExcludedFigureRegressions(unittest.TestCase):
    def operation(self, reader):
        candidates = excluded.discover_candidates(reader)
        self.assertEqual(1, len(candidates))
        self.assertEqual('restore_excluded_figure', candidates[0]['kind'])
        return {'type': 'repair_structure', 'tagId': candidates[0]['tagId'],
            'candidateId': candidates[0]['candidateId'], 'alt': DESCRIPTION}

    def apply(self, reader):
        writer = PdfWriter(clone_from=reader)
        result = excluded.apply_operations(reader, writer, [self.operation(reader)])
        data = io.BytesIO()
        writer.write(data)
        return PdfReader(io.BytesIO(data.getvalue())), result, data.getvalue()

    def test_verified_excluded_owner_is_discovered_without_losing_its_id_or_layout_attributes(self):
        reader = fixture()
        candidate = excluded.discover_candidates(reader)[0]
        self.assertEqual('tag-2', candidate['tagId'])
        self.assertEqual(1, candidate['pageNumber'])
        self.assertIn('Label0', candidate['text'])
        self.assertEqual([], candidate['relatedTagIds'])

    def test_saved_restoration_preserves_paint_native_identity_attributes_and_other_descriptions(self):
        reader = fixture()
        source = bytes_of(reader)
        output, result, output_bytes = self.apply(reader)
        self.assertTrue(excluded.verify_saved(output, result['verification']))
        inventory = worker.verify_pdf.structure_inventory(output)
        tag = next(tag for tag in inventory['tags'] if tag.get('nativeId') == 'asset-0')
        self.assertEqual('Figure', tag['role'])
        self.assertEqual(DESCRIPTION, tag['alt'])
        self.assertTrue(tag['idTreeVerified'])
        self.assertEqual('Layout', tag['attributes'][0]['owner'])
        self.assertEqual(source, bytes_of(reader))
        with tempfile.TemporaryDirectory() as directory:
            before, after = Path(directory) / 'source.pdf', Path(directory) / 'output.pdf'
            before.write_bytes(source); after.write_bytes(output_bytes)
            report = worker.verify_pdf.compare_pdfs(before, after)
        self.assertTrue(report['preservation']['passed'])
        self.assertTrue(all(page['pixels_identical'] for page in report['preservation']['pages']))
        self.assertTrue(report['figure_associations']['passed'])
        self.assertEqual(1, len(result['changes']))

    def test_image_paint_and_nested_nonsemantic_clip_wrappers_are_supported(self):
        def clip(writer, page, root, document, refs, stream, asset):
            stream.set_data(stream.get_data().replace(b'q 30 0 0 30 20 20 cm', b'/ClipSpan BMC q 30 0 0 30 20 20 cm', 1)
                .replace(b'/Im0 Do Q EMC', b'/Im0 Do Q EMC EMC', 1))
        reader = fixture(kind='image', callback=clip)
        output, result, _ = self.apply(reader)
        self.assertTrue(excluded.verify_saved(output, result['verification']))

    def test_authored_or_ancestor_alternatives_are_never_overridden(self):
        for where, key, value in ((0, '/Alt', ''), (0, '/ActualText', 'existing'),
                (-1, '/Alt', 'parent description'), (-1, '/ActualText', 'parent text')):
            def edit(writer, page, root, document, refs, stream, asset):
                target = document if where == -1 else refs[where].get_object()
                target[N(key)] = S(value)
            with self.subTest(where=where, key=key):
                self.assertEqual([], excluded.discover_candidates(fixture(callback=edit)))

    def test_ambiguous_or_artifact_paint_and_unverified_parent_owners_are_declined(self):
        def wrong_wrapper(writer, page, root, document, refs, stream, asset):
            stream.set_data(stream.get_data().replace(b'/Figure << /MCID 0', b'/P << /MCID 0', 1))
        def hidden(writer, page, root, document, refs, stream, asset):
            stream.set_data(b'/Artifact BMC ' + stream.get_data() + b' EMC')
        def duplicate(writer, page, root, document, refs, stream, asset):
            stream.set_data(stream.get_data().replace(b'/MCID 1', b'/MCID 0'))
        def wrong_owner(writer, page, root, document, refs, stream, asset):
            root['/ParentTree']['/Nums'][1][0] = refs[1]
        for edit in (wrong_wrapper, hidden, duplicate, wrong_owner):
            with self.subTest(edit=edit.__name__):
                self.assertEqual([], excluded.discover_candidates(fixture(callback=edit)))

    def test_unsupported_form_paint_is_not_guessed(self):
        self.assertEqual([], excluded.discover_candidates(fixture(kind='form')))

    def test_stale_duplicate_or_extra_plan_fields_are_refused_before_mutation(self):
        reader = fixture()
        operation = self.operation(reader)
        variants = [[dict(operation, candidateId='0' * 64)], [operation, dict(operation)],
            [dict(operation, file='/outside.pdf')], [dict(operation, alt='image 1')],
            [operation, dict(operation, candidateId='0' * 64)]]
        for operations in variants:
            writer = PdfWriter(clone_from=reader)
            before = [str(node.get('/S')) for node in semantic.nodes(writer)]
            with self.subTest(operations=operations), self.assertRaises(excluded.ExcludedFigureError):
                excluded.apply_operations(reader, writer, operations)
            self.assertEqual(before, [str(node.get('/S')) for node in semantic.nodes(writer)])

    def test_candidate_id_is_bound_to_the_actual_source_bytes(self):
        reader = fixture()
        operation = self.operation(reader)
        writer = PdfWriter(clone_from=reader)
        writer.add_metadata({'/Subject': 'a different exact source'})
        different = io.BytesIO(); writer.write(different)
        other = PdfReader(io.BytesIO(different.getvalue()))
        with self.assertRaises(excluded.ExcludedFigureError):
            excluded.apply_operations(other, PdfWriter(clone_from=other), [operation])

    def test_saved_verifier_rejects_changed_role_alt_id_attributes_ownership_and_paint(self):
        reader = fixture()
        delivered, result, _ = self.apply(reader)
        for field in ('alt', 'role', 'id', 'attributes', 'parenttree', 'paint'):
            writer = PdfWriter(clone_from=delivered)
            owner = next(node for node in semantic.nodes(writer) if node.get('/ID') == 'asset-0')
            if field == 'alt': owner[N('/Alt')] = S('A changed guess')
            elif field == 'role': owner[N('/S')] = N('/P')
            elif field == 'id': owner[N('/ID')] = S('different-id')
            elif field == 'attributes': owner['/A'][N('/BBox')][0] = I(21)
            elif field == 'parenttree': writer.root_object['/StructTreeRoot']['/ParentTree']['/Nums'][1][0] = writer.root_object['/StructTreeRoot']['/K'][0]
            else:
                stream = writer.pages[0]['/Contents']
                stream.set_data(stream.get_data().replace(b'20 20 30 20 re', b'21 20 30 20 re'))
            output = io.BytesIO(); writer.write(output)
            with self.subTest(field=field), self.assertRaises(excluded.ExcludedFigureError):
                excluded.verify_saved(PdfReader(io.BytesIO(output.getvalue())), result['verification'])
        with self.assertRaises(excluded.ExcludedFigureError):
            excluded.verify_saved(delivered, {'approved': True})

    def test_original_id_node_maps_allow_unrelated_preorder_insertions(self):
        reader = fixture()
        operation = self.operation(reader)
        writer = PdfWriter(clone_from=reader)
        tags = worker.verify_pdf.structure_inventory(reader)['tags']
        source_nodes = dict(zip((tag['id'] for tag in tags), semantic.nodes(reader)))
        target_nodes = dict(zip(source_nodes, semantic.nodes(writer)))
        parent = target_nodes['tag-1']
        new = DictionaryObject({N('/Type'): N('/StructElem'), N('/S'): N('/Div'), N('/P'): parent.indirect_reference})
        parent['/K'].insert(0, writer._add_object(new))
        result = excluded.apply_operations(reader, writer, [operation],
            _source_nodes=source_nodes, _target_nodes=target_nodes)
        output = io.BytesIO(); writer.write(output)
        self.assertTrue(excluded.verify_saved(PdfReader(io.BytesIO(output.getvalue())), result['verification']))

    def test_bounded_caption_paragraph_subtree_is_exposed_with_every_related_tag(self):
        reader = subtree_fixture()
        option = excluded.discover_candidates(reader)[0]
        self.assertEqual(['tag-3', 'tag-4', 'tag-5'], option['relatedTagIds'])
        self.assertIn('2018 2019 2020', option['text'])
        self.assertIn('2021 2022 2023', option['text'])

    def test_subtree_restoration_preserves_children_roles_order_ids_and_default_preservation(self):
        reader = subtree_fixture()
        output, result, delivered = self.apply(reader)
        self.assertTrue(excluded.verify_saved(output, result['verification']))
        tags = worker.verify_pdf.structure_inventory(output)['tags']
        self.assertEqual(['Figure', 'Caption', 'P', 'P'], [tag['role'] for tag in tags[1:5]])
        self.assertTrue(all(tag['idTreeVerified'] for tag in tags[1:5]))
        self.assertEqual([[0], [], [2], [3]], [tag['mcids'] for tag in tags[1:5]])
        with tempfile.TemporaryDirectory() as folder:
            before, after = Path(folder) / 'source.pdf', Path(folder) / 'output.pdf'
            before.write_bytes(bytes_of(reader)); after.write_bytes(delivered)
            report = worker.verify_pdf.compare_pdfs(before, after)
        self.assertTrue(report['preservation']['passed'])
        self.assertTrue(all(page['pixels_identical'] for page in report['preservation']['pages']))
        self.assertTrue(report['figure_associations']['passed'])

    def test_descendant_authored_descriptions_or_complex_roles_are_not_supported(self):
        for attribute, value in (('/Alt', S('existing')), ('/ActualText', S('existing')),
                ('/S', N('/Table')), ('/AA', DictionaryObject())):
            def edit(writer, page, root, owner, caption, children, stream):
                children[0].get_object()[N(attribute)] = value
            with self.subTest(attribute=attribute, value=value):
                self.assertEqual([], excluded.discover_candidates(subtree_fixture(edit)))

    def test_saved_subtree_cannot_change_descendant_roles_ids_order_or_owners(self):
        reader = subtree_fixture()
        delivered, result, _ = self.apply(reader)
        for change in ('role', 'id', 'order', 'parenttree', 'parent'):
            writer = PdfWriter(clone_from=delivered)
            native = semantic.nodes(writer)
            caption = next(node for node in native if node.get('/ID') == 'caption-0')
            child = next(node for node in native if node.get('/ID') == 'year-a')
            if change == 'role': child[N('/S')] = N('/H2')
            elif change == 'id': child[N('/ID')] = S('changed')
            elif change == 'order': caption[N('/K')] = ArrayObject(list(reversed(caption['/K'])))
            elif change == 'parenttree': writer.root_object['/StructTreeRoot']['/ParentTree']['/Nums'][1][2] = caption.indirect_reference
            else: child[N('/P')] = next(node for node in native if node.get('/ID') == 'asset-0').indirect_reference
            data = io.BytesIO(); writer.write(data)
            with self.subTest(change=change), self.assertRaises(excluded.ExcludedFigureError):
                excluded.verify_saved(PdfReader(io.BytesIO(data.getvalue())), result['verification'])

    def test_descendant_unverified_ownership_other_page_and_graphics_are_not_guessed(self):
        def wrong_owner(writer, page, root, owner, caption, children, stream):
            root['/ParentTree']['/Nums'][1][2] = children[1]
        def other_page(writer, page, root, owner, caption, children, stream):
            another = writer.add_blank_page(width=200, height=100)
            children[0].get_object()[N('/Pg')] = another.indirect_reference
        def graphics(writer, page, root, owner, caption, children, stream):
            stream.set_data(stream.get_data().replace(b'(2018 2019 2020) Tj ET EMC',
                b'(2018 2019 2020) Tj ET 0 0 10 10 re f EMC'))
        for edit in (wrong_owner, other_page, graphics):
            with self.subTest(edit=edit.__name__):
                self.assertEqual([], excluded.discover_candidates(subtree_fixture(edit)))


if __name__ == '__main__':
    unittest.main()
