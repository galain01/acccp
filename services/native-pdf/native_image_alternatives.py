"""Authorize exact generic Figure-label replacements on their original paint.

The app retains the immutable source. Useful authored descriptions, authored
replacement text, ambiguous owners and unverified paint are never authorized.
The private proof is created only from original bytes and an exact repair plan;
the saved-file checker independently revalidates every association and value.
"""
from dataclasses import dataclass
import hashlib
import re

import verify_pdf as v

PLACEHOLDER = re.compile(r"\s*(?:image\s*\d*|figure\s*\d*|formula|annotation)\s*", re.I)
MAX_REPLACEMENTS = 500


class AlternativeReplacementError(Exception):
    pass


def require(condition):
    if not condition:
        raise AlternativeReplacementError("native_pdf_preservation")


def placeholder_alt(value):
    return isinstance(value, str) and (not value.strip() or bool(PLACEHOLDER.fullmatch(value)))


def _bytes(reader):
    position = reader.stream.tell()
    try:
        reader.stream.seek(0)
        data = reader.stream.read(v.MAX_FILE_BYTES + 1)
    finally:
        reader.stream.seek(position)
    require(0 < len(data) <= v.MAX_FILE_BYTES)
    return data


def _snapshot(tag):
    return {key: tag.get(key) for key in ("role", "pageNumber", "text", "mcids", "alt")}


def _keys(tag):
    return tuple((item.get("pageNumber"), item.get("mcid")) for item in tag.get("content", []))


def _figure_keys(figure):
    return tuple((item.get("pageNumber"), item.get("mcid")) for item in figure["contentKeys"])


def _ancestry_clear(tag, tags):
    parent = tag.get("parentId")
    seen = {tag["id"]}
    for _ in range(128):
        if parent is None:
            return True
        if parent in seen or parent not in tags:
            return False
        seen.add(parent)
        ancestor = tags[parent]
        if "alt" in ancestor or "actualText" in ancestor:
            return False
        parent = ancestor.get("parentId")
    return False


def _native_leaf(tag, tags):
    if (tag.get("role") != "Figure" or tag.get("sourceRole") != "Figure"
            or "actualText" in tag
            or any(child.get("parentId") == tag["id"] for child in tags.values())):
        return False
    parts = tag.get("contentSequence", [])
    return bool(parts) and all(part.get("kind") == "markedContent" and part.get("resolved")
                               and part.get("parentTreeVerified") for part in parts) and _ancestry_clear(tag, tags)


def _eligible(tag, tags):
    return placeholder_alt(tag.get("alt", "")) and _native_leaf(tag, tags)


def _valid_replacement(value):
    return (isinstance(value, str) and 1 <= len(value.strip()) <= 8000
            and not placeholder_alt(value)
            and not any(ord(char) < 32 and char not in "\n\t" for char in value))


@dataclass(frozen=True, slots=True)
class _Replacement:
    source_figure_id: str
    membership_hash: str
    old_alt: str
    new_alt: str
    description_language: str | None


@dataclass(frozen=True, slots=True)
class ApprovedFigureAlternatives:
    source_sha256: str
    replacements: tuple[_Replacement, ...]


