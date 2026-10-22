"""Independent preservation gate for the static hybrid-form preparation step.

Repair discovery and its ledger are not evidence. This module reads the original
again, derives each permitted label from the original XFA template, and compares
the reopened files after undoing verified names, speech metadata and UR3 removal.
Only exact parser-bounded speak text/disable changes are accepted within XFA.
Scripts, values, widget ownership and all other objects must remain identical.
It does not validate a digital signature or certify PDF/UA.
"""
from __future__ import annotations

import io
import math
from pathlib import Path
import re
import sys
import xml.etree.ElementTree as ET
from xml.parsers import expat
from xml.sax.saxutils import escape

from pypdf import PdfReader
from pypdf.generic import (ArrayObject, BooleanObject, ByteStringObject, DictionaryObject,
                          NameObject, StreamObject, TextStringObject)

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "research" / "native-pdf"))
import verify_pdf as v

MAX_BYTES = 4 * 1024 * 1024
MAX_FIELDS = 500
MAX_XML = 2 * 1024 * 1024
MAX_NODES = 100_000


class HybridVerificationError(ValueError):
    """An exact, bounded comparison did not establish preservation."""


def require(condition, code):
    if not condition:
        raise HybridVerificationError(code)


def opened(data):
    require(isinstance(data, bytes) and 0 < len(data) <= MAX_BYTES, "hybrid_verification_size")
    reader = PdfReader(io.BytesIO(data), strict=True)
    require(not reader.is_encrypted and 1 <= len(reader.pages) <= 60, "hybrid_verification_pdf")
    return reader


class ExactGraph(v.Canonicalizer):
    """Keep all labels, ownership and stream bytes, unlike general tag checks."""

    def __init__(self, pages):
        super().__init__(pages)
        self.proxies = {}

    def value(self, item, active=None, depth=0):
        raw = v.resolved(item)
        if self.owned_reference(item) in self.page_refs or id(raw) in self.pages:
            return super().value(item, active, depth)
        if isinstance(raw, dict):
            if id(raw) not in self.proxies:
                pairs = []
                self.proxies[id(raw)] = pairs
                ignored = {"/Length", "/Filter", "/DecodeParms"} if isinstance(raw, StreamObject) else set()
                pairs.extend((str(key), value) for key, value in sorted(raw.items()) if key not in ignored)
                if isinstance(raw, StreamObject):
                    data = raw.get_data()
                    self.stream_bytes += len(data)
                    require(len(data) <= v.MAX_STREAM_BYTES and self.stream_bytes <= v.MAX_TOTAL_STREAM_BYTES,
                            "hybrid_verification_stream_limit")
                    pairs.append(("decoded_stream_sha256", v.digest(data)))
            return super().value(self.proxies[id(raw)], active, depth)
        return super().value(item, active, depth)


def exact_document(reader):
    # Root page references are normalized by page identity; include every actual
    # page dictionary as a separate root to compare its contents and annotations.
    roots = [reader.root_object, *[dict(page) for page in reader.pages], reader.trailer.get("/Info")]
    return [ExactGraph(list(reader.pages)).hash(root) for root in roots]


