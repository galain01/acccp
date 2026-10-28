"""Repair explicit headers of an existing rectangular native PDF table.

Only a verified first-column/column-header grid with its two adjacent source
axis labels is supported. A model selects the bound candidate; it supplies no
labels, geometry, cell values, identifiers or replacement PDF code.
"""
from __future__ import annotations

import hashlib
import json

from pypdf.generic import ArrayObject, ByteStringObject, DictionaryObject, NameObject as N, NumberObject as I

import bounded_semantic_structure as b
import bounded_table_structure as t
import verify_pdf as v

MAX_TABLES = 8
MAX_ROWS = 60
MAX_COLUMNS = 32
MAX_RELATED_TAGS = 4000
NODE_KEYS = {'/Type', '/S', '/P', '/Pg', '/K', '/Lang', '/A', '/ID'}
TABLE_KEYS = {'/O', '/Scope', '/Headers', '/RowSpan', '/ColSpan'}
PROTECTED = {'/Alt', '/ActualText', '/E', '/Ref'}
_TOKEN = object()


def require(value, code='native_pdf_invalid_plan'):
    if not value:
        raise b.SemanticStructureError(code)


def key(node):
    value = v.reference_key(node)
    require(value is not None)
    return tuple(value)


def child_ids(tag):
    sequence = tag.get('contentSequence', [])
    require(all(item.get('kind') == 'childTag' and item.get('resolved') for item in sequence))
    return [item['tagId'] for item in sequence]


def table_attributes(node):
    value = v.resolved(node.get('/A'))
    entries = list(value) if isinstance(value, ArrayObject) else [] if value is None else [value]
    result = {}
    table_entries = 0
    for entry in entries:
        entry = v.resolved(entry)
        require(isinstance(entry, DictionaryObject))
        if entry.get('/O') == '/Table':
            table_entries += 1
            require(table_entries == 1)
            require(not set(entry) - TABLE_KEYS)
            result.update(entry)
    return result


def set_table_attributes(node, **values):
    old = v.resolved(node.get('/A'))
    entries = list(old) if isinstance(old, ArrayObject) else [] if old is None else [old]
    attributes = DictionaryObject(table_attributes(node))
    attributes[N('/O')] = N('/Table')
    for name, value in values.items():
        attribute = N('/' + name)
        if value is None:
            attributes.pop(attribute, None)
        else:
            attributes[attribute] = value
    retained = [entry for entry in entries if v.resolved(entry).get('/O') != '/Table']
    node[N('/A')] = ArrayObject([*retained, attributes]) if retained else attributes


def shape(node, pages, labels=None):
    """Local relationships never follow a child's parent back into the PDF."""
    def identity(value):
        identifier = key(value)
        return labels.get(identifier, ('root',)) if labels is not None else identifier
    def content(value):
        raw = v.resolved(value)
        if isinstance(raw, DictionaryObject) and '/S' in raw:
            return ['tag', identity(raw)]
        if isinstance(raw, ArrayObject):
            return ['array', [content(item) for item in raw]]
        return ['content', t._MetadataCanonicalizer(pages).hash(raw)]
    return (t._metadata(node, pages), '/K' in node, content(node.get('/K')),
            identity(v.resolved(node['/P'])))


def _index_is_plain(root):
    pending = [v.resolved(root['/IDTree'])] if '/IDTree' in root else []
    while pending:
        entry = pending.pop()
        require(isinstance(entry, DictionaryObject) and not set(entry) - {'/Names', '/Kids', '/Limits'})
        pending.extend(v.resolved(item) for item in v.resolved(entry.get('/Kids', [])))


