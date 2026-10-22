"""Interaction evidence is tied to saved form behavior, not PDF/model labels."""
import importlib.util
import io
from pathlib import Path
import unittest
from unittest.mock import patch

from pypdf import PdfReader, PdfWriter
from pypdf.generic import (ArrayObject as A, BooleanObject as B, DecodedStreamObject,
                          DictionaryObject as D, NameObject as N, NumberObject as I,
                          TextStringObject as T)

import form_interaction_fingerprint as fingerprint
from hybrid_forms import prepare_hybrid

spec = importlib.util.spec_from_file_location("interaction_build_fixture", Path(__file__).with_name("build-smoke.py"))
fixtures = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixtures)


def saved(writer):
    out = io.BytesIO()
    writer.write(out)
    return out.getvalue()


def fixture():
    writer = PdfWriter(clone_from=PdfReader(io.BytesIO(fixtures.synthetic_hybrid_pdf())))
    prepare_hybrid(writer)
    page = writer.pages[0]
    page[N('/Tabs')] = N('/S')
    first = page['/Annots'][0].get_object()
    second = D(dict(first))
    second[N('/T')] = T('other[0]')
    second[N('/TU')] = T('Other workshop field')
    second[N('/StructParent')] = I(2)
    second_ref = writer._add_object(second)
    first['/Parent']['/Kids'].append(second_ref)
    page['/Annots'].append(second_ref)
    template = writer.root_object['/AcroForm']['/XFA'][3].get_object()
    template.set_data(template.get_data().replace(b'</subform>',
        b'<field name="other"><ui><textEdit/></ui><assist><speak disable="0">Other workshop field</speak></assist></field></subform>'))
    root = writer.root_object['/StructTreeRoot']
    document = root['/K']
    tag = D({N('/Type'): N('/StructElem'), N('/S'): N('/Form'), N('/P'): document.indirect_reference,
        N('/Pg'): page.indirect_reference, N('/K'): D({N('/Type'): N('/OBJR'), N('/Obj'): second_ref, N('/Pg'): page.indirect_reference})})
    ref = writer._add_object(tag)
    document['/K'].append(ref)
    root['/ParentTree']['/Nums'].extend([I(2), ref])
    return writer


def read(writer):
    return PdfReader(io.BytesIO(saved(writer)), strict=True)


