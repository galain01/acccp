"""Bounded technical repairs for local PDF/UA-1 experiments.

These operations do not establish accessibility or conformance. They never
replace fonts, redraw a page, change tags' meaning, or infer missing language.
The separate declaration setter creates an evaluation artifact that must pass
fresh preservation, semantic and ISO 14289-1:2014 checks on its final hash.

Technical rules: https://github.com/veraPDF/veraPDF-validation-profiles/wiki/PDFUA-Part-1-rules
Canonical glyph mapping: https://www.unicode.org/Public/MAPPINGS/VENDORS/ADOBE/zdingbat.txt
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
from pathlib import Path
import re
from xml.etree import ElementTree as ET
from xml.sax.saxutils import escape

from pypdf import PdfReader, PdfWriter
from pypdf.generic import (ArrayObject, BooleanObject, DecodedStreamObject,
                           DictionaryObject, NameObject, NumberObject, StreamObject)
from pdf_safety import reject_signed_pdf, resolved

MAX_BYTES = 4 * 1024 * 1024
MAX_NODES = 100_000
MAX_XMP_BYTES = 1024 * 1024
RDF = "http://www.w3.org/1999/02/22-rdf-syntax-ns#"
DC = "http://purl.org/dc/elements/1.1/"
UA = "http://www.aiim.org/pdfua/ns/id/"


def _open(source: Path, output: Path) -> tuple[PdfReader, PdfWriter]:
    if source.resolve() == output.resolve() or output.exists() or not source.is_file() or source.stat().st_size > MAX_BYTES:
        raise ValueError("new_output_and_bounded_source_required")
    with source.open("rb") as stream:
        snapshot = stream.read(MAX_BYTES + 1)
    if len(snapshot) > MAX_BYTES:
        raise ValueError("bounded_source_required")
    reader = PdfReader(io.BytesIO(snapshot), strict=True)
    if reader.is_encrypted or not 1 <= len(reader.pages) <= 60:
        raise ValueError("unsupported_source")
    reject_signed_pdf(reader)
    return reader, PdfWriter(clone_from=reader)


def _save(writer: PdfWriter, output: Path) -> str:
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("xb") as stream:
        writer.write(stream)
    PdfReader(output, strict=True)
    return hashlib.sha256(output.read_bytes()).hexdigest()


def _objects(root):
    """Visit all reachable dictionaries, including annotation/default fonts."""
    pending = [(root, "Catalog", 0)]
    seen = set()
    count = 0
    while pending:
        value, path, depth = pending.pop()
        value = resolved(value)
        count += 1
        if count > MAX_NODES or depth > 128:
            raise ValueError("object_graph_limit")
        if not isinstance(value, (DictionaryObject, ArrayObject)) or id(value) in seen:
            continue
        seen.add(id(value))
        if isinstance(value, DictionaryObject):
            yield value, path
            pending.extend((child, path + str(key), depth + 1) for key, child in value.items()
                           if key not in ("/Parent", "/P", "/Prev", "/Next"))
        else:
            pending.extend((child, f"{path}[{index}]", depth + 1) for index, child in enumerate(value))


def font_resources(root) -> list[dict]:
    """Inventory resources; an unembedded unused resource is not a failed rule."""
    result = []
    for obj, path in _objects(root):
        if obj.get("/Type") != "/Font":
            continue
        descriptor = resolved(obj.get("/FontDescriptor"))
        embedded = isinstance(descriptor, DictionaryObject) and any(
            isinstance(resolved(descriptor.get(key)), StreamObject)
            for key in ("/FontFile", "/FontFile2", "/FontFile3"))
        result.append({"location": path, "base_font": str(obj.get("/BaseFont", "")),
                       "subtype": str(obj.get("/Subtype", "")), "embedded_program": bool(embedded),
                       "to_unicode_present": obj.get("/ToUnicode") is not None,
                       "resource_only_inventory": True,
                       "font_program_available_in_resource": bool(embedded),
                       "note": "Rendering-use validation is required; missing programs are never replaced with similar fonts."})
    return result


def _xmp(root) -> tuple[bytes, ET.Element]:
    metadata = resolved(root.get("/Metadata"))
    if metadata is None:
        data = b'<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="' + RDF.encode() + b'"></rdf:RDF></x:xmpmeta>'
    elif isinstance(metadata, StreamObject):
        data = metadata.get_data()
    else:
        raise ValueError("invalid_xmp_stream")
    if len(data) > MAX_XMP_BYTES or b"\x00" in data or b"<!DOCTYPE" in data.upper() or b"<!ENTITY" in data.upper():
        raise ValueError("unsupported_xmp")
    # Keep existing bytes (including unknown schemas and packet wrappers) intact.
    # Non-UTF-8 packets are left to a fuller metadata implementation.
    data.decode("utf-8-sig", errors="strict")
    tree = ET.fromstring(data)
    if len(list(tree.iter())) > 10_000 or len(list(tree.iter(f"{{{RDF}}}RDF"))) != 1:
        raise ValueError("invalid_xmp_rdf")
    return data, tree


def _append_xmp(writer: PdfWriter, data: bytes, addition: str) -> None:
    namespaces = list(ET.iterparse(io.BytesIO(data), events=("start-ns",)))
    prefixes = {prefix for _, (prefix, uri) in namespaces if uri == RDF}
    candidates = []
    for prefix in prefixes:
        name = (prefix + ":" if prefix else "") + "RDF"
        candidates.extend(re.finditer(rb"</" + re.escape(name.encode()) + rb"\s*>", data))
    if len(candidates) != 1:
        raise ValueError("unsupported_xmp_serialization")
    at = candidates[0].start()
    new_data = data[:at] + addition.encode("utf-8") + data[at:]
    ET.fromstring(new_data)
    metadata = DecodedStreamObject()
    metadata[NameObject("/Type")] = NameObject("/Metadata")
    metadata[NameObject("/Subtype")] = NameObject("/XML")
    metadata.set_data(new_data)
    writer.root_object[NameObject("/Metadata")] = writer._add_object(metadata)


def _same(a, b) -> bool:
    return a is not None and b is not None and resolved(a) is resolved(b)


def _number_tree(root) -> dict[int, object]:
    pending, seen, result = [root], set(), {}
    while pending:
        obj = resolved(pending.pop())
        if not isinstance(obj, DictionaryObject) or id(obj) in seen or len(seen) > 10_000:
            raise ValueError("invalid_parent_tree")
        seen.add(id(obj))
        nums = resolved(obj.get("/Nums", ArrayObject()))
        kids = resolved(obj.get("/Kids", ArrayObject()))
        if not isinstance(nums, ArrayObject) or len(nums) % 2 or not isinstance(kids, ArrayObject):
            raise ValueError("invalid_parent_tree")
        for i in range(0, len(nums), 2):
            key = nums[i]
            if not isinstance(key, NumberObject) or int(key) in result:
                raise ValueError("invalid_parent_tree")
            result[int(key)] = nums[i + 1]
        pending.extend(kids)
    return result


def _annotation_links(root) -> tuple[dict, dict]:
    structure = resolved(root.get("/StructTreeRoot"))
    if not isinstance(structure, DictionaryObject):
        raise ValueError("structure_tree_required")
    parents = _number_tree(structure.get("/ParentTree"))
    found, pending, seen = {}, [(structure, None, None)], set()
    while pending:
        node, owner, page = pending.pop()
        node = resolved(node)
        if isinstance(node, (ArrayObject, DictionaryObject)):
            if id(node) in seen or len(seen) > 20_000:
                raise ValueError("invalid_structure_tree")
            seen.add(id(node))
        if isinstance(node, ArrayObject):
            pending.extend((item, owner, page) for item in node)
            continue
        if not isinstance(node, DictionaryObject):
            continue
        page = node.get("/Pg", page)
        if node.get("/Type") == "/OBJR":
            annotation = resolved(node.get("/Obj"))
            if not isinstance(annotation, DictionaryObject):
                raise ValueError("invalid_annotation_reference")
            found.setdefault(id(annotation), []).append((owner, page))
        else:
            next_owner = node if node.get("/Type") == "/StructElem" else owner
            pending.append((node.get("/K"), next_owner, page))
    return parents, found


def _repair_tabs(writer: PdfWriter, changes: list, unresolved: list) -> None:
    pages = [(index, page, resolved(page.get("/Annots", ArrayObject()))) for index, page in enumerate(writer.pages)]
    if not any(annotations for _, _, annotations in pages):
        return
    try:
        parents, links = _annotation_links(writer.root_object)
    except ValueError:
        unresolved.append({"code": "annotation_structure_unverified"})
        return
    for index, page, annotations in pages:
        if not isinstance(annotations, ArrayObject):
            raise ValueError("invalid_annotations")
        if not annotations:
            continue
        valid = True
        for reference in annotations:
            annotation = resolved(reference)
            if not isinstance(annotation, DictionaryObject):
                valid = False
                break
            key = annotation.get("/StructParent")
            matches = links.get(id(annotation), [])
            if (not isinstance(key, NumberObject) or len(matches) != 1
                    or not _same(parents.get(int(key)), matches[0][0])
                    or not _same(page, matches[0][1])
                    or (annotation.get("/P") is not None and not _same(annotation.get("/P"), page))):
                valid = False
                break
        if valid and page.get("/Tabs") != "/S":
            page[NameObject("/Tabs")] = NameObject("/S")
            changes.append({"code": "annotation_tab_order_follows_verified_structure", "page": index + 1})
        elif not valid:
            unresolved.append({"code": "annotation_structure_unverified", "page": index + 1})


def _zapf_unicode(writer: PdfWriter, changes: list) -> None:
    # Pinned pypdf carries Adobe's canonical standard-font encoding. Restrict to
    # the exact, unmodified standard ZapfDingbats font; custom encodings/subsets
    # need actual glyph evidence. Identity fallbacks represent undefined codes.
    from pypdf._codecs.zapfding import _zapfding_encoding
    pairs = [(i, char) for i, char in enumerate(_zapfding_encoding)
             if i == 32 or char != chr(i)]
    lines = ["/CIDInit /ProcSet findresource begin", "12 dict begin", "begincmap",
             "/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def",
             "/CMapName /StandardZapfDingbatsToUnicode def", "/CMapType 2 def",
             "1 begincodespacerange", "<00> <FF>", "endcodespacerange"]
    for offset in range(0, len(pairs), 100):
        batch = pairs[offset:offset + 100]
        lines.append(f"{len(batch)} beginbfchar")
        lines.extend(f"<{code:02X}> <{char.encode('utf-16-be').hex().upper()}>" for code, char in batch)
        lines.append("endbfchar")
    lines.extend(["endcmap", "CMapName currentdict /CMap defineresource pop", "end", "end"])
    for font, path in list(_objects(writer.root_object)):
        if (font.get("/Type") == "/Font" and font.get("/Subtype") == "/Type1"
                and font.get("/BaseFont") == "/ZapfDingbats" and font.get("/Encoding") is None
                and font.get("/ToUnicode") is None and font.get("/FontDescriptor") is None):
            stream = DecodedStreamObject()
            stream.set_data(("\n".join(lines) + "\n").encode("ascii"))
            font[NameObject("/ToUnicode")] = writer._add_object(stream)
            changes.append({"code": "standard_zapfdingbats_unicode_map", "location": path})


def repair_conformance_details(source: Path, output: Path) -> dict:
    reader, writer = _open(source, output)
    changes, unresolved = [], []
    title = str((reader.metadata or {}).get("/Title", "")).strip()
    data, tree = _xmp(writer.root_object)
    existing_titles = list(tree.iter(f"{{{DC}}}title"))
    if existing_titles and not any("".join(item.itertext()).strip() for item in existing_titles):
        unresolved.append({"code": "empty_xmp_title_requires_review"})
    if not title:
        for item in existing_titles:
            title = "".join(item.itertext()).strip()
            if title:
                break
    if title:
        if len(title) > 2000:
            raise ValueError("title_limit")
        preferences = resolved(writer.root_object.get("/ViewerPreferences"))
        if preferences is None:
            preferences = DictionaryObject()
        if not isinstance(preferences, DictionaryObject):
            raise ValueError("invalid_viewer_preferences")
        existing = preferences.get("/DisplayDocTitle")
        if not isinstance(existing, BooleanObject) or existing.value is not True:
            preferences[NameObject("/DisplayDocTitle")] = BooleanObject(True)
            writer.root_object[NameObject("/ViewerPreferences")] = preferences
            changes.append({"code": "display_existing_document_title"})
        if not existing_titles:
            addition = (f'<rdf:Description xmlns:rdf="{RDF}" xmlns:dc="{DC}" rdf:about="">'
                        '<dc:title><rdf:Alt><rdf:li xml:lang="x-default">' + escape(title)
                        + '</rdf:li></rdf:Alt></dc:title></rdf:Description>')
            _append_xmp(writer, data, addition)
            changes.append({"code": "add_xmp_title_from_existing_title"})
    else:
        unresolved.append({"code": "authored_title_required"})
    _repair_tabs(writer, changes, unresolved)
    _zapf_unicode(writer, changes)
    inventory = font_resources(writer.root_object)
    digest = _save(writer, output)
    return {"experimental": True, "conformance_declaration_added": False, "certification": False,
            "requires_revalidation": True, "output_sha256": digest, "changes": changes,
            "unresolved": unresolved, "font_embedding_repair": "not_performed",
            "font_resources": inventory}


def stage_pdfua1_declaration(source: Path, output: Path, *, expected_sha256: str,
                             evaluation_only: bool = False) -> dict:
    """Root's assessment gate alone may call this to stage a new evaluation PDF.

    The hash binds the caller's evidence to the input. The returned output is a
    new candidate: rerun veraPDF ua1, independent preservation and a complete
    semantic audit on its new hash before making any conformance claim.
    """
    if evaluation_only is not True or not re.fullmatch(r"[0-9a-f]{64}", expected_sha256):
        raise ValueError("explicit_staged_evaluation_required")
    reader, writer = _open(source, output)
    if hashlib.sha256(reader.stream.getvalue()).hexdigest() != expected_sha256:
        raise ValueError("candidate_hash_mismatch")
    data, tree = _xmp(writer.root_object)
    parts = list(tree.iter(f"{{{UA}}}part"))
    attributes = [node.attrib[f"{{{UA}}}part"] for node in tree.iter() if f"{{{UA}}}part" in node.attrib]
    if parts or attributes:
        raise ValueError("existing_pdfua_declaration_requires_review")
    _append_xmp(writer, data, f'<rdf:Description xmlns:rdf="{RDF}" xmlns:pdfuaid="{UA}" rdf:about=""><pdfuaid:part>1</pdfuaid:part></rdf:Description>')
    digest = _save(writer, output)
    return {"experimental": True, "evaluation_only": True, "certification": False,
            "requires_revalidation": True, "output_sha256": digest, "input_sha256": expected_sha256,
            "target_standard": "ISO 14289-1:2014"}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    print(json.dumps(repair_conformance_details(args.source, args.output), indent=2))
