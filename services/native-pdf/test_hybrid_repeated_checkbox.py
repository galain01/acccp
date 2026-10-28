"""Bounded recognition of duplicated legacy checkbox handlers, without execution."""
import io
import unittest

from pypdf import PdfReader, PdfWriter

import hybrid_forms as hybrid
import hybrid_form_verification as preservation
import worker
from test_hybrid_forms import fixture


HANDLER = ('comment();\nvar fld = this.getField ("localField[0]");\n'
           'if (fld.isBoxChecked(0)) { fld.checkThisBox (0, true); }\n'
           'else { fld.checkThisBox (0, false); }\nMainCalculation();')


def saved(writer):
    result = io.BytesIO()
    writer.write(result)
    return result.getvalue()


def repeated_fixture(script, *, checkbox=True, activity="mouseUp"):
    event = (f'<event activity="{activity}"><script contentType="application/x-javascript">'
             + script + '</script></event>')
    return fixture(checkbox=checkbox, template_extra=event)


class RepeatedCheckboxHybridTests(unittest.TestCase):
    def test_two_or_three_exact_checkbox_stanzas_are_accepted_unchanged(self):
        for count in (2, 3):
            with self.subTest(count=count):
                script = "\n".join([HANDLER] * count)
                writer, _, _ = repeated_fixture(script)
                source = saved(writer)
                self.assertEqual(len(hybrid.inspect_hybrid(writer).fields), 1)
                self.assertEqual(len(worker.open_pdf(source).pages), 1)
                candidate = PdfWriter(clone_from=PdfReader(io.BytesIO(source), strict=True))
                hybrid.prepare_hybrid(candidate)
                output = saved(candidate)
                self.assertTrue(preservation.verify_hybrid_preparation(source, output)["passed"])
                saved_template = PdfReader(io.BytesIO(output), strict=True).trailer["/Root"]["/AcroForm"]["/XFA"][3].get_object().get_data()
                self.assertIn(script.encode(), saved_template)

    def test_line_endings_of_exact_repetitions_are_preserved(self):
        script = (HANDLER + "\n" + HANDLER).replace("\n", "\r\n")
        writer, _, form = repeated_fixture(script)
        hybrid.prepare_hybrid(writer)
        self.assertIn(script.encode(), form["/XFA"][3].get_object().get_data())

    def test_larger_or_changed_programs_are_refused(self):
        variants = (
            "\n".join([HANDLER] * 4),
            HANDLER + "\n" + HANDLER + "\napp.alert('unexpected');",
            "app.alert('unexpected');\n" + HANDLER + "\n" + HANDLER,
            HANDLER + "\n" + HANDLER.replace("localField[0]", "otherField[0]"),
            HANDLER + "\n" + HANDLER.replace("true", "false"),
            HANDLER + "\n" + HANDLER.replace("MainCalculation();", "OtherCalculation();"),
            HANDLER + "\n" + HANDLER.replace("comment();", "comment(); /* changed stanza */"),
            HANDLER + "\n" + HANDLER.replace("var fld", "var  fld"),
        )
        for script in variants:
            with self.subTest(script=script):
                writer, _, _ = repeated_fixture(script)
                with self.assertRaises(hybrid.HybridFormError):
                    hybrid.inspect_hybrid(writer)

    def test_repetitions_remain_limited_to_checkbox_mouseup(self):
        for checkbox, activity in ((False, "mouseUp"), (True, "enter"), (True, "click")):
            with self.subTest(checkbox=checkbox, activity=activity):
                writer, _, _ = repeated_fixture(HANDLER + "\n" + HANDLER,
                                                checkbox=checkbox, activity=activity)
                with self.assertRaises(hybrid.HybridFormError):
                    hybrid.inspect_hybrid(writer)

    def test_independent_verifier_does_not_allow_program_change(self):
        writer, _, _ = repeated_fixture(HANDLER + "\n" + HANDLER)
        source = saved(writer)
        candidate = PdfWriter(clone_from=PdfReader(io.BytesIO(source), strict=True))
        hybrid.prepare_hybrid(candidate)
        packet = candidate.root_object["/AcroForm"]["/XFA"][3].get_object()
        packet.set_data(packet.get_data().replace(b'localField[0]', b'otherField[0]'))
        with self.assertRaises(preservation.HybridVerificationError):
            preservation.verify_hybrid_preparation(source, saved(candidate))


if __name__ == "__main__":
    unittest.main()