def native_fields(reader):
    """Derive field ownership without get_fields(), repair helpers or a ledger."""
    pages, owned, visited, result = {}, set(), set(), {}
    for page_number, page in enumerate(reader.pages, 1):
        annotations = v.resolved(page.get("/Annots", ArrayObject()))
        require(isinstance(annotations, list), "hybrid_verification_annotations")
        for ordinal, reference in enumerate(annotations, 1):
            node = v.resolved(reference)
            require(isinstance(node, dict), "hybrid_verification_annotation")
            if node.get("/Subtype") != "/Widget":
                continue
            require(id(node) not in pages and len(pages) < MAX_FIELDS, "hybrid_verification_widget_reused")
            require("/P" not in node or v.Canonicalizer.owned_reference(node["/P"]) == v.Canonicalizer.owned_reference(page),
                    "hybrid_verification_widget_page")
            pages[id(node)] = (page_number, ordinal)

    def walk(reference, parent, path, inherited, depth):
        node = v.resolved(reference)
        require(isinstance(node, dict) and id(node) not in visited and depth <= 32
                and len(visited) < 2000, "hybrid_verification_field_tree")
        visited.add(id(node))
        require(("/Parent" not in node if parent is None else v.resolved(node.get("/Parent")) is parent),
                "hybrid_verification_field_parent")
        name = node.get("/T")
        require(isinstance(name, TextStringObject) and 0 < len(name) <= 200 and "." not in name,
                "hybrid_verification_field_name")
        path = (*path, str(name))
        state = {**inherited, **{key: v.resolved(node[key]) for key in ("/FT", "/Ff") if key in node}}
        kids = v.resolved(node.get("/Kids", ArrayObject()))
        require(isinstance(kids, list), "hybrid_verification_field_children")
        if node.get("/Subtype") == "/Widget":
            require(not kids, "hybrid_verification_merged_children")
            widgets = [node]
        elif kids and all(isinstance(v.resolved(k), dict) and "/T" not in v.resolved(k)
                          and v.resolved(k).get("/Subtype") == "/Widget" for k in kids):
            widgets = [v.resolved(k) for k in kids]
            for widget in widgets:
                require(v.resolved(widget.get("/Parent")) is node and "/Kids" not in widget
                        and not any(key in widget for key in ("/FT", "/Ff", "/V", "/DV", "/TU")),
                        "hybrid_verification_widget_override")
        else:
            require(kids and all(isinstance(v.resolved(k), dict) and "/T" in v.resolved(k) for k in kids),
                    "hybrid_verification_terminal_missing")
            for child in kids:
                walk(child, node, path, state, depth + 1)
            return
        require(path not in result and state.get("/FT") in ("/Tx", "/Btn"),
                "hybrid_verification_field_type_or_duplicate")
        flags = state.get("/Ff", 0)
        require(isinstance(flags, int) and not isinstance(flags, (bool, BooleanObject))
                and 0 <= flags <= 0xffffffff and (state["/FT"] != "/Btn" or not flags & ((1 << 15) | (1 << 16))),
                "hybrid_verification_field_flags")
        keys = []
        for widget in widgets:
            require(id(widget) in pages and id(widget) not in owned, "hybrid_verification_widget_owner")
            owned.add(id(widget))
            keys.append(pages[id(widget)])
        result[path] = {"node": node, "widgets": tuple(keys), "type": str(state["/FT"])}

    form = v.resolved(reader.root_object.get("/AcroForm"))
    require(isinstance(form, dict), "hybrid_verification_form_missing")
    roots = v.resolved(form.get("/Fields"))
    require(isinstance(roots, list) and roots, "hybrid_verification_form_roots")
    for reference in roots:
        walk(reference, None, (), {}, 0)
    require(owned == set(pages) and 0 < len(result) <= MAX_FIELDS, "hybrid_verification_orphan_widget")
    return result


