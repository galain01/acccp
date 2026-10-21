"""Bounded native PDF processor. No network, credentials, model calls or storage.

The HTTP supervisor runs this in a fresh process for each request. Research
inspection code is reused as an independent verifier, never as fixture plans.
"""
from __future__ import annotations

import base64
import hashlib
import io
import json
import logging
import os
from pathlib import Path
import re
import subprocess
import sys
import threading
import time
from xml.sax.saxutils import escape

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "research" / "native-pdf"))
from pypdf import PdfReader, PdfWriter
from pypdf.generic import (ArrayObject, BooleanObject, DecodedStreamObject,
                          DictionaryObject, NameObject, TextStringObject)
import verify_pdf
from pdf_safety import reject_signed_pdf, resolved

# No research-only source hash exceptions authorize changes in the app.
verify_pdf.REVIEWED_WHITESPACE_ARTIFACTS = {}

MAX_PDF = 4 * 1024 * 1024
MAX_BODY = 12 * 1024 * 1024
MAX_REPORT = 16 * 1024 * 1024
MAX_TAGS = 5000
MAX_TEXT = 500_000
MAX_OPS = 500
ROLES = {"P", "H", "Caption", "Note", *(f"H{i}" for i in range(1, 7))}
PLACEHOLDER = re.compile(r"\s*(?:image\s*\d*|figure\s*\d*|formula|annotation)\s*", re.I)
ERRORS = {"native_pdf_unsupported", "native_pdf_preservation", "native_pdf_invalid_plan",
          "native_pdf_worker_failed", "native_pdf_timeout", "native_pdf_busy",
          "pdf_invalid", "pdf_password", "pdf_page_limit", "pdf_complexity_limit", "pdf_output_limit"}


class WorkerError(Exception):
    def __init__(self, code):
        super().__init__(code if code in ERRORS else "native_pdf_worker_failed")


def fail(code):
    raise WorkerError(code)


def digest(value):
    return hashlib.sha256(value).hexdigest()


def clean_environment():
    """Fixed runtime values plus Windows runtime necessities; no parent secrets."""
    env = {"PATH": os.defpath, "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8", "TZ": "UTC"}
    for key in ("SystemRoot", "WINDIR", "TEMP", "TMP"):
        if key in os.environ:
            env[key] = os.environ[key]
    return env


def run_bounded(command, *, directory, timeout=45, maximum=MAX_REPORT):
    """Drain both pipes while enforcing the byte cap before buffering it."""
    environment = clean_environment()
    environment.update(HOME=str(directory), TMPDIR=str(directory), TEMP=str(directory), TMP=str(directory))
    process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                               stderr=subprocess.PIPE, env=environment, cwd=directory,
                               creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    chunks = [[], []]
    too_large = threading.Event()
    def collect(stream, index):
        total = 0
        while block := stream.read(65536):
            total += len(block)
            if total > maximum:
                too_large.set()
                process.kill()
                break
            chunks[index].append(block)
        stream.close()
    threads = [threading.Thread(target=collect, args=(stream, i), daemon=True)
               for i, stream in enumerate((process.stdout, process.stderr))]
    for thread in threads:
        thread.start()
    try:
        process.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait()
        fail("native_pdf_timeout")
    finally:
        for thread in threads:
            thread.join(timeout=5)
    if too_large.is_set():
        fail("pdf_complexity_limit")
    # Stderr is intentionally never returned to a caller or logged.
    return process.returncode, b"".join(chunks[0])


def java_command(tool, arguments, directory):
    # java.io.tmpdir does not reliably follow TMPDIR/TEMP. All native scratch
    # files must remain inside the supervisor's request-owned directory.
    return [tool["command"], "-Djava.io.tmpdir=" + str(directory.resolve()), *tool["args"], *arguments]


