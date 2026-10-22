"""Conservative support for static XFA PDFs with a complete AcroForm fallback.

Nothing here evaluates JavaScript, renders XFA, or rewrites its packets. The
small set of accepted legacy programs is retained exactly. Other documents
continue through the worker's ordinary active-content and signature checks.
"""
from __future__ import annotations

from dataclasses import dataclass
import hashlib
import re
import xml.etree.ElementTree as ET

from pypdf import PdfWriter
from pypdf.generic import (ArrayObject, BooleanObject, ByteStringObject, DictionaryObject,
                          NameObject, StreamObject, TextStringObject)

MAX_XML_BYTES = 2_000_000
MAX_XML_NODES = 20_000
MAX_FIELDS = 200
MAX_GRAPH_NODES = 100_000
MAX_LABEL = 2_000

# Reviewed Adobe-generated programs, identified by program text, not input PDF
# identity. Names alone are not sufficient: altered strings/URLs also reject.
ADOBE_BOOTSTRAP = {
    "!ADBE::0100_VersChkStrings": "168e223e7aa69cf0de4a7097b3216464785e0e8953821c14ba7657dca31a23b7",
    "!ADBE::0100_VersChkVars": "6deda4f4f5e4ca2a74b161992be866434822c124b158fb41a5062935cf0550c2",
    "!ADBE::0200_VersChkCode_XFACheck": "af812ab099b4ba8477914c96eebf84df42bd8e3594d1255acec77c253d3121dd",
}

_COMMENTS = re.compile(r"(?:[ \t\r\n]|//[^\r\n\u2028\u2029]*|/\*[\s\S]*?\*/)*\Z")
_CHECKBOX_EVENT = re.compile(
    r'comment\(\);\s*var\s+fld\s*=\s*this\.getField\s*\(\s*"[A-Za-z0-9_.\[\]()]{1,200}"\s*\);\s*'
    r'if\s*\(fld\.isBoxChecked\(0\)\)\s*\{\s*fld\.checkThisBox\s*\(0,\s*true\);\s*\}\s*'
    r'else\s*\{\s*fld\.checkThisBox\s*\(0,\s*false\);\s*\}\s*MainCalculation\(\);\s*\Z', re.ASCII)


class HybridFormError(ValueError):
    def __init__(self, code="native_pdf_unsupported"):
        self.code = code
        super().__init__(code)


def _require(condition, code="native_pdf_unsupported"):
    if not condition:
        raise HybridFormError(code)


def _resolve(value):
    return value.get_object() if value is not None else None


def _root(pdf):
    return pdf.root_object if isinstance(pdf, PdfWriter) else pdf.trailer["/Root"]


def _local(element):
    return element.tag.rsplit("}", 1)[-1]


@dataclass(frozen=True)
class HybridField:
    field_name: str
    native_field: DictionaryObject
    template_path: str
    authored_label: str | None
    needs_tooltip: bool
    needs_speech_enable: bool = False


@dataclass(frozen=True)
class HybridContext:
    xfa_owner_ids: frozenset[int]
    javascript_owner_ids: frozenset[int]
    javascript_action_ids: frozenset[int]
    usage_rights_node_ids: frozenset[int]
    fields: tuple[HybridField, ...]
    has_reader_rights: bool
    xfa_packet_stream_ids: frozenset[int]


