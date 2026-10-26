"""Regression coverage for explicit grids that the two-column path misses."""
import io
import json
import os
import subprocess
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "research/native-pdf"))
from pypdf import PdfReader, PdfWriter
from pypdf.generic import ArrayObject, ByteStringObject, DecodedStreamObject, DictionaryObject, NameObject as N, NumberObject as I, TextStringObject
import bounded_semantic_structure as b
import bounded_grid_table_structure as grid
import verify_pdf as v
from test_bounded_table_structure import saved, selected, fixture as legacy_fixture


def explicit_grid(*, columns=3, independent=False, list_last=False, ambiguous=False, protected=False, wrapped=False, row_values=None, column_spacing=110, row_gap=22, fragmented_note=False):
    writer = PdfWriter()
    page = writer.add_blank_page(620, 360)
    font = writer._add_object(DictionaryObject({N('/Type'): N('/Font'), N('/Subtype'): N('/Type1'), N('/BaseFont'): N('/Helvetica'), N('/Encoding'): N('/WinAnsiEncoding'), N('/FirstChar'): I(32), N('/LastChar'): I(126), N('/Widths'): ArrayObject([I(500)] * 95)}))
    page[N('/Resources')] = DictionaryObject({N('/Font'): DictionaryObject({N('/F'): font})})
    root = DictionaryObject({N('/Type'): N('/StructTreeRoot')})
    root_ref = writer._add_object(root)
    document = DictionaryObject({N('/Type'): N('/StructElem'), N('/S'): N('/Document'), N('/P'): root_ref})
    document_ref = writer._add_object(document)
    root[N('/K')] = document_ref
    children, owners, programs = [], [], []

    def text_tag(role, parent, mcid, program):
        node = DictionaryObject({N('/Type'): N('/StructElem'), N('/S'): N('/' + role), N('/P'): parent, N('/Pg'): page.indirect_reference, N('/K'): I(mcid)})
        ref = writer._add_object(node)
        owners.append(ref)
        programs.append(f'/P << /MCID {mcid} >> BDC\n{program}\nEMC\n')
        return ref

    children.append(text_tag('P', document_ref, 0, 'BT /F 10 Tf 1 0 0 1 30 325 Tm (Table 1. Synthetic grouped measures) Tj ET'))
    rows = [['Measure', *('Group ' + chr(65 + i) for i in range(columns - 1))], ['Alpha', *(str(i + 1) for i in range(columns - 1))], ['Beta', *(str(i + 3) for i in range(columns - 1))], ['Gamma', *(str(i + 5) for i in range(columns - 1))]]
    if row_values is not None:
        rows = row_values
    xs = [30 + column_spacing * i for i in range(columns)]
    for row_index, row in enumerate(rows):
        y = 285 - row_index * row_gap
        mcid = len(owners)
        if list_last and row_index >= len(rows) - int(list_last):
            reuse = bool(children and v.resolved(children[-1]).get('/S') == '/L')
            container = v.resolved(children[-1]) if reuse else DictionaryObject({N('/Type'): N('/StructElem'), N('/S'): N('/L'), N('/P'): document_ref})
            container_ref = container.indirect_reference if reuse else writer._add_object(container)
            item = DictionaryObject({N('/Type'): N('/StructElem'), N('/S'): N('/LI'), N('/P'): container_ref})
            item_ref = writer._add_object(item)
            label = text_tag('Lbl', item_ref, mcid, f'BT /F 10 Tf 1 0 0 1 {xs[0]} {y} Tm ({row[0]}) Tj ET')
            body_ops = ' '.join(f'1 0 0 1 {x} {y} Tm ({word}) Tj' for x, word in zip(xs[1:], row[1:]))
            body = text_tag('LBody', item_ref, mcid + 1, f'BT /F 10 Tf {body_ops} ET')
            item[N('/K')] = ArrayObject([label, body])
            container[N('/K')] = ArrayObject([*container.get('/K', []), item_ref])
            if not reuse: children.append(container_ref)
            continue
        if independent:
            parts = ' '.join(f'1 0 0 1 {x + (45 if ambiguous and column == columns - 1 and row_index == 2 else 0)} {y} Tm ({word}) Tj' for column, (x, word) in enumerate(zip(xs, row)) if word)
            program = f'BT /F 10 Tf {parts} ET'
        else:
            pieces = []
            end = xs[0]
            for x, word in zip(xs, row):
                if not word:
                    continue
                if pieces:
                    pieces.append(str(-(x - end) * 100))
                pieces.append('(' + word + ')')
                end = x + len(word) * 5
            program = f'BT /F 10 Tf 1 0 0 1 {xs[0]} {y} Tm [{" ".join(pieces)}] TJ ET'
        children.append(text_tag('P', document_ref, mcid, program))
        if wrapped and row_index == 0:
            continuation = ' '.join(f'1 0 0 1 {x} {y - 12} Tm (Publication) Tj' for x in xs[2:])
            children.append(text_tag('P', document_ref, len(owners), f'BT /F 10 Tf {continuation} ET'))
    note = 'BT /F 10 Tf 1 0 0 1 30 100 Tm (Source note retained.) Tj ET'
    if fragmented_note:
        note = 'BT /F 8 Tf ' + ' '.join(f'1 0 0 1 {x} 224 Tm ({word}) Tj' for x, word in [(30, 'Source'), (60, 'note'), (85, 'is'), (100, 'retained'), (145, 'unchanged'), (200, 'here.')]) + ' ET'
    children.append(text_tag('P', document_ref, len(owners), note))
    document[N('/K')] = ArrayObject(children)
    if protected:
        document[N('/ActualText')] = TextStringObject('Protected authored alternative')
    root[N('/ParentTree')] = writer._add_object(DictionaryObject({N('/Nums'): ArrayObject([I(0), ArrayObject(owners)])}))
    root[N('/ParentTreeNextKey')] = I(1)
    page[N('/StructParents')] = I(0)
    writer.root_object[N('/StructTreeRoot')] = root_ref
    writer.root_object[N('/Lang')] = TextStringObject('en-US')
    stream = DecodedStreamObject()
    stream.set_data(''.join(programs).encode('ascii'))
    page[N('/Contents')] = writer._add_object(stream)
    return writer


