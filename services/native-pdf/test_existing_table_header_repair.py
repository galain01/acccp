"""Existing salary tables need row/column context without repainting pages."""
import io
from pathlib import Path
import sys
import tempfile
import unittest

from pypdf import PdfReader, PdfWriter
from pypdf.generic import (ArrayObject, BooleanObject, DecodedStreamObject,
                          DictionaryObject, NameObject as N, NumberObject as I,
                          TextStringObject as S)

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "research/native-pdf"))
import verify_pdf as v
import bounded_semantic_structure as semantic
import native_structure_pipeline as pipeline
import native_structure_repairs as identifiers
import worker
try:
    import bounded_existing_table_headers as headers
except ModuleNotFoundError:
    headers = None


HIGHER = "Higher Paying Job Annual Taxable Wage & Salary"
LOWER = "Lower Paying Job Annual Taxable Wage & Salary"


def saved(writer):
    stream = io.BytesIO()
    writer.write(stream)
    return stream.getvalue()


def fixture(*, columns=3, rows=3, axes=True, protected=None, ragged=False,
            invalid_headers=False, duplicate_owner=False, unknown_cell=False,
            wrapped_axes=False):
    writer = PdfWriter()
    page = writer.add_blank_page(720, 500)
    font = writer._add_object(DictionaryObject({N('/Type'): N('/Font'), N('/Subtype'): N('/Type1'),
        N('/BaseFont'): N('/Helvetica'), N('/Encoding'): N('/WinAnsiEncoding'),
        N('/FirstChar'): I(32), N('/LastChar'): I(126), N('/Widths'): ArrayObject([I(500)] * 95)}))
    page[N('/Resources')] = DictionaryObject({N('/Font'): DictionaryObject({N('/F'): font})})
    root = DictionaryObject({N('/Type'): N('/StructTreeRoot')})
    root_ref = writer._add_object(root)
    document = DictionaryObject({N('/Type'): N('/StructElem'), N('/S'): N('/Document'), N('/P'): root_ref})
    doc_ref = writer._add_object(document)
    root[N('/K')] = doc_ref
    owners, programs, children, ids = [], [], [], {}

    def node(role, parent, text=None, x=20, y=470, font_size=7):
        tag = DictionaryObject({N('/Type'): N('/StructElem'), N('/S'): N('/' + role),
            N('/P'): parent, N('/Pg'): page.indirect_reference})
        ref = writer._add_object(tag)
        if text is not None:
            mcid = len(owners)
            tag[N('/K')] = I(mcid)
            owners.append(ref)
            escaped = text.replace('\\', '\\\\').replace('(', '\\(').replace(')', '\\)')
            programs.append(f'/P << /MCID {mcid} >> BDC BT /F {font_size} Tf 1 0 0 1 {x} {y} Tm ({escaped}) Tj ET EMC\n')
        return tag, ref

    caption, caption_ref = node('H2', doc_ref, 'Synthetic wage intersections', y=478)
    children.append(caption_ref)
    axis_refs = []
    if axes:
        section_ref, axis_groups = None, []
        if wrapped_axes:
            section, section_ref = node('Sect', doc_ref)
            children.append(section_ref)
        for index, text in enumerate((HIGHER, LOWER)):
            if wrapped_axes:
                group, group_ref = node('Div', section_ref)
                axis_groups.append(group_ref)
            axis, axis_ref = node('P', group_ref if wrapped_axes else doc_ref,
                                   text, y=463-index*14)
            axis_refs.append(axis_ref)
            if wrapped_axes:
                group[N('/K')] = axis_ref
            else:
                children.append(axis_ref)
        if wrapped_axes:
            section[N('/K')] = ArrayObject(axis_groups)
    table, table_ref = node('Table', doc_ref)
    children.append(table_ref)
    table_rows, cells = [], []
    for ri in range(rows + 1):
        row, row_ref = node('TR', table_ref)
        table_rows.append(row_ref)
        row_cells = []
        width = columns - 1 if ragged and ri == rows else columns
        for ci in range(width):
            role = 'TH' if ri == 0 else ('Div' if unknown_cell and ri == 1 and ci == 1 else 'TD')
            cell, cell_ref = node(role, row_ref)
            if ri == 0:
                key = f'column-{ci}'
                cell[N('/ID')] = S(key)
                ids[key] = cell_ref
                cell[N('/A')] = DictionaryObject({N('/O'): N('/Table'), N('/Scope'): N('/Column')})
                text = ' ' if ci == 0 else f'${(ci-1)*10000:,} - {ci*10000-1:,}'
            else:
                target = 'missing-column' if invalid_headers and ri == 1 and ci == 1 else f'column-{ci}'
                cell[N('/A')] = DictionaryObject({N('/O'): N('/Table'), N('/Headers'): ArrayObject([S(target)])})
                text = f'${(ri-1)*20000:,} - {ri*20000-1:,}' if ci == 0 else str(ri*100+ci)
            paragraph, paragraph_ref = node('P', cell_ref, text, x=20+ci*(670/columns),
                                            y=420-ri*22, font_size=min(7, 670/columns/9))
            cell[N('/K')] = paragraph_ref
            row_cells.append(cell_ref)
        if duplicate_owner and ri == 1:
            row_cells[-1] = row_cells[0]
        row[N('/K')] = ArrayObject(row_cells)
        cells.append(row_cells)
    table[N('/K')] = ArrayObject(table_rows)
    if protected:
        v.resolved(axis_refs[0] if axis_refs else table_ref)[N(protected)] = S('Authored protected wording')

    # A real native field/widget outside the table must remain interactive.
    widget = DictionaryObject({N('/Type'): N('/Annot'), N('/Subtype'): N('/Widget'),
        N('/FT'): N('/Tx'), N('/T'): S('retained_field'), N('/TU'): S('Existing field description'),
        N('/V'): S('Fictional retained value'), N('/Ff'): I(0),
        N('/Rect'): ArrayObject([I(n) for n in (20, 20, 180, 40)]), N('/P'): page.indirect_reference,
        N('/StructParent'): I(1)})
    widget_ref = writer._add_object(widget)
    form, form_ref = node('Form', doc_ref)
    form[N('/K')] = DictionaryObject({N('/Type'): N('/OBJR'), N('/Obj'): widget_ref,
                                     N('/Pg'): page.indirect_reference})
    children.append(form_ref)
    page[N('/Annots')] = ArrayObject([widget_ref])
    writer.root_object[N('/AcroForm')] = DictionaryObject({N('/Fields'): ArrayObject([widget_ref])})
    document[N('/K')] = ArrayObject(children)
    names = ArrayObject([value for key in sorted(ids) for value in (S(key), ids[key])])
    root[N('/IDTree')] = DictionaryObject({N('/Names'): names})
    root[N('/ParentTree')] = DictionaryObject({N('/Nums'): ArrayObject([I(0), ArrayObject(owners), I(1), form_ref])})
    root[N('/ParentTreeNextKey')] = I(2)
    page[N('/StructParents')] = I(0)
    writer.root_object[N('/StructTreeRoot')] = root_ref
    writer.root_object[N('/MarkInfo')] = DictionaryObject({N('/Marked'): BooleanObject(True)})
    writer.root_object[N('/Lang')] = S('en-US')
    stream = DecodedStreamObject()
    stream.set_data(''.join(programs).encode())
    page[N('/Contents')] = writer._add_object(stream)
    return writer


