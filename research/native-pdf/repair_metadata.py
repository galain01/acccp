"""Small, evidence-driven native metadata repairs for the local PDF experiment.

Language must be supplied by the caller, never guessed from the OS locale.
Existing language, titles and metadata are retained. No PDF/UA declaration is
added: satisfying a validator by declaring conformance is not remediation.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import re
import sys
from xml.etree import ElementTree
from xml.sax.saxutils import escape

from pypdf import PdfReader, PdfWriter
from pypdf.generic import BooleanObject, DecodedStreamObject, DictionaryObject, NameObject, TextStringObject
from pdf_safety import reject_signed_pdf

MAX_BYTES = 4 * 1024 * 1024


def repair_metadata(source: Path, output: Path, language: str) -> list[str]:
    if not re.fullmatch(r"[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*", language) or len(language) > 35:
        raise ValueError("invalid_language")
    if source.resolve() == output.resolve() or output.exists() or not source.is_file() or source.stat().st_size > MAX_BYTES:
        raise ValueError("new_output_and_bounded_source_required")
    reader = PdfReader(source, strict=True)
    if reader.is_encrypted or not 1 <= len(reader.pages) <= 60:
        raise ValueError("unsupported_source")
    reject_signed_pdf(reader)
    writer = PdfWriter(clone_from=reader)
    root = writer.root_object
    changes: list[str] = []
    existing_language = str(root.get("/Lang", "")).strip()
    if not existing_language:
        root[NameObject("/Lang")] = TextStringObject(language)
        changes.append("Set the previously missing document language from the supplied language.")
    title = str((reader.metadata or {}).get("/Title", "")).strip()
    if title:
        if len(title) > 2000:
            raise ValueError("title_limit")
        preferences = root.get("/ViewerPreferences")
        preferences = preferences.get_object() if preferences is not None else DictionaryObject()
        if not isinstance(preferences, DictionaryObject):
            raise ValueError("invalid_viewer_preferences")
        if str(preferences.get("/DisplayDocTitle")) != "True":
            preferences[NameObject("/DisplayDocTitle")] = BooleanObject(True)
            root[NameObject("/ViewerPreferences")] = preferences
            changes.append("Display the existing document title in the PDF viewer.")
        # Only create absent XMP. Existing metadata can carry other standards,
        # authorship or workflow information that this small repair must retain.
        if root.get("/Metadata") is None:
            metadata = DecodedStreamObject()
            metadata[NameObject("/Type")] = NameObject("/Metadata")
            metadata[NameObject("/Subtype")] = NameObject("/XML")
            xml = ('<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title><rdf:Alt><rdf:li xml:lang="x-default">' + escape(title) + '</rdf:li></rdf:Alt></dc:title><dc:language><rdf:Bag><rdf:li>' + escape(existing_language or language) + '</rdf:li></rdf:Bag></dc:language></rdf:Description></rdf:RDF></x:xmpmeta>')
            # Escaping markup does not make XML 1.0 control characters legal.
            # Validate our bounded generated XML before writing any candidate.
            try:
                ElementTree.fromstring(xml)
            except ElementTree.ParseError as error:
                raise ValueError("invalid_xmp_text") from error
            metadata.set_data(xml.encode("utf-8"))
            root[NameObject("/Metadata")] = writer._add_object(metadata)
            changes.append("Add missing XMP title and language metadata using existing title and supplied language.")
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("xb") as stream:
        writer.write(stream)
    reopened = PdfReader(output, strict=True)
    if str(reopened.trailer["/Root"].get("/Lang", "")) != (existing_language or language):
        raise ValueError("saved_language_mismatch")
    return changes


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--language", required=True)
    options = parser.parse_args()
    changes = repair_metadata(options.source, options.output, options.language)
    print(json.dumps({"experimental": True, "certification": False, "changes": changes}))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        print(json.dumps({"status": "metadata_repair_incomplete", "certification": False}))
        sys.exit(1)
