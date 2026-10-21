"""Local, conservative restoration of authored PDF Figure descriptions and bindings.

This repairs an autotagged candidate only when its painting program is unchanged.
Page MCIDs are rebound to the exact source operation occurrences, including vector
paths and text. The output is experimental; independent validation is still required.
"""
from __future__ import annotations

import argparse
from collections import defaultdict
import hashlib
import json
import math
from pathlib import Path
import sys

from pypdf import PdfReader, PdfWriter
from pypdf.generic import (ArrayObject, ByteStringObject, ContentStream,
    DictionaryObject, IndirectObject, NameObject, NullObject, NumberObject,
    StreamObject, TextStringObject)

from pdf_safety import reject_signed_pdf

LIMIT = 4 * 1024 * 1024
MAX_OPS = 200_000
MARKS = {b"BDC", b"BMC", b"EMC", b"MP", b"DP"}
PAINT = {b"Tj", b"TJ", b"'", b'"', b"Do", b"INLINE IMAGE", b"S", b"s",
         b"f", b"F", b"f*", b"B", b"B*", b"b", b"b*", b"sh"}


def obj(value):
    return value.get_object() if isinstance(value, IndirectObject) else value


def refkey(value):
    ref = value if isinstance(value, IndirectObject) else getattr(value, "indirect_reference", None)
    return (ref.idnum, ref.generation) if ref else None


def effective_language(element, catalog):
    seen=set()
    while isinstance(element,dict):
        if id(element) in seen or len(seen)>=64:raise ValueError("invalid_structure_parent_chain")
        seen.add(id(element))
        if "/Lang" in element:return element["/Lang"]
        element=obj(element.get("/P"))
    return catalog.get("/Lang")


def canon(value, depth=0, active=frozenset()):
    """Resource/operand identity without indirect object numbers or tag wrappers."""
    if depth > 50:
        raise ValueError("resource_depth_limit")
    value = obj(value)
    if value is None:
        return None
    if isinstance(value, (dict, list)):
        if id(value) in active:
            raise ValueError("cyclic_resource")
        active = active | {id(value)}
    if isinstance(value, dict):
        ignored = {"/Length", "/Filter", "/DecodeParms", "/StructParents", "/StructParent"}
        result = {str(k): canon(v, depth + 1, active) for k, v in sorted(value.items()) if k not in ignored}
        if isinstance(value, StreamObject):
            data = value.get_data()
            if len(data) > 64 * 1024 * 1024:
                raise ValueError("resource_size_limit")
            if value.get("/Subtype") == "/Form":
                parsed = ContentStream(value, getattr(getattr(value, "indirect_reference", None), "pdf", None)).operations
                rows = [{"index": i, "args": a, "op": o} for i, (a, o) in enumerate(parsed) if o not in MARKS]
                result["drawing"] = [token for token, _ in atoms(rows)]
            else:
                result["decoded"] = hashlib.sha256(data).hexdigest()
        return result
    if isinstance(value, (list, tuple)):
        return [canon(x, depth + 1, active) for x in value]
    if isinstance(value, (bytes, ByteStringObject)):
        return {"bytes": bytes(value).hex()}
    if isinstance(value, (str, NameObject)):
        return str(value)
    if isinstance(value, NullObject):
        return None
    if type(value).__name__ == "BooleanObject":
        return value.value
    if isinstance(value, (int, float)):
        if not math.isfinite(float(value)):
            raise ValueError("invalid_numeric_operand")
        return float(value)
    raise ValueError("unsupported_operand")


def props(page, operand):
    operand = obj(operand)
    if isinstance(operand, NameObject):
        operand = obj(obj(page.get("/Resources", {})).get("/Properties", {})).get(operand)
        operand = obj(operand)
    if not isinstance(operand, dict):
        raise ValueError("invalid_marked_properties")
    return operand


