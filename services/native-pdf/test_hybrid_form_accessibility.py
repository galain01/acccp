"""Source-grounded form metadata and independent mutation rejection tests."""
import io
import unittest

from pypdf import PdfReader, PdfWriter
from pypdf.generic import ArrayObject, BooleanObject, DictionaryObject, NameObject, NumberObject, TextStringObject

from hybrid_forms import HybridFormError, inspect_hybrid, prepare_hybrid
from hybrid_form_accessibility import template_stream
from hybrid_form_verification import HybridVerificationError, verify_hybrid_preparation
from test_hybrid_forms import fixture


def saved(writer):
    buffer = io.BytesIO()
    writer.write(buffer)
    return buffer.getvalue()


def segmented(*, missing_traversal=False, mismatched_comb=False, wrong_row=False, conflict=False):
    writer, initial, form = fixture(label="Account &amp; branch code. First 3 digits. ")
    group = initial["/Parent"]
    fields = [initial]
    for number in (1, 2):
        field = DictionaryObject(dict(initial))
        writer._add_object(field)
        field[NameObject("/T")] = TextStringObject(f"segment{number}[0]")
        group["/Kids"].append(field.indirect_reference)
        writer.pages[0]["/Annots"].append(field.indirect_reference)
        fields.append(field)
    for index, (field, count) in enumerate(zip(fields, (3, 2, 4))):
        field[NameObject("/MaxLen")] = NumberObject(count)
        field[NameObject("/Ff")] = NumberObject(1 << 24)
        field[NameObject("/V")] = TextStringObject("")
        field[NameObject("/Rect")] = ArrayObject([NumberObject(n) for n in (10 + index * 55, 10, 50 + index * 55, 30)])
    if wrong_row:
        fields[1][NameObject("/Rect")][1] = NumberObject(40)
    if conflict:
        fields[1][NameObject("/TU")] = TextStringObject("Authored custom name")
    first_link = '' if missing_traversal else '<traversal><traverse ref="dash[0]"/></traversal>'
    cell = 9 if mismatched_comb else 2
    text = ('<template xmlns="http://www.xfa.org/schema/xfa-template/3.6/"><subform name="form">'
        '<!-- Preserve original formatting, escaped labels and comments. -->'
        '<field name="field"><ui><textEdit><comb numberOfCells="3"/></textEdit></ui>'
        '<assist><speak disable = \'1\'>Account &amp; branch code. First 3 digits. </speak></assist>'
        + first_link + '</field>'
        '<draw name="dash"><value><text>-</text></value><traversal><traverse ref="segment1[0]"/></traversal>'
        '<assist><speak disable="1">Do not enable a decorative dash</speak></assist></draw>'
        f'<field name="segment1"><ui><textEdit><comb numberOfCells="{cell}"/></textEdit></ui>'
        '<assist><speak disable="1">Middle 2 digits. </speak></assist>'
        '<traversal><traverse ref="segment2[0]"/></traversal></field>'
        '<field name="segment2"><ui><textEdit><comb numberOfCells="4"/></textEdit></ui>'
        '<assist><speak disable="1">Last 4 digits. </speak></assist></field>'
        '</subform></template>')
    template_stream(writer).set_data(text.encode())
    return writer, fields


def repaired(source, mutation=None):
    writer = PdfWriter(clone_from=PdfReader(io.BytesIO(source), strict=True))
    prepare_hybrid(writer)
    if mutation:
        mutation(writer)
    return saved(writer)


