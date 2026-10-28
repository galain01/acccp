"""Discard only proved-empty decoder prefixes; retain exact text evidence."""
import copy
import io
import unittest
from unittest.mock import patch

from pypdf import PdfReader, PdfWriter
from pypdf.generic import (ArrayObject, DecodedStreamObject, DictionaryObject,
                          NameObject as N, NumberObject as I)

import verify_pdf as v
from test_native_pdf_validation import pdf_bytes
from test_text_extraction_graphics_budget import fixture as form_fixture


SHOW = {b'Tj', b'TJ', b"'", b'"'}


def fixture(count=60, *, inherited=False, program=None, cmap=False):
    writer = PdfWriter(clone_from=PdfReader(io.BytesIO(pdf_bytes(tagged=True))))
    page = writer.pages[0]
    page[N('/MediaBox')] = ArrayObject([I(0), I(0), I(400), I(count*20+100)])
    root = writer.root_object['/StructTreeRoot']
    paragraph = root['/K'][0].get_object()['/K'][0]
    paragraph.get_object()[N('/K')] = ArrayObject([I(index) for index in range(count)])
    root['/ParentTree'][N('/Nums')] = ArrayObject([I(0), ArrayObject([paragraph]*count)])
    page['/Resources'][N('/ExtGState')] = DictionaryObject({N('/GS1'): DictionaryObject()})
    if cmap:
        unicode_map = DecodedStreamObject()
        unicode_map.set_data(b'''/CIDInit /ProcSet findresource begin 12 dict begin begincmap
/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def
/CMapName /SyntheticUnicode def /CMapType 2 def
1 begincodespacerange <00> <ff> endcodespacerange
2 beginbfchar <41> <03a9> <42> <4e2d> endbfchar
endcmap CMapName currentdict /CMap defineresource pop end end''')
        page['/Resources']['/Font'][N('/F2')] = writer._add_object(DictionaryObject({
            N('/Type'): N('/Font'), N('/Subtype'): N('/Type1'), N('/BaseFont'): N('/Courier'),
            N('/ToUnicode'): writer._add_object(unicode_map)}))
    if program is None:
        programs = [b'/F1 12 Tf']
        for index in range(count):
            font = '' if inherited else '/F1 12 Tf '
            programs.append((f'BT {font}1 0 0 1 20 {40+20*(count-index)} Tm '
                f'/P << /MCID {index} >> BDC (Passage {index}) Tj EMC ET').encode())
        programs.append(b'/Artifact BMC BT /F1 9 Tf 1 0 0 1 20 20 Tm (Footer) Tj ET EMC')
        program = b'\n'.join(programs)
    page['/Contents'].get_object().set_data(program)
    data = io.BytesIO(); writer.write(data)
    return PdfReader(io.BytesIO(data.getvalue()), strict=True)


def selected_operations(reader, mcid):
    operations = v.operations(reader.pages[0])
    owners, artifacts, stack = [], [], []
    for args, operator in operations:
        if operator in (b'BMC', b'BDC'):
            properties = args[1] if operator == b'BDC' else {}
            stack.append((properties.get('/MCID'), args[0] == '/Artifact'))
        owners.append(next((owner for owner, _ in reversed(stack) if owner is not None), None))
        artifacts.append(any(artifact for _, artifact in stack))
        if operator == b'EMC':
            stack.pop()
    scoped = v.scoped_text_operations(operations, owners, artifacts)
    return v._select_text_operations(scoped, mcid, _prefix=v._text_scope_index(scoped))


def decoded(reader, operations):
    page = copy.copy(reader.pages[0])
    stream = v.extraction_stream(operations, reader, page['/Resources'])
    page[N('/Contents')] = stream
    return page.extract_text() or '', stream.operations