def scan(page, *, candidate=False):
    content = page.get_contents()
    operations = content.operations if content is not None else []
    if len(operations) > MAX_OPS:
        raise ValueError("operation_limit")
    stack, seen, rows = [], set(), []
    for index, (args, op) in enumerate(operations):
        if op in (b"BDC", b"BMC"):
            p = props(page, args[1]) if op == b"BDC" else {}
            mcid = p.get("/MCID")
            if mcid is not None:
                if type(mcid).__name__ != "NumberObject" or mcid < 0 or mcid in seen:
                    raise ValueError("invalid_or_duplicate_mcid")
                if any(entry[0] is not None for entry in stack):
                    raise ValueError("nested_mcid")
                seen.add(int(mcid))
            artifact = str(args[0]) == "/Artifact"
            # These scopes cannot be discarded safely when rebuilding the page.
            if candidate and ((mcid is None and not artifact) or set(p) - {"/MCID"}):
                raise ValueError("candidate_marked_properties_unsupported")
            placed_metadata = (index, p) if str(args[0]) == "/PlacedPDF" and set(p) == {"/Metadata"} and isinstance(obj(p["/Metadata"]), StreamObject) else None
            scoped_properties = not artifact and placed_metadata is None and (bool(set(p) - {"/MCID"}) or str(args[0]) == "/OC")
            stack.append((int(mcid) if mcid is not None else None, artifact, scoped_properties, placed_metadata))
            if len(stack) > 64:
                raise ValueError("marked_depth_limit")
        elif op == b"EMC":
            if not stack:
                raise ValueError("unbalanced_marked_content")
            stack.pop()
        elif op in (b"MP", b"DP"):
            if candidate:
                raise ValueError("candidate_marked_points_unsupported")
        else:
            mcids = [m for m, _, _, _ in stack if m is not None]
            artifact = any(a for _, a, _, _ in stack)
            rows.append({"index": index, "args": args, "op": op,
                         "mcid": mcids[-1] if mcids else None, "artifact": artifact,
                         "scopedProperties": any(extra for _, _, extra, _ in stack),
                         "placedMetadata": [metadata for _, _, _, metadata in stack if metadata is not None]})
    if stack:
        raise ValueError("unbalanced_marked_content")
    return rows


def atoms(rows):
    """Normalize split Tj/TJ shows while retaining exact operation occurrence IDs."""
    result = []
    pending = []
    def flush():
        result.extend(pending)
        pending.clear()
    for row in rows:
        op, args, index = row["op"], row["args"], row["index"]
        if op in (b"Tj", b"TJ"):
            pieces = args if op == b"Tj" else args[0]
            for piece in pieces:
                if isinstance(piece, (str, bytes)):
                    raw = piece.original_bytes if isinstance(piece, TextStringObject) else bytes(piece)
                    pending.extend((("byte", byte), [index]) for byte in raw)
                elif float(piece):
                    value = float(piece)
                    if pending and pending[-1][0][0] == "adjust":
                        prior, owners = pending.pop()
                        value += prior[1]
                        owners = owners + [index]
                    else:
                        owners = [index]
                    if value:
                        pending.append((("adjust", value), owners))
            continue
        flush()
        result.append(((op.decode("ascii"), json.dumps(canon(args), sort_keys=True, separators=(",", ":"))), [index]))
    flush()
    if len(result) > 2_000_000:
        raise ValueError("normalized_operation_limit")
    return result


def structure(reader):
    catalog = reader.root_object if isinstance(reader, PdfWriter) else reader.trailer["/Root"]
    root = obj(catalog.get("/StructTreeRoot"))
    if not isinstance(root, dict):
        raise ValueError("tag_tree_required")
    roles = obj(root.get("/RoleMap", {}))
    page_numbers = {refkey(page): i for i, page in enumerate(reader.pages)}
    owners, figures, elements = {}, [], []
    visited = set()
    def visit(value, page=None, owner=None, figure=None, depth=0):
        value = obj(value)
        if depth > 64 or len(visited) > 20_000:
            raise ValueError("structure_limit")
        if isinstance(value, list):
            for child in value:
                visit(child, page, owner, figure, depth + 1)
        elif isinstance(value, int):
            if page is None or owner is None or (page, int(value)) in owners:
                raise ValueError("ambiguous_content_owner")
            owners[page, int(value)] = owner
            if figure is not None:
                figures[figure]["mcids"].add((page, int(value)))
        elif isinstance(value, dict):
            if "/Pg" in value:
                explicit_page = page_numbers.get(refkey(value.get("/Pg")))
                if explicit_page is None:
                    raise ValueError("invalid_explicit_page_reference")
                page = explicit_page
            if "/S" in value:
                if figure is not None:
                    raise ValueError("figure_semantic_descendants_unsupported")
                if id(value) in visited:
                    raise ValueError("reused_structure_element")
                visited.add(id(value)); elements.append(value)
                role = str(value["/S"])
                for _ in range(16):
                    if role not in roles:
                        break
                    role = str(roles[role])
                else:
                    raise ValueError("role_map_cycle")
                if role == "/Figure":
                    if figure is not None:
                        raise ValueError("nested_figure_unsupported")
                    figure = len(figures)
                    figures.append({"element": value, "mcids": set()})
                visit(value.get("/K"), page, value, figure, depth + 1)
            elif "/MCID" in value:
                if "/Stm" in value:
                    if figure is not None:
                        raise ValueError("form_stream_mcr_unsupported")
                    return
                visit(value["/MCID"], page, owner, figure, depth + 1)
            elif value.get("/Type") == "/OBJR":
                if figure is not None:
                    raise ValueError("figure_object_reference_unsupported")
            elif value is root:
                visit(value.get("/K"), page, owner, figure, depth + 1)
    visit(root)
    return root, owners, figures, elements


