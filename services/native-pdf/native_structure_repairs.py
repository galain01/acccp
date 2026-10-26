"""Small, deterministic PDF tag metadata repairs; never edits page content.

Note identifiers are generated only when the existing structure and ID name
tree are already unambiguous. Invalid existing identifiers are left for review.
"""
from dataclasses import dataclass

from pypdf import PdfWriter
from pypdf.generic import (ArrayObject, ByteStringObject, DictionaryObject,
                          NameObject, TextStringObject)

from verify_pdf import Canonicalizer, InspectionError, STANDARD_ROLES, resolved, structure_id_tree, structure_inventory
from bounded_semantic_structure import _DiscoveryInspection, SemanticStructureError

MAX_TAGS = 5000
MAX_DEPTH = 64


class NoteIdError(ValueError):
    pass


@dataclass(frozen=True)
class NoteIdSnapshot:
    # Traversal order and parent index bind every identifier to its actual tag.
    nodes: tuple[tuple[int | None, str, bytes | None], ...]
    tree_present: bool


def _raw_id(value):
    value = resolved(value)
    if isinstance(value, TextStringObject):
        raw = value.original_bytes
    elif isinstance(value, ByteStringObject):
        raw = bytes(value)
    else:
        raise NoteIdError("invalid_note_id_state")
    if not raw or len(raw) > 512:
        raise NoteIdError("invalid_note_id_state")
    return raw


def _state(pdf, *, allow_index_extensions=False, allow_missing_index=False):
    catalog = pdf.root_object if isinstance(pdf, PdfWriter) else pdf.trailer["/Root"]
    root = resolved(catalog.get("/StructTreeRoot"))
    if not isinstance(root, DictionaryObject):
        raise NoteIdError("invalid_note_id_state")
    roles = resolved(root.get("/RoleMap", {}))
    if not isinstance(roles, dict):
        raise NoteIdError("invalid_note_id_state")
    nodes, entries, seen = [], [], set()

    def walk(raw, parent, parent_index=None, depth=0):
        value = resolved(raw)
        if depth > MAX_DEPTH or len(seen) > MAX_TAGS * 2:
            raise NoteIdError("note_id_complexity_limit")
        if isinstance(value, (ArrayObject, DictionaryObject)):
            if id(value) in seen:
                raise NoteIdError("invalid_note_id_state")
            seen.add(id(value))
        if isinstance(value, ArrayObject):
            for item in value:
                walk(item, parent, parent_index, depth + 1)
        elif isinstance(value, DictionaryObject) and value.get("/Type") not in ("/MCR", "/OBJR"):
            if (resolved(value.get("/P")) is not parent or not isinstance(value.get("/S"), NameObject)
                    or getattr(value, 'indirect_reference', None) is None or len(nodes) >= MAX_TAGS):
                raise NoteIdError("invalid_note_id_state")
            role, role_seen = str(value["/S"]), set()
            while role.lstrip("/") not in STANDARD_ROLES and role in roles and role not in role_seen:
                role_seen.add(role)
                role = str(resolved(roles[role]))
            index = len(nodes)
            nodes.append(value)
            entries.append((parent_index, role, _raw_id(value["/ID"]) if "/ID" in value else None))
            walk(value.get("/K"), value, index, depth + 1)

    walk(root.get("/K"), root)
    existing = {identifier: node for node, (_, _, identifier) in zip(nodes, entries) if identifier is not None}
    if len(existing) != sum(identifier is not None for _, _, identifier in entries):
        raise NoteIdError("invalid_note_id_state")
    try:
        tree = structure_id_tree(root)
    except InspectionError as error:
        raise NoteIdError("invalid_note_id_state") from error
    # Rebuilding an index must not discard unrecognized authored metadata.
    pending = [resolved(root["/IDTree"])] if "/IDTree" in root else []
    while pending:
        item = pending.pop()
        if not allow_index_extensions and set(item) - {"/Names", "/Kids", "/Limits"}:
            raise NoteIdError("invalid_note_id_state")
        pending.extend(resolved(child) for child in resolved(item.get("/Kids", [])))
    missing_index = allow_missing_index and '/IDTree' not in root
    if not missing_index and (set(tree) != {identifier.hex() for identifier in existing}
            or any(tree[key.hex()] is not node for key, node in existing.items())):
        raise NoteIdError("invalid_note_id_state")
    return root, nodes, NoteIdSnapshot(tuple(entries), "/IDTree" in root)