def original_labels(reader):
    form = v.resolved(reader.root_object["/AcroForm"])
    xfa = v.resolved(form.get("/XFA"))
    require(isinstance(xfa, list) and 2 <= len(xfa) <= 40 and len(xfa) % 2 == 0,
            "hybrid_verification_xfa_packets")
    packets = {}
    total = 0
    for index in range(0, len(xfa), 2):
        name, stream = xfa[index], v.resolved(xfa[index + 1])
        require(isinstance(name, TextStringObject) and str(name) not in packets
                and isinstance(stream, StreamObject), "hybrid_verification_xfa_packet")
        data = stream.get_data()
        total += len(data)
        require(total <= MAX_XML, "hybrid_verification_xfa_limit")
        packets[str(name)] = data
    require("template" in packets, "hybrid_verification_template_missing")
    data = packets["template"]
    # Decode before checking declarations: an ASCII byte search misses UTF-16
    # declarations. Only the bounded UTF-8 template subset is supported here.
    text = data.decode("utf-8-sig", errors="strict")
    require("\x00" not in text and not re.search(r"<!\s*(?:DOCTYPE|ENTITY)\b", text, re.I),
            "hybrid_verification_xml_declaration")
    encoding = re.match(r"\s*<\?xml\s+[^?]*\bencoding\s*=\s*(['\"])([^'\"]+)\1", text, re.I)
    require(encoding is None or encoding.group(2).casefold() in {"utf-8", "utf8", "us-ascii", "ascii"},
            "hybrid_verification_xml_encoding")
    root = ET.fromstring(text)
    require(root.tag.startswith("{http://www.xfa.org/schema/xfa-template/")
            and root.tag.endswith("}template"), "hybrid_verification_template_namespace")
    namespace = root.tag.rsplit("}", 1)[0] + "}"
    evidence_elements = {"subform", "field", "draw", "assist", "speak", "ui", "textEdit", "checkButton", "comb",
                         "traversal", "traverse", "bind", "event", "script"}
    labels, seen = {}, 0

    def local(element):
        return element.tag.rsplit("}", 1)[-1]

    def walk(element, path, depth, parent=None, foreign_ancestor=False):
        nonlocal seen
        seen += 1
        require(seen <= MAX_NODES and depth <= 64, "hybrid_verification_xml_complexity")
        require(local(element) not in evidence_elements or (not foreign_ancestor and element.tag == namespace + local(element)),
                "hybrid_verification_evidence_namespace")
        if local(element) in {"field", "subform"}:
            require(parent is not None and parent.tag in {namespace + "template", namespace + "subform"},
                    "hybrid_verification_field_position")
        if local(element) == "field":
            require(path and path not in labels, "hybrid_verification_xfa_field_duplicate")
            assist = [c for c in element if local(c) == "assist"]
            require(len(assist) <= 1, "hybrid_verification_ambiguous_assist")
            speak = [c for a in assist for c in a if local(c) == "speak"]
            require(len(speak) <= 1, "hybrid_verification_ambiguous_label")
            label = None
            if speak:
                source = speak[0]
                require(not list(source) and not any(k in source.attrib for k in ("use", "usehref")),
                        "hybrid_verification_label_reference")
                label = source.text or ""
                require(len(label) <= 2000 and all(ord(c) >= 32 or c in "\r\n\t" for c in label),
                        "hybrid_verification_label_length")
                if not label.strip():
                    label = None
            labels[path] = label
        counters = {}
        for child in element:
            child_path = path
            tag = local(child)
            name = child.attrib.get("name")
            if tag in {"subform", "field", "exclGroup"} and name:
                require(len(name) <= 200 and "." not in name and "[" not in name and "]" not in name,
                        "hybrid_verification_xfa_name")
                key = (tag, name)
                occurrence = counters.get(key, 0)
                counters[key] = occurrence + 1
                child_path = (*path, f"{name}[{occurrence}]")
            walk(child, child_path, depth + 1, element, foreign_ancestor or element.tag != namespace + local(element))

    walk(root, (), 0)
    require(0 < len(labels) <= MAX_FIELDS, "hybrid_verification_xfa_field_count")
    return labels


