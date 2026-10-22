"""Saved-form identity for matching separately recorded interaction tests.

This is not test evidence itself. Only admitted static hybrid forms receive a
fingerprint. The exact native form/XFA graph, annotations, behavior settings and
widget structure order are bound to it; unrelated page tags and document title
metadata are not. Unknown dictionary keys are retained, never silently waived.
An unsupported or incomplete inspection returns no fingerprint.
"""
from __future__ import annotations

from pypdf import PdfReader
from pypdf.generic import ArrayObject, NameObject, TextStringObject

from hybrid_forms import inspect_hybrid
from hybrid_form_verification import ExactGraph, native_fields, require, v


SCHEMA_VERSION = 1
MAX_TAGS = 10_000
MAX_STRUCTURE_ITEMS = 50_000


class InteractionGraph(ExactGraph):
    """Retain PDF string/name type as well as ExactGraph's complete objects."""

    def value(self, item, active=None, depth=0):
        raw = v.resolved(item)
        if isinstance(raw, NameObject):
            return {"pdfName": super().value(raw, active, depth)}
        if isinstance(raw, TextStringObject):
            # Preserve encoded PDF strings: a PDF name and string with the same
            # spelling may behave differently (notably checkbox /V and /AS).
            data = raw.original_bytes
            super().value(raw, active, depth)  # Apply shared node/depth budgets.
            require(len(data) <= v.MAX_TEXT_CHARS * 4, "interaction_string_limit")
            return {"pdfString": v.digest(data), "bytes": len(data)}
        return super().value(item, active, depth)


def _projection(node, excluded):
    require(isinstance(node, dict), "interaction_dictionary")
    return {str(key): value for key, value in node.items() if str(key) not in excluded}


def _widget_structure(reader, annotation_locations):
    """Read actual OBJR order and validate every widget's ParentTree owner.

    MCIDs and ordinary paragraph/heading roles do not enter this projection.
    A control's own tag and inherited announcement overrides do enter it.
    """
    root = v.resolved(reader.root_object.get("/StructTreeRoot"))
    require(isinstance(root, dict), "interaction_structure_missing")
    parents = v.number_tree(root.get("/ParentTree"))
    roles = v.resolved(root.get("/RoleMap", {}))
    classes = v.resolved(root.get("/ClassMap", {}))
    require(isinstance(roles, dict) and isinstance(classes, dict), "interaction_structure_map")
    page_lookup = {v.Canonicalizer.owned_reference(page): index for index, page in enumerate(reader.pages, 1)}
    seen, owned, rows = set(), set(), []
    count = 0

    def visit(reference, parent, page_number, language, overrides, depth):
        nonlocal count
        count += 1
        require(count <= MAX_STRUCTURE_ITEMS and depth <= v.MAX_DEPTH, "interaction_structure_limit")
        node = v.resolved(reference)
        if isinstance(node, list):
            for item in node:
                visit(item, parent, page_number, language, overrides, depth + 1)
            return
        if node is None or v.integer(node) is not None:
            return
        require(isinstance(node, dict), "interaction_structure_entry")
        if node.get("/Type") == "/MCR":
            return
        if node.get("/Type") == "/OBJR":
            obj = v.resolved(node.get("/Obj"))
            require(id(obj) in annotation_locations, "interaction_orphan_annotation")
            location = annotation_locations[id(obj)]
            expected = page_lookup.get(v.Canonicalizer.owned_reference(node["/Pg"])) if "/Pg" in node else page_number
            require(expected == location[0] and id(obj) not in owned, "interaction_widget_structure_owner")
            key = v.integer(obj.get("/StructParent"))
            require(key is not None and v.resolved(parents.get(key)) is parent, "interaction_widget_parent_tree")
            role = str(parent.get("/S", ""))
            resolved_role, role_seen = role, set()
            while resolved_role not in {"/" + name for name in v.STANDARD_ROLES}:
                require(resolved_role in roles and resolved_role not in role_seen, "interaction_widget_role")
                role_seen.add(resolved_role)
                resolved_role = str(v.resolved(roles[resolved_role]))
            # All control ownership is explicit. An arbitrary non-Form owner
            # is not established equivalent to the tested native form role.
            require(obj.get("/Subtype") != "/Widget" or resolved_role == "/Form", "interaction_widget_role")
            owned.add(id(obj))
            rows.append({"widget": location, "language": language,
                         "ancestorAnnouncements": overrides,
                         "owner": _projection(parent, {"/P", "/K", "/Pg", "/ID"}),
                         "role": resolved_role,
                         "objectReference": _projection(node, {"/Obj", "/Pg"})})
            return
        require(id(node) not in seen and len(seen) < MAX_TAGS
                and v.resolved(node.get("/P")) is parent, "interaction_structure_parent")
        seen.add(id(node))
        if "/Pg" in node:
            page_number = page_lookup.get(v.Canonicalizer.owned_reference(node["/Pg"]))
        if "/Lang" in node:
            require(isinstance(v.resolved(node["/Lang"]), TextStringObject), "interaction_structure_language")
            language = node["/Lang"]
        # Keep titles, alternate text, attributes and unknown ancestor keys.
        # Only ordinary role/lineage bookkeeping is intentionally ignored;
        # inherited /Lang is recorded as the effective control language.
        announcements = _projection(node, {"/Type", "/S", "/P", "/K", "/Pg", "/ID", "/Lang"})
        if "/C" in node:
            names = v.resolved(node["/C"])
            names = names if isinstance(names, list) else [names]
            resolved_classes = []
            for name in names:
                if v.integer(name) is not None:
                    resolved_classes.append(name)
                else:
                    require(isinstance(name, NameObject) and name in classes, "interaction_structure_class")
                    resolved_classes.append([name, classes[name]])
            announcements["resolvedClasses"] = resolved_classes
        if announcements:
            overrides = [*overrides, announcements]
        visit(node.get("/K"), node, page_number, language, overrides, depth + 1)

    visit(root.get("/K"), root, None, reader.root_object.get("/Lang"), [], 0)
    # Include links/other annotations too: their placement between controls
    # changes keyboard order when the page uses /Tabs /S.
    require(owned == set(annotation_locations), "interaction_widget_structure_incomplete")
    return rows


