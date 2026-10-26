"""Independent, local-only native PDF preservation checks; not PDF/UA certification.

Run with the bundled Python runtime. Reads PDFs, writes only a JSON report, and
uses PDFium independently of the app's PDF.js rendering implementation.
"""
from __future__ import annotations

import argparse
import copy
import hashlib
import io
import json
import logging
import math
import re
from collections import Counter
from pathlib import Path
import sys
from typing import Any

from pypdf import PdfReader
from pypdf.generic import ArrayObject, ByteStringObject, ContentStream, DictionaryObject, IndirectObject, NameObject, NumberObject, StreamObject, TextStringObject

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
MAX_PAINT_ATOMS = 2_000_000
MAX_ARTIFACT_TEXT_CHARS = 16_000
MAX_TEXT_EXTRACTION_OPERATORS = 5_000_000
RENDER_SCALE = 1.5
MAX_RENDER_EQUIVALENCE_PAGES = 8
MAX_RENDER_DRIFT_PIXELS = 128
MAX_RENDER_DRIFT_FRACTION = 0.0001
RENDER_VERIFICATION_SCALES = (1, 2)
STANDARD_ROLES = {"Document", "Part", "Art", "Sect", "Div", "BlockQuote", "Caption", "TOC", "TOCI", "Index", "NonStruct", "Private", "P", "H", "H1", "H2", "H3", "H4", "H5", "H6", "L", "LI", "Lbl", "LBody", "Table", "TR", "TH", "TD", "THead", "TBody", "TFoot", "Span", "Quote", "Note", "Reference", "BibEntry", "Code", "Link", "Annot", "Ruby", "RB", "RT", "RP", "Warichu", "WT", "WP", "Figure", "Formula", "Form"}
# These five CDC source occurrences were reviewed as blank-paragraph spacing
# or footnote indentation, never interword separators. Pin the original file
# and full paint/resource membership: whitespace alone is not authorization.
REVIEWED_WHITESPACE_ARTIFACTS = {
    'a399c70cb22e7a0c07ad0c8cbeef33e49894a2de133d997b1fb57faabf4b61d8': {
        'db89da96cae536ea17bd3ad2e5aa85de8648bfa923560db6955fdab479995481': 'blank source paragraph on page 2',
        '3ef46e6a0f54c820d5e4fae2a41035d3d310f7dc6157122272da41d478540de6': 'blank source paragraph on page 2',
        '1c296b4fad918f1eab36494f63c58d78df7990c0cc14ac343513d5b8c526f705': 'blank source paragraph on page 5',
        '42b823fb5b8300b3579bc82c3b2329f0cfbf054266b3aa65a80530619ba82ba4': 'blank source paragraph on page 7',
        '5a54825ca289848974393f727da6105ced4dd9e4dac3b38bfc0eadd3569c9177': 'indentation before the retained footnote 1 on page 8',
    }
}


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
        self.page_refs = {self.owned_reference(page): index for index, page in enumerate(pages or []) if reference_key(page) is not None}
        self.nodes = 0
        self.stream_bytes = 0
        self.memo: dict[int, int] = {}

    @staticmethod
    def owned_reference(value: Any) -> tuple[int, int, int] | None:
        ref = value if isinstance(value, IndirectObject) else getattr(value, "indirect_reference", None)
        return (id(ref.pdf), ref.idnum, ref.generation) if isinstance(ref, IndirectObject) else None

    def value(self, item: Any, active: dict[int, int] | None = None, depth: int = 0) -> Any:
        if depth == 0:
            self.memo = {}
        self.nodes += 1
        if self.nodes > MAX_NODES or depth > MAX_DEPTH:
            raise InspectionError("object_complexity_limit")
        if self.owned_reference(item) in self.page_refs:
            return {"page": self.page_refs[self.owned_reference(item)]}
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
            # PDF serializers may write 1.0 as 1; these are the same operand.
            # Decimal reserialization can discard binary float noise such as
            # 208.88400000000001 -> 208.884. A nanounit remains far below PDF
            # renderer coordinate precision while preserving meaningful changes.
            number = round(float(item), 9)
            return int(number) if number.is_integer() else number
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


def extraction_stream(ops: list[tuple[Any, bytes]], reader: PdfReader, resources: Any) -> ContentStream:
    """Decode original text bytes through native fonts, not PDFDocEncoding guesses.

    Converting text-show operands to ByteStringObject has the same effect as
    reparsing the filtered stream with pypdf's force_encoding='bytes', without
    repeatedly serializing every graphics-state operation for each MCID.

    pypdf 6.10's TJ decoder treats the absolute adjustment as a potential word
    gap. In horizontal text a positive adjustment instead tightens glyphs
    (PDF 32000-1 Table 109). Suppress that erroneous gap inference only in this
    disposable extraction stream. Original bytes, operations and font resources
    remain untouched; negative adjustments and literal spaces are retained.
    Vertical/custom writing modes are not guessed.
    """
    def raw_text(item: Any) -> Any:
        if isinstance(item, TextStringObject):
            return ByteStringObject(item.original_bytes)
        if isinstance(item, (ArrayObject, list)):
            return ArrayObject([raw_text(value) for value in item])
        return item
    resources = resolved(resources)
    fonts = resolved(resources.get('/Font', {})) if isinstance(resources, dict) else {}
    graphics = resolved(resources.get('/ExtGState', {})) if isinstance(resources, dict) else {}
    font = None
    saved_fonts: list[Any] = []
    selected = []
    for args, operator in ops:
        if operator == b'q':
            if len(saved_fonts) >= MAX_DEPTH:
                raise InspectionError('text_extraction_state_depth')
            saved_fonts.append(font)
        elif operator == b'Q':
            font = saved_fonts.pop() if saved_fonts else None
        elif operator == b'Tf':
            font = resolved(fonts.get(args[0])) if isinstance(fonts, dict) and len(args) == 2 else None
        elif operator == b'gs':
            state = resolved(graphics.get(args[0])) if isinstance(graphics, dict) and len(args) == 1 else None
            if isinstance(state, dict) and '/Font' in state:
                entry = resolved(state['/Font'])
                font = resolved(entry[0]) if isinstance(entry, list) and len(entry) == 2 else None
        converted = raw_text(args) if operator in (b'Tj', b'TJ', b"'", b'"') else args
        if operator == b'TJ' and len(converted) == 1 and isinstance(converted[0], list):
            for index, item in enumerate(converted[0]):
                if not isinstance(item, (int, float)):
                    continue
                if not math.isfinite(float(item)):
                    raise InspectionError('invalid_text_adjustment')
                if item <= 0:
                    continue
                subtype = str(font.get('/Subtype', '')) if isinstance(font, dict) else ''
                encoding = resolved(font.get('/Encoding')) if isinstance(font, dict) else None
                horizontal = subtype in {'/Type1', '/MMType1', '/TrueType'} or (
                    subtype == '/Type0' and isinstance(encoding, NameObject) and str(encoding).endswith('-H'))
                if not horizontal:
                    raise InspectionError('unsupported_kerning_writing_mode')
                converted[0][index] = NumberObject(0)
        selected.append((converted, operator))
    content = ContentStream(None, reader)
    content.operations = selected
    return content


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


def rendered_page_image(document: Any, page_number: int, scale: float) -> Any:
    page = document[page_number]
    try:
        width, height = page.get_size()
        if not math.isfinite(width + height) or width <= 0 or height <= 0 or math.ceil(width * scale) * math.ceil(height * scale) > MAX_PAGE_PIXELS:
            raise InspectionError("render_pixel_limit")
        bitmap = page.render(scale=scale, rotation=0, draw_annots=True)
        try:
            native_image = bitmap.to_pil()
            try:
                return native_image.convert("RGB")
            finally:
                native_image.close()
        finally:
            bitmap.close()
    finally:
        page.close()


def rendered_page_hashes(path: Path) -> list[dict[str, Any]]:
    import pypdfium2 as pdfium
    document = pdfium.PdfDocument(str(path))
    result = []
    try:
        for page_number in range(len(document)):
            image = rendered_page_image(document, page_number, RENDER_SCALE)
            try:
                result.append({"width": image.width, "height": image.height, "sha256": digest(image.tobytes())})
            finally:
                image.close()
    finally:
        document.close()
    return result


def verify_rendering_equivalence(source: Path, output: Path, page_numbers: list[int]) -> dict[int, dict[str, Any]]:
    """Confirm tiny renderer drift only after independent paint identity passes.

    Splitting an unchanged text-show sequence at tag boundaries can move a few
    antialiased pixels at one render scale. This is not pixel identity. Require
    a small bounded difference at the primary scale AND exact pixel equality
    at both additional scales. Never use a similarity score as a substitute
    for the caller's content, resource and behavior checks.
    """
    import pypdfium2 as pdfium
    from PIL import ImageChops
    if not page_numbers or len(page_numbers) > MAX_RENDER_EQUIVALENCE_PAGES:
        return {}
    documents = []
    evidence = {}
    try:
        for path in (source, output):
            documents.append(pdfium.PdfDocument(str(path)))
        for page_number in page_numbers:
            images = []
            try:
                for document in documents:
                    images.append(rendered_page_image(document, page_number - 1, RENDER_SCALE))
                if images[0].size != images[1].size:
                    continue
                difference = ImageChops.difference(*images)
                try:
                    changed = sum(pixel != (0, 0, 0) for pixel in difference.getdata())
                finally:
                    difference.close()
                total = images[0].width * images[0].height
                if not 0 < changed <= min(MAX_RENDER_DRIFT_PIXELS, math.floor(total * MAX_RENDER_DRIFT_FRACTION)):
                    continue
            finally:
                for image in images:
                    image.close()
            matched = True
            for scale in RENDER_VERIFICATION_SCALES:
                images = []
                try:
                    for document in documents:
                        images.append(rendered_page_image(document, page_number - 1, scale))
                    if images[0].size != images[1].size or images[0].tobytes() != images[1].tobytes():
                        matched = False
                        break
                finally:
                    for image in images:
                        image.close()
            if matched:
                evidence[page_number] = {"pageNumber": page_number, "changedPixels": changed,
                    "totalPixels": total, "verificationScales": list(RENDER_VERIFICATION_SCALES)}
    finally:
        for document in documents:
            document.close()
    return evidence


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