def initialize_generated_id_tree(original, writer):
    """Index only new tagger IDs from an untagged source, without changing IDs.

    PDF structure elements with IDs require an IDTree mapping those exact IDs
    to their owners: https://pdfa.org/download-area/cheat-sheets/LogicalStructureObjects.pdf
    This is not a repair path for an uploaded document's authored index.
    """
    if original.trailer['/Root'].get('/StructTreeRoot') is not None:
        raise NoteIdError('generated_id_tree_requires_untagged_source')
    root, nodes, snapshot = _state(writer, allow_missing_index=True)
    if snapshot.tree_present:
        return 0  # _state already verified the existing index; never replace it.
    entries = {identifier: node.indirect_reference
               for node, (_, _, identifier) in zip(nodes, snapshot.nodes) if identifier is not None}
    if not entries:
        return 0
    names = ArrayObject()
    for identifier, reference in sorted(entries.items()):
        names.extend((ByteStringObject(identifier), reference))
    root[NameObject('/IDTree')] = writer._add_object(DictionaryObject({NameObject('/Names'): names}))
    return len(entries)


def verify_generated_id_tree(before, after):
    """Verify saved ID associations and structural/catalog equivalence."""
    _, _, previous = _state(before, allow_missing_index=True)
    _, _, current = _state(after)
    if (previous.tree_present or not any(identifier is not None for _, _, identifier in previous.nodes)
            or not current.tree_present or previous.nodes != current.nodes):
        raise NoteIdError('generated_id_tree_preservation')
    # The strict reopened _state above verifies every raw ID, unique owner and
    # name-tree entry. Compare structural/catalog semantics after removing the sole
    # permitted addition from a private clone, never from either saved reader.
    # The worker's ordinary preservation check independently verifies pages.
    stripped = PdfWriter(clone_from=after)
    del stripped.root_object['/StructTreeRoot'][NameObject('/IDTree')]
    if (Canonicalizer(list(before.pages)).hash(before.trailer['/Root'])
            != Canonicalizer(list(stripped.pages)).hash(stripped.root_object)):
        raise NoteIdError('generated_id_tree_preservation')


def note_id_snapshot(pdf):
    """Capture trusted pre-repair metadata, or decline an ambiguous structure."""
    try:
        return _state(pdf)[2]
    except (NoteIdError, InspectionError, AttributeError, ValueError, TypeError):
        return None


def _additions(snapshot):
    used = {identifier for _, _, identifier in snapshot.nodes if identifier is not None}
    additions = {}
    for index, (_, role, identifier) in enumerate(snapshot.nodes):
        if role != "/Note" or identifier is not None:
            continue
        base = f"acccp-note-{index + 1:06d}"
        candidate, suffix = base.encode("ascii"), 0
        while candidate in used:
            suffix += 1
            candidate = f"{base}-{suffix}".encode("ascii")
        additions[index] = candidate
        used.add(candidate)
    return additions


def repair_note_ids(writer):
    """Add absent Note IDs and their IDTree entries, preserving every old ID."""
    before = note_id_snapshot(writer)
    if before is None:
        return []
    additions = _additions(before)
    if not additions:
        return []
    root, nodes, _ = _state(writer)
    entries = {}
    for index, node in enumerate(nodes):
        if index in additions:
            node[NameObject("/ID")] = TextStringObject(additions[index].decode("ascii"))
        if "/ID" in node:
            entries[_raw_id(node["/ID"])] = node.indirect_reference
    names = ArrayObject()
    for identifier, reference in sorted(entries.items()):
        names.extend((ByteStringObject(identifier), reference))
    # Rebuild only this metadata index; targets, hierarchy and existing ID bytes
    # remain unchanged. The reopened verifier checks every target and ordering.
    root[NameObject("/IDTree")] = writer._add_object(DictionaryObject({NameObject("/Names"): names}))
    return [{"code": "note_identifier_added", "tagId": f"tag-{index + 1}",
             "message": "Added the internal identifier required for this note without changing its text or location."}
            for index in additions]


def verify_note_ids(before, after):
    """Independently derive expected additions from the immutable pre-step state."""
    if before is None:
        return  # Ambiguous input is never modified by repair_note_ids.
    additions = _additions(before)
    expected = tuple((parent, role, additions.get(index, identifier))
                     for index, (parent, role, identifier) in enumerate(before.nodes))
    actual = note_id_snapshot(after)
    if actual is None or actual.nodes != expected or actual.tree_present != (before.tree_present or bool(additions)):
        raise NoteIdError("note_id_preservation")


