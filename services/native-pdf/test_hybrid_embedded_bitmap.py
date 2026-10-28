"""Synthetic static XFA drawing bitmap support keeps original package bytes."""
import base64
import io
import struct
import unittest

from pypdf import PdfReader, PdfWriter

import hybrid_forms as hybrid
import hybrid_form_verification as preservation
import worker
from test_hybrid_forms import fixture


def bitmap():
    # Two 1-bit rows, each padded to a four-byte boundary; black/white palette.
    pixels = b"\x80\x00\x00\x00\x40\x00\x00\x00"
    palette = b"\x00\x00\x00\x00\xff\xff\xff\x00"
    dib = struct.pack("<IiiHHIIiiII", 40, 2, 2, 1, 1, 0, len(pixels), 2835, 2835, 0, 0)
    return struct.pack("<2sIHHI", b"BM", 14 + len(dib) + len(palette) + len(pixels), 0, 0, 62) + dib + palette + pixels


def saved(writer):
    output = io.BytesIO()
    writer.write(output)
    return output.getvalue()


def with_file_padding(padding):
    data = bytearray(bitmap() + padding)
    data[2:6] = struct.pack("<I", len(data))
    return bytes(data)


def embedded_fixture(data=None, *, image_attributes='contentType="image/bmp"',
                     image_body=None, image_suffix="", value_suffix="", draw_namespace=""):
    writer, field, form = fixture()
    encoded = base64.b64encode(bitmap() if data is None else data).decode() if image_body is None else image_body
    image = f'<image {image_attributes}>{encoded}{image_suffix}</image>'
    draw = f'<draw name="SyntheticIcon"{draw_namespace}><value>{image}{value_suffix}</value></draw>'
    packet = form["/XFA"][3].get_object()
    packet.set_data(packet.get_data().replace(b"</subform>", draw.encode() + b"</subform>"))
    return writer, field, form


