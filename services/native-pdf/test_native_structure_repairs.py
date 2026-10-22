"""Content-ownership coverage and bounded native Note-ID repair tests."""
import io
from pathlib import Path
import sys
import unittest

from pypdf import PdfReader, PdfWriter
from pypdf.generic import (ArrayObject, ByteStringObject, DecodedStreamObject,
                          DictionaryObject, NameObject, NumberObject, TextStringObject)

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "research/native-pdf"))
import verify_pdf as v
from native_structure_repairs import (NoteIdError, note_id_snapshot, repair_note_ids,
    verify_note_ids, verify_authored_ids, authored_id_bindings, verify_authored_id_bindings)
from test_native_pdf_validation import pdf_bytes, native_form_reader

def serialized(writer):
    stream = io.BytesIO()
    writer.write(stream)
    return stream.getvalue()


def note_writer():
    writer = PdfWriter(clone_from=PdfReader(io.BytesIO(pdf_bytes(tagged=True))))
    nodes(writer)[1][NameObject("/S")] = NameObject("/Note")
    return writer


def nodes(writer):
    document = writer.root_object["/StructTreeRoot"]["/K"][0].get_object()
    return document, document["/K"][0].get_object()


def append_content(writer, extra):
    stream = DecodedStreamObject()
    stream.set_data(writer.pages[0].get_contents().get_data() + b"\n" + extra)
    writer.pages[0][NameObject("/Contents")] = writer._add_object(stream)


def codes(writer):
    return {finding["code"] for finding in v.structure_inventory(PdfReader(io.BytesIO(serialized(writer))))["findings"]}