def accessibility_expectations(reader, fields, labels):
    """Independently derive allowable names and exact XML metadata deltas.

    This does not import the repair implementation or accept a change ledger.
    After verifying exact expected packet bytes, the caller restores the source
    bytes in a fresh candidate reader for the whole-object-graph comparison.
    """
    xfa = reader.root_object["/AcroForm"]["/XFA"]
    source = next(v.resolved(xfa[i + 1]).get_data() for i in range(0, len(xfa), 2) if str(xfa[i]) == "template")
    root = ET.fromstring(source.decode("utf-8-sig"))
    elements, parents = {}, {}

    def local(node):
        return node.tag.rsplit("}", 1)[-1]

    def visit(node, path):
        if local(node) == "field":
            elements[path] = node
        counts = {}
        for child in node:
            parents[id(child)] = node
            child_path = path
            key = (local(child), child.get("name"))
            if key[0] in {"field", "subform"} and key[1]:
                number = counts.get(key, 0)
                counts[key] = number + 1
                child_path += (f"{key[1]}[{number}]",)
            visit(child, child_path)
    visit(root, ())
    require(set(elements) == set(fields) == set(labels), "hybrid_verification_metadata_coverage")
    supported, speech = {}, {}
    for path, element in elements.items():
        nodes = [s for a in element if local(a) == "assist" for s in a if local(s) == "speak"]
        node = nodes[0] if len(nodes) == 1 else None
        supported[path] = bool(node is not None and labels[path] is not None
            and set(node.attrib) <= {"disable", "priority"}
            and node.get("disable", "0") in {"0", "1"} and node.get("priority", "custom") == "custom"
            and ("/TU" not in fields[path]["node"] or fields[path]["node"].get("/TU") == labels[path]))
        speech[path] = node

    # Independent lexical positions. Expat resolves character references for
    # name matching; the accepted output must retain the original raw bytes.
    spans, stack = {}, []
    parser = expat.ParserCreate(namespace_separator="}")

    def start(name, attributes):
        kind = name.rsplit("}", 1)[-1]
        path = stack[-1]["path"] if stack else ()
        if kind in {"field", "subform"} and attributes.get("name"):
            key = (kind, attributes["name"])
            index = stack[-1]["counts"].get(key, 0) if stack else 0
            if stack:
                stack[-1]["counts"][key] = index + 1
            path += (f"{key[1]}[{index}]",)
        stack.append({"kind": kind, "path": path, "counts": {}, "start": parser.CurrentByteIndex,
                      "direct": kind == "speak" and len(stack) >= 2 and stack[-1]["kind"] == "assist" and stack[-2]["kind"] == "field"})

    def end(name):
        item = stack.pop()
        if not item["direct"]:
            return
        opening = re.match(rb'<[A-Za-z_][A-Za-z0-9_.:-]*\b[^<>]*>', source[item["start"]:])
        closing = re.match(rb'</[A-Za-z_][A-Za-z0-9_.:-]*\s*>', source[parser.CurrentByteIndex:])
        if opening and closing:
            left, right = item["start"] + opening.end(), parser.CurrentByteIndex
            if b"<" not in source[left:right]:
                spans[item["path"]] = (item["start"], left, right)
    parser.StartElementHandler, parser.EndElementHandler = start, end
    parser.StartDoctypeDeclHandler = lambda *args: require(False, "hybrid_verification_xml_declaration")
    parser.Parse(source, True)

    def cell_count(path, count):
        node = elements[path]
        found = [c for u in node if local(u) == "ui" for e in u if local(e) == "textEdit" for c in e if local(c) == "comb"]
        return (supported[path] and fields[path]["type"] == "/Tx"
            and fields[path]["node"].get("/MaxLen") == count and len(found) == 1
            and found[0].get("numberOfCells") == str(count))

    def next_path(path):
        node = elements[path]
        parent = parents[id(node)]
        names, counts = {}, {}
        for child in parent:
            name = child.get("name")
            if name:
                occurrence = counts.get(name, 0)
                counts[name] = occurrence + 1
                names[f"{name}[{occurrence}]"] = child
        if any(count > 1 for count in counts.values()):
            return None
        visited = set()
        for _ in range(5):
            if id(node) in visited:
                return None
            visited.add(id(node))
            traversal = [t for t in node if local(t) == "traversal"]
            if len(traversal) != 1 or len(traversal[0]) != 1:
                return None
            edge = traversal[0][0]
            if local(edge) != "traverse" or set(edge.attrib) - {"ref", "operation"} or edge.get("operation", "next") != "next":
                return None
            node = names.get(edge.get("ref"))
            if node is None:
                return None
            if local(node) == "field":
                return next((key for key, value in elements.items() if value is node), None)
            if local(node) != "draw":
                return None
        return None

    def same_row(a, b):
        left, right = fields[a], fields[b]
        try:
            ar, br = list(map(float, left["node"]["/Rect"])), list(map(float, right["node"]["/Rect"]))
            return (len(ar) == len(br) == 4 and all(math.isfinite(x) for x in ar + br)
                and len(left["widgets"]) == len(right["widgets"]) == 1
                and left["widgets"][0][0] == right["widgets"][0][0]
                and abs(ar[1] - br[1]) <= .01 and abs(ar[3] - br[3]) <= .01
                and ar[2] > ar[0] and br[2] > br[0] and 0 <= br[0] - ar[2] <= 36)
        except (ValueError, TypeError, KeyError):
            return False

    names = {}
    for path, label in labels.items():
        match = re.search(r"(?:^|[.!?]\s+)([^.!?\r\n]{1,120})\.\s*First ([1-9][0-9]?) digits\.\s*\Z", label or "")
        if not match or not cell_count(path, int(match.group(2))):
            continue
        prefix, current, proposals, visited = match.group(1).strip() + ". ", path, [], {path}
        for step in range(2):
            following = next_path(current)
            if following is None or following in visited:
                break
            visited.add(following)
            segment = re.fullmatch(r"(Middle|Last) ([1-9][0-9]?) digits\.\s*", labels[following] or "")
            if (segment is None or not cell_count(following, int(segment.group(2)))
                    or not same_row(current, following) or (step == 1 and segment.group(1) != "Last")):
                break
            proposals.append((following, prefix + labels[following]))
            if segment.group(1) == "Last":
                for key, text in proposals:
                    require(key not in names or names[key] == text, "hybrid_verification_ambiguous_segment")
                    names[key] = text
                break
            current = following

    edits, enabled, actual_names = [], [], {}
    for path, span in spans.items():
        if not supported.get(path):
            continue
        start, middle, end = span
        if speech[path].get("disable", "0") == "1":
            opening = source[start:middle]
            # Parse complete attribute pairs. Namespace declarations are not
            # in ET.attrib, and their quoted values may contain fake tokens.
            header = re.match(rb'<[A-Za-z_][A-Za-z0-9_.:-]*', opening)
            position, token = header.end(), None
            while position < len(opening):
                pair = re.match(rb'\s+([A-Za-z_][A-Za-z0-9_.:-]*)\s*=\s*("[^"]*"|\'[^\']*\')', opening[position:], re.S)
                if pair is None:
                    break
                if pair.group(1) == b"disable" and pair.group(2)[1:-1] == b"1":
                    token = (position + pair.start(2) + 1, position + pair.end(2) - 1)
                position += pair.end()
            if token is None or opening[position:].strip() != b">":
                continue
            value = opening[:token[0]] + b"0" + opening[token[1]:]
            edits.append((start, middle, value))
            enabled.append(".".join(path))
        if path in names:
            prefix = names[path][:-len(labels[path])]
            edits.append((middle, end, escape(prefix).encode() + source[middle:end]))
            actual_names[path] = names[path]
    expected = source
    for left, right, value in sorted(edits, reverse=True):
        expected = expected[:left] + value + expected[right:]
    return source, expected, actual_names, enabled


