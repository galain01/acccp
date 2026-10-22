import io
import unittest
import hashlib
from unittest.mock import patch

from pypdf import PdfReader, PdfWriter
from pypdf.generic import (ArrayObject, ByteStringObject, DecodedStreamObject,
                          DictionaryObject, NameObject, NumberObject, TextStringObject)

import hybrid_forms as hybrid


def stream(writer, value):
    obj = DecodedStreamObject()
    obj.set_data(value.encode())
    return writer._add_object(obj)


def fixture(*, label="  Instructor name  ", template_extra="", config_extra="", checkbox=False):
    writer = PdfWriter()
    page = writer.add_blank_page(200, 200)
    field = DictionaryObject({
        NameObject("/T"): TextStringObject("field[0]"),
        NameObject("/FT"): NameObject("/Btn" if checkbox else "/Tx"),
        NameObject("/Type"): NameObject("/Annot"),
        NameObject("/Subtype"): NameObject("/Widget"),
        NameObject("/Rect"): ArrayObject([NumberObject(n) for n in (10, 10, 100, 30)]),
        NameObject("/P"): page.indirect_reference,
    })
    field_ref = writer._add_object(field)
    parent = DictionaryObject({NameObject("/T"): TextStringObject("form[0]"), NameObject("/Kids"): ArrayObject([field_ref])})
    parent_ref = writer._add_object(parent)
    field[NameObject("/Parent")] = parent_ref
    page[NameObject("/Annots")] = ArrayObject([field_ref])
    control = "checkButton" if checkbox else "textEdit"
    template = (f'<template xmlns="http://www.xfa.org/schema/xfa-template/3.6/"><subform name="form">'
                f'<field name="field"><ui><{control}/></ui><assist><speak disable="1">{label}</speak></assist>'
                f'{template_extra}</field></subform></template>')
    config = ('<config xmlns="http://www.xfa.org/schema/xci/3.0/"><acrobat><acrobat7>'
              f'<dynamicRender>forbidden</dynamicRender></acrobat7></acrobat>{config_extra}</config>')
    form = DictionaryObject({NameObject("/Fields"): ArrayObject([parent_ref]),
        NameObject("/XFA"): ArrayObject([TextStringObject("config"), stream(writer, config),
                                        TextStringObject("template"), stream(writer, template)])})
    writer.root_object[NameObject("/AcroForm")] = writer._add_object(form)
    return writer, field, form


def reader_rights(writer):
    params = DictionaryObject({NameObject("/Type"): NameObject("/TransformParams"),
        NameObject("/V"): NameObject("/2.2"), NameObject("/Document"): ArrayObject([NameObject("/FullSave")])})
    reference = DictionaryObject({NameObject("/Type"): NameObject("/SigRef"), NameObject("/TransformMethod"): NameObject("/UR3"),
        NameObject("/TransformParams"): params, NameObject("/Data"): writer.root_object.indirect_reference})
    signature = DictionaryObject({NameObject("/Type"): NameObject("/Sig"), NameObject("/Filter"): NameObject("/Adobe.PPKLite"),
        NameObject("/SubFilter"): NameObject("/adbe.pkcs7.detached"), NameObject("/Contents"): ByteStringObject(b"\x9fusage-rights"),
        NameObject("/ByteRange"): ArrayObject([NumberObject(n) for n in (0, 10, 30, 10)]),
        NameObject("/Reference"): ArrayObject([writer._add_object(reference)])})
    writer.root_object[NameObject("/Perms")] = DictionaryObject({NameObject("/UR3"): writer._add_object(signature)})
    return signature


def reopened(writer):
    buffer = io.BytesIO()
    writer.write(buffer)
    return PdfReader(io.BytesIO(buffer.getvalue()), strict=True)