def approve_replacements(original, candidate, operations):
    """Mint a source-bound exception for validated set_alt operations only.

    Generated Figures on untagged sources need no authored-description exception.
    The normal validator still verifies their saved descriptions and page paint.
    """
    require(isinstance(operations, list) and len(operations) <= MAX_REPLACEMENTS
            and all(isinstance(operation, dict) for operation in operations))
    selected = [operation for operation in operations if operation.get("type") == "set_alt"]
    if not selected:
        return None
    source_figures = v.figure_association_inventory(original)["figures"]
    if not any("alt" in figure for figure in source_figures):
        # An absent source alternative is not an authored string to replace.
        # No waiver is needed or issued; ordinary paint, ownership, ActualText
        # and saved-output checks still apply to every added description.
        return None
    before_tags = {tag["id"]: tag for tag in v.structure_inventory(original)["tags"]}
    tags = {tag["id"]: tag for tag in v.structure_inventory(candidate)["tags"]}
    candidate_figures = v.figure_association_inventory(candidate)["figures"]
    replacements, used = [], set()
    for operation in selected:
        require(isinstance(operation, dict) and set(operation) == {"type", "tagId", "expected", "alt"})
        tag = tags.get(operation.get("tagId"))
        require(tag is not None and _eligible(tag, tags) and operation.get("expected") == _snapshot(tag))
        value = operation.get("alt")
        require(_valid_replacement(value))
        candidates = [figure for figure in candidate_figures if _figure_keys(figure) == _keys(tag)]
        require(len(candidates) == 1 and candidates[0]["supported"] and candidates[0]["membershipHash"] is not None)
        current = candidates[0]
        originals = [figure for figure in source_figures if figure["membershipHash"] == current["membershipHash"]]
        if not originals:
            # No original Figure owns this painting; no authored Alt can be
            # waived. The unchanged baseline comparison remains authoritative.
            continue
        require(len(originals) == 1)
        previous = originals[0]
        if "alt" not in previous:
            continue
        original_tags = [item for item in before_tags.values() if _keys(item) == _figure_keys(previous)]
        require(len(original_tags) == 1 and _eligible(original_tags[0], before_tags)
                and placeholder_alt(previous["alt"]) and "actualText" not in previous
                and current.get("alt") == previous["alt"] and "actualText" not in current
                and current.get("descriptionLanguage") == previous.get("descriptionLanguage")
                and previous["id"] not in used)
        used.add(previous["id"])
        replacements.append(_Replacement(previous["id"], previous["membershipHash"], previous["alt"],
                                         value.strip(), previous.get("descriptionLanguage")))
    return ApprovedFigureAlternatives(hashlib.sha256(_bytes(original)).hexdigest(), tuple(replacements)) if replacements else None


def verify_replacements(proof, original, output):
    """Recheck a private approval against exact source bytes and saved output."""
    require(type(proof) is ApprovedFigureAlternatives and type(proof.replacements) is tuple
            and 1 <= len(proof.replacements) <= MAX_REPLACEMENTS
            and proof.source_sha256 == hashlib.sha256(_bytes(original)).hexdigest())
    before = v.figure_association_inventory(original)["figures"]
    after = v.figure_association_inventory(output)["figures"]
    source_tags = {tag["id"]: tag for tag in v.structure_inventory(original)["tags"]}
    output_tags = {tag["id"]: tag for tag in v.structure_inventory(output)["tags"]}
    approved, used_output = {}, set()
    for item in proof.replacements:
        require(type(item) is _Replacement and item.source_figure_id not in approved
                and placeholder_alt(item.old_alt) and _valid_replacement(item.new_alt))
        sources = [figure for figure in before if figure["id"] == item.source_figure_id
                   and figure["membershipHash"] == item.membership_hash]
        destinations = [figure for figure in after if figure["membershipHash"] == item.membership_hash]
        require(len(sources) == len(destinations) == 1)
        source, destination = sources[0], destinations[0]
        originals = [tag for tag in source_tags.values() if _keys(tag) == _figure_keys(source)]
        tagged = [tag for tag in output_tags.values() if tag.get("role") == "Figure"
                  and _keys(tag) == _figure_keys(destination)]
        require(source["supported"] and destination["supported"]
                and source.get("alt") == item.old_alt and destination.get("alt") == item.new_alt
                and "actualText" not in source and "actualText" not in destination
                and source.get("descriptionLanguage") == item.description_language
                and (item.description_language is None or destination.get("descriptionLanguage") == item.description_language)
                and len(originals) == 1 and _eligible(originals[0], source_tags)
                and len(tagged) == 1 and _native_leaf(tagged[0], output_tags)
                and destination["id"] not in used_output)
        used_output.add(destination["id"])
        approved[item.source_figure_id] = {"membershipHash": item.membership_hash,
                                         "beforeAlt": item.old_alt, "afterAlt": item.new_alt}
    return approved
