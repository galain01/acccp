"""Generated phantom link references never authorize removing authored content."""
import io
from pathlib import Path
import sys
import tempfile
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'research/native-pdf'))
from pypdf import PdfReader, PdfWriter
from pypdf.generic import ArrayObject, ContentStream, DecodedStreamObject, DictionaryObject, NameObject as N, NullObject, NumberObject as I, TextStringObject as S
import bounded_semantic_structure as b
import native_generated_references as g
import verify_pdf as v
from test_native_pdf_validation import pdf_bytes


def saved(writer):
    stream = io.BytesIO(); writer.write(stream); return stream.getvalue()


def fixture(*, real_content=False, label=True, wrong_owner=False, protected=False, copied_alt=False, bad_alt=False, copied_uri=False):
    writer = PdfWriter(clone_from=PdfReader(io.BytesIO(pdf_bytes(tagged=True, link='https://example.org/status'))))
    page = writer.pages[0]
    root = writer.root_object['/StructTreeRoot']
    document = root['/K'][0].get_object()
    annotation = page['/Annots'][0].get_object()
    if label:
        annotation[N('/Contents')] = S('https://example.org/status' if copied_uri else 'Check publication status')
    annotation[N('/StructParent')] = I(1)
    link = DictionaryObject({N('/Type'): N('/StructElem'), N('/S'): N('/Link'), N('/P'): document.indirect_reference,
                             N('/Pg'): page.indirect_reference, N('/ID'): S('generated-link')})
    if copied_alt or bad_alt:
        link[N('/Alt')] = S('An unrelated generated description' if bad_alt else 'https://example.org/status' if copied_uri else 'Check publication status')
    link_ref = writer._add_object(link)
    objr = DictionaryObject({N('/Type'): N('/OBJR'), N('/Obj'): page['/Annots'][0], N('/Pg'): page.indirect_reference})
    link[N('/K')] = ArrayObject([objr, I(13)])
    if protected:
        document[N('/ActualText')] = S('An authored replacement')
    document['/K'].append(link_ref)
    owners = root['/ParentTree']['/Nums'][1]
    while len(owners) <= 13:
        owners.append(NullObject())
    owners[13] = document.indirect_reference if wrong_owner else link_ref
    root['/ParentTree'][N('/Nums')] = ArrayObject([I(0), owners, I(1), link_ref])
    root[N('/IDTree')] = DictionaryObject({N('/Names'): ArrayObject([S('generated-link'), link_ref])})
    if real_content:
        stream = DecodedStreamObject()
        stream.set_data(page.get_contents().get_data() + b' /Link << /MCID 13 >> BDC BT /F1 12 Tf 20 20 Td (Real source text) Tj ET EMC')
        page[N('/Contents')] = writer._add_object(stream)
    generated = PdfReader(io.BytesIO(saved(writer)))
    original = PdfWriter(clone_from=generated)
    original.root_object.pop('/StructTreeRoot')
    original.root_object.pop('/MarkInfo', None)
    original.pages[0].pop('/StructParents')
    original.pages[0]['/Annots'][0].get_object().pop('/StructParent')
    if copied_uri:
        original.pages[0]['/Annots'][0].get_object().pop('/Contents', None)
    content = ContentStream(None, original)
    content.operations = [(args, op) for args, op in v.operations(original.pages[0]) if op not in (b'BDC', b'BMC', b'EMC')]
    original.pages[0][N('/Contents')] = original._add_object(content)
    return PdfReader(io.BytesIO(saved(original))), generated


