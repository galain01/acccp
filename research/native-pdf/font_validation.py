"""Independent, explicit opt-in verification of layout-preserving font changes.

The ordinary PDF verifier stays strict. This companion accepts only an exact,
hash-bound substitution ledger, rechecks each font, and separately verifies the
actual saved PDF's character placement and rendered glyph-change regions.
"""
from __future__ import annotations

import argparse
import ctypes
import io
import json
import logging
import math
from pathlib import Path
import re
from typing import Any

import numpy as np
from pypdf import PdfReader
from pypdf.generic import NameObject, TextStringObject
import pypdfium2 as pdfium
import pypdfium2.raw as raw

import verify_pdf as v

MAX_MANIFEST_BYTES = 1_000_000
MAX_SUBSTITUTIONS = 128
ORIGIN_TOLERANCE_PT = 0.02
GLYPH_BOX_TOLERANCE_PT = 0.75
# Glyph outlines may differ within their unchanged advance cells. A 0.15-em
# ceiling also bounds vertical/sidebearing changes; origin and width are stricter.
GLYPH_BOX_TOLERANCE_EM = 0.15
ADVANCE_CELL_OVERHANG_EM = 0.02
ALLOWED_FAMILIES = {
    "Helvetica": "LiberationSans",
    "Helvetica-Bold": "LiberationSans-Bold",
    "Courier": "LiberationMono",
}
# Independently pinned official Liberation 2.1.5 release programs (OFL-1.1).
# https://github.com/liberationfonts/liberation-fonts/releases/tag/2.1.5
APPROVED_FONT_PROGRAMS = {
    "LiberationSans": "76d04c18ea243f426b7de1f3ad208e927008f961dc5945e5aad352d0dfde8ee8",
    "LiberationSans-Bold": "788abee4c806d660e8aee46689dd8540cd4bb98da03dcc9d171ce3efd99a9173",
    "LiberationMono": "f2b83c763e8afd21709333370bed4774337fae82267937e2b5aea7e2fbd922c1",
}
FONT_CHANGE_FINDINGS = {
    "fonts_changed", "resources_changed", "catalog_behavior_changed",
    "page_properties_changed", "page_pixels_changed",
    "source_figure_membership_changed", "source_figure_hidden_as_artifact",
}


def require(condition: bool, code: str) -> None:
    if not condition:
        raise v.InspectionError(code)


def sha_file(path: Path) -> str:
    require(path.is_file() and path.stat().st_size <= v.MAX_FILE_BYTES, "file_missing_or_too_large")
    return v.digest(path.read_bytes())


def font_name(value: Any) -> str:
    return str(value).lstrip("/")


def used_codes(page: Any, resource_name: str) -> list[int]:
    """Read actual page text-show bytes; unsupported inherited Forms fail closed."""
    selected = None
    saved: list[Any] = []
    codes: set[int] = set()
    resources = v.resolved(page.get("/Resources", {}))
    for operands, operator in v.operations(page):
        if operator == b"q":
            saved.append(selected)
        elif operator == b"Q":
            require(bool(saved), "unbalanced_graphics_state")
            selected = saved.pop()
        elif operator == b"Tf":
            require(len(operands) == 2, "invalid_font_selection")
            selected = str(operands[0])
        elif operator == b"Do":
            asset = v.resolved(v.resolved(resources.get("/XObject", {})).get(operands[0])) if len(operands) == 1 else None
            require(isinstance(asset, dict) and asset.get("/Subtype") != "/Form", "font_change_on_form_page_unsupported")
        elif selected == resource_name and operator in (b"Tj", b"TJ", b"'", b'"'):
            pieces = operands[0] if operator == b"TJ" else operands[-1:]
            for piece in pieces:
                if isinstance(piece, TextStringObject):
                    codes.update(piece.original_bytes)
                elif isinstance(piece, bytes):
                    codes.update(piece)
                elif isinstance(piece, str):
                    raise v.InspectionError("font_character_encoding_unresolved")
    require(not saved, "unbalanced_graphics_state")
    return sorted(codes)


