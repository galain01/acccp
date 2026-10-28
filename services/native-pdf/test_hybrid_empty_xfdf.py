"""Synthetic W-4 regression: optional inert XFDF is retained, never evaluated.

These fixtures deliberately contain no IRS document content.  Only a single
empty annotation-data packet is in scope; accepting it must not widen the
existing active-content or exact preservation gates.
"""
import io
import unittest

from pypdf import PdfReader, PdfWriter
from pypdf.generic import ArrayObject, DictionaryObject, NameObject, TextStringObject

import hybrid_forms as hybrid
import hybrid_form_verification as preservation
import worker
from test_hybrid_forms import fixture, stream


XFDF = '<xfdf xmlns="http://ns.adobe.com/xfdf/"><annots/></xfdf>'


def saved(writer):
    output = io.BytesIO()
    writer.write(output)
    return output.getvalue()


def with_xfdf(xml=XFDF):
    writer, field, form = fixture()
    packet = stream(writer, xml)
    form["/XFA"].extend([TextStringObject("xfdf"), packet])
    return writer, field, form, packet.get_object()


class EmptyXfdfHybridTests(unittest.TestCase):
    def test_empty_xfdf_accepts_plain_and_preserve_space_variants(self):
        variants = (
            XFDF,
            '<xfdf xmlns="http://ns.adobe.com/xfdf/" xml:space="preserve">\n <annots\n/>\n</xfdf>',
            '<?xml version="1.0" encoding="UTF-8"?>' + XFDF,
        )
        for xml in variants:
            with self.subTest(xml=xml):
                writer, _, _, _ = with_xfdf(xml)
                self.assertEqual(len(hybrid.inspect_hybrid(writer).fields), 1)
                opened = worker.open_pdf(saved(writer))
                self.assertEqual(len(opened.pages), 1)

    def test_preparation_keeps_empty_xfdf_bytes_and_independent_verifier_accepts(self):
        xml = '<xfdf xmlns="http://ns.adobe.com/xfdf/" xml:space="preserve"\n>\n   <annots\n/>\n</xfdf\n>'
        writer, _, _, packet = with_xfdf(xml)
        original_packet = packet.get_data()
        source = saved(writer)
        candidate = PdfWriter(clone_from=PdfReader(io.BytesIO(source), strict=True))
        hybrid.prepare_hybrid(candidate)
        output = saved(candidate)
        verified = preservation.verify_hybrid_preparation(source, output)
        self.assertTrue(verified["passed"])
        reopened = PdfReader(io.BytesIO(output), strict=True)
        self.assertEqual(reopened.trailer["/Root"]["/AcroForm"]["/XFA"][-1].get_object().get_data(), original_packet)
        self.assertEqual(reopened.get_fields()["form[0].field[0]"]["/TU"], "  Instructor name  ")

    def test_nonempty_or_unrecognized_xfdf_is_refused(self):
        variants = (
            '<xfdf xmlns="http://ns.adobe.com/xfdf/"><annots><text page="0"/></annots></xfdf>',
            '<xfdf xmlns="http://ns.adobe.com/xfdf/"><annots>unrecognized text</annots></xfdf>',
            '<xfdf xmlns="http://ns.adobe.com/xfdf/">unrecognized text<annots/></xfdf>',
            '<xfdf xmlns="http://ns.adobe.com/xfdf/"><annots/>unrecognized text</xfdf>',
            '<xfdf xmlns="http://ns.adobe.com/xfdf/"><annots page="0"/></xfdf>',
            '<xfdf xmlns="http://ns.adobe.com/xfdf/"><annots/><annots/></xfdf>',
            '<xfdf xmlns="http://ns.adobe.com/xfdf/"><fields/></xfdf>',
            '<xfdf xmlns="http://ns.adobe.com/xfdf/"><annots/><f href="https://example.invalid/"/></xfdf>',
            '<xfdf xmlns="http://ns.adobe.com/xfdf/" href="https://example.invalid/"><annots/></xfdf>',
            '<xfdf xmlns="http://ns.adobe.com/xfdf/" xml:space="default"><annots/></xfdf>',
            '<xfdf xmlns="http://ns.adobe.com/xfdf/" extra="ignored"><annots/></xfdf>',
            '<xfdf xmlns="https://example.invalid/xfdf/"><annots/></xfdf>',
            '<xfdf xmlns="http://ns.adobe.com/xfdf/"><annots xmlns="https://example.invalid/"/></xfdf>',
            '<xfdf xmlns="http://ns.adobe.com/xfdf/"/>',
            '<?xml-stylesheet href="https://example.invalid/style.xsl"?>' + XFDF,
            XFDF.replace('<annots/>', '<?application instruction="unknown"?><annots/>'),
            '<!DOCTYPE xfdf [<!ENTITY extra "injected">]><xfdf xmlns="http://ns.adobe.com/xfdf/"><annots>&extra;</annots></xfdf>',
        )
        for xml in variants:
            with self.subTest(xml=xml):
                writer, _, _, _ = with_xfdf(xml)
                with self.assertRaises(hybrid.HybridFormError):
                    hybrid.inspect_hybrid(writer)

    def test_duplicate_xfdf_packet_is_refused(self):
        writer, _, form, _ = with_xfdf()
        form["/XFA"].extend([TextStringObject("xfdf"), stream(writer, XFDF)])
        with self.assertRaises(hybrid.HybridFormError):
            hybrid.inspect_hybrid(writer)

    def test_xfdf_stream_dictionary_cannot_smuggle_actions_or_other_objects(self):
        for key, value in (
            ("/JS", TextStringObject("app.alert('unexpected')")),
            ("/AA", DictionaryObject()),
            ("/EF", DictionaryObject()),
            ("/Other", ArrayObject()),
        ):
            with self.subTest(key=key):
                writer, _, _, packet = with_xfdf()
                packet[NameObject(key)] = value
                with self.assertRaises(hybrid.HybridFormError):
                    hybrid.inspect_hybrid(writer)

    def test_empty_packet_does_not_allow_an_unrelated_document_action(self):
        writer, _, _, _ = with_xfdf()
        writer.root_object[NameObject("/OpenAction")] = DictionaryObject({
            NameObject("/S"): NameObject("/JavaScript"),
            NameObject("/JS"): TextStringObject("app.alert('unexpected')"),
        })
        with self.assertRaisesRegex(worker.WorkerError, "native_pdf_unsupported"):
            worker.open_pdf(saved(writer))

    def test_independent_verifier_rejects_changed_or_removed_xfdf_packet(self):
        for remove in (False, True):
            with self.subTest(remove=remove):
                writer, _, _, _ = with_xfdf()
                source = saved(writer)
                candidate = PdfWriter(clone_from=PdfReader(io.BytesIO(source), strict=True))
                hybrid.prepare_hybrid(candidate)
                packets = candidate.root_object["/AcroForm"]["/XFA"]
                if remove:
                    del packets[-2:]
                else:
                    packets[-1].get_object().set_data(XFDF.replace("<annots/>", '<annots><text page="0"/></annots>').encode())
                with self.assertRaises(preservation.HybridVerificationError):
                    preservation.verify_hybrid_preparation(source, saved(candidate))


if __name__ == "__main__":
    unittest.main()