def parent_entries(root):
    entries, seen = {}, set()
    def walk(value, depth=0):
        value = obj(value)
        if not isinstance(value, dict) or id(value) in seen or depth > 64:
            raise ValueError("invalid_parent_tree")
        seen.add(id(value))
        nums = obj(value.get("/Nums", []))
        if len(nums) % 2:
            raise ValueError("invalid_parent_tree")
        for i in range(0, len(nums), 2):
            key = int(nums[i])
            if key in entries:
                raise ValueError("duplicate_parent_key")
            entries[key] = nums[i + 1]
        for child in obj(value.get("/Kids", [])):
            walk(child, depth + 1)
    walk(root.get("/ParentTree"))
    return entries


def preserve_figures(source: Path, candidate: Path, output: Path):
    if output.exists() or output.resolve() in (source.resolve(), candidate.resolve()):
        raise ValueError("new_output_required")
    for path in (source, candidate):
        if not path.is_file() or path.stat().st_size > LIMIT:
            raise ValueError("bounded_input_required")
    original, proposed = PdfReader(source, strict=True), PdfReader(candidate, strict=True)
    for reader in (original, proposed):
        if reader.is_encrypted or not 1 <= len(reader.pages) <= 60:
            raise ValueError("unsupported_input")
        reject_signed_pdf(reader)
    if len(original.pages) != len(proposed.pages):
        raise ValueError("page_count_changed")
    _, _, figures, _ = structure(original)
    # All authored Figure elements are retained, including figures described using
    # ActualText alone. No labels are invented for an undescribed source graphic.
    figures = [f for f in figures if "/Alt" in f["element"] or "/ActualText" in f["element"]]
    if not figures:
        raise ValueError("no_authored_figures")
    figure_mcid = {}
    for i, figure in enumerate(figures):
        if not figure["mcids"] or len({p for p, _ in figure["mcids"]}) != 1:
            raise ValueError("empty_or_multipage_figure_unsupported")
        for key in figure["mcids"]:
            if key in figure_mcid:
                raise ValueError("overlapping_figures")
            figure_mcid[key] = i
    writer = PdfWriter(clone_from=proposed)
    root, owners, _, elements = structure(writer)
    parent_tree = parent_entries(root)
    new_figures = []
    for figure in figures:
        if any(key in figure["element"] for key in ("/C", "/ID", "/Ref", "/AF")):
            raise ValueError("figure_cross_references_unsupported")
        element = DictionaryObject({NameObject("/Type"): NameObject("/StructElem"), NameObject("/S"): NameObject("/Figure")})
        # These are self-contained accessibility descriptions and attributes.
        # IDs/ClassMap references are not copied into a different tree.
        for key in ("/Alt", "/ActualText", "/Lang", "/A", "/T", "/E"):
            if key in figure["element"]:
                if key == "/A":
                    attributes = obj(figure["element"][key])
                    if not isinstance(attributes, dict) or attributes.get("/O") != "/Layout" or set(attributes) - {"/O", "/BBox", "/Placement"}:
                        raise ValueError("figure_attributes_unsupported")
                    bbox = obj(attributes.get("/BBox"))
                    if bbox is not None and (not isinstance(bbox, list) or len(bbox) != 4 or any(not isinstance(v, (int, float)) or not math.isfinite(float(v)) for v in bbox)):
                        raise ValueError("figure_attributes_unsupported")
                    if "/Placement" in attributes and str(attributes["/Placement"]) not in {"/Block", "/Inline", "/Before", "/Start", "/End"}:
                        raise ValueError("figure_attributes_unsupported")
                element[NameObject(key)] = figure["element"][key].clone(writer)
        new_figures.append(writer._add_object(element))
    replacement = defaultdict(list)
    figure_ids = defaultdict(list)
    owner_positions = defaultdict(list)
    figure_positions = defaultdict(list)
    changed_pages = sorted({p for p, _ in figure_mcid})
    reports = []
    # Reading-order anchors also need unchanged pages. Otherwise a figure at
    # the end of one repaired page could jump past intervening untouched pages.
    for p, page in enumerate(writer.pages):
        if p in changed_pages:
            continue
        for row in scan(page):
            owner = owners.get((p, row["mcid"]))
            if owner is not None and not row["artifact"] and row["op"] in PAINT:
                owner_positions[id(owner)].append((p, row["index"]))
    for p in changed_pages:
        src, dst = original.pages[p], writer.pages[p]
        # Binding by names is safe only if all referenced resources are identical.
        # Properties hold old tag declarations and are intentionally not compared.
        for key in ("/Font", "/XObject", "/ExtGState", "/ColorSpace", "/Pattern", "/Shading"):
            if canon(obj(src.get("/Resources", {})).get(key)) != canon(obj(dst.get("/Resources", {})).get(key)):
                raise ValueError("page_resources_changed")
        srows, drows = scan(src), scan(dst, candidate=True)
        if any((p, row["mcid"]) in figure_mcid and row["scopedProperties"] and not row["artifact"] for row in srows):
            raise ValueError("source_figure_scoped_properties_unsupported")
        satoms, datoms = atoms(srows), atoms(drows)
        if [x[0] for x in satoms] != [x[0] for x in datoms]:
            raise ValueError("painting_program_changed")
        sby = {r["index"]: r for r in srows}
        targets = defaultdict(set)
        metadata_targets = defaultdict(set)
        metadata_scopes = {index: metadata for row in srows for index, metadata in row["placedMetadata"]}
        candidate_properties = obj(obj(dst.get("/Resources", {})).get("/Properties", {}))
        metadata_names = {}
        for metadata_id, metadata in metadata_scopes.items():
            matching_names = sorted(str(name) for name, value in candidate_properties.items() if canon(value) == canon(metadata))
            if not matching_names:
                raise ValueError("placed_pdf_metadata_resource_missing")
            metadata_names[metadata_id] = NameObject(matching_names[0])
        for (_, si), (_, di) in zip(satoms, datoms):
            chosen = {figure_mcid.get((p, sby[index]["mcid"])) if not sby[index]["artifact"] else None for index in si}
            if len(chosen) != 1:
                raise ValueError("figure_boundary_ambiguous")
            for index in di:
                targets[index].update(chosen)
                metadata_targets[index].update(tuple(scope for scope, _ in sby[source_index]["placedMetadata"]) for source_index in si)
        if any(len(v) != 1 for v in targets.values()):
            raise ValueError("figure_boundary_inside_candidate_operation")
        if any(len(v) != 1 for v in metadata_targets.values()):
            raise ValueError("metadata_scope_boundary_ambiguous")
        groups = []
        for row in drows:
            target = next(iter(targets.get(row["index"], {None})))
            if target is not None:
                if row["op"] == b"Do":
                    xobject = obj(obj(obj(dst.get("/Resources", {})).get("/XObject", {})).get(row["args"][0]))
                    if not isinstance(xobject, dict) or xobject.get("/Subtype") != "/Image":
                        raise ValueError("figure_form_invocation_unsupported")
                owner = ("figure", target)
                if row["op"] in PAINT:
                    figure_positions[target].append((p, row["index"]))
            elif row["mcid"] is not None and not row["artifact"]:
                if (p, row["mcid"]) not in owners:
                    raise ValueError("candidate_owner_missing")
                owner = ("candidate", row["mcid"])
                if row["op"] in PAINT:
                    owner_positions[id(owners[p, row["mcid"]])].append((p, row["index"]))
            else:
                owner = ("artifact" if row["artifact"] else "unmarked", None)
            metadata_ids = next(iter(metadata_targets.get(row["index"], {()}))) if target is not None else ()
            group_key = (*owner, metadata_ids)
            if not groups or groups[-1][0] != group_key:
                groups.append((group_key, []))
            groups[-1][1].append((row["args"], row["op"]))
        newops, refs = [], []
        for (kind, identifier, metadata_ids), ops in groups:
            if kind in {"figure", "candidate"}:
                mcid = len(refs)
                owner_ref = new_figures[identifier] if kind == "figure" else owners[p, identifier].indirect_reference
                refs.append(owner_ref)
                if kind == "figure":
                    figure_ids[identifier].append((p, mcid))
                else:
                    replacement[p, identifier].append(mcid)
                role = obj(owner_ref).get("/S", NameObject("/Span"))
                newops.append(([role, DictionaryObject({NameObject("/MCID"): NumberObject(mcid)})], b"BDC"))
            elif kind == "artifact":
                newops.append(([NameObject("/Artifact")], b"BMC"))
            for metadata_id in metadata_ids:
                newops.append(([NameObject("/PlacedPDF"), metadata_names[metadata_id]], b"BDC"))
            newops.extend(ops)
            for _ in metadata_ids:
                newops.append(([], b"EMC"))
            if kind != "unmarked":
                newops.append(([], b"EMC"))
        stream = ContentStream(None, writer)
        stream.operations = newops
        dst[NameObject("/Contents")] = writer._add_object(stream)
        parent_key = int(dst.get("/StructParents", -1))
        if parent_key < 0:
            parent_key = max(parent_tree, default=-1) + 1
            dst[NameObject("/StructParents")] = NumberObject(parent_key)
        parent_tree[parent_key] = ArrayObject(refs)

    page_numbers = {refkey(page): i for i, page in enumerate(writer.pages)}
    def replace_k(value, page):
        value = obj(value)
        if isinstance(value, list):
            out = []
            for child in value:
                out.extend(replace_k(child, page))
            return out
        if isinstance(value, int):
            return [NumberObject(n) for n in replacement[page, int(value)]] if page in changed_pages else [value]
        if isinstance(value, dict):
            if "/S" in value:
                return [value.indirect_reference]
            if "/MCID" in value:
                if "/Stm" in value:
                    return [value]
                p = page_numbers.get(refkey(value.get("/Pg")), page)
                if p in changed_pages:
                    return [DictionaryObject({NameObject("/Type"): NameObject("/MCR"), NameObject("/Pg"): writer.pages[p].indirect_reference, NameObject("/MCID"): NumberObject(n)}) for n in replacement[p, int(value["/MCID"])]]
            return [value]
        if value is None:
            return []
        raise ValueError("unsupported_structure_child")
    # Resolve inherited pages before changing any children.
    inherited = {}
    def page_of(element, active=frozenset()):
        if id(element) in inherited:
            return inherited[id(element)]
        if id(element) in active or len(active) >= 64:
            raise ValueError("invalid_structure_parent_chain")
        active = active | {id(element)}
        p = page_numbers.get(refkey(element.get("/Pg")))
        if p is None:
            parent = obj(element.get("/P"))
            if parent is not root and isinstance(parent, dict):
                p = page_of(parent, active)
        inherited[id(element)] = p
        return p
    for element in elements:
        page_of(element)
    emptied_by_transfer = set()
    for element in elements:
        old_kids = obj(element.get("/K"))
        previously_nonempty = bool(old_kids) if isinstance(old_kids, list) else old_kids is not None
        element[NameObject("/K")] = ArrayObject(replace_k(element.get("/K"), inherited[id(element)]))
        if previously_nonempty and not element["/K"]:
            emptied_by_transfer.add(id(element))
    # Insert before the closest surviving content element, in the same semantic
    # container. Ambiguous content crossing the figure is rejected, not guessed.
    for i, figure_ref in enumerate(new_figures):
        if not figure_positions[i] or not figure_ids[i]:
            raise ValueError("figure_has_no_painted_content")
        start, end = min(figure_positions[i]), max(figure_positions[i])
        for positions in owner_positions.values():
            if min(positions) < start and max(positions) > end:
                raise ValueError("figure_interleaves_candidate_element")
        possible = [(min(pos), element) for element in elements if (pos := owner_positions.get(id(element))) and min(pos) > end]
        after = True
        if possible:
            _, anchor = min(possible, key=lambda item: item[0]); after = False
        else:
            possible = [(max(pos), element) for element in elements if (pos := owner_positions.get(id(element))) and max(pos) < start]
            anchor = max(possible, key=lambda item: item[0])[1] if possible else None
        if anchor is None:
            documents = [e for e in elements if e.get("/S") == "/Document"]
            if len(documents) != 1:
                raise ValueError("figure_container_ambiguous")
            parent, at = documents[0], 0
        else:
            parent = obj(anchor.get("/P"))
            if parent.get("/S") not in {"/Document", "/Part", "/Sect", "/Div", "/Art"}:
                raise ValueError("figure_insertion_container_unsupported")
            kids = list(obj(parent.get("/K", [])))
            matches = [n for n, k in enumerate(kids) if refkey(k) == refkey(anchor)]
            if len(matches) != 1:
                raise ValueError("figure_anchor_ambiguous")
            at = matches[0] + int(after)
        kids = list(obj(parent.get("/K", [])))
        if after:
            # Several Figures can share the same preceding paragraph. Keep
            # already inserted earlier figures before the current one.
            prior_figures = {refkey(ref): j for j, ref in enumerate(new_figures[:i])}
            while at < len(kids) and refkey(kids[at]) in prior_figures and min(figure_positions[prior_figures[refkey(kids[at])]]) < start:
                at += 1
        kids.insert(at, figure_ref)
        parent[NameObject("/K")] = ArrayObject(kids)
        fig = obj(figure_ref)
        fig[NameObject("/P")] = parent.indirect_reference
        source_language=effective_language(figures[i]["element"],original.trailer["/Root"])
        target_language=effective_language(fig,writer.root_object)
        if source_language is not None and source_language!=target_language:
            fig[NameObject("/Lang")]=source_language.clone(writer)
        p = figure_ids[i][0][0]
        fig[NameObject("/Pg")] = writer.pages[p].indirect_reference
        fig[NameObject("/K")] = ArrayObject([NumberObject(m) for _, m in figure_ids[i]])
        reports.append({"sourcePage": p + 1, "sourceMcids": sorted(m for _, m in figures[i]["mcids"]),
                        "candidateMcids": [m for _, m in figure_ids[i]], "paintOperations": len(figure_positions[i]),
                        "hasAlt": "/Alt" in fig, "hasActualText": "/ActualText" in fig,
                        "insertionContainer": str(parent.get("/S"))})
    # Remove old empty leaves/groups left after transferring their content.
    def prune(element):
        result = []
        original_kids = obj(element.get("/K", []))
        original_kids = original_kids if isinstance(original_kids, list) else [original_kids]
        removed = False
        for child in original_kids:
            node = obj(child)
            if isinstance(node, dict) and "/S" in node:
                prune(node)
                if id(node) in emptied_by_transfer:
                    removed = True
                    continue
            result.append(child)
        element[NameObject("/K")] = ArrayObject(result)
        if removed and not result:
            emptied_by_transfer.add(id(element))
    prune(root)
    root[NameObject("/ParentTree")] = writer._add_object(DictionaryObject({NameObject("/Nums"): ArrayObject([value for key, entry in sorted(parent_tree.items()) for value in (NumberObject(key), entry)])}))
    root[NameObject("/ParentTreeNextKey")] = NumberObject(max(parent_tree, default=-1) + 1)
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("xb") as stream:
        writer.write(stream)
    return {"experimental": True, "certification": False, "figuresRestored": len(reports), "figures": reports}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("candidate", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    print(json.dumps(preserve_figures(args.source, args.candidate, args.output)))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(json.dumps({"status": "figure_preservation_incomplete", "reason": str(error) if isinstance(error, ValueError) else "unexpected_structure", "certification": False}))
        sys.exit(1)