def structure_id_tree(root: Any) -> dict[str, Any]:
    """Resolve a bounded native ID name tree, including its ordering/limits."""
    if '/IDTree' not in root:
        return {}
    entries: dict[str, Any] = {}
    seen: set[int] = set()

    def key(value: Any) -> bytes:
        value = resolved(value)
        if not isinstance(value, (TextStringObject, ByteStringObject)):
            raise InspectionError('invalid_structure_id_tree_key')
        raw = value.original_bytes if isinstance(value, TextStringObject) else bytes(value)
        if not raw or len(raw) > 512:
            raise InspectionError('invalid_structure_id_tree_key')
        return raw

    def walk(raw: Any, depth: int = 0) -> tuple[bytes, bytes] | None:
        node = resolved(raw)
        if not isinstance(node, dict) or id(node) in seen or depth > MAX_DEPTH or len(seen) >= MAX_TAGS:
            raise InspectionError('invalid_structure_id_tree')
        seen.add(id(node))
        if ('/Names' in node) == ('/Kids' in node):
            raise InspectionError('invalid_structure_id_tree')
        bounds = []
        if '/Kids' in node:
            kids = resolved(node['/Kids'])
            if not isinstance(kids, list) or not kids or len(kids) > MAX_TAGS:
                raise InspectionError('invalid_structure_id_tree')
            for child in kids:
                interval = walk(child, depth + 1)
                if interval is None:
                    raise InspectionError('empty_structure_id_tree_child')
                if bounds and interval[0] <= bounds[-1]:
                    raise InspectionError('unordered_structure_id_tree')
                bounds.extend(interval)
        else:
            names = resolved(node['/Names'])
            if not isinstance(names, list) or len(names) % 2 or len(names) > MAX_TAGS * 2:
                raise InspectionError('invalid_structure_id_tree')
            for offset in range(0, len(names), 2):
                identifier = key(names[offset])
                if (bounds and identifier <= bounds[-1]) or identifier.hex() in entries or len(entries) >= MAX_TAGS:
                    raise InspectionError('unordered_or_duplicate_structure_id_tree_key')
                target = resolved(names[offset + 1])
                if not isinstance(target, dict) or '/S' not in target:
                    raise InspectionError('invalid_structure_id_tree_target')
                entries[identifier.hex()] = target
                bounds.append(identifier)
        interval = (bounds[0], bounds[-1]) if bounds else None
        if depth > 0 or '/Limits' in node:
            limits = resolved(node.get('/Limits'))
            if not isinstance(limits, list) or len(limits) != 2 or interval != (key(limits[0]), key(limits[1])):
                raise InspectionError('invalid_structure_id_tree_limits')
        return interval

    walk(root['/IDTree'])
    return entries


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


class LocalDestinations:
    """Resolve only native local destinations; never fetch or execute actions."""

    def __init__(self, catalog: Any, page_lookup: dict[Any, int]):
        self.catalog = catalog
        self.page_lookup = page_lookup
        self.cache: dict[str, tuple[dict[bytes, Any], str | None]] = {}
        self.ambiguous: dict[str, set[bytes]] = {}

    @staticmethod
    def string_key(value: Any) -> bytes:
        value = resolved(value)
        if isinstance(value, ByteStringObject):
            return bytes(value)
        if isinstance(value, TextStringObject):
            return value.original_bytes
        raise InspectionError("invalid_named_destination_key")

    def index(self, kind: str) -> tuple[dict[bytes, Any], str | None]:
        if kind in self.cache:
            return self.cache[kind]
        entries: dict[bytes, Any] = {}
        ambiguous: set[bytes] = set()
        self.ambiguous[kind] = ambiguous
        count = 0
        try:
            if kind == "legacy":
                table = resolved(self.catalog.get("/Dests", {}))
                if not isinstance(table, dict) or len(table) > 5000:
                    raise InspectionError("invalid_legacy_destinations")
                for key, value in table.items():
                    if not isinstance(key, NameObject):
                        raise InspectionError("invalid_named_destination_key")
                    entries[str(key).encode("utf-8")] = value
            else:
                names = resolved(self.catalog.get("/Names", {}))
                if not isinstance(names, dict):
                    raise InspectionError("invalid_destination_name_tree")
                tree = names.get("/Dests")
                visited: set[int] = set()

                def walk(node: Any, depth: int = 0) -> None:
                    nonlocal count
                    node = resolved(node)
                    if not isinstance(node, dict) or id(node) in visited or depth > MAX_DEPTH or len(visited) >= 5000:
                        raise InspectionError("invalid_destination_name_tree")
                    visited.add(id(node))
                    if "/Names" in node and "/Kids" in node:
                        raise InspectionError("invalid_destination_name_tree")
                    if "/Kids" in node:
                        kids = resolved(node["/Kids"])
                        if not isinstance(kids, list) or not kids or len(kids) > 5000:
                            raise InspectionError("invalid_destination_name_tree")
                        for child in kids:
                            walk(child, depth + 1)
                    else:
                        values = resolved(node.get("/Names"))
                        if not isinstance(values, list) or len(values) % 2 or len(values) > 10000:
                            raise InspectionError("invalid_destination_name_tree")
                        for offset in range(0, len(values), 2):
                            key = self.string_key(values[offset])
                            count += 1
                            if count > 5000:
                                raise InspectionError("invalid_destination_name_tree")
                            if key in entries or key in ambiguous:
                                ambiguous.add(key)
                                entries.pop(key, None)
                            else:
                                entries[key] = values[offset + 1]

                if tree is not None:
                    walk(tree)
            self.cache[kind] = entries, None
        except (InspectionError, UnicodeError, AttributeError) as error:
            code = str(error) if isinstance(error, InspectionError) else "invalid_named_destination_key"
            self.cache[kind] = {}, code
        return self.cache[kind]

    def resolve(self, destination: Any) -> dict[str, Any]:
        destination = resolved(destination)
        result: dict[str, Any] = {"destinationResolved": False, "destinationPageNumber": None}
        if isinstance(destination, (NameObject, TextStringObject, ByteStringObject)):
            kind = "legacy" if isinstance(destination, NameObject) else "nameTree"
            result["destinationKind"] = "named"
            result["destinationStorage"] = kind
            try:
                key = str(destination).encode("utf-8") if kind == "legacy" else self.string_key(destination)
            except (UnicodeError, AttributeError, InspectionError):
                result["destinationUnresolvedReason"] = "invalid_named_destination_key"
                return result
            result["destinationNameSha256"] = digest(key)
            entries, error = self.index(kind)
            if error is not None or key not in entries:
                result["destinationUnresolvedReason"] = error or (
                    "ambiguous_named_destination" if key in self.ambiguous[kind] else "named_destination_missing")
                return result
            destination = resolved(entries[key])
        else:
            result["destinationKind"] = "explicit"
        if isinstance(destination, dict):
            destination = resolved(destination.get("/D"))
        modes = {"/XYZ": 5, "/Fit": 2, "/FitH": 3, "/FitV": 3, "/FitR": 6, "/FitB": 2, "/FitBH": 3, "/FitBV": 3}
        if not isinstance(destination, list) or len(destination) < 2 or not isinstance(destination[1], NameObject) or modes.get(str(destination[1])) != len(destination):
            result["destinationUnresolvedReason"] = "invalid_local_destination"
            return result
        page = self.page_lookup.get(reference_key(destination[0]))
        if page is None:
            result["destinationUnresolvedReason"] = "destination_page_missing"
            return result
        for coordinate in destination[2:]:
            coordinate = resolved(coordinate)
            if type(coordinate).__name__ == "NullObject" and destination[1] != "/FitR":
                continue
            if isinstance(coordinate, bool) or not isinstance(coordinate, (int, float)) or not math.isfinite(coordinate):
                result["destinationUnresolvedReason"] = "invalid_destination_coordinates"
                return result
        result.update({"destinationResolved": True, "destinationPageNumber": page, "destinationView": str(destination[1]).lstrip("/")})
        return result



class _NavigationCanonicalizer(Canonicalizer):
    """Bind native name/string types and all navigation keys after renumbering."""

    def value(self, item: Any, active=None, depth: int = 0) -> Any:
        value = resolved(item)
        if self.owned_reference(item) in self.page_refs or id(value) in self.pages:
            return super().value(item, active, depth)
        if isinstance(value, NameObject):
            if len(value) > MAX_TEXT_CHARS:
                raise InspectionError('text_size_limit')
            return {'pdf_name': str(value)}
        elif isinstance(value, (TextStringObject, ByteStringObject, bytes)):
            data = value.original_bytes if isinstance(value, TextStringObject) else bytes(value)
            if len(data) > MAX_TEXT_CHARS:
                raise InspectionError('text_size_limit')
            return {'pdf_string_sha256': digest(data), 'length': len(data)}
        elif isinstance(value, StreamObject):
            data = value.get_data()
            self.stream_bytes += len(data)
            if len(data) > MAX_STREAM_BYTES or self.stream_bytes > MAX_TOTAL_STREAM_BYTES:
                raise InspectionError("stream_size_limit")
            item = ("pdf_stream", [(str(key), value[key]) for key in sorted(value)
                    if key not in ("/Length", "/Filter", "/DecodeParms")], digest(data))
        elif isinstance(value, dict):
            item = ("pdf_dictionary", [(str(key), value[key]) for key in sorted(value)])
        return super().value(item, active, depth)


def _bounded_navigation_data(value: Any, canonical: _NavigationCanonicalizer) -> None:
    """Inspect finite destination data without accepting executable dictionaries."""
    pending = [(value, 0)]
    seen: set[int] = set()
    count = 0
    while pending:
        item, depth = pending.pop()
        count += 1
        if count > MAX_NODES or depth > MAX_DEPTH:
            raise InspectionError("navigation_complexity_limit")
        if canonical.owned_reference(item) in canonical.page_refs:
            continue
        item = resolved(item)
        if id(item) in canonical.pages:
            continue
        if isinstance(item, StreamObject):
            raise InspectionError("unsupported_destination_data")
        if not isinstance(item, (dict, list)) or id(item) in seen:
            continue
        seen.add(id(item))
        if isinstance(item, dict):
            if any(key in item for key in ("/S", "/A", "/AA", "/JS", "/JavaScript", "/Next",
                                          "/OpenAction", "/EmbeddedFiles", "/EF", "/AF")):
                raise InspectionError("unsupported_destination_data")
            pending.extend((child, depth + 1) for child in item.values())
        else:
            pending.extend((child, depth + 1) for child in item)
    canonical.hash(value)


