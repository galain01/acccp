"""One immutable page needs one paint check per version, even with three tables."""
from collections import Counter
import io
import re
import unittest
from unittest.mock import patch

from pypdf import PdfReader, PdfWriter
from pypdf.generic import (ArrayObject, DictionaryObject, NameObject as N,
                          NumberObject as I, TextStringObject as S)

from test_existing_table_header_repair import fixture, saved, selected
import bounded_existing_table_headers as headers
import bounded_semantic_structure as semantic
import native_structure_repairs as identifiers
import verify_pdf as v


def three_tables_on_one_page():
    """Independent native tables share painting/resources, not nodes or IDs."""
    writer = fixture(columns=3, rows=3, wrapped_axes=True)
    page = writer.pages[0]
    page[N('/MediaBox')] = ArrayObject([I(0), I(0), I(720), I(1600)])
    root = writer.root_object['/StructTreeRoot']
    document = v.resolved(root['/K'])
    original_children = list(document['/K'])
    caption, axis_wrapper, table = map(v.resolved, original_children[:3])
    original_stream = page['/Contents'].get_object().get_data()
    owners = root['/ParentTree']['/Nums'][1]
    original_names = root['/IDTree']['/Names']
    names = {str(original_names[index]): original_names[index+1]
             for index in range(0, len(original_names), 2)}
    additions, programs = [], []

    for copy_number in (1, 2):
        prefix = f'table-{copy_number}-'

        def duplicate(node, parent):
            clone = DictionaryObject({name:value for name,value in node.items()
                                      if name not in ('/P', '/K', '/ID', '/A')})
            clone[N('/P')] = parent
            reference = writer._add_object(clone)
            if '/ID' in node:
                value = prefix + str(node['/ID'])
                clone[N('/ID')] = S(value)
                names[value] = reference
            if '/A' in node:
                attributes = DictionaryObject(dict(node['/A']))
                if '/Headers' in attributes:
                    attributes[N('/Headers')] = ArrayObject([S(prefix + str(value))
                                                             for value in attributes['/Headers']])
                clone[N('/A')] = attributes
            child = v.resolved(node['/K'])
            if isinstance(child, ArrayObject):
                clone[N('/K')] = ArrayObject([duplicate(v.resolved(value), reference) for value in child])
            elif isinstance(child, DictionaryObject):
                clone[N('/K')] = duplicate(child, reference)
            else:
                self_mcid = int(child)
                mcid = len(owners)
                clone[N('/K')] = I(mcid)
                owners.append(reference)
                pattern = rb'/P << /MCID ' + str(self_mcid).encode() + rb' >> BDC BT [^\n]*? EMC\n'
                matches = re.findall(pattern, original_stream)
                if len(matches) != 1:
                    raise AssertionError('The synthetic leaf must own exactly one original text program')
                program = matches[0].replace(f'/MCID {self_mcid} '.encode(), f'/MCID {mcid} '.encode(), 1)
                program = re.sub(rb'(1 0 0 1 [\d.]+ )([\d.]+)( Tm)',
                    lambda match: match[1] + str(float(match[2]) + 500*copy_number).encode() + match[3], program)
                programs.append(program)
            return reference

        # Keep a source heading between tables, so neighboring-order proofs
        # refer to retained siblings rather than another repair's axis wrapper.
        additions.extend([duplicate(caption, document.indirect_reference),
                          duplicate(axis_wrapper, document.indirect_reference),
                          duplicate(table, document.indirect_reference)])

    document[N('/K')] = ArrayObject([*original_children[:-1], *additions, original_children[-1]])
    root['/IDTree'][N('/Names')] = ArrayObject([value for name in sorted(names)
                                               for value in (S(name), names[name])])
    page['/Contents'].get_object().set_data(original_stream + b''.join(programs))
    data = saved(writer)
    return PdfReader(io.BytesIO(data), strict=True), data