def removable_rights(reader):
    permissions = v.resolved(reader.root_object.get("/Perms"))
    if permissions is None:
        return False
    require(isinstance(permissions, dict) and set(permissions) == {"/UR3"},
            "hybrid_verification_signature_permissions")
    signature = v.resolved(permissions["/UR3"])
    require(isinstance(signature, dict) and signature.get("/Type") == "/Sig"
            and signature.get("/Filter") == "/Adobe.PPKLite"
            and signature.get("/SubFilter") == "/adbe.pkcs7.detached"
            and set(signature) <= {"/Type", "/Filter", "/SubFilter", "/Reference", "/Name", "/M",
                                   "/Contents", "/ByteRange", "/Prop_Build"},
            "hybrid_verification_signature_kind")
    contents, byte_range = signature.get("/Contents"), v.resolved(signature.get("/ByteRange"))
    require(isinstance(contents, ByteStringObject) and 0 < len(contents) <= 131_072
            and isinstance(byte_range, list) and len(byte_range) == 4
            and all(isinstance(n, int) and not isinstance(n, bool) and n >= 0 for n in byte_range)
            and byte_range[0] == 0 and 0 < byte_range[1] < byte_range[2],
            "hybrid_verification_signature_bytes")
    references = v.resolved(signature.get("/Reference"))
    require(isinstance(references, list) and len(references) == 1,
            "hybrid_verification_signature_references")
    reference = v.resolved(references[0])
    require(isinstance(reference, dict) and reference.get("/Type") == "/SigRef"
            and reference.get("/TransformMethod") == "/UR3"
            and set(reference) <= {"/Type", "/TransformMethod", "/TransformParams", "/Data"}
            and v.resolved(reference.get("/Data")) is reader.root_object,
            "hybrid_verification_signature_transform")
    parameters = v.resolved(reference.get("/TransformParams"))
    require(isinstance(parameters, dict) and parameters.get("/Type") == "/TransformParams"
            and parameters.get("/V") == "/2.2"
            and set(parameters) <= {"/Type", "/V", "/Msg", "/Document", "/Annots", "/Form", "/Signature", "/P", "/EF"},
            "hybrid_verification_signature_parameters")
    allowed_rights = {"/Document": {"/FullSave"},
        "/Annots": {"/Create", "/Delete", "/Modify", "/Copy", "/Import", "/Export", "/Online"},
        "/Form": {"/FillIn", "/Import", "/Export", "/SubmitStandalone", "/Online", "/Add", "/Delete"},
        "/Signature": {"/Modify"}, "/EF": {"/Create", "/Delete", "/Import", "/Modify"}}
    for key, values in allowed_rights.items():
        if key in parameters:
            rights = v.resolved(parameters[key])
            require(isinstance(rights, list) and len(rights) <= len(values)
                    and all(isinstance(value, NameObject) and value in values for value in rights),
                    "hybrid_verification_signature_rights")
    require("/P" not in parameters or isinstance(v.resolved(parameters["/P"]), BooleanObject),
            "hybrid_verification_signature_parameter_type")
    for node, key in ((parameters, "/Msg"), (signature, "/Name"), (signature, "/M")):
        require(key not in node or isinstance(node[key], TextStringObject) and len(node[key]) <= 2000,
                "hybrid_verification_signature_text")
    if "/Prop_Build" in signature:
        build = v.resolved(signature["/Prop_Build"])
        require(isinstance(build, dict) and set(build) <= {"/Filter", "/App", "/PubSec"},
                "hybrid_verification_signature_build")
        for value in build.values():
            value = v.resolved(value)
            require(isinstance(value, dict) and set(value) <= {"/Name", "/Date", "/R", "/V", "/PreRelease", "/OS",
                        "/NonEFontNoWarn", "/TrustedMode"}
                    and all(not isinstance(v.resolved(item), (dict, list)) for item in value.values()),
                    "hybrid_verification_signature_build")
    pending, seen = [reader.root_object], set()
    while pending:
        value = v.resolved(pending.pop())
        if not isinstance(value, (dict, list)) or id(value) in seen:
            continue
        require(len(seen) < MAX_NODES, "hybrid_verification_graph_limit")
        seen.add(id(value))
        if isinstance(value, dict):
            require(value.get("/FT") != "/Sig" and (value.get("/Type") != "/Sig" or value is signature),
                    "hybrid_verification_personal_signature")
            pending.extend(value.values())
        else:
            pending.extend(value)
    return True


