import hashlib
import io
import json
from pathlib import Path
import tempfile
import unittest

from pypdf import PdfReader, PdfWriter
from pypdf.generic import (ArrayObject, ByteStringObject, ContentStream,
    DecodedStreamObject, DictionaryObject, NameObject, NumberObject)

import form_font_repairs as f
from form_order_repairs import repair_form_reading_order
from test_form_order_repairs import ordered_fixture
from test_form_label_repairs import mutate
from verify_pdf import resolved


class FormFontRepairTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        workspace = Path(__file__).resolve().parents[4]
        config = workspace / 'work/pdf-native-tools/toolchain.json'
        if not config.is_file(): raise unittest.SkipTest('Local pinned font toolchain unavailable')
        cls.font = Path(json.loads(config.read_text())['fontDirectory']) / 'LiberationSans-Regular.ttf'
        cls.face, cls.program = f._program(cls.font)

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        self.original, labeled, labels, audit, pairs = ordered_fixture(self.directory)
        audit_data = json.loads(audit.read_text()); audit_data.update(machineFindingsRetained=True, plannedBatchCount=1, completedBatchCount=1)
        audit.write_text(json.dumps(audit_data))
        self.input = self.directory / 'ordered.pdf'
        ledger = repair_form_reading_order(self.original, labeled, self.input,
            audit_report=audit, label_ledger=labels, pairs=pairs,
            expected_original_sha256=f.sha(self.original), expected_candidate_sha256=f.sha(labeled))
        self.order = self.directory / 'order.json'; self.order.write_text(json.dumps(ledger))
        self.output = self.directory / 'embedded.pdf'

    def repair(self, **kwargs):
        return f.repair_form_fonts(self.original, self.input, self.output,
            font_path=kwargs.pop('font_path', self.font), order_ledger=self.order,
            expected_original_sha256=kwargs.pop('expected_original_sha256', f.sha(self.original)),
            expected_candidate_sha256=f.sha(self.input), allow_font_substitution=kwargs.pop('allow', True), **kwargs)

    def test_saved_full_program_mapping_fields_and_appearances_are_preserved(self):
        original, prior = self.original.read_bytes(), self.input.read_bytes()
        ledger = self.repair(); before, after = PdfReader(self.input), PdfReader(self.output)
        self.assertEqual(3, len(ledger['substitutions']))
        for entry in ledger['substitutions']:
            font = f.font_at(after, entry['resourcePath'])
            program = font['/FontDescriptor']['/FontFile2'].get_data()
            self.assertEqual(f.FONT_FILE_SHA256, hashlib.sha256(program).hexdigest())
            self.assertEqual('/TrueType', font['/Subtype'])
            self.assertEqual(229, len(entry['encoding']))
            self.assertEqual({0xAF, 0xB1, 0xB5, 0xB7, 0xF7}, {e['unicode'] for e in entry['widthChanges']})
            self.assertTrue(set(entry['currentUsedCodes']).isdisjoint({e['code'] for e in entry['widthChanges']}))
            differences = font['/Encoding']['/Differences']
            for e in entry['encoding']:
                self.assertEqual('/' + e['glyphName'], differences[e['code'] + 1])
                self.assertEqual(e['targetWidth'], font['/Widths'][e['code']])
                self.assertIn(f"<{e['code']:02X}> <{e['unicode']:04X}>".encode(), font['/ToUnicode'].get_data())
            for code in entry['undefinedCodes']:
                self.assertEqual('/.notdef', differences[code + 1]); self.assertEqual(0, font['/Widths'][code])
        for old, new in zip(before.pages[0]['/Annots'], after.pages[0]['/Annots']):
            old, new = resolved(old), resolved(new)
            for key in ('/T', '/FT', '/TU', '/Ff', '/V', '/DV', '/Opt', '/DA', '/Rect', '/AS'):
                self.assertEqual(old.get(key), new.get(key))
            if hasattr(old['/AP']['/N'], 'get_data'):
                self.assertEqual(old['/AP']['/N'].get_data(), new['/AP']['/N'].get_data())
        self.assertEqual(original, self.original.read_bytes()); self.assertEqual(prior, self.input.read_bytes())

    def test_custom_encoding_defaults_to_standard_not_winansi(self):
        font = DictionaryObject({NameObject('/Type'): NameObject('/Font'), NameObject('/Subtype'): NameObject('/Type1'),
            NameObject('/BaseFont'): NameObject('/Helvetica'), NameObject('/Encoding'): DictionaryObject({
                NameObject('/Differences'): ArrayObject([NumberObject(128), NameObject('/Euro')])})})
        entries, _ = f.encoding_map(font); by_code = {e['code']: e for e in entries}
        self.assertEqual(0x2019, by_code[39]['unicode'])
        self.assertEqual(0x20AC, by_code[128]['unicode'])

    def test_shared_default_font_does_not_hide_changed_current_advance(self):
        def change(writer):
            ap = writer.pages[0]['/Annots'][0].get_object()['/AP']['/N']
            stream = ContentStream(ap, writer, 'bytes')
            stream.operations = [([ByteStringObject(b'\xaf')] if op == b'Tj' else args, op) for args, op in stream.operations]
            ap.set_data(stream.get_data())
        mutate(self.input, change)
        records = f.font_inventory(PdfReader(self.input))
        self.assertEqual([], records[0]['currentUsedCodes'])
        with self.assertRaisesRegex(ValueError, 'changed_advance_in_current'): f.planned_inventory(PdfReader(self.input), self.face)

    def test_future_fill_keeps_editable_fields_and_embedded_default_font(self):
        self.repair(); writer = PdfWriter(clone_from=self.output)
        value = 'Rene\u00e9 \u00af\u00b1\u00b5\u00b7\u00f7'
        writer.update_page_form_field_values(writer.pages[0], {'participant': value, 'session': 'Afternoon', 'materials': '/Yes'}, auto_regenerate=False)
        output = io.BytesIO(); writer.write(output); saved = PdfReader(output)
        fields = saved.get_fields()
        self.assertEqual(value, fields['participant']['/V']); self.assertEqual('Afternoon', fields['session']['/V'])
        self.assertEqual('/Yes', fields['materials']['/V'])
        self.assertEqual(2, fields['materials']['/Ff'])
        ap = saved.pages[0]['/Annots'][0].get_object()['/AP']['/N']
        self.assertTrue(ap.get_data())
        font = ap['/Resources']['/Font']['/Helv']
        self.assertEqual(f.FONT_FILE_SHA256, hashlib.sha256(font['/FontDescriptor']['/FontFile2'].get_data()).hexdigest())

    def test_page_form_aliases_rejected(self):
        def alias(writer):
            ap = writer.pages[0]['/Annots'][0].get_object()['/AP']['/N']
            writer.pages[0]['/Resources'][NameObject('/XObject')] = DictionaryObject({NameObject('/Shared'): ap.indirect_reference})
        mutate(self.input, alias)
        with self.assertRaisesRegex(ValueError, 'page_form_resource_aliases'): f.font_inventory(PdfReader(self.input))

    def test_undefined_current_code_rejected(self):
        def change(writer):
            ap = writer.pages[0]['/Annots'][0].get_object()['/AP']['/N']
            stream = ContentStream(ap, writer, 'bytes')
            stream.operations = [([ByteStringObject(b'\x00')] if op == b'Tj' else args, op) for args, op in stream.operations]
            ap.set_data(stream.get_data())
        mutate(self.input, change)
        with self.assertRaisesRegex(ValueError, 'undefined_appearance'): f.font_inventory(PdfReader(self.input))

    def test_missing_authorization_wrong_hash_or_unpinned_font_rejected(self):
        with self.assertRaisesRegex(ValueError, 'explicit_font'): self.repair(allow=False)
        with self.assertRaisesRegex(ValueError, 'exact_input_hash'): self.repair(expected_original_sha256='0' * 64)
        fake = self.directory / 'fake.ttf'; fake.write_bytes(self.program + b'x')
        with self.assertRaisesRegex(ValueError, 'pinned_official'): self.repair(font_path=fake)
        self.assertFalse(self.output.exists())

    def test_overwrite_and_stale_prior_chain_rejected(self):
        self.repair()
        with self.assertRaisesRegex(ValueError, 'new_output'): self.repair()
        self.output = self.directory / 'other.pdf'
        ledger = json.loads(self.order.read_text()); ledger['outputSha256'] = '0' * 64
        self.order.write_text(json.dumps(ledger))
        with self.assertRaisesRegex(ValueError, 'verified_prior_form'): self.repair()

    def test_xfa_and_signed_fields_rejected_before_mutation(self):
        def xfa(writer):
            writer.root_object['/AcroForm'][NameObject('/XFA')] = ArrayObject([])
        mutate(self.input, xfa)
        with self.assertRaises(ValueError): self.repair()
        self.assertFalse(self.output.exists())
        def signature(writer):
            del writer.root_object['/AcroForm']['/XFA']
            writer.pages[0]['/Annots'][0].get_object()[NameObject('/FT')] = NameObject('/Sig')
        mutate(self.input, signature)
        with self.assertRaises(ValueError): self.repair()
        self.assertFalse(self.output.exists())

    def test_encrypted_input_rejected(self):
        writer = PdfWriter(clone_from=self.input); writer.encrypt('protected')
        with self.input.open('wb') as stream: writer.write(stream)
        with self.assertRaises(ValueError): self.repair()
        self.assertFalse(self.output.exists())

    def test_unembedded_descriptor_not_silently_skipped(self):
        def descriptor(writer):
            f.font_at(writer, 'AcroForm/DR/Font/Helv')[NameObject('/FontDescriptor')] = DictionaryObject({
                NameObject('/Type'): NameObject('/FontDescriptor'), NameObject('/FontName'): NameObject('/Helvetica')})
        mutate(self.input, descriptor)
        with self.assertRaisesRegex(ValueError, 'unembedded_nonstandard'): f.font_inventory(PdfReader(self.input))


if __name__ == '__main__': unittest.main()