def validate_font_pair(before: Any, after: Any, entry: dict[str, Any], codes: list[int]) -> dict[str, Any]:
    """Independently check the embedded program, Unicode coverage and advances."""
    try:
        from fontTools.ttLib import TTFont
    except ImportError:
        raise v.InspectionError("font_parser_unavailable") from None
    from reportlab.pdfbase import pdfmetrics

    source_name = font_name(before.get("/BaseFont"))
    target_name = font_name(after.get("/BaseFont"))
    require(source_name in ALLOWED_FAMILIES and target_name == ALLOWED_FAMILIES[source_name], "font_family_not_authorized")
    require(entry.get("sourceBaseFont", "").lstrip("/") == source_name and entry.get("targetBaseFont", "").lstrip("/") == target_name, "manifest_font_name_mismatch")
    require(before.get("/Subtype") == "/Type1" and after.get("/Subtype") == "/TrueType", "font_substitution_type_unsupported")
    source_descriptor = v.resolved(before.get("/FontDescriptor", {}))
    require(not any(key in source_descriptor for key in ("/FontFile", "/FontFile2", "/FontFile3")), "embedded_source_font_change_not_authorized")
    require(before.get("/Encoding") == "/WinAnsiEncoding" or (before.get("/Encoding") is None and all(32 <= code <= 126 for code in codes)), "source_font_encoding_unsupported")
    require(after.get("/Encoding") == "/WinAnsiEncoding", "target_font_encoding_unsupported")
    require(entry.get("usedCharacterCodes") == codes, "manifest_character_codes_mismatch")
    require(v.Canonicalizer().hash(before) == entry.get("sourceFontSha256"), "manifest_source_font_hash_mismatch")
    require(v.Canonicalizer().hash(after) == entry.get("targetFontSha256"), "manifest_target_font_hash_mismatch")
    descriptor = v.resolved(after.get("/FontDescriptor", {}))
    program = v.resolved(descriptor.get("/FontFile2"))
    require(isinstance(program, v.StreamObject), "font_program_missing")
    data = program.get_data()
    require(len(data) <= 5_000_000 and v.digest(data) == entry.get("fontProgramSha256"), "manifest_font_program_hash_mismatch")
    require(v.digest(data) == APPROVED_FONT_PROGRAMS.get(target_name), "font_program_not_independently_approved")
    require(after.get("/ToUnicode") is not None, "target_font_unicode_map_missing")
    first = v.integer(after.get("/FirstChar"))
    widths = v.resolved(after.get("/Widths"))
    require(first is not None and isinstance(widths, list) and len(widths) <= 256, "target_font_widths_invalid")
    font = TTFont(io.BytesIO(data), lazy=False)
    try:
        cmap = font.getBestCmap()
        units = int(font["head"].unitsPerEm)
        require(isinstance(cmap, dict) and units > 0, "font_program_cmap_missing")
        for code in codes:
            try:
                char = bytes([code]).decode("cp1252")
            except UnicodeDecodeError:
                raise v.InspectionError("used_character_encoding_unsupported") from None
            glyph = cmap.get(ord(char))
            require(glyph is not None and glyph != ".notdef", "target_font_missing_used_glyph")
            advance = round(font["hmtx"].metrics[glyph][0] * 1000 / units)
            source_advance = round(pdfmetrics.stringWidth(char, source_name, 1000))
            require(0 <= code - first < len(widths), "target_font_width_missing")
            require(abs(float(widths[code - first]) - source_advance) <= 0.001 and advance == source_advance, "font_advance_width_changed")
    finally:
        font.close()
    return {"sourceBaseFont": source_name, "targetBaseFont": target_name, "usedCharacterCount": len(codes), "fontProgramSha256": v.digest(data), "fontProgramVersion": "2.1.5", "license": "OFL-1.1", "programHashVerified": True, "usedGlyphCoverageVerified": True, "usedAdvanceWidthsVerified": True}


