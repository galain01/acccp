"""Independent, local-only native PDF preservation checks; not PDF/UA certification.

Run with the bundled Python runtime. Reads PDFs, writes only a JSON report, and
uses PDFium independently of the app's PDF.js rendering implementation.
"""
from __future__ import annotations

import argparse
import copy
import hashlib
import json
import logging
import math
import re
from collections import Counter
from pathlib import Path
import sys
from typing import Any

from pypdf import PdfReader
from pypdf.generic import ArrayObject, ByteStringObject, ContentStream, DictionaryObject, IndirectObject, NameObject, StreamObject, TextStringObject

MAX_FILE_BYTES = 4 * 1024 * 1024
MAX_PAGES = 60
MAX_NODES = 100_000
MAX_DEPTH = 64
MAX_STREAM_BYTES = 64 * 1024 * 1024
MAX_TOTAL_STREAM_BYTES = 256 * 1024 * 1024
MAX_OPERATORS = 200_000
MAX_TEXT_CHARS = 500_000
MAX_PAGE_PIXELS = 4_000_000
MAX_FINDINGS = 100
MAX_TAGS = 10_000
MAX_ALT_CHARS = 128_000
MAX_REPORT_BYTES = 16 * 1024 * 1024
RENDER_SCALE = 1.5
STANDARD_ROLES = {"Document", "Part", "Art", "Sect", "Div", "BlockQuote", "Caption", "TOC", "TOCI", "Index", "NonStruct", "Private", "P", "H", "H1", "H2", "H3", "H4", "H5", "H6", "L", "LI", "Lbl", "LBody", "Table", "TR", "TH", "TD", "THead", "TBody", "TFoot", "Span", "Quote", "Note", "Reference", "BibEntry", "Code", "Link", "Annot", "Ruby", "RB", "RT", "RP", "Warichu", "WT", "WP", "Figure", "Formula", "Form"}


class InspectionError(Exception):
    """Contains only a controlled diagnostic code; never raw document content."""


def resolved(value: Any) -> Any:
    return value.get_object() if isinstance(value, IndirectObject) else value