class ExistingHeaderInspectionBudgetTests(unittest.TestCase):
    def source(self):
        reader, data = three_tables_on_one_page()
        inspection = semantic._DiscoveryInspection(reader)
        inventory = inspection.copy_for(reader)
        self.assertTrue(inventory['checks_complete'])
        self.assertTrue(inventory['native_id_tree']['verified'])
        candidates = headers.discover_candidates(reader, _inspection=inspection)
        self.assertEqual(len(candidates), 3)
        self.assertEqual({candidate['pageNumber'] for candidate in candidates}, {1})
        self.assertEqual(len({candidate['tagId'] for candidate in candidates}), 3)
        return reader, data, inspection, [selected(candidate) for candidate in candidates]

    def test_three_repairs_fingerprint_the_same_unchanged_clone_page_only_once(self):
        source, source_bytes, inspection, operations = self.source()
        writer = PdfWriter(clone_from=source)
        source_page, target_page = source.pages[0], writer.pages[0]
        owners = identifiers.authored_id_bindings(writer)
        # Wrap the actual parser/fingerprint functions: their full work and all
        # rejection paths run. Counts replace unreliable wall-clock assertions.
        with patch.object(v, 'operations', wraps=v.operations) as parse, \
             patch.object(v, 'drawing_fingerprint', wraps=v.drawing_fingerprint) as paint, \
             patch.object(v, 'structure_inventory', wraps=v.structure_inventory) as inventory:
            result = headers.apply_operations(source, writer, operations, _inspection=inspection)
        identifiers.verify_authored_id_bindings(owners, writer)
        output_bytes = saved(writer)
        output = PdfReader(io.BytesIO(output_bytes), strict=True)
        self.assertTrue(headers.verify_saved(output, result['verification']))
        identifiers.verify_authored_ids(source, output)
        self.assertEqual(len(result['changes']), 3)
        self.assertEqual(source.stream.getvalue(), source_bytes)
        self.assertEqual(output.stream.getvalue(), output_bytes)
        self.assertEqual(source_page.get_contents().get_data(), output.pages[0].get_contents().get_data())
        self.assertEqual(source_page.extract_text(), output.pages[0].extract_text())
        self.assertEqual(v.form_inventory(source), v.form_inventory(output))
        inventory.assert_not_called()
        counts = Counter(id(call.args[0]) for call in parse.call_args_list)
        self.assertLessEqual(counts[id(source_page)], 1)
        self.assertLessEqual(counts[id(target_page)], 1,
            'Three metadata-only repairs must share one unchanged target-page paint inspection')
        self.assertLessEqual(paint.call_count, 2,
            'Source and target are two exact page versions, regardless of the number of native tables')

    def test_shared_source_inspection_cannot_hide_changed_clone_or_saved_page(self):
        source, _, inspection, operations = self.source()
        writer = PdfWriter(clone_from=source)
        result = headers.apply_operations(source, writer, operations, _inspection=inspection)
        pristine = saved(writer)
        self.assertTrue(headers.verify_saved(PdfReader(io.BytesIO(pristine), strict=True), result['verification']))
        for change in ('paint', 'font'):
            with self.subTest(change=change):
                changed = PdfWriter(clone_from=source)
                if change == 'paint':
                    stream = changed.pages[0]['/Contents'].get_object()
                    self.assertIn(b'(101)', stream.get_data())
                    stream.set_data(stream.get_data().replace(b'(101)', b'(999)', 1))
                else:
                    changed.pages[0]['/Resources']['/Font']['/F'][N('/BaseFont')] = N('/Courier')
                with self.assertRaises(semantic.SemanticStructureError):
                    headers.apply_operations(source, changed, operations, _inspection=inspection)
                changed_saved = PdfWriter(clone_from=PdfReader(io.BytesIO(pristine), strict=True))
                if change == 'paint':
                    stream = changed_saved.pages[0]['/Contents'].get_object()
                    stream.set_data(stream.get_data().replace(b'(101)', b'(999)', 1))
                else:
                    changed_saved.pages[0]['/Resources']['/Font']['/F'][N('/BaseFont')] = N('/Courier')
                with self.assertRaises(semantic.SemanticStructureError):
                    headers.verify_saved(PdfReader(io.BytesIO(saved(changed_saved)), strict=True), result['verification'])


if __name__ == '__main__':
    unittest.main()
