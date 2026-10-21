"""Reject forged form-font evidence after the attacker updates file hashes.

All PDFs are synthetic temporary fixtures. Font/encoding dictionary hashes are
also rebound so these cases exercise independent checks, not stale evidence.
"""
import copy
import json
import unittest
from unittest.mock import patch

from pypdf import PdfReader, PdfWriter
from pypdf.generic import (DecodedStreamObject, DictionaryObject, NameObject,
                           NumberObject, TextStringObject)

import form_font_repairs as writer_module
import form_font_validation as validator
import test_form_font_repairs as writer_tests
import test_form_order_repairs as order_tests
from conformance_repairs import stage_pdfua1_declaration
from form_label_validation import ExactGraph
from verify_pdf import Canonicalizer, InspectionError


XMP = (b'<x:xmpmeta xmlns:x="adobe:ns:meta/">'
       b'<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">'
       b'<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/">'
       b'<dc:title><rdf:Alt><rdf:li xml:lang="x-default">'
       b'Fictional registration</rdf:li></rdf:Alt></dc:title>'
       b'</rdf:Description></rdf:RDF></x:xmpmeta>')


class FormFontTamperingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        writer_tests.FormFontRepairTests.setUpClass()

    def setUp(self):
        # Put XMP in the source before building its verified repair chain, so
        # staged-evaluation tests have genuine metadata to preserve.
        original_fixture = order_tests.fixture

        def with_metadata(path):
            original_fixture(path)
            pdf = PdfWriter(clone_from=path)
            metadata = DecodedStreamObject()
            metadata.set_data(XMP)
            metadata[NameObject('/Type')] = NameObject('/Metadata')
            metadata[NameObject('/Subtype')] = NameObject('/XML')
            pdf.root_object[NameObject('/Metadata')] = pdf._add_object(metadata)
            with path.open('wb') as stream:
                pdf.write(stream)

        self.fixture = writer_tests.FormFontRepairTests()
        with patch.object(order_tests, 'fixture', with_metadata):
            self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.ledger = self.fixture.repair()
        self.output = self.fixture.output

    def changed_copy(self, callback, *, refresh_font_hashes=True):
        target = self.fixture.directory / 'tampered.pdf'
        pdf = PdfWriter(clone_from=self.output)
        callback(pdf)
        with target.open('xb') as stream:
            pdf.write(stream)
        ledger = copy.deepcopy(self.ledger)
        ledger['outputSha256'] = writer_module.sha(target)
        if refresh_font_hashes:
            saved = PdfReader(target, strict=True)
            for row in ledger['substitutions']:
                font = writer_module.font_at(saved, row['resourcePath'])
                row['targetFontSha256'] = ExactGraph([]).hash(font)
                row['targetEncodingSha256'] = Canonicalizer().hash(font.get('/Encoding'))
        return target, ledger

    def assert_rejected(self, target, ledger, reason):
        with self.assertRaisesRegex(InspectionError, reason):
            validator.authorize_form_fonts(self.fixture.original, target, ledger)

    @staticmethod
    def font(pdf):
        return writer_module.font_at(pdf, 'AcroForm/DR/Font/Helv')

    def test_embedded_program_changes_rejected_after_rehashing_dictionary(self):
        def alter(pdf):
            program = self.font(pdf)['/FontDescriptor']['/FontFile2']
            program.set_data(program.get_data() + b'\0')
            program[NameObject('/Length1')] = NumberObject(len(program.get_data()))
        target, ledger = self.changed_copy(alter)
        self.assert_rejected(target, ledger, 'form_font_embedded_program')

    def test_wrong_fontfile_length_rejected_with_unchanged_program(self):
        def alter(pdf):
            program = self.font(pdf)['/FontDescriptor']['/FontFile2']
            program[NameObject('/Length1')] = NumberObject(len(program.get_data()) - 1)
        target, ledger = self.changed_copy(alter)
        self.assert_rejected(target, ledger, 'form_font_.*(length|program|stream)')

    def test_declared_width_cannot_disagree_with_embedded_font(self):
        def alter(pdf):
            widths = self.font(pdf)['/Widths']
            widths[65] = NumberObject(int(widths[65]) + 1)
        target, ledger = self.changed_copy(alter)
        self.assert_rejected(target, ledger, 'form_font_declared_width_not_program_width')

    def test_tounicode_replacement_cannot_relabel_a_glyph(self):
        def alter(pdf):
            cmap = self.font(pdf)['/ToUnicode']
            before = cmap.get_data()
            self.assertIn(b'<41> <0041>', before)
            cmap.set_data(before.replace(b'<41> <0041>', b'<41> <0042>'))
        target, ledger = self.changed_copy(alter)
        self.assert_rejected(target, ledger, 'form_font_unicode_mapping_changed')

    def test_tounicode_dictionary_usecmap_cannot_add_hidden_fallback(self):
        def alter(pdf):
            self.font(pdf)['/ToUnicode'][NameObject('/UseCMap')] = NameObject('/Identity-H')
        target, ledger = self.changed_copy(alter)
        self.assert_rejected(target, ledger, 'form_font_unicode_.*(stream|dictionary|fallback|unsupported)')

    def test_changed_encoding_glyph_name_rejected_with_rehashed_encoding(self):
        def alter(pdf):
            self.font(pdf)['/Encoding']['/Differences'][66] = NameObject('/B')
        target, ledger = self.changed_copy(alter)
        self.assert_rejected(target, ledger, 'form_font_target_encoding_not_source_equivalent')

    def test_original_undefined_code_cannot_be_silently_enabled(self):
        def alter(pdf):
            self.font(pdf)['/Encoding']['/Differences'][1] = NameObject('/A')
        target, ledger = self.changed_copy(alter)
        self.assert_rejected(target, ledger, 'form_font_target_encoding_not_source_equivalent')

    def test_undeclared_appearance_paint_is_rejected(self):
        def alter(pdf):
            appearance = pdf.pages[0]['/Annots'][0].get_object()['/AP']['/N']
            appearance.set_data(appearance.get_data() + b'\nq 1 0 0 rg 0 0 4 4 re f Q\n')
        target, ledger = self.changed_copy(alter)
        self.assert_rejected(target, ledger, 'pixels_changed_outside_authorized_glyphs|form_font_unlisted_native_change')

    def test_undeclared_page_paint_is_rejected(self):
        def alter(pdf):
            page = pdf.pages[0]
            stream = DecodedStreamObject()
            stream.set_data(page.get_contents().get_data() + b'\nq 1 0 0 rg 0 0 4 4 re f Q\n')
            page[NameObject('/Contents')] = pdf._add_object(stream)
        target, ledger = self.changed_copy(alter)
        self.assert_rejected(target, ledger, 'form_font_(pixels_changed_outside_glyphs|unlisted_native_change)')

    def test_saved_value_cannot_change_without_its_appearance(self):
        def alter(pdf):
            pdf.pages[0]['/Annots'][0].get_object()[NameObject('/V')] = TextStringObject('Other person')
        target, ledger = self.changed_copy(alter)
        self.assert_rejected(target, ledger, 'form_font_unlisted_native_change|form_font_future_field_semantics_changed')

    def test_required_flag_cannot_be_removed_by_font_permission(self):
        def alter(pdf):
            field = pdf.pages[0]['/Annots'][2].get_object()
            field[NameObject('/Ff')] = NumberObject(int(field.get('/Ff', 0)) ^ 2)
        target, ledger = self.changed_copy(alter)
        self.assert_rejected(target, ledger, 'form_font_(unlisted_native_change|future_field_semantics_changed)')

    def test_new_widget_action_cannot_hide_in_font_repair(self):
        def alter(pdf):
            field = pdf.pages[0]['/Annots'][0].get_object()
            field[NameObject('/A')] = DictionaryObject({NameObject('/S'): NameObject('/URI'),
                NameObject('/URI'): TextStringObject('https://example.invalid/unapproved')})
        target, ledger = self.changed_copy(alter)
        self.assert_rejected(target, ledger, 'form_font_unlisted_native_change')

    def staged(self, callback):
        # A valid staged declaration is built first. The test only changes the
        # final saved candidate and its hash, leaving its verified raw chain.
        path = self.fixture.directory / 'staged.pdf'
        raw_ledger_path = self.fixture.directory / 'raw-font-ledger.json'
        raw_ledger_path.write_text(json.dumps(self.ledger), encoding='utf-8')
        stage_pdfua1_declaration(self.output, path,
            expected_sha256=writer_module.sha(self.output), evaluation_only=True)
        pdf = PdfWriter(clone_from=path)
        callback(pdf)
        tampered = self.fixture.directory / 'staged-tampered.pdf'
        with tampered.open('xb') as stream:
            pdf.write(stream)
        ledger = dict(self.ledger, outputSha256=writer_module.sha(tampered), evaluationStage={
            'rawCandidatePath': str(self.output.resolve()),
            'rawCandidateSha256': writer_module.sha(self.output),
            'rawLedgerPath': str(raw_ledger_path.resolve()),
            'rawLedgerSha256': writer_module.sha(raw_ledger_path), 'evaluationOnly': True})
        return tampered, ledger

    def test_evaluation_declaration_does_not_authorize_xmp_title_change(self):
        def alter(pdf):
            metadata = pdf.root_object['/Metadata']
            data = metadata.get_data()
            self.assertIn(b'Fictional registration', data)
            metadata.set_data(data.replace(b'Fictional registration', b'Unapproved title'))
        target, ledger = self.staged(alter)
        self.assert_rejected(target, ledger, 'form_font_evaluation_metadata_not_exact_addition')

    def test_evaluation_declaration_does_not_authorize_document_language(self):
        target, ledger = self.staged(lambda pdf:
            pdf.root_object.__setitem__(NameObject('/Lang'), TextStringObject('fr-FR')))
        self.assert_rejected(target, ledger, 'form_font_evaluation_unlisted_native_change')

    def test_evaluation_declaration_must_identify_the_exact_ua1_profile(self):
        def alter(pdf):
            metadata = pdf.root_object['/Metadata']
            metadata.set_data(metadata.get_data().replace(b'<pdfuaid:part>1</pdfuaid:part>',
                                                         b'<pdfuaid:part>2</pdfuaid:part>'))
        target, ledger = self.staged(alter)
        self.assert_rejected(target, ledger, 'form_font_evaluation_metadata_not_exact_addition')


if __name__ == '__main__':
    unittest.main()