def navigation_inventory(reader: PdfReader) -> dict[str, Any]:
    """Separate inspectable broken links from unsafe or incomplete inspection.

    An unresolved local name is a document defect. Its exact original token and
    destination dictionaries can still be preserved while other content changes.
    No destination is guessed, fetched, repaired or treated as working here.
    """
    pages = list(reader.pages)
    catalog = reader.trailer["/Root"]
    lookup = {reference_key(page): index + 1 for index, page in enumerate(pages)}
    resolver = LocalDestinations(catalog, lookup)
    canonical = _NavigationCanonicalizer(pages)
    result: dict[str, Any] = {"checks_complete": True, "findings": [], "annotations": [],
                              "destinationTablesSha256": None}
    names = resolved(catalog.get('/Names', {}))
    destinations = {key: catalog[key] for key in ('/Dests',) if key in catalog}
    if isinstance(names, dict) and '/Dests' in names:
        destinations['nameTree'] = names['/Dests']
    elif not isinstance(names, dict):
        result['checks_complete'] = False
    try:
        _bounded_navigation_data(destinations, canonical)
        result['destinationTablesSha256'] = canonical.hash(destinations)
    except (InspectionError, UnicodeError, AttributeError, TypeError, ValueError):
        result['checks_complete'] = False
    for page_number, page in enumerate(pages, 1):
        annotations = resolved(page.get('/Annots', []))
        if not isinstance(annotations, list) or len(annotations) > 5000:
            raise InspectionError('annotation_count_limit')
        for index, reference in enumerate(annotations, 1):
            annotation = resolved(reference)
            if not isinstance(annotation, dict):
                raise InspectionError('invalid_annotation')
            if annotation.get('/Subtype') != '/Link':
                continue
            record: dict[str, Any] = {'annotationId': f'p{page_number}-a{index}',
                                      'page': page_number, 'annotationIndex': index}
            reason = None
            try:
                state = {key: value for key, value in annotation.items()
                         if key not in ('/StructParent', '/StructParents')}
                record['stateSha256'] = canonical.hash(state)
                if '/AA' in annotation or '/Dest' in annotation and '/A' in annotation:
                    raise InspectionError('unsupported_link_action')
                action = resolved(annotation.get('/A'))
                local = '/Dest' in annotation
                if '/A' in annotation:
                    if (not isinstance(action, dict) or not isinstance(action.get('/S'), NameObject)
                            or '/Type' in action and (not isinstance(action['/Type'], NameObject) or action['/Type'] != '/Action')):
                        raise InspectionError('unsupported_link_action')
                    if action.get('/S') == '/GoTo':
                        if set(action) - {'/Type', '/S', '/D'} or '/D' not in action:
                            raise InspectionError('unsupported_link_action')
                        local = True
                    elif action.get('/S') == '/URI':
                        uri = resolved(action.get('/URI'))
                        if (set(action) - {'/Type', '/S', '/URI', '/IsMap'}
                                or not isinstance(uri, (TextStringObject, ByteStringObject))
                                or len(uri) > 8000 or not re.match(r'^(?:https?://|mailto:|tel:)', str(uri), re.I)
                                or '/IsMap' in action and type(resolved(action['/IsMap'])).__name__ != 'BooleanObject'):
                            raise InspectionError('unsupported_link_action')
                    else:
                        raise InspectionError('unsupported_link_action')
                elif not local:
                    raise InspectionError('unsupported_link_action')
                if local:
                    destination = annotation.get('/Dest') if '/Dest' in annotation else action['/D']
                    _bounded_navigation_data(destination, canonical)
                    evidence = resolver.resolve(destination)
                    record.update(evidence)
                    reason = evidence.get('destinationUnresolvedReason')
                    if reason in ('invalid_destination_name_tree', 'invalid_legacy_destinations', 'invalid_named_destination_key'):
                        raise InspectionError(reason)
                record['navigationInspected'] = True
            except (InspectionError, UnicodeError, AttributeError, TypeError, ValueError) as error:
                record['navigationInspected'] = False
                result['checks_complete'] = False
                reason = str(error) if isinstance(error, InspectionError) else 'unsupported_link_action'
            if reason:
                complete = record['navigationInspected'] and result['destinationTablesSha256'] is not None
                finding = {'code': 'local_link_destination_unresolved' if complete else 'link_navigation_uninspected',
                           'severity': 'warning' if complete else 'error', 'page': page_number,
                           'annotationId': record['annotationId'], 'reason': reason,
                           'message': (f'Page {page_number}, link {index}: ' + {
                               'named_destination_missing': 'the link points to an internal destination that is missing from the original PDF.',
                               'ambiguous_named_destination': 'the original PDF assigns the same internal name to several destinations, so the intended target is unclear.',
                               'destination_page_missing': 'the link points to a page that is not part of the original PDF.'
                           }.get(reason, 'the original PDF contains an internal link with an invalid destination.') +
                           ' The link has been kept; the app has not guessed a replacement.'
                           if complete else f'Page {page_number}, link {index}: the app could not safely inspect this link action.')}
                result['findings'].append(finding)
            result['annotations'].append(record)
    return result


def compare_annotations(source: PdfReader, output: PdfReader) -> dict[str, Any]:
    """No waiver for changed, dropped or retargeted links, including broken ones."""
    before, after = navigation_inventory(source), navigation_inventory(output)
    result = {'passed': False, 'sourceFindings': before['findings'], 'outputFindings': after['findings'],
              'sourceInspectionComplete': before['checks_complete'], 'outputInspectionComplete': after['checks_complete'],
              'comparisons': [], 'destinationTablesIdentical': before['destinationTablesSha256'] == after['destinationTablesSha256']}
    left, right = before['annotations'], after['annotations']
    if len(source.pages) != len(output.pages) or len(left) != len(right):
        return result
    old_canonical = _NavigationCanonicalizer(list(source.pages))
    new_canonical = _NavigationCanonicalizer(list(output.pages))
    for original, current in zip(left, right):
        same = original['annotationId'] == current['annotationId']
        old = resolved(source.pages[original['page'] - 1]['/Annots'][original['annotationIndex'] - 1])
        new = resolved(output.pages[current['page'] - 1]['/Annots'][current['annotationIndex'] - 1])
        # Only a missing link description may be added. Authored descriptions,
        # URI/action keys, native destination token types and identity stay bound.
        before_state = {key: value for key, value in old.items() if key not in ('/StructParent', '/StructParents')}
        after_state = {key: value for key, value in new.items() if key not in ('/StructParent', '/StructParents')
                       and not (key == '/Contents' and '/Contents' not in old)}
        same = same and old_canonical.hash(before_state) == new_canonical.hash(after_state)
        result['comparisons'].append({'annotationId': original['annotationId'], 'pageNumber': original['page'],
                                      'preserved': same, 'originalDestinationUnresolved': original.get('destinationResolved') is False})
    result['passed'] = (before['checks_complete'] and after['checks_complete'] and result['destinationTablesIdentical']
                        and all(row['preserved'] for row in result['comparisons']))
    return result

def ownership_required_mcids(ops: list[tuple[Any, bytes]], properties: Any = None) -> set[int]:
    """Separate real content from authored artifacts and literally empty scopes.

    Keep every MCID in the ordinary syntax/uniqueness checks. Only the final
    ownership requirement changes: an artifact need not belong to the logical
    structure, and an immediate BDC/EMC pair with MCID-only properties contains
    nothing to assign. Unknown properties, ActualText, and any intervening
    operator prevent the empty-scope exception.
    """
    properties = resolved(properties) or {}
    stack: list[tuple[bool, bool]] = []
    required: set[int] = set()
    artifact_properties = {"/MCID", "/Type", "/Subtype", "/Attached", "/BBox"}
    for index, (operands, operator) in enumerate(ops):
        if operator in (b"BMC", b"BDC"):
            props = resolved(operands[1]) if operator == b"BDC" and len(operands) == 2 else {}
            if isinstance(props, NameObject):
                props = resolved(properties.get(props)) if isinstance(properties, dict) else None
            supported_props = isinstance(props, dict) and set(props) <= artifact_properties
            artifact = bool(operands) and str(operands[0]) == "/Artifact"
            if len(stack) >= MAX_DEPTH:
                raise InspectionError("structure_complexity_limit")
            stack.append((artifact, supported_props))
            mcid = integer(props.get("/MCID")) if isinstance(props, dict) else None
            if mcid is not None:
                explicitly_artifact = any(flag for flag, _ in stack) and all(safe for _, safe in stack)
                empty = all(safe for _, safe in stack) and set(props) == {"/MCID"} and index + 1 < len(ops) and ops[index + 1] == ([], b"EMC")
                if not explicitly_artifact and not empty:
                    required.add(mcid)
        elif operator == b"EMC" and stack:
            stack.pop()
    return required


def scoped_text_operations(ops: list[tuple[Any, bytes]], owners: list[int | None], artifacts: list[bool]) -> list[tuple[tuple[Any, bytes], int | None, bool]]:
    """Reuse ownership already proved by the complete stream scan.

    Marked-content wrappers have no effect on pypdf's native text decoder.
    Removing them once from this disposable extraction index avoids charging
    every MCID for all the tagger's wrappers on the page. All painting/text
    state remains in order, and the existing work limit still bounds each
    repeated extraction. Form/image invocations were already excluded from
    these page-local text views; their separate inspection is unchanged.
    """
    ignored = {b"BMC", b"BDC", b"EMC", b"MP", b"DP", b"Do", b"INLINE IMAGE"}
    return [(operation, owner, artifact) for operation, owner, artifact in zip(ops, owners, artifacts)
            if operation[1] not in ignored]