def _discover(reader, _inspection=None):
    if _inspection is not None:
        require(type(_inspection) is b._DiscoveryInspection)
        inventory = _inspection.copy_for(reader)
    else:
        inventory = v.structure_inventory(reader)
    try:
        objects = b.nodes(reader)
    except b.SemanticStructureError:
        return [], inventory, {}
    tags = {tag['id']: tag for tag in inventory['tags']}
    require(len(tags) == len(objects))
    native = dict(zip(tags, objects))
    options = []
    if not inventory.get('checks_complete') or not inventory.get('native_id_tree', {}).get('verified'):
        return options, inventory, native
    root = reader.trailer['/Root']['/StructTreeRoot']
    try:
        _index_is_plain(root)
    except b.SemanticStructureError:
        return options, inventory, native

    def subtree(identifier, roles, limit=32):
        found, pages, seen = [], set(), set()
        def visit(current, depth=0):
            require(current in tags and current not in seen and len(seen) < limit and depth <= 8)
            seen.add(current)
            tag, node = tags[current], native[current]
            require(tag['role'] in roles and tag.get('sourceRole') == tag['role']
                    and not tag.get('textIncomplete') and not tag.get('attributeGaps')
                    and not set(node) - NODE_KEYS and not (set(node) & PROTECTED))
            found.append(current)
            for item in tag.get('contentSequence', []):
                require(item.get('resolved'))
                if item.get('kind') == 'childTag':
                    child = tags[item['tagId']]
                    require(child.get('parentId') == current)
                    visit(child['id'], depth + 1)
                else:
                    require(item.get('kind') == 'markedContent' and item.get('parentTreeVerified')
                            and type(item.get('pageNumber')) is int and 'streamId' not in item
                            and isinstance(item.get('text'), str))
                    pages.add(item['pageNumber'])
        visit(identifier)
        return found, pages, ' '.join(' '.join(tags[item].get('text', '').split()) for item in found).strip()

    for table in tags.values():
        if table['role'] != 'Table':
            continue
        try:
            identifier = table['id']
            node = native[identifier]
            require(table.get('sourceRole') == 'Table' and '/ID' not in node and not table.get('attributes')
                    and not set(node) - NODE_KEYS)
            parent_id = table.get('parentId')
            parent = tags[parent_id]
            ancestors, current = set(), table
            while current:
                require(current['id'] not in ancestors and len(ancestors) < 64
                        and not (set(native[current['id']]) & (PROTECTED | {'/ID'}))
                        and current['role'] != 'Artifact')
                ancestors.add(current['id'])
                current = tags.get(current.get('parentId'))
            siblings = child_ids(parent)
            position = siblings.index(identifier)
            require(position > 0)
            wrapper = None
            prior = tags[siblings[position - 1]]
            if prior['role'] in ('Sect', 'Div'):
                wrapper = prior['id']
                require(not prior.get('attributes') and '/ID' not in native[wrapper]
                        and not set(native[wrapper]) - NODE_KEYS)
                axes = child_ids(prior)
                require(len(axes) == 2)
                tops = [wrapper]
            else:
                require(position >= 2)
                axes = siblings[position - 2:position]
                tops = axes
            participants, page_numbers, axis_text = {identifier}, set(), []
            if wrapper:
                participants.add(wrapper)
            for axis in axes:
                members, pages, text = subtree(axis, {'Div', 'P', 'Span'})
                require(text and len(text) <= 400 and len(pages) == 1)
                participants.update(members); page_numbers.update(pages); axis_text.append(text)
            require(axis_text[0] != axis_text[1] and len(page_numbers) == 1)
            rows = child_ids(table)
            require(3 <= len(rows) <= MAX_ROWS + 1)
            matrix, column_ids, row_texts, column_texts = [], [], [], []
            for ri, row_id in enumerate(rows):
                row = tags[row_id]
                require(row['role'] == row.get('sourceRole') == 'TR' and not row.get('attributes')
                        and not set(native[row_id]) - NODE_KEYS)
                participants.add(row_id)
                cells = child_ids(row)
                require(3 <= len(cells) <= MAX_COLUMNS and (not matrix or len(cells) == len(matrix[0])))
                matrix.append(cells)
                for ci, cell_id in enumerate(cells):
                    cell = tags[cell_id]
                    members, pages, text = subtree(cell_id, {'TH' if ri == 0 else 'TD', 'P', 'Span'})
                    require(len(pages) == 1 and pages == page_numbers and (text or ri == ci == 0))
                    participants.update(members)
                    attributes = table_attributes(native[cell_id])
                    require(int(attributes.get('/RowSpan', 1)) == int(attributes.get('/ColSpan', 1)) == 1
                            and all(attribute.get('source') == 'direct' and not attribute.get('revision')
                                    for attribute in cell.get('attributes', [])))
                    if ri == 0:
                        require('nativeIdHex' in cell and cell.get('idTreeVerified') and not attributes.get('/Headers')
                                and attributes.get('/Scope') in (None, '/Column'))
                        column_ids.append(cell['nativeIdHex']); column_texts.append(text)
                        require(bool(text) if ci else not text)
                    else:
                        require(cell['role'] == 'TD' and not attributes.get('/Scope'))
                        links = [attribute for attribute in cell.get('attributes', []) if attribute.get('headersEffective')]
                        require(len(links) == 1 and links[0].get('headersResolved') and links[0].get('headersAcyclic')
                                and links[0].get('headerTagIds') == [matrix[0][ci]])
                        if ci == 0:
                            row_texts.append(text)
            require(len(set(row_texts)) == len(row_texts)
                    and len(set(column_texts[1:])) == len(column_texts) - 1)
            ordered = [item for item in tags if item in participants]
            require(len(ordered) <= MAX_RELATED_TAGS + 1)
            public = {'kind': 'repair_table_headers', 'tagId': identifier,
                'pageNumber': next(iter(page_numbers)), 'text': '\n'.join(axis_text),
                'preview': ('Existing table: use the first source axis for row ranges and the second for column ranges.\n'
                    + f'Row axis: {axis_text[0]}\nColumn axis: {axis_text[1]}\n'
                    + 'Row labels: ' + '; '.join(row_texts) + '\nColumn labels: ' + '; '.join(column_texts[1:]))[:20000],
                'relatedTagIds': [item for item in ordered if item != identifier]}
            detail = {'parent': parent_id, 'tops': tops, 'wrapper': wrapper, 'axes': axes, 'rows': rows,
                'matrix': matrix, 'columnIds': column_ids, 'axisText': axis_text, 'rowText': row_texts,
                'columnText': column_texts, 'participants': ordered,
                'before': siblings[position - len(tops) - 1] if position > len(tops) else None,
                'after': siblings[position + 1] if position + 1 < len(siblings) else None}
            public['candidateId'] = hashlib.sha256(json.dumps({'source': b.source_digest(reader),
                'public': public, 'detail': detail}, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
            if len(options) >= MAX_TABLES:
                raise b.SemanticStructureError('pdf_complexity_limit')
            options.append((public, detail))
        except (b.SemanticStructureError, v.InspectionError, KeyError, ValueError, TypeError):
            continue
    return options, inventory, native


def discover_candidates(reader, *, _inspection=None):
    return [public for public, _ in _discover(reader, _inspection)[0]]


class _Proof:
    __slots__ = ('token', 'tables', 'forms', 'pages', 'source_nodes', 'ids')

    def __init__(self, token):
        require(token is _TOKEN)
        self.token, self.tables, self.pages, self.ids = token, [], {}, {}
        self.forms, self.source_nodes = None, set()


def apply_operations(source_reader, writer, operations, *, _inspection=None, _source_nodes=None, _target_nodes=None):
    require(isinstance(operations, list) and len(operations) <= MAX_TABLES)
    options, _, original = _discover(source_reader, _inspection)
    options = {public['candidateId']: (public, detail) for public, detail in options}
    source_nodes = _source_nodes if _source_nodes is not None else original
    targets = _target_nodes if _target_nodes is not None else {
        f'tag-{i+1}': node for i, node in enumerate(b.nodes(writer))}
    require(isinstance(source_nodes, dict) and isinstance(targets, dict))
    source_labels = {key(node): identifier for identifier, node in source_nodes.items()}
    target_labels = {key(node): identifier for identifier, node in targets.items()}
    source_pages = list(source_reader.pages)
    chosen, used = [], set()
    pages = list(writer.pages)
    for operation in operations:
        require(isinstance(operation, dict) and set(operation) == {'type', 'tagId', 'candidateId'}
                and operation.get('type') == 'repair_structure' and operation.get('candidateId') in options)
        public, detail = options[operation['candidateId']]
        require(operation.get('tagId') == public['tagId'] and not used.intersection(detail['participants']))
        used.update(detail['participants'])
        for identifier in detail['participants']:
            require(identifier in source_nodes and identifier in targets
                    and shape(source_nodes[identifier], source_pages, source_labels) ==
                        shape(targets[identifier], pages, target_labels))
        siblings = b._children(targets[detail['parent']])
        at = next(i for i, value in enumerate(siblings) if v.resolved(value) is targets[public['tagId']])
        require(at >= len(detail['tops']) and all(v.resolved(value) is targets[identifier]
            for value, identifier in zip(siblings[at-len(detail['tops']):at], detail['tops'])))
        chosen.append((public, detail))
    root = writer.root_object['/StructTreeRoot']
    _index_is_plain(root)
    entries = v.structure_id_tree(root)
    proof = _Proof(_TOKEN)
    proof.forms = v.form_inventory(source_reader)
    proof.source_nodes = {key(node) for node in b.nodes(writer)}
    lineage = [{'node': node, 'sourceTagId': identifier} for identifier, node in targets.items()]
    changes = []
    for public, detail in chosen:
        identifier = public['tagId']; table = targets[identifier]
        page_number = public['pageNumber']; page = pages[page_number - 1]
        parent = targets[detail['parent']]
        prefix = ('acccp-headers-' + public['candidateId'][:20]).encode()
        while any(bytes.fromhex(value).startswith(prefix) for value in entries):
            prefix += b'-x'
        def assign(node, suffix):
            if '/ID' in node:
                value = v.native_string(node['/ID'])[1]
                require(value in entries and v.resolved(entries[value]) is node)
                return bytes.fromhex(value)
            value = prefix + suffix
            require(value.hex() not in entries)
            node[N('/ID')] = ByteStringObject(value); entries[value.hex()] = node
            return value
        def new(role, owner):
            node = b._new_tag(writer, role, owner, page, ArrayObject())
            lineage.append({'node': node, 'sourceTagId': identifier})
            return node
        table_id = assign(table, b'-table')
        header = targets[detail['wrapper']] if detail['wrapper'] else new('THead', table)
        header[N('/S')] = N('/THead'); header[N('/P')] = b._reference(writer, table)
        top_row = new('TR', header)
        axes = [targets[value] for value in detail['axes']]
        axis_ids = []
        for ci, axis in enumerate(axes):
            axis[N('/S')] = N('/TH'); axis[N('/P')] = b._reference(writer, top_row)
            axis_ids.append(assign(axis, b'-axis-' + str(ci).encode()))
            set_table_attributes(axis, Scope=N('/Column'), Headers=None, RowSpan=I(1),
                                 ColSpan=I(1 if ci == 0 else len(detail['matrix'][0]) - 1))
        top_row[N('/K')] = ArrayObject([b._reference(writer, axis) for axis in axes])
        original_header = targets[detail['rows'][0]]
        original_header[N('/P')] = b._reference(writer, header)
        header[N('/K')] = ArrayObject([b._reference(writer, top_row), b._reference(writer, original_header)])
        body = new('TBody', table)
        body[N('/K')] = ArrayObject([b._reference(writer, targets[row]) for row in detail['rows'][1:]])
        for row in detail['rows'][1:]:
            targets[row][N('/P')] = b._reference(writer, body)
        table[N('/K')] = ArrayObject([b._reference(writer, header), b._reference(writer, body)])
        parent[N('/K')] = ArrayObject([value for value in b._children(parent)
            if not any(v.resolved(value) is targets[top] for top in detail['tops'])])
        expected_rows = []
        for ri, row in enumerate(detail['matrix']):
            if ri == 0:
                for ci, cell_id in enumerate(row):
                    cell = targets[cell_id]
                    cell[N('/S')] = N('/TD' if ci == 0 else '/TH')
                    set_table_attributes(cell, Scope=None if ci == 0 else N('/Column'),
                        Headers=ArrayObject([ByteStringObject(axis_ids[0 if ci == 0 else 1])]))
                continue
            row_header = targets[row[0]]
            row_header[N('/S')] = N('/TH')
            row_id = assign(row_header, b'-row-' + str(ri).encode())
            set_table_attributes(row_header, Scope=N('/Row'), Headers=ArrayObject([ByteStringObject(axis_ids[0])]))
            for ci, cell_id in enumerate(row[1:], 1):
                column_id = bytes.fromhex(detail['columnIds'][ci])
                set_table_attributes(targets[cell_id], Headers=ArrayObject([ByteStringObject(value)
                    for value in (axis_ids[0], row_id, axis_ids[1], column_id)]))
            expected_rows.append({'row': key(targets[detail['rows'][ri]]), 'rowId': row_id.hex(),
                                  'text': detail['rowText'][ri-1], 'cells': [key(targets[value]) for value in row[1:]]})
        related = {key(targets[value]): shape(targets[value], pages) for value in detail['participants']}
        related[key(top_row)] = shape(top_row, pages)
        related[key(body)] = shape(body, pages)
        if not detail['wrapper']:
            related[key(header)] = shape(header, pages)
        proof.tables.append({'tableId': table_id.hex(), 'table': key(table), 'parent': key(parent),
            'before': key(targets[detail['before']]) if detail['before'] else None,
            'after': key(targets[detail['after']]) if detail['after'] else None,
            'shape': related, 'axes': [value.hex() for value in axis_ids], 'axisText': detail['axisText'],
            'columnIds': detail['columnIds'], 'columnText': detail['columnText'], 'rows': expected_rows})
        if page_number not in proof.pages:
            source_page = source_pages[page_number - 1]
            proof.pages[page_number] = (
                v.drawing_fingerprint(v.operations(source_page), v.Canonicalizer(source_pages)),
                v.Canonicalizer(source_pages).hash(source_page['/Resources']))
        require(proof.pages[page_number] == (
            v.drawing_fingerprint(v.operations(page), v.Canonicalizer(pages)),
            v.Canonicalizer(pages).hash(page['/Resources'])))
        changes.append({'code': 'repair_table_headers', 'tagId': identifier, 'pageNumber': page_number,
            'candidateId': public['candidateId'], 'relatedTagIds': public['relatedTagIds'],
            'message': 'Connected every table amount to its row range, column range and existing axis labels without changing the pages or form fields.'})
    if chosen:
        root[N('/IDTree')] = writer._add_object(DictionaryObject({N('/Names'): ArrayObject([
            value for identifier, node in sorted(entries.items())
            for value in (ByteStringObject(bytes.fromhex(identifier)), b._reference(writer, node))])}))
    proof.ids = {identifier: key(v.resolved(node)) for identifier, node in entries.items()}
    return {'changes': changes, 'lineage': lineage, 'verification': proof}


def verify_saved(reader, verification, *, _inspection=None):
    require(type(verification) is _Proof and verification.token is _TOKEN)
    if _inspection is not None:
        require(type(_inspection) is b._DiscoveryInspection)
        inventory = _inspection.copy_for(reader)
    else:
        inventory = v.structure_inventory(reader)
    require(inventory.get('checks_complete') and inventory.get('native_id_tree', {}).get('verified'))
    nodes = b.nodes(reader); native = {key(node): node for node in nodes}; pages = list(reader.pages)
    require(len(native) == len(nodes) and verification.source_nodes <= set(native)
            and v.form_inventory(reader) == verification.forms)
    tags = {tag['id']: tag for tag in inventory['tags']}
    by_key = {key(node): tag for node, tag in zip(nodes, inventory['tags'])}
    ids = v.structure_id_tree(reader.trailer['/Root']['/StructTreeRoot'])
    require(all(identifier in ids and key(v.resolved(ids[identifier])) == owner
                for identifier, owner in verification.ids.items()))
    def text(tag):
        return ' '.join(' '.join([tag.get('text', ''),
            *[text(tags[value]) for value in child_ids(tag)]]).split()) if any(
            item.get('kind') == 'childTag' for item in tag.get('contentSequence', [])) else ' '.join(tag.get('text', '').split())
    def headers(tag):
        matches = [attr for attr in tag.get('attributes', []) if attr.get('headersEffective')]
        require(len(matches) == 1 and matches[0].get('headersResolved') and matches[0].get('headersAcyclic'))
        return matches[0]['headersHex']
    def scope(tag):
        return [attr.get('scope') for attr in tag.get('attributes', []) if attr.get('owner') == 'Table'][-1]
    for table in verification.tables:
        require(all(owner in native and shape(native[owner], pages) == expected for owner, expected in table['shape'].items()))
        parent = native[table['parent']]
        siblings = [key(v.resolved(value)) for value in b._children(parent)]
        require(siblings.count(table['table']) == 1)
        at = siblings.index(table['table'])
        require((table['before'] is None or siblings.index(table['before']) < at)
                and (table['after'] is None or siblings.index(table['after']) > at))
        row_axis, column_axis = [by_key[key(v.resolved(ids[value]))] for value in table['axes']]
        require([text(row_axis), text(column_axis)] == table['axisText']
                and row_axis['role'] == column_axis['role'] == 'TH'
                and scope(row_axis) == scope(column_axis) == 'Column')
        for column, identifier in enumerate(table['columnIds'][1:], 1):
            tag = by_key[key(v.resolved(ids[identifier]))]
            require(tag['role'] == 'TH' and scope(tag) == 'Column' and text(tag) == table['columnText'][column]
                    and headers(tag) == [table['axes'][1]])
        for row in table['rows']:
            label = by_key[key(v.resolved(ids[row['rowId']]))]
            require(label['role'] == 'TH' and scope(label) == 'Row' and text(label) == row['text']
                    and headers(label) == [table['axes'][0]])
            for ci, owner in enumerate(row['cells'], 1):
                cell = by_key[owner]
                require(cell['role'] == 'TD' and headers(cell) == [table['axes'][0], row['rowId'],
                    table['axes'][1], table['columnIds'][ci]])
    for page_number, (paint, resources) in verification.pages.items():
        page = pages[page_number - 1]
        require(v.drawing_fingerprint(v.operations(page), v.Canonicalizer(pages)) == paint
                and v.Canonicalizer(pages).hash(page['/Resources']) == resources)
    return True