def _reader_rights(root):
    """Recognize only Reader usage rights, never document/user signatures."""
    if "/Perms" not in root:
        return frozenset()
    perms = _resolve(root["/Perms"])
    _require(isinstance(perms, DictionaryObject) and set(perms) == {"/UR3"})
    signature = _resolve(perms["/UR3"])
    _require(isinstance(signature, DictionaryObject))
    _require(set(signature) <= {"/Type", "/Filter", "/SubFilter", "/Reference", "/Name", "/M", "/Contents", "/ByteRange", "/Prop_Build"})
    _require(signature.get("/Type") == "/Sig" and signature.get("/Filter") == "/Adobe.PPKLite"
             and signature.get("/SubFilter") == "/adbe.pkcs7.detached")
    contents, ranges = signature.get("/Contents"), _resolve(signature.get("/ByteRange"))
    _require(isinstance(contents, ByteStringObject) and 0 < len(contents) <= 131_072)
    _require(isinstance(ranges, ArrayObject) and len(ranges) == 4
             and all(isinstance(n, int) and not isinstance(n, bool) and n >= 0 for n in ranges)
             and ranges[0] == 0 and 0 < ranges[1] < ranges[2])
    references = _resolve(signature.get("/Reference"))
    _require(isinstance(references, ArrayObject) and len(references) == 1)
    reference = _resolve(references[0])
    _require(isinstance(reference, DictionaryObject)
             and set(reference) <= {"/Type", "/TransformMethod", "/TransformParams", "/Data"}
             and reference.get("/Type") == "/SigRef" and reference.get("/TransformMethod") == "/UR3"
             and _resolve(reference.get("/Data")) is root)
    params = _resolve(reference.get("/TransformParams"))
    _require(isinstance(params, DictionaryObject) and params.get("/Type") == "/TransformParams"
             and params.get("/V") == "/2.2"
             and set(params) <= {"/Type", "/V", "/Msg", "/Document", "/Annots", "/Form", "/Signature", "/P", "/EF"})
    rights = {
        "/Document": {"/FullSave"},
        "/Annots": {"/Create", "/Delete", "/Modify", "/Copy", "/Import", "/Export", "/Online"},
        "/Form": {"/FillIn", "/Import", "/Export", "/SubmitStandalone", "/Online", "/Add", "/Delete"},
        "/Signature": {"/Modify"},
        "/EF": {"/Create", "/Delete", "/Import", "/Modify"},
    }
    for key, allowed in rights.items():
        if key in params:
            value = _resolve(params[key])
            _require(isinstance(value, ArrayObject) and all(isinstance(v, NameObject) and v in allowed for v in value))
    _require("/Msg" not in params or isinstance(params["/Msg"], TextStringObject))
    _require("/P" not in params or isinstance(params["/P"], BooleanObject))
    _require("/Name" not in signature or isinstance(signature["/Name"], TextStringObject))
    _require("/M" not in signature or isinstance(signature["/M"], TextStringObject))
    identities = {id(perms), id(signature), id(reference), id(params)}
    if "/Prop_Build" in signature:
        build = _resolve(signature["/Prop_Build"])
        _require(isinstance(build, DictionaryObject) and set(build) <= {"/Filter", "/App", "/PubSec"})
        identities.add(id(build))
        for item in build.values():
            item = _resolve(item)
            _require(isinstance(item, DictionaryObject) and set(item) <= {"/Name", "/Date", "/R", "/V", "/PreRelease", "/OS", "/NonEFontNoWarn", "/TrustedMode"})
            _require(all(not isinstance(_resolve(v), (DictionaryObject, ArrayObject)) for v in item.values()))
            identities.add(id(item))
    return frozenset(identities)


def _reject_other_signatures(root, rights):
    pending, seen = [(root, 0)], set()
    while pending:
        value, depth = pending.pop()
        value = _resolve(value)
        if not isinstance(value, (DictionaryObject, ArrayObject)) or id(value) in seen or id(value) in rights:
            continue
        seen.add(id(value))
        _require(len(seen) <= MAX_GRAPH_NODES and depth <= 128, "pdf_complexity_limit")
        if isinstance(value, DictionaryObject):
            _require(value.get("/FT") != "/Sig" and value.get("/Type") != "/Sig" and "/ByteRange" not in value
                     and "/DocMDP" not in value and "/FieldMDP" not in value and "/UR" not in value)
            pending.extend((v, depth + 1) for v in value.values())
        else:
            pending.extend((v, depth + 1) for v in value)


