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
import math
import os
from pathlib import Path
import re
import subprocess
import sys
import threading
import time
import unicodedata
from xml.sax.saxutils import escape

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "research" / "native-pdf"))
from pypdf import PdfReader, PdfWriter
from pypdf.generic import (ArrayObject, BooleanObject, ByteStringObject, DecodedStreamObject,
                          DictionaryObject, NameObject, TextStringObject)
import verify_pdf
from pdf_safety import reject_signed_pdf, resolved
from hybrid_forms import HybridFormError, inspect_hybrid, prepare_hybrid
from hybrid_form_verification import HybridVerificationError, verify_hybrid_preparation
from native_form_inventory import NativeFormInventoryError, native_form_inventory
from form_interaction_fingerprint import form_interaction_fingerprint
from native_structure_repairs import (NoteIdError, note_id_snapshot, repair_note_ids,
    verify_note_ids, verify_authored_ids, authored_id_bindings, verify_authored_id_bindings)
from bounded_semantic_structure import discover_candidates, apply_operations, SemanticStructureError

# No research-only source hash exceptions authorize changes in the app.
verify_pdf.REVIEWED_WHITESPACE_ARTIFACTS = {}

MAX_PDF = 4 * 1024 * 1024
MAX_BODY = 12 * 1024 * 1024
MAX_REPORT = 16 * 1024 * 1024
MAX_TAGS = 5000
MAX_TEXT = 500_000
MAX_OPS = 500
MAX_LINK_DESCRIPTIONS = 200
MAX_LINK_SCAN_OPERATIONS = 1_000_000
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


def local_opening_view(reader):
    """Accept only a catalog view of an existing page, without chained actions.

    Opening-page destinations are passive navigation metadata. Keep them intact
    and let the independent catalog comparison verify the saved behavior.
    """
    catalog = reader.trailer["/Root"]
    destination = resolved(catalog.get("/OpenAction"))
    if isinstance(destination, DictionaryObject):
        if (set(destination) - {"/Type", "/S", "/D"}
                or destination.get("/S") != "/GoTo"
                or ("/Type" in destination and destination["/Type"] != "/Action")):
            return False
        destination = resolved(destination.get("/D"))
        if not isinstance(destination, (ArrayObject, NameObject, TextStringObject, ByteStringObject)):
            return False
    elif not isinstance(destination, ArrayObject):
        return False
    pages = {verify_pdf.reference_key(page): index for index, page in enumerate(reader.pages, 1)}
    return verify_pdf.LocalDestinations(catalog, pages).resolve(destination)["destinationResolved"]


