"""Bounded metadata-only repairs for already admitted static hybrid forms.

No generated labels, field-name exceptions, validation or script changes.
Descriptions are copied from a verified neighboring segment's authored name.
The XML packet is patched at exact parser-reported spans, never serialized.
"""
from __future__ import annotations

import math
import re
import xml.etree.ElementTree as ET
from xml.parsers import expat
from xml.sax.saxutils import escape

from pypdf.generic import ArrayObject, NameObject, TextStringObject

from hybrid_forms import HybridFormError, _local, _resolve, _root, _require, _xml_packets

FIRST = re.compile(r"(?:^|[.!?]\s+)([^.!?\r\n]{1,120})\.\s*First ([1-9][0-9]?) digits\.\s*\Z")
REST = re.compile(r"(Middle|Last) ([1-9][0-9]?) digits\.\s*\Z")


def template_stream(pdf):
    packets = _resolve(_root(pdf)["/AcroForm"]["/XFA"])
    return next(_resolve(packets[i + 1]) for i in range(0, len(packets), 2) if str(packets[i]) == "template")


def field_elements(template):
    result = {}

    def walk(node, path, parent):
        if _local(node) == "field":
            result[".".join(path)] = (node, parent)
        counters = {}
        for child in node:
            child_path = path
            kind, name = _local(child), child.get("name")
            if kind in {"subform", "field"} and name:
                key = (kind, name)
                index = counters.get(key, 0)
                counters[key] = index + 1
                child_path = (*path, f"{name}[{index}]")
            walk(child, child_path, node)
    walk(template, (), None)
    return result


def next_field(node, parent):
    """Follow explicit next traversal through at most four sibling draw nodes."""
    siblings = {}
    counts = {}
    for child in parent:
        name = child.get("name")
        if name:
            index = counts.get(name, 0)
            counts[name] = index + 1
            siblings[f"{name}[{index}]"] = child
    if any(count > 1 for count in counts.values()):
        return None
    visited = set()
    for _ in range(5):
        if id(node) in visited:
            return None
        visited.add(id(node))
        traversals = [n for n in node if _local(n) == "traversal"]
        if len(traversals) != 1 or len(traversals[0]) != 1:
            return None
        traverse = traversals[0][0]
        if _local(traverse) != "traverse" or set(traverse.attrib) - {"ref", "operation"} or traverse.get("operation", "next") != "next":
            return None
        target = siblings.get(traverse.get("ref"))
        if target is None:
            return None
        if _local(target) == "field":
            return target
        if _local(target) != "draw":
            return None
        node = target
    return None


def segment_labels(pdf, context, template):
    """Return only complete First/[Middle]/Last comb groups with source proof."""
    elements = field_elements(template)
    by_element = {id(elements[f.field_name][0]): f for f in context.fields}
    pages = {}
    for page_number, page in enumerate(pdf.pages):
        for reference in _resolve(page.get("/Annots", ArrayObject())):
            pages[id(_resolve(reference))] = page_number

    def comb(field, node, count):
        controls = [c for u in node if _local(u) == "ui" for c in u if _local(c) == "textEdit"]
        cells = [c for control in controls for c in control if _local(c) == "comb"]
        return (field.speech_supported and field.native_field.get("/FT") == "/Tx"
                and field.native_field.get("/MaxLen") == count
                and len(cells) == 1 and cells[0].get("numberOfCells") == str(count))

    def aligned(left, right):
        a, b = left.native_field, right.native_field
        try:
            ar, br = [float(x) for x in a["/Rect"]], [float(x) for x in b["/Rect"]]
            return (len(ar) == len(br) == 4 and all(math.isfinite(x) for x in ar + br)
                    and pages.get(id(a)) is not None and pages[id(a)] == pages.get(id(b))
                    and abs(ar[1] - br[1]) <= .01 and abs(ar[3] - br[3]) <= .01
                    and 0 < ar[2] - ar[0] and 0 < br[2] - br[0]
                    and ar[2] <= br[0] and br[0] - ar[2] <= 36)
        except (KeyError, TypeError, ValueError):
            return False

    result = {}
    for field in context.fields:
        match = FIRST.search(field.authored_label or "")
        if not match:
            continue
        node, parent = elements[field.field_name]
        prefix = match.group(1).strip() + ". "
        if not comb(field, node, int(match.group(2))):
            continue
        proposed, seen, prior, complete = [], {id(node)}, field, False
        for step in range(2):
            node = next_field(node, parent)
            if node is None or id(node) in seen or id(node) not in by_element:
                break
            seen.add(id(node))
            current = by_element[id(node)]
            relative = REST.fullmatch(current.authored_label or "")
            if (relative is None or not aligned(prior, current)
                    or not comb(current, node, int(relative.group(2)))
                    or (step == 1 and relative.group(1) != "Last")):
                break
            proposed.append((current.field_name, prefix + current.authored_label))
            if relative.group(1) == "Last":
                complete = True
                break
            prior = current
        if complete:
            for name, label in proposed:
                if name in result and result[name] != label:
                    raise HybridFormError()
                result[name] = label
    return result