def digest(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def pdf_boolean(value: Any) -> bool:
    value = resolved(value)
    return bool(value.value) if type(value).__name__ == "BooleanObject" else value is True


def reference_key(value: Any) -> tuple[int, int] | None:
    ref = value if isinstance(value, IndirectObject) else getattr(value, "indirect_reference", None)
    return (ref.idnum, ref.generation) if isinstance(ref, IndirectObject) else None


def integer(value: Any) -> int | None:
    value = resolved(value)
    if isinstance(value, bool):
        return None
    try:
        number = int(value)
        return number if number >= 0 and number == value else None
    except (TypeError, ValueError, OverflowError):
        return None


class Canonicalizer:
    """Compares decoded objects without depending on renumbered indirect IDs."""

    def __init__(self, pages: list[Any] | None = None):
        self.pages = {id(resolved(page)): index for index, page in enumerate(pages or [])}
        self.page_refs = {reference_key(page): index for index, page in enumerate(pages or []) if reference_key(page) is not None}
        self.nodes = 0
        self.stream_bytes = 0
        self.memo: dict[int, int] = {}

    def value(self, item: Any, active: dict[int, int] | None = None, depth: int = 0) -> Any:
        if depth == 0:
            self.memo = {}
        self.nodes += 1
        if self.nodes > MAX_NODES or depth > MAX_DEPTH:
            raise InspectionError("object_complexity_limit")
        if reference_key(item) in self.page_refs:
            return {"page": self.page_refs[reference_key(item)]}
        item = resolved(item)
        if id(item) in self.pages:
            return {"page": self.pages[id(item)]}
        active = {} if active is None else active
        if isinstance(item, (DictionaryObject, dict, ArrayObject, list, tuple)):
            if id(item) in active:
                return {"cycle": active[id(item)]}
            if id(item) in self.memo:
                return {"shared": self.memo[id(item)]}
            self.memo[id(item)] = len(self.memo)
            active = {**active, id(item): depth}
        if isinstance(item, (DictionaryObject, dict)):
            ignored = {"/StructParent", "/StructParents"}
            if item.get("/Subtype") in ("/Link", "/Widget"):
                # Annotation description preservation is checked separately;
                # newly added labels must not count as changed functionality.
                ignored.add("/Contents")
            if isinstance(item, StreamObject):
                ignored |= {"/Length", "/Filter", "/DecodeParms"}
            result = {str(key): self.value(item[key], active, depth + 1) for key in sorted(item, key=str) if str(key) not in ignored}
            if isinstance(item, StreamObject):
                data = item.get_data()
                self.stream_bytes += len(data)
                if len(data) > MAX_STREAM_BYTES or self.stream_bytes > MAX_TOTAL_STREAM_BYTES:
                    raise InspectionError("stream_size_limit")
                if item.get("/Subtype") == "/Form":
                    document = getattr(getattr(item, "indirect_reference", None), "pdf", None)
                    stream_ops = ContentStream(item, document).operations
                    if len(stream_ops) > MAX_OPERATORS:
                        raise InspectionError("operator_limit")
                    result["drawing_operations_sha256"] = drawing_fingerprint(stream_ops, Canonicalizer())
                else:
                    result["decoded_stream_sha256"] = digest(data)
            return result
        if isinstance(item, (ArrayObject, list, tuple)):
            return [self.value(entry, active, depth + 1) for entry in item]
        if isinstance(item, (ByteStringObject, bytes, bytearray)):
            return {"bytes_sha256": digest(bytes(item)), "length": len(item)}
        if isinstance(item, (TextStringObject, NameObject, str)):
            if len(item) > MAX_TEXT_CHARS:
                raise InspectionError("text_size_limit")
            return str(item)
        if item is None or isinstance(item, (int, bool)):
            return item
        if isinstance(item, float):
            if not math.isfinite(item):
                raise InspectionError("invalid_number")
            return float(item)
        # pypdf NullObject and BooleanObject do not inherit Python primitives.
        if type(item).__name__ == "NullObject":
            return None
        if type(item).__name__ == "BooleanObject":
            return bool(item.value)
        raise InspectionError("unsupported_pdf_object")

    def hash(self, item: Any) -> str:
        return digest(json.dumps(self.value(item), sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode())


def operations(page: Any) -> list[tuple[Any, bytes]]:
    content = page.get_contents()
    if content is None:
        return []
    result = content.operations
    if len(result) > MAX_OPERATORS:
        raise InspectionError("operator_limit")
    return result


def drawing_fingerprint(ops: list[tuple[Any, bytes]], canonical: Canonicalizer) -> str:
    """Only tag wrappers/marked-content points may change, never painting ops."""
    ignored = {b"BMC", b"BDC", b"EMC", b"MP", b"DP"}
    retained: list[Any] = []
    pending: list[Any] = []
    def flush() -> None:
        if pending:
            retained.append(("text_show", list(pending)))
            pending.clear()
    for operands, operator in ops:
        if operator in ignored:
            continue
        if operator in (b"Tj", b"TJ"):
            pieces = operands if operator == b"Tj" else operands[0]
            for piece in pieces:
                if isinstance(piece, (str, bytes)):
                    raw = piece.original_bytes if isinstance(piece, TextStringObject) else bytes(piece) if isinstance(piece, bytes) else str(piece).encode("utf-8")
                    text_piece = {"hex": raw.hex()}
                    if pending and isinstance(pending[-1], dict):
                        pending[-1]["hex"] += text_piece["hex"]
                    elif raw:
                        pending.append(text_piece)
                else:
                    number = float(piece)
                    if number:
                        if pending and isinstance(pending[-1], (float, int)):
                            pending[-1] += number
                        else:
                            pending.append(number)
            continue
        flush()
        retained.append((operator.decode("ascii"), canonical.value(operands)))
    flush()
    return digest(json.dumps(retained, ensure_ascii=True, separators=(",", ":")).encode())


def scan_marked_content(ops: list[tuple[Any, bytes]], properties: Any = None) -> dict[str, Any]:
    stack: list[tuple[int | None, bool]] = []
    mcids: set[int] = set()
    text_owners: set[int] = set()
    unowned_text = 0
    artifact_text = 0
    properties = resolved(properties or {})
    unsupported = False
    for operands, operator in ops:
        if operator in (b"BMC", b"BDC"):
            if not operands or len(stack) >= MAX_DEPTH:
                raise InspectionError("invalid_marked_content")
            artifact = str(operands[0]) == "/Artifact"
            mcid = None
            if operator == b"BDC":
                if len(operands) != 2:
                    raise InspectionError("invalid_marked_content")
                props = resolved(operands[1])
                if isinstance(props, NameObject):
                    props = resolved(properties.get(props))
                if not isinstance(props, dict):
                    raise InspectionError("invalid_marked_content_properties")
                if "/MCID" in props:
                    mcid = integer(props["/MCID"])
                    if mcid is None or mcid in mcids or artifact:
                        raise InspectionError("duplicate_or_invalid_mcid")
                    if any(owner is not None for owner, _ in stack):
                        raise InspectionError("nested_mcid")
                    mcids.add(mcid)
            stack.append((mcid, artifact))
        elif operator == b"EMC":
            if not stack:
                raise InspectionError("unbalanced_marked_content")
            stack.pop()
        elif operator in (b"Do", b"INLINE IMAGE"):
            unsupported = True
        elif operator in (b"Tj", b"TJ", b"'", b'"'):
            strings = operands[-1:] if operator != b"TJ" else (operands[0] if operands else [])
            if not any(isinstance(value, (str, bytes)) and len(value) for value in strings):
                continue
            if any(artifact for _, artifact in stack):
                artifact_text += 1
            else:
                owner = next((owner for owner, _ in reversed(stack) if owner is not None), None)
                if owner is None:
                    unowned_text += 1
                else:
                    text_owners.add(owner)
    if stack:
        raise InspectionError("unbalanced_marked_content")
    return {"mcids": mcids, "text_owners": text_owners, "unowned_text_operators": unowned_text, "artifact_text_operators": artifact_text, "unsupported_xobject_or_inline_image": unsupported}


def number_tree(root: Any) -> dict[int, Any]:
    result: dict[int, Any] = {}
    seen: set[int] = set()
    pending = [(resolved(root), 0)]
    while pending:
        node, depth = pending.pop()
        if not isinstance(node, dict) or id(node) in seen or depth > MAX_DEPTH or len(seen) >= MAX_NODES:
            raise InspectionError("invalid_parent_tree")
        seen.add(id(node))
        nums, kids = resolved(node.get("/Nums")), resolved(node.get("/Kids"))
        if nums is not None and kids is not None:
            raise InspectionError("invalid_parent_tree")
        if nums is not None:
            if not isinstance(nums, list) or len(nums) % 2:
                raise InspectionError("invalid_parent_tree")
            previous = -1
            for offset in range(0, len(nums), 2):
                key = integer(nums[offset])
                if key is None or key <= previous or key in result:
                    raise InspectionError("invalid_parent_tree")
                result[key] = resolved(nums[offset + 1])
                previous = key
        elif isinstance(kids, list):
            pending.extend((resolved(child), depth + 1) for child in reversed(kids))
        else:
            raise InspectionError("invalid_parent_tree")
    return result


def check_structure(reader: PdfReader) -> dict[str, Any]:
    pages = list(reader.pages)
    catalog = reader.trailer["/Root"]
    root = resolved(catalog.get("/StructTreeRoot"))
    if not isinstance(root, dict):
        raise InspectionError("missing_structure_tree")
    if not pdf_boolean(resolved(catalog.get("/MarkInfo", {})).get("/Marked")):
        raise InspectionError("missing_marked_flag")
    if not isinstance(catalog.get("/Lang"), str) or not catalog["/Lang"].strip():
        raise InspectionError("missing_document_language")
    parent_tree = number_tree(root.get("/ParentTree"))
    page_lookup = {reference_key(page): index for index, page in enumerate(pages)}
    scans = [scan_marked_content(operations(page), resolved(page.get("/Resources", {})).get("/Properties")) for page in pages]
    if any(scan["unsupported_xobject_or_inline_image"] for scan in scans):
        raise InspectionError("unsupported_content_for_initial_subset")
    if any(scan["unowned_text_operators"] for scan in scans):
        raise InspectionError("untagged_text_content")
    # Artifact decisions need independent semantic review; do not silently pass.
    if any(scan["artifact_text_operators"] for scan in scans):
        raise InspectionError("artifact_text_requires_review")
    owners: dict[tuple[int, int], Any] = {}
    seen_nodes: set[int] = set()
    roles: dict[str, int] = {}
    role_map = resolved(root.get("/RoleMap", {}))

    def add_owner(page_index: int | None, mcid: Any, owner: Any) -> None:
        parsed = integer(mcid)
        if page_index is None or parsed is None or (page_index, parsed) in owners:
            raise InspectionError("duplicate_or_invalid_structure_content")
        owners[(page_index, parsed)] = owner

    def visit(item: Any, parent: Any, page_index: int | None = None, depth: int = 0) -> None:
        item = resolved(item)
        if depth > MAX_DEPTH or len(seen_nodes) > MAX_NODES:
            raise InspectionError("structure_complexity_limit")
        if isinstance(item, list):
            for child in item:
                visit(child, parent, page_index, depth + 1)
            return
        if integer(item) is not None:
            add_owner(page_index, item, parent)
            return
        if not isinstance(item, dict):
            raise InspectionError("invalid_structure_child")
        if "/Pg" in item:
            page_index = page_lookup.get(reference_key(item["/Pg"]))
            if page_index is None:
                raise InspectionError("invalid_structure_page")
        if str(item.get("/Type")) == "/MCR":
            if "/Stm" in item:
                raise InspectionError("unsupported_form_content_reference")
            add_owner(page_index, item.get("/MCID"), parent)
            return
        if str(item.get("/Type")) != "/StructElem" or id(item) in seen_nodes:
            raise InspectionError("invalid_or_reused_structure_element")
        seen_nodes.add(id(item))
        if resolved(item.get("/P")) is not parent:
            raise InspectionError("invalid_structure_parent")
        role = str(item.get("/S", ""))
        visited_roles: set[str] = set()
        while role.startswith("/") and role[1:] not in STANDARD_ROLES:
            if role in visited_roles or role not in role_map:
                raise InspectionError("unmapped_structure_role")
            visited_roles.add(role)
            role = str(resolved(role_map[role]))
        if not role.startswith("/") or role[1:] not in STANDARD_ROLES:
            raise InspectionError("invalid_structure_role")
        roles[role[1:]] = roles.get(role[1:], 0) + 1
        if "/K" not in item:
            raise InspectionError("empty_structure_element")
        visit(item["/K"], item, page_index, depth + 1)

    visit(root.get("/K"), root)
    seen_parent_keys: set[int] = set()
    total_mcids = 0
    for index, (page, scan) in enumerate(zip(pages, scans)):
        key = integer(page.get("/StructParents"))
        if key is None or key in seen_parent_keys or key not in parent_tree:
            raise InspectionError("missing_or_duplicate_structparents")
        seen_parent_keys.add(key)
        array = parent_tree[key]
        if not isinstance(array, list):
            raise InspectionError("invalid_page_parent_array")
        actual = {mcid for page_number, mcid in owners if page_number == index}
        if actual != scan["mcids"]:
            raise InspectionError("structure_content_coverage_mismatch")
        for mcid in actual:
            if mcid >= len(array) or resolved(array[mcid]) is not owners[(index, mcid)]:
                raise InspectionError("parent_tree_owner_mismatch")
        for mcid, entry in enumerate(array):
            if resolved(entry) is not None and type(resolved(entry)).__name__ != "NullObject" and mcid not in actual:
                raise InspectionError("orphan_parent_tree_entry")
        total_mcids += len(actual)
    if set(parent_tree) != seen_parent_keys:
        raise InspectionError("unreferenced_parent_tree_keys")
    return {"passed": True, "pages": len(pages), "structure_elements": len(seen_nodes), "mcids": total_mcids, "roles": roles, "scope": "text-only page content; semantic correctness requires auditor review"}


def rendered_page_hashes(path: Path) -> list[dict[str, Any]]:
    import pypdfium2 as pdfium
    document = pdfium.PdfDocument(str(path))
    result = []
    try:
        for page_number in range(len(document)):
            page = document[page_number]
            try:
                width, height = page.get_size()
                if not math.isfinite(width + height) or width <= 0 or height <= 0 or math.ceil(width * RENDER_SCALE) * math.ceil(height * RENDER_SCALE) > MAX_PAGE_PIXELS:
                    raise InspectionError("render_pixel_limit")
                bitmap = page.render(scale=RENDER_SCALE, rotation=0, draw_annots=True)
                try:
                    image = bitmap.to_pil().convert("RGB")
                    result.append({"width": image.width, "height": image.height, "sha256": digest(image.tobytes())})
                finally:
                    bitmap.close()
            finally:
                page.close()
    finally:
        document.close()
    return result


def page_behavior_values(pair: tuple[Any, Any]) -> tuple[dict[str, Any], dict[str, Any], int]:
    values = [{key: value for key, value in page.items() if str(key) not in {"/Type", "/Parent", "/Contents", "/Resources", "/StructParents", "/Tabs"}} for page in pair]
    added_labels = 0
    left = resolved(pair[0].get("/Annots", []))
    right = resolved(pair[1].get("/Annots", []))
    if len(left) == len(right) and left:
        normalized = []
        for old, new in zip(left, right):
            old, new = resolved(old), resolved(new)
            # A newly supplied link description is an intended accessibility
            # metadata change, while changing an authored description is visible.
            if old.get("/Subtype") == new.get("/Subtype") == "/Link" and "/Contents" not in old and "/Contents" in new:
                normalized.append({key: value for key, value in new.items() if key != "/Contents"})
                added_labels += 1
            else:
                normalized.append(new)
        values[1]["/Annots"] = normalized
    return values[0], values[1], added_labels


def font_image_inventory(reader: PdfReader) -> dict[str, Any]:
    seen: set[int] = set()
    fonts: set[str] = set()
    images: set[str] = set()
    streams = 0
    def visit(resources: Any, depth: int = 0) -> None:
        nonlocal streams
        resources = resolved(resources)
        if not isinstance(resources, dict) or id(resources) in seen:
            return
        if depth > MAX_DEPTH or len(seen) > MAX_NODES:
            raise InspectionError("resource_complexity_limit")
        seen.add(id(resources))
        for value in resolved(resources.get("/Font", {})).values():
            fonts.add(Canonicalizer().hash(value))
        for value in resolved(resources.get("/XObject", {})).values():
            value = resolved(value)
            if value.get("/Subtype") == "/Image":
                images.add(Canonicalizer().hash(value))
            elif value.get("/Subtype") == "/Form":
                streams += 1
                visit(value.get("/Resources", {}), depth + 1)
    for page in reader.pages:
        visit(page.get("/Resources", {}))
    return {"font_hashes": sorted(fonts), "image_hashes": sorted(images), "form_xobject_occurrences": streams}


def form_inventory(reader: PdfReader) -> dict[str, Any]:
    fields = reader.get_fields() or {}
    values = {}
    for name, field in fields.items():
        values[name] = Canonicalizer().hash({key: field.get(key) for key in ("/FT", "/V", "/DV", "/Ff", "/Opt", "/MaxLen", "/AA", "/A", "/TU", "/TM")})
    widgets = sum(str(resolved(annotation).get("/Subtype")) == "/Widget" for page in reader.pages for annotation in resolved(page.get("/Annots", [])))
    return {"field_count": len(fields), "widget_count": widgets, "field_values_types_flags_actions_labels_hash": digest(json.dumps(values, sort_keys=True).encode()), "xfa_hash": Canonicalizer().hash(resolved(reader.trailer["/Root"].get("/AcroForm", {})).get("/XFA"))}


def native_string(value: Any, limit: int = 512) -> tuple[str, str]:
    """Expose human text plus exact ID bytes so byte-string IDs cannot collide."""
    value = resolved(value)
    if isinstance(value, TextStringObject):
        raw = value.original_bytes
        text = str(value)
    elif isinstance(value, (ByteStringObject, bytes)):
        raw = bytes(value)
        try:
            text = raw.decode("utf-8")
        except UnicodeError:
            text = "hex:" + raw.hex()
    elif isinstance(value, str):
        raw, text = value.encode("utf-8"), value
    else:
        raise InspectionError("invalid_native_string")
    if len(raw) > limit or len(text) > limit:
        raise InspectionError("native_string_limit")
    return text, raw.hex()


def tag_attributes(item: Any, class_map: Any) -> tuple[list[dict[str, Any]], list[str]]:
    """Read direct and class-based attributes; retain order and revisions."""
    result: list[dict[str, Any]] = []
    gaps: list[str] = []
    def append(value: Any, source: str, class_name: str | None = None) -> None:
        value = resolved(value)
        entries = value if isinstance(value, list) else [value]
        if len(entries) > 128:
            raise InspectionError("attribute_count_limit")
        previous = None
        for entry in entries:
            entry = resolved(entry)
            revision = integer(entry)
            if revision is not None:
                if previous is None:
                    gaps.append("orphan_attribute_revision")
                else:
                    previous["revision"] = revision
                continue
            if not isinstance(entry, dict):
                gaps.append("unsupported_attribute_entry")
                continue
            attribute: dict[str, Any] = {"source": source, "owner": str(entry.get("/O", "")).lstrip("/")[:100]}
            if class_name is not None:
                attribute["className"] = class_name
            if "/Scope" in entry:
                attribute["scope"] = str(resolved(entry["/Scope"])).lstrip("/")[:100]
                if attribute["owner"] != "Table" or attribute["scope"] not in {"Row", "Column", "Both"}:
                    gaps.append("invalid_table_scope_attribute")
            for key, output in (("/RowSpan", "rowSpan"), ("/ColSpan", "colSpan")):
                if key in entry:
                    span = integer(entry[key])
                    if span is None or not 1 <= span <= 10000:
                        gaps.append("invalid_table_span_attribute")
                    else:
                        attribute[output] = span
            if "/Headers" in entry:
                headers = resolved(entry["/Headers"])
                if not isinstance(headers, list) or len(headers) > 128:
                    gaps.append("invalid_table_headers_attribute")
                else:
                    values = [native_string(header) for header in headers]
                    attribute["headers"] = [text for text, _ in values]
                    attribute["headersHex"] = [raw for _, raw in values]
            result.append(attribute)
            previous = attribute
    # Class attributes appear first, followed by direct attributes that override
    # them. We preserve all records rather than guessing effective revisions.
    classes = resolved(item.get("/C"))
    if classes is not None:
        classes = classes if isinstance(classes, list) else [classes]
        if len(classes) > 128:
            raise InspectionError("attribute_count_limit")
        for entry in classes:
            entry = resolved(entry)
            if integer(entry) is not None:
                continue
            if not isinstance(entry, NameObject) or not isinstance(class_map, dict) or entry not in class_map:
                gaps.append("unresolved_attribute_class")
                continue
            append(class_map[entry], "class", str(entry).lstrip("/")[:100])
    if "/A" in item:
        append(item["/A"], "direct")
    return result, gaps


def structure_inventory(reader: PdfReader) -> dict[str, Any]:
    """Read actual saved tags; do not infer associations from visual proximity."""
    pages = list(reader.pages)
    lookup = {reference_key(page): index + 1 for index, page in enumerate(pages)}
    catalog = reader.trailer["/Root"]
    root = resolved(catalog.get("/StructTreeRoot"))
    info: dict[str, Any] = {"tagged": isinstance(root, dict), "marked": pdf_boolean(resolved(catalog.get("/MarkInfo", {})).get("/Marked")), "language": str(catalog.get("/Lang", ""))[:100], "title": str((reader.metadata or {}).get("/Title", ""))[:2000], "tags": [], "alt_count": 0, "unresolved_content_references": 0, "actual_text_count": 0, "page_content": [], "findings": [], "limitations": ["This is a bounded structure inspection, not PDF/UA validation or a semantic accessibility assessment.", "Authored alternative text retention compares exact strings and counts; it does not establish that each description remains attached to the same figure."]}
    if not isinstance(root, dict):
        info["findings"].append({"code": "missing_structure_tree", "severity": "error"})
        return info
    if not info["marked"]:
        info["findings"].append({"code": "missing_marked_flag", "severity": "error"})
    if not info["language"].strip():
        info["findings"].append({"code": "missing_document_language", "severity": "error"})
    seen: set[int] = set()
    content_seen: set[tuple[int, int]] = set()
    role_map = resolved(root.get("/RoleMap", {}))
    content_text: dict[tuple[int, int], str | None] = {}
    decoded_text_chars = 0
    extraction_work = 0
    report_text_chars = 0
    report_alt_chars = 0
    class_map = resolved(root.get("/ClassMap", {}))
    annotation_locations: dict[tuple[str, Any], list[dict[str, Any]]] = {}
    annotation_objects: dict[str, Any] = {}
    object_reference_owners: set[str] = set()
    attribute_gaps = 0
    info["resolved_object_references"] = 0
    for page_number, page in enumerate(pages, 1):
        annotations = resolved(page.get("/Annots", []))
        if not isinstance(annotations, list) or len(annotations) > 5000:
            raise InspectionError("annotation_count_limit")
        for index, annotation in enumerate(annotations):
            obj = resolved(annotation)
            if not isinstance(obj, dict):
                raise InspectionError("invalid_annotation")
            location = {"id": f"p{page_number}-a{index + 1}", "pageNumber": page_number, "annotationIndex": index + 1}
            annotation_objects[location["id"]] = obj
            key = ("ref", reference_key(annotation)) if reference_key(annotation) is not None else ("object", id(obj))
            annotation_locations.setdefault(key, []).append(location)
    # Re-extract each MCID from a shallow page copy containing only its text-show
    # operations. Font and positioning state are retained; PDF bytes are untouched.
    for page_number, page in enumerate(pages, 1):
        ops = operations(page)
        properties = resolved(resolved(page.get("/Resources", {})).get("/Properties", {}))
        stack: list[tuple[int | None, bool]] = []
        current_owners: list[int | None] = []
        occurrence_ids: dict[int, list[str]] = {}
        text_index = 0
        unowned = 0
        artifacts = 0
        page_mcids: set[int] = set()
        duplicate_mcids = False
        for operands, operator in ops:
            if operator in (b"BMC", b"BDC"):
                artifact = bool(operands) and str(operands[0]) == "/Artifact"
                mcid = None
                if operator == b"BDC" and len(operands) == 2:
                    props = resolved(operands[1])
                    if isinstance(props, NameObject):
                        props = resolved(properties.get(props))
                    if isinstance(props, dict):
                        mcid = integer(props.get("/MCID"))
                if mcid is not None:
                    duplicate_mcids |= mcid in page_mcids
                    page_mcids.add(mcid)
                if len(stack) >= MAX_DEPTH:
                    raise InspectionError("structure_complexity_limit")
                stack.append((mcid, artifact))
            owner = next((key for key, _ in reversed(stack) if key is not None), None)
            current_owners.append(owner)
            if operator in (b"Tj", b"TJ", b"'", b'"'):
                text_index += 1
                if any(artifact for _, artifact in stack):
                    artifacts += 1
                elif owner is None:
                    unowned += 1
                else:
                    occurrence_ids.setdefault(owner, []).append(f"p{page_number}-t{text_index}")
            if operator == b"EMC":
                if not stack:
                    info["findings"].append({"code": "unbalanced_marked_content", "severity": "error", "page": page_number})
                else:
                    stack.pop()
        if duplicate_mcids:
            info["findings"].append({"code": "duplicate_mcid", "severity": "error", "page": page_number})
        if stack:
            info["findings"].append({"code": "unbalanced_marked_content", "severity": "error", "page": page_number})
        if unowned:
            info["findings"].append({"code": "untagged_page_text", "severity": "error", "page": page_number})
        if artifacts:
            info["findings"].append({"code": "artifact_text_needs_semantic_review", "severity": "warning", "page": page_number})
        info["page_content"].append({"pageNumber": page_number, "mcids": sorted(page_mcids), "text_show_operators": text_index, "untagged_text_operators": unowned, "artifact_text_operators": artifacts, "occurrence_ids_by_mcid": occurrence_ids})
        for mcid in page_mcids:
            extraction_work += len(ops)
            if extraction_work > 2_000_000:
                content_text[(page_number, mcid)] = None
                continue
            selected = [(operands, operator) for (operands, operator), owner in zip(ops, current_owners) if operator not in (b"Tj", b"TJ", b"'", b'"') or owner == mcid]
            stream = ContentStream(None, reader)
            stream.operations = selected
            page_copy = copy.copy(page)
            page_copy[NameObject("/Contents")] = stream
            text = page_copy.extract_text() or ""
            decoded_text_chars += len(text)
            if decoded_text_chars > MAX_TEXT_CHARS:
                content_text[(page_number, mcid)] = None
            else:
                content_text[(page_number, mcid)] = text
    parent_tree = None
    try:
        parent_tree = number_tree(root.get("/ParentTree"))
    except InspectionError:
        info["findings"].append({"code": "invalid_parent_tree", "severity": "error"})

    def visit(item: Any, parent: Any, parent_id: str | None, page_number: int | None = None, depth: int = 0, inherited_language: str | None = None) -> str | None:
        nonlocal report_text_chars, report_alt_chars, attribute_gaps
        item = resolved(item)
        if depth > MAX_DEPTH or len(seen) > MAX_NODES:
            raise InspectionError("structure_complexity_limit")
        if isinstance(item, list):
            for child in item:
                visit(child, parent, parent_id, page_number, depth + 1, inherited_language)
            return
        if not isinstance(item, dict):
            # Leaf content is handled by the owning StructElem below.
            return
        if str(item.get("/Type")) in ("/MCR", "/OBJR"):
            return
        if id(item) in seen:
            info["findings"].append({"code": "reused_structure_element", "severity": "error"})
            return
        seen.add(id(item))
        if len(seen) > MAX_TAGS:
            raise InspectionError("structure_tag_limit")
        if resolved(item.get("/P")) is not parent:
            info["findings"].append({"code": "invalid_structure_parent", "severity": "error"})
        if "/Pg" in item:
            page_number = lookup.get(reference_key(item["/Pg"]))
        raw_role = str(item.get("/S", ""))
        role = raw_role
        role_seen: set[str] = set()
        while role.startswith("/") and role[1:] not in STANDARD_ROLES and role in role_map and role not in role_seen:
            role_seen.add(role)
            role = str(resolved(role_map[role]))
        if not role.startswith("/") or role[1:] not in STANDARD_ROLES:
            info["findings"].append({"code": "unmapped_structure_role", "severity": "error"})
        tag: dict[str, Any] = {"id": f"tag-{len(info['tags']) + 1}", "parentId": parent_id, "role": role.lstrip("/"), "sourceRole": raw_role.lstrip("/"), "pageNumber": page_number, "mcids": [], "content": [], "contentSequence": [], "text": ""}
        info["tags"].append(tag)
        if "/ID" in item:
            tag["nativeId"], tag["nativeIdHex"] = native_string(item["/ID"])
        if "/Lang" in item:
            tag["language"], _ = native_string(item["/Lang"], 100)
        tag["effectiveLanguage"] = tag.get("language", inherited_language or info["language"])
        tag["attributes"], gaps = tag_attributes(item, class_map)
        if gaps:
            tag["attributeGaps"] = gaps
            attribute_gaps += len(gaps)
            for gap in gaps:
                info["findings"].append({"code": gap, "severity": "error" if gap.startswith("invalid_") else "warning", "tagId": tag["id"]})
        if "/Alt" in item:
            tag["alt"] = str(item["/Alt"])[:8000]
            report_alt_chars += len(tag["alt"])
            if len(str(item["/Alt"])) > 8000 or report_alt_chars > MAX_ALT_CHARS:
                raise InspectionError("alternative_text_limit")
            info["alt_count"] += 1
            if re.fullmatch(r"\s*(?:image\s*\d*|figure\s*\d*|formula|annotation)\s*", tag["alt"], flags=re.IGNORECASE):
                info["findings"].append({"code": "placeholder_alternative", "severity": "error", "tagId": tag["id"]})
        if tag["role"] in {"Figure", "Formula"} and not str(item.get("/Alt", item.get("/ActualText", ""))).strip():
            info["findings"].append({"code": "missing_figure_alternative", "severity": "error", "tagId": tag["id"]})
        if "/ActualText" in item:
            tag["actualText"] = str(item["/ActualText"])[:8000]
            report_alt_chars += len(tag["actualText"])
            if len(str(item["/ActualText"])) > 8000 or report_alt_chars > MAX_ALT_CHARS:
                raise InspectionError("alternative_text_limit")
            info["actual_text_count"] += 1
        children = resolved(item.get("/K"))
        children = children if isinstance(children, list) else [children]
        for child in children:
            value = resolved(child)
            mcid = integer(value)
            child_page = page_number
            stream_ref = None
            if isinstance(value, dict) and str(value.get("/Type")) == "/MCR":
                mcid = integer(value.get("/MCID"))
                child_page = lookup.get(reference_key(value["/Pg"])) if "/Pg" in value else page_number
                stream_ref = value.get("/Stm")
            if mcid is not None:
                content = {"pageNumber": child_page, "mcid": mcid, "resolved": False}
                tag["content"].append(content)
                segment: dict[str, Any] = {"kind": "markedContent", **content, "text": None}
                tag["contentSequence"].append(segment)
                if child_page is not None and stream_ref is None:
                    key = (child_page, mcid)
                    if key in content_seen:
                        info["findings"].append({"code": "duplicate_structure_content", "severity": "error", "page": child_page})
                    content_seen.add(key)
                    if mcid not in info["page_content"][child_page - 1]["mcids"]:
                        info["findings"].append({"code": "missing_marked_content", "severity": "error", "page": child_page})
                    else:
                        content["resolved"] = True
                        segment["resolved"] = True
                    text = content_text.get(key)
                    if text is not None:
                        report_text_chars += len(text)
                        if report_text_chars <= MAX_TEXT_CHARS:
                            tag["text"] += text
                            segment["text"] = text
                        else:
                            tag["textIncomplete"] = True
                    else:
                        tag["textIncomplete"] = True
                    if child_page == page_number:
                        tag["mcids"].append(mcid)
                    if parent_tree is not None:
                        parent_key = integer(pages[child_page - 1].get("/StructParents"))
                        entries = parent_tree.get(parent_key)
                        if not isinstance(entries, list) or mcid >= len(entries) or resolved(entries[mcid]) is not item:
                            info["findings"].append({"code": "parent_tree_owner_mismatch", "severity": "error", "page": child_page})
                            segment["parentTreeVerified"] = False
                        else:
                            segment["parentTreeVerified"] = True
                else:
                    info["unresolved_content_references"] += 1
                    tag["textIncomplete"] = True
            elif isinstance(value, dict) and str(value.get("/Type")) == "/OBJR":
                tag.setdefault("objectReferences", 0)
                tag["objectReferences"] += 1
                object_ref = value.get("/Obj")
                obj = resolved(object_ref)
                key = ("ref", reference_key(object_ref)) if reference_key(object_ref) is not None else ("object", id(obj))
                locations = annotation_locations.get(key, [])
                expected_page = lookup.get(reference_key(value["/Pg"])) if "/Pg" in value else page_number
                entry: dict[str, Any] = {"kind": "objectReference", "resolved": False, "pageNumber": expected_page, "parentTreeVerified": False}
                tag["contentSequence"].append(entry)
                reason = None
                if not isinstance(obj, dict) or len(locations) != 1:
                    reason = "annotation_object_not_uniquely_on_page"
                else:
                    location = locations[0]
                    entry.update({"annotationId": location["id"], "pageNumber": location["pageNumber"], "annotationIndex": location["annotationIndex"], "subtype": str(obj.get("/Subtype", "")).lstrip("/")})
                    if expected_page is not None and expected_page != location["pageNumber"]:
                        reason = "object_reference_page_mismatch"
                    elif "/P" in obj and lookup.get(reference_key(obj["/P"])) != location["pageNumber"]:
                        reason = "annotation_page_pointer_mismatch"
                    elif location["id"] in object_reference_owners:
                        reason = "duplicate_annotation_owner"
                    else:
                        object_reference_owners.add(location["id"])
                        parent_key = integer(obj.get("/StructParent"))
                        if parent_tree is None or parent_key is None or resolved(parent_tree.get(parent_key)) is not item:
                            reason = "annotation_parent_tree_owner_mismatch"
                        else:
                            entry["parentTreeVerified"] = True
                    if "/Contents" in obj:
                        entry["description"], _ = native_string(obj["/Contents"], 8000)
                    action = resolved(obj.get("/A"))
                    if isinstance(action, dict):
                        entry["actionType"] = str(action.get("/S", "")).lstrip("/")[:100]
                        if action.get("/S") == "/URI" and "/URI" in action:
                            entry["uri"], _ = native_string(action["/URI"], 8000)
                        elif action.get("/S") == "/GoTo":
                            destination = resolved(action.get("/D"))
                            entry["destinationPageNumber"] = lookup.get(reference_key(destination[0])) if isinstance(destination, list) and destination else None
                    if "/Dest" in obj:
                        destination = resolved(obj["/Dest"])
                        entry["destinationPageNumber"] = lookup.get(reference_key(destination[0])) if isinstance(destination, list) and destination else None
                if reason:
                    entry["unresolvedReason"] = reason
                    info["unresolved_content_references"] += 1
                    info["findings"].append({"code": reason, "severity": "error", "tagId": tag["id"]})
                else:
                    entry["resolved"] = True
                    info["resolved_object_references"] += 1
            elif isinstance(value, dict) or isinstance(value, list):
                child_id = visit(value, item, tag["id"], page_number, depth + 1, tag["effectiveLanguage"])
                tag["contentSequence"].append({"kind": "childTag", "tagId": child_id, "resolved": child_id is not None})
                if child_id is None:
                    info["unresolved_content_references"] += 1
            elif value is not None:
                tag["contentSequence"].append({"kind": "unsupported", "resolved": False})
                info["unresolved_content_references"] += 1
        return tag["id"]
    visit(root.get("/K"), root, None, inherited_language=info["language"])
    native_ids: dict[str, list[dict[str, Any]]] = {}
    for tag in info["tags"]:
        if "nativeIdHex" in tag:
            native_ids.setdefault(tag["nativeIdHex"], []).append(tag)
    for candidates in native_ids.values():
        if len(candidates) > 1:
            info["findings"].append({"code": "duplicate_structure_native_id", "severity": "error"})
    for tag in info["tags"]:
        for attribute in tag["attributes"]:
            if "headersHex" in attribute:
                attribute["headerTagIds"] = []
                attribute["headersResolved"] = True
                for header in attribute["headersHex"]:
                    matches = native_ids.get(header, [])
                    if len(matches) != 1 or matches[0]["role"] != "TH":
                        attribute["headersResolved"] = False
                        attribute_gaps += 1
                        info["findings"].append({"code": "unresolved_table_header_id", "severity": "error", "tagId": tag["id"]})
                    else:
                        attribute["headerTagIds"].append(matches[0]["id"])
    for page in info["page_content"]:
        if any((page["pageNumber"], mcid) not in content_seen for mcid in page["mcids"]):
            info["findings"].append({"code": "unowned_marked_content", "severity": "error", "page": page["pageNumber"]})
    info["findings"] = info["findings"][:MAX_FINDINGS]
    info["tag_count"] = len(info["tags"])
    info["mcid_count"] = sum(len(page["mcids"]) for page in info["page_content"])
    if not info["tag_count"]:
        info["findings"].append({"code": "empty_structure_tree", "severity": "error"})
    info["machine_checks_passed"] = not any(item["severity"] == "error" for item in info["findings"])
    info["checks_complete"] = not info["unresolved_content_references"] and not attribute_gaps and not any(tag.get("textIncomplete") for tag in info["tags"])
    return info


def compare_pdfs(source: Path, output: Path, strict_text_subset: bool = False) -> dict[str, Any]:
    report: dict[str, Any] = {"schema_version": 1, "passed": False, "certification": False, "accessibility_ready": False, "semantic_review_required": True, "renderer": {"name": "PDFium", "scale": RENDER_SCALE}, "preservation": {"passed": False, "pages": []}, "structure": {"passed": False}, "findings": []}

    def finding(code: str, message: str, page: int | None = None) -> None:
        if len(report["findings"]) < MAX_FINDINGS:
            item = {"severity": "error", "code": code, "message": message}
            if page is not None:
                item["page"] = page
            report["findings"].append(item)
        else:
            report["findings_truncated"] = True

    try:
        for path in (source, output):
            if not path.is_file() or path.stat().st_size > MAX_FILE_BYTES:
                raise InspectionError("file_missing_or_too_large")
        readers = [PdfReader(path, strict=True) for path in (source, output)]
        if any(reader.is_encrypted for reader in readers):
            raise InspectionError("encrypted_pdf_unsupported")
        before, after = readers
        if len(before.pages) != len(after.pages) or not 1 <= len(before.pages) <= MAX_PAGES:
            raise InspectionError("page_count_changed_or_out_of_bounds")
        if strict_text_subset and before.trailer["/Root"].get("/StructTreeRoot") is not None:
            raise InspectionError("tagged_source_outside_initial_subset")
        for reader in readers:
            catalog = reader.trailer["/Root"]
            fields = reader.get_fields() or {}
            if strict_text_subset and (any(field.get("/FT") == "/Sig" for field in fields.values()) or catalog.get("/Perms") is not None):
                raise InspectionError("signed_pdf_unsupported")
            if strict_text_subset and resolved(catalog.get("/AcroForm", {})).get("/XFA") is not None:
                raise InspectionError("xfa_unsupported")
        canonical = [Canonicalizer(list(reader.pages)) for reader in readers]
        inventories = [font_image_inventory(reader) for reader in readers]
        forms = [form_inventory(reader) for reader in readers]
        if before.trailer["/Root"].get("/Perms") is not None or any(field.get("/FT") == "/Sig" for field in (before.get_fields() or {}).values()):
            finding("signature_requires_specialized_validation", "The source has a signature or usage-rights signature. Ordinary PDF rewriting cannot establish signature preservation.")
        report["preservation"]["fonts_identical"] = inventories[0]["font_hashes"] == inventories[1]["font_hashes"]
        report["preservation"]["images_identical"] = inventories[0]["image_hashes"] == inventories[1]["image_hashes"]
        report["preservation"]["form_fields_identical"] = forms[0] == forms[1]
        report["preservation"]["forms"] = {"source": forms[0], "output": forms[1]}
        for key in ("fonts_identical", "images_identical", "form_fields_identical"):
            if not report["preservation"][key]:
                finding(key.replace("_identical", "_changed"), "The repaired PDF changed original fonts, images, or interactive fields.")
        ignored_catalog = {"/Type", "/Pages", "/StructTreeRoot", "/MarkInfo", "/Lang", "/Metadata", "/ViewerPreferences"}
        catalog_values = [{key: value for key, value in reader.trailer["/Root"].items() if str(key) not in ignored_catalog} for reader in readers]
        if canonical[0].hash(catalog_values[0]) != canonical[1].hash(catalog_values[1]):
            finding("catalog_behavior_changed", "Links, forms, navigation, attachments, or other document behavior changed.")
        preferences = [{key: value for key, value in resolved(reader.trailer["/Root"].get("/ViewerPreferences", {})).items() if key != "/DisplayDocTitle"} for reader in readers]
        if canonical[0].hash(preferences[0]) != canonical[1].hash(preferences[1]):
            finding("viewer_preferences_changed", "Viewer behavior changed beyond displaying the document title.")
        total_operators = total_text = 0
        for index, pair in enumerate(zip(before.pages, after.pages)):
            page_result = {"page": index + 1}
            left_behavior, right_behavior, added_labels = page_behavior_values(pair)
            page_values = [left_behavior, right_behavior]
            ops = []
            texts = []
            for page in pair:
                ops.append(operations(page))
                texts.append(page.extract_text() or "")
            total_operators += sum(len(value) for value in ops)
            total_text += sum(len(value) for value in texts)
            if total_operators > MAX_OPERATORS * 2 or total_text > MAX_TEXT_CHARS * 2:
                raise InspectionError("document_complexity_limit")
            page_result["page_properties_identical"] = canonical[0].hash(page_values[0]) == canonical[1].hash(page_values[1])
            page_result["drawing_operators_identical"] = drawing_fingerprint(ops[0], canonical[0]) == drawing_fingerprint(ops[1], canonical[1])
            page_result["resources_identical"] = canonical[0].hash(pair[0].get("/Resources", {})) == canonical[1].hash(pair[1].get("/Resources", {}))
            page_result["extracted_text_identical"] = texts[0] == texts[1]
            old_annotations = resolved(pair[0].get("/Annots", []))
            new_annotations = resolved(pair[1].get("/Annots", []))
            page_result["authored_annotation_descriptions_retained"] = len(old_annotations) == len(new_annotations) and all("/Contents" not in resolved(old) or resolved(old).get("/Contents") == resolved(new).get("/Contents") for old, new in zip(old_annotations, new_annotations))
            if added_labels:
                page_result["added_link_descriptions"] = added_labels
            for key, passed in page_result.items():
                if key not in {"page", "added_link_descriptions"} and not passed:
                    finding(key.replace("_identical", "_changed"), "The repaired PDF changed source content, appearance, resources, or page behavior.", index + 1)
            report["preservation"]["pages"].append(page_result)
        source_pixels, output_pixels = rendered_page_hashes(source), rendered_page_hashes(output)
        for index, (left, right) in enumerate(zip(source_pixels, output_pixels)):
            same = left == right
            report["preservation"]["pages"][index]["pixels_identical"] = same
            if not same:
                finding("page_pixels_changed", "The repaired page does not render identically to the original.", index + 1)
        report["preservation"]["passed"] = not report["findings"]
        report["source_structure"] = structure_inventory(before)
        report["structure"] = structure_inventory(after)
        source_figures = sum(tag["role"] == "Figure" for tag in report["source_structure"]["tags"])
        output_figures = sum(tag["role"] == "Figure" for tag in report["structure"]["tags"])
        report["structure"]["figure_counts"] = {"source": source_figures, "output": output_figures}
        if output_figures < source_figures:
            finding("existing_figure_tags_lost", "The repaired PDF contains fewer figure tags than the original; image meaning may no longer be available to a screen reader.")
        source_alts = sorted(tag["alt"] for tag in report["source_structure"]["tags"] if "alt" in tag)
        output_alts = sorted(tag["alt"] for tag in report["structure"]["tags"] if "alt" in tag)
        remaining = list(output_alts)
        for alt in source_alts:
            if alt in remaining:
                remaining.remove(alt)
            else:
                finding("authored_alternative_lost_or_changed", "An existing image description was lost or changed in the repaired PDF.")
                report["preservation"]["passed"] = False
                break
        report["structure"]["authored_alternative_strings_retained"] = not bool(Counter(source_alts) - Counter(output_alts))
        report["structure"]["authored_alternative_associations_verified"] = not bool(source_alts)
        report["structure"]["passed"] = report["structure"].get("machine_checks_passed", False)
        if strict_text_subset:
            try:
                report["structure"]["strict_text_subset"] = check_structure(after)
            except InspectionError as error:
                report["structure"]["passed"] = False
                finding(str(error), "The PDF's saved tag structure did not pass the supported-subset machine checks.")
        report["mechanical_checks_passed"] = report["preservation"]["passed"] and report["structure"]["passed"] and not report["findings"]
        report["passed"] = report["mechanical_checks_passed"] and report["structure"].get("checks_complete", False) and not report["structure"].get("findings") and report["structure"]["authored_alternative_associations_verified"]
    except InspectionError as error:
        report["inspection_incomplete"] = True
        finding(str(error), "The checker could not complete a supported, bounded inspection of these PDFs.")
    except Exception:
        report["inspection_incomplete"] = True
        finding("pdf_inspection_failed", "A PDF parser or renderer could not safely complete the inspection.")
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--report", type=Path)
    parser.add_argument("--text-subset", action="store_true", help="Require the initial untagged, page-text-only repair subset.")
    args = parser.parse_args()
    # Parser messages can contain source text; only emit controlled JSON findings.
    logging.getLogger("pypdf").setLevel(logging.CRITICAL)
    report = compare_pdfs(args.source, args.output, args.text_subset)
    payload = json.dumps(report, ensure_ascii=True, indent=2)
    if len(payload.encode("utf-8")) > MAX_REPORT_BYTES:
        report = {"passed": False, "inspection_incomplete": True, "preservation": {"passed": False}, "structure": {"passed": False}, "findings": [{"code": "report_size_limit"}]}
        payload = json.dumps(report)
    if args.report:
        try:
            args.report.parent.mkdir(parents=True, exist_ok=True)
            args.report.write_text(payload + "\n", encoding="utf-8")
        except OSError:
            print(json.dumps({"passed": False, "inspection_incomplete": True, "findings": [{"code": "report_write_failed"}]}))
            return 2
    if args.report:
        print(json.dumps({"passed": report["passed"], "preservation_passed": report["preservation"]["passed"], "structure_passed": report["structure"].get("passed", False), "inspection_incomplete": report.get("inspection_incomplete", False), "finding_codes": [item["code"] for item in report["findings"]], "report_written": True}))
    else:
        print(payload)
    return 0 if report["passed"] else 2 if report.get("inspection_incomplete") else 1


if __name__ == "__main__":
    sys.exit(main())
