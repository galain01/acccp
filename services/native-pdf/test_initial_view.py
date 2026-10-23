"""Initial-page views are passive navigation, and must survive PDF repair."""
import tempfile
import unittest
from pathlib import Path

from pypdf.generic import (
    ArrayObject, BooleanObject, ByteStringObject, DictionaryObject, FloatObject,
    NameObject, NullObject, NumberObject, TextStringObject,
)

import worker
from test_worker import modified, pdf_bytes


def destination(writer, mode="/Fit", coordinates=(), page=0):
    return ArrayObject([writer.pages[page].indirect_reference, NameObject(mode), *coordinates])


def with_opening_view(factory, *, extra_page=False):
    def mutate(writer):
        if extra_page:
            writer.add_blank_page(200, 100)
        writer.root_object[NameObject("/OpenAction")] = factory(writer)
    return modified(pdf_bytes(tagged=True, text="Fictional chapter"), mutate)


def goto(target, **extra):
    value = DictionaryObject({NameObject("/S"): NameObject("/GoTo"), NameObject("/D"): target})
    value.update({NameObject(key): item for key, item in extra.items()})
    return value


def resolver(reader):
    pages = {worker.verify_pdf.reference_key(page): index for index, page in enumerate(reader.pages, 1)}
    return worker.verify_pdf.LocalDestinations(reader.trailer["/Root"], pages)


def named_view(writer, kind, *, duplicate=False, missing=False):
    value = destination(writer, "/FitH", [NumberObject(80)])
    if kind == "legacy":
        name = NameObject("/chapter")
        if not missing:
            writer.root_object[NameObject("/Dests")] = DictionaryObject({
                name: DictionaryObject({NameObject("/D"): value}),
            })
    else:
        name = ByteStringObject(b"chapter") if kind == "bytes" else TextStringObject("chapter")
        if not missing:
            entries = ArrayObject([name, value])
            if duplicate:
                entries.extend([name, value])
            writer.root_object[NameObject("/Names")] = DictionaryObject({
                NameObject("/Dests"): DictionaryObject({NameObject("/Names"): entries}),
            })
    return goto(name)


