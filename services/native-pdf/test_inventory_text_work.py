"""Dense native tags should not repeat ignored wrappers in each text decode."""
import io
import unittest
from unittest.mock import patch

from pypdf import PdfReader, PdfWriter
from pypdf.generic import ArrayObject, DecodedStreamObject, NameObject, NumberObject

import worker
from test_native_pdf_validation import pdf_bytes, native_form_reader

v = worker.verify_pdf


def dense_reader(count=60):
    writer = PdfWriter(clone_from=PdfReader(io.BytesIO(pdf_bytes(tagged=True))))
    page = writer.pages[0]
    root = writer.root_object['/StructTreeRoot']
    paragraph_ref = root['/K'][0].get_object()['/K'][0]
    paragraph_ref.get_object()[NameObject('/K')] = ArrayObject([NumberObject(i) for i in range(count)])
    root['/ParentTree'][NameObject('/Nums')] = ArrayObject([
        NumberObject(0), ArrayObject([paragraph_ref] * count)])
    stream = DecodedStreamObject()
    stream.set_data((
        'q BT /F1 12 Tf 1 0 0 1 10 90 Tm '
        '/Artifact BMC (Footer) Tj EMC '
        + ' '.join(f'/P <</MCID {i}>> BDC 0 -1 Td [(T) 120 (ext {i})] TJ EMC' for i in range(count))
        + ' ET Q').encode('ascii'))
    page[NameObject('/Contents')] = writer._add_object(stream)
    data = io.BytesIO()
    writer.write(data)
    return PdfReader(io.BytesIO(data.getvalue()))


def unoptimized_index(ops, owners, artifacts):
    # The original per-MCID extraction kept wrappers but omitted invocations.
    return [(op, owner, artifact) for op, owner, artifact in zip(ops, owners, artifacts)
            if op[1] not in (b'Do', b'INLINE IMAGE')]


class InventoryTextWorkTests(unittest.TestCase):
    def test_dense_tag_inventory_matches_original_decoder_and_keeps_bytes(self):
        reader = dense_reader()
        original = reader.pages[0].get_contents().get_data()
        expected = v.structure_inventory(reader)
        with patch.object(v, 'scoped_text_operations', side_effect=unoptimized_index):
            prior = v.structure_inventory(reader)
        self.assertEqual(expected, prior)
        self.assertTrue(expected['checks_complete'])
        self.assertEqual(expected['page_content'][0]['artifactText'], 'Footer')
        paragraph = expected['tags'][1]
        self.assertEqual(len(paragraph['contentSequence']), 60)
        self.assertTrue(all(f'Text {i}' in part['text']
                            for i, part in enumerate(paragraph['contentSequence'])))
        self.assertEqual(reader.pages[0].get_contents().get_data(), original)

    def test_wrapper_heavy_document_fits_existing_actual_extraction_budget(self):
        reader = dense_reader()
        ops = v.operations(reader.pages[0])
        optimized = len(v.scoped_text_operations(ops, [None] * len(ops), [False] * len(ops)))
        scopes = 61  # 60 native text scopes plus the artifact text.
        limit = (len(ops) + optimized) * scopes // 2
        with patch.object(v, 'MAX_TEXT_EXTRACTION_OPERATORS', limit):
            current = v.structure_inventory(reader)
            with patch.object(v, 'scoped_text_operations', side_effect=unoptimized_index):
                prior = v.structure_inventory(reader)
        self.assertTrue(current['checks_complete'])
        self.assertFalse(prior['checks_complete'])
        self.assertTrue(any(tag.get('textIncomplete') for tag in prior['tags']))
        self.assertFalse(any(tag.get('textIncomplete') for tag in current['tags']))

    def test_real_extraction_budget_remains_enforced(self):
        with patch.object(v, 'MAX_TEXT_EXTRACTION_OPERATORS', 1):
            result = v.structure_inventory(dense_reader())
        self.assertFalse(result['checks_complete'])
        self.assertFalse(result['page_content'][0]['artifactTextComplete'])
        self.assertTrue(any(tag.get('textIncomplete') for tag in result['tags']))

    def test_form_text_artifact_and_ownership_evidence_is_unchanged(self):
        for kwargs in ({}, {'artifact': True, 'reused': True}, {'bad_parent': True},
                       {'reused': True}, {'orphan': True}):
            with self.subTest(kwargs=kwargs):
                reader = native_form_reader(**kwargs)
                current = v.structure_inventory(reader)
                with patch.object(v, 'scoped_text_operations', side_effect=unoptimized_index):
                    prior = v.structure_inventory(reader)
                self.assertEqual(current, prior)

    def test_index_keeps_text_state_and_drops_pure_painting_in_original_order(self):
        ops = [([], op) for op in (b'q', b'BT', b'Tf', b'gs', b'Tm', b'BMC',
                                  b'BDC', b'TJ', b'TD', b'Tj', b'EMC', b'ET',
                                  b'Q', b'MP', b'DP', b'm', b'l', b'S', b'Do', b'INLINE IMAGE')]
        owners = list(range(len(ops)))
        artifacts = [bool(i % 2) for i in owners]
        actual = v.scoped_text_operations(ops, owners, artifacts)
        retained = [index for index, (_, op) in enumerate(ops)
                    if op not in (b'BMC', b'BDC', b'EMC', b'MP', b'DP', b'Do', b'INLINE IMAGE', b'm', b'l', b'S')]
        self.assertEqual(actual, [(ops[i], owners[i], artifacts[i]) for i in retained])


if __name__ == '__main__':
    unittest.main()