def _xml_packets(form):
    packets = _resolve(form.get("/XFA"))
    _require(isinstance(packets, ArrayObject) and 2 <= len(packets) <= 32 and len(packets) % 2 == 0)
    values, xml_texts, total = {}, {}, 0
    allowed = {"preamble", "config", "template", "datasets", "localeSet", "xmpmeta", "form", "postamble"}
    for i in range(0, len(packets), 2):
        name, stream = str(packets[i]), _resolve(packets[i + 1])
        _require(name in allowed and name not in values and isinstance(stream, StreamObject))
        data = stream.get_data()
        _require(set(stream) <= {"/Length", "/Filter", "/DecodeParms", "/Type"}
                 and stream.get("/Type") in {None, "/EmbeddedFile"})
        total += len(data)
        _require(len(data) <= MAX_XML_BYTES and total <= MAX_XML_BYTES, "pdf_complexity_limit")
        # A byte search alone misses UTF-16/32 declarations. Accept only UTF-8
        # packets, reject declarations/entities on decoded text, and pass text
        # (never auto-detected bytes) to ElementTree.
        try:
            text = data.decode("utf-8-sig")
        except UnicodeDecodeError as error:
            raise HybridFormError() from error
        _require("\x00" not in text and not re.search(r"<!\s*(?:DOCTYPE|ENTITY)\b", text, re.I))
        encoding = re.search(r'<\?xml\s+[^?]*encoding\s*=\s*[\'"]([^\'"]+)[\'"]', text, re.I)
        _require(encoding is None or encoding.group(1).lower() in {"utf-8", "utf8", "us-ascii"})
        values[name] = data
        xml_texts[name] = text
    _require({"config", "template"} <= set(values))
    roots = {}
    for name, data in values.items():
        if name in {"preamble", "postamble"}:
            continue
        try:
            roots[name] = ET.fromstring(xml_texts[name])
        except ET.ParseError as error:
            raise HybridFormError() from error
        _require(_local(roots[name]) == name)
        namespaces = {
            "config": "http://www.xfa.org/schema/xci/3.0/",
            "datasets": "http://www.xfa.org/schema/xfa-data/1.0/",
            "form": "http://www.xfa.org/schema/xfa-form/2.8/",
            "localeSet": "http://www.xfa.org/schema/xfa-locale-set/2.7/",
            "xmpmeta": "adobe:ns:meta/",
        }
        if name == "template":
            _require(bool(re.fullmatch(r"\{http://www\.xfa\.org/schema/xfa-template/3\.[0-6]/\}template", roots[name].tag)))
        else:
            _require(roots[name].tag == "{" + namespaces[name] + "}" + name)
    # Validate wrappers as XML too, without resolving any external resources.
    if "preamble" in values or "postamble" in values:
        _require("preamble" in values and "postamble" in values)
        try:
            wrapper = ET.fromstring(xml_texts["preamble"] + "".join(text for name, text in xml_texts.items() if name not in {"preamble", "postamble"}) + xml_texts["postamble"])
        except ET.ParseError as error:
            raise HybridFormError() from error
        _require(wrapper.tag == "{http://ns.adobe.com/xdp/}xdp")
    nodes = 0
    for packet, root in roots.items():
        pending = [(root, 0, ())]
        while pending:
            element, depth, ancestors = pending.pop()
            nodes += 1
            _require(nodes <= MAX_XML_NODES and depth <= 64, "pdf_complexity_limit")
            tag = _local(element)
            path = (*ancestors, tag)
            if packet == "config":
                _require(element.tag == "{http://www.xfa.org/schema/xci/3.0/}" + tag)
            if tag in {"uri", "url", "source", "stylesheet"} and (element.text or "").strip():
                # Designer stores the author's historical output filename here.
                # It is not an imported resource; this service never runs XFA.
                _require(packet == "config" and path == ("config", "present", "output", "uri")
                         and re.fullmatch(r"[A-Za-z]:\\[^\x00-\x1f<>|?*]+\.pdf", element.text or "", re.I))
            for key, value in element.attrib.items():
                local_key = key.rsplit("}", 1)[-1]
                _require(local_key not in {"href", "usehref", "src", "schemaLocation", "noNamespaceSchemaLocation"} or not value)
                if local_key == "use":
                    _require(tag in {"hyphenation", "font", "para", "border"}
                             and re.fullmatch(r"[A-Za-z_][A-Za-z0-9_.\[\]#-]{0,255}", value))
            if packet != "template":
                _require(tag not in {"script", "event", "connectionSet", "sourceSet", "connect", "submit", "execute"})
            pending.extend((child, depth + 1, path) for child in element)
    dynamic = [n for n in roots["config"].iter() if _local(n) == "dynamicRender"]
    ns = "{http://www.xfa.org/schema/xci/3.0/}"
    actual = roots["config"].findall(f"{ns}acrobat/{ns}acrobat7/{ns}dynamicRender")
    _require(len(dynamic) == len(actual) == 1 and dynamic[0] is actual[0]
             and len(dynamic[0]) == 0 and (dynamic[0].text or "").strip() == "forbidden")
    if "form" in roots:
        _require(len(roots["form"]) == 0 and not (roots["form"].text or "").strip())
    return roots


