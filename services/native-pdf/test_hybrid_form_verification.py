"""Mutation tests for the independent hybrid-form preservation gate."""
import io
import unittest
from unittest.mock import patch

from pypdf import PdfReader, PdfWriter
from pypdf.generic import (ArrayObject, BooleanObject, ByteStringObject, DecodedStreamObject, DictionaryObject,
                          NameObject, NumberObject, TextStringObject)

import hybrid_form_verification as h


def saved(writer):
    output = io.BytesIO()
    writer.write(output)
    return output.getvalue()


def fixture(existing_tooltip=None, rights=True):
    writer = PdfWriter()
    page = writer.add_blank_page(240, 180)
    font = writer._add_object(DictionaryObject({NameObject("/Type"): NameObject("/Font"),
        NameObject("/Subtype"): NameObject("/Type1"), NameObject("/BaseFont"): NameObject("/Helvetica")}))
    group = DictionaryObject({NameObject("/T"): TextStringObject("form[0]")})
    group_ref = writer._add_object(group)
    fields = []
    for index in range(2):
        field = DictionaryObject({NameObject("/Type"): NameObject("/Annot"),
            NameObject("/Subtype"): NameObject("/Widget"), NameObject("/FT"): NameObject("/Tx"),
            NameObject("/T"): TextStringObject(f"name[{index}]"), NameObject("/Parent"): group_ref,
            NameObject("/Rect"): ArrayObject([NumberObject(n) for n in (20, 110-index*30, 210, 130-index*30)]),
            NameObject("/F"): NumberObject(4), NameObject("/DA"): TextStringObject("/Helv 10 Tf 0 g"),
            NameObject("/V"): TextStringObject(""), NameObject("/P"): page.indirect_reference})
        if existing_tooltip is not None and index == 0:
            field[NameObject("/TU")] = TextStringObject(existing_tooltip)
        fields.append(writer._add_object(field))
    group[NameObject("/Kids")] = ArrayObject(fields)
    page[NameObject("/Annots")] = ArrayObject(fields)
    template = DecodedStreamObject()
    template.set_data(b'<template xmlns="http://www.xfa.org/schema/xfa-template/3.3/">'
        b'<subform name="form" layout="tb">'
        b'<field name="name"><ui><textEdit/></ui><assist><speak disable="1"> Enter your name. </speak></assist></field>'
        b'<field name="name"><ui><textEdit/></ui><assist><speak disable="1">Second name</speak></assist></field>'
        b'</subform></template>')
    datasets = DecodedStreamObject()
    datasets.set_data(b'<datasets><data><name></name></data></datasets>')
    form = DictionaryObject({NameObject("/Fields"): ArrayObject([group_ref]),
        NameObject("/SigFlags"): NumberObject(2), NameObject("/DA"): TextStringObject("/Helv 10 Tf 0 g"),
        NameObject("/DR"): DictionaryObject({NameObject("/Font"): DictionaryObject({NameObject("/Helv"): font})}),
        NameObject("/XFA"): ArrayObject([TextStringObject("template"),writer._add_object(template),
                                      TextStringObject("datasets"),writer._add_object(datasets)])})
    writer.root_object[NameObject("/AcroForm")] = writer._add_object(form)
    if rights:
        signature = DictionaryObject({NameObject("/Type"): NameObject("/Sig"),
            NameObject("/Filter"): NameObject("/Adobe.PPKLite"),
            NameObject("/SubFilter"): NameObject("/adbe.pkcs7.detached"),
            NameObject("/Contents"): ByteStringObject(b"\x16reader-usage-rights"),
            NameObject("/ByteRange"): ArrayObject([NumberObject(x) for x in (0, 10, 30, 10)]),
            NameObject("/Reference"): ArrayObject([DictionaryObject({NameObject("/Type"): NameObject("/SigRef"),
                NameObject("/TransformMethod"): NameObject("/UR3"),NameObject("/Data"): writer.root_object.indirect_reference,
                NameObject("/TransformParams"): DictionaryObject({NameObject("/Type"):NameObject("/TransformParams"),
                    NameObject("/V"):NameObject("/2.2"),NameObject("/P"):BooleanObject(False)})})])})
        writer.root_object[NameObject("/Perms")] = DictionaryObject({NameObject("/UR3"): writer._add_object(signature)})
    return saved(writer)