def interaction_payload(reader):
    """Internal inspectable payload; callers cannot supply projected evidence."""
    require(isinstance(reader, PdfReader) and not reader.is_encrypted
            and 1 <= len(reader.pages) <= 60, "interaction_saved_reader_required")
    context = inspect_hybrid(reader)
    require(context is not None, "interaction_hybrid_required")
    fields = native_fields(reader)
    pages = list(reader.pages)
    locations = {}
    for page_number, page in enumerate(pages, 1):
        annotations = v.resolved(page.get("/Annots", ArrayObject()))
        require(isinstance(annotations, list), "interaction_annotations")
        for index, reference in enumerate(annotations, 1):
            annotation = v.resolved(reference)
            require(isinstance(annotation, dict), "interaction_annotation")
            require(id(annotation) not in locations, "interaction_annotation_reused")
            locations[id(annotation)] = [page_number, index]
    catalog = _projection(reader.root_object, {"/Type", "/Pages", "/AcroForm", "/StructTreeRoot", "/Metadata"})
    if "/ViewerPreferences" in catalog:
        catalog["/ViewerPreferences"] = _projection(v.resolved(catalog["/ViewerPreferences"]), {"/DisplayDocTitle"})
    # /Resources is retained (including inherited defaults), along with all
    # annotations, /Tabs, /AA, geometry and unknown page behavior keys. Paint
    # streams and unrelated MCID indexing are the only page-level exclusions.
    page_projections = [_projection(page, {"/Type", "/Parent", "/Contents", "/StructParents", "/Metadata"}) for page in pages]
    return {"domain": "native-pdf-form-interaction", "schemaVersion": SCHEMA_VERSION,
            "form": reader.root_object["/AcroForm"], "catalog": catalog,
            "pages": page_projections,
            "ownership": [{"name": list(name), "type": field["type"], "widgets": field["widgets"]}
                          for name, field in fields.items()],
            "widgetStructure": _widget_structure(reader, locations),
            "structureSettings": _projection(v.resolved(reader.root_object.get("/StructTreeRoot")),
                {"/Type", "/K", "/ParentTree", "/ParentTreeNextKey", "/IDTree", "/RoleMap", "/ClassMap"})}


def form_interaction_fingerprint(reader):
    """Return a worker-derived fingerprint, or None when equivalence is unknown.

    Omission leaves ordinary interaction review in place. No request/model/PDF
    metadata value is consulted as a claimed digest or proof of testing.
    """
    try:
        payload = interaction_payload(reader)
        return {"schemaVersion": SCHEMA_VERSION,
                "sha256": InteractionGraph(list(reader.pages)).hash(payload)}
    except Exception:
        return None