def structure_inventory(reader: PdfReader) -> dict[str, Any]:
    """Read actual saved tags; do not infer associations from visual proximity."""
    pages = list(reader.pages)
    lookup = {reference_key(page): index + 1 for index, page in enumerate(pages)}
    catalog = reader.trailer["/Root"]
    root = resolved(catalog.get("/StructTreeRoot"))
    info: dict[str, Any] = {"tagged": isinstance(root, dict), "marked": pdf_boolean(resolved(catalog.get("/MarkInfo", {})).get("/Marked")), "language": str(catalog.get("/Lang", ""))[:100], "title": str((reader.metadata or {}).get("/Title", ""))[:2000], "tags": [], "alt_count": 0, "unresolved_content_references": 0, "actual_text_count": 0, "page_content": [], "findings": [], "limitations": ["This is a bounded structure inspection, not PDF/UA validation or a semantic accessibility assessment.", "Authored alternative text retention compares exact strings and counts; it does not establish that each description remains attached to the same figure."]}
    navigation = navigation_inventory(reader)
    info['navigation_checks_complete'] = navigation['checks_complete']
    info['navigation_findings'] = navigation['findings']
    if not isinstance(root, dict):
        info['findings'].extend(navigation['findings'])
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
    form_scopes: dict[Any, dict[str, Any]] = {}
    form_invocations: list[dict[str, Any]] = []
    decoded_text_chars = 0
    extraction_work = 0
    report_text_chars = 0
    report_alt_chars = 0
    class_map = resolved(root.get("/ClassMap", {}))
    annotation_locations: dict[tuple[str, Any], list[dict[str, Any]]] = {}
    annotation_objects: dict[str, Any] = {}
    annotation_destinations: dict[str, dict[str, Any]] = {}
    navigation_records = {record['annotationId']: record for record in navigation['annotations']}
    info["unresolved_local_destinations"] = sum(record.get('destinationResolved') is False for record in navigation['annotations'])
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
            action = resolved(obj.get("/A"))
            if "/Dest" in obj or isinstance(action, dict) and action.get("/S") == "/GoTo":
                evidence = navigation_records.get(location['id'], {})
                annotation_destinations[location["id"]] = {key: value for key, value in evidence.items()
                    if key.startswith('destination') or key == 'navigationInspected'}
            key = ("ref", reference_key(annotation)) if reference_key(annotation) is not None else ("object", id(obj))
            annotation_locations.setdefault(key, []).append(location)
    # Re-extract each MCID from a shallow page copy containing only its text-show
    # operations. Font and positioning state are retained; PDF bytes are untouched.
    for page_number, page in enumerate(pages, 1):
        ops = operations(page)
        properties = resolved(resolved(page.get("/Resources", {})).get("/Properties", {}))
        stack: list[tuple[int | None, bool]] = []
        current_owners: list[int | None] = []
        current_artifacts: list[bool] = []
        form_content_uninspected = False
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
                        if "/MCID" in props and mcid is None:
                            info["findings"].append({"code": "invalid_mcid", "severity": "error", "page": page_number})
                    else:
                        info["findings"].append({"code": "invalid_marked_content_properties", "severity": "error", "page": page_number})
                elif operator == b"BDC":
                    info["findings"].append({"code": "invalid_marked_content_properties", "severity": "error", "page": page_number})
                if mcid is not None:
                    if any(key is not None for key, _ in stack):
                        info["findings"].append({"code": "nested_mcid_scope_unsupported", "severity": "error", "page": page_number})
                    duplicate_mcids |= mcid in page_mcids
                    page_mcids.add(mcid)
                if len(stack) >= MAX_DEPTH:
                    raise InspectionError("structure_complexity_limit")
                stack.append((mcid, artifact))
            owner = next((key for key, _ in reversed(stack) if key is not None), None)
            is_artifact = any(artifact for _, artifact in stack)
            current_owners.append(owner)
            current_artifacts.append(is_artifact)
            if operator == b"Do":
                xobjects = resolved(resolved(page.get("/Resources", {})).get("/XObject", {}))
                asset = resolved(xobjects.get(operands[0])) if len(operands) == 1 else None
                if isinstance(asset, StreamObject) and asset.get("/Subtype") == "/Form":
                    form_invocations.append({"stream": asset, "pageNumber": page_number, "artifact": is_artifact, "pageOwner": owner})
                elif not isinstance(asset, dict):
                    form_content_uninspected = True
            if operator in (b"Tj", b"TJ", b"'", b'"'):
                text_index += 1
                if is_artifact:
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
        artifact_text = ""
        artifact_complete = not form_content_uninspected
        extraction_ops = scoped_text_operations(ops, current_owners, current_artifacts)
        if artifacts:
            extraction_work += len(extraction_ops)
            if extraction_work > MAX_TEXT_EXTRACTION_OPERATORS:
                artifact_complete = False
            else:
                # Keep text state while removing every other text-show operation.
                # Do is omitted because a Form can contain unrelated/internal text.
                selected = [(operands, operator) for (operands, operator), _, artifact in extraction_ops if operator not in (b"Tj", b"TJ", b"'", b'"') or artifact]
                page_copy = copy.copy(page)
                page_copy[NameObject("/Contents")] = extraction_stream(selected, reader, page.get('/Resources', {}))
                artifact_text = page_copy.extract_text() or ""
                decoded_text_chars += len(artifact_text)
                artifact_complete &= len(artifact_text) <= MAX_ARTIFACT_TEXT_CHARS and decoded_text_chars <= MAX_TEXT_CHARS
                artifact_text = artifact_text[:MAX_ARTIFACT_TEXT_CHARS] if decoded_text_chars <= MAX_TEXT_CHARS else ""
        info["page_content"].append({"pageNumber": page_number, "mcids": sorted(page_mcids), "ownership_required_mcids": sorted(ownership_required_mcids(ops, properties)), "text_show_operators": text_index, "untagged_text_operators": unowned, "artifact_text_operators": artifacts, "artifactText": artifact_text, "artifactTextComplete": artifact_complete, "occurrence_ids_by_mcid": occurrence_ids})
        for mcid in page_mcids:
            extraction_work += len(extraction_ops)
            if extraction_work > MAX_TEXT_EXTRACTION_OPERATORS:
                content_text[(page_number, mcid)] = None
                continue
            selected = [(operands, operator) for (operands, operator), owner, artifact in extraction_ops if operator not in (b"Tj", b"TJ", b"'", b'"') or (owner == mcid and not artifact)]
            page_copy = copy.copy(page)
            page_copy[NameObject("/Contents")] = extraction_stream(selected, reader, page.get('/Resources', {}))
            text = page_copy.extract_text() or ""
            decoded_text_chars += len(text)
            if decoded_text_chars > MAX_TEXT_CHARS:
                content_text[(page_number, mcid)] = None
            else:
                content_text[(page_number, mcid)] = text

    # Reopen leaf Form content streams by their actual drawing invocation. A
    # /Stm pointer is accepted only when it names this exact, uniquely used Form.
    # Repeated all-Artifact leaf Forms are safe to decode once per page occurrence.
    form_counts = Counter(reference_key(call["stream"]) for call in form_invocations)
    info["form_content"] = []
    for call in form_invocations:
        form = call["stream"]
        form_key = reference_key(form)
        pn = call["pageNumber"]
        page = pages[pn - 1]
        page_info = info["page_content"][pn - 1]
        resources = resolved(form.get("/Resources", page.get("/Resources", {})))
        props = resolved(resources.get("/Properties", {}))
        ops = ContentStream(form, reader).operations
        if len(ops) > MAX_OPERATORS:
            raise InspectionError("operator_limit")
        owners: list[int | None] = []
        artifacts: list[bool] = []
        stack: list[tuple[int | None, bool]] = []
        mcids: set[int] = set()
        gaps: set[str] = set()
        unowned = 0
        artifact_shows = 0
        for operands, operator in ops:
            if operator in (b"BMC", b"BDC"):
                mcid = None
                if not operands or len(stack) >= MAX_DEPTH:
                    raise InspectionError("invalid_marked_content")
                if operator == b"BDC":
                    marked_props = resolved(operands[1]) if len(operands) == 2 else None
                    if isinstance(marked_props, NameObject):
                        marked_props = resolved(props.get(marked_props))
                    if isinstance(marked_props, dict):
                        mcid = integer(marked_props.get("/MCID"))
                        if "/MCID" in marked_props and mcid is None:
                            gaps.add("invalid_form_mcid")
                    else:
                        gaps.add("invalid_form_marked_content_properties")
                if mcid is not None:
                    if any(key is not None for key, _ in stack):
                        gaps.add("nested_form_mcid_scope_unsupported")
                    if mcid in mcids:
                        gaps.add("duplicate_form_mcid")
                    mcids.add(mcid)
                stack.append((mcid, str(operands[0]) == "/Artifact"))
            owner = next((key for key, _ in reversed(stack) if key is not None), None)
            artifact = call["artifact"] or any(flag for _, flag in stack)
            owners.append(owner)
            artifacts.append(artifact)
            if operator in (b"Tj", b"TJ", b"'", b'"'):
                if artifact:
                    artifact_shows += 1
                elif owner is None:
                    unowned += 1
            if operator == b"Do":
                xobject = resolved(resolved(resources.get("/XObject", {})).get(operands[0])) if len(operands) == 1 else None
                if not isinstance(xobject, dict) or xobject.get("/Subtype") == "/Form":
                    gaps.add("nested_form_content_uninspected")
            if operator == b"EMC":
                if not stack:
                    gaps.add("unbalanced_form_marked_content")
                else:
                    stack.pop()
        if stack:
            gaps.add("unbalanced_form_marked_content")
        if mcids and (form_key is None or form_counts[form_key] != 1 or call["artifact"]):
            gaps.add("ambiguous_form_content_invocation")
        if unowned:
            gaps.add("form_text_without_native_mcid")
        scope = {"id": f"form-{len(info['form_content']) + 1}", "pageNumber": pn, "mcids": sorted(mcids), "ownership_required_mcids": sorted(ownership_required_mcids(ops, props)), "stream": form, "text": {}, "gaps": gaps}
        extraction_ops = scoped_text_operations(ops, owners, artifacts)
        for selected_mcid in [None, *sorted(mcids)]:
            extraction_work += len(extraction_ops)
            if extraction_work > MAX_TEXT_EXTRACTION_OPERATORS:
                gaps.add("form_text_extraction_limit")
                continue
            selected = [(args, operator) for (args, operator), owner, artifact in extraction_ops if operator not in (b"Tj", b"TJ", b"'", b'"') or (artifact if selected_mcid is None else owner == selected_mcid and not artifact)]
            page_copy = copy.copy(page)
            page_copy[NameObject("/Contents")] = extraction_stream(selected, reader, resources)
            page_copy[NameObject("/Resources")] = resources
            text = page_copy.extract_text() or ""
            decoded_text_chars += len(text)
            if decoded_text_chars > MAX_TEXT_CHARS:
                gaps.add("form_text_extraction_limit")
                continue
            if selected_mcid is None:
                if text:
                    page_info["artifactText"] = "\n".join(filter(None, [page_info["artifactText"], text]))
                    if len(page_info["artifactText"]) > MAX_ARTIFACT_TEXT_CHARS:
                        page_info["artifactText"] = page_info["artifactText"][:MAX_ARTIFACT_TEXT_CHARS]
                        gaps.add("artifact_text_size_limit")
            else:
                scope["text"][selected_mcid] = text
        if artifact_shows:
            page_info["form_artifact_text_operators"] = page_info.get("form_artifact_text_operators", 0) + artifact_shows
            if not any(f.get("code") == "artifact_text_needs_semantic_review" and f.get("page") == pn for f in info["findings"]):
                info["findings"].append({"code": "artifact_text_needs_semantic_review", "severity": "warning", "page": pn})
        if gaps:
            page_info["artifactTextComplete"] = False
            for gap in sorted(gaps):
                info["findings"].append({"code": gap, "severity": "warning", "page": pn})
        elif mcids:
            form_scopes[form_key] = scope
        info["form_content"].append({"streamId": scope["id"], "pageNumber": pn, "mcids": sorted(mcids), "checksComplete": not gaps, "gaps": sorted(gaps)})
    parent_tree = None
    try:
        parent_tree = number_tree(root.get("/ParentTree"))
    except InspectionError:
        info["findings"].append({"code": "invalid_parent_tree", "severity": "error"})

    native_objects: dict[str, Any] = {}

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
        native_objects[tag['id']] = item
        if "/ID" in item:
            tag["nativeId"], tag["nativeIdHex"] = native_string(item["/ID"])
        if tag["role"] == "Note" and not tag.get("nativeIdHex"):
            info["findings"].append({"code": "missing_note_identifier", "severity": "error", "tagId": tag["id"], "page": page_number})
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
                scope = form_scopes.get(reference_key(stream_ref)) if stream_ref is not None else None
                if child_page is not None and (stream_ref is None or (scope is not None and scope["pageNumber"] == child_page)):
                    key = (scope["id"] if scope is not None else child_page, mcid)
                    if scope is not None:
                        content["streamId"] = scope["id"]
                        segment["streamId"] = scope["id"]
                    if key in content_seen:
                        info["findings"].append({"code": "duplicate_structure_content", "severity": "error", "page": child_page})
                    content_seen.add(key)
                    if mcid not in (scope["mcids"] if scope is not None else info["page_content"][child_page - 1]["mcids"]):
                        info["findings"].append({"code": "missing_marked_content", "severity": "error", "page": child_page})
                    else:
                        content["resolved"] = True
                        segment["resolved"] = True
                    text = scope["text"].get(mcid) if scope is not None else content_text.get(key)
                    if text is not None:
                        report_text_chars += len(text)
                        if report_text_chars <= MAX_TEXT_CHARS:
                            tag["text"] += text
                            segment["text"] = text
                        else:
                            tag["textIncomplete"] = True
                    else:
                        tag["textIncomplete"] = True
                    if child_page == page_number and scope is None:
                        tag["mcids"].append(mcid)
                    if parent_tree is not None:
                        parent_key = integer((scope["stream"] if scope is not None else pages[child_page - 1]).get("/StructParents"))
                        entries = parent_tree.get(parent_key)
                        if not isinstance(entries, list) or mcid >= len(entries) or resolved(entries[mcid]) is not item:
                            info["findings"].append({"code": "parent_tree_owner_mismatch", "severity": "error", "page": child_page})
                            segment["parentTreeVerified"] = False
                        else:
                            segment["parentTreeVerified"] = True
                else:
                    segment["unresolvedReason"] = "form_content_scope_unresolved" if stream_ref is not None else "content_page_unresolved"
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
                    entry.update(annotation_destinations.get(location["id"], {}))
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
    id_tree_complete = True
    for tag in info["tags"]:
        if "nativeIdHex" in tag:
            native_ids.setdefault(tag["nativeIdHex"], []).append(tag)
    for candidates in native_ids.values():
        if len(candidates) > 1:
            info["findings"].append({"code": "duplicate_structure_native_id", "severity": "error"})
            id_tree_complete = False
    try:
        id_entries = structure_id_tree(root)
    except InspectionError as error:
        id_entries = {}
        id_tree_complete = False
        info['findings'].append({'code': str(error), 'severity': 'error'})
    for identifier, tags in native_ids.items():
        for tag in tags:
            node = native_objects[tag['id']]
            tag['idTreeVerified'] = (isinstance(resolved(node['/ID']), (TextStringObject, ByteStringObject))
                and len(tags) == 1 and id_entries.get(identifier) is node)
            if not tag['idTreeVerified']:
                id_tree_complete = False
                info['findings'].append({'code': 'structure_id_tree_target_mismatch', 'severity': 'error', 'tagId': tag['id']})
    for identifier, node in id_entries.items():
        matches = native_ids.get(identifier, [])
        if len(matches) != 1 or native_objects[matches[0]['id']] is not node:
            id_tree_complete = False
            info['findings'].append({'code': 'unreachable_or_mismatched_structure_id_tree_entry', 'severity': 'error'})
    info['native_id_tree'] = {'present': '/IDTree' in root, 'entryCount': len(id_entries), 'verified': id_tree_complete}
    by_tag = {tag['id']: tag for tag in info['tags']}

    def nearest_table(tag: dict[str, Any]) -> str | None:
        for _ in range(MAX_DEPTH):
            if tag['role'] == 'Table':
                return tag['id']
            tag = by_tag.get(tag.get('parentId'))
            if tag is None:
                return None
        return None

    for tag in info["tags"]:
        # ISO 32000 attribute precedence: later entries override earlier ones,
        # and direct /A overrides class /C for the same owner and attribute.
        # https://pdf-issues.pdfa.org/32000-2-2020/clause14.html#h14.7.6.1
        header_attributes = [attr for attr in tag['attributes']
            if attr.get('owner') == 'Table' and 'headersHex' in attr]
        effective_headers = header_attributes[-1] if header_attributes else None
        node = native_objects[tag['id']]
        classes = resolved(node.get('/C', []))
        classes = classes if isinstance(classes, list) else [classes]
        if header_attributes and ('/R' in node or any('revision' in attr for attr in tag['attributes'])
                or any(integer(entry) is not None for entry in classes)):
            effective_headers = None
            attribute_gaps += 1
            info['findings'].append({'code': 'table_header_attribute_revisions_unsupported',
                'severity': 'error', 'tagId': tag['id']})
        for attribute in tag["attributes"]:
            if "headersHex" in attribute:
                attribute['headersEffective'] = attribute is effective_headers
                if not attribute['headersEffective']:
                    continue
                attribute["headerTagIds"] = []
                attribute["headersResolved"] = True
                for header in attribute["headersHex"]:
                    matches = native_ids.get(header, [])
                    if len(matches) != 1 or matches[0]["role"] != "TH" or not matches[0].get('idTreeVerified'):
                        attribute["headersResolved"] = False
                        attribute_gaps += 1
                        info["findings"].append({"code": "unresolved_table_header_id", "severity": "error", "tagId": tag["id"]})
                    elif (matches[0]['id'] == tag['id'] or nearest_table(tag) is None
                          or nearest_table(tag) != nearest_table(matches[0])):
                        attribute['headersResolved'] = False
                        attribute_gaps += 1
                        info['findings'].append({'code': 'table_header_not_in_same_table', 'severity': 'error', 'tagId': tag['id']})
                    else:
                        attribute["headerTagIds"].append(matches[0]["id"])
    # Real, local IDs alone do not establish useful header relationships: a
    # TH can point back to one of its descendants. Resolve the bounded graph
    # iteratively so a cycle cannot pass or exhaust Python's recursion stack.
    header_graph = {tag['id']: set(header for attr in tag['attributes']
        if attr.get('headersEffective') for header in attr.get('headerTagIds', [])) for tag in info['tags']}
    reverse_headers: dict[str, set[str]] = {}
    for identity, headers in header_graph.items():
        for header in headers:
            reverse_headers.setdefault(header, set()).add(identity)
    remaining = {identity: len(headers) for identity, headers in header_graph.items()}
    pending = [identity for identity, count in remaining.items() if count == 0]
    while pending:
        for identity in reverse_headers.get(pending.pop(), set()):
            remaining[identity] -= 1
            if remaining[identity] == 0:
                pending.append(identity)
    # Anything left either participates in a cycle or depends on one. Each
    # vertex and edge is visited at most once, including pathological inputs.
    affected = {identity for identity, count in remaining.items() if count}
    if affected:
        attribute_gaps += 1
        info['findings'].append({'code': 'cyclic_table_header_relationship',
            'severity': 'error', 'tagIds': sorted(affected)[:MAX_FINDINGS]})
    for tag in info['tags']:
        for attribute in tag['attributes']:
            if 'headersResolved' in attribute:
                attribute['headersAcyclic'] = attribute['headersResolved'] and tag['id'] not in affected
    info['table_header_graph'] = {'cycleDetected': bool(affected),
        'resolvedEdgeCount': sum(len(headers) for headers in header_graph.values())}
    for page in info["page_content"]:
        if any((page["pageNumber"], mcid) not in content_seen for mcid in page["ownership_required_mcids"]):
            info["findings"].append({"code": "unowned_marked_content", "severity": "error", "page": page["pageNumber"]})
    for scope in form_scopes.values():
        if any((scope["id"], mcid) not in content_seen for mcid in scope["ownership_required_mcids"]):
            info["findings"].append({"code": "unowned_form_marked_content", "severity": "error", "page": scope["pageNumber"]})
    info["findings"].extend(navigation["findings"])
    info["findings"] = info["findings"][:MAX_FINDINGS]
    info["tag_count"] = len(info["tags"])
    info["mcid_count"] = sum(len(page["mcids"]) for page in info["page_content"]) + sum(len(scope["mcids"]) for scope in form_scopes.values())
    if not info["tag_count"]:
        info["findings"].append({"code": "empty_structure_tree", "severity": "error"})
    info["machine_checks_passed"] = not any(item["severity"] == "error" for item in info["findings"])
    info["checks_complete"] = id_tree_complete and not info["unresolved_content_references"] and info["navigation_checks_complete"] and not attribute_gaps and not any(tag.get("textIncomplete") for tag in info["tags"]) and all(page["artifactTextComplete"] for page in info["page_content"])
    return info


