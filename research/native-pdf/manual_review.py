"""Build a local, hash-bound human review pack; never simulate screen-reader use.

The native sequence is evidence from the PDF objects, not a transcript of any
PDF viewer's accessibility API or a prediction of speech output.
"""
from __future__ import annotations

import argparse
from copy import deepcopy
from hashlib import sha256
import io
import json
from pathlib import Path
import re

from pypdf import PdfReader

from verify_pdf import structure_inventory


MAX_PDF_BYTES = 32 * 1024 * 1024
MAX_PACK_BYTES = 8 * 1024 * 1024
MAX_TAGS = 10000
MAX_EVENTS = 60000

CHECKPOINTS = (
    ("open-and-identify", "Open the exact reviewed file", "Record the PDF viewer, screen reader, versions, keyboard mode, language, voice and reading preferences. Confirm the title and page count. If the viewer proposes OCR or automatic tagging, record it and do not use that transformed view as proof about this file."),
    ("continuous-reading", "Listen through the complete document", "Read every page, including the added description page. Check columns, captions, footnotes and page transitions against the visible source. Record missing, repeated or misplaced passages and whether source page changes are understandable."),
    ("headings", "Navigate by headings", "Use heading navigation and the heading list. Confirm the title, section hierarchy and description appendix can be found and understood. A tag inventory is a reference; record what the screen reader actually exposes."),
    ("table-navigation", "Read table relationships", "Enter each table and navigate horizontally and vertically. Sample every header pattern and category, first/last rows, spanning headers and rows on both sides of page breaks. Record the value plus every spoken row, year, statistic and category label. Missing or misleading relationships are failures even if the table was announced."),
    ("links-and-focus", "Follow links using the keyboard", "Traverse focus forward and backward. Compare spoken link labels and targets with the source meaning; activate each distinct repaired destination and return to the PDF. Check wrapped URLs do not become confusing duplicate links, and that focus remains usable."),
    ("figures-and-descriptions", "Understand every meaningful graphic", "Navigate to each graphic and listen to its alternative. Find the detailed description from the normal reading sequence and heading navigation. A reviewer should answer the same substantive questions using the description as using the graphic, including units, groups, missing data and uncertainty. Record any unsupported detail or omission."),
    ("lists-and-continuations", "Check lists and interrupted paragraphs", "Verify list boundaries and name-to-role associations. Listen across cross-page paragraphs and content interrupted visually by a table or figure. Words and ideas must remain complete; record the actual reading sequence rather than judging only raw extracted line breaks."),
    ("text-and-language", "Check text, symbols and pronunciation", "Inspect selected text word by word and, when ambiguous, character by character. Check names, soft hyphens, ligatures, mathematical signs, percentages and language changes. Separate a voice pronunciation choice from wrong characters or missing words; record the reader's exposed text when available."),
    ("excluded-content", "Check what was omitted from reading", "Compare every page with the spoken content. Repeated running furniture may be silent, but directions, table notes, captions, disclaimers and other meaningful content must remain available. The machine's Artifact excerpts identify exclusions to review."),
    ("visual-usability", "Check magnification and contrast", "Use the viewer's zoom and reflow options where supported. Check clipping, overlap, legibility, meaningful color differences and contrast against the intended accessibility requirements. Record viewer limitations separately from document defects; a reflow failure is not by itself proof of a broken tag tree."),
    ("viewer-cross-check", "Try the critical tasks in a second viewer", "Repeat heading, table, graphic and link checks in another documented PDF viewer/screen-reader combination. Record any difference and reproduce it before assigning a cause. If this cannot be done, leave this checkpoint unable to test."),
)


def native_sequence(inventory: dict) -> list[dict]:
    """Export exact logical /K order, preserving overrides as separate evidence."""
    tags = inventory.get("tags", [])
    if not tags or len(tags) > MAX_TAGS:
        raise ValueError("invalid_tag_count")
    by_id = {tag["id"]: tag for tag in tags}
    if len(by_id) != len(tags):
        raise ValueError("duplicate_tag_id")
    result, visited = [], set()

    def visit(tag_id: str, parent_id: str | None, depth: int = 0) -> None:
        if depth > 100 or tag_id not in by_id or tag_id in visited:
            raise ValueError("unresolved_or_cyclic_tag_sequence")
        tag = by_id[tag_id]
        if tag.get("parentId") != parent_id:
            raise ValueError("tag_parent_mismatch")
        visited.add(tag_id)
        entry = {"kind": "beginTag", "tagId": tag_id, "role": tag["role"], "parentId": parent_id}
        for key in ("pageNumber", "effectiveLanguage", "alt", "actualText", "attributes", "nativeIdHex", "idTreeVerified"):
            if key in tag:
                entry[key] = deepcopy(tag[key])
        result.append(entry)
        for part in tag.get("contentSequence", []):
            if part.get("resolved") is not True:
                raise ValueError("unresolved_content_sequence")
            if part["kind"] == "childTag":
                visit(part["tagId"], tag_id, depth + 1)
            elif part["kind"] in ("markedContent", "objectReference"):
                result.append({**deepcopy(part), "tagId": tag_id})
            else:
                raise ValueError("unsupported_content_sequence")
        result.append({"kind": "endTag", "tagId": tag_id})
        if len(result) > MAX_EVENTS:
            raise ValueError("sequence_limit")

    for tag in tags:
        if tag.get("parentId") is None:
            visit(tag["id"], None)
    if len(visited) != len(tags):
        raise ValueError("unreachable_tags")
    return result