def _assert_exemption_ownership(root, form, javascript_owners, rights):
    """Exemptions belong only to their verified paths, never aliased actions."""
    expected = {}

    def expect(value, parent, key):
        value = _resolve(value)
        _require(isinstance(value, (DictionaryObject, ArrayObject)))
        _require(id(value) not in expected)
        expected[id(value)] = (id(parent), key)
        return value

    expect(form, root, "/AcroForm")
    xfa = expect(form["/XFA"], form, "/XFA")
    packet_ids = set()
    for index in range(1, len(xfa), 2):
        packet_ids.add(id(expect(xfa[index], xfa, index)))
    if javascript_owners:
        names = expect(root["/Names"], root, "/Names")
        tree = expect(names["/JavaScript"], names, "/JavaScript")
        entries = expect(tree["/Names"], tree, "/Names")
        for index in range(1, len(entries), 2):
            action = expect(entries[index], entries, index)
            program = _resolve(action["/JS"])
            if isinstance(program, StreamObject):
                expect(program, action, "/JS")
    if rights:
        permissions = expect(root["/Perms"], root, "/Perms")

        def rights_children(value):
            items = value.items() if isinstance(value, DictionaryObject) else enumerate(value)
            for key, child in items:
                # This required reference points back to the catalog; it is not
                # part of the exemption and must still be inspected normally.
                if key == "/Data":
                    continue
                child = _resolve(child)
                if isinstance(child, (DictionaryObject, ArrayObject)):
                    rights_children(expect(child, value, key))

        rights_children(permissions)
    pending, seen, observed, count = [(root, None, None, 0)], set(), set(), 0
    while pending:
        value, parent, key, depth = pending.pop()
        value = _resolve(value)
        count += 1
        _require(count <= MAX_GRAPH_NODES and depth <= 128, "pdf_complexity_limit")
        if not isinstance(value, (DictionaryObject, ArrayObject)):
            continue
        identity = id(value)
        if identity in expected:
            _require(identity not in observed and expected[identity] == (id(parent), key))
            observed.add(identity)
        if identity in seen:
            continue
        seen.add(identity)
        items = value.items() if isinstance(value, DictionaryObject) else enumerate(value)
        pending.extend((child, value, child_key, depth + 1) for child_key, child in items)
    _require(observed == set(expected))
    return frozenset(packet_ids)