class NativePdfInitialViewTests(unittest.TestCase):
    def assert_rejected(self, data):
        with self.assertRaisesRegex(worker.WorkerError, "native_pdf_unsupported"):
            worker.open_pdf(data)

    def test_all_standard_explicit_views_are_accepted(self):
        views = {
            "/XYZ": [NullObject(), NumberObject(80), FloatObject(1.25)],
            "/Fit": [],
            "/FitH": [NullObject()],
            "/FitV": [NumberObject(20)],
            "/FitR": [NumberObject(value) for value in (0, 0, 200, 100)],
            "/FitB": [],
            "/FitBH": [NumberObject(90)],
            "/FitBV": [NullObject()],
        }
        for mode, coordinates in views.items():
            with self.subTest(mode=mode):
                reader = worker.open_pdf(with_opening_view(lambda w: destination(w, mode, coordinates)))
                view = resolver(reader).resolve(reader.trailer["/Root"]["/OpenAction"])
                self.assertTrue(view["destinationResolved"])
                self.assertEqual(1, view["destinationPageNumber"])
                self.assertEqual(mode[1:], view["destinationView"])

    def test_direct_and_indirect_goto_actions_are_accepted(self):
        factories = (
            lambda w: goto(destination(w)),
            lambda w: goto(destination(w), **{"/Type": NameObject("/Action")}),
            lambda w: w._add_object(goto(destination(w))),
            lambda w: w._add_object(destination(w)),
        )
        for index, factory in enumerate(factories):
            with self.subTest(form=index):
                worker.open_pdf(with_opening_view(factory))

    def test_named_goto_actions_resolve_legacy_text_and_byte_names(self):
        for kind in ("legacy", "text", "bytes"):
            with self.subTest(kind=kind):
                reader = worker.open_pdf(with_opening_view(lambda w: named_view(w, kind)))
                resolved = resolver(reader).resolve(reader.trailer["/Root"]["/OpenAction"]["/D"])
                self.assertTrue(resolved["destinationResolved"])
                self.assertEqual(1, resolved["destinationPageNumber"])

    def test_missing_and_ambiguous_named_destinations_are_rejected(self):
        for kind in ("legacy", "text", "bytes"):
            with self.subTest(kind=kind):
                self.assert_rejected(with_opening_view(lambda w: named_view(w, kind, missing=True)))
        self.assert_rejected(with_opening_view(lambda w: named_view(w, "text", duplicate=True)))

    def test_invalid_explicit_destination_shape_or_coordinates_are_rejected(self):
        factories = (
            lambda w: ArrayObject(),
            lambda w: ArrayObject([w.pages[0].indirect_reference]),
            lambda w: destination(w, "/UnknownView"),
            lambda w: destination(w, "/Fit", [NumberObject(1)]),
            lambda w: destination(w, "/XYZ", [NumberObject(0), NumberObject(0)]),
            lambda w: destination(w, "/FitH", [TextStringObject("80")]),
            lambda w: destination(w, "/FitV", [BooleanObject(True)]),
            lambda w: destination(w, "/FitR", [NumberObject(0)] * 3 + [NullObject()]),
            lambda w: ArrayObject([w.pages[0].indirect_reference, TextStringObject("/Fit")]),
        )
        for index, factory in enumerate(factories):
            with self.subTest(case=index):
                self.assert_rejected(with_opening_view(factory))

    def test_destination_must_refer_to_a_real_page(self):
        factories = (
            lambda w: ArrayObject([NumberObject(0), NameObject("/Fit")]),
            lambda w: ArrayObject([w._add_object(DictionaryObject({NameObject("/Type"): NameObject("/Page")})), NameObject("/Fit")]),
            lambda w: ArrayObject([w.root_object["/Pages"].indirect_reference, NameObject("/Fit")]),
        )
        for index, factory in enumerate(factories):
            with self.subTest(case=index):
                self.assert_rejected(with_opening_view(factory))

    def test_direct_named_values_and_plain_destination_dictionaries_are_rejected(self):
        for value in (NameObject("/chapter"), TextStringObject("chapter"), NullObject(), NumberObject(0)):
            with self.subTest(value=repr(value)):
                self.assert_rejected(with_opening_view(lambda w: value))
        self.assert_rejected(with_opening_view(lambda w: DictionaryObject({NameObject("/D"): destination(w)})))

    def test_goto_cannot_chain_or_carry_unknown_action_properties(self):
        extras = (
            {"/Next": ArrayObject()},
            {"/Next": DictionaryObject({NameObject("/S"): NameObject("/JavaScript"), NameObject("/JS"): TextStringObject("app.alert('test')")})},
            {"/Type": NameObject("/NotAction")},
            {"/Unknown": TextStringObject("unrecognized behavior")},
        )
        for index, extra in enumerate(extras):
            with self.subTest(case=index):
                self.assert_rejected(with_opening_view(lambda w: goto(destination(w), **extra)))

    def test_other_opening_actions_remain_rejected(self):
        for action in ("JavaScript", "Launch", "GoToR", "GoToE", "URI", "Named", "SubmitForm", "ResetForm", "ImportData", "Rendition"):
            with self.subTest(action=action):
                self.assert_rejected(with_opening_view(lambda w: DictionaryObject({NameObject("/S"): NameObject("/" + action), NameObject("/D"): destination(w)})))

    def test_passive_opening_view_does_not_exempt_other_active_features(self):
        base = with_opening_view(lambda w: destination(w))
        mutations = (
            lambda w: w.root_object.__setitem__(NameObject("/AA"), DictionaryObject()),
            lambda w: w.root_object.__setitem__(NameObject("/OtherAction"), DictionaryObject({NameObject("/S"): NameObject("/JavaScript"), NameObject("/JS"): TextStringObject("app.alert('test')")})),
            lambda w: w.root_object.__setitem__(NameObject("/Names"), DictionaryObject({NameObject("/EmbeddedFiles"): DictionaryObject()})),
            lambda w: w.pages[0].__setitem__(NameObject("/OpenAction"), destination(w)),
            lambda w: w.root_object.__setitem__(NameObject("/Nested"), DictionaryObject({NameObject("/OpenAction"): destination(w)})),
        )
        for index, mutate in enumerate(mutations):
            with self.subTest(case=index):
                self.assert_rejected(modified(base, mutate))

    def test_saved_repair_preserves_opening_view_and_original_bytes(self):
        factories = {
            "explicit": lambda w: destination(w, "/XYZ", [NullObject(), NumberObject(80), NumberObject(0)]),
            "goto": lambda w: goto(destination(w, "/FitH", [NumberObject(80)])),
            "named": lambda w: named_view(w, "text"),
        }
        with tempfile.TemporaryDirectory() as folder:
            source = Path(folder) / "source.pdf"
            for kind, factory in factories.items():
                with self.subTest(kind=kind):
                    output = Path(folder) / f"{kind}.pdf"
                    data = with_opening_view(factory)
                    source.write_bytes(data)
                    original = worker.open_pdf(data)
                    tag = worker.enrich_inventory(original, original)["tags"][1]
                    plan = {"schemaVersion": 1, "candidateSha256": worker.digest(data), "operations": [
                        {"type": "set_role", "tagId": tag["id"], "expected": tag["snapshot"], "role": "H1"},
                    ]}
                    worker.apply_plan(original, original, plan, output)
                    repaired = worker.open_pdf(output.read_bytes())
                    self.assertEqual(data, source.read_bytes())
                    before = worker.verify_pdf.Canonicalizer(list(original.pages))
                    after = worker.verify_pdf.Canonicalizer(list(repaired.pages))
                    self.assertEqual(before.hash(original.trailer["/Root"]["/OpenAction"]), after.hash(repaired.trailer["/Root"]["/OpenAction"]))
                    report = worker.verify_pdf.compare_pdfs(source, output)
                    self.assertTrue(report["preservation"]["passed"], report["findings"])
                    self.assertTrue(all(page["pixels_identical"] for page in report["preservation"]["pages"]))

    def test_preservation_rejects_changed_initial_page_or_view(self):
        data = with_opening_view(lambda w: destination(w), extra_page=True)
        mutations = {
            "page": lambda w: w.root_object.__setitem__(NameObject("/OpenAction"), destination(w, page=1)),
            "view": lambda w: w.root_object.__setitem__(NameObject("/OpenAction"), destination(w, "/FitH", [NumberObject(80)])),
            "removed": lambda w: w.root_object.pop(NameObject("/OpenAction")),
        }
        with tempfile.TemporaryDirectory() as folder:
            source, output = Path(folder) / "source.pdf", Path(folder) / "output.pdf"
            source.write_bytes(data)
            for kind, mutate in mutations.items():
                with self.subTest(kind=kind):
                    output.write_bytes(modified(data, mutate))
                    report = worker.verify_pdf.compare_pdfs(source, output)
                    self.assertFalse(report["preservation"]["passed"])
                    self.assertIn("catalog_behavior_changed", [finding["code"] for finding in report["findings"]])


if __name__ == "__main__":
    unittest.main()