class FormAccessibilityTests(unittest.TestCase):
    def test_general_segment_context_and_speech_preserve_every_other_byte(self):
        writer, _ = segmented()
        source = saved(writer)
        output = repaired(source)
        proof = verify_hybrid_preparation(source, output)
        self.assertEqual([change["newText"] for change in proof["accessibleNameChanges"]],
            ["Account & branch code. Middle 2 digits. ", "Account & branch code. Last 4 digits. "])
        self.assertEqual(len(proof["speechPromptsEnabled"]), 3)
        self.assertTrue(proof["verifiedAccessibilityMetadataOnly"])
        self.assertTrue(proof["xfaScriptsBindingsAndDataUnchanged"])
        self.assertFalse(proof["xfaPacketsScriptsBindingsAndDataUnchanged"])
        xml = template_stream(PdfReader(io.BytesIO(output))).get_data()
        self.assertIn(b'disable = \'0\'', xml)
        self.assertIn(b'<speak disable="1">Do not enable a decorative dash</speak>', xml)
        self.assertIn(b'Account &amp; branch code. Middle 2 digits.', xml)
        second = verify_hybrid_preparation(output, repaired(output))
        self.assertEqual(second["accessibleNameChanges"], [])
        self.assertEqual(second["speechPromptsEnabled"], [])

    def test_incomplete_or_ambiguous_groups_remain_unqualified(self):
        for option in ("missing_traversal", "mismatched_comb", "wrong_row", "conflict"):
            with self.subTest(option=option):
                writer, _ = segmented(**{option: True})
                source = saved(writer)
                proof = verify_hybrid_preparation(source, repaired(source))
                self.assertEqual(proof["accessibleNameChanges"], [])
                if option == "conflict":
                    self.assertNotIn("form[0].segment1[0]", proof["speechPromptsEnabled"])

    def test_already_enabled_or_unsupported_priority_is_preserved(self):
        for value in (b'disable="0"', b'disable="1" priority="caption"', b'disable="&#49;"'):
            with self.subTest(value=value):
                writer, _, _ = fixture()
                packet = template_stream(writer)
                packet.set_data(packet.get_data().replace(b'disable="1"', value))
                source = saved(writer)
                proof = verify_hybrid_preparation(source, repaired(source))
                self.assertEqual(proof["speechPromptsEnabled"], [])

    def test_required_state_values_and_validation_are_never_added(self):
        writer, field, _ = fixture(label="Name. An entry is required.")
        field[NameObject("/Ff")] = NumberObject(8388608)
        source = saved(writer)
        output = repaired(source)
        proof = verify_hybrid_preparation(source, output)
        reader = PdfReader(io.BytesIO(output))
        context = inspect_hybrid(reader)
        self.assertEqual(context.fields[0].native_field["/Ff"], 8388608)
        self.assertEqual(context.fields[0].authored_label, "Name. An entry is required.")
        self.assertFalse(context.fields[0].speech_disabled)
        self.assertTrue(proof["otherReachableObjectsUnchanged"])

    def test_namespace_value_cannot_impersonate_disable_attribute(self):
        for attribute, expected in ((b'&#49;', 0), (b'1', 1)):
            with self.subTest(attribute=attribute):
                writer, _, _ = fixture()
                packet = template_stream(writer)
                xml = packet.get_data().replace(b'disable="1"', b'xmlns:x=\'disable="1"\' disable="' + attribute + b'"')
                packet.set_data(xml)
                source = saved(writer)
                output = repaired(source)
                proof = verify_hybrid_preparation(source, output)
                self.assertEqual(len(proof["speechPromptsEnabled"]), expected)
                after = PdfReader(io.BytesIO(output))
                self.assertEqual(inspect_hybrid(after).fields[0].speech_disabled, not bool(expected))
                self.assertIn(b'xmlns:x=\'disable="1"\'', template_stream(after).get_data())
                def mutate_namespace(writer):
                    stream = template_stream(writer)
                    stream.set_data(stream.get_data().replace(b'xmlns:x=\'disable="1"\'', b'xmlns:x=\'disable="0"\''))
                with self.assertRaises(HybridVerificationError):
                    verify_hybrid_preparation(source, repaired(source, mutate_namespace))

    def test_foreign_namespace_cannot_impersonate_form_metadata_evidence(self):
        for tag in ("speak", "assist", "comb", "traversal", "traverse", "field", "subform", "draw", "ui", "textEdit"):
            with self.subTest(tag=tag):
                writer, _ = segmented()
                packet = template_stream(writer)
                xml = packet.get_data().replace(("<" + tag).encode(), ("<" + tag + ' xmlns="urn:unrelated"').encode())
                packet.set_data(xml)
                source = saved(writer)
                with self.assertRaises(HybridFormError):
                    repaired(source)
                with self.assertRaises(HybridVerificationError):
                    verify_hybrid_preparation(source, source)

    def test_inherited_button_flags_cannot_impersonate_checkbox(self):
        for flag in (NumberObject(32768), NumberObject(65536), TextStringObject("0"), BooleanObject(False)):
            with self.subTest(flag=flag):
                writer, field, _ = fixture(checkbox=True)
                field["/Parent"][NameObject("/Ff")] = flag
                source = saved(writer)
                with self.assertRaises(HybridFormError):
                    repaired(source)
                with self.assertRaises(HybridVerificationError):
                    verify_hybrid_preparation(source, source)
        writer, field, _ = fixture(checkbox=True)
        field["/Parent"][NameObject("/Ff")] = NumberObject(32768)
        field[NameObject("/Ff")] = NumberObject(0)
        source = saved(writer)
        self.assertTrue(verify_hybrid_preparation(source, repaired(source))["passed"])

    def test_unrecognized_wrapper_cannot_hide_an_invalid_field_position(self):
        for namespace in ("urn:unrelated", "http://www.xfa.org/schema/xfa-template/3.6/"):
            with self.subTest(namespace=namespace):
                writer, _, _ = fixture()
                packet = template_stream(writer)
                xml = packet.get_data().replace(b'<field ', ('<extension xmlns="' + namespace + '"><field xmlns="http://www.xfa.org/schema/xfa-template/3.6/" ').encode()).replace(b'</field>', b'</field></extension>')
                packet.set_data(xml)
                source = saved(writer)
                with self.assertRaises(HybridFormError):
                    repaired(source)
                with self.assertRaises(HybridVerificationError):
                    verify_hybrid_preparation(source, source)

    def test_wrong_context_or_only_one_layer_update_is_rejected(self):
        writer, _ = segmented()
        source = saved(writer)
        def native_change(writer):
            inspect_hybrid(writer).fields[1].native_field[NameObject("/TU")] = TextStringObject("Middle 2 digits. ")
        def wrong_context(writer):
            packet = template_stream(writer)
            packet.set_data(packet.get_data().replace(b'Account &amp; branch code. Middle', b'Other account. Middle'))
        def nonfield_speech(writer):
            packet = template_stream(writer)
            packet.set_data(packet.get_data().replace(b'disable="1">Do not', b'disable="0">Do not'))
        for mutation in (native_change, wrong_context, nonfield_speech):
            with self.subTest(mutation=mutation.__name__), self.assertRaises(HybridVerificationError):
                verify_hybrid_preparation(source, repaired(source, mutation))

    def test_unrelated_xml_and_native_mutations_are_rejected(self):
        writer, _ = segmented()
        source = saved(writer)
        def xml_change(writer):
            packet = template_stream(writer)
            packet.set_data(packet.get_data().replace(b'Preserve original', b'Change original'))
        def flag_change(writer):
            inspect_hybrid(writer).fields[0].native_field[NameObject("/Ff")] = NumberObject(2)
        def value_change(writer):
            inspect_hybrid(writer).fields[0].native_field[NameObject("/V")] = TextStringObject("999")
        for mutation in (xml_change, flag_change, value_change):
            with self.subTest(mutation=mutation.__name__), self.assertRaises(HybridVerificationError):
                verify_hybrid_preparation(source, repaired(source, mutation))


if __name__ == "__main__":
    unittest.main()