def figure_association_inventory(reader: PdfReader, *, include_actual_text: bool = False) -> dict[str, Any]:
    """Bind native Figures to exact paint occurrences, independently of tag IDs.

    The full normalized page program and resources must match before occurrence
    positions can establish identity. This avoids matching repeated images by
    payload alone and includes vector fills/strokes, text and shading. Internal
    Form MCIDs and reused Form content remain explicitly outside this subset.
    """
    pages = list(reader.pages)
    page_ids = {reference_key(page): number for number, page in enumerate(pages, 1)}
    root = resolved(reader.trailer["/Root"].get("/StructTreeRoot"))
    result: dict[str, Any] = {"figures": [], "replacementTexts": [], "inlineReplacementTexts": [], "pages": {}, "supported": True, "scope": "page-scoped MCIDs with exact normalized paint-occurrence membership; internal or reused Form content is not inferred"}
    form_uses: Counter = Counter()
    atom_count = 0
    paint_ops = {b"S", b"s", b"f", b"F", b"f*", b"B", b"B*", b"b", b"b*", b"sh", b"Do", b"INLINE IMAGE"}
    for page_number, page in enumerate(pages, 1):
        resources = resolved(page.get("/Resources", {}))
        properties = resolved(resources.get("/Properties", {}))
        tokens: list[Any] = []
        owned: dict[int, set[int]] = {}
        artifact_events: set[int] = set()
        forms_by_event: dict[int, Any] = {}
        stack: list[tuple[int | None, bool]] = []
        inline_stack: list[dict[str, Any] | None] = []
        language_stack: list[str | None] = []
        event_languages: dict[int, str] = {}
        page_inline: list[dict[str, Any]] = []
        declared_mcids: set[int] = set()
        gaps: set[str] = set()
        asset_hashes: dict[int, str] = {}
        canonical = Canonicalizer()

        def emit(token: Any, paint: bool = False, form: Any = None) -> None:
            nonlocal atom_count
            atom_count += 1
            if atom_count > MAX_PAINT_ATOMS:
                raise InspectionError("paint_atom_limit")
            index = len(tokens)
            tokens.append(token)
            if not paint:
                return
            language = next((value for value in reversed(language_stack) if value is not None), None)
            if language is not None: event_languages[index] = language
            for replacement in inline_stack:
                if replacement is not None:
                    replacement['events'].add(index)
                    if token[0] == 'text-byte': replacement['paintBytes'].append(token[1])
                    if token[0] != 'text-byte':
                        replacement['gaps'].add('nontext_inline_actual_text_scope')
                    if any(artifact for _, artifact in stack):
                        replacement['artifactEvents'].add(index)
            if any(artifact for _, artifact in stack):
                artifact_events.add(index)
            else:
                for mcid, _ in stack:
                    if mcid is not None:
                        owned.setdefault(mcid, set()).add(index)
            if form is not None:
                forms_by_event[index] = form
                form_uses[form] += 1

        for operands, operator in operations(page):
            if operator in (b"BMC", b"BDC"):
                if not operands or len(stack) >= MAX_DEPTH:
                    raise InspectionError("invalid_marked_content")
                artifact = str(operands[0]) == "/Artifact"
                mcid = None
                replacement = None
                scoped_language = None
                if operator == b"BDC":
                    props = resolved(operands[1]) if len(operands) == 2 else None
                    if isinstance(props, NameObject):
                        props = resolved(properties.get(props))
                    if not isinstance(props, dict):
                        gaps.add("unsupported_marked_content_properties")
                    elif "/MCID" in props:
                        mcid = integer(props["/MCID"])
                        if mcid is None or mcid in declared_mcids:
                            gaps.add("duplicate_or_invalid_mcid")
                        elif any(key is not None for key, _ in stack):
                            gaps.add("nested_mcid_scope_unsupported")
                        else:
                            declared_mcids.add(mcid)
                    if isinstance(props, dict) and '/Lang' in props:
                        if isinstance(resolved(props['/Lang']), TextStringObject) and len(str(props['/Lang'])) <= 256:
                            scoped_language = str(props['/Lang'])
                        else: gaps.add('unsupported_marked_content_language')
                    if isinstance(props, dict) and '/ActualText' in props:
                        replacement = {'id': f'inline-actualtext-{len(result["inlineReplacementTexts"]) + len(page_inline) + 1}',
                            'pageNumber': page_number, 'events': set(), 'artifactEvents': set(), 'paintBytes': [], 'gaps': set()}
                        value, _ = native_string(props['/ActualText'], 2048)
                        replacement['actualText'] = value
                        if not isinstance(props['/ActualText'], TextStringObject) or len(str(props['/ActualText'])) > 2048:
                            replacement['gaps'].add('unsupported_inline_actual_text_value')
                        if set(props) - {'/ActualText', '/MCID'}:
                            replacement['gaps'].add('unsupported_inline_actual_text_properties')
                        if any(item is not None for item in inline_stack):
                            replacement['gaps'].add('nested_inline_actual_text_scope')
                            for item in inline_stack:
                                if item is not None:item['gaps'].add('nested_inline_actual_text_scope')
                        page_inline.append(replacement)
                        if len(result['inlineReplacementTexts']) + len(page_inline) > MAX_TAGS:
                            raise InspectionError('inline_actual_text_limit')
                stack.append((mcid, artifact))
                language_stack.append(scoped_language)
                inline_stack.append(replacement)
                continue
            if operator == b"EMC":
                if not stack:
                    gaps.add("unbalanced_marked_content")
                else:
                    stack.pop()
                    language_stack.pop()
                    inline_stack.pop()
                continue
            if operator in (b"MP", b"DP"):
                continue
            if operator in (b"Tj", b"TJ", b"'", b'"'):
                if operator in (b"'", b'"'):
                    emit([operator.decode("ascii"), canonical.value(operands[:-1])])
                pieces = operands[0] if operator == b"TJ" else operands[-1:]
                for piece in pieces:
                    if isinstance(piece, (str, bytes)):
                        raw = piece.original_bytes if isinstance(piece, TextStringObject) else bytes(piece) if isinstance(piece, bytes) else piece.encode("utf-8")
                        for byte in raw:
                            emit(["text-byte", byte], paint=True)
                    else:
                        amount = float(piece)
                        if not math.isfinite(amount):
                            raise InspectionError("invalid_number")
                        if amount:
                            if tokens and tokens[-1][0] == "text-adjust":
                                tokens[-1][1] += amount
                            else:
                                emit(["text-adjust", amount])
                continue
            form = None
            token = [operator.decode("ascii"), canonical.value(operands)]
            if operator == b"Do":
                asset = resolved(resolved(resources.get("/XObject", {})).get(operands[0])) if len(operands) == 1 else None
                if not isinstance(asset, StreamObject) or asset.get("/Subtype") not in ("/Form", "/Image"):
                    gaps.add("unresolved_painted_xobject")
                else:
                    if id(asset) not in asset_hashes:
                        asset_hashes[id(asset)] = Canonicalizer().hash(asset)
                    token.append(asset_hashes[id(asset)])
                    if asset.get("/Subtype") == "/Form":
                        form = reference_key(asset) or ("direct", id(asset))
            emit(token, operator in paint_ops, form)
        if stack:
            gaps.add("unbalanced_marked_content")
        result["pages"][page_number] = {"executionHash": digest(json.dumps(tokens, separators=(",", ":"), ensure_ascii=True).encode()), "resourcesHash": Canonicalizer().hash(resources), "owned": owned, "artifactEvents": artifact_events, "eventLanguages": event_languages, "formsByEvent": forms_by_event, "gaps": gaps}
        for replacement in page_inline:
            replacement['gaps'].update(gaps)
            if not replacement['events']:
                replacement['gaps'].add('empty_inline_actual_text_scope')
            membership = {'pageNumber': page_number,
                'executionHash': result['pages'][page_number]['executionHash'],
                'resourcesHash': result['pages'][page_number]['resourcesHash'],
                'paintOccurrences': sorted(replacement['events'])}
            replacement['membershipHash'] = digest(json.dumps(membership, sort_keys=True, separators=(',', ':')).encode()) if not replacement['gaps'] else None
            replacement['supported'] = not replacement['gaps']
            replacement['contentKeys'] = [{'pageNumber': page_number, 'mcid': mcid}
                for mcid, events in owned.items() if replacement['events'] & events]
            replacement['gaps'] = sorted(replacement['gaps'])
            result['inlineReplacementTexts'].append(replacement)
    if not isinstance(root, dict):
        return result
    try:
        parents = number_tree(root.get("/ParentTree"))
    except InspectionError:
        parents = None
    role_map = resolved(root.get("/RoleMap", {}))
    visited: set[int] = set()

    def effective_language(item: Any) -> str | None:
        seen: set[int] = set()
        for _ in range(MAX_DEPTH):
            item = resolved(item)
            if not isinstance(item, dict) or id(item) in seen: break
            seen.add(id(item))
            if '/Lang' in item:
                language = resolved(item['/Lang'])
                if not isinstance(language, TextStringObject) or len(str(language)) > 256:
                    raise InspectionError('unsupported_actual_text_language')
                return str(language)
            item = item.get('/P')
        language = resolved(reader.trailer['/Root'].get('/Lang'))
        return str(language) if isinstance(language, TextStringObject) else None

    def page_of(item: Any, inherited: int | None) -> int | None:
        return page_ids.get(reference_key(item["/Pg"])) if "/Pg" in item else inherited

    def collect(item: Any, owner: Any, page_number: int | None, leaves: list[Any], gaps: set[str], depth: int = 0, active: set[int] | None = None) -> None:
        if depth > MAX_DEPTH or len(leaves) > MAX_NODES:
            raise InspectionError("structure_complexity_limit")
        item = resolved(item)
        active = set() if active is None else active
        if isinstance(item, (list, dict)):
            if id(item) in active:
                gaps.add("cyclic_figure_structure")
                return
            active = active | {id(item)}
        if isinstance(item, list):
            for child in item:
                collect(child, owner, page_number, leaves, gaps, depth + 1, active)
        elif integer(item) is not None:
            leaves.append((page_number, integer(item), owner))
        elif isinstance(item, dict):
            page_number = page_of(item, page_number)
            if item.get("/Type") == "/MCR":
                if item.get("/Stm") is not None:
                    gaps.add("internal_form_mcid_unsupported")
                else:
                    leaves.append((page_number, integer(item.get("/MCID")), owner))
            elif item.get("/Type") == "/OBJR":
                gaps.add("figure_object_reference_unsupported")
            elif item.get("/Type") == "/StructElem" or "/S" in item:
                collect(item.get("/K"), item, page_number, leaves, gaps, depth + 1, active)
            else:
                gaps.add("unsupported_figure_content")
        else:
            gaps.add("unsupported_figure_content")

    def walk(item: Any, inherited: int | None = None, depth: int = 0) -> None:
        item = resolved(item)
        if depth > MAX_DEPTH or len(visited) > MAX_TAGS:
            raise InspectionError("structure_complexity_limit")
        if isinstance(item, list):
            for child in item:
                walk(child, inherited, depth + 1)
            return
        if not isinstance(item, dict) or id(item) in visited:
            return
        visited.add(id(item))
        page_number = page_of(item, inherited)
        role = str(item.get("/S", ""))
        seen_roles: set[str] = set()
        while role not in ("/" + value for value in STANDARD_ROLES) and role in role_map and role not in seen_roles:
            seen_roles.add(role)
            role = str(resolved(role_map[role]))
        if role == "/Figure" or (include_actual_text and "/ActualText" in item):
            leaves: list[Any] = []
            gaps: set[str] = set()
            collect(item.get("/K"), item, page_number, leaves, gaps)
            events: dict[int, set[int]] = {}
            leaf_ids: list[dict[str, Any]] = []
            seen_leaves: set[tuple[int, int]] = set()
            for leaf_page, mcid, owner in leaves:
                if leaf_page is None or mcid is None or leaf_page not in result["pages"]:
                    gaps.add("unresolved_figure_content_location")
                    continue
                if (leaf_page, mcid) in seen_leaves:
                    gaps.add("duplicate_figure_content_reference")
                seen_leaves.add((leaf_page, mcid))
                leaf_ids.append({"pageNumber": leaf_page, "mcid": mcid})
                scan = result["pages"][leaf_page]
                gaps.update(scan["gaps"])
                parent_key = integer(pages[leaf_page - 1].get("/StructParents"))
                parent_array = parents.get(parent_key) if parents is not None else None
                if not isinstance(parent_array, list) or mcid >= len(parent_array) or resolved(parent_array[mcid]) is not owner:
                    gaps.add("figure_parent_tree_owner_mismatch")
                paint = scan["owned"].get(mcid, set())
                if not paint:
                    gaps.add("figure_has_no_semantic_paint")
                events.setdefault(leaf_page, set()).update(paint)
                if any(form_uses[scan["formsByEvent"][event]] > 1 for event in paint if event in scan["formsByEvent"]):
                    gaps.add("reused_form_figure_unsupported")
            membership = [{"pageNumber": number, "executionHash": result["pages"][number]["executionHash"], "resourcesHash": result["pages"][number]["resourcesHash"], "paintOccurrences": sorted(indices)} for number, indices in sorted(events.items())]
            if not membership:
                gaps.add("empty_figure_membership")
            destination = result['figures'] if role == '/Figure' else result['replacementTexts']
            prefix = 'figure' if role == '/Figure' else 'actualtext'
            figure: dict[str, Any] = {"id": f"{prefix}-{len(destination) + 1}", "role": role.lstrip('/'), "pageNumber": page_number, "contentKeys": leaf_ids, "paintCount": sum(len(indices) for indices in events.values()), "membershipHash": digest(json.dumps(membership, sort_keys=True, separators=(",", ":")).encode()) if not gaps else None, "supported": not gaps, "gaps": sorted(gaps), "events": events}
            if role == '/Figure':
                # A copied description read in a different authored language is
                # not equivalent, even when its Unicode string and paint match.
                # Alt/ActualText on the StructElem inherits native language;
                # language scopes on painted labels do not override this value.
                figure['descriptionLanguage'] = effective_language(item)
            if role != '/Figure':
                fallback_language = effective_language(item)
                languages = {result['pages'][number]['eventLanguages'].get(event, fallback_language)
                    for number, indices in events.items() for event in indices}
                figure['effectiveLanguages'] = sorted(languages, key=lambda value: value or '')
            for key, name in (("/Alt", "alt"), ("/ActualText", "actualText")):
                if key in item:
                    figure[name], _ = native_string(item[key], 8000)
            destination.append(figure)
        walk(item.get("/K"), page_number, depth + 1)
    walk(root.get("/K"))
    result["supported"] = all(figure["supported"] for figure in result["figures"])
    return result