def authorize_fonts(source: Path, output: Path, manifest: dict[str, Any]) -> tuple[PdfReader, PdfReader, list[dict[str, Any]], dict[int, dict[str, str]]]:
    require(manifest.get("schemaVersion") == 1, "font_manifest_version_unsupported")
    require(manifest.get("sourceSha256") == sha_file(source), "font_manifest_source_hash_mismatch")
    require(manifest.get("candidateSha256") == sha_file(output), "font_manifest_candidate_hash_mismatch")
    auth = manifest.get("authorization", {})
    require(auth.get("fontSubstitution") is True and auth.get("glyphAppearanceMayChange") is True, "font_change_authorization_missing")
    entries = manifest.get("substitutions")
    require(isinstance(entries, list) and 1 <= len(entries) <= MAX_SUBSTITUTIONS, "font_manifest_substitutions_invalid")
    before, after = PdfReader(source, strict=True), PdfReader(output, strict=True)
    require(not before.is_encrypted and not after.is_encrypted, "encrypted_pdf_unsupported")
    require(len(before.pages) == len(after.pages) and 1 <= len(before.pages) <= v.MAX_PAGES, "page_count_changed_or_out_of_bounds")
    seen: set[str] = set()
    ledger = []
    allowed_names: dict[int, dict[str, str]] = {}
    replacements = []
    for entry in entries:
        require(isinstance(entry, dict), "font_manifest_substitution_invalid")
        path = entry.get("resourcePath", "")
        match = re.fullmatch(r"page/([1-9][0-9]*)/Resources/Font/([^/\s]+)", path)
        require(match is not None and path not in seen, "font_manifest_resource_path_invalid")
        seen.add(path)
        page_number = int(match.group(1))
        name = "/" + match.group(2)
        require(1 <= page_number <= len(before.pages), "font_manifest_page_out_of_bounds")
        require(entry.get("pageNumber") == page_number and entry.get("resourceName", "").lstrip("/") == name.lstrip("/"), "font_manifest_resource_path_mismatch")
        left_fonts = v.resolved(before.pages[page_number - 1].get("/Resources", {})).get("/Font", {})
        right_fonts = v.resolved(after.pages[page_number - 1].get("/Resources", {})).get("/Font", {})
        left_fonts, right_fonts = v.resolved(left_fonts), v.resolved(right_fonts)
        left, right = v.resolved(left_fonts.get(name)), v.resolved(right_fonts.get(name))
        require(isinstance(left, dict) and isinstance(right, dict), "font_manifest_resource_missing")
        codes = used_codes(before.pages[page_number - 1], name)
        require(codes == used_codes(after.pages[page_number - 1], name), "font_character_codes_changed")
        row = validate_font_pair(left, right, entry, codes)
        row.update({"resourcePath": path, "pageNumber": page_number})
        ledger.append(row)
        names = allowed_names.setdefault(page_number, {})
        require(row["sourceBaseFont"] not in names or names[row["sourceBaseFont"]] == row["targetBaseFont"], "ambiguous_font_name_mapping")
        names[row["sourceBaseFont"]] = row["targetBaseFont"]
        replacements.append((right_fonts, name, left))
    # Shared resource dictionaries must not let one listed page authorize a
    # changed but unlisted occurrence on another page, even if that font is unused.
    for page_number, (left_page, right_page) in enumerate(zip(before.pages, after.pages), 1):
        left_fonts = v.resolved(v.resolved(left_page.get("/Resources", {})).get("/Font", {}))
        right_fonts = v.resolved(v.resolved(right_page.get("/Resources", {})).get("/Font", {}))
        require(set(left_fonts) == set(right_fonts), "unlisted_font_resource_change")
        for name in left_fonts:
            if v.Canonicalizer().hash(left_fonts[name]) != v.Canonicalizer().hash(right_fonts[name]):
                require(f"page/{page_number}/Resources/Font/{str(name).lstrip('/')}" in seen, "unlisted_font_resource_change")
    # Only memory objects are normalized. Actual output bytes are separately
    # rendered and inspected below, and no rewritten PDF is created here.
    for fonts, name, original in replacements:
        fonts[NameObject(name)] = original
    return before, after, ledger, allowed_names


