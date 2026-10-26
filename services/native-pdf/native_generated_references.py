"""Remove only nonexistent Link references created when tagging untagged input.

This is preparation cleanup, never a waiver for missing authored content. The
private proof retains the complete generated input so saved verification can
independently rederive the exact allowed delta and compare all native structure.
"""
from __future__ import annotations
import io
from pypdf import PdfReader, PdfWriter
from pypdf.generic import ArrayObject, DictionaryObject, NameObject as N, NullObject
import bounded_semantic_structure as b
import verify_pdf as v

MAX_REPAIRS = 50


def _require(value):
    if not value:
        raise v.InspectionError('generated_link_reference_unverified')


def _bytes(writer):
    stream = io.BytesIO()
    writer.write(stream)
    return stream.getvalue()


def _page_mcids(page):
    """Independently inspect all page marked scopes and points, including artifacts."""
    properties = v.resolved(v.resolved(page.get('/Resources', {})).get('/Properties', {}))
    result = set()
    for args, op in v.operations(page):
        if op not in (b'BDC', b'DP'):
            continue
        if len(args) != 2:
            return None
        values = v.resolved(args[1])
        if isinstance(values, N):
            values = v.resolved(properties.get(values)) if isinstance(properties, dict) else None
        if not isinstance(values, dict):
            return None
        if '/MCID' in values:
            mcid = v.integer(values['/MCID'])
            if mcid is None:
                return None
            result.add(mcid)
    return result


def _candidates(original, generated):
    if '/StructTreeRoot' in original.trailer['/Root']:
        return []
    if not v.compare_annotations(original, generated)['passed']:
        return []
    inventory = v.structure_inventory(generated)
    tags = {tag['id']: tag for tag in inventory['tags']}
    nodes = {f'tag-{index + 1}': node for index, node in enumerate(b.nodes(generated))}
    root = v.resolved(generated.trailer['/Root'].get('/StructTreeRoot'))
    if not isinstance(root, dict):
        return []
    parents = v.number_tree(root.get('/ParentTree'))
    navigation = {record['annotationId']: record for record in v.navigation_inventory(generated)['annotations']}
    found = []; page_ids = {}
    for identifier, tag in tags.items():
        sequence = tag.get('contentSequence', [])
        if tag['role'] != 'Link' or tag['sourceRole'] != 'Link' or len(sequence) != 2:
            continue
        refs = [item for item in sequence if item.get('kind') == 'objectReference']
        missing = [item for item in sequence if item.get('kind') == 'markedContent' and item.get('resolved') is False]
        if len(refs) != 1 or len(missing) != 1:
            continue
        reference, absent = refs[0], missing[0]
        page_number, mcid = absent.get('pageNumber'), absent.get('mcid')
        if (not reference.get('resolved') or not reference.get('parentTreeVerified')
                or not absent.get('parentTreeVerified') or 'streamId' in absent
                or reference.get('pageNumber') != page_number or type(page_number) is not int
                or type(mcid) is not int or not 0 <= mcid <= 100000):
            continue
        record = navigation.get(reference.get('annotationId'), {})
        if not record.get('navigationInspected') or reference.get('actionType') != 'URI':
            continue
        page = generated.pages[page_number - 1]
        index = reference['annotationIndex']
        annotation = v.resolved(page['/Annots'][index - 1])
        label = v.resolved(annotation.get('/Contents'))
        if (not isinstance(label, (str, bytes)) or not str(label).strip() or len(label) > 8000
                or any(key in annotation for key in ('/Alt', '/ActualText', '/E'))):
            continue
        original_annotation = v.resolved(original.pages[page_number - 1]['/Annots'][index - 1])
        original_action = v.resolved(original_annotation.get('/A'))
        source_label = (original_annotation.get('/Contents') if '/Contents' in original_annotation else
                        original_action.get('/URI') if isinstance(original_action, dict) else None)
        if label != source_label:
            continue
        copied_alt = ('/Alt' in nodes[identifier] and nodes[identifier]['/Alt'] == source_label
                      and not any(key in original_annotation for key in ('/Alt', '/ActualText', '/E')))
        current = identifier; seen = set(); protected = False
        while current in tags and current not in seen:
            seen.add(current)
            protected |= any(key in nodes[current] for key in ('/ActualText', '/E'))
            protected |= '/Alt' in nodes[current] and not (current == identifier and copied_alt)
            current = tags[current].get('parentId')
        if protected or current in seen:
            continue
        node = nodes[identifier]
        children = b._children(node)
        if (len(children) != 2 or sum(v.integer(child) == mcid for child in children) != 1
                or sum(isinstance(v.resolved(child), dict) and v.resolved(child).get('/Type') == '/OBJR' for child in children) != 1):
            continue
        if page_number not in page_ids:
            page_ids[page_number] = _page_mcids(page)
        if page_ids[page_number] is None or mcid in page_ids[page_number]:
            continue
        contexts = [item for other in tags.values() for item in other.get('contentSequence', [])
                    if item.get('kind') == 'markedContent' and item.get('pageNumber') == page_number
                    and item.get('mcid') == mcid and 'streamId' not in item]
        if len(contexts) != 1:
            continue
        array = parents.get(v.integer(page.get('/StructParents')))
        if not isinstance(array, ArrayObject) or mcid >= len(array) or v.resolved(array[mcid]) is not node:
            continue
        found.append({'tagId': identifier, 'pageNumber': page_number, 'annotationIndex': index, 'mcid': mcid})
        if len(found) >= MAX_REPAIRS:
            break
    return found


