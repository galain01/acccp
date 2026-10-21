"""Replace proven-generated Link placeholders with unchanged native link text.

This local experiment does not invent link purposes or repair destinations.
Only the exact OpenDataLoader fallback 'Annotation' is eligible. Authored
descriptions, link geometry, actions, reading order and painting stay intact.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re

from pypdf import PdfReader
from pypdf.generic import NameObject, TextStringObject
from conformance_repairs import _open, _save
from semantic_repairs import _tag_nodes
from verify_pdf import Canonicalizer, drawing_fingerprint, operations, resolved, structure_inventory


def _label(text):
    if not isinstance(text, str) or len(text) > 20_000:
        return None
    text = re.sub(r"\s+", " ", text).strip()
    if (not 3 <= len(text) <= 2000 or not any(char.isalpha() for char in text)
            or text.casefold().strip(' .:') in {'annotation', 'link', 'here', 'click here', 'read more', 'more', 'image'}
            or any(ord(char) < 32 or char == '\ufffd' or 0xE000 <= ord(char) <= 0xF8FF for char in text)):
        return None
    return text


def _annotations(reader):
    rows = {}
    canonical = Canonicalizer(list(reader.pages))
    for number, page in enumerate(reader.pages, 1):
        for index, ref in enumerate(resolved(page.get('/Annots', [])), 1):
            annotation = resolved(ref)
            if not isinstance(annotation, dict):
                raise ValueError('invalid_annotation')
            if annotation.get('/Subtype') == '/Link':
                # Compare the full behavioral dictionary. /P maps to a page
                # number; generated descriptions and ParentTree keys may differ.
                identity = canonical.hash({key: value for key, value in annotation.items()
                                           if key not in {'/Contents', '/StructParent', '/Alt', '/ActualText'}})
                rows[(number, index)] = (annotation, identity)
    return rows


def _owners(inventory):
    owners = {}
    for tag in inventory['tags']:
        for item in tag.get('contentSequence', []):
            if item.get('kind') == 'objectReference':
                owners.setdefault((item.get('pageNumber'), item.get('annotationIndex')), []).append((tag, item))
    return owners


def repair_generated_link_placeholders(original: Path, candidate: Path, output: Path) -> dict:
    if output.resolve() == original.resolve():
        raise ValueError('new_output_required')
    source, _ = _open(original, output)
    reader, writer = _open(candidate, output)
    if len(source.pages) != len(reader.pages):
        raise ValueError('page_count_changed')
    # Labels must be drawn by the same original page program and resources.
    # Marked-content wrapper changes and identical split text shows are allowed.
    for old, new in zip(source.pages, reader.pages):
        if (drawing_fingerprint(operations(old), Canonicalizer()) != drawing_fingerprint(operations(new), Canonicalizer())
                or Canonicalizer(list(source.pages)).hash(old.get('/Resources', {})) != Canonicalizer(list(reader.pages)).hash(new.get('/Resources', {}))):
            raise ValueError('original_page_content_changed')
    original_inventory, candidate_inventory = structure_inventory(source), structure_inventory(reader)
    old_annotations, new_annotations = _annotations(source), _annotations(reader)
    source_owners = _owners(original_inventory)
    candidate_owners = _owners(candidate_inventory)
    writer_nodes = _tag_nodes(writer)
    if len(writer_nodes) != len(candidate_inventory['tags']):
        raise ValueError('tag_inventory_mismatch')
    changes, unresolved, source_link_issues = [], [], []
    consumed = set()
    for tag in candidate_inventory['tags']:
        if tag.get('role') != 'Link':
            continue
        refs = [item for item in tag.get('contentSequence', []) if item.get('kind') == 'objectReference']
        eligible = tag.get('alt') == 'Annotation' or any(item.get('description') == 'Annotation' for item in refs)
        if not eligible:
            continue
        def leave(code):
            unresolved.append({'code': code, 'tagId': tag['id'], 'pageNumber': tag['pageNumber']})
        if (tag.get('sourceRole') != 'Link' or tag.get('textIncomplete') or len(refs) != 1
                or not all(item.get('resolved') is True and item.get('parentTreeVerified') is True
                           and item.get('kind') in {'objectReference', 'markedContent'}
                           for item in tag.get('contentSequence', []))):
            leave('link_structure_ambiguous'); continue
        ref = refs[0]
        key = (ref.get('pageNumber'), ref.get('annotationIndex'))
        if key in consumed or key not in new_annotations or len(candidate_owners.get(key, [])) != 1:
            leave('link_annotation_ambiguous'); continue
        new_annotation, identity = new_annotations[key]
        matches = [(old_key, annotation) for old_key, (annotation, old_identity) in old_annotations.items()
                   if old_key[0] == key[0] and old_identity == identity]
        if len(matches) != 1:
            leave('source_annotation_identity_unverified'); continue
        old_key, old_annotation = matches[0]
        old_owners = source_owners.get(old_key, [])
        if len(old_owners) != 1:
            leave('source_link_structure_ambiguous'); continue
        old_tag, old_ref = old_owners[0]
        if (old_tag.get('role') != 'Link' or old_tag.get('textIncomplete') or old_ref.get('resolved') is not True
                or old_ref.get('parentTreeVerified') is not True):
            leave('source_link_structure_unverified'); continue
        # Any source-authored description disqualifies generation provenance.
        # If an upstream stage changed it, refuse this candidate instead of
        # writing an output that silently carries the lost description forward.
        authored = {name: old_tag[name] for name in ('alt', 'actualText') if name in old_tag}
        if any(tag.get(name) != value for name, value in authored.items()) or any(
            name in old_annotation and new_annotation.get(name) != old_annotation[name]
            for name in ('/Contents', '/Alt', '/ActualText')):
            raise ValueError('authored_link_description_changed')
        if authored or any(name in old_annotation for name in ('/Contents', '/Alt', '/ActualText')):
            leave('authored_description_preserved'); continue
        label = _label(tag.get('text'))
        source_label = _label(old_tag.get('text'))
        if label is None or source_label is None or label not in source_label:
            leave('native_link_label_missing_or_ambiguous'); continue
        if 'actualText' in tag or any(name in new_annotation for name in ('/Alt', '/ActualText')):
            leave('additional_link_override_requires_review'); continue
        if tag.get('alt') not in (None, 'Annotation') or new_annotation.get('/Contents') not in (None, 'Annotation'):
            leave('nonplaceholder_candidate_description_preserved'); continue
        node = writer_nodes[int(tag['id'][4:]) - 1]
        if node.get('/S') != '/Link':
            raise ValueError('tag_inventory_mismatch')
        saved_annotation = resolved(writer.pages[key[0] - 1]['/Annots'][key[1] - 1])
        fields = []
        if tag.get('alt') == 'Annotation':
            node[NameObject('/Alt')] = TextStringObject(label); fields.append('Alt')
        if new_annotation.get('/Contents') == 'Annotation':
            saved_annotation[NameObject('/Contents')] = TextStringObject(label); fields.append('Contents')
        consumed.add(key)
        action = resolved(old_annotation.get('/A', {}))
        if action.get('/S') == '/GoTo' and isinstance(action.get('/D'), str) and str(action['/D']) not in source.named_destinations:
            source_link_issues.append({'code': 'original_named_destination_unresolved', 'tagId': tag['id'], 'pageNumber': key[0]})
        changes.append({'tagId': tag['id'], 'pageNumber': key[0], 'annotationIndex': key[1],
                        'sourceAnnotationIndex': old_key[1], 'fields': fields, 'before': 'Annotation',
                        'after': label, 'evidence': 'unchanged native label, annotation behavior, geometry and verified structure owners'})
    digest = _save(writer, output)
    return {'experimental': True, 'certification': False, 'requires_revalidation': True,
            'originalSha256': hashlib.sha256(source.stream.getvalue()).hexdigest(),
            'inputSha256': hashlib.sha256(reader.stream.getvalue()).hexdigest(), 'outputSha256': digest,
            'changes': changes, 'unresolved': unresolved, 'sourceLinkIssues': source_link_issues}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('original', type=Path)
    parser.add_argument('candidate', type=Path)
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    print(json.dumps(repair_generated_link_placeholders(args.original, args.candidate, args.output), indent=2))