def verify_other_content(before: PdfReader, after: PdfReader) -> dict[str, Any]:
    """Every graph/value outside the specifically authorized font objects is strict."""
    canonical = [v.Canonicalizer(list(reader.pages)) for reader in (before, after)]
    ignored = {"/Type", "/Pages", "/StructTreeRoot", "/MarkInfo", "/Lang", "/Metadata", "/ViewerPreferences"}
    catalog = [{key: value for key, value in reader.trailer["/Root"].items() if str(key) not in ignored} for reader in (before, after)]
    require(canonical[0].hash(catalog[0]) == canonical[1].hash(catalog[1]), "unauthorized_catalog_change")
    preferences = [{key: value for key, value in v.resolved(reader.trailer["/Root"].get("/ViewerPreferences", {})).items() if key != "/DisplayDocTitle"} for reader in (before, after)]
    require(canonical[0].hash(preferences[0]) == canonical[1].hash(preferences[1]), "unauthorized_viewer_change")
    require(v.form_inventory(before) == v.form_inventory(after), "unauthorized_form_change")
    require(v.font_image_inventory(before) == v.font_image_inventory(after), "unauthorized_font_or_image_change")
    for left, right in zip(before.pages, after.pages):
        left_values, right_values, _ = v.page_behavior_values((left, right))
        require(canonical[0].hash(left_values) == canonical[1].hash(right_values), "unauthorized_page_behavior_change")
        require(canonical[0].hash(left.get("/Resources", {})) == canonical[1].hash(right.get("/Resources", {})), "unauthorized_resource_change")
        require(v.drawing_fingerprint(v.operations(left), canonical[0]) == v.drawing_fingerprint(v.operations(right), canonical[1]), "unauthorized_drawing_change")
    figures = v.compare_figure_associations(before, after)
    require(figures["passed"], "authored_figure_association_changed")
    return {"nonFontResourcesUnchanged": True, "drawingProgramsUnchanged": True, "pageAndDocumentBehaviorUnchanged": True, "figureAssociations": figures}


def char_inventory(textpage: Any) -> list[dict[str, Any]]:
    count = textpage.count_chars()
    require(count <= v.MAX_TEXT_CHARS, "font_layout_character_limit")
    result = []
    for index in range(count):
        origin_x, origin_y = ctypes.c_double(), ctypes.c_double()
        require(bool(raw.FPDFText_GetCharOrigin(textpage, index, origin_x, origin_y)), "character_origin_unavailable")
        matrix = raw.FS_MATRIX()
        require(bool(raw.FPDFText_GetMatrix(textpage, index, matrix)), "character_matrix_unavailable")
        length = raw.FPDFText_GetFontInfo(textpage, index, None, 0, None)
        require(length <= 1024, "font_name_size_limit")
        buffer = ctypes.create_string_buffer(max(1, length))
        if length:
            raw.FPDFText_GetFontInfo(textpage, index, buffer, length, None)
        name = buffer.value.decode("utf-8", "strict")
        codepoint = int(raw.FPDFText_GetUnicode(textpage, index))
        generated = raw.FPDFText_IsGenerated(textpage, index)
        require(0 <= codepoint <= 0x10FFFF and generated in (0, 1), "character_evidence_unavailable")
        bounds = tuple(float(n) for n in textpage.get_charbox(index))
        result.append({"codepoint": codepoint, "font": name, "size": float(raw.FPDFText_GetFontSize(textpage, index)), "origin": (origin_x.value, origin_y.value), "matrix": tuple(float(getattr(matrix, key)) for key in ("a", "b", "c", "d", "e", "f")), "box": bounds, "generated": bool(generated)})
    return result


def max_delta(left: Any, right: Any) -> float:
    require(len(left) == len(right), "geometry_shape_mismatch")
    values = [abs(a - b) for a, b in zip(left, right)]
    require(all(math.isfinite(value) for value in values), "invalid_character_geometry")
    return max(values, default=0)