def open_pdf(data):
    if not 1 <= len(data) <= MAX_PDF or not data.startswith(b"%PDF-"):
        fail("pdf_invalid")
    try:
        reader = PdfReader(io.BytesIO(data), strict=True)
        if reader.is_encrypted:
            fail("pdf_password")
        if not 1 <= len(reader.pages) <= 60:
            fail("pdf_page_limit")
        hybrid = inspect_hybrid(reader)
        # A verified Reader usage-rights signature is distinct from a user's
        # signature. Recheck every field for actual signatures with only that
        # catalog entry temporarily absent; retain the immutable source bytes.
        root = reader.trailer["/Root"]
        rights = root.pop(NameObject("/Perms")) if hybrid and hybrid.has_reader_rights else None
        try:
            reject_signed_pdf(reader)
        except ValueError:
            fail("native_pdf_unsupported")
        finally:
            if rights is not None:
                root[NameObject("/Perms")] = rights
        opening_view_owners = {id(root)} if "/OpenAction" in root and local_opening_view(reader) else set()
        # Walk the reachable graph without decoding streams. Even hidden or
        # orphaned actions in an annotation/field cause rejection.
        pending, seen, count = [(reader.trailer["/Root"], 0)], set(), 0
        while pending:
            value, depth = pending.pop()
            value = resolved(value)
            count += 1
            if count > 100_000 or depth > 128:
                fail("pdf_complexity_limit")
            if hybrid and id(value) in hybrid.usage_rights_node_ids:
                continue
            if not isinstance(value, (DictionaryObject, ArrayObject)) or id(value) in seen:
                continue
            seen.add(id(value))
            if isinstance(value, DictionaryObject):
                exceptions = {
                    "/XFA": hybrid.xfa_owner_ids if hybrid else set(),
                    "/JavaScript": hybrid.javascript_owner_ids if hybrid else set(),
                    "/JS": hybrid.javascript_action_ids if hybrid else set(),
                    "/OpenAction": opening_view_owners,
                }
                if any(key in value and id(value) not in exceptions.get(key, set())
                       for key in ("/XFA", "/JavaScript", "/JS", "/EmbeddedFiles", "/EF", "/AF", "/AA", "/OpenAction")):
                    fail("native_pdf_unsupported")
                if ((value.get("/Type") == "/EmbeddedFile" and not (hybrid and id(value) in hybrid.xfa_packet_stream_ids))
                        or value.get("/Subtype") in ("/FileAttachment", "/RichMedia", "/Movie", "/Sound", "/3D")):
                    fail("native_pdf_unsupported")
                if (value.get("/S") in ("/JavaScript", "/Launch", "/SubmitForm", "/ImportData", "/GoToR", "/GoToE", "/Rendition", "/Sound", "/Movie", "/ResetForm")
                        and not (value.get("/S") == "/JavaScript" and hybrid and id(value) in hybrid.javascript_action_ids)):
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
    except HybridFormError:
        fail("native_pdf_unsupported")
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
    # New heading/reference children can shift preorder IDs. Bind authored
    # descriptions to their native content scope rather than an ordinal ID.
    def content_key(tag):
        return tuple((part.get("pageNumber"), part.get("streamId"), part.get("mcid"))
                     for part in tag.get("content", []))
    authored = {content_key(tag) for tag in original_inventory["tags"]
                if ("alt" in tag or "actualText" in tag) and tag.get("content")}
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
            "alt": native_leaf and tag["role"] == "Figure" and tag["sourceRole"] == "Figure" and content_key(tag) not in authored and "actualText" not in tag and (not str(tag.get("alt", "")).strip() or bool(PLACEHOLDER.fullmatch(str(tag.get("alt", ""))))),
            "tableHeader": simple_cell(tag, by_id),
        }
        tag["snapshot"] = snapshot(tag)
    try:
        controls = native_form_inventory(reader)
    except NativeFormInventoryError as error:
        fail(str(error) if str(error) in ERRORS else "native_pdf_preservation")
    inventory["forms"] = {**verify_pdf.form_inventory(reader), **controls}
    interaction = form_interaction_fingerprint(reader)
    if interaction is not None:
        inventory["forms"]["interactionFingerprint"] = interaction
    try:
        inventory["structureCandidates"] = discover_candidates(reader)
    except SemanticStructureError as error:
        if str(error) != "pdf_complexity_limit":
            fail(str(error) if str(error) in {"native_pdf_invalid_plan", "native_pdf_preservation"} else "native_pdf_worker_failed")
        # Candidate discovery is optional assistance. The completed native
        # checks and model audit still run, and this limitation remains visible.
        inventory["structureCandidates"] = []
        inventory["findings"].append({"code": "structure_candidates_limited", "severity": "warning"})
    if len(json.dumps(inventory, ensure_ascii=True).encode()) > 7 * 1024 * 1024:
        fail("pdf_complexity_limit")
    return inventory


def write_pdf(writer, path):
    with path.open("xb") as stream:
        writer.write(stream)
    if path.stat().st_size > MAX_PDF:
        fail("pdf_output_limit")
    return open_pdf(path.read_bytes())


def link_label(value):
    if not isinstance(value, str) or len(value) > 20_000:
        return None
    # A native string is evidence, not permission to invent a link purpose.
    if any(unicodedata.category(char) in {"Cf", "Co", "Cs"} or char == "\ufffd"
           or (unicodedata.category(char) == "Cc" and not char.isspace()) for char in value):
        return None
    label = re.sub(r"\s+", " ", value).strip()
    if (not 3 <= len(label) <= 2000 or not any(char.isalpha() for char in label)
            or label.casefold().strip(" .:") in {"annotation", "link", "here", "click here", "read more", "more", "image"}):
        return None
    return label