def speech_spans(data):
    """Use XML byte positions; preserve comments, namespace spellings and bytes."""
    parser = expat.ParserCreate(namespace_separator="}")
    stack, spans = [], []

    def start(name, attrs):
        kind = name.rsplit("}", 1)[-1]
        parent = stack[-1] if stack else None
        path = () if parent is None else parent["path"]
        if kind in {"subform", "field"} and attrs.get("name"):
            key = (kind, attrs["name"])
            count = 0 if parent is None else parent["counts"].get(key, 0)
            if parent is not None:
                parent["counts"][key] = count + 1
            path = (*path, f'{attrs["name"]}[{count}]')
        item = {"kind": kind, "path": path, "counts": {}, "start": parser.CurrentByteIndex,
                "attrs": attrs, "text": "", "children": 0}
        if parent:
            parent["children"] += 1
        if kind == "speak" and len(stack) >= 2 and stack[-1]["kind"] == "assist" and stack[-2]["kind"] == "field":
            item["fieldName"] = ".".join(stack[-2]["path"])
        stack.append(item)

    def end(name):
        item = stack.pop()
        if item["kind"] == "speak" and item.get("fieldName") and not item["children"]:
            start = item["start"]
            # Supported attributes cannot contain '>'; require a literal plain
            # closing tag so a CDATA/comment variant remains untouched.
            opening = re.match(rb'<[A-Za-z_][A-Za-z0-9_.:-]*\b[^<>]*>', data[start:])
            closing = re.match(rb'</[A-Za-z_][A-Za-z0-9_.:-]*\s*>', data[parser.CurrentByteIndex:])
            if opening and closing:
                item.update(contentStart=start + opening.end(), contentEnd=parser.CurrentByteIndex,
                            end=parser.CurrentByteIndex + closing.end())
                if b"<" not in data[item["contentStart"]:item["contentEnd"]]:
                    spans.append(item)

    def chars(text):
        if stack:
            stack[-1]["text"] += text

    parser.StartElementHandler, parser.EndElementHandler, parser.CharacterDataHandler = start, end, chars
    parser.StartDoctypeDeclHandler = lambda *args: _require(False)
    parser.Parse(data, True)
    return {item["fieldName"]: item for item in spans}


def literal_disable_value(opening):
    """Locate the actual attribute, never matching text inside another value."""
    name = re.match(rb'<[A-Za-z_][A-Za-z0-9_.:-]*', opening)
    if name is None:
        return None
    position, found = name.end(), None
    while position < len(opening):
        whitespace = re.match(rb'\s*', opening[position:])
        position += whitespace.end()
        if opening[position:] == b">":
            return found
        attribute = re.match(rb'([A-Za-z_][A-Za-z0-9_.:-]*)\s*=\s*([\'"])(.*?)\2', opening[position:], re.S)
        if attribute is None:
            return None
        if attribute.group(1) == b"disable" and attribute.group(3) == b"1":
            found = (position + attribute.start(3), position + attribute.end(3))
        position += attribute.end()
    return None


def prepare_accessibility(writer, context):
    template = _xml_packets(_resolve(_root(writer)["/AcroForm"]))["template"]
    stream = template_stream(writer)
    data = stream.get_data()
    qualified = segment_labels(writer, context, template)
    spans = speech_spans(data)
    patches = []
    for field in context.fields:
        span = spans.get(field.field_name)
        if not field.speech_supported or span is None or span["text"] != field.authored_label:
            continue
        opening = data[span["start"]:span["contentStart"]]
        if field.needs_speech_enable:
            token = literal_disable_value(opening)
            if token is None:
                continue
            new_opening = opening[:token[0]] + b"0" + opening[token[1]:]
            patches.append((span["start"], span["contentStart"], new_opening))
        label = qualified.get(field.field_name)
        if label is not None:
            # Prefix only: the authored relative segment text and its original
            # XML escapes stay byte-for-byte intact.
            prefix = label[:-len(field.authored_label)]
            raw = data[span["contentStart"]:span["contentEnd"]]
            patches.append((span["contentStart"], span["contentEnd"], escape(prefix).encode("utf-8") + raw))
            field.native_field[NameObject("/TU")] = TextStringObject(label)
    for start, end, replacement in sorted(patches, reverse=True):
        data = data[:start] + replacement + data[end:]
    if patches:
        stream.set_data(data)
