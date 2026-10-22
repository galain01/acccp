"""Independent preservation gate for the static hybrid-form preparation step.

Repair discovery and its ledger are not evidence. This module reads the original
again, derives each permitted label from the original XFA template, and compares
the reopened files after undoing only verified /TU additions and UR3 removal.
XFA packet bytes, scripts, values, widget ownership and all other native objects
must remain identical. It does not validate a digital signature or certify PDF/UA.
"""
from __future__ import annotations

import io
import math
from pathlib import Path
import re
import sys
import xml.etree.ElementTree as ET

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
    labels, seen = {}, 0

    def local(element):
        return element.tag.rsplit("}", 1)[-1]

    def walk(element, path, depth):
        nonlocal seen
        seen += 1
        require(seen <= MAX_NODES and depth <= 64, "hybrid_verification_xml_complexity")
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
            walk(child, child_path, depth + 1)

    walk(root, (), 0)
    require(0 < len(labels) <= MAX_FIELDS, "hybrid_verification_xfa_field_count")
    return labels


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
        changes = []
        for path, record in old.items():
            candidate = new[path]
            require(record["widgets"] == candidate["widgets"] and record["type"] == candidate["type"],
                    "hybrid_verification_widget_mapping")
            left, right = record["node"], candidate["node"]
            if "/TU" not in left and labels[path] is not None:
                require(isinstance(right.get("/TU"), TextStringObject) and str(right["/TU"]) == labels[path],
                        "hybrid_verification_authored_label")
                changes.append(".".join(path))
                right.pop(NameObject("/TU"))
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
                "xfaPacketsScriptsBindingsAndDataUnchanged": True,
                "otherReachableObjectsUnchanged": True, "originalPagesAndWidgetsRenderIdentically": True,
                "renderedPages": candidate_pixels,
                "renderingScope": "Static pages and native AcroForm widgets; XFA execution is not exercised.",
                "certification": False}
    except HybridVerificationError:
        raise
    except Exception as error:
        raise HybridVerificationError("hybrid_verification_incomplete") from error