def words(chars: list[dict[str, Any]]) -> list[tuple[float, float, float, float]]:
    result, group = [], []
    def flush() -> None:
        if group:
            result.append((min(c["box"][0] for c in group), min(c["box"][1] for c in group), max(c["box"][2] for c in group), max(c["box"][3] for c in group)))
            group.clear()
    for char in chars:
        if char["generated"] or chr(char["codepoint"]).isspace():
            flush()
        else:
            group.append(char)
    flush()
    return result


def overlap(left: tuple[float, ...], right: tuple[float, ...]) -> bool:
    return min(left[2], right[2]) - max(left[0], right[0]) > ORIGIN_TOLERANCE_PT and min(left[3], right[3]) - max(left[1], right[1]) > ORIGIN_TOLERANCE_PT


def verify_word_collisions(before: list[tuple[float, ...]], after: list[tuple[float, ...]]) -> None:
    active: list[int] = []
    comparisons = 0
    for index in sorted(range(len(after)), key=lambda i: after[i][0]):
        active = [other for other in active if after[other][2] > after[index][0]]
        for other in active:
            comparisons += 1
            require(comparisons <= 2_000_000, "word_collision_check_limit")
            require(not overlap(after[index], after[other]) or overlap(before[index], before[other]), "font_change_introduced_word_collision")
        active.append(index)


def verify_advance_cell(before: dict[str, Any], after: dict[str, Any]) -> float:
    from reportlab.pdfbase import pdfmetrics
    # This first font-repair subset is horizontal text. Unsupported transforms
    # must be inspected explicitly instead of using an incorrect axis-aligned cell.
    require(max_delta(before["matrix"][:4], (1.0, 0.0, 0.0, 1.0)) <= 0.00001, "transformed_font_layout_unsupported")
    advance = pdfmetrics.stringWidth(chr(before["codepoint"]), before["font"], before["size"])
    # A small sidebearing overhang is distinct from changing the glyph advance.
    # The fixed advance is verified in the font program; collision checks below
    # prevent a new overhang from covering a neighboring word.
    padding = max(ORIGIN_TOLERANCE_PT, before["size"] * ADVANCE_CELL_OVERHANG_EM)
    left = min(before["origin"][0], before["box"][0])
    right = max(before["origin"][0] + advance, before["box"][2])
    overhang = max(0.0, left - after["box"][0], after["box"][2] - right)
    require(overhang <= padding, "font_glyph_exceeds_original_advance_cell")
    return overhang


def box_mask(mask: np.ndarray, box: tuple[float, ...], page_height: float, scale: float) -> None:
    x0, y0, x1, y1 = box
    # One pixel accounts for antialiasing along an authorized glyph edge.
    left, right = max(0, math.floor(x0 * scale) - 1), min(mask.shape[1], math.ceil(x1 * scale) + 1)
    top, bottom = max(0, math.floor((page_height - y1) * scale) - 1), min(mask.shape[0], math.ceil((page_height - y0) * scale) + 1)
    if right > left and bottom > top:
        mask[top:bottom, left:right] = True


