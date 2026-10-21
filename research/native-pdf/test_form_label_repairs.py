import hashlib
from pathlib import Path
import tempfile
import unittest

from pypdf import PdfReader, PdfWriter
from pypdf.generic import ArrayObject, DictionaryObject, NameObject, NumberObject, TextStringObject
from reportlab.pdfgen import canvas

from form_label_repairs import repair_form_labels, _form_page_hashes
from verify_pdf import rendered_page_hashes, resolved


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def fixture(path):
    pdf = canvas.Canvas(str(path), pagesize=(400, 400))
    pdf.drawString(20, 360, 'Participant name')
    pdf.acroForm.textfield(name='participant', tooltip='Participant name', value='Alex Example',
                           x=150, y=345, width=220, height=24)
    pdf.drawString(20, 300, 'Preferred session')
    pdf.acroForm.choice(name='session', tooltip='Preferred session', options=['Morning', 'Afternoon'],
                       value='Morning', x=150, y=285, width=220, height=24)
    pdf.drawString(45, 245, 'Send workshop materials')
    pdf.acroForm.checkbox(name='materials', tooltip='Send workshop materials', x=20, y=240)
    pdf.showPage()
    pdf.save()


def mutate(path, callback):
    writer = PdfWriter(clone_from=path)
    callback(writer)
    with path.open('wb') as stream:
        writer.write(stream)


def tagged(source, target, *, one_form=False):
    writer = PdfWriter(clone_from=source)
    root = DictionaryObject({NameObject('/Type'): NameObject('/StructTreeRoot')})
    root_ref = writer._add_object(root)
    document = DictionaryObject({NameObject('/Type'): NameObject('/StructElem'),
        NameObject('/S'): NameObject('/Document'), NameObject('/P'): root_ref})
    doc_ref = writer._add_object(document)
    root[NameObject('/K')] = doc_ref
    children, nums, current = [], [], None
    for page in writer.pages:
        for i, annotation in enumerate(page['/Annots']):
            widget = resolved(annotation)
            if current is None or not one_form:
                current = DictionaryObject({NameObject('/Type'): NameObject('/StructElem'),
                    NameObject('/S'): NameObject('/Form'), NameObject('/P'): doc_ref,
                    NameObject('/Pg'): page.indirect_reference, NameObject('/Alt'): TextStringObject('Annotation'),
                    NameObject('/K'): ArrayObject()})
                children.append(writer._add_object(current))
            current['/K'].append(DictionaryObject({NameObject('/Type'): NameObject('/OBJR'),
                NameObject('/Obj'): annotation, NameObject('/Pg'): page.indirect_reference}))
            parent = len(nums) // 2
            widget[NameObject('/StructParent')] = NumberObject(parent)
            widget[NameObject('/Contents')] = TextStringObject('Annotation')
            nums.extend([NumberObject(parent), current.indirect_reference])
    document[NameObject('/K')] = ArrayObject(children)
    root[NameObject('/ParentTree')] = DictionaryObject({NameObject('/Nums'): ArrayObject(nums)})
    writer.root_object[NameObject('/StructTreeRoot')] = root_ref
    writer.root_object[NameObject('/Lang')] = TextStringObject('en-US')
    with target.open('xb') as stream:
        writer.write(stream)


class FormLabelRepairTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.original, self.candidate, self.output = [self.root / name for name in ('original.pdf', 'candidate.pdf', 'output.pdf')]
        fixture(self.original)

    def repair(self):
        return repair_form_labels(self.original, self.candidate, self.output,
            expected_original_sha256=digest(self.original), expected_candidate_sha256=digest(self.candidate))

    def test_saved_labels_preserve_source_and_form_filling_pixels(self):
        tagged(self.original, self.candidate)
        before = (self.original.read_bytes(), self.candidate.read_bytes())
        result = self.repair()
        self.assertEqual(6, len(result['changes']))
        self.assertEqual([], result['reviewItems'])
        saved = PdfReader(self.output)
        self.assertEqual(['Participant name', 'Preferred session', 'Send workshop materials'],
                         [a.get_object()['/Contents'] for a in saved.pages[0]['/Annots']])
        self.assertEqual(rendered_page_hashes(self.original), rendered_page_hashes(self.output))
        filled = []
        for name, source in [('source', self.original), ('repaired', self.output)]:
            writer = PdfWriter(clone_from=source)
            writer.update_page_form_field_values(writer.pages[0],
                {'participant': 'Jordan Example', 'session': 'Afternoon', 'materials': '/Yes'}, auto_regenerate=False)
            path = self.root / f'{name}-filled.pdf'
            with path.open('xb') as stream: writer.write(stream)
            fields = PdfReader(path).get_fields()
            self.assertEqual('Jordan Example', fields['participant']['/V'])
            self.assertEqual('Afternoon', fields['session']['/V'])
            self.assertEqual('/Yes', fields['materials']['/V'])
            filled.append(_form_page_hashes(path))
        self.assertEqual(filled[0], filled[1])
        self.assertEqual(before, (self.original.read_bytes(), self.candidate.read_bytes()))

    def test_tooltip_is_owned_by_terminal_field_not_inherited_from_ancestor(self):
        def parent(writer):
            form = writer.root_object['/AcroForm']
            field = form['/Fields'][0].get_object()
            field.pop('/TU')
            group = DictionaryObject({NameObject('/T'): TextStringObject('group'),
                NameObject('/TU'): TextStringObject('Wrong ancestor label'),
                NameObject('/Kids'): ArrayObject([field.indirect_reference])})
            ref = writer._add_object(group)
            field[NameObject('/Parent')] = ref
            form['/Fields'][0] = ref
        mutate(self.original, parent)
        tagged(self.original, self.candidate)
        report = self.repair()
        self.assertEqual(4, len(report['changes']))
        self.assertEqual('authored_form_label_missing', report['reviewItems'][0]['code'])
        self.assertNotIn('Wrong ancestor label', [c['afterValue'] for c in report['changes']])

    def test_multiple_text_widgets_share_terminal_tooltip_and_keep_widget_owners(self):
        def split(writer):
            form = writer.root_object['/AcroForm']
            first, second = [form['/Fields'][i].get_object() for i in (0, 1)]
            parent = DictionaryObject({NameObject('/T'): TextStringObject('repeated'),
                NameObject('/FT'): NameObject('/Tx'), NameObject('/TU'): TextStringObject('Repeated participant'),
                NameObject('/V'): TextStringObject('Alex Example')})
            parent_ref = writer._add_object(parent)
            for widget in (first, second):
                for key in ('/T', '/TU', '/FT', '/Ff', '/V', '/DV'): widget.pop(key, None)
                widget[NameObject('/Parent')] = parent_ref
            parent[NameObject('/Kids')] = ArrayObject([first.indirect_reference, second.indirect_reference])
            form[NameObject('/Fields')] = ArrayObject([parent_ref, form['/Fields'][2]])
        mutate(self.original, split)
        tagged(self.original, self.candidate)
        report = self.repair()
        repeated = [c for c in report['changes'] if c['fieldPath'] == ['repeated']]
        self.assertEqual(4, len(repeated))
        self.assertEqual({'Repeated participant'}, {c['afterValue'] for c in repeated})

    def test_existing_authored_descriptions_survive_instead_of_tooltip_replacement(self):
        def descriptions(writer):
            writer.pages[0]['/Annots'][0].get_object()[NameObject('/Contents')] = TextStringObject('Name as used on your registration')
        mutate(self.original, descriptions)
        tagged(self.original, self.candidate)
        report = self.repair()
        restored = [c for c in report['changes'] if c['target'] == 'widgetContents' and c['fieldPath'] == ['participant']]
        self.assertEqual('Name as used on your registration', restored[0]['afterValue'])
        self.assertEqual('authoredWidgetContents', restored[0]['evidenceKind'])

    def test_meaningful_candidate_descriptions_are_kept(self):
        tagged(self.original, self.candidate)
        def label(writer):
            writer.pages[0]['/Annots'][0].get_object()[NameObject('/Contents')] = TextStringObject('Existing meaningful label')
        mutate(self.candidate, label)
        report = self.repair()
        self.assertEqual(5, len(report['changes']))
        self.assertEqual('Existing meaningful label', PdfReader(self.output).pages[0]['/Annots'][0].get_object()['/Contents'])

    def test_internal_field_name_is_not_used_when_tooltip_missing(self):
        mutate(self.original, lambda w: w.pages[0]['/Annots'][0].get_object().pop('/TU'))
        tagged(self.original, self.candidate)
        report = self.repair()
        self.assertEqual(4, len(report['changes']))
        self.assertEqual('authored_form_label_missing', report['reviewItems'][0]['code'])

    def test_radio_control_requires_option_review_without_edit(self):
        mutate(self.original, lambda w: w.pages[0]['/Annots'][2].get_object().__setitem__(NameObject('/Ff'), NumberObject(32768)))
        tagged(self.original, self.candidate)
        report = self.repair()
        self.assertEqual(4, len(report['changes']))
        self.assertEqual('button_option_labels_need_review', report['reviewItems'][0]['code'])

    def test_shared_form_over_distinct_fields_does_not_assign_one_group_name(self):
        tagged(self.original, self.candidate, one_form=True)
        report = self.repair()
        self.assertEqual({'widgetContents'}, {c['target'] for c in report['changes']})
        self.assertEqual('form_tag_label_ambiguous', report['reviewItems'][0]['code'])

    def test_actual_pushbutton_caption_is_native_label_not_checkbox_caption(self):
        def push(writer):
            widget = writer.pages[0]['/Annots'][2].get_object()
            widget.pop('/TU')
            widget[NameObject('/Ff')] = NumberObject(65536)
            widget['/MK'][NameObject('/CA')] = TextStringObject('Submit registration')
        mutate(self.original, push)
        tagged(self.original, self.candidate)
        report = self.repair()
        self.assertEqual(2, len([c for c in report['changes'] if c['evidenceKind'] == 'pushbuttonCaption']))

    def test_checkbox_glyph_is_not_label(self):
        mutate(self.original, lambda w: w.pages[0]['/Annots'][2].get_object().pop('/TU'))
        tagged(self.original, self.candidate)
        self.assertEqual(4, len(self.repair()['changes']))

    def test_changed_behavior_and_bad_parenttree_fail(self):
        tagged(self.original, self.candidate)
        mutate(self.candidate, lambda w: w.pages[0]['/Annots'][0].get_object().__setitem__(NameObject('/V'), TextStringObject('Wrong value')))
        with self.assertRaisesRegex(ValueError, 'behavior'): self.repair()
        self.assertFalse(self.output.exists())

    def test_wrong_widget_parenttree_fails(self):
        tagged(self.original, self.candidate)
        def corrupt(writer):
            tree = writer.root_object['/StructTreeRoot']
            tree['/ParentTree']['/Nums'][1] = tree.indirect_reference
        mutate(self.candidate, corrupt)
        with self.assertRaisesRegex(ValueError, 'verified_widget'): self.repair()

    def test_duplicate_field_paths_rejected_even_with_identical_labels(self):
        mutate(self.original, lambda w: w.pages[0]['/Annots'][1].get_object().__setitem__(NameObject('/T'), TextStringObject('participant')))
        tagged(self.original, self.candidate)
        with self.assertRaisesRegex(ValueError, 'duplicate_fully'): self.repair()

    def test_stale_hash_and_overwrite_refused(self):
        tagged(self.original, self.candidate)
        with self.assertRaisesRegex(ValueError, 'hash'):
            repair_form_labels(self.original, self.candidate, self.output,
                expected_original_sha256='0' * 64, expected_candidate_sha256=digest(self.candidate))
        self.repair()
        with self.assertRaisesRegex(ValueError, 'new_output'): self.repair()

    def test_xfa_signature_and_encrypted_inputs_refused(self):
        for kind in ('xfa', 'signed', 'encrypted'):
            with self.subTest(kind=kind):
                original = self.root / f'{kind}.pdf'
                fixture(original)
                def special(writer):
                    if kind == 'xfa': writer.root_object['/AcroForm'][NameObject('/XFA')] = TextStringObject('unsupported')
                    elif kind == 'signed': writer.root_object[NameObject('/Perms')] = DictionaryObject()
                    else: writer.encrypt('secret')
                mutate(original, special)
                with self.assertRaises(ValueError):
                    repair_form_labels(original, original, self.root / f'{kind}-out.pdf',
                        expected_original_sha256=digest(original), expected_candidate_sha256=digest(original))


if __name__ == '__main__':
    unittest.main()