def annotation_states(reader):
    """Include every dictionary entry, including descriptions and parent keys.

    The general verifier intentionally allows new descriptions. This stricter
    view proves that our writer changes only the specifically approved entry.
    """
    rows = {}
    for page_number, page in enumerate(reader.pages, 1):
        for index, reference in enumerate(resolved(page.get("/Annots", ArrayObject())), 1):
            annotation = resolved(reference)
            if not isinstance(annotation, DictionaryObject):
                fail("native_pdf_preservation")
            rows[(page_number, index)] = {str(key): verify_pdf.Canonicalizer(list(reader.pages)).hash(value)
                                          for key, value in annotation.items()}
    return rows


def simple_link_paint(page, mcids, rectangle, page_operations=None):
    """Allow text and a plain underline; reject mixed or replacement content."""
    stack, counts, rendered = [], {}, set()
    invisible, graphics_override = False, False
    matrix, line_width, graphics_stack, path, strokes = (1, 0, 0, 1, 0, 0), 1, [], [], 0
    for operands, operator in page_operations if page_operations is not None else verify_pdf.operations(page):
        if operator == b"q":
            graphics_stack.append((matrix, line_width, invisible, graphics_override))
        elif operator == b"Q":
            if not graphics_stack:
                return False
            matrix, line_width, invisible, graphics_override = graphics_stack.pop()
        elif operator == b"cm":
            a, b, c, d, e, f = (float(value) for value in operands)
            aa, bb, cc, dd, ee, ff = matrix
            matrix = (a*aa+b*cc, a*bb+b*dd, c*aa+d*cc, c*bb+d*dd, e*aa+f*cc+ee, e*bb+f*dd+ff)
        elif operator == b"w":
            line_width = float(operands[0])
        if operator in (b"m", b"l"):
            x, y = (float(value) for value in operands)
            a, b, c, d, e, f = matrix
            path.append((operator, x*a+y*c+e, x*b+y*d+f))
        elif operator == b"re":
            x, y, width, height = (float(value) for value in operands)
            a, b, c, d, e, f = matrix
            corners = [(xx*a+yy*c+e, xx*b+yy*d+f) for xx, yy in ((x, y), (x+width, y), (x+width, y+height), (x, y+height))]
            axis_aligned = (b == c == 0 or a == d == 0)
            path.append((operator, corners, axis_aligned))
        elif operator in (b"c", b"v", b"y", b"h"):
            path.append((operator,))
        if operator == b"Tr":
            invisible = int(operands[0]) in (3, 7)
            if int(operands[0]) in (4, 5, 6, 7):
                graphics_override = True
        if operator == b"gs":
            # Opacity and optional-content effects need a richer visibility check.
            graphics_override = True
        if operator in (b"W", b"W*"):
            # A simple page/cell crop containing the entire link is harmless.
            # Unknown, empty or intersecting clips remain ambiguous until Q.
            safe_clip = len(path) == 1 and path[0][0] == b"re" and path[0][2]
            if safe_clip:
                xs, ys = zip(*path[0][1])
                safe_clip = (all(math.isfinite(value) for value in (*xs, *ys))
                             and min(xs) <= rectangle[0] < rectangle[2] <= max(xs)
                             and min(ys) <= rectangle[1] < rectangle[3] <= max(ys))
            graphics_override |= not safe_clip
        if operator in (b"BMC", b"BDC"):
            properties = resolved(operands[1]) if operator == b"BDC" and len(operands) > 1 else {}
            if isinstance(properties, NameObject):
                properties = resolved(resolved(page.get("/Resources", DictionaryObject())).get("/Properties", DictionaryObject())).get(properties)
                properties = resolved(properties)
            identifier = verify_pdf.integer(properties.get("/MCID")) if isinstance(properties, dict) else None
            unsafe = (str(operands[0]) in ("/Artifact", "/OC") or not isinstance(properties, dict)
                      or any(key in properties for key in ("/Alt", "/ActualText", "/OC")))
            stack.append((identifier, unsafe))
            if identifier in mcids:
                counts[identifier] = counts.get(identifier, 0) + 1
        selected = {identifier for identifier, _ in stack if identifier in mcids}
        if selected and (any(unsafe for _, unsafe in stack) or len(selected) != 1):
            return False
        if selected and operator == b"S":
            # Word/LibreOffice often puts the ordinary hyperlink underline in
            # the text's MCID. It is not an additional graphic description.
            a, b, c, d, _, _ = matrix
            width = abs(line_width) * max(math.hypot(a, b), math.hypot(c, d))
            left, bottom, right, top = rectangle
            if (graphics_override or strokes >= len(mcids) or not selected <= rendered or len(path) != 2
                    or path[0][0] != b"m" or path[1][0] != b"l"
                    or not all(math.isfinite(value) for point in path for value in point[1:])
                    or abs(path[0][2] - path[1][2]) > 0.01
                    or not 0 < width <= min(2, (top-bottom)*0.2)
                    or not (right-left)*0.5 <= abs(path[1][1]-path[0][1]) <= right-left
                    # Exported link rectangles may round differently from the
                    # underline endpoints. Half a point covers that rounding,
                    # without accepting a stroke outside the link's region.
                    or not all(left-0.5 <= point[1] <= right+0.5 and bottom <= point[2] <= bottom+(top-bottom)*0.35 for point in path)):
                return False
            strokes += 1
        if selected and operator in (b"Do", b"INLINE IMAGE", b"s", b"f", b"F", b"f*", b"B", b"B*", b"b", b"b*", b"sh"):
            return False
        if selected and operator in (b"Tj", b"TJ", b"'", b'"'):
            if invisible or graphics_override or not all(math.isfinite(value) for value in matrix) or abs(matrix[0]*matrix[3]-matrix[1]*matrix[2]) < 1e-10:
                return False
            rendered.update(selected)
        if operator == b"EMC":
            if not stack:
                return False
            stack.pop()
        if operator in (b"S", b"s", b"f", b"F", b"f*", b"B", b"B*", b"b", b"b*", b"n"):
            path = []
    return not stack and not graphics_stack and rendered == mcids and counts == {identifier: 1 for identifier in mcids}


