"""Independent saved-file mutations of the Unicode editable-form font change."""
import copy
import json
import logging
import unittest

from pypdf import PdfReader, PdfWriter
from pypdf.generic import NameObject, NumberObject, TextStringObject

import form_default_font_validation as f
import form_default_font_repairs as writer_module
import test_form_requirement_validation as fixture_module
import verify_pdf as v


class FormDefaultFontValidationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls): fixture_module.FormRequirementValidationTests.setUpClass()

    def setUp(self):
        self.fixture = fixture_module.FormRequirementValidationTests(); self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.source = self.fixture.fixture.original; self.input = self.fixture.output
        self.requirement = self.fixture.fixture.directory / 'requirement.json'
        self.requirement.write_text(json.dumps(self.fixture.ledger), encoding='utf-8')
        self.output = self.fixture.fixture.directory / 'compatible.pdf'
        self.ledger = writer_module.repair_unicode_form_defaults(self.source, self.input, self.output,
            requirement_ledger=self.requirement, expected_original_sha256=v.digest(self.source.read_bytes()),
            expected_candidate_sha256=v.digest(self.input.read_bytes()))
        logging.getLogger('pypdf').setLevel(logging.ERROR)

    def check(self): return f.authorize_form_default_font(self.source, self.output, self.ledger)[0]

    def mutate(self, callback):
        writer = PdfWriter(clone_from=self.output); callback(writer)
        with self.output.open('wb') as handle: writer.write(handle)
        self.ledger['outputSha256'] = v.digest(self.output.read_bytes())

    @staticmethod
    def font(writer): return writer.root_object['/AcroForm']['/DR']['/Font']['/UniForm']

    def test_full_repertoire_exact_graph_pixels_and_immutable_inputs(self):
        paths = (self.source, self.input, self.output, self.requirement)
        hashes = [v.digest(path.read_bytes()) for path in paths]
        report = f.compare_with_authorized_form_default_font(self.source, self.output, self.ledger)
        proof = report['form_default_font_validation']
        self.assertTrue(report['passed'], proof)
        self.assertEqual(proof['fontMapping']['sourceCharactersCovered'], 229)
        self.assertTrue(proof['originalAppearanceStreamsAndAllOtherObjectsUnchanged'])
        self.assertTrue(proof['initializedStaticPixelsIdentical'])
        self.assertFalse(proof['interactiveViewerBehaviorVerifiedByThisCheck'])
        self.assertTrue(proof['interactiveViewerReviewRequired'])
        self.assertFalse(proof['widgetEvidence'][2]['required'])
        self.assertEqual(hashes, [v.digest(path.read_bytes()) for path in paths])

    def test_wrong_glyph_mapping_mode_rejected_even_with_rebound_output_hash(self):
        def change(writer):
            self.font(writer)['/DescendantFonts'][0].get_object()[NameObject('/CIDToGIDMap')] = NameObject('/OtherMap')
        self.mutate(change)
        with self.assertRaisesRegex(v.InspectionError, 'identity_gid_map_required'): self.check()

    def test_undeclared_future_unicode_mapping_is_rejected(self):
        def change(writer):
            stream = self.font(writer)['/ToUnicode']
            stream.set_data(stream.get_data().replace(b'endcmap', b'1 beginbfchar\n<1000> <0400>\nendbfchar\nendcmap'))
        self.mutate(change)
        with self.assertRaisesRegex(v.InspectionError, 'unicode_mapping_changed'): self.check()

    def test_real_program_widths_cannot_be_replaced_by_claimed_source_width(self):
        def change(writer):
            widths = self.font(writer)['/DescendantFonts'][0].get_object()['/W']
            for i in range(0, len(widths), 2):
                if widths[i+1][0] == 552: widths[i+1][0] = NumberObject(333)
        self.mutate(change)
        with self.assertRaisesRegex(v.InspectionError, 'width_mapping_changed'): self.check()

    def test_tounicode_change_or_fallback_is_rejected(self):
        original = self.output.read_bytes()
        for fallback in (False, True):
            with self.subTest(fallback=fallback):
                self.output.write_bytes(original)
                def change(writer):
                    stream = self.font(writer)['/ToUnicode']
                    if fallback: stream[NameObject('/UseCMap')] = NameObject('/Identity-H')
                    else: stream.set_data(stream.get_data().replace(b'<0030> <004D>', b'<0030> <0141>'))
                self.mutate(change)
                with self.assertRaisesRegex(v.InspectionError, 'unicode_'): self.check()

    def test_changed_program_or_descriptor_cannot_hide_in_the_new_resource(self):
        def change(writer):
            desc = self.font(writer)['/DescendantFonts'][0].get_object()['/FontDescriptor']
            desc[NameObject('/Ascent')] = NumberObject(999)
        self.mutate(change)
        with self.assertRaisesRegex(v.InspectionError, 'descriptor_or_program_changed'): self.check()

    def test_default_font_is_only_selected_change_not_size_color_or_field_value(self):
        original = self.output.read_bytes(); original_ledger = copy.deepcopy(self.ledger)
        for key, value in [('/DA', '/UniForm 24 Tf .1 .1 .1 rg'), ('/V', 'Different name')]:
            with self.subTest(key=key):
                self.output.write_bytes(original); self.ledger = copy.deepcopy(original_ledger)
                self.mutate(lambda w: w.pages[0]['/Annots'][0].get_object().__setitem__(NameObject(key), TextStringObject(value)))
                with self.assertRaisesRegex(v.InspectionError, 'da_unlisted_change|unlisted_native_change'): self.check()

    def test_original_appearance_bytes_and_checkbox_flags_cannot_change(self):
        original = self.output.read_bytes()
        for appearance in (False, True):
            with self.subTest(appearance=appearance):
                self.output.write_bytes(original)
                def change(writer):
                    if appearance:
                        stream = writer.pages[0]['/Annots'][0].get_object()['/AP']['/N']
                        stream.set_data(stream.get_data().replace(b'12 Tf', b'13 Tf'))
                    else: writer.pages[0]['/Annots'][2].get_object()[NameObject('/Ff')] = NumberObject(2)
                self.mutate(change)
                with self.assertRaisesRegex(v.InspectionError, 'unlisted_native_change'): self.check()

    def test_schema_and_complete_default_appearance_evidence_are_strict(self):
        original = copy.deepcopy(self.ledger)
        for mutation in [lambda x: x.update(ignoreErrors=True), lambda x: x.update(schemaVersion=True),
                         lambda x: x['defaultAppearances'].pop(), lambda x: x.update(fontResourceName='Helv')]:
            self.ledger = copy.deepcopy(original); mutation(self.ledger)
            with self.assertRaises(v.InspectionError): self.check()

    def test_stale_prior_chain_and_candidate_hash_fail(self):
        self.ledger['requirementLedgerSha256'] = '0'*64
        with self.assertRaisesRegex(v.InspectionError, 'evidence_hash_mismatch'): self.check()
        self.ledger['requirementLedgerSha256'] = v.digest(self.requirement.read_bytes())
        self.ledger['outputSha256'] = '0'*64
        with self.assertRaisesRegex(v.InspectionError, 'file_binding_mismatch'): self.check()


if __name__ == '__main__': unittest.main()