class NoteIdTests(unittest.TestCase):
    def test_missing_note_id_is_reported_then_added_and_reopened(self):
        writer = note_writer()
        self.assertIn("missing_note_identifier", codes(writer))
        before = note_id_snapshot(writer)
        original = PdfReader(io.BytesIO(serialized(writer)))
        changes = repair_note_ids(writer)
        after = PdfReader(io.BytesIO(serialized(writer)))
        verify_note_ids(before, after)
        self.assertEqual([change["tagId"] for change in changes], ["tag-2"])
        self.assertNotIn("missing_note_identifier", codes(writer))
        self.assertEqual(original.pages[0].get_contents().get_data(), after.pages[0].get_contents().get_data())
        self.assertEqual(v.form_inventory(original), v.form_inventory(after))
        self.assertEqual(repair_note_ids(writer), [])

    def test_existing_id_bytes_and_mapping_preserved_with_collision(self):
        writer = note_writer()
        root = writer.root_object["/StructTreeRoot"]
        document, note = nodes(writer)
        existing = b"acccp-note-000002"
        document[NameObject("/ID")] = ByteStringObject(existing)
        leaf = DictionaryObject({NameObject("/Names"): ArrayObject([ByteStringObject(existing), document.indirect_reference]),
                                 NameObject("/Limits"): ArrayObject([ByteStringObject(existing), ByteStringObject(existing)])})
        root[NameObject("/IDTree")] = DictionaryObject({NameObject("/Kids"): ArrayObject([writer._add_object(leaf)])})
        before = note_id_snapshot(writer)
        repair_note_ids(writer)
        reopened = PdfReader(io.BytesIO(serialized(writer)))
        verify_note_ids(before, reopened)
        self.assertEqual(str(note["/ID"]), "acccp-note-000002-1")
        self.assertEqual(bytes(document["/ID"]), existing)
        self.assertEqual(len(v.structure_id_tree(reopened.trailer["/Root"]["/StructTreeRoot"])), 2)

    def test_mapped_note_is_supported(self):
        writer = note_writer()
        writer.root_object["/StructTreeRoot"][NameObject("/RoleMap")] = DictionaryObject({NameObject("/Footnote"): NameObject("/Note")})
        nodes(writer)[1][NameObject("/S")] = NameObject("/Footnote")
        before = note_id_snapshot(writer)
        self.assertEqual(len(repair_note_ids(writer)), 1)
        verify_note_ids(before, PdfReader(io.BytesIO(serialized(writer))))

    def test_preexisting_ids_are_not_overwritten(self):
        writer = note_writer()
        repair_note_ids(writer)
        before = serialized(writer)
        self.assertEqual(repair_note_ids(writer), [])
        self.assertEqual(before, serialized(writer))

    def test_ambiguous_existing_metadata_is_left_unchanged(self):
        mutations = [
            lambda w, root, doc, note: note.__setitem__(NameObject("/ID"), TextStringObject("")),
            lambda w, root, doc, note: doc.__setitem__(NameObject("/ID"), TextStringObject("unindexed")),
            lambda w, root, doc, note: root.__setitem__(NameObject("/IDTree"), DictionaryObject({NameObject("/Names"): ArrayObject([TextStringObject("orphan"), note.indirect_reference])})),
            lambda w, root, doc, note: root.__setitem__(NameObject("/IDTree"), DictionaryObject({NameObject("/Names"): ArrayObject(), NameObject("/PrivateMetadata"): TextStringObject("preserve")})),
            lambda w, root, doc, note: note.__setitem__(NameObject("/P"), root.indirect_reference),
            lambda w, root, doc, note: doc.__setitem__(NameObject("/K"), ArrayObject([note.indirect_reference, note.indirect_reference])),
        ]
        for mutate in mutations:
            with self.subTest(mutation=mutations.index(mutate)):
                writer = note_writer()
                doc, note = nodes(writer)
                mutate(writer, writer.root_object["/StructTreeRoot"], doc, note)
                before = serialized(writer)
                self.assertIsNone(note_id_snapshot(writer))
                self.assertEqual(repair_note_ids(writer), [])
                self.assertEqual(before, serialized(writer))

    def test_reopened_wrong_id_wrong_target_or_missing_tree_rejected(self):
        for mutation in ("id", "target", "tree", "role", "extra"):
            with self.subTest(mutation=mutation):
                writer = note_writer()
                before = note_id_snapshot(writer)
                repair_note_ids(writer)
                root = writer.root_object["/StructTreeRoot"]
                doc, note = nodes(writer)
                if mutation == "id":
                    note[NameObject("/ID")] = TextStringObject("incorrect")
                elif mutation == "target":
                    root["/IDTree"]["/Names"][1] = doc.indirect_reference
                elif mutation == "tree":
                    root.pop("/IDTree")
                elif mutation == "role":
                    note[NameObject("/S")] = NameObject("/P")
                else:
                    doc[NameObject("/ID")] = TextStringObject("unexpected")
                with self.assertRaises(NoteIdError):
                    verify_note_ids(before, PdfReader(io.BytesIO(serialized(writer))))

    def test_authored_id_owner_preserved_when_role_changes(self):
        writer = note_writer()
        repair_note_ids(writer)
        original = PdfReader(io.BytesIO(serialized(writer)))
        nodes(writer)[1][NameObject("/S")] = NameObject("/P")
        verify_authored_ids(original, PdfReader(io.BytesIO(serialized(writer))))

    def test_authored_id_removal_or_move_between_equal_content_owners_rejected(self):
        writer = note_writer()
        root = writer.root_object["/StructTreeRoot"]
        document, note = nodes(writer)
        document[NameObject("/ID")] = TextStringObject("authored-id")
        root[NameObject("/IDTree")] = DictionaryObject({NameObject("/Names"): ArrayObject([TextStringObject("authored-id"), document.indirect_reference])})
        original_bytes = serialized(writer)
        original = PdfReader(io.BytesIO(original_bytes))
        for action in ("remove", "move", "content"):
            with self.subTest(action=action):
                output = PdfWriter(clone_from=original)
                document, note = nodes(output)
                if action == "remove":
                    document.pop("/ID")
                    output.root_object["/StructTreeRoot"].pop("/IDTree")
                elif action == "move":
                    note[NameObject("/ID")] = document.pop("/ID")
                    output.root_object["/StructTreeRoot"]["/IDTree"]["/Names"][1] = note.indirect_reference
                else:
                    append_content(output, b"/P <</MCID 1>> BDC BT /F1 12 Tf 20 20 Td (Different content) Tj ET EMC")
                    note[NameObject("/K")] = NumberObject(1)
                    output.root_object["/StructTreeRoot"]["/ParentTree"]["/Nums"][1].append(note.indirect_reference)
                with self.assertRaises(NoteIdError):
                    verify_authored_ids(original, PdfReader(io.BytesIO(serialized(output))))

    def test_new_note_ids_without_authored_ids_are_allowed(self):
        writer = note_writer()
        original = PdfReader(io.BytesIO(serialized(writer)))
        repair_note_ids(writer)
        verify_authored_ids(original, PdfReader(io.BytesIO(serialized(writer))))

    def test_untagged_original_has_no_authored_ids_to_preserve(self):
        writer = note_writer()
        repair_note_ids(writer)
        verify_authored_ids(PdfReader(io.BytesIO(pdf_bytes())), PdfReader(io.BytesIO(serialized(writer))))

    def test_unrelated_sibling_insertion_preserves_authored_id_owner(self):
        writer = note_writer()
        repair_note_ids(writer)
        original = PdfReader(io.BytesIO(serialized(writer)))
        bindings = authored_id_bindings(writer)
        doc, note = nodes(writer)
        sibling = DictionaryObject({NameObject("/Type"): NameObject("/StructElem"), NameObject("/S"): NameObject("/P"), NameObject("/P"): doc.indirect_reference})
        doc["/K"].insert(0, writer._add_object(sibling))
        verify_authored_id_bindings(bindings, writer)
        verify_authored_ids(original, PdfReader(io.BytesIO(serialized(writer))))

    def test_replacing_native_id_owner_with_clone_rejected_before_save(self):
        writer = note_writer()
        repair_note_ids(writer)
        bindings = authored_id_bindings(writer)
        doc, note = nodes(writer)
        replacement = DictionaryObject(note)
        replacement_ref = writer._add_object(replacement)
        doc["/K"][0] = replacement_ref
        root = writer.root_object["/StructTreeRoot"]
        root["/IDTree"]["/Names"][1] = replacement_ref
        root["/ParentTree"]["/Nums"][1][0] = replacement_ref
        with self.assertRaises(NoteIdError):
            verify_authored_id_bindings(bindings, writer)

    def test_read_only_bindings_preserve_unknown_id_index_metadata(self):
        writer = note_writer()
        repair_note_ids(writer)
        index = writer.root_object["/StructTreeRoot"]["/IDTree"]
        index[NameObject("/PrivateMetadata")] = TextStringObject("retain")
        bindings = authored_id_bindings(writer)
        self.assertIsNone(note_id_snapshot(writer))
        self.assertEqual(repair_note_ids(writer), [])
        verify_authored_id_bindings(bindings, writer)
        self.assertEqual(index["/PrivateMetadata"], "retain")