def native_link_descriptions(reader, *, targets=None, include_existing=False):
    """Verified source-tagged, single-page links with literal native labels."""
    if reader.trailer["/Root"].get("/StructTreeRoot") is None:
        return {}
    inventory = verify_pdf.structure_inventory(reader)
    if inventory.get("checks_complete") is not True or len(inventory["tags"]) > MAX_TAGS:
        return {}
    tags = {tag["id"]: tag for tag in inventory["tags"]}
    owners = {}
    for tag in tags.values():
        for item in tag.get("contentSequence", []):
            if item.get("kind") == "objectReference":
                owners.setdefault(item.get("annotationId"), []).append(tag["id"])
    states, result, page_operations, paint_attempts, scanned_operations = annotation_states(reader), {}, {}, 0, 0
    for tag in tags.values():
        if tag["role"] != "Link" or tag["sourceRole"] != "Link" or tag.get("textIncomplete") or tag.get("attributeGaps"):
            continue
        sequence = tag.get("contentSequence", [])
        refs = [item for item in sequence if item.get("kind") == "objectReference"]
        marks = [item for item in sequence if item.get("kind") == "markedContent"]
        if (len(refs) != 1 or not marks or len(sequence) > 64 or len(sequence) != len(marks) + 1
                or any(item.get("resolved") is not True or item.get("parentTreeVerified") is not True for item in sequence)
                or any("streamId" in item for item in marks)
                or len({item.get("mcid") for item in marks}) != len(marks)):
            continue
        reference = refs[0]
        page_number, index = reference.get("pageNumber"), reference.get("annotationIndex")
        if (type(page_number) is not int or type(index) is not int or reference.get("subtype") != "Link"
                or any(item.get("pageNumber") != page_number for item in marks)
                or owners.get(reference.get("annotationId")) != [tag["id"]]):
            continue
        key = (page_number, index)
        if targets is not None and key not in targets:
            continue
        # An ancestor replacement can override the visible/native link label.
        current, seen, overrides = tag, set(), False
        while current and current["id"] not in seen:
            seen.add(current["id"])
            overrides |= "alt" in current or "actualText" in current
            current = tags.get(current.get("parentId"))
        page = reader.pages[page_number - 1]
        annotation = resolved(page["/Annots"][index - 1])
        if not include_existing and "/Contents" in annotation:
            continue
        if overrides or any(key in annotation for key in ("/Alt", "/ActualText", "/OC")):
            continue
        action = resolved(annotation.get("/A"))
        if "/A" in annotation and "/Dest" in annotation:
            continue
        if reference.get("actionType") == "URI":
            if not isinstance(action, dict) or not isinstance(action.get("/URI"), TextStringObject) or not re.match(r"^(?:https?://|mailto:|tel:)\S+$", str(action["/URI"]), re.I):
                continue
        elif reference.get("destinationResolved") is not True or (action is not None and reference.get("actionType") != "GoTo"):
            continue
        try:
            rectangle = [float(value) for value in resolved(annotation.get("/Rect", ArrayObject()))]
            crop = [float(value) for value in page.cropbox]
            flags = int(annotation.get("/F", 0))
            if (len(rectangle) != 4 or not all(math.isfinite(value) for value in rectangle + crop)
                    or flags & (1 | 2 | 32) or not crop[0] <= rectangle[0] < rectangle[2] <= crop[2]
                    or not crop[1] <= rectangle[1] < rectangle[3] <= crop[3]):
                continue
        except (ValueError, TypeError):
            continue
        label = link_label(tag.get("text"))
        if label is None or label != link_label("".join(item.get("text") or "" for item in marks)):
            continue
        # Optional cleanup must not consume unbounded scans or reject the PDF
        # simply because further links need review. Candidate matching examines
        # only these source-proven targets, avoiding differences in scan order.
        if paint_attempts >= MAX_LINK_DESCRIPTIONS:
            break
        paint_attempts += 1
        if page_number not in page_operations:
            page_operations[page_number] = verify_pdf.operations(page)
        scanned_operations += len(page_operations[page_number])
        if scanned_operations > MAX_LINK_SCAN_OPERATIONS:
            break
        if not simple_link_paint(page, {item["mcid"] for item in marks}, rectangle, page_operations[page_number]):
            continue
        result[key] = {"label": label, "tagId": tag["id"],
                       "sequence": [{name: value for name, value in item.items() if name != "description"} for item in sequence],
                       "state": {name: value for name, value in states[key].items() if name != "/Contents"}}
    return result


