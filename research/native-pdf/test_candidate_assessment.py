"""Regression checks for false conformance claims and stale evidence."""
from copy import deepcopy
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch
from types import SimpleNamespace

from assess_candidate import assess_candidate, assess_evidence, validation_result


class CandidateAssessmentTests(unittest.TestCase):
    def setUp(self):
        self.checks = {"passed": True, "mechanical_checks_passed": True, "preservation": {"passed": True, "pages": [{"page": 1}]}, "structure": {"checks_complete": True, "authored_alternative_associations_verified": True, "tags": [{"id": "tag-1"}]}}
        self.validation = {"complete": True, "passed": True}
        self.audit = {"status": "complete", "sourceSha256": "source", "outputSha256": "output", "machineFindingsRetained": True, "reviewedPages": [1], "reviewedTagIds": ["tag-1"], "findings": []}

    def assess(self):
        return assess_evidence(self.checks, self.validation, self.audit, "source", "output")

    def test_automated_success_still_requires_human_checkpoints(self):
        result = self.assess()
        self.assertTrue(result["automatedChecksPassed"])
        self.assertFalse(result["standardConformanceEstablished"])
        self.assertFalse(result["readyForApp"])
        self.assertEqual(result["manualReview"]["status"], "required")

    def test_changed_output_invalidates_audit(self):
        self.audit["outputSha256"] = "old output"
        self.assertIn("semantic_audit_missing_stale_or_incomplete", self.assess()["blockers"])

    def test_verified_appendix_still_needs_every_new_page_reviewed(self):
        self.checks['appendix_validation']={'passed':True}
        self.checks['structure']['page_content']=[{'pageNumber':1},{'pageNumber':2}]
        self.assertIn('semantic_audit_missing_stale_or_incomplete',self.assess()['blockers'])
        self.audit['reviewedPages']=[1,2]
        self.assertTrue(self.assess()['automatedChecksPassed'])
        self.checks['structure']['page_content']=[{'pageNumber':1},{'pageNumber':3}]
        self.assertIn('appendix_page_coverage_incomplete',self.assess()['blockers'])

    def test_different_original_invalidates_audit(self):
        self.audit["sourceSha256"] = "another source"
        self.assertFalse(self.assess()["automatedChecksPassed"])

    def test_scanned_text_requires_independent_exact_page_review(self):
        self.checks['ocr_validation']={'passed':True,'requiredAuditPages':[1]}
        self.assertFalse(self.assess()['automatedChecksPassed'])
        self.audit['ocrReviews']=[{'pageNumber':1,'decision':'matches-visible-page','textOnly':True,'explanation':'Every saved line agrees with the original visible page, including the date and quantity.'}]
        self.assertTrue(self.assess()['automatedChecksPassed'])
        for key,value in [('decision','uncertain'),('decision','incorrect-or-incomplete'),('textOnly',False),('pageNumber',2),('explanation','')]:
            before=deepcopy(self.audit['ocrReviews'])
            self.audit['ocrReviews'][0][key]=value
            self.assertFalse(self.assess()['automatedChecksPassed'])
            self.audit['ocrReviews']=before
        self.checks['ocr_validation']['requiredAuditPages']=[]
        self.assertFalse(self.assess()['automatedChecksPassed'])

    def test_scan_review_cannot_override_failed_native_text_validation(self):
        self.checks['ocr_validation']={'passed':False,'requiredAuditPages':[1]}
        self.audit['ocrReviews']=[{'pageNumber':1,'decision':'matches-visible-page','textOnly':True,'explanation':'Agrees.'}]
        self.assertFalse(self.assess()['automatedChecksPassed'])

    def test_clean_audit_cannot_override_incomplete_form_evidence(self):
        for kind in ('form_label_validation','form_order_validation'):
            for evidence in ({'passed':False,'checksComplete':True},
                             {'passed':True,'checksComplete':False},
                             {'passed':True,'checksComplete':True,'reviewItems':[{'code':'ambiguous_control'}]},
                             {'passed':True,'checksComplete':True,'findings':[{'severity':'error'}]}):
                with self.subTest(kind=kind,evidence=evidence):
                    self.checks[kind]=evidence
                    self.assertIn(kind+'_not_passed',self.assess()['blockers'])
                    del self.checks[kind]
            self.checks[kind]={'passed':True,'checksComplete':True,'reviewItems':[],'findings':[]}
            self.assertTrue(self.assess()['automatedChecksPassed'])
            del self.checks[kind]

    def test_missing_or_partial_audit_blocks(self):
        for key, value in [("reviewedPages", []), ("reviewedTagIds", []), ("reviewedTagIds", ["tag-1", "tag-1"]), ("status", "incomplete"), ("findings", None), ("machineFindingsRetained", False), ("reviewedPages", [True])]:
            with self.subTest(key=key, value=value):
                audit = deepcopy(self.audit)
                audit[key] = value
                result = assess_evidence(self.checks, self.validation, audit, "source", "output")
                self.assertFalse(result["automatedChecksPassed"])

    def test_even_warning_is_unresolved(self):
        self.audit["findings"] = [{"severity": "warning"}]
        self.assertIn("semantic_accessibility_findings_unresolved", self.assess()["blockers"])

    def test_validator_success_cannot_override_lost_description(self):
        self.checks["structure"]["authored_alternative_associations_verified"] = False
        self.assertIn("authored_descriptions_not_verified_on_original_figures", self.assess()["blockers"])

    def test_semantic_success_cannot_override_machine_failures(self):
        self.validation["passed"] = False
        self.assertIn("pdfua1_machine_requirements_not_met", self.assess()["blockers"])

    def test_incomplete_inspection_never_passes(self):
        self.checks["inspection_incomplete"] = True
        self.assertFalse(self.assess()["automatedChecksPassed"])

    def test_artifact_warning_requires_explicit_content_review(self):
        self.checks["passed"] = False
        self.checks["structure"]["findings"] = [{"code": "artifact_text_needs_semantic_review", "severity": "warning", "page": 1}]
        self.checks["structure"]["page_content"] = [{"pageNumber": 1, "artifact_text_operators": 1, "artifactText": "Page 1", "artifactTextComplete": True}]
        self.assertFalse(self.assess()["automatedChecksPassed"])
        self.audit["artifactReviews"] = [{"pageNumber": 1, "decision": "decorative-or-redundant", "explanation": "Only the redundant page number is excluded."}]
        self.assertTrue(self.assess()["automatedChecksPassed"])
        self.checks["structure"]["page_content"][0]["artifactTextComplete"] = False
        self.assertFalse(self.assess()["automatedChecksPassed"])

    def test_other_machine_warnings_cannot_be_dismissed_by_audit(self):
        self.checks["structure"]["findings"] = [{"code": "unknown_coverage", "severity": "warning"}]
        self.assertFalse(self.assess()["automatedChecksPassed"])

    def test_form_only_artifact_text_requires_its_own_review(self):
        self.checks["structure"]["findings"] = [{"code": "artifact_text_needs_semantic_review", "severity": "warning", "page": 1}]
        self.checks["structure"]["page_content"] = [{"pageNumber": 1, "artifact_text_operators": 0, "form_artifact_text_operators": 1, "artifactText": "Page 1", "artifactTextComplete": True}]
        self.assertFalse(self.assess()["automatedChecksPassed"])
        self.audit["artifactReviews"] = [{"pageNumber": 1, "decision": "decorative-or-redundant", "explanation": "The footer Form contains only the redundant page number."}]
        self.assertTrue(self.assess()["automatedChecksPassed"])
        self.checks["structure"]["page_content"][0]["artifactTextComplete"] = False
        self.assertFalse(self.assess()["automatedChecksPassed"])

    def test_artifact_warning_without_corresponding_evidence_never_passes(self):
        self.checks["structure"]["findings"] = [{"code": "artifact_text_needs_semantic_review", "severity": "warning", "page": 1}]
        self.audit["artifactReviews"] = []
        result = self.assess()
        self.assertFalse(result["automatedChecksPassed"])
        self.assertIn("excluded_text_not_verified_as_decorative_or_redundant", result["blockers"])
        self.checks["structure"]["page_content"] = [{"pageNumber": 2, "artifact_text_operators": 1, "artifactText": "Page 2", "artifactTextComplete": True}]
        self.audit["artifactReviews"] = [{"pageNumber": 2, "decision": "decorative-or-redundant", "explanation": "Page number."}]
        self.assertFalse(self.assess()["automatedChecksPassed"])

    def test_validation_profile_file_and_completion_are_required(self):
        with TemporaryDirectory() as temporary:
            candidate = Path(temporary) / "candidate.pdf"
            candidate.write_bytes(b"test")
            result = {"jobEndStatus": "normal", "profileName": "PDF/UA-1 validation profile", "compliant": True, "details": {"failedRules": 0, "failedChecks": 0, "passedRules": 100, "passedChecks": 500, "ruleSummaries": []}}
            raw = {"report": {"jobs": [{"itemDetails": {"name": str(candidate), "size": 4}, "validationResult": [result]}], "batchSummary": {"totalJobs": 1, "validationSummary": {"successfulJobCount": 1, "failedJobCount": 0}}}}
            self.assertTrue(validation_result(raw, candidate)["passed"])
            for field, value in [("profileName", "PDF/A-1b validation profile"), ("jobEndStatus", "aborted")]:
                bad = deepcopy(raw)
                bad["report"]["jobs"][0]["validationResult"][0][field] = value
                self.assertFalse(validation_result(bad, candidate)["complete"])
            bad = deepcopy(raw)
            bad["report"]["jobs"][0]["itemDetails"]["name"] = str(candidate.with_name("other.pdf"))
            self.assertFalse(validation_result(bad, candidate)["complete"])
            bad = deepcopy(raw)
            bad["report"]["jobs"][0]["validationResult"][0]["details"]["ruleSummaries"] = [{"status": "failed", "failedChecks": 1}]
            self.assertFalse(validation_result(bad, candidate)["passed"])
            self.assertFalse(validation_result({}, candidate)["complete"])

    def test_exit_one_is_completed_failed_validation_not_missing_evidence(self):
        with TemporaryDirectory() as temporary:
            directory = Path(temporary)
            source, candidate = directory / "source.pdf", directory / "candidate.pdf"
            source.write_bytes(b"source")
            candidate.write_bytes(b"candidate")
            validation = {"complete": True, "passed": False, "failedRules": 1, "failedChecks": 2}
            with patch("assess_candidate.compare_pdfs", return_value=self.checks), patch("assess_candidate.run_tool", return_value=SimpleNamespace(returncode=1, stdout=b'{}')), patch("assess_candidate.validation_result", return_value=validation):
                result = assess_candidate(source, candidate, {"veraPdf": {}}, directory / "assessment")
            self.assertTrue(result["pdfua1MachineValidation"]["complete"])
            self.assertIn("pdfua1_machine_requirements_not_met", result["blockers"])
            self.assertTrue((directory / "assessment" / "verapdf-ua1.json").is_file())

    def test_file_change_during_validation_invalidates_all_results(self):
        with TemporaryDirectory() as temporary:
            directory = Path(temporary)
            source, candidate = directory / "source.pdf", directory / "candidate.pdf"
            source.write_bytes(b"source")
            candidate.write_bytes(b"candidate")
            def changed(*args):
                candidate.write_bytes(b"changed")
                return SimpleNamespace(returncode=0, stdout=b'{}')
            with patch("assess_candidate.compare_pdfs", return_value=self.checks), patch("assess_candidate.run_tool", side_effect=changed), patch("assess_candidate.validation_result", return_value=self.validation):
                result = assess_candidate(source, candidate, {"veraPdf": {}}, directory / "assessment")
            self.assertIn("input_changed_during_assessment", result["blockers"])
            self.assertFalse(result["automatedChecksPassed"])


if __name__ == "__main__":
    unittest.main()