def _verified_figure_alternative_replacements(proof, source, output):
    if proof is None:
        return {}
    # This private proof never comes from a request or saved PDF. Revalidate it
    # against the actual bytes and independently discovered paint owners.
    from native_image_alternatives import AlternativeReplacementError, verify_replacements
    try:
        return verify_replacements(proof, source, output)
    except AlternativeReplacementError:
        raise InspectionError("approved_figure_description_invalid") from None


def compare_figure_associations(source: PdfReader, output: PdfReader, *, _approved_figure_alternatives=None) -> dict[str, Any]:
    approved = _verified_figure_alternative_replacements(_approved_figure_alternatives, source, output)
    before = figure_association_inventory(source)
    after = figure_association_inventory(output)
    comparisons = []
    used_candidates: set[str] = set()
    for original in before["figures"]:
        matches = [candidate for candidate in after["figures"] if original["membershipHash"] is not None and candidate["membershipHash"] == original["membershipHash"]]
        row: dict[str, Any] = {"sourceFigureId": original["id"], "pageNumber": original["pageNumber"], "sourceContentKeys": original["contentKeys"], "sourcePaintCount": original["paintCount"], "candidateCount": len(matches), "membershipVerified": False, "descriptionsIdentical": False, "gaps": original["gaps"]}
        if len(matches) == 1 and matches[0]["id"] not in used_candidates:
            candidate = matches[0]
            used_candidates.add(candidate["id"])
            row.update({"outputFigureId": candidate["id"], "outputContentKeys": candidate["contentKeys"], "membershipVerified": True, "descriptionsIdentical": all(key not in original or candidate.get(key) == original[key] for key in ("alt", "actualText"))})
            row.update({'sourceDescriptionLanguage': original.get('descriptionLanguage'),
                        'outputDescriptionLanguage': candidate.get('descriptionLanguage'),
                        'descriptionLanguageIdentical': not any(key in original for key in ('alt', 'actualText'))
                            or original.get('descriptionLanguage') is None
                            or candidate.get('descriptionLanguage') == original['descriptionLanguage']})
            replacement = approved.get(original["id"])
            if replacement is not None:
                row["descriptionReplacementVerified"] = (
                    replacement["membershipHash"] == original["membershipHash"]
                    and original.get("alt") == replacement["beforeAlt"]
                    and candidate.get("alt") == replacement["afterAlt"]
                    and "actualText" not in original and "actualText" not in candidate)
            if not row["descriptionsIdentical"] and not row.get("descriptionReplacementVerified"):
                row["failureCode"] = "authored_figure_description_changed"
            elif not row['descriptionLanguageIdentical']:
                row['failureCode'] = 'authored_figure_description_language_changed'
        elif not original["supported"]:
            row["failureCode"] = "figure_membership_unverified"
        elif matches:
            row["failureCode"] = "ambiguous_figure_membership"
        else:
            hidden = False
            for number, events in original["events"].items():
                a, b = before["pages"][number], after["pages"].get(number)
                if b and a["executionHash"] == b["executionHash"] and a["resourcesHash"] == b["resourcesHash"] and events & b["artifactEvents"]:
                    hidden = True
            row["failureCode"] = "source_figure_hidden_as_artifact" if hidden else "source_figure_membership_changed"
        comparisons.append(row)
    return {"passed": all(row["membershipVerified"] and (row["descriptionsIdentical"] or row.get("descriptionReplacementVerified")) and row.get('descriptionLanguageIdentical') for row in comparisons), "checksComplete": all(row["membershipVerified"] for row in comparisons), "sourceFigureCount": len(before["figures"]), "outputFigureCount": len(after["figures"]), "comparisons": comparisons, "scope": before["scope"]}