def verify_added_link_descriptions(original, candidate):
    # This increment does not infer link labels for OpenDataLoader's new tags.
    if original.trailer["/Root"].get("/StructTreeRoot") is None:
        return
    before, after = annotation_states(original), annotation_states(candidate)
    additions = [key for key in before if "/Contents" not in before[key] and "/Contents" in after.get(key, {})]
    if not additions:
        return
    source_links = native_link_descriptions(original)
    candidate_links = native_link_descriptions(candidate, targets=source_links, include_existing=True)
    if len(additions) > MAX_LINK_DESCRIPTIONS:
        fail("pdf_complexity_limit")
    for key in additions:
        expected = source_links.get(key)
        annotation = resolved(candidate.pages[key[0] - 1]["/Annots"][key[1] - 1])
        if (expected is None or candidate_links.get(key) != expected
                or not isinstance(annotation.get("/Contents"), TextStringObject)
                or str(annotation["/Contents"]) != expected["label"]):
            fail("native_pdf_preservation")


def add_link_descriptions(original, candidate, writer):
    source_links = native_link_descriptions(original)
    candidate_links = native_link_descriptions(candidate, targets=source_links, include_existing=True)
    changes = []
    for key, expected in source_links.items():
        old = resolved(original.pages[key[0] - 1]["/Annots"][key[1] - 1])
        if "/Contents" in old or candidate_links.get(key) != expected:
            continue
        annotation = resolved(writer.pages[key[0] - 1]["/Annots"][key[1] - 1])
        if "/Contents" in annotation:
            continue
        if len(changes) >= MAX_LINK_DESCRIPTIONS:
            break
        annotation[NameObject("/Contents")] = TextStringObject(expected["label"])
        changes.append({"code": "link_description_added", "message": "Added the link's existing visible text as its description.",
                        "tagId": expected["tagId"], "pageNumber": key[0]})
    return changes