class GridTableReliabilityTests(unittest.TestCase):
    def source(self, **kwargs):
        return PdfReader(io.BytesIO(saved(explicit_grid(**kwargs))))

    def repaired(self, **kwargs):
        source = self.source(**kwargs)
        candidates = grid.discover_candidates(source)
        self.assertEqual(len(candidates), 1, 'A captioned aligned grid needs an automatic source-bound repair candidate')
        writer = PdfWriter(clone_from=source)
        old = list(b.nodes(writer))
        proof = grid.apply_operations(source, writer, [selected(candidates[0])])
        output = saved(writer)
        reopened = PdfReader(io.BytesIO(output))
        self.assertTrue(grid.verify_saved(reopened, proof['verification']))
        self.assertTrue(all(any(node is original for node in b.nodes(writer)) for original in old))
        self.assertEqual(source.pages[0].extract_text(), reopened.pages[0].extract_text())
        with tempfile.TemporaryDirectory() as directory:
            before, after = Path(directory) / 'source.pdf', Path(directory) / 'output.pdf'
            before.write_bytes(source.stream.getvalue())
            after.write_bytes(output)
            comparison = v.compare_pdfs(before, after)
        self.assertTrue(comparison['preservation']['passed'], comparison['findings'])
        self.assertTrue(comparison['preservation']['pages'][0]['pixels_identical'])
        return reopened, proof

    def test_three_aligned_tj_columns_become_native_cells(self):
        reopened, _ = self.repaired(columns=3)
        tags = v.structure_inventory(reopened)['tags']
        self.assertEqual(sum(tag['role'] == 'Table' for tag in tags), 1)
        self.assertEqual(sum(tag['role'] == 'TR' for tag in tags), 4)
        self.assertEqual(sum(tag['role'] == 'TD' for tag in tags), 6)

    def test_five_independently_positioned_columns_have_explicit_headers(self):
        reopened, _ = self.repaired(columns=5, independent=True)
        inventory = v.structure_inventory(reopened)
        cells = [tag for tag in inventory['tags'] if tag['role'] == 'TD']
        self.assertEqual(len(cells), 12)
        self.assertTrue(all(len(next(a for a in tag['attributes'] if a['owner'] == 'Table')['headersHex']) == 2 for tag in cells))

    def test_obvious_list_misclassification_inside_an_aligned_grid_is_repaired(self):
        reopened, _ = self.repaired(columns=3, independent=True, list_last=True)
        tags = v.structure_inventory(reopened)['tags']
        self.assertFalse(any(tag['role'] in ('L', 'LI', 'Lbl', 'LBody') for tag in tags))
        self.assertEqual(sum(tag['role'] == 'TR' for tag in tags), 4)

    def test_wrapped_column_labels_under_separate_original_nodes_are_kept(self):
        reopened, _ = self.repaired(columns=5, independent=True, wrapped=True)
        tags = v.structure_inventory(reopened)['tags']
        by_id = {tag['id']: tag for tag in tags}
        descriptions = [tag for tag in tags if 'Publication' in tag['text']]
        self.assertEqual(len(descriptions), 3)
        self.assertTrue(all(by_id[tag['parentId']]['role'] == 'TH' for tag in descriptions))

    def test_grouped_rows_keep_source_labels_and_explicit_row_spans(self):
        rows = [['Characteristic', 'Variable', 'Group A', 'Group B', 'Probability'],
                ['Authorship', 'Mean (SD)', '5.2', '6.8', '0.01'],
                ['', '1-2', '15', '10', '0.05'],
                ['Funding', 'Public', '30', '40', '0.25']]
        reopened, _ = self.repaired(columns=5, independent=True, row_values=rows)
        tags = v.structure_inventory(reopened)['tags']
        by_id = {tag['id']: tag for tag in tags}
        label = next(tag for tag in tags if tag['text'].strip() == 'Authorship')
        group = by_id[label['parentId']]
        self.assertEqual(group['role'], 'TH')
        self.assertEqual(next(a for a in group['attributes'] if a['owner'] == 'Table')['rowSpan'], 2)
        values = [tag for tag in tags if tag['role'] == 'TD']
        self.assertEqual(len(values), 9)
        self.assertTrue(all(len(next(a for a in tag['attributes'] if a['owner'] == 'Table')['headersHex']) == 3 for tag in values))

    def test_numeric_reference_labels_do_not_hide_explicit_data_columns(self):
        rows = [['Characteristic', 'Variable', 'Group A', 'Group B', 'Probability'],
                ['Authorship', 'Mean (SD)', '1 (rc)', '6.8', '0.01'],
                ['', '1-2', '1 (rc)', '10', '0.05'],
                ['Funding', 'Public', '30', '40', '0.25']]
        reopened, _ = self.repaired(columns=5, independent=True, row_values=rows)
        self.assertEqual(sum(tag['role'] == 'Table' for tag in v.structure_inventory(reopened)['tags']), 1)

    def test_narrow_explicit_tj_gaps_still_define_clear_aligned_cells(self):
        reopened, _ = self.repaired(columns=3, column_spacing=70)
        self.assertEqual(sum(tag['role'] == 'TD' for tag in v.structure_inventory(reopened)['tags']), 6)

    def test_fragmented_source_footnote_after_compact_rows_stays_outside(self):
        reopened, _ = self.repaired(columns=3, independent=True, row_gap=12, fragmented_note=True)
        tags = v.structure_inventory(reopened)['tags']
        note = next(tag for tag in tags if tag['text'].startswith('Source note'))
        self.assertEqual(next(tag for tag in tags if tag['id'] == note['parentId'])['role'], 'Document')

    def test_model_cannot_supply_cells_or_replay_a_candidate(self):
        source = self.source(columns=5, independent=True)
        operation = selected(grid.discover_candidates(source)[0])
        for extra in ({'rows': []}, {'offset': 12}, {'role': 'TH'}, {'candidateId': '0' * 64}):
            with self.subTest(extra=extra), self.assertRaises(b.SemanticStructureError):
                grid.apply_operations(source, PdfWriter(clone_from=source), [{**operation, **extra}])
        with self.assertRaises(b.SemanticStructureError):
            grid.apply_operations(source, PdfWriter(clone_from=source), [operation, operation])
        changed = PdfWriter(clone_from=source)
        changed.add_metadata({'/Subject': 'A different exact source'})
        other = PdfReader(io.BytesIO(saved(changed)))
        with self.assertRaises(b.SemanticStructureError):
            grid.apply_operations(other, PdfWriter(clone_from=other), [operation])

    def test_saved_header_membership_metadata_or_paint_changes_fail(self):
        source = self.source(columns=5, independent=True, list_last=True)
        writer = PdfWriter(clone_from=source)
        proof = grid.apply_operations(source, writer, [selected(grid.discover_candidates(source)[0])])
        output = saved(writer)
        for mutation in ('headers', 'scope', 'parent', 'body', 'membership', 'metadata', 'paint'):
            altered = PdfWriter(clone_from=PdfReader(io.BytesIO(output)))
            nodes = b.nodes(altered)
            if mutation == 'headers':
                next(node for node in nodes if node['/S'] == '/TD')['/A'][N('/Headers')] = ArrayObject()
            elif mutation == 'scope':
                next(node for node in nodes if node['/S'] == '/TH')['/A'][N('/Scope')] = N('/Row')
            elif mutation == 'parent':
                row = next(node for node in nodes if node['/S'] == '/TR')
                next(node for node in nodes if node['/S'] == '/TD')[N('/P')] = row.indirect_reference
            elif mutation == 'body':
                next(node for node in nodes if node['/S'] == '/TBody')[N('/S')] = N('/Div')
            elif mutation == 'membership':
                body = next(node for node in nodes if node['/S'] == '/TBody')
                table = v.resolved(body['/P'])
                row = v.resolved(body['/K'][0])
                body[N('/K')] = ArrayObject()
                index = next(i for i, child in enumerate(table['/K']) if v.resolved(child) is body)
                table['/K'].insert(index, row.indirect_reference)
                row[N('/P')] = table.indirect_reference
            elif mutation == 'metadata':
                next(node for node in nodes if node['/S'] == '/TH')[N('/Alt')] = TextStringObject('Injected description')
            else:
                page = altered.pages[0]
                stream = DecodedStreamObject()
                data = page.get_contents().get_data()
                replacement = data.replace(b'416c706861', b'4f6d656761')
                self.assertNotEqual(data, replacement)
                stream.set_data(replacement)
                page[N('/Contents')] = altered._add_object(stream)
            with self.subTest(mutation=mutation), self.assertRaises(b.SemanticStructureError):
                grid.verify_saved(PdfReader(io.BytesIO(saved(altered))), proof['verification'])

    def test_existing_list_node_ids_survive_reclassification(self):
        writer = explicit_grid(columns=5, independent=True, list_last=True)
        entries = []
        original_ids = {}
        for index, node in enumerate(b.nodes(writer)):
            if node['/S'] in ('/L', '/LI', '/Lbl', '/LBody'):
                identity = f'authored-{index:03d}'.encode()
                node[N('/ID')] = ByteStringObject(identity)
                entries.extend([ByteStringObject(identity), node.indirect_reference])
                original_ids[identity.hex()] = node['/S']
                if node['/S'] == '/L':
                    node[N('/A')] = DictionaryObject({N('/O'): N('/List'), N('/ListNumbering'): N('/None')})
        writer.root_object['/StructTreeRoot'][N('/IDTree')] = writer._add_object(DictionaryObject({N('/Names'): ArrayObject(entries)}))
        source = PdfReader(io.BytesIO(saved(writer)))
        target = PdfWriter(clone_from=source)
        proof = grid.apply_operations(source, target, [selected(grid.discover_candidates(source)[0])])
        reopened = PdfReader(io.BytesIO(saved(target)))
        self.assertTrue(grid.verify_saved(reopened, proof['verification']))
        final_ids = {tag['nativeIdHex']: tag for tag in v.structure_inventory(reopened)['tags'] if 'nativeIdHex' in tag}
        expected = {'/L': 'TBody', '/LI': 'TR', '/Lbl': 'P', '/LBody': 'P'}
        self.assertTrue(all(final_ids[identity]['role'] == expected[role] and final_ids[identity]['idTreeVerified'] for identity, role in original_ids.items()))

    def test_unsupported_list_semantics_and_uncaptioned_content_decline(self):
        writer = explicit_grid(columns=5, independent=True, list_last=True)
        next(node for node in b.nodes(writer) if node['/S'] == '/L')[N('/A')] = DictionaryObject({N('/O'): N('/List'), N('/ListNumbering'): N('/Decimal')})
        self.assertEqual(grid.discover_candidates(PdfReader(io.BytesIO(saved(writer)))), [])
        writer = explicit_grid(columns=3)
        page = writer.pages[0]
        stream = DecodedStreamObject()
        stream.set_data(page.get_contents().get_data().replace(b'Table 1.', b'Notes 1.'))
        page[N('/Contents')] = writer._add_object(stream)
        self.assertEqual(grid.discover_candidates(PdfReader(io.BytesIO(saved(writer)))), [])

    def test_authored_overrides_and_inconsistent_columns_remain_unselected(self):
        self.assertEqual(grid.discover_candidates(self.source(columns=3, independent=True, protected=True)), [])
        self.assertEqual(grid.discover_candidates(self.source(columns=3, independent=True, ambiguous=True)), [])
        # Existing deliberately inconsistent third-column fixture stays rejected.
        source = PdfReader(io.BytesIO(saved(legacy_fixture(three_columns=True))))
        self.assertEqual(grid.discover_candidates(source), [])