def _document_scripts(root):
    names = _resolve(root.get("/Names"))
    if names is None or "/JavaScript" not in names:
        return frozenset(), frozenset()
    _require(isinstance(names, DictionaryObject))
    tree = _resolve(names["/JavaScript"])
    _require(isinstance(tree, DictionaryObject) and set(tree) == {"/Names"})
    entries = _resolve(tree["/Names"])
    _require(isinstance(entries, ArrayObject) and len(entries) == 6)
    found, actions = set(), set()
    for index in range(0, len(entries), 2):
        name, action = str(entries[index]), _resolve(entries[index + 1])
        _require(name in ADOBE_BOOTSTRAP and name not in found)
        _require(isinstance(action, DictionaryObject) and set(action) == {"/S", "/JS"} and action["/S"] == "/JavaScript")
        program = _resolve(action["/JS"])
        _require(isinstance(program, (StreamObject, TextStringObject)))
        data = program.get_data() if isinstance(program, StreamObject) else str(program).encode("utf-8")
        _require(len(data) <= 16_384, "pdf_complexity_limit")
        try:
            normalized = data.decode("utf-8").replace("\r\n", "\n").replace("\r", "\n").strip()
        except UnicodeDecodeError as error:
            raise HybridFormError() from error
        _require(hashlib.sha256(normalized.encode()).hexdigest() == ADOBE_BOOTSTRAP[name])
        found.add(name)
        actions.add(id(action))
    return frozenset({id(names)}), frozenset(actions)


def _native_fields(pdf, form):
    fields = _resolve(form.get("/Fields"))
    _require(isinstance(fields, ArrayObject))
    result, widgets, seen = {}, {}, set()

    def walk(reference, prefix, inherited_type, depth):
        field = _resolve(reference)
        _require(isinstance(field, DictionaryObject) and id(field) not in seen and depth <= 32)
        seen.add(id(field))
        _require(len(seen) <= MAX_FIELDS * 8, "pdf_complexity_limit")
        _require(not any(key in field for key in ("/AA", "/A", "/Lock", "/SV")))
        partial = field.get("/T")
        _require(isinstance(partial, TextStringObject) and re.fullmatch(r"[A-Za-z_][A-Za-z0-9_-]*\[\d+\]", str(partial)))
        name = ".".join((*prefix, str(partial)))
        kind = field.get("/FT", inherited_type)
        children = _resolve(field.get("/Kids", ArrayObject()))
        _require(isinstance(children, ArrayObject))
        if children:
            _require(field.get("/Subtype") != "/Widget" and kind is None)
            for child in children:
                _require(_resolve(_resolve(child).get("/Parent")) is field)
                walk(child, (*prefix, str(partial)), kind, depth + 1)
        else:
            _require(kind in {"/Tx", "/Btn"} and field.get("/Subtype") == "/Widget" and name not in result)
            flags = int(field.get("/Ff", 0))
            _require(not flags & ((1 << 15) | (1 << 16)) if kind == "/Btn" else True)
            result[name] = field
            widgets[id(field)] = name
            _require(len(result) <= MAX_FIELDS, "pdf_complexity_limit")

    for field in fields:
        walk(field, (), None, 0)
    observed = set()
    for page in pdf.pages:
        for reference in _resolve(page.get("/Annots", ArrayObject())):
            annotation = _resolve(reference)
            if annotation.get("/Subtype") == "/Widget":
                _require(id(annotation) in widgets and id(annotation) not in observed)
                observed.add(id(annotation))
    _require(observed == set(widgets) and bool(result))
    return result


