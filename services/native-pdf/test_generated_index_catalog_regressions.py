"""Index validation compares catalog semantics across hierarchical page trees."""
import io
from pathlib import Path
import sys
import tempfile
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'research/native-pdf'))
from pypdf import PdfReader, PdfWriter
from pypdf.generic import ArrayObject, DecodedStreamObject, DictionaryObject, NameObject as N, NumberObject as I, TextStringObject as S
import native_structure_repairs as repairs
import verify_pdf as v
from test_generated_structure_ids import generated_writer, serialized
from test_native_pdf_validation import pdf_bytes


def hierarchical_reader():
    writer = generated_writer()
    writer.add_blank_page(200, 100)
    writer.add_blank_page(200, 100)
    pages = list(writer.pages)
    root = writer.root_object['/Pages']
    groups = []
    for chunk in (pages[:2], pages[2:]):
        group = DictionaryObject({N('/Type'): N('/Pages'), N('/Parent'): root.indirect_reference,
                                  N('/Count'): I(len(chunk)), N('/Kids'): ArrayObject([page.indirect_reference for page in chunk])})
        ref = writer._add_object(group)
        groups.append(ref)
        for page in chunk:
            page[N('/Parent')] = ref
    root[N('/Kids')] = ArrayObject(groups)
    root[N('/Count')] = I(3)
    return PdfReader(io.BytesIO(serialized(writer)))


def indexed(before):
    original = PdfReader(io.BytesIO(pdf_bytes()))
    writer = PdfWriter(clone_from=before)
    repairs.initialize_generated_id_tree(original, writer)
    return PdfReader(io.BytesIO(serialized(writer)))


class GeneratedIndexCatalogTests(unittest.TestCase):
    def test_equivalent_hierarchical_page_tree_does_not_fail_id_index_checkpoint(self):
        before = hierarchical_reader()
        after = indexed(before)
        self.assertEqual(len(before.trailer['/Root']['/Pages']['/Kids']), 2)
        self.assertEqual(len(after.trailer['/Root']['/Pages']['/Kids']), 3)
        self.assertEqual(repairs._state(before, allow_missing_index=True)[2].nodes, repairs._state(after)[2].nodes)
        repairs.verify_generated_id_tree(before, after)

    def test_catalog_and_native_metadata_changes_still_fail_checkpoint(self):
        before = hierarchical_reader()
        after = indexed(before)
        for mutation in ('catalog', 'native', 'stream'):
            writer = PdfWriter(clone_from=after)
            if mutation == 'catalog':
                writer.root_object[N('/Lang')] = S('fr-FR')
            elif mutation == 'native':
                listing = writer.root_object['/StructTreeRoot']['/K'][0].get_object()['/K'][0].get_object()
                listing['/A'][N('/ContinuedFrom')] = S('Changed source value')
            else:
                listing = writer.root_object['/StructTreeRoot']['/K'][0].get_object()['/K'][0].get_object()
                stream = DecodedStreamObject(); stream.set_data(b'changed native stream')
                listing[N('/PrivateStream')] = writer._add_object(stream)
            with self.subTest(mutation=mutation), self.assertRaises(repairs.NoteIdError):
                repairs.verify_generated_id_tree(before, PdfReader(io.BytesIO(serialized(writer))))

    def test_independent_page_preservation_still_rejects_leaf_font_or_annotation_changes(self):
        before = hierarchical_reader()
        after = indexed(before)
        for mutation in ('page', 'font', 'annotation'):
            writer = PdfWriter(clone_from=after)
            page = writer.pages[0]
            if mutation == 'page':
                page[N('/MediaBox')] = ArrayObject([I(0), I(0), I(300), I(100)])
            elif mutation == 'font':
                page['/Resources']['/Font']['/F1'].get_object()[N('/BaseFont')] = N('/Courier')
            else:
                annotation = DictionaryObject({N('/Type'): N('/Annot'), N('/Subtype'): N('/Link'),
                    N('/Rect'): ArrayObject([I(20), I(20), I(60), I(40)]),
                    N('/A'): DictionaryObject({N('/S'): N('/URI'), N('/URI'): S('https://example.org/new')})})
                page[N('/Annots')] = ArrayObject([writer._add_object(annotation)])
            with tempfile.TemporaryDirectory() as directory:
                source, output = Path(directory) / 'source.pdf', Path(directory) / 'output.pdf'
                source.write_bytes(before.stream.getvalue()); output.write_bytes(serialized(writer))
                report = v.compare_pdfs(source, output)
            with self.subTest(mutation=mutation):
                self.assertFalse(report['preservation']['passed'])


if __name__ == '__main__':
    unittest.main()
