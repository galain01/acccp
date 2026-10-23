"""Source-bound removal of linked sidebars from interrupted paragraphs.

Candidates require a short linked callout beside body text that resumes below
it. The semantic planner decides whether those two body fragments belong to
one paragraph. The operation changes only structure: the original owners of
every text scope and annotation remain intact underneath a new paragraph.
"""
from __future__ import annotations

import hashlib
import json
import math
import re
import statistics

from pypdf import PdfReader, PdfWriter
from pypdf.generic import ArrayObject, DictionaryObject, NameObject

import bounded_semantic_structure as semantic
import verify_pdf as v

MAX_CANDIDATES = 200
MAX_CALLOUTS = 4
BODY_KEYS = {'/Type', '/S', '/P', '/Pg', '/K', '/Lang'}
CALLOUT_KEYS = BODY_KEYS | {'/Alt'}
UNSAFE_FINDINGS = {'duplicate_mcid', 'invalid_mcid', 'unbalanced_marked_content',
    'nested_mcid_scope_unsupported', 'invalid_marked_content_properties',
    'duplicate_structure_content', 'parent_tree_owner_mismatch'}
_PROOF_TOKEN = object()


class ReadingOrderError(semantic.SemanticStructureError):
    """Controlled diagnostic without document content."""


def fail():
    raise ReadingOrderError('native_pdf_invalid_plan')


def _children(node):
    value = v.resolved(node.get('/K'))
    return list(value) if isinstance(value, ArrayObject) else [] if value is None else [value]


def _text(tag):
    return re.sub(r'\s+', ' ', tag.get('text', '')).strip()


def _matrix(left, right):
    a, b, c, d, e, f = left
    g, h, i, j, k, l = right
    return (a*g+b*i, a*h+b*j, c*g+d*i, c*h+d*j, e*g+f*i+k, e*h+f*j+l)


def _positions(page):
    """Bounded baseline origins, used only to discover a wrap-around pattern.

    No text width or glyph advance is guessed. Horizontal origins on each line
    establish a right-hand body column beside a left-hand callout, followed by
    a full-width continuation. Unhandled text operators make discovery decline.
    """
    ops = v.operations(page)
    # Geometry does not split operators, so a complete BT/ET inside a marked
    # text scope is safe here. The legacy operator-splitting kernel stays strict.
    scopes = semantic._scopes(ops, allow_text_boundaries=True)
    cm = (1., 0., 0., 1., 0., 0.)
    tm = None
    size, leading = 0., 0.
    saved, positions = [], {}
    for index, (args, op) in enumerate(ops):
        if op == b'q':
            saved.append((cm, tm, size, leading))
        elif op == b'Q':
            if not saved:
                return {}
            cm, tm, size, leading = saved.pop()
        elif op == b'cm' and len(args) == 6:
            cm = _matrix(tuple(map(float, args)), cm)
        elif op == b'BT':
            tm = (1., 0., 0., 1., 0., 0.)
        elif op == b'Tm' and len(args) == 6:
            tm = tuple(map(float, args))
        elif op == b'Tf' and len(args) == 2:
            size = float(args[1])
        elif op == b'gs':
            size = 0.  # An uninspected graphics state may replace the font.
        elif op == b'TL' and len(args) == 1:
            leading = float(args[0])
        elif op in (b'Td', b'TD') and len(args) == 2 and tm is not None:
            tx, ty = map(float, args)
            a, b, c, d, x, y = tm
            tm = (a, b, c, d, x+tx*a+ty*c, y+tx*b+ty*d)
            if op == b'TD':
                leading = -ty
        elif op == b'T*' and tm is not None:
            a, b, c, d, x, y = tm
            tm = (a, b, c, d, x-leading*c, y-leading*d)
        elif op in (b"'", b'"'):
            tm = None
        if op in semantic.SHOW and tm is not None:
            a, b, c, d, x, y = _matrix(tm, cm)
            if abs(b) < 1e-8 and abs(c) < 1e-8 and a > 0 and d > 0 and size > 0:
                values = x, y, abs(d*size)
                if all(math.isfinite(value) for value in values):
                    positions[index] = values
    if saved:
        return {}
    return {mcid: [positions[index] for index in scope['shows']]
        for mcid, scope in scopes.items()
        if scope['shows'] and all(index in positions for index in scope['shows'])}