class HybridFormsTests(unittest.TestCase):
    def rejected(self, writer):
        with self.assertRaises(hybrid.HybridFormError) as error:
            hybrid.inspect_hybrid(writer)
        self.assertIn(str(error.exception), {"native_pdf_unsupported", "pdf_complexity_limit"})

    def test_prepare_copies_exact_authored_label_and_keeps_xfa_and_sigflags(self):
        writer, field, form = fixture()
        reader_rights(writer)
        form[NameObject("/SigFlags")] = NumberObject(2)
        xfa_before = [form["/XFA"][i].get_object().get_data() for i in (1, 3)]
        context = hybrid.prepare_hybrid(writer)
        self.assertTrue(context.has_reader_rights)
        self.assertEqual(field["/TU"], "  Instructor name  ")
        self.assertNotIn("/Perms", writer.root_object)
        self.assertEqual(form["/SigFlags"], 2)
        self.assertEqual(xfa_before, [form["/XFA"][i].get_object().get_data() for i in (1, 3)])
        output = reopened(writer)
        second = hybrid.inspect_hybrid(output)
        self.assertFalse(second.has_reader_rights)
        self.assertFalse(second.fields[0].needs_tooltip)

    def test_prepare_is_idempotent_and_never_changes_existing_blank_label(self):
        writer, field, _ = fixture()
        field[NameObject("/TU")] = TextStringObject("")
        hybrid.prepare_hybrid(writer)
        hybrid.prepare_hybrid(writer)
        self.assertEqual(field["/TU"], "")

    def test_empty_source_label_is_not_invented(self):
        writer, field, _ = fixture(label=" \n ")
        hybrid.prepare_hybrid(writer)
        self.assertNotIn("/TU", field)

    def test_regular_acroform_is_not_a_hybrid(self):
        writer, _, form = fixture()
        del form[NameObject("/XFA")]
        self.assertIsNone(hybrid.inspect_hybrid(writer))

    def test_user_signature_still_rejected_with_reader_rights(self):
        writer, field, _ = fixture()
        reader_rights(writer)
        field[NameObject("/FT")] = NameObject("/Sig")
        self.rejected(writer)

    def test_other_permissions_and_signature_transforms_are_rejected(self):
        for name in ("/UR", "/DocMDP", "/Other"):
            with self.subTest(name=name):
                writer, _, _ = fixture()
                reader_rights(writer)
                writer.root_object["/Perms"][NameObject(name)] = DictionaryObject()
                self.rejected(writer)
        writer, _, _ = fixture()
        signature = reader_rights(writer)
        signature["/Reference"][0].get_object()[NameObject("/TransformMethod")] = NameObject("/DocMDP")
        self.rejected(writer)

    def test_signature_subtree_cannot_smuggle_active_objects(self):
        writer, _, _ = fixture()
        signature = reader_rights(writer)
        signature[NameObject("/Prop_Build")] = DictionaryObject({NameObject("/App"): DictionaryObject({NameObject("/JS"): TextStringObject("bad")})})
        self.rejected(writer)
        writer, _, _ = fixture()
        signature = reader_rights(writer)
        signature["/Reference"][0].get_object()["/TransformParams"][NameObject("/P")] = DictionaryObject()
        self.rejected(writer)

    def test_embeddedfile_typed_xfa_streams_only_exempt_at_packet_positions(self):
        writer, _, form = fixture()
        packet = form["/XFA"][1].get_object()
        packet[NameObject("/Type")] = NameObject("/EmbeddedFile")
        context = hybrid.inspect_hybrid(writer)
        self.assertIn(id(packet), context.xfa_packet_stream_ids)
        writer.root_object[NameObject("/HiddenCopy")] = form["/XFA"][1]
        self.rejected(writer)

    def test_rights_and_form_owner_aliases_reject(self):
        writer, _, form = fixture()
        writer.root_object[NameObject("/Alias")] = form.indirect_reference
        self.rejected(writer)
        writer, _, _ = fixture()
        signature = reader_rights(writer)
        writer.root_object[NameObject("/Alias")] = signature.indirect_reference
        self.rejected(writer)

    def test_approved_document_action_cannot_be_reused_as_link_action(self):
        writer, _, _ = fixture()
        names = ArrayObject()
        approved = {}
        for index, name in enumerate(hybrid.ADOBE_BOOTSTRAP):
            program = f"approved_test_program_{index}"
            approved[name] = hashlib.sha256(program.encode()).hexdigest()
            action = DictionaryObject({NameObject("/S"): NameObject("/JavaScript"), NameObject("/JS"): TextStringObject(program)})
            names.extend([TextStringObject(name), writer._add_object(action)])
        writer.root_object[NameObject("/Names")] = DictionaryObject({NameObject("/JavaScript"): DictionaryObject({NameObject("/Names"): names})})
        # Isolate graph ownership from program recognition. Production continues
        # to require the unpatched reviewed Adobe program digests.
        with patch.dict(hybrid.ADOBE_BOOTSTRAP, approved, clear=True):
            self.assertIsNotNone(hybrid.inspect_hybrid(writer))
            link = DictionaryObject({NameObject("/Subtype"): NameObject("/Link"), NameObject("/A"): names[1]})
            writer.pages[0]["/Annots"].append(writer._add_object(link))
            self.rejected(writer)

    def test_hidden_user_signature_is_rejected(self):
        writer, _, _ = fixture()
        writer.root_object[NameObject("/Hidden")] = DictionaryObject({NameObject("/Type"): NameObject("/Sig")})
        self.rejected(writer)

    def test_dynamic_render_and_dynamic_templates_rejected(self):
        writer, _, form = fixture()
        config = form["/XFA"][1].get_object().get_data().replace(b"forbidden", b"required")
        form["/XFA"][1].get_object().set_data(config)
        self.rejected(writer)
        for extra in ("<occur/>", "<calculate/>", "<validate/>", "<connectionSet/>"):
            with self.subTest(extra=extra):
                writer, _, _ = fixture(template_extra=extra)
                self.rejected(writer)
        writer, _, form = fixture()
        config = form["/XFA"][1].get_object().get_data().replace(b"<acrobat><acrobat7>", b"<unexpected>").replace(b"</acrobat7></acrobat>", b"</unexpected>")
        form["/XFA"][1].get_object().set_data(config)
        self.rejected(writer)

    def test_external_xml_resources_and_entities_rejected(self):
        for extra in ('<image href="https://example.invalid/image"/>', '<para usehref="file:///etc/passwd"/>'):
            writer, _, _ = fixture(template_extra=extra)
            self.rejected(writer)
        writer, _, form = fixture()
        form["/XFA"][3].get_object().set_data(b'<!DOCTYPE template [<!ENTITY x "bad">]>' + form["/XFA"][3].get_object().get_data())
        self.rejected(writer)
        writer, _, _ = fixture(config_extra='<template><uri>https://example.invalid/template</uri></template>')
        self.rejected(writer)
        writer, _, form = fixture()
        text = '<!DOCTYPE config [<!ENTITY probe "accepted">]>' + form["/XFA"][1].get_object().get_data().decode()
        form["/XFA"][1].get_object().set_data(text.encode("utf-16"))
        self.rejected(writer)

    def test_historical_local_output_filename_is_not_fetched(self):
        writer, _, _ = fixture(config_extra='<present><output><uri>C:\\author\\output\\form.pdf</uri></output></present>')
        self.assertIsNotNone(hybrid.inspect_hybrid(writer))
        writer, _, _ = fixture(config_extra='<present><output><uri>https://example.invalid/output.pdf</uri></output></present>')
        self.rejected(writer)

    def test_unknown_script_and_fake_adobe_name_rejected(self):
        writer, _, _ = fixture(template_extra='<event activity="enter"><script contentType="application/x-javascript">app.alert("hello")</script></event>')
        self.rejected(writer)
        writer, _, _ = fixture()
        names = ArrayObject()
        for name in hybrid.ADOBE_BOOTSTRAP:
            action = DictionaryObject({NameObject("/S"): NameObject("/JavaScript"), NameObject("/JS"): TextStringObject("app.alert('fake')")})
            names.extend([TextStringObject(name), writer._add_object(action)])
        writer.root_object[NameObject("/Names")] = DictionaryObject({NameObject("/JavaScript"): DictionaryObject({NameObject("/Names"): names})})
        self.rejected(writer)

    def test_comments_and_exact_legacy_checkbox_handler_are_retained(self):
        script = ('comment();\nvar fld = this.getField ("localField[0]");\n'
                  'if (fld.isBoxChecked(0)) { fld.checkThisBox (0, true); }\n'
                  'else { fld.checkThisBox (0, false); }\nMainCalculation();')
        extra = f'<event activity="mouseUp"><script contentType="application/x-javascript">{script}</script></event>'
        writer, _, form = fixture(checkbox=True, template_extra=extra)
        before = form["/XFA"][3].get_object().get_data()
        hybrid.prepare_hybrid(writer)
        self.assertEqual(before, form["/XFA"][3].get_object().get_data())
        writer, _, _ = fixture(template_extra='<event activity="enter"><script contentType="application/x-javascript">/* legacy comment */\n// another comment</script></event>')
        self.assertIsNotNone(hybrid.inspect_hybrid(writer))

    def test_legacy_script_with_extra_behavior_rejected(self):
        script = 'comment(); var fld = this.getField ("field[0]"); if (fld.isBoxChecked(0)) { fld.checkThisBox (0, true); } else { fld.checkThisBox (0, false); } MainCalculation(); app.alert("extra");'
        writer, _, _ = fixture(checkbox=True, template_extra=f'<event activity="mouseUp"><script contentType="application/x-javascript">{script}</script></event>')
        self.rejected(writer)

    def test_missing_or_duplicate_native_mapping_rejected(self):
        writer, field, _ = fixture()
        field[NameObject("/T")] = TextStringObject("different[0]")
        self.rejected(writer)
        writer, _, form = fixture()
        form["/Fields"].append(form["/Fields"][0])
        self.rejected(writer)

    def test_orphan_and_repeated_widget_rejected(self):
        writer, _, _ = fixture()
        writer.pages[0]["/Annots"].append(writer.pages[0]["/Annots"][0])
        self.rejected(writer)

    def test_field_actions_and_control_type_mismatch_rejected(self):
        writer, field, _ = fixture()
        field[NameObject("/AA")] = DictionaryObject()
        self.rejected(writer)
        writer, field, _ = fixture()
        field[NameObject("/FT")] = NameObject("/Btn")
        self.rejected(writer)

    def test_oversized_label_is_bounded(self):
        writer, _, _ = fixture(label="x" * (hybrid.MAX_LABEL + 1))
        with self.assertRaises(hybrid.HybridFormError) as error:
            hybrid.inspect_hybrid(writer)
        self.assertEqual(error.exception.code, "pdf_complexity_limit")


if __name__ == "__main__":
    unittest.main()