def compare_actual_text_associations(source: PdfReader, output: PdfReader) -> dict[str, Any]:
    """Preserve authored replacement text on its exact native painted content.

    This covers non-Figure native StructElem ActualText, including soft-hyphen
    Spans. It does not infer substitutions from extracted whitespace or accept
    a copied string attached elsewhere. Unsupported Form/OBJR scopes fail closed.
    """
    before = figure_association_inventory(source, include_actual_text=True)
    after = figure_association_inventory(output, include_actual_text=True)
    source_properties = [item['pageNumber'] for item in before['inlineReplacementTexts'] if not item['supported']]
    output_properties = [item['pageNumber'] for item in after['inlineReplacementTexts'] if not item['supported']]
    comparisons = []
    used: set[str] = set()
    for original in before['replacementTexts']:
        matches = [candidate for candidate in after['replacementTexts']
                   if original['membershipHash'] is not None and candidate['membershipHash'] == original['membershipHash']]
        row = {'sourceReplacementId': original['id'], 'pageNumber': original['pageNumber'],
               'sourceRole': original['role'], 'sourceContentKeys': original['contentKeys'],
               'sourcePaintCount': original['paintCount'], 'candidateCount': len(matches),
               'membershipVerified': False, 'replacementTextIdentical': False, 'gaps': original['gaps']}
        if len(matches) == 1 and matches[0]['id'] not in used:
            candidate = matches[0]; used.add(candidate['id'])
            row.update({'outputReplacementId': candidate['id'], 'outputContentKeys': candidate['contentKeys'],
                        'membershipVerified': True, 'replacementTextIdentical': candidate.get('actualText') == original.get('actualText'),
                        'sourceLanguages': original.get('effectiveLanguages'), 'outputLanguages': candidate.get('effectiveLanguages'),
                        'languageIdentical': candidate.get('effectiveLanguages') == original.get('effectiveLanguages')})
            if not row['replacementTextIdentical']: row['failureCode'] = 'authored_actual_text_changed'
            elif not row['languageIdentical']: row['failureCode'] = 'authored_actual_text_language_changed'
        elif not original['supported']:
            row['failureCode'] = 'authored_actual_text_membership_unverified'
        elif matches:
            row['failureCode'] = 'ambiguous_authored_actual_text_membership'
        else:
            hidden = any(number in after['pages'] and before['pages'][number]['executionHash'] == after['pages'][number]['executionHash']
                         and before['pages'][number]['resourcesHash'] == after['pages'][number]['resourcesHash']
                         and bool(events & after['pages'][number]['artifactEvents']) for number, events in original['events'].items())
            row['failureCode'] = 'authored_actual_text_hidden_as_artifact' if hidden else 'authored_actual_text_membership_lost'
        comparisons.append(row)
    inline_comparisons = []
    used_inline: set[str] = set()
    original_position = source.stream.tell()
    try:
        source.stream.seek(0)
        source_bytes = source.stream.read(MAX_FILE_BYTES + 1)
        reviewed_whitespace = REVIEWED_WHITESPACE_ARTIFACTS.get(digest(source_bytes), {}) if len(source_bytes) <= MAX_FILE_BYTES else {}
    finally:
        source.stream.seek(original_position)
    for original in before['inlineReplacementTexts']:
        matches = [item for item in after['inlineReplacementTexts'] if original['membershipHash'] is not None and item['membershipHash'] == original['membershipHash']]
        row = {'sourceReplacementId': original['id'], 'pageNumber': original['pageNumber'],
            'sourcePaintCount': len(original['events']), 'sourceActualText': original['actualText'],
            'sourceContentKeys': original['contentKeys'],
            'sourceArtifactPaintCount': len(original['artifactEvents']),
            'membershipVerified': False, 'replacementTextIdentical': False, 'gaps': original['gaps']}
        if len(matches) == 1 and matches[0]['id'] not in used_inline:
            candidate = matches[0]; used_inline.add(candidate['id'])
            row.update({'outputReplacementId': candidate['id'], 'membershipVerified': True,
                'outputContentKeys': candidate['contentKeys'],
                'replacementTextIdentical': original['actualText'] == candidate['actualText'],
                'outputArtifactPaintCount': len(candidate['artifactEvents']),
                'artifactMembershipIdentical': original['artifactEvents'] == candidate['artifactEvents']})
            if not row['replacementTextIdentical']: row['failureCode'] = 'authored_inline_actual_text_changed'
            elif not row['artifactMembershipIdentical']:
                reason = reviewed_whitespace.get(original['membershipHash'])
                allowed = bool(reason and original['actualText'] == '\t'
                    and original['paintBytes'] == candidate['paintBytes'] == [32]
                    and not original['artifactEvents'] and candidate['artifactEvents'] == original['events'])
                if allowed:
                    row['reviewedWhitespaceArtifactChange'] = {'allowed': True, 'reason': reason,
                        'exactSourceAndPaintIdentityVerified': True, 'meaningfulCharactersHidden': False}
                else: row['failureCode'] = 'authored_inline_actual_text_artifact_membership_changed'
        else:
            row['failureCode'] = 'authored_inline_actual_text_membership_unverified' if not original['supported'] else 'authored_inline_actual_text_membership_lost_or_ambiguous'
        inline_comparisons.append(row)
    unexpected_inline = [item['id'] for item in after['inlineReplacementTexts'] if item['id'] not in used_inline]
    inline_passed = not source_properties and not output_properties and not unexpected_inline and all(
        row['membershipVerified'] and row['replacementTextIdentical'] and (row.get('artifactMembershipIdentical') or row.get('reviewedWhitespaceArtifactChange', {}).get('allowed')) for row in inline_comparisons)
    return {'passed': inline_passed and all(row['membershipVerified'] and row['replacementTextIdentical'] and row.get('languageIdentical') for row in comparisons),
            'checksComplete': not source_properties and not output_properties and not unexpected_inline
                and all(row['membershipVerified'] for row in [*comparisons, *inline_comparisons]),
            'sourceReplacementCount': len(before['replacementTexts']), 'outputReplacementCount': len(after['replacementTexts']),
            'unsupportedMarkedContentActualText': {'sourcePages':sorted(set(source_properties)), 'outputPages':sorted(set(output_properties))},
            'markedContentComparisons': inline_comparisons, 'sourceInlineReplacementCount': len(before['inlineReplacementTexts']),
            'outputInlineReplacementCount': len(after['inlineReplacementTexts']), 'unexpectedOutputInlineReplacements': unexpected_inline,
            'comparisons': comparisons, 'scope': 'Authored native StructElem ActualText and text-only inline replacement scopes; ' + before['scope']}