class GeneratedReferenceTests(unittest.TestCase):
    def repair(self):
        original, generated = fixture()
        writer = PdfWriter(clone_from=generated)
        old = list(b.nodes(writer))
        result = g.repair_generated_link_references(original, writer)
        self.assertEqual(len(result['changes']), 1)
        reopened = PdfReader(io.BytesIO(saved(writer)))
        self.assertTrue(g.verify_generated_link_references(original, reopened, result['verification']))
        return original, generated, writer, old, reopened, result

    def test_phantom_reference_only_is_removed_with_all_nodes_paint_and_links_kept(self):
        original, generated, writer, old, reopened, result = self.repair()
        self.assertFalse(v.structure_inventory(generated)['checks_complete'])
        self.assertTrue(v.structure_inventory(reopened)['checks_complete'])
        self.assertTrue(all(any(node is previous for node in b.nodes(writer)) for previous in old))
        link = next(node for node in b.nodes(reopened) if node['/S'] == '/Link')
        self.assertEqual(link['/ID'], 'generated-link')
        self.assertEqual(len(link['/K']), 1)
        self.assertIsInstance(v.number_tree(reopened.trailer['/Root']['/StructTreeRoot']['/ParentTree'])[0][13], NullObject)
        self.assertTrue(v.compare_annotations(original, reopened)['passed'])
        with tempfile.TemporaryDirectory() as directory:
            before, after = Path(directory) / 'source.pdf', Path(directory) / 'output.pdf'
            before.write_bytes(original.stream.getvalue()); after.write_bytes(reopened.stream.getvalue())
            report = v.compare_pdfs(before, after)
        self.assertTrue(report['preservation']['passed'], report['findings'])
        self.assertTrue(report['preservation']['pages'][0]['pixels_identical'])

    def test_authored_tagged_source_real_content_or_unverified_owners_are_not_changed(self):
        for options in ({'real_content': True}, {'label': False}, {'wrong_owner': True}, {'protected': True}, {'bad_alt': True}):
            original, generated = fixture(**options)
            writer = PdfWriter(clone_from=generated)
            with self.subTest(options=options):
                self.assertEqual(g.repair_generated_link_references(original, writer)['changes'], [])
        original, generated = fixture()
        self.assertEqual(g.repair_generated_link_references(generated, PdfWriter(clone_from=generated))['changes'], [])

    def test_exact_source_copied_generated_description_is_kept(self):
        original, generated = fixture(copied_alt=True)
        writer = PdfWriter(clone_from=generated)
        result = g.repair_generated_link_references(original, writer)
        self.assertEqual(len(result['changes']), 1)
        reopened = PdfReader(io.BytesIO(saved(writer)))
        self.assertTrue(g.verify_generated_link_references(original, reopened, result['verification']))
        self.assertEqual(next(node for node in b.nodes(reopened) if node['/S'] == '/Link')['/Alt'], 'Check publication status')

    def test_exact_source_uri_copied_by_tagger_is_kept(self):
        original, generated = fixture(copied_alt=True, copied_uri=True)
        writer = PdfWriter(clone_from=generated)
        result = g.repair_generated_link_references(original, writer)
        self.assertEqual(len(result['changes']), 1)
        reopened = PdfReader(io.BytesIO(saved(writer)))
        self.assertTrue(g.verify_generated_link_references(original, reopened, result['verification']))

    def test_saved_verification_rejects_extra_structural_link_or_paint_changes(self):
        original, _, _, _, reopened, result = self.repair()
        for mutation in ('role', 'link', 'parentTree', 'page', 'language', 'paint'):
            writer = PdfWriter(clone_from=reopened)
            if mutation == 'role':
                next(node for node in b.nodes(writer) if node['/S'] == '/P')[N('/S')] = N('/H1')
            elif mutation == 'link':
                writer.pages[0]['/Annots'][0].get_object()['/A'][N('/URI')] = S('https://example.org/changed')
            elif mutation == 'parentTree':
                writer.root_object['/StructTreeRoot']['/ParentTree']['/Nums'][1][13] = writer.root_object['/StructTreeRoot']['/K'][0]
            elif mutation == 'page':
                writer.pages[0][N('/MediaBox')] = ArrayObject([I(0), I(0), I(300), I(100)])
            elif mutation == 'language':
                writer.root_object[N('/Lang')] = S('fr-FR')
            else:
                page = writer.pages[0]
                stream = DecodedStreamObject(); stream.set_data(page.get_contents().get_data().replace(b'Hello', b'Other'))
                page[N('/Contents')] = writer._add_object(stream)
            with self.subTest(mutation=mutation), self.assertRaises(v.InspectionError):
                g.verify_generated_link_references(original, PdfReader(io.BytesIO(saved(writer))), result['verification'])


if __name__ == '__main__':
    unittest.main()