def _raw_inventory(reader, inspection):
    if inspection is not None and type(inspection) is not semantic._DiscoveryInspection:
        fail()
    return (inspection.copy_for(reader) if inspection is not None
        else v.structure_inventory(reader))


def _discover(reader, *, _inspection=None):
    inventory = _raw_inventory(reader, _inspection)
    tags, native_nodes = inventory['tags'], semantic.nodes(reader)
    if len(tags) != len(native_nodes):
        fail()
    by_id = {tag['id']: tag for tag in tags}
    native = {tag['id']: node for tag, node in zip(tags, native_nodes)}
    unsafe_pages = {item.get('page') for item in inventory['findings']
        if item['code'] in UNSAFE_FINDINGS}
    page_positions, result = {}, []
    source_hash = semantic.source_digest(reader)

    def ancestry_safe(tag):
        while tag:
            if any(key in native[tag['id']] for key in ('/ID', '/Alt', '/ActualText', '/E', '/Ref')):
                return False
            tag = by_id.get(tag.get('parentId'))
        return True

    def subtree(tag, depth=0):
        if depth > 8 or tag.get('textIncomplete') or tag.get('attributeGaps'):
            return None
        page = tag.get('pageNumber')
        if not isinstance(page, int) or page in unsafe_pages:
            return None
        found = [tag['id']]
        for item in tag.get('contentSequence', []):
            if item.get('kind') == 'childTag':
                child = by_id.get(item.get('tagId'))
                if not child or child.get('parentId') != tag['id'] or child.get('pageNumber') != page:
                    return None
                descendants = subtree(child, depth+1)
                if descendants is None:
                    return None
                found.extend(descendants)
            elif (item.get('kind') not in ('markedContent', 'objectReference')
                  or item.get('resolved') is not True or item.get('parentTreeVerified') is not True
                  or item.get('pageNumber') != page or 'streamId' in item):
                return None
        return found if len(found) <= 20 else None

    def body(tag):
        if (tag['role'] != 'P' or set(native[tag['id']]) - BODY_KEYS
            or not ancestry_safe(tag) or len(_text(tag)) < 40):
            return False
        descendants = subtree(tag)
        return descendants == [tag['id']] and bool(tag.get('contentSequence')) and all(
            item['kind'] == 'markedContent' for item in tag['contentSequence'])

    def callout(tag):
        if tag['role'] not in ('P', 'H', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6') or not 1 <= len(_text(tag)) <= 240:
            return None
        descendants = subtree(tag)
        if not descendants or not ancestry_safe(tag):
            return None
        # Existing alternatives on link leaves are valuable and remain exact.
        if any(set(native[i]) - (CALLOUT_KEYS if by_id[i]['role'] == 'Link' else BODY_KEYS)
               or by_id[i]['role'] not in ('Link', tag['role']) for i in descendants):
            return None
        links = [by_id[i] for i in descendants if by_id[i]['role'] == 'Link']
        if not links or any(not any(c['kind'] == 'objectReference' and c.get('subtype') == 'Link'
            for c in link['contentSequence']) for link in links):
            return None
        return descendants

    def points(ids, page):
        if page not in page_positions:
            page_positions[page] = _positions(reader.pages[page-1])
        positions, found = page_positions[page], []
        for identifier in ids:
            for item in by_id[identifier]['contentSequence']:
                if item['kind'] == 'markedContent':
                    values = positions.get(item['mcid'])
                    if not values:
                        return None
                    found.extend(values)
        return found or None

    for parent in tags:
        if parent['role'] not in ('Document', 'Part', 'Art', 'Sect', 'Div'):
            continue
        content = parent.get('contentSequence', [])
        if not content or any(item['kind'] != 'childTag' for item in content):
            continue
        children = [by_id[item['tagId']] for item in content]
        for index, first in enumerate(children):
            if not body(first):
                continue
            callouts, descendants = [], []
            for next_tag in children[index+1:index+MAX_CALLOUTS+2]:
                ids = callout(next_tag)
                if ids is None:
                    last = next_tag
                    break
                callouts.append(next_tag['id'])
                descendants.extend(ids)
            else:
                continue
            if not callouts or len(callouts) > MAX_CALLOUTS or not body(last):
                continue
            page = first.get('pageNumber')
            if any(by_id[i].get('pageNumber') != page for i in [*descendants, last['id']]):
                continue
            before_text, after_text = _text(first), _text(last)
            if not re.search(r'[\w\-\u00ad]$', before_text) or not re.match(r'[a-z]', after_text):
                continue
            before = points([first['id']], page)
            middle = points(descendants, page)
            after = points([last['id']], page)
            if not before or not middle or not after:
                continue
            em = statistics.median(p[2] for p in before+after)
            if not 4 <= em <= 40:
                continue
            bx, by = min(p[0] for p in before), min(p[1] for p in before)
            cx0, cx1 = min(p[0] for p in middle), max(p[0] for p in middle)
            cy0, cy1 = min(p[1] for p in middle), max(p[1] for p in middle)
            ax, ay = min(p[0] for p in after), max(p[1] for p in after)
            # Require the body to the right of the callout, then directly below
            # it at the callout's left margin. A separate footer/link list does
            # not satisfy this visual pattern.
            if (bx < cx1+2*em or abs(ax-cx0) > 2*em
                or not -0.5*em <= by-ay <= 2.5*em
                or cy1 < by-em or cy0 > max(p[1] for p in before)+em
                or cy0 < by-2*em or cy1-cy0 > 6*em
                or max(p[2] for p in middle) > 1.3*em):
                continue
            public = {'kind': 'move_callout', 'tagId': first['id'], 'pageNumber': page,
                'text': before_text[:20000],
                'preview': ('Read the interrupted paragraph continuously, then read the linked callout. '
                    + before_text[-300:] + ' ' + after_text[:300]),
                'relatedTagIds': [*descendants, last['id']]}
            detail = {'parentId': parent['id'], 'calloutIds': callouts, 'continuationId': last['id'],
                'geometry': [round(value, 4) for value in (bx, by, cx0, cx1, cy0, cy1, ax, ay, em)]}
            public['candidateId'] = hashlib.sha256(json.dumps(
                {'source': source_hash, **public, 'details': detail}, sort_keys=True,
                separators=(',', ':')).encode()).hexdigest()
            result.append((public, detail))
            if len(result) > MAX_CANDIDATES:
                raise ReadingOrderError('pdf_complexity_limit')
    result.extend(_page_continuations(reader, inventory, native_nodes, _inspection, source_hash))
    if len(result) > MAX_CANDIDATES:
        raise ReadingOrderError('pdf_complexity_limit')
    return result, inventory, native_nodes


def _page_continuations(reader, inventory, native_nodes, inspection, source_hash):
    """Move a page continuation ahead of intervening verified chart blocks.

    This is a reading-order proposal only. Source charts are independently
    bounded by their existing captions, text labels and native vector paint.
    The planner must confirm that the unfinished sentence actually continues.
    """
    if len(reader.pages) < 2:
        return []
    import bounded_chart_structure as charts
    tags = inventory['tags']
    by_id = {tag['id']: tag for tag in tags}
    native = {tag['id']: node for tag, node in zip(tags, native_nodes)}
    options, _, _ = charts._discover(reader, inspection)
    if not options:
        return []
    chart_options = {public['tagId']: (public, detail) for public, detail in options}
    positions, boxes, output = {}, {}, []

    def plain(tag):
        if (tag['role'] != 'P' or set(native[tag['id']]) - BODY_KEYS
            or tag.get('textIncomplete') or tag.get('attributeGaps') or len(_text(tag)) < 40):
            return False
        current = tag
        while current:
            if any(key in native[current['id']] for key in ('/Alt', '/ActualText', '/ID', '/Ref', '/E')):
                return False
            current = by_id.get(current.get('parentId'))
        return bool(tag['contentSequence']) and all(item['kind'] == 'markedContent'
            and item.get('resolved') is True and item.get('parentTreeVerified') is True
            and 'streamId' not in item and item.get('pageNumber') == tag.get('pageNumber')
            for item in tag['contentSequence'])

    def geometry(tag):
        pn = tag.get('pageNumber')
        if not isinstance(pn, int):
            return None
        if pn not in boxes:
            boxes.update(charts._pdfium_bounds(reader, [pn]))
            positions[pn] = _positions(reader.pages[pn-1])
        if pn not in boxes:
            return None
        bounds = charts._bound(tag, by_id, boxes[pn], pn)
        points = [p for item in tag['contentSequence'] if item['kind'] == 'markedContent'
            for p in positions[pn].get(item['mcid'], [])]
        if bounds is None or not points:
            return None
        return bounds, statistics.median(point[2] for point in points)

    def footer_link(tag, page, anchor_box):
        if (tag['role'] != 'Link' or tag.get('pageNumber') != page or _text(tag)
            or tag.get('textIncomplete') or tag.get('attributeGaps')
            or not tag['contentSequence'] or set(native[tag['id']]) - CALLOUT_KEYS):
            return False
        for item in tag['contentSequence']:
            if (item['kind'] != 'objectReference' or item.get('subtype') != 'Link'
                or item.get('resolved') is not True or item.get('parentTreeVerified') is not True
                or item.get('pageNumber') != page):
                return False
            annots = v.resolved(reader.pages[page-1].get('/Annots', []))
            index = item.get('annotationIndex')
            if not isinstance(index, int) or not 1 <= index <= len(annots):
                return False
            rect = v.resolved(v.resolved(annots[index-1]).get('/Rect'))
            if not isinstance(rect, ArrayObject) or len(rect) != 4:
                return False
            coordinates = [float(n) for n in rect]
            if (not all(math.isfinite(n) for n in coordinates)
                or coordinates[3] >= anchor_box[1] or coordinates[3] > float(reader.pages[page-1].mediabox.top)*.12):
                return False
        return True

    for parent in tags:
        if parent['role'] not in ('Document', 'Part', 'Art', 'Sect', 'Div'):
            continue
        content = parent.get('contentSequence', [])
        if not content or any(item['kind'] != 'childTag' for item in content):
            continue
        children = [by_id[item['tagId']] for item in content]
        for index, anchor in enumerate(children):
            pn = anchor.get('pageNumber')
            if (not isinstance(pn, int) or pn >= len(reader.pages) or not plain(anchor)
                or not re.search(r'[\w\-\u00ad]$', _text(anchor))):
                continue
            anchor_geometry = geometry(anchor)
            if anchor_geometry is None:
                continue
            anchor_box, em = anchor_geometry
            if not 4 <= em <= 40 or anchor_box[1] > float(reader.pages[pn-1].mediabox.top)*.25:
                continue
            cursor, crossed, graph_ids = index+1, [], []
            while cursor < len(children) and len(crossed) < 2 and footer_link(children[cursor], pn, anchor_box):
                crossed.append(children[cursor]['id']); cursor += 1
            last_region = None
            while cursor < len(children) and len(graph_ids) < 4:
                choice = chart_options.get(children[cursor]['id'])
                if choice is None:
                    break
                public, detail = choice
                roots = [public['tagId'], *detail['roots']]
                if (public['pageNumber'] != pn+1 or detail['parentId'] != parent['id']
                    or [tag['id'] for tag in children[cursor:cursor+len(roots)]] != roots):
                    break
                crossed.extend(roots); cursor += len(roots)
                graph_ids.append(public['candidateId'])
                last_region = detail['bounds']
                # A compact explanatory paragraph immediately below the chart
                # can belong to its caption rather than the interrupted prose.
                if cursor < len(children):
                    note = children[cursor]
                    note_geometry = geometry(note) if plain(note) and note.get('pageNumber') == pn+1 else None
                    if note_geometry and re.match(r'[A-Z]', _text(note)) and _text(note).endswith('.'):
                        bound, size = note_geometry
                        if (len(_text(note)) <= 1200 and size <= .95*em
                            and bound[0] >= last_region[0]-8 and bound[2] <= last_region[2]+8
                            and 0 <= last_region[1]-bound[3] <= 40
                            and bound[3]-bound[1] <= 90):
                            crossed.append(note['id']); cursor += 1
            if not graph_ids or cursor >= len(children) or len(crossed) > 200:
                continue
            continuation = children[cursor]
            if (continuation.get('pageNumber') != pn+1 or not plain(continuation)
                or not re.match(r'[a-z]', _text(continuation))):
                continue
            following_geometry = geometry(continuation)
            if following_geometry is None:
                continue
            bound, size = following_geometry
            if (not .85*em <= size <= 1.15*em or bound[3] > last_region[1]+8
                or bound[0] < last_region[0]-8 or bound[2] > last_region[2]+8):
                continue
            public = {'kind': 'move_page_continuation', 'tagId': continuation['id'], 'pageNumber': pn+1,
                'relatedTagIds': [anchor['id']], 'readonlyTagIds': [anchor['id']],
                'text': _text(continuation)[:20000],
                'preview': 'Read this continuation immediately after the unfinished paragraph on the previous page, before the charts. '
                    + _text(anchor)[-300:] + ' ' + _text(continuation)[:300]}
            detail = {'parentId': parent['id'], 'anchorId': anchor['id'], 'crossedIds': crossed,
                'chartCandidates': graph_ids}
            public['candidateId'] = hashlib.sha256(json.dumps({'source': source_hash, **public,
                'details': detail}, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
            output.append((public, detail))
    return output


def discover_candidates(reader, *, _inspection=None):
    return [public for public, _ in _discover(reader, _inspection=_inspection)[0]]


def _key(node):
    value = v.reference_key(node)
    if value is None:
        fail()
    return value


def _signature(node, pages):
    """A node's own data and exact native K/P ownership, without ancestor cycles."""
    def child(value):
        item = v.resolved(value)
        if isinstance(item, DictionaryObject) and item.get('/Type') not in ('/MCR', '/OBJR'):
            return {'node': _key(item)}
        return {'content': v.Canonicalizer(pages).value(value)}
    return {'attributes': v.Canonicalizer(pages).value(DictionaryObject({key: value
            for key, value in node.items() if key not in ('/P', '/K')})),
        'parent': _key(v.resolved(node['/P'])), 'children': [child(value) for value in _children(node)]}


def _evidence(node, pages, depth=0):
    """Compare source/clone subtree data without following parent cycles."""
    if depth > 8:
        fail()
    content = []
    for value in _children(node):
        child = v.resolved(value)
        if isinstance(child, DictionaryObject) and child.get('/Type') not in ('/MCR', '/OBJR'):
            content.append({'node': _evidence(child, pages, depth+1)})
        else:
            content.append({'content': v.Canonicalizer(pages).value(value)})
    return {'attributes': v.Canonicalizer(pages).value(DictionaryObject({k: x
        for k, x in node.items() if k not in ('/P', '/K')})), 'children': content}


def _ownership(tag):
    return [dict(item) for item in tag['contentSequence'] if item['kind'] != 'childTag']


class _Verification:
    __slots__ = ('_nodes', '_windows', '_owners')

    def __init__(self, token, nodes, windows, owners):
        if token is not _PROOF_TOKEN:
            fail()
        object.__setattr__(self, '_nodes', tuple((key, _proof_json(value)) for key, value in nodes.items()))
        object.__setattr__(self, '_windows', tuple(windows))
        object.__setattr__(self, '_owners', tuple((key, _proof_json(value)) for key, value in owners.items()))

    def __setattr__(self, name, value):
        fail()


def _proof_json(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'))


def apply_operations(source_reader, writer, operations, *, _inspection=None,
                     _source_nodes=None, _target_nodes=None, _prior_verifications=()):
    if not isinstance(operations, list) or len(operations) > MAX_CANDIDATES:
        fail()
    options, inventory, discovered_nodes = _discover(source_reader, _inspection=_inspection)
    source_nodes = discovered_nodes if _source_nodes is None else _source_nodes
    targets = semantic.nodes(writer) if _target_nodes is None else _target_nodes
    tag_ids = [tag['id'] for tag in inventory['tags']]
    if isinstance(source_nodes, dict):
        if set(source_nodes) != set(tag_ids):
            fail()
        source_nodes = [source_nodes[identifier] for identifier in tag_ids]
    if isinstance(targets, dict):
        if set(targets) != set(tag_ids):
            fail()
        targets = [targets[identifier] for identifier in tag_ids]
    if (len(source_nodes) != len(discovered_nodes) or len(targets) != len(discovered_nodes)
        or any(a is not b for a, b in zip(source_nodes, discovered_nodes))
        or len({id(node) for node in targets}) != len(targets)):
        fail()
    actual_targets = {id(node) for node in semantic.nodes(writer)}
    if any(id(node) not in actual_targets for node in targets):
        fail()
    tags = inventory['tags']
    by_id = {tag['id']: node for tag, node in zip(tags, targets)}
    source = {tag['id']: node for tag, node in zip(tags, source_nodes)}
    tag_map = {tag['id']: tag for tag in tags}
    lineage = [{'node': node, 'sourceTagId': tag['id']} for tag, node in zip(tags, targets)]
    choices = {public['candidateId']: (public, detail) for public, detail in options}
    selected, used = [], set()
    source_pages, output_pages = list(source_reader.pages), list(writer.pages)
    for operation in operations:
        if (not isinstance(operation, dict) or set(operation) != {'type', 'tagId', 'candidateId'}
            or operation.get('type') != 'repair_structure' or operation.get('candidateId') not in choices):
            fail()
        public, detail = choices[operation['candidateId']]
        if operation['tagId'] != public['tagId']:
            fail()
        participants = {public['tagId'], *public['relatedTagIds']}
        readonly = set(public.get('readonlyTagIds', []))
        if (participants-readonly) & used:
            fail()
        used |= participants-readonly
        for identifier in participants:
            # Compare complete attributes/content with native IDs normalized by
            # canonicalization; an earlier independent repair cannot silently
            # change this candidate's source assumptions.
            source_equal = (set(source[identifier]) == set(by_id[identifier])
                and _evidence(source[identifier], source_pages) == _evidence(by_id[identifier], output_pages))
            approved_split = (identifier in readonly and any(module is semantic
                and semantic._verified_split_body(source_reader, writer, by_id[identifier], identifier, proof)
                for module, proof in _prior_verifications))
            if (not (source_equal or approved_split)
                or v.resolved(by_id[identifier].get('/P')) is not by_id.get(tag_map[identifier].get('parentId'))):
                fail()
        parent = by_id[detail['parentId']]
        group_ids = ([detail['anchorId'], *detail['crossedIds'], public['tagId']]
            if public['kind'] == 'move_page_continuation'
            else [public['tagId'], *detail['calloutIds'], detail['continuationId']])
        group = [by_id[i] for i in group_ids]
        children = [v.resolved(item) for item in _children(parent)]
        starts = [i for i, node in enumerate(children) if node is group[0]]
        if (len(starts) != 1 or len(children[starts[0]:starts[0]+len(group)]) != len(group)
            or any(a is not z for a, z in zip(children[starts[0]:starts[0]+len(group)], group))
            or any(v.resolved(node.get('/P')) is not parent for node in group)):
            fail()
        selected.append((public, detail, participants))
    changes, proof_nodes, windows, owners = [], {}, [], {}
    for public, detail, participants in selected:
        parent = by_id[detail['parentId']]
        if public['kind'] == 'move_page_continuation':
            anchor, target = by_id[detail['anchorId']], by_id[public['tagId']]
            kids = _children(parent)
            current = [item for item in kids if v.resolved(item) is not target]
            if len(current) != len(kids)-1:
                fail()
            at = next(index for index, item in enumerate(current) if v.resolved(item) is anchor)
            current.insert(at+1, target.indirect_reference)
            parent[NameObject('/K')] = ArrayObject(current)
            for identifier in participants:
                node = by_id[identifier]
                proof_nodes[_key(node)] = _signature(node, output_pages)
            # A prior split proof verifies the changed anchor's text owners;
            # this operation's sole content owner is the unchanged moved P.
            owners[_key(target)] = _ownership(tag_map[public['tagId']])
            windows.append((_key(parent), (_key(anchor), _key(target))))
            changes.append({'code': 'move_page_continuation', 'candidateId': public['candidateId'],
                'tagId': public['tagId'], 'relatedTagIds': public['relatedTagIds'],
                'pageNumber': public['pageNumber'],
                'message': 'Placed the next-page continuation directly after its unfinished paragraph in the reading order, before the charts. Every page keeps its original appearance.'})
            continue
        first, last = by_id[public['tagId']], by_id[detail['continuationId']]
        callouts = [by_id[i] for i in detail['calloutIds']]
        old = _children(parent)
        start = next(i for i, node in enumerate(old) if v.resolved(node) is first)
        wrapper = DictionaryObject({NameObject('/Type'): NameObject('/StructElem'),
            NameObject('/S'): NameObject('/P'), NameObject('/P'): parent.indirect_reference,
            NameObject('/Pg'): writer.pages[public['pageNumber']-1].indirect_reference,
            NameObject('/K'): ArrayObject([first.indirect_reference, last.indirect_reference])})
        wrapper_ref = writer._add_object(wrapper)
        for body in (first, last):
            body[NameObject('/S')] = NameObject('/Span')
            body[NameObject('/P')] = wrapper_ref
        for callout in callouts:
            # Selecting this candidate confirms these short ancillary labels
            # are a callout, rather than headings that introduce the body.
            callout[NameObject('/S')] = NameObject('/P')
        replacement = [wrapper_ref, *[node.indirect_reference for node in callouts]]
        parent[NameObject('/K')] = ArrayObject(old[:start]+replacement+old[start+len(callouts)+2:])
        lineage.append({'node': wrapper, 'sourceTagId': public['tagId']})
        for identifier in participants:
            node = by_id[identifier]
            proof_nodes[_key(node)] = _signature(node, output_pages)
            owners[_key(node)] = _ownership(tag_map[identifier])
        proof_nodes[_key(wrapper)] = _signature(wrapper, output_pages)
        windows.append((_key(parent), tuple(_key(v.resolved(item)) for item in replacement)))
        changes.append({'type': 'repair_structure', 'kind': 'move_callout', 'code': 'move_callout',
            'candidateId': public['candidateId'], 'tagId': public['tagId'],
            'relatedTagIds': public['relatedTagIds'], 'pageNumber': public['pageNumber'],
            'message': 'Joined the interrupted paragraph and placed its linked callout after it in the reading order. The callout labels are paragraphs, and the page appearance and links are unchanged.'})
    return {'changes': changes, 'lineage': lineage,
        'verification': _Verification(_PROOF_TOKEN, proof_nodes, tuple(windows), owners)}


def verify_saved(reader, verification, *, _inspection=None):
    """Require the saved file to contain the exact planned hierarchy and owners.

    The worker additionally runs independent source/output page, text, link and
    rendering preservation checks. This proof covers the new reading order.
    """
    if type(verification) is not _Verification:
        fail()
    inventory = _raw_inventory(reader, _inspection)
    native = semantic.nodes(reader)
    if len(native) != len(inventory['tags']):
        fail()
    indexed = {_key(node): node for node in native}
    tags = {_key(node): tag for node, tag in zip(native, inventory['tags'])}
    pages = list(reader.pages)
    for key, expected in verification._nodes:
        if key not in indexed or _proof_json(_signature(indexed[key], pages)) != expected:
            fail()
    for parent_key, window in verification._windows:
        if parent_key not in indexed:
            fail()
        keys = tuple(_key(v.resolved(item)) for item in _children(indexed[parent_key]))
        if sum(keys[i:i+len(window)] == window for i in range(len(keys))) != 1:
            fail()
    for key, expected in verification._owners:
        if key not in tags or _proof_json(_ownership(tags[key])) != expected:
            fail()
    return True
