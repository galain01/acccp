"""Do not confuse native evidence or a filled form with an executed AT test."""
from copy import deepcopy
from hashlib import sha256
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from manual_review import CHECKPOINTS, build_pack, native_sequence, recorded_review_status
from test_native_pdf_validation import pdf_bytes


class ManualReviewTests(unittest.TestCase):
    def pack(self):
        with TemporaryDirectory() as directory:
            path = Path(directory) / "fixture.pdf"
            data = pdf_bytes(tagged=True)
            path.write_bytes(data)
            result = build_pack(path, sha256(data).hexdigest())
            self.assertEqual(data, path.read_bytes())
            return result

    def test_native_inspection_never_marks_human_test_performed(self):
        pack = self.pack()
        self.assertEqual("not_run", pack["reviewStatus"])
        self.assertFalse(pack["screenReaderTestPerformed"])
        self.assertFalse(pack["standardConformanceEstablished"])
        self.assertTrue(all(item["status"] == "not_run" for item in pack["checks"]))
        self.assertTrue(pack["machineEvidence"]["mechanicalChecksPassed"])

    def test_wrong_file_hash_refused(self):
        with TemporaryDirectory() as directory:
            path = Path(directory) / "fixture.pdf"
            path.write_bytes(pdf_bytes(tagged=True))
            with self.assertRaisesRegex(ValueError, "candidate_identity_mismatch"):
                build_pack(path, "a" * 64)

    def test_exact_child_order_overrides_inventory_order_and_aggregate_text(self):
        part = lambda text: {"kind": "markedContent", "resolved": True, "text": text, "pageNumber": 1, "mcid": 0}
        inventory = {"tags": [
            {"id": "p", "parentId": None, "role": "P", "text": "misleading aggregate", "contentSequence": [part("before"), {"kind": "childTag", "tagId": "s", "resolved": True}, part("after")]},
            {"id": "s", "parentId": "p", "role": "Span", "actualText": "\u00ad", "contentSequence": [part("-")]},
        ]}
        evidence = native_sequence(inventory)
        self.assertEqual(["before", "-", "after"], [item["text"] for item in evidence if item["kind"] == "markedContent"])
        self.assertEqual("\u00ad", evidence[2]["actualText"])
        self.assertNotIn("misleading aggregate", str(evidence))

    def test_unresolved_or_unreachable_evidence_refused(self):
        for tags in ([{"id": "s", "parentId": "absent", "role": "Span", "contentSequence": []}], [{"id": "p", "parentId": None, "role": "P", "contentSequence": [{"kind": "markedContent", "resolved": False}]}]):
            with self.assertRaises(ValueError):
                native_sequence({"tags": tags})

    def test_manual_record_remains_incomplete_without_observations(self):
        pack = self.pack()
        for check in pack["checks"]:
            check["status"] = "pass"
        self.assertFalse(recorded_review_status(pack, pack["document"]["sha256"])["recordedChecksPassed"])

    def test_complete_record_does_not_establish_conformance_or_execution(self):
        pack = self.pack()
        for key in pack["session"]:
            pack["session"][key] = "Tester supplied value"
        for check in pack["checks"]:
            check.update(status="pass", observed="Tester recorded actual behavior.")
        result = recorded_review_status(pack, pack["document"]["sha256"])
        self.assertTrue(result["recordedChecksPassed"])
        self.assertFalse(result["screenReaderExecutionVerifiedByCode"])
        self.assertFalse(result["standardConformanceEstablished"])
        self.assertFalse(result["readyForApp"])
        for outcome in ("not_run", "unable", "fail"):
            edited = deepcopy(pack)
            edited["checks"][0]["status"] = outcome
            self.assertFalse(recorded_review_status(edited, edited["document"]["sha256"])["recordedChecksPassed"])

    def test_stale_identity_or_missing_checkpoint_refused(self):
        pack = self.pack()
        with self.assertRaisesRegex(ValueError, "stale_manual_review"):
            recorded_review_status(pack, "b" * 64)
        pack["checks"].pop()
        with self.assertRaisesRegex(ValueError, "coverage_changed"):
            recorded_review_status(pack, pack["document"]["sha256"])


if __name__ == "__main__":
    unittest.main()