def verify_rendered_layout(source: Path, output: Path, allowed_names: dict[int, dict[str, str]]) -> list[dict[str, Any]]:
    results = []
    documents = [pdfium.PdfDocument(source), pdfium.PdfDocument(output)]
    try:
        for number in range(len(documents[0])):
            pages = [document[number] for document in documents]
            textpages = []
            bitmaps = []
            try:
                dimensions = [page.get_size() for page in pages]
                require(dimensions[0] == dimensions[1], "rendered_page_dimensions_changed")
                require(all(page.get_rotation() == 0 for page in pages), "rotated_font_layout_unsupported")
                require(all(tuple(page.get_cropbox()[:2]) == (0.0, 0.0) for page in pages), "offset_page_font_layout_unsupported")
                width, height = dimensions[0]
                require(math.ceil(width * v.RENDER_SCALE) * math.ceil(height * v.RENDER_SCALE) <= v.MAX_PAGE_PIXELS, "render_pixel_limit")
                textpages = [page.get_textpage() for page in pages]
                chars = [char_inventory(tp) for tp in textpages]
                require(len(chars[0]) == len(chars[1]), "rendered_character_count_changed")
                bitmaps = [page.render(scale=v.RENDER_SCALE) for page in pages]
                pixels = [np.asarray(bitmap.to_pil().convert("RGB")) for bitmap in bitmaps]
                require(pixels[0].shape == pixels[1].shape, "rendered_page_dimensions_changed")
                authorized = np.zeros(pixels[0].shape[:2], dtype=bool)
                names = allowed_names.get(number + 1, {})
                max_origin = max_box = max_overhang = 0.0
                changed_characters = 0
                for left, right in zip(chars[0], chars[1]):
                    require(left["codepoint"] == right["codepoint"] and left["generated"] == right["generated"], "rendered_unicode_or_reading_order_changed")
                    delta = max_delta(left["origin"], right["origin"])
                    max_origin = max(max_origin, delta)
                    require(delta <= ORIGIN_TOLERANCE_PT and max_delta(left["matrix"], right["matrix"]) <= ORIGIN_TOLERANCE_PT and abs(left["size"] - right["size"]) <= ORIGIN_TOLERANCE_PT, "rendered_character_placement_changed")
                    authorized_font = left["font"] in names and right["font"] == names[left["font"]]
                    tolerance = max(GLYPH_BOX_TOLERANCE_PT, left["size"] * GLYPH_BOX_TOLERANCE_EM) if authorized_font else ORIGIN_TOLERANCE_PT
                    box_delta = max_delta(left["box"], right["box"])
                    max_box = max(max_box, box_delta)
                    require(box_delta <= tolerance, "rendered_glyph_bounds_changed")
                    if authorized_font:
                        changed_characters += 1
                        old_inside = left["box"][0] >= 0 and left["box"][1] >= 0 and left["box"][2] <= width and left["box"][3] <= height
                        new_inside = right["box"][0] >= 0 and right["box"][1] >= 0 and right["box"][2] <= width and right["box"][3] <= height
                        require(not old_inside or new_inside, "font_change_introduced_page_clipping")
                        if not left["generated"] and not chr(left["codepoint"]).isspace():
                            max_overhang = max(max_overhang, verify_advance_cell(left, right))
                            box_mask(authorized, left["box"], height, v.RENDER_SCALE)
                            box_mask(authorized, right["box"], height, v.RENDER_SCALE)
                    else:
                        require(left["font"] == right["font"], "unlisted_rendered_font_change")
                left_words, right_words = words(chars[0]), words(chars[1])
                require(len(left_words) == len(right_words), "rendered_word_count_changed")
                max_word_delta = max((max_delta(a, b) for a, b in zip(left_words, right_words)), default=0)
                # Character-wise bounds constrain each word even on mixed-size lines.
                require(max_word_delta <= max_box + 0.0001, "rendered_word_layout_changed")
                verify_word_collisions(left_words, right_words)
                changed = np.any(pixels[0] != pixels[1], axis=2)
                outside = int(np.count_nonzero(changed & ~authorized))
                require(outside == 0, "pixels_changed_outside_authorized_glyphs")
                results.append({"pageNumber": number + 1, "characterCount": len(chars[0]), "wordCount": len(left_words), "authorizedFontCharacters": changed_characters, "unicodeAndReadingOrderIdentical": True, "maxCharacterOriginDeltaPt": round(max_origin, 6), "maxGlyphBoxEdgeDeltaPt": round(max_box, 6), "maxWordBoxEdgeDeltaPt": round(max_word_delta, 6), "maxAdditionalGlyphOverhangPt": round(max_overhang, 6), "changedPixels": int(np.count_nonzero(changed)), "changedPixelsOutsideAuthorizedGlyphs": outside, "pageEdgeClippingIntroduced": False, "newWordCollisions": False, "glyphsWithinAdvanceCellsWithBoundedOverhang": True})
            finally:
                for value in bitmaps + textpages + pages:
                    value.close()
    finally:
        for document in documents:
            document.close()
    return results