def selected(candidate):
    return {'type': 'repair_structure', 'tagId': candidate['tagId'], 'candidateId': candidate['candidateId']}


def with_run_in_heading(writer):
    caption = semantic.nodes(writer)[1]
    caption[N('/S')] = N('/P')
    font = DictionaryObject(dict(writer.pages[0]['/Resources']['/Font']['/F'].get_object()))
    font[N('/BaseFont')] = N('/Helvetica-Bold')
    writer.pages[0]['/Resources']['/Font'][N('/Bold')] = writer._add_object(font)
    stream = writer.pages[0]['/Contents'].get_object()
    old = b'/P << /MCID 0 >> BDC BT /F 7 Tf 1 0 0 1 20 478 Tm (Synthetic wage intersections) Tj ET EMC'
    replacement = (b'BT /P << /MCID 0 >> BDC /Bold 7 Tf 1 0 0 1 20 478 Tm (Synthetic section. ) Tj '
                   b'/F 7 Tf (The original explanatory paragraph remains.) Tj EMC ET')
    assert old in stream.get_data()
    stream.set_data(stream.get_data().replace(old, replacement, 1))
    return writer


def descendants(tag, tags):
    return [tag] + [item for entry in tag['contentSequence'] if entry['kind'] == 'childTag'
                    for item in descendants(tags[entry['tagId']], tags)]


def text_of(tag, tags):
    return ' '.join(part.get('text', '').strip() for part in descendants(tag, tags)).strip()


