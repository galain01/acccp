"""Generated native IDs must retain their owners and acquire a verified index."""
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import worker
from pypdf import PdfReader, PdfWriter
from pypdf.generic import (ArrayObject, BooleanObject, ByteStringObject, DictionaryObject,
                          NameObject, NumberObject, TextStringObject)
import native_structure_repairs as repairs
from test_native_pdf_validation import pdf_bytes
from test_worker import validation


def serialized(writer):
    output = io.BytesIO()
    writer.write(output)
    return output.getvalue()


def generated_writer():
    writer = PdfWriter(clone_from=PdfReader(io.BytesIO(pdf_bytes(tagged=True))))
    document = writer.root_object['/StructTreeRoot']['/K'][0].get_object()
    listing = document['/K'][0].get_object()
    listing[NameObject('/S')] = NameObject('/L')
    listing[NameObject('/ID')] = TextStringObject('generated-list-1')
    listing[NameObject('/A')] = DictionaryObject({NameObject('/O'): NameObject('/List'),
        NameObject('/ListNumbering'): NameObject('/Decimal'), NameObject('/ContinuedList'): BooleanObject(True),
        NameObject('/ContinuedFrom'): TextStringObject('unresolved-source-value')})
    return writer


class GeneratedIdPreparationTests(unittest.TestCase):
    def test_untagged_prepare_indexes_generated_ids_and_preserves_the_source(self):
        original_bytes = pdf_bytes()
        tagged_bytes = serialized(generated_writer())
        toolchain = {name: {'command': 'local-test-tool', 'args': []}
                     for name in ('openDataLoader', 'veraPdf')}
        with tempfile.TemporaryDirectory() as temporary:
            folder = Path(temporary)
            request = folder / 'input.pdf'
            request.write_bytes(original_bytes)

            def native_tools(command, **kwargs):
                if '--output-dir' in command:
                    (Path(command[command.index('--output-dir') + 1]) / 'source_tagged.pdf').write_bytes(tagged_bytes)
                    return 0, b''
                return 1, json.dumps(validation(Path(command[-1]))).encode()

            # Substitute only the external executables. The actual worker,
            # saved-byte validators and PDFium preservation checks all run.
            with patch.object(worker, 'run_bounded', side_effect=native_tools):
                result = worker.process('prepare', request, folder, toolchain)
            self.assertEqual(request.read_bytes(), original_bytes)
            self.assertEqual(result['sourceSha256'], worker.digest(original_bytes))
            self.assertTrue(result['machineChecks']['preservationPassed'])
            self.assertTrue(result['inventory']['native_id_tree']['verified'])
            saved = PdfReader(folder / 'output.pdf')
            root = saved.trailer['/Root']['/StructTreeRoot']
            listing = root['/K'][0].get_object()['/K'][0].get_object()
            self.assertEqual(listing['/ID'].original_bytes, b'generated-list-1')
            self.assertEqual(listing['/A']['/ContinuedFrom'], 'unresolved-source-value')
            self.assertEqual(listing['/A']['/ListNumbering'], '/Decimal')
            self.assertIs(worker.verify_pdf.structure_id_tree(root)[b'generated-list-1'.hex()], listing)
            self.assertIn('generated_identifier_index_added', [change['code'] for change in result['changes']])

    def test_tagged_upload_with_missing_authored_index_still_refuses(self):
        original_bytes = serialized(generated_writer())
        with tempfile.TemporaryDirectory() as temporary:
            folder = Path(temporary)
            request = folder / 'input.pdf'
            request.write_bytes(original_bytes)
            with self.assertRaisesRegex(worker.WorkerError, 'native_pdf_preservation'):
                worker.process('prepare', request, folder, {})
            self.assertEqual(request.read_bytes(), original_bytes)
            self.assertNotIn('/IDTree', PdfReader(folder / 'output.pdf').trailer['/Root']['/StructTreeRoot'])


