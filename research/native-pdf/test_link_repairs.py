from pathlib import Path
import tempfile
import unittest

from pypdf import PdfReader, PdfWriter
from pypdf.generic import ArrayObject, DictionaryObject, NameObject, NumberObject, TextStringObject

from link_repairs import repair_generated_link_placeholders
from semantic_repairs import _tag_nodes
from test_semantic_repairs import fixture as text_fixture
from verify_pdf import compare_pdfs


class LinkRepairsTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(); self.addCleanup(temp.cleanup)
        self.folder = Path(temp.name)
        self.original = self.folder/'original.pdf'; self.candidate = self.folder/'candidate.pdf'; self.output = self.folder/'output.pdf'

    def files(self, *, authored=None, wrong_destination=False, empty=False, bad_parent=False, signed=False):
        base = self.folder/'base.pdf'; text_fixture(base)
        writer = PdfWriter(clone_from=base)
        page = writer.pages[0]; node = _tag_nodes(writer)[0]; node[NameObject('/S')] = NameObject('/Link')
        if empty:
            content = page.get_contents(); content.set_data(b'/Link <</MCID 0>> BDC EMC'); page[NameObject('/Contents')] = writer._add_object(content)
        annotation = DictionaryObject({NameObject('/Type'):NameObject('/Annot'), NameObject('/Subtype'):NameObject('/Link'),
            NameObject('/Rect'):ArrayObject([NumberObject(n) for n in (20,90,180,110)]), NameObject('/StructParent'):NumberObject(1),
            NameObject('/A'):DictionaryObject({NameObject('/S'):NameObject('/URI'), NameObject('/URI'):TextStringObject('https://example.edu/diagram')})})
        annotation_ref = writer._add_object(annotation)
        page[NameObject('/Annots')] = ArrayObject([annotation_ref])
        node[NameObject('/K')] = ArrayObject([NumberObject(0),DictionaryObject({NameObject('/Type'):NameObject('/OBJR'),NameObject('/Obj'):annotation_ref,NameObject('/Pg'):page.indirect_reference})])
        root = writer.root_object['/StructTreeRoot']
        root['/ParentTree']['/Nums'].extend([NumberObject(1), node.indirect_reference])
        if authored is not None:
            node[NameObject('/Alt')] = TextStringObject(authored); annotation[NameObject('/Contents')] = TextStringObject(authored)
        if signed:writer.root_object[NameObject('/Perms')] = DictionaryObject()
        with self.original.open('xb') as stream:writer.write(stream)
        writer = PdfWriter(clone_from=self.original)
        node = _tag_nodes(writer)[0]; annotation = writer.pages[0]['/Annots'][0].get_object()
        node[NameObject('/Alt')] = TextStringObject('Annotation'); annotation[NameObject('/Contents')] = TextStringObject('Annotation')
        if wrong_destination:annotation['/A'][NameObject('/URI')] = TextStringObject('https://example.edu/other')
        if bad_parent:annotation[NameObject('/StructParent')] = NumberObject(999)
        with self.candidate.open('xb') as stream:writer.write(stream)

    def test_replaces_generated_placeholder_with_native_text_same_pixels(self):
        self.files(); source_bytes = self.original.read_bytes(); candidate_bytes = self.candidate.read_bytes()
        report = repair_generated_link_placeholders(self.original,self.candidate,self.output)
        self.assertEqual(1,len(report['changes'])); self.assertEqual([],report['unresolved'])
        self.assertEqual('Consider the diagram.',_tag_nodes(PdfReader(self.output))[0]['/Alt'])
        self.assertEqual('Consider the diagram.',PdfReader(self.output).pages[0]['/Annots'][0].get_object()['/Contents'])
        self.assertTrue(compare_pdfs(self.original,self.output)['preservation']['passed'])
        self.assertEqual(source_bytes,self.original.read_bytes()); self.assertEqual(candidate_bytes,self.candidate.read_bytes())

    def test_wrong_destination_is_left_unresolved(self):
        self.files(wrong_destination=True)
        report=repair_generated_link_placeholders(self.original,self.candidate,self.output)
        self.assertEqual([],report['changes']); self.assertEqual('source_annotation_identity_unverified',report['unresolved'][0]['code'])
        self.assertEqual('Annotation',_tag_nodes(PdfReader(self.output))[0]['/Alt'])

    def test_authored_description_cannot_be_overwritten(self):
        self.files(authored='Authored purpose')
        with self.assertRaisesRegex(ValueError,'authored_link_description_changed'):
            repair_generated_link_placeholders(self.original,self.candidate,self.output)
        self.assertFalse(self.output.exists())

    def test_authored_literal_placeholder_is_preserved(self):
        self.files(authored='Annotation')
        report=repair_generated_link_placeholders(self.original,self.candidate,self.output)
        self.assertEqual([],report['changes']); self.assertEqual('Annotation',_tag_nodes(PdfReader(self.output))[0]['/Alt'])

    def test_missing_native_text_remains_unresolved(self):
        self.files(empty=True)
        report=repair_generated_link_placeholders(self.original,self.candidate,self.output)
        self.assertEqual([],report['changes']); self.assertTrue(report['unresolved'])

    def test_unverified_parent_tree_remains_unresolved(self):
        self.files(bad_parent=True)
        report=repair_generated_link_placeholders(self.original,self.candidate,self.output)
        self.assertEqual([],report['changes']); self.assertEqual('link_structure_ambiguous',report['unresolved'][0]['code'])

    def test_signed_and_overwrite_rejected(self):
        self.files(signed=True)
        with self.assertRaisesRegex(ValueError,'signed_pdf'):
            repair_generated_link_placeholders(self.original,self.candidate,self.output)
        with self.assertRaises(ValueError):repair_generated_link_placeholders(self.original,self.candidate,self.original)
        self.output.write_bytes(b'keep')
        with self.assertRaises(ValueError):repair_generated_link_placeholders(self.original,self.candidate,self.output)
        self.assertEqual(b'keep',self.output.read_bytes())


if __name__=='__main__':unittest.main()