def verify_authored_ids(original, candidate, *, _candidate_inspection=None):
    """Keep each authored ID bound to the exact same ordered source content.

    Tag numbers may shift when a separately authorized structural edit adds a
    child. Native MCIDs and page/annotation positions are the stable identity;
    the ordinary preservation check independently protects their page programs.
    """
    try:
        if _candidate_inspection is not None and type(_candidate_inspection) is not _DiscoveryInspection:
            raise NoteIdError("authored_id_preservation")
        inventories = [structure_inventory(original),
            _candidate_inspection.copy_for(candidate) if _candidate_inspection is not None
            else structure_inventory(candidate)]
        if any(item.get("tagged") and not item.get("native_id_tree", {}).get("verified") for item in inventories):
            raise NoteIdError("authored_id_preservation")
        maps = [{tag["nativeIdHex"]: tag for tag in inventory["tags"] if "nativeIdHex" in tag}
                for inventory in inventories]
        if any(not identifier or not tag.get("idTreeVerified") for mapping in maps for identifier, tag in mapping.items()):
            raise NoteIdError("authored_id_preservation")

        inspected_entries = 0

        def association(inventory, target):
            tags = {tag["id"]: tag for tag in inventory["tags"]}
            seen, content = set(), []

            def walk(tag, depth=0, path=()):
                nonlocal inspected_entries
                if depth > MAX_DEPTH or len(seen) >= MAX_TAGS or tag["id"] in seen or tag.get("textIncomplete"):
                    raise NoteIdError("authored_id_preservation")
                seen.add(tag["id"])
                for index, entry in enumerate(tag["contentSequence"]):
                    inspected_entries += 1
                    if inspected_entries > 100_000:
                        raise NoteIdError("authored_id_preservation")
                    if not entry.get("resolved"):
                        raise NoteIdError("authored_id_preservation")
                    if entry["kind"] == "childTag":
                        walk(tags[entry["tagId"]], depth + 1, (*path, index))
                    elif entry["kind"] == "markedContent":
                        if not entry.get("parentTreeVerified") or entry.get("text") is None:
                            raise NoteIdError("authored_id_preservation")
                        content.append(("marked", (*path, index), entry["pageNumber"], entry.get("streamId"), entry["mcid"], entry["text"]))
                    elif entry["kind"] == "objectReference":
                        if not entry.get("parentTreeVerified"):
                            raise NoteIdError("authored_id_preservation")
                        content.append(("object", (*path, index), entry["pageNumber"], entry["annotationIndex"], entry["subtype"]))
                    else:
                        raise NoteIdError("authored_id_preservation")
            walk(target)
            # Relative paths distinguish a parent from its only child without
            # forbidding unrelated sibling insertion elsewhere in the document.
            if content:
                return tuple(content)
            # Empty tags have no content anchor, so their exact position stays
            # conservative; a separately authorized mutation can use the native
            # object bindings below to establish their identity instead.
            ancestry = []
            tag = target
            while True:
                parent = tags.get(tag.get("parentId"))
                siblings = [item["id"] for item in inventory["tags"] if item.get("parentId") == tag.get("parentId")]
                ancestry.append(siblings.index(tag["id"]))
                if parent is None:
                    break
                tag = parent
                if len(ancestry) > MAX_DEPTH:
                    raise NoteIdError("authored_id_preservation")
            return ("empty-position", tuple(reversed(ancestry)))

        for identifier, source_tag in maps[0].items():
            output_tag = maps[1].get(identifier)
            if output_tag is None or association(inventories[0], source_tag) != association(inventories[1], output_tag):
                raise NoteIdError("authored_id_preservation")
    except (InspectionError, SemanticStructureError, KeyError, IndexError, AttributeError, TypeError) as error:
        raise NoteIdError("authored_id_preservation") from error


def authored_id_bindings(writer):
    """Capture ID owners by native object identity before trusted mutations."""
    _, nodes, snapshot = _state(writer, allow_index_extensions=True)
    return tuple((identifier, node) for node, (_, _, identifier) in zip(nodes, snapshot.nodes)
                 if identifier is not None)


def verify_authored_id_bindings(before, writer):
    """New tags may change ordinal IDs; every old native owner must survive."""
    actual = dict(authored_id_bindings(writer))
    if any(actual.get(identifier) is not owner for identifier, owner in before):
        raise NoteIdError("authored_id_preservation")
