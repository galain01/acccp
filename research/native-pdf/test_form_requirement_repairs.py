import io
import json
from pathlib import Path
import tempfile
import unittest

from pypdf import PdfReader, PdfWriter
from pypdf.generic import ArrayObject, NameObject, NumberObject

import form_requirement_repairs as r
from form_font_repairs import repair_form_fonts
from form_label_validation import _document_graph
from form_order_repairs import repair_form_reading_order
from test_form_label_repairs import mutate
from test_form_order_repairs import ordered_fixture


def font_fixture(directory, font):
    source, labeled, labels, audit, pairs = ordered_fixture(directory)
    review = json.loads(audit.read_text())
    review.update(machineFindingsRetained=True, plannedBatchCount=1, completedBatchCount=1)
    audit.write_text(json.dumps(review))
    ordered = directory / 'ordered.pdf'
    order = repair_form_reading_order(source, labeled, ordered, audit_report=audit,
        label_ledger=labels, pairs=pairs, expected_original_sha256=r.sha(source),
        expected_candidate_sha256=r.sha(labeled))
    order_path = directory / 'order.json'; order_path.write_text(json.dumps(order))
    embedded = directory / 'fonts.pdf'
    ledger = repair_form_fonts(source, ordered, embedded, font_path=font, order_ledger=order_path,
        expected_original_sha256=r.sha(source), expected_candidate_sha256=r.sha(ordered),
        allow_font_substitution=True)
    ledger_path = directory / 'font-ledger.json'; ledger_path.write_text(json.dumps(ledger))
    return source, embedded, ledger_path


class FormRequirementRepairTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        config = Path(__file__).resolve().parents[4] / 'work/pdf-native-tools/toolchain.json'
        if not config.is_file(): raise unittest.SkipTest('Local pinned font toolchain unavailable')
        cls.font = Path(json.loads(config.read_text())['fontDirectory']) / 'LiberationSans-Regular.ttf'

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        self.source, self.input, self.font_ledger = font_fixture(self.directory, self.font)
        self.decision = self.directory / 'author.json'
        self.decision.write_text(json.dumps({'schemaVersion': 1, 'candidateSha256': r.sha(self.input),
            'fieldPath': ['materials'], 'tooltip': 'Send workshop materials', 'clearRequired': True}))
        self.output = self.directory / 'optional.pdf'

    def repair(self):
        return r.repair_optional_materials(self.source, self.input, self.output,
            font_ledger=self.font_ledger, author_decision=self.decision,
            expected_original_sha256=r.sha(self.source), expected_candidate_sha256=r.sha(self.input))

    def test_exact_required_bit_only_changes_and_all_inputs_remain_immutable(self):
        paths = [self.source, self.input, self.font_ledger, self.decision]
        before_hashes = [r.sha(p) for p in paths]
        ledger = self.repair(); before, after = PdfReader(self.input), PdfReader(self.output)
        self.assertEqual((2, 0), (ledger['beforeFlags'], ledger['afterFlags']))
        self.assertEqual(['materials'], ledger['fieldPath'])
        self.assertEqual({'pageNumber': 1, 'annotationIndex': 3}, ledger['widgetRef'])
        fields = after.get_fields()
        self.assertEqual(0, fields['materials']['/Ff'])
        self.assertEqual(before.get_fields()['participant']['/Ff'], fields['participant']['/Ff'])
        self.assertEqual('/Off', fields['materials']['/V'])
        target, _, _ = r._target(after)
        target['node'][NameObject('/Ff')] = NumberObject(2)
        self.assertEqual(_document_graph(before), _document_graph(after))
        self.assertEqual(r._pixels(self.input.read_bytes()), r._pixels(self.output.read_bytes()))
        self.assertEqual(before_hashes, [r.sha(p) for p in paths])

    def test_authorization_is_exact_and_cannot_target_a_different_control(self):
        original = json.loads(self.decision.read_text())
        for key, value in [('clearRequired', False), ('candidateSha256', '0' * 64),
                           ('fieldPath', ['participant']), ('tooltip', 'Different checkbox'),
                           ('schemaVersion', True)]:
            with self.subTest(key=key):
                self.decision.write_text(json.dumps(dict(original, **{key: value})))
                with self.assertRaisesRegex(ValueError, 'exact_explicit_author_decision'): self.repair()
                self.assertFalse(self.output.exists())

    def test_stale_font_ledger_cannot_authorize_flag_change(self):
        ledger = json.loads(self.font_ledger.read_text()); ledger['outputSha256'] = '0' * 64
        self.font_ledger.write_text(json.dumps(ledger))
        with self.assertRaisesRegex(ValueError, 'verified_prior_form_fonts'): self.repair()
        self.assertFalse(self.output.exists())

    def test_radio_pushbutton_and_inherited_flag_targets_are_not_guessed(self):
        for flag in (2 | 32768, 2 | 65536, None):
            with self.subTest(flag=flag):
                reader = PdfReader(self.input)
                node = reader.pages[0]['/Annots'][2].get_object()
                if flag is None: del node['/Ff']
                else: node[NameObject('/Ff')] = NumberObject(flag)
                with self.assertRaisesRegex(ValueError, 'local_ordinary_materials_checkbox'): r._target(reader)

    def test_optional_checkbox_can_remain_off_or_be_checked_after_filling(self):
        self.repair()
        for state in ('/Off', '/Yes'):
            writer = PdfWriter(clone_from=self.output)
            writer.update_page_form_field_values(None, {'participant': 'Jordan Example',
                'session': 'Afternoon', 'materials': state}, auto_regenerate=False)
            data = io.BytesIO(); writer.write(data); reader = PdfReader(data)
            fields = reader.get_fields()
            self.assertEqual(0, fields['materials']['/Ff'])
            self.assertEqual(state, fields['materials']['/V'])
            self.assertEqual(state, reader.pages[0]['/Annots'][2].get_object()['/AS'])
            self.assertEqual('Send workshop materials', fields['materials']['/TU'])
            self.assertEqual('Jordan Example', fields['participant']['/V'])
            self.assertTrue(reader.root_object.get('/AcroForm'))

    def test_output_overwrite_refused(self):
        self.repair(); before = self.output.read_bytes()
        with self.assertRaisesRegex(ValueError, 'new_output'): self.repair()
        self.assertEqual(before, self.output.read_bytes())

    def test_xfa_signature_and_encryption_are_rejected(self):
        for case in ('xfa', 'signature', 'encrypted'):
            with self.subTest(case=case):
                writer = PdfWriter(clone_from=self.input)
                if case == 'xfa': writer.root_object['/AcroForm'][NameObject('/XFA')] = ArrayObject([])
                elif case == 'signature': writer.pages[0]['/Annots'][0].get_object()[NameObject('/FT')] = NameObject('/Sig')
                else: writer.encrypt('protected')
                path = self.directory / f'{case}.pdf'
                with path.open('wb') as stream: writer.write(stream)
                with self.assertRaises(ValueError): r._open(path)


if __name__ == '__main__': unittest.main()