class GeneratedIdIndexTests(unittest.TestCase):
    def setUp(self):
        self.original = PdfReader(io.BytesIO(pdf_bytes()))

    def nodes(self, writer):
        root = writer.root_object['/StructTreeRoot']
        document = root['/K'][0].get_object()
        return root, document, document['/K'][0].get_object()

    def test_valid_index_preserves_raw_ids_and_uses_byte_order(self):
        writer = generated_writer()
        root, document, listing = self.nodes(writer)
        document[NameObject('/ID')] = ByteStringObject(b'9')
        listing[NameObject('/ID')] = TextStringObject('10')
        before = PdfReader(io.BytesIO(serialized(writer)))
        self.assertEqual(repairs.initialize_generated_id_tree(self.original, writer), 2)
        after = PdfReader(io.BytesIO(serialized(writer)))
        repairs.verify_generated_id_tree(before, after)
        names = after.trailer['/Root']['/StructTreeRoot']['/IDTree']['/Names']
        self.assertEqual([repairs._raw_id(value) for value in names[::2]], [b'10', b'9'])
        repairs.verify_authored_ids(self.original, after)

    def test_empty_id_set_and_valid_existing_index_are_unchanged(self):
        empty = PdfWriter(clone_from=PdfReader(io.BytesIO(pdf_bytes(tagged=True))))
        before = serialized(empty)
        self.assertEqual(repairs.initialize_generated_id_tree(self.original, empty), 0)
        self.assertEqual(serialized(empty), before)
        writer = generated_writer()
        repairs.initialize_generated_id_tree(self.original, writer)
        before = serialized(writer)
        self.assertEqual(repairs.initialize_generated_id_tree(self.original, writer), 0)
        self.assertEqual(serialized(writer), before)

    def test_binary_id_bytes_are_preserved(self):
        writer = generated_writer()
        self.nodes(writer)[2][NameObject('/ID')] = ByteStringObject(b'\x00\xfe\xff\x01')
        before = PdfReader(io.BytesIO(serialized(writer)))
        repairs.initialize_generated_id_tree(self.original, writer)
        after = PdfReader(io.BytesIO(serialized(writer)))
        repairs.verify_generated_id_tree(before, after)
        self.assertEqual(set(worker.verify_pdf.structure_id_tree(after.trailer['/Root']['/StructTreeRoot'])), {'00feff01'})

    def test_depth_and_node_budgets_remain_enforced(self):
        for limit in ('MAX_DEPTH', 'MAX_TAGS'):
            writer = generated_writer()
            with self.subTest(limit=limit), patch.object(repairs, limit, 1), self.assertRaises(repairs.NoteIdError):
                repairs.initialize_generated_id_tree(self.original, writer)
            self.assertNotIn('/IDTree', writer.root_object['/StructTreeRoot'])

    def test_tagged_uploaded_source_is_never_reindexed(self):
        writer = generated_writer()
        before = serialized(writer)
        with self.assertRaises(repairs.NoteIdError):
            repairs.initialize_generated_id_tree(PdfReader(io.BytesIO(before)), writer)
        self.assertEqual(serialized(writer), before)

    def test_invalid_or_duplicate_ids_fail_before_any_mutation(self):
        for value in (TextStringObject(''), ByteStringObject(b''), TextStringObject('x' * 513), NumberObject(1)):
            writer = generated_writer()
            self.nodes(writer)[2][NameObject('/ID')] = value
            before = serialized(writer)
            with self.subTest(value=repr(value)), self.assertRaises(repairs.NoteIdError):
                repairs.initialize_generated_id_tree(self.original, writer)
            self.assertEqual(serialized(writer), before)
        writer = generated_writer()
        self.nodes(writer)[1][NameObject('/ID')] = ByteStringObject(b'generated-list-1')
        before = serialized(writer)
        with self.assertRaises(repairs.NoteIdError):
            repairs.initialize_generated_id_tree(self.original, writer)
        self.assertEqual(serialized(writer), before)

    def test_ambiguous_hierarchy_is_not_indexed(self):
        mutations = (
            lambda root, document, listing: listing.__setitem__(NameObject('/P'), root.indirect_reference),
            lambda root, document, listing: document['/K'].append(listing.indirect_reference),
            lambda root, document, listing: listing.__setitem__(NameObject('/K'), document.indirect_reference),
            lambda root, document, listing: document.__setitem__(NameObject('/K'), ArrayObject([DictionaryObject(listing)])),
        )
        for mutation in mutations:
            writer = generated_writer()
            mutation(*self.nodes(writer))
            with self.subTest(mutation=mutation), self.assertRaises(repairs.NoteIdError):
                repairs.initialize_generated_id_tree(self.original, writer)
            self.assertNotIn('/IDTree', writer.root_object['/StructTreeRoot'])

    def test_existing_malformed_or_conflicting_index_is_not_replaced(self):
        for malformed in ('empty', 'wrong-owner', 'extension'):
            writer = generated_writer()
            root, document, listing = self.nodes(writer)
            names = ArrayObject() if malformed == 'empty' else ArrayObject([
                TextStringObject('generated-list-1'), document.indirect_reference if malformed == 'wrong-owner' else listing.indirect_reference])
            index = DictionaryObject({NameObject('/Names'): names})
            if malformed == 'extension':
                index[NameObject('/PrivateMetadata')] = TextStringObject('preserve')
            root[NameObject('/IDTree')] = index
            before = serialized(writer)
            with self.subTest(malformed=malformed), self.assertRaises(repairs.NoteIdError):
                repairs.initialize_generated_id_tree(self.original, writer)
            self.assertEqual(serialized(writer), before)

    def test_reopened_verification_rejects_index_id_owner_and_metadata_changes(self):
        mutations = (
            lambda root, document, listing: root.pop('/IDTree'),
            lambda root, document, listing: root['/IDTree']['/Names'].__setitem__(1, document.indirect_reference),
            lambda root, document, listing: root['/IDTree']['/Names'].extend([TextStringObject('unapproved'), listing.indirect_reference]),
            lambda root, document, listing: listing.__setitem__(NameObject('/ID'), TextStringObject('changed')),
            lambda root, document, listing: listing['/A'].__setitem__(NameObject('/ContinuedFrom'), TextStringObject('changed')),
            lambda root, document, listing: listing.__setitem__(NameObject('/Alt'), TextStringObject('unapproved')),
            lambda root, document, listing: listing.__setitem__(NameObject('/P'), root.indirect_reference),
            lambda root, document, listing: root['/IDTree'].__setitem__(NameObject('/Limits'), ArrayObject([TextStringObject('wrong'), TextStringObject('wrong')])),
        )
        for mutation in mutations:
            writer = generated_writer()
            before = PdfReader(io.BytesIO(serialized(writer)))
            repairs.initialize_generated_id_tree(self.original, writer)
            mutation(*self.nodes(writer))
            with self.subTest(mutation=mutation), self.assertRaises(repairs.NoteIdError):
                repairs.verify_generated_id_tree(before, PdfReader(io.BytesIO(serialized(writer))))

    def test_index_checkpoint_composes_with_independently_verified_note_ids(self):
        writer = generated_writer()
        root, document, listing = self.nodes(writer)
        document[NameObject('/S')] = NameObject('/Note')
        before = PdfReader(io.BytesIO(serialized(writer)))
        repairs.initialize_generated_id_tree(self.original, writer)
        indexed = PdfReader(io.BytesIO(serialized(writer)))
        repairs.verify_generated_id_tree(before, indexed)
        writer = PdfWriter(clone_from=indexed)
        note_before = repairs.note_id_snapshot(writer)
        changes = repairs.repair_note_ids(writer)
        saved = PdfReader(io.BytesIO(serialized(writer)))
        repairs.verify_note_ids(note_before, saved)
        repairs.verify_authored_ids(indexed, saved)
        self.assertEqual(len(changes), 1)
        self.assertEqual(len(worker.verify_pdf.structure_id_tree(saved.trailer['/Root']['/StructTreeRoot'])), 2)


if __name__ == '__main__':
    unittest.main()
