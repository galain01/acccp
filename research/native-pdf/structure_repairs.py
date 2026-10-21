"""Bounded, audit-supported changes to native reading order and list structure.

Plans address exact saved tag snapshots. Existing content is moved, never
recreated. All output requires a fresh independent audit and PDF/UA validation.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import re

from pypdf import PdfReader
from pypdf.generic import ArrayObject, DictionaryObject, NameObject, NumberObject

from conformance_repairs import _open, _save
from pdf_safety import resolved
from preserve_figures import parent_entries
from semantic_repairs import _tag_nodes
from verify_pdf import structure_inventory


def snapshot(tag):
    return {key: tag.get(key) for key in
            ('role', 'sourceRole', 'parentId', 'pageNumber', 'text', 'mcids', 'contentSequence')}


def children(node):
    value = resolved(node.get('/K'))
    return list(value) if isinstance(value, ArrayObject) else ([] if value is None else [node.raw_get('/K')])


def apply_structure_plan(source: Path, output: Path, plan: dict, *, audit_report: Path):
    if (not isinstance(plan, dict) or set(plan) != {'schemaVersion', 'inputSha256', 'auditReportSha256', 'snapshots', 'operations'}
            or plan['schemaVersion'] != 1):
        raise ValueError('invalid_structure_plan')
    reader, writer = _open(source, output)
    digest = hashlib.sha256(reader.stream.getvalue()).hexdigest()
    if digest != plan['inputSha256']:
        raise ValueError('candidate_hash_mismatch')
    if not audit_report.is_file() or audit_report.stat().st_size > 2 * 1024 * 1024:
        raise ValueError('bounded_audit_required')
    audit_bytes = audit_report.read_bytes()
    audit = json.loads(audit_bytes)
    if (hashlib.sha256(audit_bytes).hexdigest() != plan['auditReportSha256']
            or audit.get('status') != 'complete' or audit.get('outputSha256') != digest):
        raise ValueError('complete_matching_audit_required')
    inventory = structure_inventory(reader)
    tags = {t['id']: t for t in inventory['tags']}
    native = _tag_nodes(writer)
    if len(native) != len(tags) or any(str(n.get('/S', '')).lstrip('/') != t['sourceRole']
                                    for n, t in zip(native, tags.values())):
        raise ValueError('tag_inventory_mismatch')
    nodes = dict(zip(tags, native))
    if not isinstance(plan['snapshots'], dict) or not 1 <= len(plan['snapshots']) <= 500:
        raise ValueError('snapshot_count_limit')
    for tag_id, expected in plan['snapshots'].items():
        if tag_id not in tags or snapshot(tags[tag_id]) != expected or tag_id not in audit.get('reviewedTagIds', []):
            raise ValueError('tag_snapshot_mismatch')
    operations = plan['operations']
    if not isinstance(operations, list) or not 1 <= len(operations) <= 100:
        raise ValueError('operation_limit')
    changed = []
    def target(tag_id):
        if tag_id not in plan['snapshots']:
            raise ValueError('exact_target_snapshot_required')
        return nodes[tag_id], tags[tag_id]
    def new(role, parent, kids):
        node = DictionaryObject({NameObject('/Type'): NameObject('/StructElem'),
            NameObject('/S'): NameObject('/' + role), NameObject('/P'): parent.indirect_reference,
            NameObject('/K'): ArrayObject(kids)})
        writer._add_object(node)
        return node
    for operation in operations:
        if not isinstance(operation, dict):
            raise ValueError('invalid_operation')
        kind = operation.get('kind')
        fields = {'role': {'tagId', 'role'}, 'order': {'tagId', 'order'},
                  'group': {'tagId', 'children'}, 'list': {'tagId', 'items'}}.get(kind)
        if fields is None or set(operation) != fields | {'kind', 'findingCode', 'reason'}:
            raise ValueError('invalid_operation_fields')
        if not isinstance(operation['reason'], str) or not 1 <= len(operation['reason']) <= 1500:
            raise ValueError('bounded_reason_required')
        affected = {operation['tagId'], *operation.get('children', []), *operation.get('items', [])}
        if not any(f.get('code') == operation['findingCode'] and affected.intersection(f.get('tagIds', []))
                   for f in audit.get('findings', [])):
            # Document-wide order changes cite children named by the auditor.
            if kind != 'order' or not any(f.get('code') == operation['findingCode'] and
                    any(tags.get(i, {}).get('parentId') == operation['tagId'] for i in f.get('tagIds', []))
                    for f in audit.get('findings', [])):
                raise ValueError('audit_finding_required')
        node, tag = target(operation['tagId'])
        if kind == 'role':
            if (tag['role'] not in {'P', 'Caption', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6'}
                    or operation['role'] not in {'P', 'Caption', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6'}
                    or tag['role'] != tag['sourceRole'] or not tag.get('text', '').strip()):
                raise ValueError('unsupported_role_change')
            node[NameObject('/S')] = NameObject('/' + operation['role'])
        elif kind == 'order':
            kids = children(node)
            order = operation['order']
            if (tag['role'] not in {'Document', 'Sect', 'Div', 'TOCI', 'P'} or not isinstance(order, list)
                    or any(type(i) is not int for i in order) or sorted(order) != list(range(len(kids)))):
                raise ValueError('exact_permutation_required')
            node[NameObject('/K')] = ArrayObject([kids[i] for i in order])
        elif kind in {'group', 'list'}:
            ids = operation['children' if kind == 'group' else 'items']
            if not isinstance(ids, list) or not 2 <= len(ids) <= 100 or len(ids) != len(set(ids)):
                raise ValueError('bounded_unique_group_required')
            kids = children(node)
            selected = [target(i)[0] for i in ids]
            indexes = [next((j for j, k in enumerate(kids) if resolved(k) is n), -1) for n in selected]
            if (-1 in indexes or indexes != list(range(indexes[0], indexes[0] + len(indexes)))
                    or tag['role'] not in {'Document', 'Sect', 'Div'}):
                raise ValueError('contiguous_children_required')
            group = new('Sect' if kind == 'group' else 'L', node, [])
            if kind == 'group':
                group[NameObject('/K')] = ArrayObject([n.indirect_reference for n in selected])
                for n in selected:
                    n[NameObject('/P')] = group.indirect_reference
            else:
                root = resolved(writer.root_object['/StructTreeRoot'])
                parents = parent_entries(root)
                group[NameObject('/A')] = DictionaryObject({NameObject('/O'): NameObject('/List'), NameObject('/ListNumbering'): NameObject('/Decimal')})
                for number, (tag_id, paragraph) in enumerate(zip(ids, selected), 1):
                    item_tag = tags[tag_id]
                    seq = item_tag['contentSequence']
                    item_kids = children(paragraph)
                    if (item_tag['role'] != 'P' or paragraph.get('/S') != '/P'
                            or '/ActualText' in paragraph or '/Alt' in paragraph
                            or len(seq) != len(item_kids) or not seq):
                        raise ValueError('unsupported_list_paragraph')
                    labels, label_text = [], ''
                    for i, part in enumerate(seq):
                        if part.get('kind') != 'markedContent' or not part.get('parentTreeVerified'):
                            break
                        text = part.get('text', '')
                        if not text.strip() or re.fullmatch(r'\s*' + str(number) + r'\.\s*', text):
                            labels.append(i); label_text += text
                        else:
                            break
                    if not labels or label_text.strip() != str(number) + '.' or len(labels) == len(item_kids):
                        raise ValueError('separate_exact_number_label_required')
                    li = new('LI', group, [])
                    lbl = new('Lbl', li, [item_kids[i] for i in labels])
                    body = new('LBody', li, [paragraph.indirect_reference])
                    if '/Pg' not in paragraph:
                        raise ValueError('explicit_list_page_required')
                    lbl[NameObject('/Pg')] = paragraph.raw_get('/Pg')
                    for key in ('/Lang',):
                        if key in paragraph:
                            lbl[NameObject(key)] = paragraph.raw_get(key)
                    paragraph[NameObject('/K')] = ArrayObject(item_kids[len(labels):])
                    paragraph[NameObject('/P')] = body.indirect_reference
                    li[NameObject('/K')] = ArrayObject([lbl.indirect_reference, body.indirect_reference])
                    group['/K'].append(li.indirect_reference)
                    for i in labels:
                        part = seq[i]
                        native_label = resolved(item_kids[i])
                        if (part.get('streamId') is not None or
                                isinstance(native_label, DictionaryObject) and '/Stm' in native_label):
                            raise ValueError('form_list_label_unsupported')
                        page = writer.pages[part['pageNumber'] - 1]
                        array = resolved(parents[int(page['/StructParents'])])
                        mcid = part['mcid']
                        if resolved(array[mcid]) is not paragraph:
                            raise ValueError('list_parent_owner_mismatch')
                        array[mcid] = lbl.indirect_reference
            node[NameObject('/K')] = ArrayObject(kids[:indexes[0]] + [group.indirect_reference] + kids[indexes[-1] + 1:])
        changed.append(operation)
    output_digest = _save(writer, output)
    reopened = structure_inventory(PdfReader(output, strict=True))
    # Tag numbering changes, so save a stable before/after lineage for composition.
    final_nodes = _tag_nodes(writer)
    position = {id(n): f'tag-{i + 1}' for i, n in enumerate(final_nodes)}
    return {'experimental': True, 'certification': False, 'requires_revalidation': True,
            'inputSha256': digest, 'outputSha256': output_digest,
            'auditReportSha256': plan['auditReportSha256'], 'operations': changed,
            'lineage': {tag_id: position[id(n)] for tag_id, n in nodes.items()},
            'savedTagCount': len(reopened['tags'])}