class EmbeddedStaticBitmapHybridTests(unittest.TestCase):
    def test_static_1bit_bmp_draw_is_accepted_and_bytes_preserved(self):
        writer, _, _ = embedded_fixture()
        source = saved(writer)
        self.assertEqual(len(hybrid.inspect_hybrid(writer).fields), 1)
        self.assertEqual(len(worker.open_pdf(source).pages), 1)
        candidate = PdfWriter(clone_from=PdfReader(io.BytesIO(source), strict=True))
        hybrid.prepare_hybrid(candidate)
        output = saved(candidate)
        self.assertTrue(preservation.verify_hybrid_preparation(source, output)["passed"])
        original_template = PdfReader(io.BytesIO(source)).trailer["/Root"]["/AcroForm"]["/XFA"][3].get_object().get_data()
        output_template = PdfReader(io.BytesIO(output)).trailer["/Root"]["/AcroForm"]["/XFA"][3].get_object().get_data()
        self.assertEqual(original_template.replace(b'disable="1"', b'disable="0"'), output_template)

    def test_embedded_base64_line_whitespace_is_retained(self):
        encoded = base64.b64encode(bitmap()).decode()
        wrapped = "\n".join(encoded[index:index + 28] for index in range(0, len(encoded), 28))
        writer, _, form = embedded_fixture(image_body=wrapped)
        hybrid.prepare_hybrid(writer)
        self.assertIn(wrapped.encode(), form["/XFA"][3].get_object().get_data())

    def test_uncompressed_implicit_image_size_and_two_color_count_are_supported(self):
        data = bytearray(bitmap())
        data[34:38] = struct.pack("<I", 0)
        data[46:50] = struct.pack("<I", 2)
        writer, _, _ = embedded_fixture(bytes(data))
        self.assertEqual(len(hybrid.inspect_hybrid(writer).fields), 1)

    def test_zero_only_file_alignment_padding_is_supported_and_preserved(self):
        data = with_file_padding(b"\x00\x00")
        self.assertEqual(len(data) % 4, 0)
        writer, _, _ = embedded_fixture(data)
        source = saved(writer)
        self.assertEqual(len(hybrid.inspect_hybrid(writer).fields), 1)
        candidate = PdfWriter(clone_from=PdfReader(io.BytesIO(source), strict=True))
        hybrid.prepare_hybrid(candidate)
        output = saved(candidate)
        self.assertTrue(preservation.verify_hybrid_preparation(source, output)["passed"])
        template = PdfReader(io.BytesIO(output)).trailer["/Root"]["/AcroForm"]["/XFA"][3].get_object().get_data()
        self.assertIn(base64.b64encode(data), template)

    def test_file_padding_must_exactly_align_and_contain_only_zero_bytes(self):
        for padding in (b"\x00", b"\x00\x00\x00", b"\x00" * 4,
                        b"\x00\x01", b"\x01\x00", b"\x01\x01"):
            with self.subTest(padding=padding.hex()):
                writer, _, _ = embedded_fixture(with_file_padding(padding))
                with self.assertRaises(hybrid.HybridFormError):
                    hybrid.inspect_hybrid(writer)

    def test_nonstatic_or_foreign_image_structure_is_refused(self):
        variants = (
            {"image_attributes": 'contentType="image/png"'},
            {"image_attributes": 'contentType="image/bmp" href="https://example.invalid/icon.bmp"'},
            {"image_attributes": 'contentType="image/bmp" usehref="file:///tmp/icon.bmp"'},
            {"image_attributes": 'contentType="image/bmp" transferEncoding="base64"'},
            {"image_attributes": 'contentType="image/bmp" xmlns="https://example.invalid/"'},
            {"draw_namespace": ' xmlns="https://example.invalid/"'},
            {"image_suffix": '<script contentType="application/x-javascript">app.alert("unexpected")</script>'},
            {"value_suffix": '<text>unexpected value</text>'},
        )
        for options in variants:
            with self.subTest(options=options):
                writer, _, _ = embedded_fixture(**options)
                with self.assertRaises(hybrid.HybridFormError):
                    hybrid.inspect_hybrid(writer)

    def test_invalid_base64_truncated_or_malformed_bitmaps_are_refused(self):
        variants = [b"", b"not a bitmap", bitmap()[:53], bitmap()[:-1], bitmap() + b"\x00"]
        changes = (
            (0, b"ZZ"),                          # Signature.
            (2, struct.pack("<I", 0)),          # File size.
            (6, struct.pack("<H", 1)),          # Reserved header bits.
            (10, struct.pack("<I", 54)),        # Pixels overlap palette.
            (14, struct.pack("<I", 108)),       # Unsupported DIB shape.
            (18, struct.pack("<i", 0)),         # Invalid width.
            (18, struct.pack("<i", 4097)),      # Dimension budget.
            (22, struct.pack("<i", 0)),         # Invalid height.
            (22, struct.pack("<i", 4097)),      # Dimension budget.
            (26, struct.pack("<H", 2)),         # Planes.
            (28, struct.pack("<H", 8)),         # Unsupported bit depth.
            (30, struct.pack("<I", 1)),         # Compression.
            (34, struct.pack("<I", 4)),         # Wrong image-byte count.
            (46, struct.pack("<I", 3)),         # More colors than one-bit palette.
        )
        for offset, replacement in changes:
            data = bytearray(bitmap())
            data[offset:offset + len(replacement)] = replacement
            variants.append(bytes(data))
        for data in variants:
            with self.subTest(data=data[:54].hex()):
                writer, _, _ = embedded_fixture(data)
                with self.assertRaises(hybrid.HybridFormError):
                    hybrid.inspect_hybrid(writer)
        for text in ("***not base64***", base64.b64encode(bitmap()).decode() + "!"):
            with self.subTest(base64=text):
                writer, _, _ = embedded_fixture(image_body=text)
                with self.assertRaises(hybrid.HybridFormError):
                    hybrid.inspect_hybrid(writer)

    def test_independent_verifier_rejects_valid_bitmap_pixel_changes(self):
        writer, _, _ = embedded_fixture()
        source = saved(writer)
        candidate = PdfWriter(clone_from=PdfReader(io.BytesIO(source), strict=True))
        hybrid.prepare_hybrid(candidate)
        packet = candidate.root_object["/AcroForm"]["/XFA"][3].get_object()
        changed = bytearray(bitmap())
        changed[-1] = 1
        packet.set_data(packet.get_data().replace(base64.b64encode(bitmap()), base64.b64encode(changed)))
        with self.assertRaises(preservation.HybridVerificationError):
            preservation.verify_hybrid_preparation(source, saved(candidate))


if __name__ == "__main__":
    unittest.main()
