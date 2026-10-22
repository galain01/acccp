"""Bounded, read-only inventory of terminal native PDF form controls.

Grouping dictionaries are traversed, never reported as controls. Widget ownership
is checked against both the field hierarchy and page annotation arrays. XFA speech
is reported only from the same document's independently admitted hybrid context.
"""
from __future__ import annotations

import hashlib
import json
import math

from pypdf import PdfWriter
from pypdf.generic import (ArrayObject, BooleanObject, ByteStringObject,
                          DictionaryObject, IndirectObject, NameObject, NullObject,
                          NumberObject, TextStringObject)

try:
    from hybrid_forms import HybridFormError, inspect_hybrid
except ImportError:  # Native AcroForm inspection does not require XFA support.
    HybridFormError = ValueError
    inspect_hybrid = None


MAX_FIELDS = 200
MAX_WIDGETS = 800
MAX_NODES = 2_000
MAX_DEPTH = 32
MAX_TEXT = 8_000
MAX_PAGES = 60
FIELD_KEYS = {"/T", "/FT", "/Ff", "/V", "/DV", "/TU", "/TM"}
# /TU is not an inheritable field attribute. A grouping label cannot supply a
# missing accessible name on a terminal field (PDF field dictionary table).
INHERITED_KEYS = {"/FT", "/Ff", "/V"}


class NativeFormInventoryError(ValueError):
    """Controlled diagnostics; never include field names or entered values."""
    def __init__(self, code="native_pdf_unsupported"):
        self.code = code
        super().__init__(code)


def _require(condition, code="native_pdf_unsupported"):
    if not condition:
        raise NativeFormInventoryError(code)


def _resolve(value):
    return value.get_object() if value is not None else None


def _same_page(left, right):
    left, right = _resolve(left), _resolve(right)
    if left is right:
        return True
    references = [getattr(value, "indirect_reference", None) for value in (left, right)]
    return (all(isinstance(reference, IndirectObject) for reference in references)
            and references[0].pdf is references[1].pdf
            and references[0].idnum == references[1].idnum
            and references[0].generation == references[1].generation)


def _text(value, *, value_field=False):
    value = _resolve(value)
    if value is None or isinstance(value, NullObject):
        return ""
    if value_field and isinstance(value, ArrayObject):
        _require(len(value) <= 200, "pdf_complexity_limit")
        for item in value:
            _require(isinstance(_resolve(item), (TextStringObject, ByteStringObject, NameObject)))
        text = str(value)
    else:
        allowed = (TextStringObject, ByteStringObject, NameObject, NumberObject) if value_field else (TextStringObject, ByteStringObject)
        _require(isinstance(value, allowed) and not isinstance(value, BooleanObject))
        text = str(value)
    _require(len(text) <= MAX_TEXT, "pdf_complexity_limit")
    return text


def _flags(value):
    value = _resolve(value)
    _require(isinstance(value, NumberObject) and not isinstance(value, BooleanObject)
             and 0 <= int(value) <= 0xFFFFFFFF)
    return int(value)


def _widget_only(node):
    return node.get("/Subtype") == "/Widget" and not FIELD_KEYS.intersection(node)


def native_form_inventory(pdf):
    """Return ``{fields, field_count, widget_count}`` without changing ``pdf``.

    Each terminal row retains ``name/type/label/required/value`` and adds a stable
    ``fieldId``, sorted ``pageNumbers``, ``widgets`` (widgetId/pageNumber/rect), and
    ``speech`` (supported/text/disabled/priority/source). Widget IDs use existing
    one-based page/annotation positions; field IDs use hierarchy positions and
    qualified names, so native object renumbering or label fixes do not change IDs.

    ``speech.disabled`` is None when the current XFA state is not established.
    Ambiguous/malformed ownership fails closed rather than hiding controls.
    """
    try:
        return _inventory(pdf)
    except NativeFormInventoryError:
        raise
    except Exception as error:
        raise NativeFormInventoryError() from error