def verify_saved_annotations(original, before, after):
    old, new = annotation_states(before), annotation_states(after)
    if old.keys() != new.keys():
        fail("native_pdf_preservation")
    for key, value in old.items():
        changed = new[key]
        if "/Contents" not in value and "/Contents" in changed:
            changed = {name: digest for name, digest in changed.items() if name != "/Contents"}
        if changed != value:
            fail("native_pdf_preservation")
    verify_added_link_descriptions(original, after)


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


def apply_plan(original, candidate, plan, output, *, lineage=None):
    if not isinstance(plan, dict) or set(plan) - {"schemaVersion", "candidateSha256", "language", "title", "operations"} or type(plan.get("schemaVersion")) is not int or plan["schemaVersion"] != 1 or plan.get("candidateSha256") != digest(candidate.stream.getvalue()):
        fail("native_pdf_invalid_plan")
    operations = plan.get("operations")
    if not isinstance(operations, list) or len(operations) > MAX_OPS:
        fail("native_pdf_invalid_plan")
    verify_added_link_descriptions(original, candidate)
    try:
        verify_authored_ids(original, candidate)
    except NoteIdError:
        fail("native_pdf_preservation")
    inventory = enrich_inventory(candidate, original)
    nodes = native_nodes(candidate)
    if len(nodes) != len(inventory["tags"]) or any(str(node.get("/S", "")).lstrip("/") != tag["sourceRole"] for node, tag in zip(nodes, inventory["tags"])):
        fail("native_pdf_preservation")
    writer = PdfWriter(clone_from=candidate)
    targets = native_nodes(writer)
    changes = add_link_descriptions(original, candidate, writer)
    changes.extend(set_metadata(writer, plan.get("title"), plan.get("language")))
    used = set()
    structure_operations = []
    for operation in operations:
        if not isinstance(operation, dict) or operation.get("type") not in ("set_role", "set_alt", "set_table_header", "repair_structure"):
            fail("native_pdf_invalid_plan")
        identifier = operation.get("tagId")
        if not isinstance(identifier, str) or not re.fullmatch(r"tag-[1-9][0-9]{0,4}", identifier) or identifier in used:
            fail("native_pdf_invalid_plan")
        used.add(identifier)
        index = int(identifier[4:]) - 1
        if index >= len(targets):
            fail("native_pdf_invalid_plan")
        tag, target = inventory["tags"][index], targets[index]
        if operation.get("expected") != tag["snapshot"]:
            fail("native_pdf_invalid_plan")
        if operation["type"] == "repair_structure":
            if (set(operation) - {"type", "tagId", "expected", "candidateId", "role"}
                    or not isinstance(operation.get("candidateId"), str)):
                fail("native_pdf_invalid_plan")
            structure_operations.append({key: value for key, value in operation.items() if key != "expected"})
            continue
        value_key, edit_key = {"set_role": ("role", "role"), "set_alt": ("alt", "alt"), "set_table_header": ("scope", "tableHeader")}[operation["type"]]
        if set(operation) != {"type", "tagId", "expected", value_key} or not tag["editable"][edit_key]:
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
    try:
        authored_bindings = authored_id_bindings(writer)
        structural = apply_operations(candidate, writer, structure_operations) if structure_operations else {
            "changes": [], "lineage": [{"node": node, "sourceTagId": f"tag-{index + 1}"} for index, node in enumerate(targets)]}
        verify_authored_id_bindings(authored_bindings, writer)
    except SemanticStructureError as error:
        fail(str(error) if str(error) in {"native_pdf_invalid_plan", "native_pdf_preservation", "pdf_complexity_limit"} else "native_pdf_worker_failed")
    except NoteIdError:
        fail("native_pdf_preservation")
    changes.extend(structural["changes"])
    final_positions = {id(node): f"tag-{index + 1}" for index, node in enumerate(native_nodes(writer))}
    source_lineage = {f"tag-{index + 1}": final_positions[id(node)]
                      for index, node in enumerate(targets) if id(node) in final_positions}
    for change in changes:
        if change.get("tagId") in source_lineage:
            change["tagId"] = source_lineage[change["tagId"]]
        if "relatedTagIds" in change:
            change["relatedTagIds"] = [source_lineage[tag_id] for tag_id in change["relatedTagIds"]]
    if lineage is not None:
        lineage["sourceTagLineage"] = source_lineage
        lineage["sourceTagIds"] = {final_positions[id(entry["node"])]: entry["sourceTagId"]
                                   for entry in structural["lineage"] if id(entry["node"]) in final_positions}
    note_before = note_id_snapshot(writer)
    changes.extend(repair_note_ids(writer))
    reopened = write_pdf(writer, output)
    try:
        verify_note_ids(note_before, reopened)
        verify_authored_ids(original, reopened)
    except NoteIdError:
        fail("native_pdf_preservation")
    verify_saved_annotations(original, candidate, reopened)
    actual = enrich_inventory(reopened, original)
    if len(actual["tags"]) != len(final_positions):
        fail("native_pdf_preservation")
    for operation in operations:
        if operation["type"] == "repair_structure":
            continue
        tag = actual["tags"][int(source_lineage[operation["tagId"]][4:]) - 1]
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
        "structure_candidates_limited": "Automatic heading, list and footnote repair suggestions could not be completed within the processing limit. Review those parts of the PDF; the other document checks still ran.",
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