class _PdfInspection:
    """Request-local evidence derived only from a fresh parse of exact PDF bytes.

    Native readers and writers are never retained or supplied by callers. The
    private raw snapshot is copied before report enrichment, and can be reused
    only for the identical saved bytes that produced it.
    """
    __slots__ = ('_bytes', '_inventory')

    def __init__(self, data: bytes):
        if type(data) is not bytes or not 0 < len(data) <= MAX_FILE_BYTES:
            raise InspectionError('invalid_inspection_evidence')
        reader = PdfReader(io.BytesIO(data), strict=True)
        if reader.is_encrypted:
            raise InspectionError('encrypted_pdf_unsupported')
        self._bytes = data
        self._inventory = structure_inventory(reader)

    def fresh_reader(self) -> PdfReader:
        return PdfReader(io.BytesIO(self._bytes), strict=True)

    def copy_for(self, data: bytes) -> dict[str, Any]:
        if type(data) is not bytes or data != self._bytes:
            raise InspectionError('inspection_bytes_changed')
        return copy.deepcopy(self._inventory)


class _PdfInspectionCapture:
    __slots__ = ('source', 'output')

    def __init__(self):
        self.source = self.output = None


def compare_pdfs(source: Path, output: Path, strict_text_subset: bool = False, *,
                 _capture=None, _source_inspection=None, _output_inspection=None,
                 _approved_figure_alternatives=None) -> dict[str, Any]:
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
        if (_capture is not None and (type(_capture) is not _PdfInspectionCapture
                or _capture.source is not None or _capture.output is not None)):
            raise InspectionError('invalid_inspection_evidence')
        if any(item is not None and type(item) is not _PdfInspection
               for item in (_source_inspection, _output_inspection)):
            raise InspectionError('invalid_inspection_evidence')
        for path in (source, output):
            if not path.is_file() or path.stat().st_size > MAX_FILE_BYTES:
                raise InspectionError("file_missing_or_too_large")
        saved_bytes = [path.read_bytes() for path in (source, output)]
        readers = [PdfReader(io.BytesIO(data), strict=True) for data in saved_bytes]
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
        report['navigation'] = compare_annotations(before, after)
        if not report['navigation']['passed']:
            finding('annotation_navigation_changed_or_uninspected', 'The repaired PDF changed a link or destination dictionary, or its navigation could not be safely inspected.')
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
        differing_pages = [index + 1 for index, (left, right) in enumerate(zip(source_pixels, output_pixels)) if left != right]
        # No content/behavior/resource mismatch is eligible for a rasterization
        # exception. The additional exact renders cannot dismiss other findings.
        equivalent = verify_rendering_equivalence(source, output, differing_pages) if not report["findings"] else {}
        for index, (left, right) in enumerate(zip(source_pixels, output_pixels)):
            same = left == right
            report["preservation"]["pages"][index]["pixels_identical"] = same
            if index + 1 in equivalent:
                report["preservation"]["pages"][index]["rendering_equivalence"] = equivalent[index + 1]
            if not same and index + 1 not in equivalent:
                finding("page_pixels_changed", "The repaired page does not render identically to the original.", index + 1)
        if equivalent:
            report["preservation"]["rendering_equivalence"] = {"method": "identical-paint-multiscale-v1", "pages": list(equivalent.values())}
        report["preservation"]["passed"] = not report["findings"]
        inspections = [item if item is not None else _PdfInspection(data)
                       for item, data in zip((_source_inspection, _output_inspection), saved_bytes)]
        report["source_structure"], report["structure"] = [
            item.copy_for(data) for item, data in zip(inspections, saved_bytes)]
        source_figures = sum(tag["role"] == "Figure" for tag in report["source_structure"]["tags"])
        output_figures = sum(tag["role"] == "Figure" for tag in report["structure"]["tags"])
        report["structure"]["figure_counts"] = {"source": source_figures, "output": output_figures}
        if output_figures < source_figures:
            finding("existing_figure_tags_lost", "The repaired PDF contains fewer figure tags than the original; image meaning may no longer be available to a screen reader.")
        source_alts = sorted(tag["alt"] for tag in report["source_structure"]["tags"] if "alt" in tag)
        output_alts = sorted(tag["alt"] for tag in report["structure"]["tags"] if "alt" in tag)
        approved = _verified_figure_alternative_replacements(_approved_figure_alternatives, before, after)
        required_alts = list(source_alts)
        for replacement in approved.values():
            # The original string remains in the immutable uploaded source.
            # Exempt only this exact, paint-bound and independently verified
            # generic label; all other authored alternatives remain required.
            required_alts.remove(replacement["beforeAlt"])
        remaining = list(output_alts)
        for alt in required_alts:
            if alt in remaining:
                remaining.remove(alt)
            else:
                finding("authored_alternative_lost_or_changed", "An existing image description was lost or changed in the repaired PDF.")
                report["preservation"]["passed"] = False
                break
        report["structure"]["authored_alternative_strings_retained"] = not bool(Counter(source_alts) - Counter(output_alts))
        if approved:
            report["structure"]["approved_figure_alternative_replacements"] = approved
        report["figure_associations"] = compare_figure_associations(before, after, _approved_figure_alternatives=_approved_figure_alternatives)
        report['actual_text_associations'] = compare_actual_text_associations(before, after)
        property_gaps=report['actual_text_associations']['unsupportedMarkedContentActualText']
        if property_gaps['sourcePages'] or property_gaps['outputPages']:
            finding('marked_content_actual_text_association_unverified', 'Replacement text in marked-content properties requires a separate association check; it cannot be discarded as a harmless wrapper.')
            report['preservation']['passed'] = False
        if report['actual_text_associations']['unexpectedOutputInlineReplacements']:
            finding('unexpected_inline_actual_text', 'The repaired PDF introduced inline replacement text that is not associated with the same authored source scope.')
            report['preservation']['passed'] = False
        for comparison in [*report['actual_text_associations']['comparisons'], *report['actual_text_associations']['markedContentComparisons']]:
            if comparison.get('failureCode'):
                finding(comparison['failureCode'], 'An authored replacement text span was lost, changed, or moved away from its original painted content.', comparison.get('pageNumber'))
                report['preservation']['passed'] = False
        nonfigure_source_alts = any("alt" in tag and tag["role"] != "Figure" for tag in report["source_structure"]["tags"])
        report["structure"]["authored_alternative_associations_verified"] = report["figure_associations"]["passed"] and not nonfigure_source_alts
        for comparison in report["figure_associations"]["comparisons"]:
            if comparison.get("failureCode"):
                finding(comparison["failureCode"], "An original figure's exact painted content and authored description could not both be verified in the repaired PDF.", comparison.get("pageNumber"))
        report["structure"]["passed"] = report["structure"].get("machine_checks_passed", False)
        if strict_text_subset:
            try:
                report["structure"]["strict_text_subset"] = check_structure(after)
            except InspectionError as error:
                report["structure"]["passed"] = False
                finding(str(error), "The PDF's saved tag structure did not pass the supported-subset machine checks.")
        report["mechanical_checks_passed"] = report["preservation"]["passed"] and report["structure"]["passed"] and not report["findings"]
        report["passed"] = report["mechanical_checks_passed"] and report["structure"].get("checks_complete", False) and not report["structure"].get("findings") and report["structure"]["authored_alternative_associations_verified"]
        if any(path.read_bytes() != data for path, data in zip((source, output), saved_bytes)):
            raise InspectionError('inspection_bytes_changed')
        if _capture is not None:
            _capture.source, _capture.output = inspections
    except InspectionError as error:
        report['passed'] = False
        report["inspection_incomplete"] = True
        report['preservation']['passed'] = False
        report['mechanical_checks_passed'] = False
        finding(str(error), "The checker could not complete a supported, bounded inspection of these PDFs.")
    except Exception:
        report['passed'] = False
        report["inspection_incomplete"] = True
        report['preservation']['passed'] = False
        report['mechanical_checks_passed'] = False
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