class GridCompositionReliabilityTests(unittest.TestCase):
    def test_unrelated_heading_fix_does_not_invalidate_a_nested_table_row(self):
        source=PdfReader(io.BytesIO(saved(explicit_grid(columns=3,independent=True,list_last=True))))
        candidate=grid.discover_candidates(source)[0]
        writer=PdfWriter(clone_from=source)
        # A separately verified role fix outside the table changes no cell.
        b.nodes(writer)[-1][N('/S')]=N('/H2')
        proof=grid.apply_operations(source,writer,[selected(candidate)])
        reopened=PdfReader(io.BytesIO(saved(writer)))
        self.assertTrue(grid.verify_saved(reopened,proof['verification']))
        self.assertEqual(b.nodes(reopened)[-1]['/S'],'/H2')

    def test_candidate_ids_are_stable_across_independent_worker_hash_seeds(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'source.pdf'
            path.write_bytes(saved(explicit_grid(columns=3,independent=True,list_last=2)))
            command="import json,sys;from pypdf import PdfReader;import bounded_grid_table_structure as g;print(json.dumps(g.discover_candidates(PdfReader(sys.argv[1]))))"
            pythonpath=os.pathsep.join([str(Path(__file__).parent.resolve()),str(Path(__file__).resolve().parents[2]/'research/native-pdf')])
            outputs=[]
            for seed in ('1','2','7','31'):
                result=subprocess.run([sys.executable,'-c',command,str(path)],env={**os.environ,'PYTHONPATH':pythonpath,'PYTHONHASHSEED':seed},capture_output=True,text=True,check=True,timeout=20)
                candidates=json.loads(result.stdout)
                self.assertEqual(len(candidates),1)
                outputs.append(candidates)
            self.assertTrue(all(output==outputs[0] for output in outputs))
