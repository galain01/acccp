"""Run local OpenDataLoader + independent PDF checks without touching the app.

Outputs are experimental candidates, never a conformance claim. Tool binaries
are configured separately; this script downloads nothing and loads no API keys.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import logging
import os
from pathlib import Path
import subprocess
import sys
import time

from pypdf import PdfReader
from verify_pdf import compare_pdfs, MAX_FILE_BYTES, MAX_PAGES
from pdf_safety import reject_signed_pdf

REPO = Path(__file__).resolve().parents[2]


def run_tool(tool: dict, extra: list[str], limit_seconds: int = 120) -> subprocess.CompletedProcess:
    command = tool.get("command")
    args = tool.get("args")
    if not isinstance(command, str) or not Path(command).is_absolute() or not isinstance(args, list) or not all(isinstance(arg, str) for arg in args):
        raise ValueError("invalid_toolchain")
    # In particular, do not forward institutional model or storage credentials.
    environment = {name: os.environ[name] for name in ("SystemRoot", "WINDIR", "TEMP", "TMP", "USERPROFILE", "LOCALAPPDATA", "PATH") if name in os.environ}
    return subprocess.run([command, *args, *extra], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=limit_seconds, env=environment, check=False, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))


def summarize_verapdf(raw: dict) -> list[dict]:
    jobs = raw.get("report", {}).get("jobs", [])
    summaries = []
    for job in jobs:
        for result in job.get("validationResult", []):
            details = result.get("details", {})
            summaries.append({"compliant": result.get("compliant") is True, "failedRules": details.get("failedRules"), "failedChecks": details.get("failedChecks")})
    return summaries


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--toolchain", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path, help="New output folder outside the Git repository")
    parser.add_argument("--use-struct-tree", action="store_true", help="Comparison experiment only; does not guarantee existing tags/alternatives survive")
    parser.add_argument("inputs", nargs="+", type=Path)
    options = parser.parse_args()
    output = options.output.resolve()
    if output.is_relative_to(REPO) or output.exists():
        raise ValueError("new_output_outside_repository_required")
    toolchain = json.loads(options.toolchain.read_text(encoding="utf-8-sig"))
    if "openDataLoader" not in toolchain or "veraPdf" not in toolchain:
        raise ValueError("toolchain_requires_tagger_and_validator")
    sources = [item.resolve(strict=True) for item in options.inputs]
    if len(sources) > 20 or len(set(sources)) != len(sources):
        raise ValueError("input_batch_limit_or_duplicate")
    logging.getLogger("pypdf").setLevel(logging.CRITICAL)
    for source in sources:
        if source.suffix.lower() != ".pdf" or source.stat().st_size > MAX_FILE_BYTES:
            raise ValueError("input_limit")
        reader = PdfReader(source, strict=True)
        if reader.is_encrypted or not 1 <= len(reader.pages) <= MAX_PAGES:
            raise ValueError("encrypted_or_page_limit")
        reject_signed_pdf(reader)
    output.mkdir(parents=True)
    summary = {"experimental": True, "readyForApp": False, "certification": False, "engine": {"name": "OpenDataLoader", "version": toolchain["openDataLoader"].get("version")}, "settings": {"hybrid": "off", "threads": 1, "useStructTree": options.use_struct_tree, "contentFilters": "upstream defaults", "sanitize": False}, "documents": []}
    for index, source in enumerate(sources):
        folder = output / f"document-{index + 1}"
        folder.mkdir()
        started = time.monotonic()
        entry = {"source": source.name, "sourceSha256": hashlib.sha256(source.read_bytes()).hexdigest(), "status": "incomplete"}
        summary["documents"].append(entry)
        try:
            flags = ["--quiet", "--format", "tagged-pdf,json", "--hybrid", "off", "--threads", "1", "--image-output", "off", "--output-dir", str(folder)]
            if options.use_struct_tree:
                flags.append("--use-struct-tree")
            tagger = run_tool(toolchain["openDataLoader"], [*flags, str(source)])
            candidate = folder / f"{source.stem}_tagged.pdf"
            if tagger.returncode or not candidate.is_file():
                raise ValueError("tagging_failed")
            if hashlib.sha256(source.read_bytes()).hexdigest() != entry["sourceSha256"]:
                raise ValueError("source_changed")
            checks = compare_pdfs(source, candidate)
            (folder / "independent-checks.json").write_text(json.dumps(checks, ensure_ascii=True, indent=2), encoding="utf-8")
            validated = run_tool(toolchain["veraPdf"], ["--flavour", "ua1", "--format", "json", str(candidate)])
            if len(validated.stdout) > 16 * 1024 * 1024:
                raise ValueError("validator_report_limit")
            vera_report = json.loads(validated.stdout)
            vera_summary = summarize_verapdf(vera_report)
            if not vera_summary:
                raise ValueError("validator_result_unavailable")
            (folder / "verapdf-ua1.json").write_text(json.dumps(vera_report, ensure_ascii=True, indent=2), encoding="utf-8")
            entry.update({"status": "evaluated", "candidate": str(candidate.relative_to(output)), "outputSha256": hashlib.sha256(candidate.read_bytes()).hexdigest(), "pages": len(checks["preservation"]["pages"]), "preservationPassed": checks["preservation"]["passed"], "pixelsIdentical": bool(checks["preservation"]["pages"]) and all(page.get("pixels_identical") for page in checks["preservation"]["pages"]), "machineInspectionComplete": not checks.get("inspection_incomplete", False) and checks["structure"].get("checks_complete", False), "findingCodes": sorted(set(finding["code"] for finding in [*checks["findings"], *checks["structure"].get("findings", [])])), "veraPdf": vera_summary, "semanticAudit": "not_run"})
        except Exception:
            # Raw parser/provider output can contain source content. Keep it out
            # of terminal logs; the local PDF and explicit reports are evidence.
            entry["status"] = "incomplete"
            entry["reason"] = "local_evaluation_could_not_complete"
        entry["elapsedSeconds"] = round(time.monotonic() - started, 3)
        (output / "summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
        print(json.dumps({"document": index + 1, "status": entry["status"], "pixelsIdentical": entry.get("pixelsIdentical"), "elapsedSeconds": entry["elapsedSeconds"]}))
    return 0 if all(item["status"] == "evaluated" for item in summary["documents"]) else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        print(json.dumps({"status": "could_not_start", "reason": "Check the input paths, new output folder, and local toolchain configuration."}))
        sys.exit(2)