def header_context(tag, tags):
    result, pending = {}, [tag]
    while pending:
        current = pending.pop()
        for attribute in current.get('attributes', []):
            if attribute.get('owner') == 'Table' and attribute.get('headersEffective'):
                for identifier in attribute.get('headerTagIds', []):
                    if identifier not in result:
                        result[identifier] = tags[identifier]
                        pending.append(tags[identifier])
    return list(result.values())


class AutomaticExistingHeaderCoverageRegression(unittest.TestCase):
    def test_worker_offers_header_repair_for_valid_existing_column_only_salary_table(self):
        source = PdfReader(io.BytesIO(saved(fixture(columns=13, wrapped_axes=True))), strict=True)
        inventory = worker.enrich_inventory(source, source)
        candidates = [candidate for candidate in inventory['structureCandidates']
                      if candidate['kind'] == 'repair_table_headers']
        self.assertEqual(len(candidates), 1,
                         'The valid native table needs an automatic repair for its missing row/header context')


class ExistingTableHeaderRepairTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(headers, 'The existing-table header repair module is missing')

    def source(self, **kwargs):
        return PdfReader(io.BytesIO(saved(fixture(**kwargs))), strict=True)

    def repair(self, **kwargs):
        original = self.source(**kwargs)
        options = headers.discover_candidates(original)
        self.assertEqual(len(options), 1)
        writer = PdfWriter(clone_from=original)
        old = list(semantic.nodes(writer))
        result = headers.apply_operations(original, writer, [selected(options[0])])
        output = saved(writer)
        reopened = PdfReader(io.BytesIO(output), strict=True)
        headers.verify_saved(reopened, result['verification'])
        return original, writer, old, result, reopened, output

    def test_existing_column_only_native_table_exposes_one_bound_header_candidate(self):
        source = self.source()
        candidates = headers.discover_candidates(source)
        self.assertEqual(len(candidates), 1)
        option = candidates[0]
        self.assertEqual(option['kind'], 'repair_table_headers')
        self.assertRegex(option['candidateId'], '^[a-f0-9]{64}$')
        inventory = v.structure_inventory(source)
        tags = {tag['id']: tag for tag in inventory['tags']}
        self.assertEqual(tags[option['tagId']]['role'], 'Table')
        self.assertIn(HIGHER, option['preview'])
        self.assertIn(LOWER, option['preview'])
        self.assertEqual(headers.discover_candidates(source, _inspection=semantic._DiscoveryInspection(source)), candidates)

    def test_amounts_receive_row_column_and_both_source_axis_contexts(self):
        for columns, wrapped in ((3, False), (14, False), (13, True)):
            with self.subTest(columns=columns, wrapped=wrapped):
                _, _, _, _, output, _ = self.repair(columns=columns, wrapped_axes=wrapped)
                inventory = v.structure_inventory(output)
                self.assertTrue(inventory['checks_complete'])
                self.assertTrue(inventory['native_id_tree']['verified'])
                self.assertFalse(inventory['table_header_graph']['cycleDetected'])
                tags = {tag['id']: tag for tag in inventory['tags']}
                amounts = [tag for tag in tags.values()
                           if tag['role'] == 'TD' and text_of(tag,tags).isdigit()]
                self.assertEqual(len(amounts), 3*(columns-1))
                row_labels = [tag for tag in tags.values() if tag['role'] == 'TH' and text_of(tag,tags) == '$0 - 19,999']
                self.assertEqual(len(row_labels), 1)
                self.assertTrue(any(a.get('scope') == 'Row' for a in row_labels[0]['attributes']))
                for amount in amounts:
                    amount_text = text_of(amount,tags)
                    ri, ci = divmod(int(amount_text), 100)
                    expected_row = f'${(ri-1)*20000:,} - {ri*20000-1:,}'
                    expected_column = f'${(ci-1)*10000:,} - {ci*10000-1:,}'
                    context = [text_of(tag,tags) for tag in header_context(amount,tags)]
                    self.assertIn(expected_row, context)
                    self.assertIn(expected_column, context)
                    self.assertTrue(any(HIGHER in value for value in context))
                    self.assertTrue(any(LOWER in value for value in context))

    def test_wrapped_axes_and_original_blank_corner_keep_their_native_content(self):
        source, writer, old, _, output, _ = self.repair(columns=13, wrapped_axes=True)
        current = semantic.nodes(writer)
        self.assertTrue(all(any(node is original for node in current) for original in old))
        def blank_scope(reader):
            inventory = v.structure_inventory(reader)
            tags = {tag['id']:tag for tag in inventory['tags']}
            corner = next(tag for tag in tags.values() if tag.get('nativeIdHex') == b'column-0'.hex())
            return [(entry.get('pageNumber'), entry.get('mcid'), entry.get('text'))
                    for tag in descendants(corner,tags) for entry in tag['contentSequence']
                    if entry['kind'] == 'markedContent']
        self.assertEqual(blank_scope(source), blank_scope(output))
        self.assertEqual(source.pages[0].get_contents().get_data(), output.pages[0].get_contents().get_data())
        self.assertEqual(v.form_inventory(source), v.form_inventory(output))

    def test_grouped_header_has_native_body_rows_in_a_tbody(self):
        # PDF/UA clause 7.2 requires TBody whenever Table has a THead.
        # Header grouping must retain every original native row and ID owner.
        for columns, wrapped in ((3, False), (13, True)):
            with self.subTest(columns=columns, wrapped=wrapped):
                source = self.source(columns=columns, wrapped_axes=wrapped)
                operation = selected(headers.discover_candidates(source)[0])
                writer = PdfWriter(clone_from=source)
                originals = list(semantic.nodes(writer))
                table = next(node for node in originals if node.get('/S') == '/Table')
                rows = [v.resolved(ref) for ref in table['/K']]
                owners = identifiers.authored_id_bindings(writer)
                result = headers.apply_operations(source, writer, [operation])
                identifiers.verify_authored_id_bindings(owners, writer)
                current = semantic.nodes(writer)
                self.assertTrue(all(any(node is old for node in current) for old in originals))
                groups = [v.resolved(ref) for ref in table['/K']]
                self.assertEqual([group['/S'] for group in groups], ['/THead', '/TBody'])
                head, body = groups
                head_rows = [v.resolved(ref) for ref in head['/K']]
                self.assertEqual([row['/S'] for row in head_rows], ['/TR', '/TR'])
                self.assertIs(head_rows[1], rows[0])
                body_rows = [v.resolved(ref) for ref in body['/K']]
                self.assertEqual(len(body_rows), len(rows)-1)
                self.assertTrue(all(actual is expected for actual, expected in zip(body_rows, rows[1:])))
                self.assertTrue(all(row['/S'] == '/TR' and v.resolved(row['/P']) is body
                                    for row in body_rows))
                self.assertIs(v.resolved(head['/P']), table)
                self.assertIs(v.resolved(body['/P']), table)
                output = PdfReader(io.BytesIO(saved(writer)), strict=True)
                identifiers.verify_authored_ids(source, output)
                self.assertTrue(headers.verify_saved(output, result['verification']))
                saved_table = next(node for node in semantic.nodes(output) if node.get('/S') == '/Table')
                saved_groups = [v.resolved(ref) for ref in saved_table['/K']]
                self.assertEqual([group['/S'] for group in saved_groups], ['/THead', '/TBody'])
                self.assertEqual(len(saved_groups[1]['/K']), len(rows)-1)
                self.assertEqual(source.pages[0].get_contents().get_data(),
                                 output.pages[0].get_contents().get_data())
                self.assertEqual(v.form_inventory(source), v.form_inventory(output))

    def test_repair_preserves_all_source_nodes_ids_paint_and_fillable_fields(self):
        source, writer, old, result, output, data = self.repair(columns=14)
        current = semantic.nodes(writer)
        self.assertTrue(all(any(node is original for node in current) for original in old))
        self.assertEqual(len(result['lineage']), len(current))
        source_ids = {str(node['/ID']) for node in semantic.nodes(source) if '/ID' in node}
        output_ids = {str(node['/ID']) for node in semantic.nodes(output) if '/ID' in node}
        self.assertTrue(source_ids <= output_ids)
        self.assertEqual(source.pages[0].get_contents().get_data(), output.pages[0].get_contents().get_data())
        self.assertEqual(source.pages[0].extract_text(), output.pages[0].extract_text())
        self.assertEqual(v.form_inventory(source), v.form_inventory(output))
        self.assertEqual(source.get_fields()['retained_field']['/V'], output.get_fields()['retained_field']['/V'])
        with tempfile.TemporaryDirectory() as directory:
            before, after = Path(directory)/'source.pdf', Path(directory)/'output.pdf'
            before.write_bytes(source.stream.getvalue()); after.write_bytes(data)
            report = v.compare_pdfs(before, after)
        self.assertTrue(report['preservation']['passed'], report['findings'])
        self.assertTrue(report['preservation']['pages'][0]['pixels_identical'])
        self.assertEqual(headers.discover_candidates(output), [])

    def test_ambiguous_or_protected_inputs_are_not_candidates(self):
        for options in ({'axes': False}, {'ragged': True}, {'invalid_headers': True},
                        {'duplicate_owner': True}, {'unknown_cell': True},
                        {'protected': '/Alt'}, {'protected': '/ActualText'}):
            with self.subTest(options=options):
                self.assertEqual(headers.discover_candidates(self.source(**options)), [])

    def test_forged_duplicate_or_free_form_operations_are_refused(self):
        source = self.source()
        operation = selected(headers.discover_candidates(source)[0])
        for invalid in ({**operation, 'candidateId': '0'*64}, {**operation, 'rowLabels': ['guessed']},
                        {**operation, 'scope': 'Row'}, {**operation, 'tagId': 'tag-1'}):
            with self.subTest(invalid=invalid), self.assertRaises(semantic.SemanticStructureError):
                headers.apply_operations(source, PdfWriter(clone_from=source), [invalid])
        with self.assertRaises(semantic.SemanticStructureError):
            headers.apply_operations(source, PdfWriter(clone_from=source), [operation, operation])

    def test_source_clone_renumbering_keeps_authored_id_owners_and_saved_content(self):
        source = self.source(columns=13, wrapped_axes=True)
        option = headers.discover_candidates(source)[0]
        writer = PdfWriter(clone_from=source)
        source_nodes, target_nodes = semantic.nodes(source), semantic.nodes(writer)
        self.assertTrue(any(v.reference_key(a) != v.reference_key(b)
                            for a,b in zip(source_nodes,target_nodes)),
                        'The fixture must exercise real indirect-object renumbering')
        owners = identifiers.authored_id_bindings(writer)
        result = headers.apply_operations(source, writer, [selected(option)])
        identifiers.verify_authored_id_bindings(owners, writer)
        output = PdfReader(io.BytesIO(saved(writer)), strict=True)
        identifiers.verify_authored_ids(source, output)
        self.assertTrue(headers.verify_saved(output, result['verification']))
        self.assertEqual(source.pages[0].get_contents().get_data(), output.pages[0].get_contents().get_data())

    def test_pre_mutated_clone_cannot_bind_changed_source_paint_as_preserved(self):
        for change in ('paint', 'font'):
            with self.subTest(change=change):
                source = self.source(wrapped_axes=True)
                operation = selected(headers.discover_candidates(source)[0])
                writer = PdfWriter(clone_from=source)
                if change == 'paint':
                    stream = writer.pages[0]['/Contents'].get_object()
                    self.assertIn(b'(101)', stream.get_data())
                    stream.set_data(stream.get_data().replace(b'(101)', b'(999)', 1))
                else:
                    writer.pages[0]['/Resources']['/Font']['/F'][N('/BaseFont')] = N('/Courier')
                # A saved proof must stay bound to the source, even when the
                # caller supplied a clone that was changed before this repair.
                with self.assertRaises(semantic.SemanticStructureError):
                    result = headers.apply_operations(source, writer, [operation])
                    output = PdfReader(io.BytesIO(saved(writer)), strict=True)
                    headers.verify_saved(output, result['verification'])

    def test_header_and_unrelated_heading_repairs_compose_through_real_pipeline(self):
        source = PdfReader(io.BytesIO(saved(with_run_in_heading(
            fixture(columns=13, wrapped_axes=True)))), strict=True)
        inspection = semantic._DiscoveryInspection(source)
        options = pipeline.discover_candidates(source, _inspection=inspection)
        chosen = [candidate for candidate in options
                  if candidate['kind'] in ('repair_table_headers','split_heading')]
        self.assertEqual({candidate['kind'] for candidate in chosen},
                         {'repair_table_headers','split_heading'})
        writer = PdfWriter(clone_from=source)
        original_nodes = list(semantic.nodes(writer))
        owners = identifiers.authored_id_bindings(writer)
        source_positions = {id(node):f'tag-{index+1}' for index,node in enumerate(original_nodes)}
        operations = [{**selected(option), **({'role':'H2'} if option['kind']=='split_heading' else {})}
                      for option in chosen]
        result = pipeline.apply_operations(source, writer, operations,
                                           _inspection=inspection)
        identifiers.verify_authored_id_bindings(owners, writer)
        current = semantic.nodes(writer)
        lineage = {id(entry['node']):entry['sourceTagId'] for entry in result['lineage']}
        self.assertTrue(all(any(node is old for node in current) for old in original_nodes))
        self.assertTrue(all(lineage[id(node)] == source_positions[id(node)] for node in original_nodes))
        output = PdfReader(io.BytesIO(saved(writer)), strict=True)
        identifiers.verify_authored_ids(source, output)
        pipeline.verify_saved(output, result['verification'], _inspection=semantic._DiscoveryInspection(output))
        actual = v.structure_inventory(output)
        self.assertTrue(any(tag['role'] == 'H2' and 'Synthetic section.' in tag['text'] for tag in actual['tags']))
        self.assertEqual(source.pages[0].extract_text(), output.pages[0].extract_text())
        self.assertEqual(v.form_inventory(source),v.form_inventory(output))

    def test_hierarchical_authored_identifier_index_survives_header_repair(self):
        writer = fixture(columns=14, wrapped_axes=True)
        root = writer.root_object['/StructTreeRoot']
        original = root['/IDTree']['/Names']
        cuts = (original[:8], original[8:])
        root[N('/IDTree')] = DictionaryObject({N('/Kids'): ArrayObject([
            writer._add_object(DictionaryObject({N('/Names'):ArrayObject(part),
                N('/Limits'):ArrayObject([part[0],part[-2]])})) for part in cuts])})
        source = PdfReader(io.BytesIO(saved(writer)), strict=True)
        self.assertTrue(v.structure_inventory(source)['native_id_tree']['verified'])
        option = headers.discover_candidates(source)[0]
        candidate = PdfWriter(clone_from=source)
        owners = identifiers.authored_id_bindings(candidate)
        result = headers.apply_operations(source,candidate,[selected(option)])
        identifiers.verify_authored_id_bindings(owners,candidate)
        output = PdfReader(io.BytesIO(saved(candidate)), strict=True)
        identifiers.verify_authored_ids(source,output)
        self.assertTrue(headers.verify_saved(output,result['verification']))

    def test_conflicting_or_ambiguous_table_attributes_are_not_candidates(self):
        def duplicate_owner(cell):
            cell[N('/A')] = ArrayObject([cell['/A'],DictionaryObject({N('/O'):N('/Table'),
                N('/Headers'):ArrayObject([S('column-1')])})])
        def row_span(cell):
            cell['/A'][N('/RowSpan')] = I(2)
        def wrong_column(cell):
            cell['/A'][N('/Headers')] = ArrayObject([S('column-2')])
        def duplicate_header(cell):
            cell['/A'][N('/Headers')] = ArrayObject([S('column-1'),S('column-1')])
        for mutation in (duplicate_owner,row_span,wrong_column,duplicate_header):
            with self.subTest(mutation=mutation.__name__):
                writer = fixture(wrapped_axes=True)
                target = next(node for node in semantic.nodes(writer)
                              if node.get('/S') == '/TD' and node['/A']['/Headers'] == [S('column-1')])
                mutation(target)
                source = PdfReader(io.BytesIO(saved(writer)),strict=True)
                self.assertEqual(headers.discover_candidates(source),[])

    def test_saved_header_id_or_source_paint_tampering_fails_verification(self):
        for change in ('headers', 'id', 'paint', 'field'):
            with self.subTest(change=change):
                _, _, _, result, output, _ = self.repair()
                writer = PdfWriter(clone_from=output)
                tags = semantic.nodes(writer)
                if change == 'headers':
                    cell = next(tag for tag in tags if tag.get('/S') == '/TD')
                    cell[N('/A')] = DictionaryObject({N('/O'): N('/Table'), N('/Headers'): ArrayObject([S('missing')])})
                elif change == 'id':
                    target = next(tag for tag in tags if tag.get('/S') == '/TH' and '/ID' in tag)
                    target[N('/ID')] = S('changed-header-id')
                elif change == 'paint':
                    stream = writer.pages[0]['/Contents'].get_object()
                    stream.set_data(stream.get_data().replace(b'(101)', b'(999)', 1))
                else:
                    writer.root_object['/AcroForm']['/Fields'][0].get_object()[N('/V')] = S('Changed field value')
                with self.assertRaises(semantic.SemanticStructureError):
                    headers.verify_saved(PdfReader(io.BytesIO(saved(writer)), strict=True), result['verification'])


if __name__ == '__main__':
    unittest.main()