def _apply(writer, changes):
    nodes = {f'tag-{index + 1}': node for index, node in enumerate(b.nodes(writer))}
    parents = v.number_tree(writer.root_object['/StructTreeRoot'].get('/ParentTree'))
    for change in changes:
        node = nodes[change['tagId']]
        page = writer.pages[change['pageNumber'] - 1]
        array = parents[v.integer(page.get('/StructParents'))]
        _require(v.resolved(array[change['mcid']]) is node)
        node[N('/K')] = ArrayObject([child for child in b._children(node) if v.integer(child) != change['mcid']])
        array[change['mcid']] = NullObject()


class _GeneratedReferenceProof:
    __slots__ = ('source_hash', 'generated_bytes', 'changes')
    def __init__(self, original, generated_bytes, changes):
        self.source_hash = b.source_digest(original)
        self.generated_bytes = generated_bytes
        self.changes = tuple(tuple(sorted(change.items())) for change in changes)


def repair_generated_link_references(original, writer):
    if '/StructTreeRoot' in original.trailer['/Root']:
        return {'changes': [], 'verification': None}
    before = _bytes(writer)
    generated = PdfReader(io.BytesIO(before), strict=True)
    changes = _candidates(original, generated)
    if not changes:
        return {'changes': [], 'verification': None}
    proof = _GeneratedReferenceProof(original, before, changes)
    _apply(writer, changes)
    return {'changes': [{**change, 'code': 'generated_missing_link_reference_removed',
                        'message': 'Removed a nonexistent content reference added during automatic tagging; the original link and visible content were kept.'}
                       for change in changes], 'verification': proof}


def verify_generated_link_references(original, reopened, verification):
    _require(type(verification) is _GeneratedReferenceProof and verification.source_hash == b.source_digest(original))
    generated = PdfReader(io.BytesIO(verification.generated_bytes), strict=True)
    changes = _candidates(original, generated)
    _require(tuple(tuple(sorted(change.items())) for change in changes) == verification.changes)
    expected = PdfWriter(clone_from=generated)
    _apply(expected, changes)
    expected_reader = PdfReader(io.BytesIO(_bytes(expected)), strict=True)
    _require(len(reopened.pages) == len(expected_reader.pages))
    old_canonical, new_canonical = v.Canonicalizer(list(expected_reader.pages)), v.Canonicalizer(list(reopened.pages))
    _require(old_canonical.hash(expected_reader.trailer['/Root']['/StructTreeRoot']) ==
             new_canonical.hash(reopened.trailer['/Root']['/StructTreeRoot']))
    _require(v.Canonicalizer(list(expected_reader.pages)).hash(expected_reader.trailer['/Root']) ==
             v.Canonicalizer(list(reopened.pages)).hash(reopened.trailer['/Root']))
    _require(v.Canonicalizer().hash(dict(expected_reader.metadata or {})) ==
             v.Canonicalizer().hash(dict(reopened.metadata or {})))
    _require(v.compare_annotations(generated, reopened)['passed'])
    _require([item['stateSha256'] for item in v.navigation_inventory(generated)['annotations']] ==
             [item['stateSha256'] for item in v.navigation_inventory(reopened)['annotations']])
    for old, new in zip(generated.pages, reopened.pages):
        old_canonical, new_canonical = v.Canonicalizer(list(generated.pages)), v.Canonicalizer(list(reopened.pages))
        old_values = {key: value for key, value in old.items() if key not in ('/Parent', '/Contents', '/Resources')}
        new_values = {key: value for key, value in new.items() if key not in ('/Parent', '/Contents', '/Resources')}
        _require(old_canonical.hash(old_values) == new_canonical.hash(new_values))
        _require(v.drawing_fingerprint(v.operations(old), old_canonical) == v.drawing_fingerprint(v.operations(new), new_canonical))
        _require(old_canonical.hash(old.get('/Resources', {})) == new_canonical.hash(new.get('/Resources', {})))
    inventory = v.structure_inventory(reopened)
    tags = {tag['id']: tag for tag in inventory['tags']}
    for change in changes:
        tag = tags[change['tagId']]
        sequence = tag.get('contentSequence', [])
        _require(tag['role'] == 'Link' and len(sequence) == 1 and sequence[0].get('kind') == 'objectReference'
                 and sequence[0].get('resolved') and sequence[0].get('parentTreeVerified')
                 and sequence[0].get('pageNumber') == change['pageNumber']
                 and sequence[0].get('annotationIndex') == change['annotationIndex'])
    return True