def compare_with_authorized_fonts(source: Path, output: Path, manifest: dict[str, Any]) -> dict[str, Any]:
    try:
        initial_hashes = (sha_file(source), sha_file(output))
    except (OSError, v.InspectionError):
        initial_hashes = None
    report = v.compare_pdfs(source, output)
    report["font_validation"] = {"passed": False, "checksComplete": False, "optIn": True, "fontAppearanceMayDiffer": True, "limits": {"characterOriginTolerancePt": ORIGIN_TOLERANCE_PT, "glyphBoxEdgeTolerancePt": GLYPH_BOX_TOLERANCE_PT, "glyphBoxEdgeToleranceEm": GLYPH_BOX_TOLERANCE_EM, "advanceCellOverhangToleranceEm": ADVANCE_CELL_OVERHANG_EM}, "findings": []}
    evidence = report["font_validation"]
    try:
        require(not report.get("inspection_incomplete"), "strict_inspection_incomplete")
        require(initial_hashes is not None and initial_hashes == (manifest.get("sourceSha256"), manifest.get("candidateSha256")), "font_manifest_file_binding_mismatch")
        before, normalized_after, ledger, names = authorize_fonts(source, output, manifest)
        unchanged = verify_other_content(before, normalized_after)
        layout = verify_rendered_layout(source, output, names)
        require(initial_hashes == (sha_file(source), sha_file(output)), "input_changed_during_font_validation")
        evidence.update({"passed": True, "checksComplete": True, "substitutions": ledger, "preservedContent": unchanged, "pages": layout, "sourceSha256": manifest["sourceSha256"], "candidateSha256": manifest["candidateSha256"]})
        allowed = []
        retained = []
        for finding in report["findings"]:
            (allowed if finding["code"] in FONT_CHANGE_FINDINGS else retained).append(finding)
        report["findings"] = retained
        evidence["strictFindingsExplainedByAuthorizedFonts"] = allowed
        report["figure_associations"] = unchanged["figureAssociations"]
        nonfigure_alts = any("alt" in tag and tag["role"] != "Figure" for tag in report["source_structure"]["tags"])
        report["structure"]["authored_alternative_associations_verified"] = not nonfigure_alts
        report["preservation"]["authorized_font_changes_verified"] = True
        report["preservation"]["passed"] = not retained
        report["mechanical_checks_passed"] = report["preservation"]["passed"] and report["structure"].get("passed", False)
        report["passed"] = report["mechanical_checks_passed"] and report["structure"].get("checks_complete", False) and not report["structure"].get("findings") and report["structure"]["authored_alternative_associations_verified"]
    except v.InspectionError as error:
        evidence["findings"].append({"code": str(error), "severity": "error"})
        report["passed"] = report["mechanical_checks_passed"] = False
        report["preservation"]["passed"] = False
    except Exception:
        evidence["findings"].append({"code": "font_validation_failed", "severity": "error"})
        report["passed"] = report["mechanical_checks_passed"] = False
        report["preservation"]["passed"] = False
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--report", type=Path, required=True)
    args = parser.parse_args()
    logging.getLogger("pypdf").setLevel(logging.CRITICAL)
    try:
        require(args.manifest.is_file() and args.manifest.stat().st_size <= MAX_MANIFEST_BYTES, "font_manifest_missing_or_too_large")
        manifest = json.loads(args.manifest.read_text(encoding="utf-8-sig"))
        require(isinstance(manifest, dict), "font_manifest_invalid")
        report = compare_with_authorized_fonts(args.source, args.output, manifest)
        payload = json.dumps(report, indent=2, ensure_ascii=True)
        require(len(payload.encode()) <= v.MAX_REPORT_BYTES, "report_size_limit")
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(payload + "\n", encoding="utf-8")
        print(json.dumps({"passed": report["passed"], "fontValidationPassed": report["font_validation"]["passed"], "findingCodes": [f["code"] for f in report["font_validation"]["findings"]], "reportWritten": True}))
        return 0 if report["passed"] else 1
    except Exception as error:
        print(json.dumps({"passed": False, "findingCodes": [str(error) if isinstance(error, v.InspectionError) else "font_validation_failed"]}))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
