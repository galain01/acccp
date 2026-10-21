"""Assess an exact saved candidate against PDF/UA-1 and preservation evidence.

This local gate cannot certify human checkpoints. It never turns a missing or
stale audit, an incomplete inspection, or a different validation profile into
success. Run it again after every candidate edit.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import sys

from evaluate import REPO, run_tool
from verify_pdf import compare_pdfs

STANDARD = {"name": "PDF/UA-1", "specification": "ISO 14289-1:2014", "validatorProfile": "ua1"}
MAX_REPORT_BYTES = 16 * 1024 * 1024


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def validation_result(raw: dict, candidate: Path) -> dict:
    """Require one completed UA1 result for this exact requested file."""
    try:
        report = raw["report"]
        jobs = report["jobs"]
        if len(jobs) != 1 or Path(jobs[0]["itemDetails"]["name"]).resolve() != candidate.resolve():
            raise ValueError("validator_file_mismatch")
        if jobs[0]["itemDetails"]["size"] != candidate.stat().st_size:
            raise ValueError("validator_file_size_mismatch")
        results = jobs[0]["validationResult"]
        if len(results) != 1:
            raise ValueError("validator_result_count")
        result = results[0]
        details = result["details"]
        if result.get("jobEndStatus") != "normal" or result.get("profileName") != "PDF/UA-1 validation profile":
            raise ValueError("validator_profile_or_completion")
        for key in ("failedRules", "failedChecks", "passedRules", "passedChecks"):
            if type(details.get(key)) is not int or details[key] < 0:
                raise ValueError("validator_counts_missing")
        if details["passedRules"] == 0 or details["passedChecks"] == 0:
            raise ValueError("validator_empty")
        summary = report["batchSummary"]
        if summary.get("totalJobs") != 1 or any(summary.get(key, 0) != 0 for key in ("outOfMemory", "veraExceptions", "failedEncryptedJobs", "failedParsingJobs")):
            raise ValueError("validator_batch_failed")
        jobs_summary = summary["validationSummary"]
        if jobs_summary.get("successfulJobCount") != 1 or jobs_summary.get("failedJobCount") != 0:
            raise ValueError("validator_job_failed")
        failed_rules = [rule for rule in details.get("ruleSummaries", []) if rule.get("ruleStatus") == "FAILED" or rule.get("status") == "failed" or rule.get("failedChecks", 0) > 0]
        passed = result.get("compliant") is True and details["failedRules"] == 0 and details["failedChecks"] == 0 and not failed_rules
        return {"complete": True, "passed": passed, "failedRules": details["failedRules"], "failedChecks": details["failedChecks"], "rules": [{"specification": rule.get("specification"), "clause": rule.get("clause"), "testNumber": rule.get("testNumber"), "failedChecks": rule.get("failedChecks"), "description": rule.get("description")} for rule in failed_rules]}
    except (KeyError, TypeError, IndexError, AttributeError, ValueError):
        return {"complete": False, "passed": False, "reason": "missing_mismatched_or_incomplete_ua1_validation"}


def assess_evidence(checks: dict, validation: dict, audit: dict | None, source_hash: str, output_hash: str) -> dict:
    blockers: list[str] = []
    structure = checks.get("structure", {})
    if checks.get("inspection_incomplete") or structure.get("checks_complete") is not True:
        blockers.append("independent_inspection_incomplete")
    if checks.get("preservation", {}).get("passed") is not True:
        blockers.append("source_content_or_appearance_not_preserved")
    if structure.get("authored_alternative_associations_verified") is not True:
        blockers.append("authored_descriptions_not_verified_on_original_figures")
    machine_findings = [*checks.get("findings", []), *structure.get("findings", [])]
    unresolved_machine_findings = [finding for finding in machine_findings if not (finding.get("code") == "artifact_text_needs_semantic_review" and finding.get("severity") == "warning")]
    if checks.get("mechanical_checks_passed") is not True or unresolved_machine_findings:
        blockers.append("independent_machine_checks_not_passed")
    if validation.get("complete") is not True:
        blockers.append("pdfua1_validation_incomplete")
    elif validation.get("passed") is not True:
        blockers.append("pdfua1_machine_requirements_not_met")
    expected_pages = list(range(1, len(checks.get("preservation", {}).get("pages", [])) + 1))
    expected_tags = [tag.get("id") for tag in structure.get("tags", [])]

    def exact(actual, expected, allow_empty=False):
        return isinstance(actual, list) and (bool(expected) or allow_empty) and len(actual) == len(expected) and all(type(a) is type(b) and a == b for a, b in zip(sorted(actual, key=str), sorted(expected, key=str)))

    audit_complete = bool(isinstance(audit, dict) and audit.get("status") == "complete" and audit.get("sourceSha256") == source_hash and audit.get("outputSha256") == output_hash and audit.get("machineFindingsRetained") is True and exact(audit.get("reviewedPages"), expected_pages) and exact(audit.get("reviewedTagIds"), expected_tags) and isinstance(audit.get("findings"), list))
    if not audit_complete:
        blockers.append("semantic_audit_missing_stale_or_incomplete")
    elif audit["findings"]:
        blockers.append("semantic_accessibility_findings_unresolved")
    artifact_pages = [page for page in structure.get("page_content", []) if page.get("artifact_text_operators", 0) + page.get("form_artifact_text_operators", 0) > 0]
    # An exemption for reviewable Artifact warnings needs the actual excluded
    # text evidence. Missing evidence cannot turn into an empty review checklist.
    artifact_warning_pages = [finding.get("page") for finding in machine_findings if finding.get("code") == "artifact_text_needs_semantic_review" and finding.get("severity") == "warning"]
    artifact_evidence_covers_warnings = all(type(page_number) is int and any(type(page.get("pageNumber")) is int and page["pageNumber"] == page_number for page in artifact_pages) for page_number in artifact_warning_pages)
    artifact_reviews = audit.get("artifactReviews", []) if audit_complete else []
    artifact_coverage = isinstance(artifact_reviews, list) and all(isinstance(review, dict) for review in artifact_reviews) and exact([review.get("pageNumber") for review in artifact_reviews], [page.get("pageNumber") for page in artifact_pages], allow_empty=True)
    if not artifact_evidence_covers_warnings or not artifact_coverage or any(page.get("artifactTextComplete") is not True for page in artifact_pages) or any(review.get("decision") != "decorative-or-redundant" or not isinstance(review.get("explanation"), str) or not review["explanation"].strip() for review in artifact_reviews):
        blockers.append("excluded_text_not_verified_as_decorative_or_redundant")
    return {
        "standard": STANDARD,
        "status": "blocked" if blockers else "automated_checks_passed_manual_review_required",
        "sourceSha256": source_hash,
        "outputSha256": output_hash,
        "automatedChecksPassed": not blockers,
        "standardConformanceEstablished": False,
        "readyForApp": False,
        "blockers": blockers,
        "pdfua1MachineValidation": validation,
        "semanticAudit": {"complete": audit_complete, "unresolvedFindings": len(audit["findings"]) if audit_complete else None},
        "manualReview": {"status": "required", "basis": "Matterhorn Protocol 1.1 human checkpoints", "areas": ["Meaningful content and decorative content are correctly distinguished.", "Reading order, headings, lists and table relationships convey the source meaning.", "Image descriptions and text alternatives convey the necessary information.", "Language, links, interactive features and visual information are usable with assistive technology."]},
    }


def assess_candidate(source: Path, candidate: Path, toolchain: dict, folder: Path, audit_path: Path | None = None, font_manifest_path: Path | None = None) -> dict:
    source, candidate, folder = source.resolve(strict=True), candidate.resolve(strict=True), folder.resolve()
    if source == candidate or folder.exists() or folder.is_relative_to(REPO):
        raise ValueError("immutable_inputs_and_new_external_report_directory_required")
    folder.mkdir(parents=True)
    source_hash, output_hash = sha256(source), sha256(candidate)
    if font_manifest_path is None:
        checks = compare_pdfs(source, candidate)
    else:
        from font_validation import compare_with_authorized_fonts, MAX_MANIFEST_BYTES
        if font_manifest_path.stat().st_size > MAX_MANIFEST_BYTES:
            raise ValueError("font_manifest_too_large")
        checks = compare_with_authorized_fonts(source, candidate, json.loads(font_manifest_path.read_text(encoding="utf-8-sig")))
    (folder / "independent-checks.json").write_text(json.dumps(checks, ensure_ascii=True, indent=2), encoding="utf-8")
    validation = {"complete": False, "passed": False, "reason": "validator_unavailable"}
    try:
        process = run_tool(toolchain["veraPdf"], ["--flavour", "ua1", "--format", "json", str(candidate)])
        # veraPDF uses exit 1 for a completed nonconformant result.
        if process.returncode in (0, 1) and len(process.stdout) <= MAX_REPORT_BYTES:
            raw = json.loads(process.stdout)
            validation = validation_result(raw, candidate)
            if process.returncode == 1 and validation.get("passed"):
                validation = {"complete": False, "passed": False, "reason": "validator_exit_status_conflicts_with_report"}
            (folder / "verapdf-ua1.json").write_text(json.dumps(raw, ensure_ascii=True, indent=2), encoding="utf-8")
    except Exception:
        pass
    audit = None
    if audit_path is not None:
        try:
            if audit_path.stat().st_size <= MAX_REPORT_BYTES:
                audit = json.loads(audit_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            pass
    result = assess_evidence(checks, validation, audit, source_hash, output_hash)
    if (sha256(source), sha256(candidate)) != (source_hash, output_hash):
        result["blockers"].append("input_changed_during_assessment")
        result.update(status="blocked", automatedChecksPassed=False)
    (folder / "assessment.json").write_text(json.dumps(result, ensure_ascii=True, indent=2), encoding="utf-8")
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("candidate", type=Path)
    parser.add_argument("--toolchain", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--audit", type=Path)
    parser.add_argument("--font-manifest", type=Path)
    args = parser.parse_args()
    result = assess_candidate(args.source, args.candidate, json.loads(args.toolchain.read_text(encoding="utf-8-sig")), args.output, args.audit, args.font_manifest)
    print(json.dumps({"status": result["status"], "blockers": result["blockers"], "standardConformanceEstablished": False}))
    return 0 if result["automatedChecksPassed"] else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        print(json.dumps({"status": "assessment_incomplete", "standardConformanceEstablished": False}))
        sys.exit(2)