class ContentOwnershipTests(unittest.TestCase):
    def test_artifact_and_literal_empty_scope_do_not_need_tag_owners(self):
        writer = note_writer()
        append_content(writer, b"/Artifact <</MCID 1>> BDC 10 10 m 50 10 l S EMC\n/Content <</MCID 2>> BDC EMC")
        inventory = v.structure_inventory(PdfReader(io.BytesIO(serialized(writer))))
        self.assertEqual(inventory["page_content"][0]["mcids"], [0, 1, 2])
        self.assertEqual(inventory["page_content"][0]["ownership_required_mcids"], [0])
        self.assertNotIn("unowned_marked_content", {x["code"] for x in inventory["findings"]})

    def test_artifact_text_still_requires_semantic_review(self):
        writer = note_writer()
        append_content(writer, b"/Artifact <</MCID 1>> BDC BT /F1 12 Tf 10 10 Td (Meaningful text) Tj ET EMC")
        self.assertIn("artifact_text_needs_semantic_review", codes(writer))
        self.assertNotIn("unowned_marked_content", codes(writer))

    def test_real_untagged_text_graphics_and_semantic_properties_still_fail(self):
        examples = [
            b"/Content <</MCID 1>> BDC BT /F1 12 Tf 10 10 Td (Excluded text) Tj ET EMC",
            b"/Figure <</MCID 1>> BDC 10 10 m 50 10 l S EMC",
            b"/Content <</MCID 1 /ActualText (Accessible text)>> BDC EMC",
            b"/Artifact <</MCID 1 /ActualText (Accessible text)>> BDC EMC",
            b"/Content <</MCID 1 /Unknown true>> BDC EMC",
            b"/Span <</ActualText (Accessible text)>> BDC /Content <</MCID 1>> BDC EMC EMC",
            b"/Content <</MCID 1>> BDC q Q EMC",
        ]
        for extra in examples:
            with self.subTest(extra=extra):
                writer = note_writer()
                append_content(writer, extra)
                self.assertIn("unowned_marked_content", codes(writer))

    def test_duplicate_artifact_and_empty_mcids_still_fail(self):
        for extra in (b"/Artifact <</MCID 0>> BDC EMC", b"/Content <</MCID 0>> BDC EMC"):
            writer = note_writer()
            append_content(writer, extra)
            self.assertIn("duplicate_mcid", codes(writer))

    def test_named_properties_and_ancestor_artifact(self):
        writer = note_writer()
        writer.pages[0]["/Resources"][NameObject("/Properties")] = DictionaryObject({NameObject("/Empty"): DictionaryObject({NameObject("/MCID"): NumberObject(1)})})
        append_content(writer, b"/Content /Empty BDC EMC\n/Artifact BMC /Span <</MCID 2>> BDC 1 1 m 5 1 l S EMC EMC")
        self.assertNotIn("unowned_marked_content", codes(writer))

    def test_unbalanced_and_nested_marked_content_still_fail(self):
        writer = note_writer()
        append_content(writer, b"/Content <</MCID 1>> BDC /Content <</MCID 2>> BDC EMC")
        findings = codes(writer)
        self.assertIn("nested_mcid_scope_unsupported", findings)
        self.assertIn("unbalanced_marked_content", findings)

    def test_form_xobject_artifact_and_empty_scopes_do_not_hide_real_content(self):
        for extra, expected_unowned in ((b"/Artifact <</MCID 1>> BDC 1 1 m 5 1 l S EMC /Content <</MCID 2>> BDC EMC", False),
                                         (b"/Content <</MCID 1>> BDC 1 1 m 5 1 l S EMC", True)):
            writer = PdfWriter(clone_from=native_form_reader())
            form = next(iter(writer.pages[0]["/Resources"]["/XObject"].values())).get_object()
            form.set_data(form.get_data() + b"\n" + extra)
            self.assertEqual("unowned_form_marked_content" in codes(writer), expected_unowned)


if __name__ == "__main__":
    unittest.main()