def decode_pdf(value):
    if not isinstance(value, str) or not 1 <= len(value) <= ((MAX_PDF + 2) // 3) * 4:
        fail("pdf_output_limit")
    try:
        data = base64.b64decode(value, validate=True)
    except (ValueError, TypeError):
        fail("pdf_invalid")
    if len(data) > MAX_PDF or base64.b64encode(data).decode("ascii") != value:
        fail("pdf_invalid")
    return data


def open_pdf(data):
    if not 1 <= len(data) <= MAX_PDF or not data.startswith(b"%PDF-"):
        fail("pdf_invalid")
    try:
        reader = PdfReader(io.BytesIO(data), strict=True)
        if reader.is_encrypted:
            fail("pdf_password")
        if not 1 <= len(reader.pages) <= 60:
            fail("pdf_page_limit")
        try:
            reject_signed_pdf(reader)
        except ValueError:
            fail("native_pdf_unsupported")
        # Walk the reachable graph without decoding streams. Even hidden or
        # orphaned actions in an annotation/field cause rejection.
        pending, seen, count = [(reader.trailer["/Root"], 0)], set(), 0
        while pending:
            value, depth = pending.pop()
            value = resolved(value)
            count += 1
            if count > 100_000 or depth > 128:
                fail("pdf_complexity_limit")
            if not isinstance(value, (DictionaryObject, ArrayObject)) or id(value) in seen:
                continue
            seen.add(id(value))
            if isinstance(value, DictionaryObject):
                if any(key in value for key in ("/XFA", "/JavaScript", "/JS", "/EmbeddedFiles", "/EF", "/AF", "/AA", "/OpenAction")):
                    fail("native_pdf_unsupported")
                if value.get("/Type") == "/EmbeddedFile" or value.get("/Subtype") in ("/FileAttachment", "/RichMedia", "/Movie", "/Sound", "/3D"):
                    fail("native_pdf_unsupported")
                if value.get("/S") in ("/JavaScript", "/Launch", "/SubmitForm", "/ImportData", "/GoToR", "/GoToE", "/Rendition", "/Sound", "/Movie", "/ResetForm"):
                    fail("native_pdf_unsupported")
                if value.get("/S") == "/URI":
                    # Retain normal links; never execute or fetch them.
                    uri = str(value.get("/URI", ""))
                    if len(uri) > 8000 or not re.match(r"^(?:https?://|mailto:|tel:)", uri, re.I):
                        fail("native_pdf_unsupported")
                pending.extend((child, depth + 1) for child in value.values())
            else:
                pending.extend((child, depth + 1) for child in value)
        return reader
    except WorkerError:
        raise
    except Exception:
        fail("pdf_invalid")


def native_nodes(reader):
    catalog = reader.root_object if isinstance(reader, PdfWriter) else reader.trailer["/Root"]
    root = resolved(catalog.get("/StructTreeRoot"))
    if not isinstance(root, DictionaryObject):
        fail("native_pdf_unsupported")
    nodes, seen = [], set()
    def walk(value, depth=0):
        value = resolved(value)
        if depth > 64 or len(seen) > 20_000:
            fail("pdf_complexity_limit")
        if isinstance(value, (DictionaryObject, ArrayObject)):
            if id(value) in seen:
                fail("native_pdf_unsupported")
            seen.add(id(value))
        if isinstance(value, ArrayObject):
            for item in value:
                walk(item, depth + 1)
        elif isinstance(value, DictionaryObject) and value.get("/Type") not in ("/MCR", "/OBJR"):
            nodes.append(value)
            walk(value.get("/K"), depth + 1)
    walk(root.get("/K"))
    return nodes


def snapshot(tag):
    return {key: tag.get(key) for key in ("role", "pageNumber", "text", "mcids", "alt")}


def simple_cell(tag, tags):
    if tag["role"] not in ("TD", "TH") or tag.get("attributeGaps") or tag.get("textIncomplete"):
        return False
    row = tags.get(tag.get("parentId"), {})
    if row.get("role") != "TR":
        return False
    table = tags.get(row.get("parentId"), {})
    if table.get("role") in ("THead", "TBody", "TFoot"):
        table = tags.get(table.get("parentId"), {})
    if table.get("role") != "Table":
        return False
    rows = []
    for child_id in table.get("children", []):
        child = tags[child_id]
        if child["role"] == "TR":
            rows.append(child)
        elif child["role"] in ("THead", "TBody", "TFoot"):
            rows.extend(tags[item] for item in child["children"])
        else:
            return False
    lengths = set()
    for current in rows:
        if current["role"] != "TR":
            return False
        lengths.add(len(current["children"]))
        for cell_id in current["children"]:
            cell = tags[cell_id]
            if cell["role"] not in ("TD", "TH") or cell.get("attributeGaps"):
                return False
            for attribute in cell.get("attributes", []):
                if attribute.get("source") == "class" or attribute.get("revision") or attribute.get("headers") or attribute.get("rowSpan", 1) != 1 or attribute.get("colSpan", 1) != 1:
                    return False
    # Cell text commonly lives in child P/Span nodes. Keep those nodes intact;
    # the header role belongs on the cell that owns them, not on the paragraph.
    pending, meaningful = [tag], False
    while pending:
        descendant = pending.pop()
        if descendant.get("textIncomplete") or descendant.get("attributeGaps") or descendant["role"] in ("Table", "TR"):
            return False
        meaningful |= bool(descendant.get("text", "").strip())
        pending.extend(tags[item] for item in descendant.get("children", []))
    return len(lengths) == 1 and next(iter(lengths), 0) > 0 and meaningful


def text_block_eligible(tag, tags):
    """One block and its verified inline runs; never absorb nested blocks.

    A source role such as /Standard may validly map to /P. The independent
    inventory resolves that mapping, and the candidate hash binds its exact
    native dictionary. Editing this node's role leaves the shared RoleMap,
    inline markup, links, replacement text and painting untouched.
    """
    if tag["role"] not in ROLES:
        return False
    pending, seen, pages, text = [(tag, 0)], set(), set(), []
    while pending:
        current, depth = pending.pop()
        if current["id"] in seen or len(seen) >= 128 or depth > 16:
            return False
        seen.add(current["id"])
        if current is not tag and current["role"] not in ("Span", "Link"):
            return False
        if current.get("textIncomplete") or current.get("attributeGaps"):
            return False
        text.append(current.get("text", ""))
        sequence = current.get("contentSequence", [])
        if not sequence:
            return False
        child_references = []
        for item in sequence:
            if item.get("resolved") is not True:
                return False
            if item["kind"] == "childTag":
                child = tags.get(item.get("tagId"))
                if child is None or child.get("parentId") != current["id"]:
                    return False
                child_references.append(child["id"])
                pending.append((child, depth + 1))
            elif item["kind"] == "markedContent":
                if item.get("parentTreeVerified") is not True or type(item.get("pageNumber")) is not int:
                    return False
                pages.add(item["pageNumber"])
            elif item["kind"] == "objectReference":
                if (current["role"] != "Link" or item.get("subtype") != "Link"
                        or item.get("parentTreeVerified") is not True
                        or type(item.get("pageNumber")) is not int
                        or (item.get("actionType") != "URI" and item.get("destinationResolved") is not True)):
                    return False
                pages.add(item["pageNumber"])
            else:
                return False
        if child_references != current.get("children", []):
            return False
    text = "".join(text)
    return len(pages) == 1 and 0 < len(text.strip()) <= 20_000


def enrich_inventory(reader, original):
    inventory = verify_pdf.structure_inventory(reader)
    tags = inventory["tags"]
    if not tags or len(tags) > MAX_TAGS:
        fail("pdf_complexity_limit" if tags else "native_pdf_unsupported")
    if any(tag.get("textIncomplete") for tag in tags) or sum(len(tag.get("text", "")) + len(tag.get("alt", "")) for tag in tags) > MAX_TEXT:
        fail("pdf_complexity_limit")
    by_id = {tag["id"]: tag for tag in tags}
    original_inventory = verify_pdf.structure_inventory(original)
    # Existing tagged PDFs retain their native nodes and order. For untagged
    # sources there are no authored StructElem descriptions to replace.
    authored = {tag["id"] for tag in original_inventory["tags"] if "alt" in tag or "actualText" in tag}
    for tag in tags:
        tag["children"] = []
    for tag in tags:
        if tag["parentId"] in by_id:
            by_id[tag["parentId"]]["children"].append(tag["id"])
    annotation_labels = {}
    for page_number, page in enumerate(reader.pages, 1):
        for index, reference in enumerate(resolved(page.get("/Annots", ArrayObject())), 1):
            annotation, visited = resolved(reference), set()
            label = None
            for _ in range(64):
                if not isinstance(annotation, dict) or id(annotation) in visited:
                    break
                visited.add(id(annotation))
                label = str(annotation.get("/TU", "")).strip() or label or str(annotation.get("/T", "")).strip()
                if str(annotation.get("/TU", "")).strip():
                    break
                annotation = resolved(annotation.get("/Parent"))
            if label:
                annotation_labels[f"p{page_number}-a{index}"] = label[:200]
    for tag in tags:
        labels = [annotation_labels[item["annotationId"]] for item in tag.get("contentSequence", [])
                  if item.get("annotationId") in annotation_labels]
        if labels:
            tag["annotationLabels"] = labels
        native_leaf = not tag["children"] and bool(tag.get("contentSequence")) and all(
            item.get("kind") == "markedContent" and item.get("resolved") and item.get("parentTreeVerified")
            for item in tag.get("contentSequence", []))
        tag["editable"] = {
            "role": text_block_eligible(tag, by_id),
            "alt": native_leaf and tag["role"] == "Figure" and tag["sourceRole"] == "Figure" and tag["id"] not in authored and "actualText" not in tag and (not str(tag.get("alt", "")).strip() or bool(PLACEHOLDER.fullmatch(str(tag.get("alt", ""))))),
            "tableHeader": simple_cell(tag, by_id),
        }
        tag["snapshot"] = snapshot(tag)
    fields = []
    for name, field in (reader.get_fields() or {}).items():
        if len(fields) >= 200:
            fail("pdf_complexity_limit")
        row = {"name": str(name), "type": str(field.get("/FT", "")).lstrip("/"),
               "label": str(field.get("/TU", "")), "required": bool(int(field.get("/Ff", 0)) & 2),
               "value": str(field.get("/V", ""))}
        if any(len(value) > 8000 for value in row.values() if isinstance(value, str)):
            fail("pdf_complexity_limit")
        fields.append(row)
    inventory["forms"] = {**verify_pdf.form_inventory(reader), "fields": fields}
    if len(json.dumps(inventory, ensure_ascii=True).encode()) > 7 * 1024 * 1024:
        fail("pdf_complexity_limit")
    return inventory


def write_pdf(writer, path):
    with path.open("xb") as stream:
        writer.write(stream)
    if path.stat().st_size > MAX_PDF:
        fail("pdf_output_limit")
    return open_pdf(path.read_bytes())


def set_metadata(writer, title=None, language=None):
    root, changes = writer.root_object, []
    existing_title = str((writer.metadata or {}).get("/Title", "")).strip()
    if title is not None:
        if not isinstance(title, str) or not 1 <= len(title.strip()) <= 2000 or any(ord(char) < 32 for char in title):
            fail("native_pdf_invalid_plan")
    if language is not None:
        if not isinstance(language, str) or len(language) > 35 or not re.fullmatch(r"[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*", language):
            fail("native_pdf_invalid_plan")
    if title is not None and not existing_title:
        writer.add_metadata({"/Title": title.strip()})
        existing_title = title.strip()
        changes.append({"code": "document_title_added", "message": "Added a document title based on its content."})
    if language is not None and not str(root.get("/Lang", "")).strip():
        root[NameObject("/Lang")] = TextStringObject(language)
        changes.append({"code": "document_language_added", "message": "Set the document language so assistive technology can pronounce it appropriately."})
    if existing_title:
        prefs = resolved(root.get("/ViewerPreferences"))
        if prefs is None:
            prefs = DictionaryObject()
        if not isinstance(prefs, DictionaryObject):
            fail("pdf_invalid")
        if not verify_pdf.pdf_boolean(prefs.get("/DisplayDocTitle")):
            prefs[NameObject("/DisplayDocTitle")] = BooleanObject(True)
            root[NameObject("/ViewerPreferences")] = prefs
            changes.append({"code": "display_document_title", "message": "Configured the PDF viewer to display the document title."})
    if root.get("/StructTreeRoot") is not None:
        mark = resolved(root.get("/MarkInfo")) or DictionaryObject()
        if not isinstance(mark, DictionaryObject):
            fail("pdf_invalid")
        if not verify_pdf.pdf_boolean(mark.get("/Marked")):
            mark[NameObject("/Marked")] = BooleanObject(True)
            root[NameObject("/MarkInfo")] = mark
            changes.append({"code": "marked_document", "message": "Identified the document's existing accessibility tags."})
    # Preserve existing XMP schemas. Only create an absent packet; never add a
    # PDF/UA identification entry merely to make a validator return success.
    if existing_title and root.get("/Metadata") is None:
        xml = ('<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title><rdf:Alt><rdf:li xml:lang="x-default">' + escape(existing_title) + '</rdf:li></rdf:Alt></dc:title></rdf:Description></rdf:RDF></x:xmpmeta>')
        stream = DecodedStreamObject()
        stream[NameObject("/Type")] = NameObject("/Metadata")
        stream[NameObject("/Subtype")] = NameObject("/XML")
        stream.set_data(xml.encode("utf-8"))
        root[NameObject("/Metadata")] = writer._add_object(stream)
    return changes


def apply_plan(original, candidate, plan, output):
    if not isinstance(plan, dict) or set(plan) - {"schemaVersion", "candidateSha256", "language", "title", "operations"} or type(plan.get("schemaVersion")) is not int or plan["schemaVersion"] != 1 or plan.get("candidateSha256") != digest(candidate.stream.getvalue()):
        fail("native_pdf_invalid_plan")
    operations = plan.get("operations")
    if not isinstance(operations, list) or len(operations) > MAX_OPS:
        fail("native_pdf_invalid_plan")
    inventory = enrich_inventory(candidate, original)
    nodes = native_nodes(candidate)
    if len(nodes) != len(inventory["tags"]) or any(str(node.get("/S", "")).lstrip("/") != tag["sourceRole"] for node, tag in zip(nodes, inventory["tags"])):
        fail("native_pdf_preservation")
    writer = PdfWriter(clone_from=candidate)
    targets = native_nodes(writer)
    changes = set_metadata(writer, plan.get("title"), plan.get("language"))
    used = set()
    for operation in operations:
        if not isinstance(operation, dict) or operation.get("type") not in ("set_role", "set_alt", "set_table_header"):
            fail("native_pdf_invalid_plan")
        value_key, edit_key = {"set_role": ("role", "role"), "set_alt": ("alt", "alt"), "set_table_header": ("scope", "tableHeader")}[operation["type"]]
        if set(operation) != {"type", "tagId", "expected", value_key}:
            fail("native_pdf_invalid_plan")
        identifier = operation["tagId"]
        if not isinstance(identifier, str) or not re.fullmatch(r"tag-[1-9][0-9]{0,4}", identifier) or identifier in used:
            fail("native_pdf_invalid_plan")
        used.add(identifier)
        index = int(identifier[4:]) - 1
        if index >= len(targets):
            fail("native_pdf_invalid_plan")
        tag, target = inventory["tags"][index], targets[index]
        if operation["expected"] != tag["snapshot"] or not tag["editable"][edit_key]:
            fail("native_pdf_invalid_plan")
        value = operation[value_key]
        if operation["type"] == "set_role":
            if not isinstance(value, str) or value not in ROLES:
                fail("native_pdf_invalid_plan")
            target[NameObject("/S")] = NameObject("/" + value)
            message = "Corrected this text's heading or paragraph role."
        elif operation["type"] == "set_alt":
            if not isinstance(value, str) or not 1 <= len(value.strip()) <= 8000 or PLACEHOLDER.fullmatch(value) or any(ord(char) < 32 and char not in "\n\t" for char in value):
                fail("native_pdf_invalid_plan")
            target[NameObject("/Alt")] = TextStringObject(value.strip())
            message = "Added a description for this image."
        else:
            if value not in ("Column", "Row"):
                fail("native_pdf_invalid_plan")
            target[NameObject("/S")] = NameObject("/TH")
            attributes = resolved(target.get("/A"))
            attributes = list(attributes) if isinstance(attributes, ArrayObject) else [attributes] if attributes is not None else []
            # A final direct Table attribute overrides earlier direct scope
            # while retaining unrelated layout attributes.
            attributes.append(DictionaryObject({NameObject("/O"): NameObject("/Table"), NameObject("/Scope"): NameObject("/" + value)}))
            target[NameObject("/A")] = ArrayObject(attributes)
            message = "Identified this table cell as a header for its row or column."
        changes.append({"code": operation["type"], "message": message, "tagId": identifier, "pageNumber": tag["pageNumber"]})
    reopened = write_pdf(writer, output)
    actual = enrich_inventory(reopened, original)
    if len(actual["tags"]) != len(inventory["tags"]):
        fail("native_pdf_preservation")
    for operation in operations:
        tag = actual["tags"][int(operation["tagId"][4:]) - 1]
        expected = operation["expected"]
        if any(tag.get(key) != expected[key] for key in ("pageNumber", "text", "mcids")):
            fail("native_pdf_preservation")
        if operation["type"] == "set_role" and tag["role"] != operation["role"]:
            fail("native_pdf_preservation")
        if operation["type"] == "set_alt" and tag.get("alt") != operation["alt"].strip():
            fail("native_pdf_preservation")
        if operation["type"] == "set_table_header" and (tag["role"] != "TH" or tag["attributes"][-1].get("scope") != operation["scope"]):
            fail("native_pdf_preservation")
    return changes


def validate_ua(path, toolchain):
    tool = toolchain["veraPdf"]
    code, stdout = run_bounded(java_command(tool, ["--flavour", "ua1", "--format", "json", str(path)], path.parent), directory=path.parent, timeout=35)
    try:
        data = json.loads(stdout)
        if code not in (0, 1):
            fail("native_pdf_worker_failed")
        report = data["report"]
        jobs = report["jobs"]
        if len(jobs) != 1 or Path(jobs[0]["itemDetails"]["name"]).resolve() != path.resolve() or jobs[0]["itemDetails"]["size"] != path.stat().st_size:
            fail("native_pdf_worker_failed")
        results = jobs[0]["validationResult"]
        if len(results) != 1 or not isinstance(results[0].get("compliant"), bool):
            fail("native_pdf_worker_failed")
        result = results[0]
        if result.get("jobEndStatus") != "normal" or result.get("profileName") != "PDF/UA-1 validation profile":
            fail("native_pdf_worker_failed")
        details = result["details"]
        rules, checks = details["failedRules"], details["failedChecks"]
        if any(type(details.get(key)) is not int or details[key] < 0 for key in ("passedRules", "passedChecks", "failedRules", "failedChecks")) or details["passedRules"] == 0 or details["passedChecks"] == 0:
            fail("native_pdf_worker_failed")
        summary = report["batchSummary"]
        if summary.get("totalJobs") != 1 or any(summary.get(key, 0) != 0 for key in ("outOfMemory", "veraExceptions", "failedEncryptedJobs", "failedParsingJobs")) or summary["validationSummary"].get("successfulJobCount") != 1 or summary["validationSummary"].get("failedJobCount") != 0:
            fail("native_pdf_worker_failed")
        failed = [rule for rule in details.get("ruleSummaries", []) if rule.get("ruleStatus") == "FAILED" or rule.get("status") == "failed" or rule.get("failedChecks", 0) > 0]
        if len(failed) > 200 or (bool(rules) != bool(failed)) or result["compliant"] != (rules == 0 and checks == 0 and not failed) or (result["compliant"] and code == 1):
            fail("native_pdf_worker_failed")
        rows = [{"clause": str(rule.get("clause", ""))[:100], "testNumber": rule.get("testNumber"),
                 "failedChecks": rule.get("failedChecks"), "description": str(rule.get("description", ""))[:2000]}
                for rule in failed]
        return {"completed": True, "compliant": result["compliant"], "failedRules": rules, "failedChecks": checks, "rules": rows}
    except WorkerError:
        raise
    except Exception:
        fail("native_pdf_worker_failed")


def normalized_finding(item, inventory):
    code = str(item.get("code", "pdf_check_requires_review"))
    by_id = {tag["id"]: tag for tag in inventory["tags"]}
    tag = by_id.get(item.get("tagId"))
    subject = "image"
    if tag:
        subject = {"Figure": "image", "Form": "form control", "Link": "link", "Annot": "annotation", "Formula": "formula",
                   "P": "paragraph", "Table": "table", "TR": "table row", "TH": "table header", "TD": "table cell",
                   "Document": "document", **{role: "heading" for role in ("H", "H1", "H2", "H3", "H4", "H5", "H6")}}.get(tag["role"], "item")
    text = {
        "missing_document_language": "The PDF does not identify its language. A screen reader may pronounce words incorrectly.",
        "missing_figure_alternative": f"This {subject} is missing a description for people who cannot see it.",
        "placeholder_alternative": f"This {subject} has a generic label rather than a useful description.",
        "artifact_text_needs_semantic_review": "Some text is excluded from screen-reader reading order. Check that it is only repeated headers, footers or decoration.",
        "missing_structure_tree": "The PDF does not contain the tags needed to identify its reading order and headings.",
    }.get(code, "A saved-PDF structure check still needs attention: " + code.replace("_", " ") + ".")
    row = {"code": code, "severity": "error" if item.get("severity") == "error" else "warning", "message": text,
           "suggestion": "Review the indicated content in a PDF accessibility editor and run its accessibility checker.", "location": "Document"}
    number = item.get("pageNumber", item.get("page"))
    if tag:
        pages, pending, seen = set(), [tag], set()
        while pending:
            current = pending.pop()
            if current["id"] in seen:
                continue
            seen.add(current["id"])
            for page in [current.get("pageNumber"), *(entry.get("pageNumber") for entry in current.get("contentSequence", [])), *(entry.get("pageNumber") for entry in current.get("content", []))]:
                if type(page) is int and 1 <= page <= len(inventory["page_content"]):
                    pages.add(page)
            pending.extend(by_id[identifier] for identifier in current.get("children", []) if identifier in by_id)
        if type(number) is not int and len(pages) == 1:
            number = next(iter(pages))
        elif type(number) is not int and pages:
            row["location"] = "Pages " + ", ".join(str(page) for page in sorted(pages))
    if type(number) is int and number > 0:
        row.update(pageNumber=number, location=f"Page {number}")
    if isinstance(item.get("tagId"), str):
        row["tagId"] = item["tagId"]
        label = "; ".join(tag.get("annotationLabels", [])) if tag else ""
        if not label and tag:
            label = re.sub(r"\s+", " ", tag.get("text", "")).strip()[:100]
        row["location"] += " · " + (label if label else f"{subject} {item['tagId']}")
        row["location"] = row["location"][:300]
    return row


def response(original_path, candidate_path, changes, toolchain):
    before = open_pdf(original_path.read_bytes())
    after = open_pdf(candidate_path.read_bytes())
    checks = verify_pdf.compare_pdfs(original_path, candidate_path)
    # Preservation failures cannot be waived by a model or converted to a
    # normal warning. Incomplete semantic inspection remains a visible issue.
    if checks.get("inspection_incomplete") or not checks.get("preservation", {}).get("passed") or checks.get("findings"):
        fail("native_pdf_preservation")
    inventory = enrich_inventory(after, before)
    if inventory.get("checks_complete") is not True:
        fail("native_pdf_preservation")
    vera = validate_ua(candidate_path, toolchain)
    findings = [normalized_finding(item, inventory) for item in inventory.get("findings", [])]
    if len(findings) > 300:
        fail("pdf_complexity_limit")
    for page_number, page in enumerate(after.pages, 1):
        # An image-only page might be a legitimate photograph or a text scan.
        # Give the mandatory visual auditor evidence, without inventing an OCR
        # defect solely because no text is selectable.
        page_evidence = inventory["page_content"][page_number - 1]
        page_evidence["selectableTextPresent"] = bool((page.extract_text() or "").strip())
        page_evidence["requiresVisualTextReview"] = not page_evidence["selectableTextPresent"]
    if not vera["compliant"]:
        if len(vera["rules"]) != vera["failedRules"]:
            number = vera["failedChecks"]
            findings.append({"code": "pdf_ua_checks_remaining", "severity": "warning", "location": "Document",
                             "message": f"The PDF/UA-1 machine check reports {number} remaining failed {'check' if number == 1 else 'checks'}. This output is not claimed to meet PDF/UA-1.",
                             "suggestion": "Use the detailed document findings and a PDF accessibility checker to finish reviewing this PDF."})
        for rule in vera["rules"]:
            clause = rule["clause"]
            if clause.startswith("7.21"):
                message = "A font is missing embedded letters or a reliable text mapping. Some readers may display or announce the text incorrectly."
                suggestion = "Re-export from the original document with fonts embedded, or repair the fonts in a PDF accessibility editor."
            elif clause.startswith("7.18"):
                message = "A link, form control or other annotation has an unresolved accessibility requirement."
                suggestion = "Check the labels and keyboard reading order of links and form fields in a PDF accessibility editor."
            elif clause.startswith("7.5"):
                message = "A table still has an unresolved header or structure requirement."
                suggestion = "Check that each data cell can be associated with the correct row and column headings."
            elif clause.startswith("7.2"):
                message = "The PDF's text or language metadata still has an unresolved requirement."
                suggestion = "Check the document language and whether its text can be selected and read correctly."
            elif clause.startswith("5"):
                message = "The document is not declared as a PDF/UA-1 document. A declaration should be added only after all required accessibility checks pass."
                suggestion = "Complete the accessibility review before using a PDF editor to declare conformance."
            else:
                message = "The independent PDF checker found a remaining accessibility requirement: " + rule["description"]
                suggestion = "Review this requirement with a PDF accessibility checker."
            findings.append({"code": "pdf_ua_rule_" + re.sub(r"[^A-Za-z0-9_]", "_", clause + "_" + str(rule["testNumber"])),
                             "severity": "warning" if clause.startswith("5") else "error", "location": "Document", "message": message,
                             "suggestion": suggestion, "rule": rule})
    complete = True  # Required above; incomplete evidence never reaches the auditor.
    return {"schemaVersion": 1, "sourceSha256": digest(original_path.read_bytes()), "candidateSha256": digest(candidate_path.read_bytes()),
            "pdfBase64": base64.b64encode(candidate_path.read_bytes()).decode("ascii"), "pageCount": len(after.pages),
            "inventory": inventory, "findings": findings, "changes": changes,
            "machineChecks": {"preservationPassed": True, "inspectionComplete": complete,
                              "structurePassed": bool(inventory.get("machine_checks_passed")),
                              "pixelsIdentical": all(page.get("pixels_identical") for page in checks["preservation"]["pages"]),
                              "targetStandard": "PDF/UA-1 (ISO 14289-1:2014)", "veraPdf": vera, "conformanceClaim": False}}


def process(mode, request_path, directory, toolchain):
    source_path, output_path = directory / "source.pdf", directory / "output.pdf"
    if mode == "prepare":
        source = request_path.read_bytes()
        original = open_pdf(source)
        source_path.write_bytes(source)
        changes = []
        if original.trailer["/Root"].get("/StructTreeRoot") is None:
            tool = toolchain["openDataLoader"]
            tag_directory = directory / "tagged"
            tag_directory.mkdir()
            code, _ = run_bounded(java_command(tool, ["--quiet", "--format", "tagged-pdf", "--hybrid", "off", "--threads", "1", "--image-output", "off", "--include-header-footer", "--output-dir", str(tag_directory), str(source_path)], directory), directory=directory, timeout=40)
            tagged = tag_directory / "source_tagged.pdf"
            if code != 0 or not tagged.is_file() or tagged.stat().st_size > MAX_PDF:
                fail("native_pdf_worker_failed")
            candidate = open_pdf(tagged.read_bytes())
            changes.append({"code": "native_tags_added", "message": "Added native reading-order and content tags while preserving the original pages."})
        else:
            candidate = original
        writer = PdfWriter(clone_from=candidate)
        changes.extend(set_metadata(writer))
        write_pdf(writer, output_path)
    elif mode == "repair":
        try:
            data = json.loads(request_path.read_bytes())
        except Exception:
            fail("native_pdf_invalid_plan")
        if not isinstance(data, dict) or set(data) != {"sourcePdfBase64", "candidatePdfBase64", "plan"}:
            fail("native_pdf_invalid_plan")
        source = decode_pdf(data["sourcePdfBase64"])
        candidate_bytes = decode_pdf(data["candidatePdfBase64"])
        original, candidate = open_pdf(source), open_pdf(candidate_bytes)
        source_path.write_bytes(source)
        baseline = directory / "baseline.pdf"
        baseline.write_bytes(candidate_bytes)
        # Validate the caller-provided prepared file before using its IDs.
        comparison = verify_pdf.compare_pdfs(source_path, baseline)
        if comparison.get("inspection_incomplete") or not comparison.get("preservation", {}).get("passed") or comparison.get("findings"):
            fail("native_pdf_preservation")
        changes = apply_plan(original, candidate, data["plan"], output_path)
    else:
        fail("native_pdf_invalid_plan")
    return response(source_path, output_path, changes, toolchain)


def main():
    logging.disable(logging.CRITICAL)
    if os.name == "posix":
        import resource
        resource.setrlimit(resource.RLIMIT_AS, (3 * 1024 ** 3, 3 * 1024 ** 3))
        resource.setrlimit(resource.RLIMIT_CPU, (85, 90))
        resource.setrlimit(resource.RLIMIT_FSIZE, (64 * 1024 ** 2, 64 * 1024 ** 2))
        resource.setrlimit(resource.RLIMIT_NOFILE, (128, 128))
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    # Paths are supplied only by the trusted supervisor/CLI, never by JSON.
    if len(sys.argv) != 6:
        fail("native_pdf_worker_failed")
    mode, request, directory, toolchain_file, result_file = sys.argv[1:]
    request, directory, result_file = Path(request), Path(directory), Path(result_file)
    if request.stat().st_size > MAX_BODY:
        fail("pdf_output_limit")
    toolchain = json.loads(Path(toolchain_file).read_text(encoding="utf-8-sig"))
    result = process(mode, request, directory, toolchain)
    encoded = json.dumps(result, ensure_ascii=True, separators=(",", ":")).encode("utf-8")
    if len(encoded) > MAX_REPORT:
        fail("pdf_complexity_limit")
    result_file.write_bytes(encoded)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        code = str(error) if isinstance(error, WorkerError) else "native_pdf_worker_failed"
        print(json.dumps({"error": {"code": code}}))
        sys.exit(1)
