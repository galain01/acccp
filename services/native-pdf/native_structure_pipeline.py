"""Compose source-bound structural repairs without trusting model geometry.

Every discovery phase shares a fresh inspection of one immutable reader. Node
maps refer to the original clone throughout: edits may change preorder tag IDs.
"""
import bounded_semantic_structure as semantic
import bounded_table_structure as tables
import bounded_reading_order as reading
import bounded_chart_structure as charts


MODULES = (tables, reading, charts)
KINDS = {'rebuild_table': tables, 'move_callout': reading,
         'move_page_continuation': reading, 'describe_chart': charts}


def _inspection_for(reader, inspection):
    if inspection is not None and type(inspection) is not semantic._DiscoveryInspection:
        semantic.fail()
    result = inspection if inspection is not None else semantic._DiscoveryInspection(reader)
    result.copy_for(reader)
    return result


def _participants(candidate):
    return {candidate['tagId'], *candidate['relatedTagIds']} - set(candidate.get('readonlyTagIds', []))


def discover_candidates(reader, *, _inspection=None):
    inspection = _inspection_for(reader, _inspection)
    native = [candidate for module in MODULES
              for candidate in module.discover_candidates(reader, _inspection=inspection)]
    participants = set().union(*(_participants(item) for item in native)) if native else set()
    # A chart axis or table label must not also be offered as an unrelated list
    # or heading split. The atomic operation owns its internal relationships.
    ordinary = [candidate for candidate in semantic.discover_candidates(reader, _inspection=inspection)
                if not (_participants(candidate) & participants)]
    combined = ordinary + native
    if len(combined) > 500 or len({item['candidateId'] for item in combined}) != len(combined):
        raise semantic.SemanticStructureError('pdf_complexity_limit')
    return combined


class _SavedProof:
    __slots__ = ('parts',)

    def __init__(self, parts):
        self.parts = parts


def apply_operations(source_reader, writer, operations):
    if not isinstance(operations, list) or len(operations) > 500:
        semantic.fail()
    # Recompute from source bytes, independently of a previously published
    # inventory or model-supplied candidate list.
    inspection = semantic._DiscoveryInspection(source_reader)
    options = {item['candidateId']: item for item in discover_candidates(source_reader, _inspection=inspection)}
    original, targets = semantic.nodes(source_reader), semantic.nodes(writer)
    if len(original) != len(targets):
        semantic.fail()
    source_nodes = {f'tag-{i + 1}': node for i, node in enumerate(original)}
    target_nodes = {f'tag-{i + 1}': node for i, node in enumerate(targets)}
    grouped = {module: [] for module in (semantic, *MODULES)}
    used, shared_notes = set(), set()
    for operation in operations:
        if not isinstance(operation, dict) or not isinstance(operation.get('candidateId'), str):
            semantic.fail()
        candidate = options.get(operation['candidateId'])
        if candidate is None or operation.get('tagId') != candidate['tagId']:
            semantic.fail()
        participants = _participants(candidate)
        note = candidate['relatedTagIds'][0] if candidate['kind'] == 'mark_note_reference' else None
        if (participants & used) - ({note} if note in shared_notes else set()):
            semantic.fail()
        used |= participants
        if note:
            shared_notes.add(note)
        grouped[KINDS.get(candidate['kind'], semantic)].append(operation)
    lineage = {id(node): {'node': node, 'sourceTagId': identifier} for identifier, node in target_nodes.items()}
    changes, proofs = [], []
    for module in (semantic, *MODULES):
        if not grouped[module]:
            continue
        kwargs = {'_inspection': inspection}
        if module is not semantic:
            kwargs.update(_source_nodes=source_nodes, _target_nodes=target_nodes)
        if module is reading:
            kwargs['_prior_verifications'] = tuple(proofs)
        result = module.apply_operations(source_reader, writer, grouped[module], **kwargs)
        changes.extend(result['changes'])
        for entry in result['lineage']:
            key = id(entry['node'])
            if key in lineage and lineage[key]['sourceTagId'] != entry['sourceTagId']:
                semantic.fail()
            if entry['sourceTagId'] not in source_nodes:
                semantic.fail()
            lineage[key] = entry
        if 'verification' in result:
            proofs.append((module, result['verification']))
    # Every original node must survive, even when reparented into a new table,
    # figure or uninterrupted paragraph.
    final_nodes = {id(node) for node in semantic.nodes(writer)}
    if any(id(node) not in final_nodes for node in targets) or set(lineage) != final_nodes:
        semantic.fail()
    return {'changes': changes, 'lineage': list(lineage.values()), 'verification': _SavedProof(proofs)}


def verify_saved(reader, verification, *, _inspection=None):
    if type(verification) is not _SavedProof:
        semantic.fail()
    inspection = _inspection_for(reader, _inspection)
    for module, proof in verification.parts:
        module.verify_saved(reader, proof, _inspection=inspection)