class FormInteractionFingerprintTests(unittest.TestCase):
    def result(self, writer):
        return fingerprint.form_interaction_fingerprint(read(writer))

    def assert_invalidated(self, mutate):
        writer = fixture()
        original = self.result(writer)
        self.assertIsNotNone(original)
        mutate(writer)
        self.assertNotEqual(original, self.result(writer))

    def test_shape_and_reopened_saved_bytes_only(self):
        writer = fixture()
        result = self.result(writer)
        self.assertEqual(set(result), {'schemaVersion', 'sha256'})
        self.assertEqual(result['schemaVersion'], 1)
        self.assertRegex(result['sha256'], r'^[a-f0-9]{64}$')
        self.assertIsNone(fingerprint.form_interaction_fingerprint(writer))

    def test_unrelated_tags_metadata_and_serialization_are_stable(self):
        writer = fixture()
        original = self.result(writer)
        writer.add_metadata({'/Title': 'A different document title', '/Subject': 'Different subject'})
        root = writer.root_object['/StructTreeRoot']
        document = root['/K']
        document['/K'][0].get_object()[N('/S')] = N('/H2')
        inserted = D({N('/Type'): N('/StructElem'), N('/S'): N('/P'), N('/P'): document.indirect_reference})
        document['/K'].insert(1, writer._add_object(inserted))
        meta = DecodedStreamObject()
        meta.set_data(b'Changed noninteractive XMP')
        writer.root_object[N('/Metadata')] = writer._add_object(meta)
        self.assertEqual(original, self.result(writer))
        before = read(writer)
        renumbered = PdfWriter()
        for index in range(15):
            renumbered._add_object(T('Unused ' + str(index)))
        # clone_document_from_reader clears preexisting objects, so clone the
        # root directly to deliberately place every reference after padding.
        renumbered._root_object = before.root_object.clone(renumbered)
        renumbered._pages = renumbered._root_object.raw_get('/Pages')
        after = read(renumbered)
        self.assertNotEqual(before.pages[0].indirect_reference.idnum, after.pages[0].indirect_reference.idnum)
        self.assertEqual(original, fingerprint.form_interaction_fingerprint(after))

    def test_title_display_change_is_not_interaction_change(self):
        writer = fixture()
        writer.root_object[N('/ViewerPreferences')] = D({N('/DisplayDocTitle'): B(True), N('/HideToolbar'): B(False)})
        before = self.result(writer)
        writer.root_object['/ViewerPreferences'][N('/DisplayDocTitle')] = B(False)
        self.assertEqual(before, self.result(writer))

    def test_native_label_value_and_parent_flags_invalidate(self):
        for key, value in [('/TU', T('Changed field label')), ('/V', T('Entered value')),
                           ('/Ff', I(2)), ('/AS', N('/Selected')), ('/F', I(4))]:
            with self.subTest(key=key):
                self.assert_invalidated(lambda w: w.pages[0]['/Annots'][0].get_object().__setitem__(N(key), value))
        self.assert_invalidated(lambda w: w.pages[0]['/Annots'][0].get_object()['/Parent'].__setitem__(N('/Ff'), I(1)))

    def test_pdf_name_and_string_with_same_spelling_are_not_equivalent(self):
        writer = fixture()
        field = writer.pages[0]['/Annots'][0].get_object()
        field[N('/V')] = N('/Example')
        first = self.result(writer)
        field[N('/V')] = T('/Example')
        self.assertNotEqual(first, self.result(writer))

    def test_every_xfa_packet_and_speech_setting_is_bound(self):
        changes = [(3, b'disable="0"', b'disable="1"'),
                   (3, b'Fictional workshop name', b'Changed workshop name'),
                   (1, b'</acrobat>', b'<validate>preSubmit</validate></acrobat>'),
                   (5, b'<name/>', b'<name>Entered value</name>')]
        for index, old, new in changes:
            with self.subTest(index=index, old=old):
                def change(w):
                    packet = w.root_object['/AcroForm']['/XFA'][index].get_object()
                    self.assertIn(old, packet.get_data())
                    packet.set_data(packet.get_data().replace(old, new))
                self.assert_invalidated(change)

    def test_added_script_is_never_treated_as_same_tested_form(self):
        def script(w):
            packet = w.root_object['/AcroForm']['/XFA'][3].get_object()
            packet.set_data(packet.get_data().replace(b'</field>', b'<event activity="click"><script contentType="application/x-javascript">xfa.host.messageBox("Changed");</script></event></field>', 1))
        self.assert_invalidated(script)

    def test_annotation_field_and_structure_order_invalidate(self):
        self.assert_invalidated(lambda w: w.pages[0]['/Annots'].reverse())
        self.assert_invalidated(lambda w: w.root_object['/AcroForm']['/Fields'][0].get_object()['/Kids'].reverse())
        def change_structure(w):
            kids = w.root_object['/StructTreeRoot']['/K']['/K']
            kids[1], kids[2] = kids[2], kids[1]
        self.assert_invalidated(change_structure)

    def test_link_position_between_widgets_is_bound_to_keyboard_order(self):
        writer = fixture()
        page, root = writer.pages[0], writer.root_object['/StructTreeRoot']
        document = root['/K']
        link = D({N('/Type'): N('/Annot'), N('/Subtype'): N('/Link'),
            N('/P'): page.indirect_reference, N('/StructParent'): I(3),
            N('/Rect'): A([I(0), I(0), I(10), I(10)]),
            N('/A'): D({N('/S'): N('/URI'), N('/URI'): T('https://example.edu/')})})
        link_ref = writer._add_object(link)
        page['/Annots'].append(link_ref)
        tag = D({N('/Type'): N('/StructElem'), N('/S'): N('/Link'), N('/P'): document.indirect_reference,
            N('/Pg'): page.indirect_reference, N('/K'): D({N('/Type'): N('/OBJR'), N('/Obj'): link_ref, N('/Pg'): page.indirect_reference})})
        tag_ref = writer._add_object(tag)
        document['/K'].append(tag_ref)
        root['/ParentTree']['/Nums'].extend([I(3), tag_ref])
        before = self.result(writer)
        self.assertIsNotNone(before)
        document['/K'].remove(tag_ref)
        document['/K'].insert(2, tag_ref)
        self.assertNotEqual(before, self.result(writer))

    def test_untagged_extra_annotation_cannot_claim_complete_keyboard_identity(self):
        writer = fixture()
        link = writer._add_object(D({N('/Type'): N('/Annot'), N('/Subtype'): N('/Link'),
            N('/P'): writer.pages[0].indirect_reference, N('/Rect'): A([I(0)] * 4)}))
        writer.pages[0]['/Annots'].append(link)
        self.assertIsNone(self.result(writer))

    def test_page_tab_mode_geometry_and_acroform_behavior_invalidate(self):
        self.assert_invalidated(lambda w: w.pages[0].__setitem__(N('/Tabs'), N('/R')))
        self.assert_invalidated(lambda w: w.pages[0].__setitem__(N('/Rotate'), I(90)))
        self.assert_invalidated(lambda w: w.root_object['/AcroForm'].__setitem__(N('/NeedAppearances'), B(True)))
        self.assert_invalidated(lambda w: w.root_object['/AcroForm'].__setitem__(N('/SigFlags'), I(0)))
        self.assert_invalidated(lambda w: w.pages[0]['/Annots'][0].get_object().__setitem__(N('/Rect'), A([I(1), I(2), I(3), I(4)])))

    def test_language_and_announcement_overrides_invalidate(self):
        self.assert_invalidated(lambda w: w.root_object.__setitem__(N('/Lang'), T('fr-FR')))
        self.assert_invalidated(lambda w: w.root_object['/StructTreeRoot']['/K'].__setitem__(N('/Lang'), T('fr-FR')))
        self.assert_invalidated(lambda w: w.root_object['/StructTreeRoot']['/K'].__setitem__(N('/ActualText'), T('Different announced context')))
        self.assert_invalidated(lambda w: w.root_object['/StructTreeRoot']['/K'].__setitem__(N('/T'), T('Different container title')))
        self.assert_invalidated(lambda w: w.root_object['/StructTreeRoot']['/K'].__setitem__(N('/UnrecognizedBehavior'), T('Changed')))
        writer = fixture()
        before = self.result(writer)
        writer.root_object['/StructTreeRoot']['/K']['/K'][0].get_object()[N('/Lang')] = T('fr-FR')
        self.assertEqual(before, self.result(writer))

    def test_appearances_resources_and_unknown_behavior_keys_invalidate(self):
        def appearance(w):
            stream = DecodedStreamObject()
            stream.set_data(b'q 1 0 0 rg 0 0 10 10 re f Q')
            w.pages[0]['/Annots'][0].get_object()[N('/AP')] = D({N('/N'): w._add_object(stream)})
        self.assert_invalidated(appearance)
        self.assert_invalidated(lambda w: w.pages[0]['/Resources']['/Font']['/F1'].__setitem__(N('/BaseFont'), N('/Courier')))
        self.assert_invalidated(lambda w: w.root_object.__setitem__(N('/UnrecognizedBehavior'), T('Changed')))
        self.assert_invalidated(lambda w: w.pages[0].__setitem__(N('/UnrecognizedBehavior'), T('Changed')))
        self.assert_invalidated(lambda w: w.root_object['/AcroForm'].__setitem__(N('/UnrecognizedBehavior'), T('Changed')))

    def test_missing_ambiguous_structure_and_unsupported_forms_are_omitted(self):
        mutations = [lambda w: w.root_object.__delitem__(N('/StructTreeRoot')),
            lambda w: w.root_object['/AcroForm'].__delitem__(N('/XFA')),
            lambda w: w.pages[0]['/Annots'][0].get_object().__setitem__(N('/StructParent'), I(999)),
            lambda w: w.root_object['/StructTreeRoot']['/K']['/K'].append(w.root_object['/StructTreeRoot']['/K']['/K'][1])]
        for mutate in mutations:
            writer = fixture()
            mutate(writer)
            self.assertIsNone(self.result(writer))

    def test_inspection_budget_failure_omits_evidence(self):
        writer = fixture()
        with patch.object(fingerprint, 'MAX_STRUCTURE_ITEMS', 1):
            self.assertIsNone(self.result(writer))
        with patch.object(fingerprint.v, 'MAX_NODES', 1):
            self.assertIsNone(self.result(writer))

    def test_embedded_claim_cannot_supply_digest(self):
        writer = fixture()
        original = self.result(writer)
        writer.add_metadata({'/interactionFingerprint': '0' * 64})
        self.assertEqual(original, self.result(writer))
        del writer.root_object['/AcroForm'][N('/XFA')]
        self.assertIsNone(self.result(writer))


if __name__ == '__main__':
    unittest.main()