class PrefixTextExtractionWorkTests(unittest.TestCase):
    def test_dense_font_reset_or_inherited_blocks_keep_exact_inventory_with_less_decoder_work(self):
        for inherited in (False, True):
            with self.subTest(inherited=inherited):
                reader = fixture(inherited=inherited)
                page = reader.pages[0]
                source = reader.stream.getvalue()
                contents = page.get_contents().get_data()
                resources = v.Canonicalizer().hash(page['/Resources'])
                paint = v.drawing_fingerprint(v.operations(page), v.Canonicalizer())
                real_stream = v.extraction_stream
                actual_work, legacy_work = [], []
                def measured(operations, *args):
                    stream = real_stream(operations, *args)
                    actual_work.append(len(stream.operations))
                    return stream
                with patch.object(v, '_text_scope_index', wraps=v._text_scope_index) as index, \
                     patch.object(v, 'extraction_stream', side_effect=measured):
                    actual = v.structure_inventory(reader)
                self.assertEqual(index.call_count, 1, 'Build one linear index per page, never one per MCID')
                def prior(operations, *args):
                    stream = real_stream(operations, *args)
                    legacy_work.append(len(stream.operations))
                    return stream
                # Disable only the proposed disposable-view optimization. All
                # native decoding, ownership and machine inspection remain real.
                with patch.object(v, '_text_scope_index', return_value=None), \
                     patch.object(v, 'extraction_stream', side_effect=prior):
                    expected = v.structure_inventory(reader)
                self.assertEqual(actual, expected)
                self.assertTrue(actual['checks_complete'])
                self.assertEqual(actual['page_content'][0]['artifactText'], 'Footer')
                self.assertEqual(reader.stream.getvalue(), source)
                self.assertEqual(page.get_contents().get_data(), contents)
                self.assertEqual(v.Canonicalizer().hash(page['/Resources']), resources)
                self.assertEqual(v.drawing_fingerprint(v.operations(page), v.Canonicalizer()), paint)
                self.assertEqual(len(actual_work), 61)
                self.assertLess(sum(actual_work), sum(legacy_work)*0.75,
                    'Proved-empty prefix text blocks should not be replayed for every later MCID')

    def test_inherited_unicode_font_and_outside_graphics_restore_are_kept(self):
        reader = fixture(4, cmap=True, program=b'''/F1 12 Tf
BT 1 0 0 1 20 140 Tm /P << /MCID 0 >> BDC (First regular) Tj EMC ET
q 1 0 0 1 5 7 cm
BT /F2 11 Tf 1 0 0 1 20 110 Tm /P << /MCID 1 >> BDC <4142> Tj EMC ET
Q
BT 1 0 0 1 20 80 Tm /P << /MCID 2 >> BDC (Restored regular) Tj EMC ET
BT /F2 11 Tf 1 0 0 1 20 50 Tm /P << /MCID 3 >> BDC <4142> Tj EMC ET''')
        for mcid in range(4):
            with self.subTest(mcid=mcid):
                operations = selected_operations(reader, mcid)
                actual, sent = decoded(reader, operations)
                with patch.object(v, '_text_scope_index', return_value=None):
                    expected, prior = decoded(reader, selected_operations(reader, mcid))
                self.assertEqual(actual, expected)
                self.assertEqual([op for op in sent if op[1] in (b'Tf', b'q', b'Q', b'cm')],
                                 [op for op in prior if op[1] in (b'Tf', b'q', b'Q', b'cm')])
                if mcid in (1, 3):
                    self.assertIn('\u03a9\u4e2d', actual)
                if mcid == 2:
                    self.assertIn('Restored regular', actual)

    def test_complete_suffix_preserves_decoder_added_trailing_whitespace(self):
        reader = fixture(3)
        operations = selected_operations(reader, 0)
        actual, sent = decoded(reader, operations)
        with patch.object(v, '_text_scope_index', return_value=None):
            expected, prior = decoded(reader, selected_operations(reader, 0))
        self.assertEqual(actual, expected)
        self.assertTrue(actual.endswith('\n'))
        self.assertEqual(sent, prior)

    def test_persistent_state_stack_quotes_or_unknown_text_blocks_use_unchanged_view(self):
        unsafe = (b'1 Tc', b'1 Tw', b'90 Tz', b'14 TL', b'1 Ts', b'0 Tr', b'0 -10 TD',
                  b'T*', b'(Extra) \x27', b'0 0 (Extra) "', b'q Q', b'/GS1 gs', b'UNRECOGNIZED')
        for instruction in unsafe:
            with self.subTest(instruction=instruction):
                base = fixture(3)
                program = base.pages[0].get_contents().get_data().replace(
                    b'BT /F1 12 Tf', b'BT /F1 12 Tf ' + instruction, 1)
                reader = fixture(3, program=program)
                operations = selected_operations(reader, 2)
                actual, sent = decoded(reader, operations)
                with patch.object(v, '_text_scope_index', return_value=None):
                    expected, prior = decoded(reader, selected_operations(reader, 2))
                self.assertEqual(actual, expected)
                self.assertEqual(sent, prior)

    def test_target_without_position_reset_keeps_unchanged_prefix(self):
        base = fixture(3, inherited=True)
        program = base.pages[0].get_contents().get_data().replace(b'1 0 0 1 20 80 Tm ', b'', 1)
        reader = fixture(3, program=program)
        operations = selected_operations(reader, 1)
        actual, sent = decoded(reader, operations)
        with patch.object(v, '_text_scope_index', return_value=None):
            expected, prior = decoded(reader, selected_operations(reader, 1))
        self.assertEqual(actual, expected)
        self.assertEqual(sent, prior)

    def test_original_work_limit_is_still_charged_before_any_prefix_optimization(self):
        reader = fixture(60)
        with patch.object(v, 'MAX_TEXT_EXTRACTION_OPERATORS', 1):
            inventory = v.structure_inventory(reader)
        self.assertFalse(inventory['checks_complete'])
        self.assertTrue(any(tag.get('textIncomplete') for tag in inventory['tags']))
        self.assertFalse(inventory['page_content'][0]['artifactTextComplete'])

    def test_leaf_form_gets_one_separate_index_with_identical_text_and_ownership(self):
        reader = PdfReader(io.BytesIO(form_fixture(form=True, artifact=True)[0]), strict=True)
        with patch.object(v, '_text_scope_index', wraps=v._text_scope_index) as index:
            actual = v.structure_inventory(reader)
        self.assertEqual(index.call_count, 2, 'One page index and one uniquely invoked leaf-Form index')
        with patch.object(v, '_text_scope_index', return_value=None):
            expected = v.structure_inventory(reader)
        self.assertEqual(actual, expected)
        self.assertTrue(actual['checks_complete'])
        self.assertIn('Page footer', actual['page_content'][0]['artifactText'])

    def test_foreign_scope_index_cannot_discard_another_streams_prefix(self):
        reader = fixture(3)
        ops = v.operations(reader.pages[0])
        plain = [operation for operation, _, _ in v.scoped_text_operations(
            ops, [None]*len(ops), [False]*len(ops))]
        scoped = [(operation, 0 if operation[1] == b'Tj' and operation[0][0] == 'Passage 2' else 1, False)
                  for operation in plain]
        other = [(operation, 0 if operation[1] == b'Tj' and operation[0][0] == 'Passage 0' else 1, False)
                 for operation in plain]
        index = v._text_scope_index(scoped)
        self.assertIsNotNone(index)
        self.assertEqual(v._select_text_operations(other, 0, _prefix=index),
                         v._select_text_operations(other, 0))


if __name__ == '__main__':
    unittest.main()