def response(original_path, candidate_path, changes, toolchain, *, preservation_source_path=None, hybrid_summary=None, lineage=None):
    before = open_pdf(original_path.read_bytes())
    after = open_pdf(candidate_path.read_bytes())
    verify_added_link_descriptions(before, after)
    checks = verify_pdf.compare_pdfs(preservation_source_path or original_path, candidate_path)
    # Preservation failures cannot be waived by a model or converted to a
    # normal warning. Incomplete semantic inspection remains a visible issue.
    if checks.get("inspection_incomplete") or not checks.get("preservation", {}).get("passed") or checks.get("findings"):
        fail("native_pdf_preservation")
    inventory = enrich_inventory(after, before)
    if lineage is not None:
        inventory["sourceTagLineage"] = lineage["sourceTagLineage"]
        for tag in inventory["tags"]:
            tag["sourceTagId"] = lineage["sourceTagIds"].get(tag["id"])
    if hybrid_summary is not None:
        inventory["forms"]["hybrid"] = hybrid_summary
    if inventory.get("checks_complete") is not True:
        fail("native_pdf_preservation")
    vera = validate_ua(candidate_path, toolchain)
    findings = [normalized_finding(item, inventory) for item in inventory.get("findings", [])]
    if hybrid_summary is not None:
        findings.append({
            "code": "legacy_form_interaction_review", "severity": "warning", "location": "Fillable form fields",
            "message": "This PDF uses an older Adobe form format. Its fields and form logic have been kept. Supported field descriptions and announcement settings were repaired where the source provided enough information; actual operation still needs a check in a PDF reader.",
            "suggestion": "Open the downloaded PDF in Adobe Acrobat Reader. Check that each field announces a useful name, checkbox choices work as expected, and entered values remain after saving and reopening."
        })
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
                              **({"renderingEquivalence": checks["preservation"]["rendering_equivalence"]}
                                 if "rendering_equivalence" in checks["preservation"] else {}),
                              "targetStandard": "PDF/UA-1 (ISO 14289-1:2014)", "veraPdf": vera, "conformanceClaim": False}}


