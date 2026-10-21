"""Apply a small, reviewable role-change plan supported by a completed audit.

Only existing leaf paragraphs, headings and captions may change role. Text,
painting streams, MCIDs, ordering, figures, tables and native attributes stay
unchanged. The output requires a fresh audit and independent validation.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re

from pypdf import PdfReader
from pypdf.generic import ArrayObject, DictionaryObject, NameObject
from conformance_repairs import _open, _save
from pdf_safety import resolved
from verify_pdf import Canonicalizer, structure_inventory

ROLES = {"P", "Caption", *(f"H{i}" for i in range(1, 7))}


def _tag_nodes(reader) -> list:
    catalog = reader.root_object if hasattr(reader, "root_object") else reader.trailer["/Root"]
    root = resolved(catalog.get("/StructTreeRoot"))
    if not isinstance(root, DictionaryObject):
        raise ValueError("structure_tree_required")
    nodes, seen = [], set()

    def walk(value, depth=0):
        value = resolved(value)
        if depth > 128 or len(seen) > 20_000:
            raise ValueError("structure_limit")
        if isinstance(value, (DictionaryObject, ArrayObject)):
            if id(value) in seen:
                raise ValueError("reused_or_cyclic_structure")
            seen.add(id(value))
        if isinstance(value, ArrayObject):
            for item in value:
                walk(item, depth + 1)
        elif isinstance(value, DictionaryObject) and value.get("/Type") not in ("/MCR", "/OBJR"):
            nodes.append(value)
            walk(value.get("/K"), depth + 1)
    walk(root.get("/K"))
    return nodes


def apply_semantic_role_plan(source: Path, output: Path, plan: dict, *, audit_report: Path) -> dict:
    if not isinstance(plan, dict) or set(plan) != {"schemaVersion", "inputSha256", "auditReportSha256", "repairs"} or plan["schemaVersion"] != 1:
        raise ValueError("invalid_semantic_plan")
    reader, writer = _open(source, output)
    digest = hashlib.sha256(reader.stream.getvalue()).hexdigest()
    if plan["inputSha256"] != digest:
        raise ValueError("candidate_hash_mismatch")
    if not audit_report.is_file() or audit_report.stat().st_size > 2 * 1024 * 1024:
        raise ValueError("bounded_audit_required")
    audit_bytes = audit_report.read_bytes()
    if hashlib.sha256(audit_bytes).hexdigest() != plan["auditReportSha256"]:
        raise ValueError("audit_hash_mismatch")
    audit = json.loads(audit_bytes)
    if audit.get("status") != "complete" or audit.get("outputSha256") != digest:
        raise ValueError("complete_matching_audit_required")
    repairs = plan["repairs"]
    if not isinstance(repairs, list) or not 1 <= len(repairs) <= 40:
        raise ValueError("repair_count_limit")
    inventory = structure_inventory(reader)
    nodes = _tag_nodes(reader)
    # The independent inventory assigns deterministic preorder tag IDs. Verify
    # its enumeration against native dictionaries before using those IDs.
    if len(nodes) != len(inventory["tags"]):
        raise ValueError("tag_inventory_mismatch")
    for node, tag in zip(nodes, inventory["tags"]):
        if str(node.get("/S", "")).lstrip("/") != tag["sourceRole"]:
            raise ValueError("tag_inventory_mismatch")
    writer_nodes = _tag_nodes(writer)
    if len(writer_nodes) != len(nodes):
        raise ValueError("cloned_tag_inventory_mismatch")
    changes, used = [], set()
    for repair in repairs:
        if not isinstance(repair, dict) or set(repair) != {"tagId", "expected", "newRole", "findingCode", "reason"}:
            raise ValueError("invalid_role_repair")
        tag_id = repair["tagId"]
        if not isinstance(tag_id, str) or not re.fullmatch(r"tag-[1-9][0-9]{0,4}", tag_id) or tag_id in used:
            raise ValueError("duplicate_or_invalid_tag")
        used.add(tag_id)
        index = int(tag_id[4:]) - 1
        if index >= len(nodes):
            raise ValueError("unknown_tag")
        tag, node = inventory["tags"][index], nodes[index]
        expected = repair["expected"]
        if not isinstance(expected, dict) or set(expected) != {"role", "pageNumber", "text", "mcids"}:
            raise ValueError("exact_tag_snapshot_required")
        if any(tag.get(key) != expected[key] for key in expected):
            raise ValueError("tag_snapshot_mismatch")
        if (tag["role"] not in ROLES or tag["sourceRole"] != tag["role"] or repair["newRole"] not in ROLES
                or repair["newRole"] == tag["role"] or tag.get("textIncomplete")
                or not isinstance(tag["text"], str) or not tag["text"].strip()
                or len(tag["text"]) > 20_000 or not tag["mcids"]
                or not all(item.get("resolved") is True and item.get("kind") == "markedContent" for item in tag["contentSequence"])
                or any(item.get("pageNumber") != tag["pageNumber"] for item in tag["content"])
                or tag.get("attributeGaps")):
            raise ValueError("unsupported_role_target")
        if not isinstance(repair["reason"], str) or not 1 <= len(repair["reason"].strip()) <= 2000:
            raise ValueError("review_reason_required")
        findings = audit.get("findings", [])
        if tag_id not in audit.get("reviewedTagIds", []) or tag["pageNumber"] not in audit.get("reviewedPages", []) or not any(
            finding.get("code") == repair["findingCode"] and tag_id in finding.get("tagIds", [])
            and finding.get("pageNumber") == tag["pageNumber"] for finding in findings):
            raise ValueError("matching_audit_finding_required")
        clone = writer_nodes[index]
        # Compare everything except the role before mutating this exact node.
        if Canonicalizer().hash({k:v for k,v in node.items() if k not in ("/P", "/Pg")}) != Canonicalizer().hash({k:v for k,v in clone.items() if k not in ("/P", "/Pg")}):
            raise ValueError("cloned_tag_changed")
        clone[NameObject("/S")] = NameObject("/" + repair["newRole"])
        changes.append({"tagId": tag_id, "pageNumber": tag["pageNumber"], "beforeRole": tag["role"],
                        "afterRole": repair["newRole"], "text": tag["text"], "mcids": tag["mcids"],
                        "findingCode": repair["findingCode"], "reason": repair["reason"]})
    output_digest = _save(writer, output)
    reopened = structure_inventory(PdfReader(output, strict=True))
    for change in changes:
        tag = reopened["tags"][int(change["tagId"][4:]) - 1]
        if any(tag.get(key) != change[key] for key in ("pageNumber", "text", "mcids")) or tag["role"] != change["afterRole"]:
            raise ValueError("saved_role_verification_failed")
    return {"experimental": True, "certification": False, "requires_revalidation": True,
            "inputSha256": digest, "outputSha256": output_digest, "auditReportSha256": plan["auditReportSha256"],
            "changes": changes}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--plan", type=Path, required=True)
    parser.add_argument("--audit", type=Path, required=True)
    args = parser.parse_args()
    if args.plan.stat().st_size > 1024 * 1024:
        raise ValueError("plan_size_limit")
    print(json.dumps(apply_semantic_role_plan(args.source, args.output, json.loads(args.plan.read_text(encoding="utf-8")), audit_report=args.audit), indent=2))
