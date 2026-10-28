"""Native structural edits must not round unrelated content-stream operands."""
import io
from pathlib import Path
import sys
import tempfile
import unittest

from pypdf import PdfReader, PdfWriter
from pypdf.generic import (ArrayObject, ByteStringObject, ContentStream, DictionaryObject,
                          FloatObject, NameObject as N, NumberObject)

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "research/native-pdf"))
import bounded_semantic_structure as semantic
import bounded_table_structure as tables
import bounded_grid_table_structure as grids
import bounded_chart_structure as charts
import bounded_artifact_reading as artifacts
import verify_pdf as v
from test_bounded_semantic_structure import fixture as semantic_fixture, selection
from test_bounded_table_structure import fixture as table_fixture, selected
from test_table_reliability_regressions import explicit_grid
from test_bounded_chart_structure import fixture as chart_fixture, selection as chart_selection
from test_artifact_reading_reliability import artifact_fixture
from test_native_pdf_validation import pdf_bytes


PRECISION_PAINT = b"q 554.3999939 0 0 722.1085205 0 0 cm 0 0 0.0001 0.0001 re f Q\n"


def saved(writer):
    output = io.BytesIO()
    writer.write(output)
    return output.getvalue()


def precise_source(writer):
    stream = writer.pages[0]["/Contents"].get_object()
    stream.set_data(PRECISION_PAINT + stream.get_data())
    return PdfReader(io.BytesIO(saved(writer)), strict=True)


def matrices(reader):
    return [[float(value) for value in args] for args, operator in v.operations(reader.pages[0]) if operator == b"cm"]


class ContentOperandPrecisionTests(unittest.TestCase):
    def assert_precise_repair(self, source, module, operations):
        original = matrices(source)
        self.assertEqual(original[0][0], 554.3999939)
        self.assertEqual(original[0][3], 722.1085205)
        writer = PdfWriter(clone_from=source)
        result = module.apply_operations(source, writer, operations)
        self.assertTrue(result["changes"])
        output = PdfReader(io.BytesIO(saved(writer)), strict=True)
        self.assertEqual(matrices(output), original)
        self.assertEqual(v.drawing_fingerprint(v.operations(source.pages[0]), v.Canonicalizer()),
                         v.drawing_fingerprint(v.operations(output.pages[0]), v.Canonicalizer()))
        module.verify_saved(output, result["verification"])

    def test_semantic_split_and_list_repairs_keep_unrelated_matrix_precision(self):
        source = precise_source(semantic_fixture()[0])
        self.assert_precise_repair(source, semantic, selection(semantic.discover_candidates(source)))

    def test_two_column_table_repair_keeps_unrelated_matrix_precision(self):
        source = precise_source(table_fixture())
        operations = [selected(item) for item in tables.discover_candidates(source)]
        self.assert_precise_repair(source, tables, operations)

    def test_grid_table_repair_keeps_unrelated_matrix_precision(self):
        source = precise_source(explicit_grid())
        operations = [selected(item) for item in grids.discover_candidates(source)]
        self.assert_precise_repair(source, grids, operations)

    def test_chart_repair_keeps_unrelated_matrix_precision(self):
        source = precise_source(chart_fixture()[0])
        self.assert_precise_repair(source, charts, chart_selection(source))

    def test_artifact_text_restoration_keeps_unrelated_matrix_precision(self):
        source = precise_source(artifact_fixture())
        candidate = artifacts.discover_candidates(source)[0]
        operation = {"type": "repair_structure", "tagId": candidate["tagId"], "candidateId": candidate["candidateId"],
            "selections": [{"scopeId": scope["scopeId"], "role": "P"} for scope in candidate["textScopes"]]}
        self.assert_precise_repair(source, artifacts, [operation])

    def test_local_serializer_roundtrips_nested_content_numbers_without_global_change(self):
        writer = PdfWriter()
        page = writer.add_blank_page(100, 100)
        number = FloatObject("554.3999939")
        before_default = io.BytesIO()
        number.write_to_stream(before_default)
        properties = DictionaryObject({N("/MCID"): NumberObject(0), N("/BBox"): ArrayObject([
            FloatObject("0.123456789"), FloatObject("1.987654321"), FloatObject("2.123456789"), FloatObject("3.987654321")])})
        image_settings = DictionaryObject({N("/W"): NumberObject(1), N("/H"): NumberObject(1),
            N("/BPC"): NumberObject(8), N("/CS"): N("/G"),
            N("/D"): ArrayObject([FloatObject("0.123456789"), FloatObject("0.987654321")])})
        operations = [([number, NumberObject(0), NumberObject(0), FloatObject("722.1085205"), NumberObject(0), NumberObject(0)], b"cm"),
            ([N("/P"), properties], b"BDC"),
            ([ArrayObject([ByteStringObject(b"Words"), FloatObject("-123.456789"), ByteStringObject(b"next")])], b"TJ"),
            ([], b"EMC"), ({"settings": image_settings, "data": b"\x80"}, b"INLINE IMAGE")]
        snapshot = semantic.raw([(args, op.decode()) for args, op in operations])
        content = semantic.preserved_content_stream(writer, operations)
        page[N("/Contents")] = writer._add_object(content)
        output = PdfReader(io.BytesIO(saved(writer)), strict=True)
        reparsed = ContentStream(output.pages[0]["/Contents"], output).operations
        self.assertEqual(semantic.raw([(args, op.decode()) for args, op in reparsed]), snapshot)
        self.assertEqual(semantic.raw([(args, op.decode()) for args, op in operations]), snapshot)
        after_default = io.BytesIO()
        number.write_to_stream(after_default)
        self.assertEqual(before_default.getvalue(), after_default.getvalue())
        self.assertIs(type(number), FloatObject)

    def test_genuine_geometry_change_is_still_rejected_by_independent_preservation(self):
        source_writer = PdfWriter(clone_from=PdfReader(io.BytesIO(pdf_bytes(tagged=True))))
        source = precise_source(source_writer)
        candidate = PdfWriter(clone_from=source)
        operations = v.operations(candidate.pages[0])
        matrix = next(args for args, operator in operations if operator == b"cm")
        matrix[0] = FloatObject("554.4999939")
        candidate.pages[0][N("/Contents")] = candidate._add_object(semantic.preserved_content_stream(candidate, operations))
        with tempfile.TemporaryDirectory() as directory:
            source_path = Path(directory) / "source.pdf"
            output_path = Path(directory) / "candidate.pdf"
            source_path.write_bytes(source.stream.getvalue())
            output_path.write_bytes(saved(candidate))
            result = v.compare_pdfs(source_path, output_path)
        self.assertFalse(result["preservation"]["passed"])
        self.assertFalse(result["preservation"]["pages"][0]["drawing_operators_identical"])


if __name__ == "__main__":
    unittest.main()