def prepared_source(source, source_path, directory):
    """Derive and independently verify the sole hybrid-form exception.

    Model repair requests repeat this derivation from immutable source bytes;
    a caller's prepared PDF or ledger can never authorize a form change.
    """
    original = open_pdf(source)
    source_path.write_bytes(source)
    context = inspect_hybrid(original)
    if context is None:
        return original, source_path, [], None
    writer = PdfWriter(clone_from=original)
    prepare_hybrid(writer)
    reference_path = directory / "verified-form-source.pdf"
    reference = write_pdf(writer, reference_path)
    try:
        verification = verify_hybrid_preparation(source, reference_path.read_bytes())
    except HybridVerificationError:
        fail("native_pdf_preservation")
    added = sum(field.needs_tooltip for field in context.fields)
    changes = []
    if context.has_reader_rights:
        changes.append({"code": "legacy_reader_rights_removed", "message": "Removed obsolete Adobe Reader usage rights from the repaired copy so it can be edited. The original PDF was kept."})
    if added:
        changes.append({"code": "authored_form_labels_added", "message": f"Copied existing descriptions into {added} standard PDF form fields without changing their values or positions."})
    name_changes = verification.get("accessibleNameChanges", [])
    speech_enabled = verification.get("speechPromptsEnabled", [])
    if name_changes:
        changes.append({"code": "form_label_context_added", "message": f"Added the source's group name to {len(name_changes)} number-entry field descriptions so each part identifies what number to enter."})
    if speech_enabled:
        changes.append({"code": "form_speech_enabled", "message": f"Enabled the existing spoken descriptions for {len(speech_enabled)} form fields."})
    summary = {"type": "static-xfa-with-acroform", "xfaStructurePreserved": True, "formLogicPreserved": True,
               "nativeFieldDescriptionsAdded": added, "readerUsageRightsRemoved": context.has_reader_rights,
               "accessibleNameChanges": name_changes, "speechPromptsEnabled": speech_enabled,
               "verifiedMetadataOnly": True,
               "interactiveViewerReviewRequired": True, "verification": verification}
    return reference, reference_path, changes, summary


def process(mode, request_path, directory, toolchain):
    source_path, output_path = directory / "source.pdf", directory / "output.pdf"
    lineage = None
    if mode == "prepare":
        source = request_path.read_bytes()
        original, reference_path, changes, hybrid_summary = prepared_source(source, source_path, directory)
        if original.trailer["/Root"].get("/StructTreeRoot") is None:
            tool = toolchain["openDataLoader"]
            tag_directory = directory / "tagged"
            tag_directory.mkdir()
            code, _ = run_bounded(java_command(tool, ["--quiet", "--format", "tagged-pdf", "--hybrid", "off", "--threads", "1", "--image-output", "off", "--include-header-footer", "--output-dir", str(tag_directory), str(reference_path)], directory), directory=directory, timeout=40)
            tagged = tag_directory / f"{reference_path.stem}_tagged.pdf"
            if code != 0 or not tagged.is_file() or tagged.stat().st_size > MAX_PDF:
                fail("native_pdf_worker_failed")
            candidate = open_pdf(tagged.read_bytes())
            changes.append({"code": "native_tags_added", "message": "Added native reading-order and content tags while preserving the original pages."})
        else:
            candidate = original
        writer = PdfWriter(clone_from=candidate)
        changes.extend(add_link_descriptions(original, candidate, writer))
        changes.extend(set_metadata(writer))
        note_before = note_id_snapshot(writer)
        changes.extend(repair_note_ids(writer))
        reopened = write_pdf(writer, output_path)
        try:
            verify_note_ids(note_before, reopened)
            verify_authored_ids(original, reopened)
        except NoteIdError:
            fail("native_pdf_preservation")
        verify_saved_annotations(original, candidate, reopened)
    elif mode == "repair":
        try:
            data = json.loads(request_path.read_bytes())
        except Exception:
            fail("native_pdf_invalid_plan")
        if not isinstance(data, dict) or set(data) != {"sourcePdfBase64", "candidatePdfBase64", "plan"}:
            fail("native_pdf_invalid_plan")
        source = decode_pdf(data["sourcePdfBase64"])
        candidate_bytes = decode_pdf(data["candidatePdfBase64"])
        original, reference_path, _, hybrid_summary = prepared_source(source, source_path, directory)
        candidate = open_pdf(candidate_bytes)
        baseline = directory / "baseline.pdf"
        baseline.write_bytes(candidate_bytes)
        # Validate the caller-provided prepared file before using its IDs.
        comparison = verify_pdf.compare_pdfs(reference_path, baseline)
        if comparison.get("inspection_incomplete") or not comparison.get("preservation", {}).get("passed") or comparison.get("findings"):
            fail("native_pdf_preservation")
        lineage = {}
        changes = apply_plan(original, candidate, data["plan"], output_path, lineage=lineage)
    else:
        fail("native_pdf_invalid_plan")
    return response(source_path, output_path, changes, toolchain,
                    preservation_source_path=reference_path, hybrid_summary=hybrid_summary, lineage=lineage)


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