def _template_fields(template, native):
    unsupported = {"occur", "subformSet", "instanceManager", "connectionSet", "connect", "connection", "sourceSet", "submit", "execute", "calculate", "validate", "bindItems", "exclGroup", "variables", "signature", "signData", "exObject", "image", "barcode", "externalObject", "wsdlConnection", "xmlConnection", "xsdConnection"}
    result, script_count, all_names = [], 0, set()

    def walk(element, path, parent=None, field_type=None):
        nonlocal script_count
        tag = _local(element)
        _require(tag not in unsupported)
        if tag in {"subform", "field"} and element.get("name"):
            name = element.get("name")
            _require(re.fullmatch(r"[A-Za-z_][A-Za-z0-9_-]{0,100}", name))
            siblings = list(parent) if parent is not None else [element]
            index = sum(_local(sibling) == tag and sibling.get("name") == name for sibling in siblings[:siblings.index(element)])
            path = (*path, f"{name}[{index}]")
        if tag == "bind":
            _require(set(element.attrib) <= {"match"} and element.get("match", "once") in {"global", "once", "none"})
        if tag == "field":
            _require(element.get("name") is not None and element.get("presence", "visible") == "visible")
            name = ".".join(path)
            _require(name in native and name not in all_names)
            all_names.add(name)
            ui = [n for n in element if _local(n) == "ui"]
            _require(len(ui) == 1 and len(ui[0]) == 1)
            field_type = _local(ui[0][0])
            _require(field_type in {"textEdit", "checkButton"}
                     and native[name]["/FT"] == {"textEdit": "/Tx", "checkButton": "/Btn"}[field_type])
            assists = [n for n in element if _local(n) == "assist"]
            _require(len(assists) <= 1)
            speaks = [] if not assists else [n for n in assists[0] if _local(n) == "speak"]
            _require(len(speaks) <= 1)
            label = None
            if speaks:
                _require(len(speaks[0]) == 0 and not any(k in speaks[0].attrib for k in ("use", "usehref")))
                text = speaks[0].text or ""
                _require(len(text) <= MAX_LABEL, "pdf_complexity_limit")
                _require(not any(ord(c) < 32 and c not in "\t\r\n" for c in text))
                label = text if text.strip() else None
            result.append(HybridField(name, native[name], name, label, label is not None and "/TU" not in native[name]))
        if tag == "script":
            script_count += 1
            _require(script_count <= 32, "pdf_complexity_limit")
            _require(parent is not None and _local(parent) == "event" and len(element) == 0
                     and set(element.attrib) <= {"contentType"} and element.get("contentType") == "application/x-javascript")
            text = (element.text or "").replace("\r\n", "\n").replace("\r", "\n")
            _require(len(text) <= 16_384, "pdf_complexity_limit")
            _require(bool(_COMMENTS.fullmatch(text)) or (field_type == "checkButton" and parent.get("activity") == "mouseUp" and bool(_CHECKBOX_EVENT.fullmatch(text.strip()))))
        if tag == "event":
            _require(set(element.attrib) <= {"activity", "name"} and len(element) == 1 and _local(element[0]) == "script")
        for child in element:
            walk(child, path, element, field_type)

    walk(template, ())
    _require(all_names == set(native))
    return tuple(result)


def inspect_hybrid(pdf):
    """Read-only admission check. Returned identities are scoped to this PDF."""
    try:
        root = _root(pdf)
        form = _resolve(root.get("/AcroForm"))
        if form is None or "/XFA" not in form:
            return None
        _require(isinstance(form, DictionaryObject) and not bool(root.get("/NeedsRendering", False)))
        _require("/CO" not in form or not _resolve(form["/CO"]))
        rights = _reader_rights(root)
        _reject_other_signatures(root, rights)
        packets = _xml_packets(form)
        javascript_owners, javascript_actions = _document_scripts(root)
        packet_ids = _assert_exemption_ownership(root, form, javascript_owners, rights)
        fields = _template_fields(packets["template"], _native_fields(pdf, form))
        return HybridContext(frozenset({id(form)}), javascript_owners, javascript_actions,
                             rights, fields, bool(rights), packet_ids)
    except HybridFormError:
        raise
    except Exception as error:
        raise HybridFormError() from error


def prepare_hybrid(writer):
    """Apply only verified Reader-rights removal and missing native tooltips.

    Return the original context as a change ledger. All XFA packet bytes,
    scripts, values, bindings, fields, appearances and SigFlags remain intact.
    """
    _require(isinstance(writer, PdfWriter))
    context = inspect_hybrid(writer)
    if context is None:
        return None
    if context.has_reader_rights:
        del writer.root_object[NameObject("/Perms")]
    for field in context.fields:
        if field.needs_tooltip:
            field.native_field[NameObject("/TU")] = TextStringObject(field.authored_label)
    return context