def _inventory(pdf):
    root = pdf.root_object if isinstance(pdf, PdfWriter) else pdf.trailer["/Root"]
    pages = list(pdf.pages)
    _require(len(pages) <= MAX_PAGES, "pdf_complexity_limit")
    page_widgets = {}
    for page_number, page in enumerate(pages, 1):
        annotations = _resolve(page.get("/Annots", ArrayObject()))
        _require(isinstance(annotations, ArrayObject))
        _require(len(annotations) <= MAX_NODES, "pdf_complexity_limit")
        for annotation_number, reference in enumerate(annotations, 1):
            widget = _resolve(reference)
            _require(isinstance(widget, DictionaryObject))
            if widget.get("/Subtype") != "/Widget":
                continue
            _require(id(widget) not in page_widgets)
            _require(len(page_widgets) < MAX_WIDGETS, "pdf_complexity_limit")
            if "/P" in widget:
                _require(_same_page(widget["/P"], page))
            rect = _resolve(widget.get("/Rect"))
            _require(isinstance(rect, ArrayObject) and len(rect) == 4)
            _require(all(isinstance(_resolve(n), (int, float)) and not isinstance(_resolve(n), (bool, BooleanObject))
                         and math.isfinite(float(_resolve(n))) and abs(float(_resolve(n))) <= 10_000_000 for n in rect))
            page_widgets[id(widget)] = {"widgetId": f"p{page_number}-a{annotation_number}",
                "pageNumber": page_number, "rect": [float(_resolve(n)) for n in rect]}

    form = _resolve(root.get("/AcroForm"))
    if form is None:
        _require(not page_widgets)
        return {"fields": [], "field_count": 0, "widget_count": 0}
    _require(isinstance(form, DictionaryObject))
    field_roots = _resolve(form.get("/Fields", ArrayObject()))
    _require(isinstance(field_roots, ArrayObject))
    fields, native_rows, seen, owned = [], {}, set(), set()

    def visit(reference, parent, name_parts, positions, inherited, depth):
        _require(depth <= MAX_DEPTH, "pdf_complexity_limit")
        node = _resolve(reference)
        _require(isinstance(node, DictionaryObject) and id(node) not in seen)
        _require(len(seen) < MAX_NODES, "pdf_complexity_limit")
        seen.add(id(node))
        if parent is None:
            _require("/Parent" not in node)
        else:
            _require(_resolve(node.get("/Parent")) is parent)
        name_parts = (*name_parts, _text(node["/T"])) if "/T" in node else name_parts
        name = ".".join(name_parts)
        _require(len(name) <= MAX_TEXT, "pdf_complexity_limit")
        state = {**inherited, **{key: node[key] for key in INHERITED_KEYS if key in node}}
        if "/FT" in state:
            _require(isinstance(_resolve(state["/FT"]), NameObject)
                     and str(_resolve(state["/FT"])) in {"/Tx", "/Btn", "/Ch", "/Sig"})
        flags = _flags(state.get("/Ff", NumberObject(0)))
        label = _text(node.get("/TU"))
        value = _text(state.get("/V"), value_field=True)
        kids = _resolve(node.get("/Kids", ArrayObject()))
        _require(isinstance(kids, ArrayObject))
        _require(len(kids) <= MAX_NODES, "pdf_complexity_limit")
        children = [_resolve(child) for child in kids]
        _require(all(isinstance(child, DictionaryObject) for child in children))
        child_widget_flags = [_widget_only(child) for child in children]
        _require(not children or all(child_widget_flags) or not any(child_widget_flags))
        if children and not all(child_widget_flags):
            _require(node.get("/Subtype") != "/Widget")
            for index, child in enumerate(kids):
                visit(child, node, name_parts, (*positions, index), state, depth + 1)
            return
        if "/FT" not in state:
            # An empty grouping dictionary is not a terminal form control.
            _require(not children and node.get("/Subtype") != "/Widget")
            return
        _require(len(fields) < MAX_FIELDS, "pdf_complexity_limit")
        if node.get("/Subtype") == "/Widget":
            _require(not children)
            widgets = [node]
        else:
            widgets = children
            for widget in widgets:
                _require(id(widget) not in seen and _resolve(widget.get("/Parent")) is node and "/Kids" not in widget)
                _require(len(seen) < MAX_NODES, "pdf_complexity_limit")
                seen.add(id(widget))
        widget_rows = []
        for widget in widgets:
            _require(id(widget) in page_widgets and id(widget) not in owned)
            owned.add(id(widget))
            widget_rows.append(page_widgets[id(widget)])
        widget_rows.sort(key=lambda row: (row["pageNumber"], int(row["widgetId"].split("-a")[1])))
        identifier = hashlib.sha256(json.dumps({"path": positions, "name": name}, ensure_ascii=True,
                                               separators=(",", ":")).encode()).hexdigest()
        row = {"fieldId": "field-" + identifier, "name": name, "type": str(_resolve(state["/FT"])).lstrip("/"),
               "label": label, "required": bool(flags & 2), "value": value,
               "pageNumbers": sorted({widget["pageNumber"] for widget in widget_rows}), "widgets": widget_rows,
               "speech": {"supported": False, "text": None, "disabled": None,
                          "priority": None, "source": "xfa-assist"}}
        fields.append(row)
        native_rows[id(node)] = row

    for index, reference in enumerate(field_roots):
        visit(reference, None, (), (index,), {}, 0)
    _require(owned == set(page_widgets))

    if "/XFA" in form and inspect_hybrid is not None:
        try:
            context = inspect_hybrid(pdf)
        except HybridFormError as error:
            raise NativeFormInventoryError(getattr(error, "code", "native_pdf_unsupported")) from error
        _require(context is not None and len(context.fields) == len(fields))
        matched = set()
        for field in context.fields:
            identity = id(field.native_field)
            _require(identity in native_rows and identity not in matched)
            matched.add(identity)
            row = native_rows[identity]
            _require(row["name"] == field.field_name)
            supported = getattr(field, "speech_supported", False)
            text = field.authored_label
            disabled = getattr(field, "speech_disabled", None)
            priority = getattr(field, "speech_priority", None)
            _require(type(supported) is bool and (disabled is None or type(disabled) is bool)
                     and (priority is None or isinstance(priority, str))
                     and (text is None or isinstance(text, str)))
            _require(text is None or len(text) <= MAX_TEXT, "pdf_complexity_limit")
            row["speech"] = {"supported": supported, "text": text, "disabled": disabled,
                             "priority": priority, "source": "xfa-assist"}
        _require(matched == set(native_rows))
    return {"fields": fields, "field_count": len(fields), "widget_count": len(page_widgets)}