def form_pixels(data):
    """Render native widget appearances as well as page content, without JS."""
    import pypdfium2 as pdfium
    # A future XFA/V8 runtime must not silently execute preserved source code.
    require("XFA" not in pdfium.PDFIUM_INFO.flags and "V8" not in pdfium.PDFIUM_INFO.flags,
            "hybrid_verification_script_runtime")
    hashes = []
    with pdfium.PdfDocument(data) as document:
        document.init_forms()
        for index in range(len(document)):
            page = document[index]
            try:
                width, height = page.get_size()
                require(math.isfinite(width + height) and width > 0 and height > 0
                        and math.ceil(width * v.RENDER_SCALE) * math.ceil(height * v.RENDER_SCALE) <= v.MAX_PAGE_PIXELS,
                        "hybrid_verification_render_limit")
                bitmap = page.render(scale=v.RENDER_SCALE, draw_annots=True, may_draw_forms=True)
                try:
                    image = bitmap.to_pil().convert("RGB")
                    hashes.append({"pageNumber": index + 1, "width": image.width, "height": image.height,
                                   "sha256": v.digest(image.tobytes())})
                finally:
                    bitmap.close()
            finally:
                page.close()
    return hashes


def verify_hybrid_preparation(source_bytes, candidate_bytes):
    """Return evidence only after all permitted changes are rederived and exact.

    The worker may use candidate_bytes as its preservation baseline only after
    this succeeds. No caller-supplied ledger or field labels are accepted.
    """
    try:
        before, after = opened(source_bytes), opened(candidate_bytes)
        require(len(before.pages) == len(after.pages), "hybrid_verification_page_count")
        old, new = native_fields(before), native_fields(after)
        labels = original_labels(before)
        require(set(old) == set(new) == set(labels), "hybrid_verification_field_coverage")
        original_template, expected_template, qualified, enabled = accessibility_expectations(before, old, labels)
        after_xfa = after.root_object["/AcroForm"]["/XFA"]
        require(isinstance(after_xfa, list) and len(after_xfa) % 2 == 0, "hybrid_verification_xfa_packets")
        candidates = [v.resolved(after_xfa[i + 1]) for i in range(0, len(after_xfa), 2) if str(after_xfa[i]) == "template"]
        require(len(candidates) == 1 and isinstance(candidates[0], StreamObject)
                and candidates[0].get_data() == expected_template, "hybrid_verification_xfa_metadata")
        # Restore only the proven packet bytes for the exact graph comparison.
        candidates[0].set_data(original_template)
        changes, name_changes = [], []
        for path, record in old.items():
            candidate = new[path]
            require(record["widgets"] == candidate["widgets"] and record["type"] == candidate["type"],
                    "hybrid_verification_widget_mapping")
            left, right = record["node"], candidate["node"]
            if path in qualified or ("/TU" not in left and labels[path] is not None):
                expected_label = qualified.get(path, labels[path])
                require(isinstance(right.get("/TU"), TextStringObject) and str(right["/TU"]) == expected_label,
                        "hybrid_verification_authored_label")
                if path in qualified:
                    name_changes.append({"fieldName": ".".join(path), "oldText": labels[path], "newText": expected_label})
                if "/TU" not in left:
                    changes.append(".".join(path))
                    right.pop(NameObject("/TU"))
                else:
                    right[NameObject("/TU")] = left["/TU"]
        removed = removable_rights(before)
        require("/Perms" not in after.root_object, "hybrid_verification_rights_retained")
        if removed:
            before.root_object.pop(NameObject("/Perms"))
        require(exact_document(before) == exact_document(after), "hybrid_verification_unexpected_change")
        original_pixels, candidate_pixels = form_pixels(source_bytes), form_pixels(candidate_bytes)
        require(original_pixels == candidate_pixels, "hybrid_verification_page_pixels")
        return {"passed": True, "sourceSha256": v.digest(source_bytes), "candidateSha256": v.digest(candidate_bytes),
                "fieldCount": len(old), "widgetCount": sum(len(f["widgets"]) for f in old.values()),
                "addedTooltipFields": changes, "removedReaderUsageRights": removed,
                "accessibleNameChanges": name_changes, "speechPromptsEnabled": enabled,
                "xfaPacketsScriptsBindingsAndDataUnchanged": original_template == expected_template,
                "xfaScriptsBindingsAndDataUnchanged": True, "verifiedAccessibilityMetadataOnly": True,
                "otherReachableObjectsUnchanged": True, "originalPagesAndWidgetsRenderIdentically": True,
                "renderedPages": candidate_pixels,
                "renderingScope": "Static pages and native AcroForm widgets; XFA execution is not exercised.",
                "certification": False}
    except HybridVerificationError:
        raise
    except Exception as error:
        raise HybridVerificationError("hybrid_verification_incomplete") from error
