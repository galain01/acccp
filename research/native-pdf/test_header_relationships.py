"""Headers must resolve through the real IDTree within their own Table."""
import io
from pathlib import Path
import tempfile
import unittest

from pypdf import PdfReader, PdfWriter
from pypdf.generic import ArrayObject, DictionaryObject, NameObject, TextStringObject
from semantic_repairs import _tag_nodes
from test_table_direction_order import fixture
from verify_pdf import structure_inventory


def table_of(node):
    while node.get('/S') != '/Table' and '/P' in node:
        node = node['/P']
    return node


class HeaderRelationshipsTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.path = Path(temporary.name) / 'source.pdf'
        fixture(self.path)
        self.writer = PdfWriter(clone_from=self.path)
        self.nodes = _tag_nodes(self.writer)
        self.headers = [n for n in self.nodes if n.get('/S') == '/TH']
        self.cells = [n for n in self.nodes if n.get('/S') == '/TD']
        for index, header in enumerate(self.headers):
            header[NameObject('/ID')] = TextStringObject('header-' + str(index))
        for cell in self.cells:
            header = next(h for h in self.headers if table_of(h) is table_of(cell))
            cell[NameObject('/A')] = DictionaryObject({NameObject('/O'): NameObject('/Table'),
                NameObject('/Headers'): ArrayObject([header['/ID']])})
        identified = sorted((n['/ID'], n.indirect_reference) for n in self.nodes if '/ID' in n)
        self.names = ArrayObject([item for pair in identified for item in pair])
        self.root = self.writer.root_object['/StructTreeRoot']
        self.root[NameObject('/IDTree')] = DictionaryObject({NameObject('/Names'): self.names})

    def inspect(self):
        output = io.BytesIO()
        self.writer.write(output)
        return structure_inventory(PdfReader(io.BytesIO(output.getvalue()), strict=True))

    def test_real_tree_targets_and_same_table_headers_are_verified(self):
        info = self.inspect()
        self.assertTrue(info['machine_checks_passed'])
        self.assertTrue(info['checks_complete'])
        self.assertEqual(info['native_id_tree'], {'present': True, 'entryCount': 4, 'verified': True})
        self.assertTrue(all(t['idTreeVerified'] for t in info['tags'] if 'nativeId' in t))
        self.assertTrue(all(a['headersResolved'] for t in info['tags'] for a in t['attributes'] if 'headersResolved' in a))

    def test_missing_tree_is_not_reconstructed_from_native_id_strings(self):
        self.root.pop('/IDTree')
        info = self.inspect()
        self.assertFalse(info['machine_checks_passed'])
        self.assertFalse(info['checks_complete'])
        self.assertIn('structure_id_tree_target_mismatch', [f['code'] for f in info['findings']])

    def test_valid_id_from_another_table_is_rejected(self):
        self.cells[0]['/A'][NameObject('/Headers')] = ArrayObject([self.headers[1]['/ID']])
        info = self.inspect()
        self.assertFalse(info['checks_complete'])
        self.assertIn('table_header_not_in_same_table', [f['code'] for f in info['findings']])

    def test_tree_must_point_to_the_exact_native_element(self):
        self.names[1] = self.headers[1].indirect_reference
        info = self.inspect()
        self.assertFalse(info['checks_complete'])
        self.assertIn('structure_id_tree_target_mismatch', [f['code'] for f in info['findings']])

    def test_unreachable_target_is_rejected_even_if_its_id_matches(self):
        extra = DictionaryObject({NameObject('/Type'): NameObject('/StructElem'), NameObject('/S'): NameObject('/TH'),
            NameObject('/ID'): self.headers[0]['/ID']})
        self.names[1] = self.writer._add_object(extra)
        info = self.inspect()
        self.assertFalse(info['native_id_tree']['verified'])

    def test_duplicate_and_unsorted_names_are_rejected(self):
        self.names.extend(self.names[:2])
        info = self.inspect()
        self.assertFalse(info['checks_complete'])
        self.assertIn('unordered_or_duplicate_structure_id_tree_key', [f['code'] for f in info['findings']])

    def test_nested_tree_limits_are_verified(self):
        leaves = []
        for entries in (self.names[:4], self.names[4:]):
            leaf = DictionaryObject({NameObject('/Names'): ArrayObject(entries),
                NameObject('/Limits'): ArrayObject([entries[0], entries[-2]])})
            leaves.append(self.writer._add_object(leaf))
        self.root[NameObject('/IDTree')] = DictionaryObject({NameObject('/Kids'): ArrayObject(leaves)})
        self.assertTrue(self.inspect()['native_id_tree']['verified'])
        leaves[0].get_object()[NameObject('/Limits')] = ArrayObject([TextStringObject('wrong'), self.names[2]])
        self.assertFalse(self.inspect()['checks_complete'])

    def test_self_header_reference_is_rejected(self):
        self.headers[0][NameObject('/A')] = DictionaryObject({NameObject('/O'): NameObject('/Table'),
            NameObject('/Headers'): ArrayObject([self.headers[0]['/ID']])})
        self.assertFalse(self.inspect()['checks_complete'])


if __name__ == '__main__':
    unittest.main()