def prepared(source, mutate=None):
    writer = PdfWriter(clone_from=PdfReader(io.BytesIO(source), strict=True))
    writer.root_object.pop(NameObject("/Perms"),None)
    fields = writer.root_object["/AcroForm"]["/Fields"][0].get_object()["/Kids"]
    for field, label in zip(fields, (" Enter your name. ","Second name")):
        field = field.get_object()
        if "/TU" not in field:
            field[NameObject("/TU")] = TextStringObject(label)
    if mutate:
        mutate(writer)
    return saved(writer)


def first_field(writer):
    return writer.root_object["/AcroForm"]["/Fields"][0].get_object()["/Kids"][0].get_object()


class HybridFormVerificationTests(unittest.TestCase):
    def assert_refused(self, source, mutate, code=None):
        with self.assertRaises(h.HybridVerificationError) as result:
            h.verify_hybrid_preparation(source, prepared(source,mutate))
        if code:
            self.assertEqual(str(result.exception),code)

    def test_only_verified_labels_and_rights_removal_pass(self):
        source=fixture(); result=h.verify_hybrid_preparation(source,prepared(source))
        self.assertTrue(result["passed"])
        self.assertEqual(result["fieldCount"],2)
        self.assertEqual(result["addedTooltipFields"],["form[0].name[0]","form[0].name[1]"])
        self.assertTrue(result["originalPagesAndWidgetsRenderIdentically"])

    def test_existing_blank_tooltip_is_preserved(self):
        source=fixture(existing_tooltip="")
        result=h.verify_hybrid_preparation(source,prepared(source))
        self.assertEqual(result["addedTooltipFields"],["form[0].name[1]"])
        self.assert_refused(source,lambda w:first_field(w).__setitem__(NameObject("/TU"),TextStringObject("Replacement")))

    def test_no_reader_rights_is_supported(self):
        source=fixture(rights=False)
        self.assertFalse(h.verify_hybrid_preparation(source,prepared(source))["removedReaderUsageRights"])

    def test_label_whitespace_cannot_change(self):
        self.assert_refused(fixture(),lambda w:first_field(w).__setitem__(NameObject("/TU"),TextStringObject("Enter your name.")),
                            "hybrid_verification_authored_label")

    def test_label_cannot_be_copied_to_wrong_field(self):
        self.assert_refused(fixture(),lambda w:first_field(w).__setitem__(NameObject("/TU"),TextStringObject("Second name")),
                            "hybrid_verification_authored_label")

    def test_xfa_packet_changes_are_refused(self):
        def mutate(w):
            xfa=w.root_object["/AcroForm"]["/XFA"]
            xfa[3].get_object().set_data(b'<datasets><data><name>Changed</name></data></datasets>')
        self.assert_refused(fixture(),mutate,"hybrid_verification_unexpected_change")

    def test_enabling_disabled_speech_is_not_an_allowed_delta(self):
        def mutate(w):
            stream=w.root_object["/AcroForm"]["/XFA"][1].get_object()
            stream.set_data(stream.get_data().replace(b'disable="1"',b'disable="0"'))
        self.assert_refused(fixture(),mutate,"hybrid_verification_unexpected_change")

    def test_field_values_flags_geometry_and_appearances_are_protected(self):
        for key,value in [("/V",TextStringObject("Injected")),("/Ff",NumberObject(1)),
                          ("/Rect",ArrayObject([NumberObject(x) for x in (0,0,50,50)])),
                          ("/AP",DictionaryObject())]:
            with self.subTest(key=key):
                self.assert_refused(fixture(),lambda w:first_field(w).__setitem__(NameObject(key),value),
                                    "hybrid_verification_unexpected_change")

    def test_sigflags_cannot_be_removed(self):
        self.assert_refused(fixture(),lambda w:w.root_object["/AcroForm"].pop(NameObject("/SigFlags")),
                            "hybrid_verification_unexpected_change")

    def test_page_widget_order_cannot_change(self):
        self.assert_refused(fixture(),lambda w:w.pages[0]["/Annots"].reverse(),"hybrid_verification_widget_mapping")

    def test_canonical_field_child_order_cannot_change(self):
        self.assert_refused(fixture(),lambda w:w.root_object["/AcroForm"]["/Fields"][0].get_object()["/Kids"].reverse(),
                            "hybrid_verification_unexpected_change")

    def test_new_action_cannot_be_added(self):
        self.assert_refused(fixture(),lambda w:first_field(w).__setitem__(NameObject("/A"),
                            DictionaryObject({NameObject("/S"):NameObject("/JavaScript"),NameObject("/JS"):TextStringObject("changed()") })),
                            "hybrid_verification_unexpected_change")

    def test_duplicate_or_orphan_widgets_are_refused(self):
        self.assert_refused(fixture(),lambda w:w.pages[0]["/Annots"].append(w.pages[0]["/Annots"][0]),
                            "hybrid_verification_widget_reused")

    def test_missing_required_added_label_is_refused(self):
        self.assert_refused(fixture(),lambda w:first_field(w).pop(NameObject("/TU")),"hybrid_verification_authored_label")

    def test_signature_permissions_cannot_be_broadly_waived(self):
        source_writer=PdfWriter(clone_from=PdfReader(io.BytesIO(fixture())))
        source_writer.root_object["/Perms"][NameObject("/DocMDP")]=source_writer.root_object["/Perms"]["/UR3"]
        source=saved(source_writer)
        self.assert_refused(source,lambda w:None,"hybrid_verification_signature_permissions")

    def test_pixels_must_match_even_if_native_comparison_passes(self):
        source=fixture()
        with patch.object(h,"form_pixels",side_effect=[[{"page":1,"hash":"a"}],[{"page":1,"hash":"b"}]]):
            self.assert_refused(source,lambda w:None,"hybrid_verification_page_pixels")

    def test_utf16_entity_declaration_cannot_hide_from_xml_gate(self):
        writer=PdfWriter(clone_from=PdfReader(io.BytesIO(fixture())))
        stream=writer.root_object["/AcroForm"]["/XFA"][1].get_object()
        xml=stream.get_data().decode().replace(" Enter your name. ","&secret;")
        stream.set_data(('<?xml version="1.0" encoding="UTF-16"?><!DOCTYPE template [<!ENTITY secret "Changed">]>'+xml).encode('utf-16'))
        source=saved(writer)
        with self.assertRaises(h.HybridVerificationError):
            h.verify_hybrid_preparation(source,prepared(source))

    def test_arbitrary_objects_cannot_be_hidden_in_removed_rights(self):
        writer=PdfWriter(clone_from=PdfReader(io.BytesIO(fixture())))
        params=writer.root_object["/Perms"]["/UR3"]["/Reference"][0]["/TransformParams"]
        params[NameObject("/P")]=DictionaryObject({NameObject("/Hidden"):TextStringObject("Unrelated data")})
        source=saved(writer)
        self.assert_refused(source,lambda w:None,"hybrid_verification_signature_parameter_type")

    def test_unknown_signature_data_cannot_be_discarded(self):
        writer=PdfWriter(clone_from=PdfReader(io.BytesIO(fixture())))
        writer.root_object["/Perms"]["/UR3"][NameObject("/Unexpected")]=TextStringObject("Unrelated data")
        source=saved(writer)
        self.assert_refused(source,lambda w:None,"hybrid_verification_signature_kind")


if __name__ == "__main__":
    unittest.main()
