"""Saved-byte adversarial tests authored independently of the label writer."""
import copy
import tempfile
import unittest
from pathlib import Path

from pypdf import PdfReader, PdfWriter
from pypdf.generic import (ArrayObject, BooleanObject, DictionaryObject, NameObject,
                           NumberObject, TextStringObject, DecodedStreamObject)

import form_label_validation as f
import verify_pdf as v


def D(**values):
    return DictionaryObject({NameObject('/' + key): value for key, value in values.items()})


def save(writer, path):
    with path.open('xb') as handle:
        writer.write(handle)


def form_fixture(path, *, multi=False, parent_tooltip=False, button=False, source_alt=None):
    writer = PdfWriter()
    page = writer.add_blank_page(300, 400)
    writer.root_object[NameObject('/Lang')] = TextStringObject('en-US')
    writer.add_metadata({'/Title': 'Fictional form validation fixture'})
    widgets = []
    for index in range(2):
        ap = DecodedStreamObject(); ap.set_data(b'1 1 1 rg 0 0 120 20 re f 0 0 0 RG 0 0 120 20 re S')
        ap.update(D(Type=NameObject('/XObject'), Subtype=NameObject('/Form'),
                    BBox=ArrayObject([NumberObject(n) for n in (0, 0, 120, 20)])))
        widget = D(Type=NameObject('/Annot'), Subtype=NameObject('/Widget'),
                   Rect=ArrayObject([NumberObject(n) for n in (20, 300 - index * 40, 140, 320 - index * 40)]),
                   P=page.indirect_reference, AP=D(N=writer._add_object(ap)), F=NumberObject(4))
        widgets.append(writer._add_object(widget))
    if multi or parent_tooltip:
        terminal = D(T=TextStringObject('child'), FT=NameObject('/Btn' if button else '/Tx'),
                     Ff=NumberObject(32768 if button else 0), Kids=ArrayObject(widgets))
        if not parent_tooltip: terminal[NameObject('/TU')] = TextStringObject('Participant name')
        owner = writer._add_object(terminal)
        for widget in widgets: widget.get_object()[NameObject('/Parent')] = owner
        if parent_tooltip:
            parent = writer._add_object(D(T=TextStringObject('group'), TU=TextStringObject('Wrong group title'),
                                         Kids=ArrayObject([owner])))
            terminal[NameObject('/Parent')] = parent
            fields = [parent]
        else: fields = [owner]
    else:
        fields = widgets
        for index, ref in enumerate(widgets):
            ref.get_object().update(D(T=TextStringObject(f'field{index}'), FT=NameObject('/Tx'),
                                     TU=TextStringObject(('Participant name', 'Preferred session')[index]),
                                     V=TextStringObject(('Alex Example', 'Morning')[index])))
    page[NameObject('/Annots')] = ArrayObject(widgets)
    writer.root_object[NameObject('/AcroForm')] = writer._add_object(D(Fields=ArrayObject(fields)))
    if source_alt is not None: tag(writer, source_alt)
    save(writer, path)


def tag(writer, alt='Annotation'):
    root = writer._add_object(D(Type=NameObject('/StructTreeRoot')))
    document = writer._add_object(D(Type=NameObject('/StructElem'), S=NameObject('/Document'), P=root))
    root.get_object()[NameObject('/K')] = document
    children, nums = [], []
    for index, widget in enumerate(writer.pages[0]['/Annots']):
        widget.get_object()[NameObject('/StructParent')] = NumberObject(index)
        form = writer._add_object(D(Type=NameObject('/StructElem'), S=NameObject('/Form'), P=document,
                                    Pg=writer.pages[0].indirect_reference, Alt=TextStringObject(alt),
                                    K=D(Type=NameObject('/OBJR'), Obj=widget, Pg=writer.pages[0].indirect_reference)))
        children.append(form); nums.extend([NumberObject(index), form])
    document.get_object()[NameObject('/K')] = ArrayObject(children)
    root.get_object()[NameObject('/ParentTree')] = writer._add_object(D(Nums=ArrayObject(nums)))
    root.get_object()[NameObject('/ParentTreeNextKey')] = NumberObject(2)
    writer.root_object[NameObject('/StructTreeRoot')] = root
    writer.root_object[NameObject('/MarkInfo')] = D(Marked=BooleanObject(True))
    writer.pages[0][NameObject('/Tabs')] = NameObject('/S')


def forms(writer):
    return writer.root_object['/StructTreeRoot']['/K']['/K']


class FormLabelValidationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='independent-form-labels-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source, self.before, self.final = [self.root / name for name in ('source.pdf', 'input.pdf', 'output.pdf')]

    def build(self, **options):
        form_fixture(self.source, **options)
        candidate = PdfWriter(clone_from=PdfReader(self.source))
        if '/StructTreeRoot' not in candidate.root_object: tag(candidate)
        for widget in candidate.pages[0]['/Annots']:
            widget.get_object()[NameObject('/Contents')] = TextStringObject('Annotation')
        save(candidate, self.before)
        output = PdfWriter(clone_from=PdfReader(self.before))
        changes = []
        for index in range(2):
            label = 'Wrong group title' if options.get('parent_tooltip') else ('Participant name' if options.get('multi') else ('Participant name', 'Preferred session')[index])
            path = ['group', 'child'] if options.get('parent_tooltip') else (['child'] if options.get('multi') else [f'field{index}'])
            for target, node, prop in [('formAlt', forms(output)[index].get_object(), '/Alt'),
                                       ('widgetContents', output.pages[0]['/Annots'][index].get_object(), '/Contents')]:
                changes.append({'target': target, 'fieldPath': path,
                                'widgetRefs': [{'pageNumber': 1, 'annotationIndex': index + 1}],
                                'tagId': f'tag-{index + 2}', 'beforePresent': prop in node,
                                'beforeValue': str(node[prop]) if prop in node else None,
                                'afterValue': label, 'evidenceKind': 'terminalFieldTooltip'})
                node[NameObject(prop)] = TextStringObject(label)
        save(output, self.final)
        self.ledger = {'schemaVersion': 1, 'operation': 'native-form-labels',
                       'sourcePath': str(self.source), 'inputPath': str(self.before),
                       'sourceSha256': v.digest(self.source.read_bytes()), 'inputSha256': v.digest(self.before.read_bytes()),
                       'outputSha256': v.digest(self.final.read_bytes()), 'changes': changes,
                       'reviewItems': [], 'widgetEvidence': [], 'requiresRevalidation': True, 'certification': False}

    def mutate_final(self, operation):
        writer = PdfWriter(clone_from=PdfReader(self.final)); operation(writer)
        new_path = self.root / 'mutated.pdf'; save(writer, new_path)
        self.final = new_path; self.ledger['outputSha256'] = v.digest(new_path.read_bytes())

    def reject(self, fragment):
        with self.assertRaisesRegex(v.InspectionError, fragment):
            f.authorize_form_labels(self.source, self.final, self.ledger)

    def test_exact_labels_pass_saved_pdf_and_leave_files_unchanged(self):
        self.build(); hashes = [v.digest(p.read_bytes()) for p in (self.source, self.before, self.final)]
        result = f.compare_with_authorized_form_labels(self.source, self.final, self.ledger)
        self.assertTrue(result['form_label_validation']['passed'], result['form_label_validation'])
        self.assertTrue(result['preservation']['passed']); self.assertTrue(result['passed'])
        self.assertEqual(hashes, [v.digest(p.read_bytes()) for p in (self.source, self.before, self.final)])
        evidence = result['form_label_validation']['widgetEvidence']
        self.assertEqual(evidence[0]['fieldType'], '/Tx')
        self.assertEqual(evidence[0]['value'], 'Alex Example')
        self.assertEqual(evidence[0]['tooltip'], 'Participant name')
        self.assertEqual(evidence[0]['formAlt'], 'Participant name')
        self.assertEqual(evidence[0]['widgetContents'], 'Participant name')
        self.assertTrue(result['form_label_validation']['initializedFormAppearancePixelsIdentical'])

    def test_same_terminal_field_with_multiple_widgets_is_not_ambiguous(self):
        self.build(multi=True)
        self.assertTrue(f.authorize_form_labels(self.source, self.final, self.ledger)['passed'])

    def test_nonterminal_tooltip_is_not_inherited_as_a_child_label(self):
        self.build(parent_tooltip=True)
        self.reject('value_not_authored')

    def test_radio_group_tooltip_does_not_name_options(self):
        self.build(multi=True, button=True)
        self.reject('value_not_authored')

    def test_correct_text_from_wrong_field_is_rejected_even_with_updated_ledger(self):
        self.build()
        self.mutate_final(lambda w: forms(w)[0].get_object().__setitem__(NameObject('/Alt'), TextStringObject('Preferred session')))
        self.ledger['changes'][0]['afterValue'] = 'Preferred session'
        self.reject('value_not_authored')

    def test_unlisted_widget_description_is_not_ignored_by_graph_comparison(self):
        self.build()
        self.ledger['changes'] = [c for c in self.ledger['changes'] if not (c['target'] == 'widgetContents' and c['tagId'] == 'tag-3')]
        self.reject('unlisted_native_change')

    def test_field_value_and_action_are_outside_label_permission(self):
        self.build()
        self.mutate_final(lambda w: w.pages[0]['/Annots'][0].get_object().__setitem__(NameObject('/V'), TextStringObject('Someone else')))
        self.reject('original_field_behavior_changed')

    def test_appearance_stream_and_geometry_cannot_change(self):
        self.build()
        self.mutate_final(lambda w: w.pages[0]['/Annots'][0].get_object().__setitem__(NameObject('/Rect'), ArrayObject([NumberObject(n) for n in (21, 300, 141, 320)])))
        self.reject('original_field_behavior_changed')

    def test_native_actualtext_cannot_silently_override_correct_label(self):
        self.build()
        self.mutate_final(lambda w: forms(w)[0].get_object().__setitem__(NameObject('/ActualText'), TextStringObject('Wrong reading')))
        self.reject('form_shape_unsupported')

    def test_parenttree_owner_and_objr_must_remain_consistent(self):
        self.build()
        self.mutate_final(lambda w: forms(w)[0].get_object()['/K'].__setitem__(NameObject('/Obj'), w.pages[0]['/Annots'][1]))
        self.reject('objr_unverified|multiple_tag_owners')

    def test_source_hash_cannot_be_replaced_with_a_hint(self):
        self.build(); self.ledger['sourceSha256'] = '0' * 64
        self.reject('hash_mismatch')

    def test_xfa_is_not_treated_as_a_static_native_form(self):
        self.build()
        self.mutate_final(lambda w: w.root_object['/AcroForm'].__setitem__(NameObject('/XFA'), TextStringObject('packet')))
        self.reject('native_acroform_required')

    def test_meaningful_authored_alt_cannot_be_replaced_by_tooltip(self):
        self.build(source_alt='Authored explanation')
        self.reject('authored_alt_changed')

    def test_duplicate_changes_and_wrong_before_value_are_rejected(self):
        self.build(); self.ledger['changes'].append(copy.deepcopy(self.ledger['changes'][0]))
        self.reject('duplicate_change')

    def test_shared_form_with_distinct_fields_derives_ambiguity_even_if_ledger_omits_it(self):
        self.build()
        writer = PdfWriter(clone_from=PdfReader(self.before))
        left, right = [ref.get_object() for ref in forms(writer)]
        left[NameObject('/K')] = ArrayObject([left['/K'], right['/K']])
        first = forms(writer)[0]
        writer.root_object['/StructTreeRoot']['/K'][NameObject('/K')] = ArrayObject([first])
        writer.root_object['/StructTreeRoot']['/ParentTree'][NameObject('/Nums')] = ArrayObject([
            NumberObject(0), first, NumberObject(1), first])
        self.before = self.root / 'shared-input.pdf'; save(writer, self.before)
        for index, ref in enumerate(writer.pages[0]['/Annots']):
            ref.get_object()[NameObject('/Contents')] = TextStringObject(('Participant name', 'Preferred session')[index])
        self.final = self.root / 'shared-output.pdf'; save(writer, self.final)
        self.ledger['inputPath'] = str(self.before)
        self.ledger['inputSha256'] = v.digest(self.before.read_bytes())
        self.ledger['outputSha256'] = v.digest(self.final.read_bytes())
        self.ledger['changes'] = [c for c in self.ledger['changes'] if c['target'] == 'widgetContents']
        for change in self.ledger['changes']: change['tagId'] = 'tag-2'
        result = f.compare_with_authorized_form_labels(self.source, self.final, self.ledger)
        self.assertTrue(result['form_label_validation']['passed'])
        self.assertFalse(result['mechanical_checks_passed'])
        self.assertIn('form_tag_label_ambiguous', [r['code'] for r in result['findings']])

    def test_radio_with_existing_labels_still_blocks_unreviewed_options(self):
        self.build(multi=True, button=True)
        writer = PdfWriter(clone_from=PdfReader(self.before))
        for index, ref in enumerate(forms(writer)):
            ref.get_object()[NameObject('/Alt')] = TextStringObject(f'Option {index + 1}')
            writer.pages[0]['/Annots'][index].get_object()[NameObject('/Contents')] = TextStringObject(f'Option {index + 1}')
        self.before = self.root / 'radio-input.pdf'; save(writer, self.before)
        self.final = self.root / 'radio-output.pdf'; save(writer, self.final)
        self.ledger.update(inputPath=str(self.before), inputSha256=v.digest(self.before.read_bytes()),
                           outputSha256=v.digest(self.final.read_bytes()), changes=[])
        result = f.compare_with_authorized_form_labels(self.source, self.final, self.ledger)
        self.assertTrue(result['form_label_validation']['passed'])
        self.assertFalse(result['mechanical_checks_passed'])
        self.assertIn('button_option_labels_need_review', [r['code'] for r in result['findings']])


if __name__ == '__main__':
    unittest.main()