def build_pack(pdf: Path, expected_sha256: str) -> dict:
    if not re.fullmatch(r"[0-9a-f]{64}", expected_sha256):
        raise ValueError("invalid_expected_hash")
    if pdf.stat().st_size > MAX_PDF_BYTES:
        raise ValueError("pdf_size_limit")
    data = pdf.read_bytes()
    if len(data) > MAX_PDF_BYTES or sha256(data).hexdigest() != expected_sha256:
        raise ValueError("candidate_identity_mismatch")
    reader = PdfReader(io.BytesIO(data), strict=True)
    inventory = structure_inventory(reader)
    sequence = native_sequence(inventory)
    pack = {
        "schemaVersion": 1,
        "document": {"filename": pdf.name, "sha256": expected_sha256, "pages": len(reader.pages), "title": inventory.get("title"), "language": inventory.get("language")},
        "reviewStatus": "not_run",
        "screenReaderTestPerformed": False,
        "standardConformanceEstablished": False,
        "scope": "Manual usability protocol plus native-object evidence. Neither a speech transcript nor a PDF/UA certificate.",
        "session": {key: "" for key in ("tester", "date", "operatingSystem", "pdfViewerAndVersion", "screenReaderAndVersion", "keyboardLayout", "voiceAndLanguage", "readingPreferences", "evidenceLocation")},
        "checks": [{"id": key, "title": title, "procedure": action, "status": "not_run", "observed": "", "pages": [], "evidence": ""} for key, title, action in CHECKPOINTS],
        "machineEvidence": {
            "method": "Reopened immutable PDF native structure /K order; markedContent text is extracted evidence and may differ from actual assistive-technology output. Alt and ActualText are separate authoritative properties; no synthesized spoken transcript is created.",
            "tagCount": len(inventory["tags"]),
            "inspectionComplete": inventory.get("checks_complete", False),
            "mechanicalChecksPassed": inventory.get("machine_checks_passed", False),
            "findings": inventory.get("findings", []),
            "nativeIdTree": inventory.get("native_id_tree"),
            "excludedPageText": inventory.get("page_content", []),
            "excludedFormText": inventory.get("form_content", []),
            "nativeSequence": sequence,
        },
    }
    if len(json.dumps(pack, ensure_ascii=True).encode()) > MAX_PACK_BYTES:
        raise ValueError("pack_size_limit")
    if sha256(pdf.read_bytes()).hexdigest() != expected_sha256:
        raise ValueError("candidate_changed_during_inspection")
    return pack


def recorded_review_status(pack: dict, current_sha256: str) -> dict:
    """Summarize a human-entered record without promoting it to conformance."""
    if pack.get("document", {}).get("sha256") != current_sha256:
        raise ValueError("stale_manual_review")
    checks = pack.get("checks", [])
    if [check.get("id") for check in checks] != [item[0] for item in CHECKPOINTS]:
        raise ValueError("manual_checkpoint_coverage_changed")
    allowed = {"not_run", "pass", "fail", "unable", "not_applicable"}
    if any(check.get("status") not in allowed for check in checks):
        raise ValueError("invalid_review_status")
    outcomes = [check["status"] for check in checks]
    completed = all(status in {"pass", "not_applicable"} for status in outcomes)
    completed = completed and all(str(check.get("observed", "")).strip() for check in checks)
    session = pack.get("session", {})
    completed = completed and all(str(session.get(key, "")).strip() for key in ("tester", "date", "operatingSystem", "pdfViewerAndVersion", "screenReaderAndVersion", "readingPreferences"))
    return {"status": "manual_record_complete" if completed else "manual_review_incomplete_or_failed", "recordedChecksPassed": bool(completed), "screenReaderExecutionVerifiedByCode": False, "standardConformanceEstablished": False, "readyForApp": False}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("pdf", type=Path)
    parser.add_argument("--sha256", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.output.exists():
        raise ValueError("review_pack_exists")
    pack = build_pack(args.pdf, args.sha256)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("x", encoding="utf-8") as handle:
        json.dump(pack, handle, ensure_ascii=True, indent=2)
        handle.write("\n")
    print(json.dumps({"reviewStatus": "not_run", "screenReaderTestPerformed": False, "pageCount": pack["document"]["pages"], "packWritten": True}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
