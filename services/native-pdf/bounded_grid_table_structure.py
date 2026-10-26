"""Repair captioned, explicitly aligned native PDF data grids.

This bounded path supplements the existing two-column repair. Existing text
shows supply cells; model selection cannot introduce text, values or geometry.
Every original native node survives and saved proofs bind header relationships,
marked-content membership and painting independently of the model.
"""
from __future__ import annotations

import hashlib
import json
import math
import re

from pypdf.generic import (ArrayObject, ByteStringObject, ContentStream,
    DictionaryObject, NameObject as N, NullObject, NumberObject as I)

import bounded_semantic_structure as b
import bounded_table_structure as t
import verify_pdf as v

MAX_TABLES = 8
MAX_ROWS = 60
MAX_COLUMNS = 8
MAX_PAGE_OPERATIONS = 100_000
MAX_SEGMENTS = 4000
MAX_NEW_MCIDS = 1000

# Share the established byte, geometry, paint and native-metadata contracts.
_require = t._require
_raw_bytes = t._raw_bytes
_mm = t._mm
_translate = t._translate
_text = t._text
_node_map = t._node_map
_metadata = t._metadata
_paint_member = t._paint_member
_same_paint_member = t._same_paint_member
_background_blocks = t._background_blocks
_background_identity = t._background_identity
_verified_background = t._verified_background


def _segments(reader, page, operations, owners):
    """Conservative simple-font horizontal positions; unsupported shows decline."""
    resources = v.resolved(page.get('/Resources', {}))
    fonts = v.resolved(resources.get('/Font', {}))
    graphics = v.resolved(resources.get('/ExtGState', {}))
    identity = (1., 0., 0., 1., 0., 0.)
    cm = line = tm = identity
    font, size, char_space, word_space, scale, rise, leading, rendering = None, 0., 0., 0., 1., 0., 0., 0
    saved, stack, output, scopes = [], [], [], {}
    in_text = False
    for index, (args, op) in enumerate(operations):
        if op == b'q':
            saved.append((cm, font, size, char_space, word_space, scale, rise, leading, rendering))
        elif op == b'Q':
            if not saved: return [], {}
            cm, font, size, char_space, word_space, scale, rise, leading, rendering = saved.pop()
        elif op == b'cm' and len(args) == 6:
            cm = _mm(tuple(map(float, args)), cm)
        elif op == b'BT': in_text, line, tm = True, identity, identity
        elif op == b'ET': in_text = False
        elif op == b'Tf' and len(args) == 2: font, size = args[0], float(args[1])
        elif op == b'Tc': char_space = float(args[0])
        elif op == b'Tw': word_space = float(args[0])
        elif op == b'Tz': scale = float(args[0])/100
        elif op == b'Ts': rise = float(args[0])
        elif op == b'TL': leading = float(args[0])
        elif op == b'Tr': rendering = int(args[0])
        elif op == b'Tm' and len(args) == 6: line = tm = tuple(map(float, args))
        elif op in (b'Td', b'TD') and len(args) == 2:
            if op == b'TD': leading = -float(args[1])
            line = tm = _translate(line, float(args[0]), float(args[1]))
        elif op == b'T*': line = tm = _translate(line, 0, -leading)
        elif op == b'gs':
            state = v.resolved(graphics.get(args[0], {}))
            if '/Font' in state: font = None
        elif op in (b'BDC', b'BMC'):
            for outer in stack: outer['safe'] = False
            properties = args[1] if op == b'BDC' and len(args) == 2 else None
            mcid = v.integer(properties.get('/MCID')) if isinstance(properties, dict) else None
            safe = (not stack and isinstance(properties, DictionaryObject)
                    and set(properties) == {'/MCID'} and mcid in owners)
            stack.append({'mcid': mcid, 'start': index, 'safe': safe, 'shows': []})
        elif op == b'EMC':
            if not stack: return [], {}
            scope = stack.pop()
            if scope['safe'] and scope['mcid'] not in scopes:
                scopes[scope['mcid']] = {**scope, 'end': index}
            elif scope['mcid'] in scopes: return [], {}
        elif op in b.SHOW:
            if stack: stack[-1]['shows'].append(index)
            if op not in (b'Tj', b'TJ') or not in_text or font not in fonts:
                font = None
                continue
            resource = v.resolved(fonts[font])
            widths = v.resolved(resource.get('/Widths'))
            first = v.integer(resource.get('/FirstChar'))
            physical = _mm(tm, cm)
            if (resource.get('/Subtype') not in ('/Type1', '/TrueType') or '/FontMatrix' in resource
                    or not isinstance(widths, list) or first is None or size <= 0
                    or abs(physical[1]) > 1e-7 or abs(physical[2]) > 1e-7
                    or physical[0] <= 0 or physical[3] <= 0 or not 0 < scale <= 4
                    or rendering != 0 or abs(rise) > 1e-7):
                font = None
                continue
            pieces = list(args[0]) if op == b'TJ' else [args[0]]
            if not pieces or len(pieces) > 500: continue
            positions, ends, advance, valid = [], [], 0., True
            for piece in pieces:
                positions.append(physical[4]+advance*physical[0])
                if isinstance(piece, (str, bytes)):
                    codes = list(_raw_bytes(piece))
                    if any(not 0 <= code-first < len(widths) for code in codes): valid = False; break
                    advance += sum((float(widths[code-first])/1000*size+char_space+
                                    (word_space if code == 32 else 0))*scale for code in codes)
                elif isinstance(piece, (int, float)) and math.isfinite(float(piece)):
                    advance -= float(piece)/1000*size*scale
                else: valid = False; break
                ends.append(physical[4]+advance*physical[0])
            if not valid:
                font = None
                continue
            tm = _translate(tm, advance, 0)
            if not stack or not stack[-1]['safe']: continue
            cuts = [0]
            for offset, piece in enumerate(pieces):
                if (offset and not isinstance(piece, (str, bytes))
                        and ends[offset]-positions[offset] >= max(12., size*physical[3]*2)
                        and any(isinstance(p, (str, bytes)) and _raw_bytes(p) for p in pieces[offset+1:])):
                    cuts.append(offset)
            cuts.append(len(pieces))
            if len(cuts) > MAX_COLUMNS + 1: continue
            for lo, hi in zip(cuts, cuts[1:]):
                strings = [offset for offset in range(lo, hi) if isinstance(pieces[offset], (str, bytes)) and _raw_bytes(pieces[offset])]
                if not strings: continue
                output.append({'op': index, 'lo': lo, 'hi': hi, 'mcid': stack[-1]['mcid'],
                    'owner': owners[stack[-1]['mcid']], 'x': positions[strings[0]],
                    'right': ends[strings[-1]], 'y': physical[5], 'height': size*physical[3],
                    'font': font, 'size': size, 'pieces': pieces[lo:hi], 'paired': len(cuts) >= 3,
                    'bold': bool(re.search(r'Bold|Black|Demi|Heavy|Medium|[-,]Bd(?:It)?$', str(resource.get('/BaseFont','')), re.I))})
                if len(output) > MAX_SEGMENTS: return [], {}
    if stack or saved: return [], {}
    return output, scopes


def _lines(segments):
    lines=[]
    for segment in sorted(segments,key=lambda s:(-s['y'],s['x'],s['op'],s['lo'])):
        if not lines or abs(lines[-1][0]['y']-segment['y'])>1.5:lines.append([segment])
        else:lines[-1].append(segment)
    # Preserve original superscript transforms, associating them with the next row.
    result=[];index=0
    while index<len(lines):
        line=lines[index]
        if index+1<len(lines):
            following=lines[index+1];height=max(s['height'] for s in following)
            if max(s['height'] for s in line)<=height*.85 and 0<line[0]['y']-following[0]['y']<=height*.75:
                result.append(line+following);index+=2;continue
        result.append(line);index+=1
    return result


def _joined(cell):return ' '.join(s['text'] for s in cell).strip()


def _cell_line(line,starts):
    cells=[[] for _ in starts]
    for s in line:
        column=max((i for i,x in enumerate(starts) if s['x']>=x-2),default=-1)
        if column<0 or column+1<len(starts) and s['right']>starts[column+1]-2:return None
        cells[column].append(s)
    if any(cell and abs(min(s['x'] for s in cell)-starts[i])>12 for i,cell in enumerate(cells)):return None
    return [sorted(cell,key=lambda s:(s['x'],-s['y'],s['op'],s['lo'])) for cell in cells]


def _containers(identifiers,tags,nodes):
    owners=set(identifiers);tops={};lists={};row_lists={}
    for identifier in identifiers:
        tag=tags[identifier]
        if tag['role']=='P':tops[identifier]=tag['parentId'];continue
        item_id=tag.get('parentId');item=tags.get(item_id)
        list_id=item.get('parentId') if item else None;outer=tags.get(list_id)
        if not item or item['role']!='LI' or not outer or outer['role']!='L':return None
        top=nodes[list_id]
        if set(top)-(b.SIMPLE_KEYS|{'/ID'}) or set(nodes[item_id])-(b.SIMPLE_KEYS|{'/ID'}):return None
        attr=v.resolved(top.get('/A',{}))
        if attr and (not isinstance(attr,dict) or set(attr)!={'/O','/ListNumbering'} or attr.get('/O')!='/List' or attr.get('/ListNumbering')!='/None'):return None
        if nodes[item_id].get('/A'):return None
        tops[list_id]=outer['parentId'];lists.setdefault(list_id,set()).add(item_id);row_lists[identifier]=item_id
    parents=set(tops.values())
    if len(parents)!=1:return None
    parent_id=next(iter(parents));parent=nodes.get(parent_id)
    if parent is None or parent.get('/S') not in ('/Document','/Sect','/Part','/Div','/Art'):return None
    for list_id,items in lists.items():
        children=b._children(nodes[list_id])
        if len(children)!=len(items) or {id(v.resolved(c)) for c in children}!={id(nodes[i]) for i in items}:return None
        for item_id in items:
            leaves=b._children(nodes[item_id]);leaf_ids={i for i in owners if tags[i].get('parentId')==item_id}
            if not leaves or len(leaf_ids)!=len(leaves) or any(v.resolved(leaf).get('/S') not in ('/Lbl','/LBody') for leaf in leaves):return None
    siblings=b._children(parent);top_nodes={id(nodes[i]) for i in tops}
    positions=[i for i,child in enumerate(siblings) if id(v.resolved(child)) in top_nodes]
    if len(positions)!=len(tops) or positions!=list(range(min(positions),max(positions)+1)):return None
    return {'parentId':parent_id,'tops':list(tops),'lists':{key:sorted(value) for key,value in lists.items()},
            'rowLists':row_lists,'participants':list(dict.fromkeys([*identifiers,*tops,*(i for values in lists.values() for i in sorted(values))]))}


def _discover(reader, *, _inspection=None):
    if _inspection is not None:_require(type(_inspection) is b._DiscoveryInspection)
    inventory=_inspection.copy_for(reader) if _inspection is not None else v.structure_inventory(reader)
    tags={tag['id']:tag for tag in inventory['tags']};nodes=_node_map(None,reader);eligible={}
    for identifier,tag in tags.items():
        node=nodes[identifier];sequence=tag.get('contentSequence',[])
        if (tag['role'] not in ('P','Lbl','LBody') or tag['role']!=tag['sourceRole'] or tag.get('attributeGaps')
                or tag.get('textIncomplete') or tag.get('attributes') or set(node)-(b.SIMPLE_KEYS|{'/ID'}) or not sequence
                or any(item.get('kind')!='markedContent' or not item.get('resolved') or not item.get('parentTreeVerified') or 'streamId' in item for item in sequence)
                or len({item.get('pageNumber') for item in sequence})!=1):continue
        content=b._children(node)
        if len(content)!=len(sequence) or any(v.integer(value)!=item['mcid'] for value,item in zip(content,sequence)):continue
        current,seen=node,set()
        while isinstance(current,dict) and '/S' in current:
            if id(current) in seen or any(key in current for key in ('/Alt','/ActualText','/E')):break
            seen.add(id(current));current=v.resolved(current.get('/P'))
        else:eligible[identifier]=tag
    captions=[tag for tag in eligible.values() if tag['role']=='P' and re.match(r'^Table\s+(?:\d+|[IVX]+)[. :]', ' '.join(tag.get('text','').split()),re.I)]
    candidates=[];source_hash=b.source_digest(reader)
    for page_number,page in enumerate(reader.pages,1):
        page_captions=[tag for tag in captions if tag['contentSequence'][0]['pageNumber']==page_number]
        if not page_captions:continue
        owners={item['mcid']:identifier for identifier,tag in eligible.items() for item in tag['contentSequence'] if item['pageNumber']==page_number}
        operations=v.operations(page)
        if len(operations)>MAX_PAGE_OPERATIONS:continue
        segments,scopes=_segments(reader,page,operations,owners)
        for segment in segments:segment['text']=_text(reader,page,segment['font'],segment['size'],segment['pieces'])
        lines=_lines([s for s in segments if s['text']])
        for caption in page_captions:
            caption_segments=[s for s in segments if s['owner']==caption['id']]
            if not caption_segments:continue
            bottom=min(s['y'] for s in caption_segments)
            below=[line for line in lines if max(s['y'] for s in line)<bottom-3]
            if not below or bottom-max(s['y'] for s in below[0])>50:continue
            first=sorted(below[0],key=lambda s:s['x']);cells=[]
            for segment in first:
                if not cells or segment['x']-max(s['right'] for s in cells[-1])>max(16,segment['height']*1.7):cells.append([segment])
                else:cells[-1].append(segment)
            if not 3<=len(cells)<=MAX_COLUMNS or any(not any(c.isalpha() for c in _joined(cell)) for cell in cells):continue
            starts=[min(s['x'] for s in cell) for cell in cells]
            if any(right-left<30 for left,right in zip(starts,starts[1:])):continue
            rows=[{'kind':'header','cells':cells,'y':min(s['y'] for s in first)}]
            header_owners={s['owner'] for s in first};safe=True;header_lines=1
            for line in below[1:]:
                baseline=min(s['y'] for s in line);height=max(s['height'] for s in line);gap=rows[-1]['y']-baseline
                if gap<=0:safe=False;break
                row_step=rows[-2]['y']-rows[-1]['y'] if len(rows)>=3 else 0
                limit=max(height*2.5,row_step*1.8) if row_step else max(height*2.5,26)
                if gap>limit:break
                cells=_cell_line(line,starts)
                if cells is None:
                    if len(rows)>=3 and len({s['owner'] for s in line})==1 and len(line)<=3 and min(s['x'] for s in line)<starts[0]+12:break
                    safe=False;break
                wrapped_suffix=(not cells[0] and not cells[1] and
                    all(any(char.isalpha() for char in _joined(cell)) for cell in cells if cell) and
                    all(s['font'] in {header['font'] for header in first} for s in line))
                if len(rows)==1 and ({s['owner'] for s in line}<=header_owners or wrapped_suffix):
                    if header_lines>=3 or gap>height*1.75:safe=False;break
                    for column,cell in enumerate(cells):rows[0]['cells'][column].extend(cell)
                    rows[0]['y']=baseline;header_owners.update(s['owner'] for s in line);header_lines+=1;continue
                if sum(bool(cell) for cell in cells)<2:break
                if cells[0] and rows[-1]['kind']=='data' and rows[-1]['cells'][0] and _joined(cells[0]).startswith('('):
                    rows[-1]['cells'][0].extend(cells[0]);cells[0]=[]
                rows.append({'kind':'data','cells':cells,'y':baseline})
                if len(rows)>MAX_ROWS:safe=False;break
            if not safe or len(rows)<3 or any(not cell for cell in rows[0]['cells']):continue
            selected_segments=[s for row in rows for cell in row['cells'] for s in cell];touched={s['mcid'] for s in selected_segments};selected_ops={s['op'] for s in selected_segments}
            if any(mcid not in scopes or set(scopes[mcid]['shows'])-selected_ops or any(op not in b.TEXT_ONLY|{b'BT',b'ET'} for _,op in operations[scopes[mcid]['start']+1:scopes[mcid]['end']]) for mcid in touched):continue
            identifiers=list(dict.fromkeys(s['owner'] for s in selected_segments))
            if any({item['mcid'] for item in tags[i]['contentSequence']}-touched for i in identifiers):continue
            if {(s['op'],s['lo'],s['hi']) for s in segments if s['mcid'] in touched}!={(s['op'],s['lo'],s['hi']) for s in selected_segments}:continue
            containers=_containers(identifiers,tags,nodes)
            if not containers:continue
            for row in rows:
                items={containers['rowLists'][s['owner']] for cell in row['cells'] for s in cell if s['owner'] in containers['rowLists']}
                if len(items)>1 or items and any(s['owner'] not in containers['rowLists'] for cell in row['cells'] for s in cell):safe=False;break
                row['listItem']=next(iter(items),None)
            if not safe or len({row['listItem'] for row in rows if row['listItem']})!=sum(bool(row['listItem']) for row in rows):continue
            def numeric(cell):
                height=max(s['height'] for s in cell)
                plain=_joined([s for s in cell if s['height']>=height*.85])
                return bool(re.match(r'^[<>=+\-\u2013\u2212,.(%]*\d',plain))
            counts=[sum(bool(row['cells'][c]) for row in rows[1:]) for c in range(len(starts))]
            numeric_counts=[sum(numeric(row['cells'][c]) for row in rows[1:] if row['cells'][c]) for c in range(len(starts))]
            first_data=next((c for c in range(1,len(starts)) if counts[c]>=2 and numeric_counts[c]/counts[c]>=.75),None)
            if first_data is None or first_data>2 or len(starts)-first_data<2:continue
            spans={};active=None
            if first_data==2:
                for index,row in enumerate(rows[1:],1):
                    if row['cells'][0]:active=index;spans[index]=1
                    elif active is not None:spans[active]+=1
                    else:safe=False;break
            if not safe:continue
            preview='\n'.join(row['kind']+': '+' | '.join(_joined(cell) for cell in row['cells']) for row in rows)
            public={'kind':'rebuild_grid_table','tagId':identifiers[0],'pageNumber':page_number,'text':'\n'.join(tags[i]['text'] for i in identifiers)[:20000],
                    'preview':preview[:20000],'relatedTagIds':[i for i in containers['participants'] if i!=identifiers[0]]}
            detail={'rows':rows,'owners':identifiers,**containers,'rowHeaderColumns':first_data,'rowSpans':spans,
                    'scopes':{mcid:scopes[mcid] for mcid in touched},'backgrounds':_verified_background(reader,page_number,operations,rows)}
            public['candidateId']=hashlib.sha256(json.dumps({'source':source_hash,**public,'cells':[[[(s['op'],s['lo'],s['hi'],s['mcid'],s['owner']) for s in cell] for cell in row['cells']] for row in rows]},sort_keys=True).encode()).hexdigest()
            candidates.append((public,detail))
            if len(candidates)>=MAX_TABLES:return candidates,inventory,nodes
    return candidates,inventory,nodes


def discover_candidates(reader, *, _inspection=None):
    try:
        return [public for public,_ in _discover(reader,_inspection=_inspection)[0]]
    except (ValueError,TypeError,KeyError,IndexError,AttributeError):
        return []


class _TableProof:
    def __init__(self): self.tables=[]


def _current_detail(source_reader, writer, page_number, detail, operations):
    """Relocate unchanged source scopes after unrelated, verified tag edits.

    Earlier semantic repairs can add MCID wrappers elsewhere on this page.
    Every participating table scope must still have its exact original local
    program, text bytes and geometry; only its position in the stream may move.
    """
    source_page = source_reader.pages[page_number-1]
    page = writer.pages[page_number-1]
    original = v.operations(source_page)
    source_canonical = v.Canonicalizer(list(source_reader.pages))
    target_canonical = v.Canonicalizer(list(writer.pages))
    _require(v.drawing_fingerprint(original, source_canonical) ==
             v.drawing_fingerprint(operations, target_canonical))
    _require(source_canonical.hash(source_page.get('/Resources', {})) ==
             target_canonical.hash(page.get('/Resources', {})))
    source_segments = [segment for row in detail['rows'] for cell in row['cells'] for segment in cell]
    owners = {segment['mcid']: segment['owner'] for segment in source_segments}
    segments, scopes = _segments(writer, page, operations, owners)
    for mcid, before in detail['scopes'].items():
        after = scopes.get(mcid)
        _require(after is not None)
        _require(b.raw([(args, op.decode()) for args, op in
            original[before['start']:before['end']+1]]) == b.raw([(args, op.decode()) for args, op in
            operations[after['start']:after['end']+1]]))
    def key(segment, source_scopes):
        return (segment['mcid'], segment['op']-source_scopes[segment['mcid']]['start'],
                segment['lo'], segment['hi'])
    current = {key(segment, scopes): segment for segment in segments}
    expected = {key(segment, detail['scopes']) for segment in source_segments}
    _require(set(current) == expected)
    remapped = {**detail, 'scopes': {mcid:scopes[mcid] for mcid in detail['scopes']}, 'rows': [], 'backgrounds': []}
    if detail['backgrounds']:
        current_backgrounds=_background_blocks(page,operations)
        for expected_background in detail['backgrounds']:
            matches=[block for block in current_backgrounds if _background_identity(block)==_background_identity(expected_background)]
            _require(len(matches)==1);remapped['backgrounds'].append(matches[0])
    for row in detail['rows']:
        cells = []
        for cell in row['cells']:
            changed = []
            for before in cell:
                after = current[key(before, detail['scopes'])]
                _require(all(abs(before[name]-after[name]) < 1e-7 for name in ('x','right','y','height','size')))
                _require(before['owner'] == after['owner'] and before['font'] == after['font']
                         and b.raw(before['pieces']) == b.raw(after['pieces']))
                changed.append({**before, 'op':after['op']})
            cells.append(changed)
        remapped['rows'].append({**row, 'cells':cells})
    return remapped


def _local_shape(node, node_map, pages):
    """Bind native metadata and K relationships without following P cycles.

    Following a child's P back to the document would bind unrelated paragraph
    roles. Each participating child is checked separately; its reference here
    must retain exactly the same source identity.
    """
    identities = {id(value): key for key, value in node_map.items()}
    def content(value):
        value = v.resolved(value)
        if isinstance(value, DictionaryObject) and value.get('/Type') == '/StructElem':
            identifier = identities.get(id(value))
            _require(identifier is not None)
            return ('tag', identifier)
        if isinstance(value, ArrayObject):
            return ('array', tuple(content(item) for item in value))
        return ('content', t._MetadataCanonicalizer(pages).hash(value))
    return t._metadata(node, pages), '/K' in node, content(node.get('/K'))


def apply_operations(source_reader, writer, operations, *, _inspection=None, _source_nodes=None, _target_nodes=None):
    _require(isinstance(operations,list) and len(operations)<=MAX_TABLES)
    discovered,inventory,default_nodes = _discover(source_reader,_inspection=_inspection)
    source_nodes = _node_map(_source_nodes,source_reader) if _source_nodes is not None else default_nodes
    targets = _node_map(_target_nodes,writer)
    options = {public['candidateId']:(public,detail) for public,detail in discovered}
    root=writer.root_object['/StructTreeRoot']; id_entries=v.structure_id_tree(root)
    # Rebuilding an index must not discard private authored extension metadata.
    pending=[v.resolved(root['/IDTree'])] if '/IDTree' in root else []
    while pending:
        item=pending.pop(); _require(not set(item)-{'/Names','/Kids','/Limits'})
        pending.extend(v.resolved(child) for child in v.resolved(item.get('/Kids',[])))
    selected,used=[],set()
    for operation in operations:
        _require(isinstance(operation,dict) and set(operation)=={'type','tagId','candidateId'} and operation.get('type')=='repair_structure' and operation.get('candidateId') in options)
        public,detail=options[operation['candidateId']]
        _require(operation['tagId']==public['tagId'] and not used.intersection(detail['participants']))
        used.update(detail['participants'])
        for identifier in detail['participants']:
            _require(identifier in targets and identifier in source_nodes)
            old,new=source_nodes[identifier],targets[identifier]
            _require(_local_shape(old, source_nodes, source_reader.pages) ==
                     _local_shape(new, targets, writer.pages))
            old_parent = next((key for key,node in source_nodes.items() if node is v.resolved(old['/P'])), None)
            _require(old_parent in targets and v.resolved(new['/P']) is targets[old_parent])
        selected.append((public,detail))
    changes=[]; lineage=[{'node':node,'sourceTagId':identifier} for identifier,node in targets.items()]
    proof=_TableProof()
    for public,detail in selected:
        page_number=public['pageNumber']; page=writer.pages[page_number-1]
        ops=v.operations(page)
        detail=_current_detail(source_reader,writer,page_number,detail,ops)
        parent=targets[detail['parentId']]; siblings=b._children(parent)
        parent_tree=v.number_tree(root.get('/ParentTree')); array=parent_tree.get(v.integer(page.get('/StructParents')))
        _require(isinstance(array,ArrayObject))
        def new(role,parent,source_id,content=None):
            node=b._new_tag(writer,role,parent,page,ArrayObject() if content is None else content)
            lineage.append({'node':node,'sourceTagId':source_id});return node
        table=new('Table',parent,public['tagId'])
        table_id=('acccp-table-'+public['candidateId'][:20]).encode()
        while any(bytes.fromhex(identifier)==table_id or bytes.fromhex(identifier).startswith(table_id+b'-')
                  for identifier in id_entries):table_id+=b'-x'
        table[N('/ID')]=ByteStringObject(table_id);id_entries[table_id.hex()]=table
        insertion=min(i for i,item in enumerate(siblings) if any(v.resolved(item) is targets[identifier] for identifier in detail['tops']))
        kept=[item for item in siblings if not any(v.resolved(item) is targets[identifier] for identifier in detail['tops'])]
        kept.insert(insertion,table.indirect_reference);parent[N('/K')]=ArrayObject(kept)
        reused=set();replacements={};removed=set();allocated=0
        original_ids=set(detail['scopes']);next_mcid=max(len(array),max(original_ids,default=-1)+1)
        used_old=set();expected_rows=[];expected_row_metadata=[];expected_members={}
        top_headers=[];active_group=None;row_nodes=[];list_bodies={};body_rows={};expected_bodies=[]
        for list_id in detail['lists']:
            body=targets[list_id];body[N('/S')]=N('/TBody');body[N('/P')]=table.indirect_reference
            body.pop('/A',None);list_bodies[list_id]=body;body_rows[list_id]=[]
        for row_index,row in enumerate(detail['rows']):
            source_id=next(s['owner'] for cell in row['cells'] for s in cell)
            list_item=row['listItem']
            if list_item:
                list_id=next(identifier for identifier,items in detail['lists'].items() if list_item in items)
                body=list_bodies[list_id];row_node=targets[list_item]
                row_node[N('/S')]=N('/TR');row_node[N('/P')]=body.indirect_reference
                body_rows[list_id].append(row_node.indirect_reference)
                if not any(v.resolved(value) is body for value in row_nodes):row_nodes.append(body.indirect_reference)
            else:
                row_node=new('TR',table,source_id);row_nodes.append(row_node.indirect_reference)
            cell_nodes=[];expected_cells=[];row_headers=[]
            if row['kind']=='data' and row['cells'][0]:active_group=None
            for column,segments in enumerate(row['cells']):
                if row['kind']=='data' and column==0 and not segments and detail['rowHeaderColumns']==2:
                    _require(active_group is not None);row_headers.append(active_group);continue
                owner=segments[0]['owner'] if segments else source_id
                header=row['kind']=='header' or column<detail['rowHeaderColumns'] and bool(segments)
                cell=new('TH' if header else 'TD',row_node,owner)
                attrs=DictionaryObject({N('/O'):N('/Table')})
                if header:attrs[N('/Scope')]=N('/Column' if row['kind']=='header' else '/Row')
                span=detail['rowSpans'].get(row_index,1) if column==0 else 1
                if span>1:attrs[N('/RowSpan')]=I(span)
                identifier=table_id+b'-r'+str(row_index).encode()+b'-c'+str(column).encode()
                headers=[] if row['kind']=='header' else [top_headers[column],*row_headers]
                if headers:attrs[N('/Headers')]=ArrayObject([ByteStringObject(value) for value in headers])
                cell[N('/A')]=attrs
                if header:
                    cell[N('/ID')]=ByteStringObject(identifier);id_entries[identifier.hex()]=cell
                    if row['kind']=='header':top_headers.append(identifier)
                    else:
                        row_headers.append(identifier)
                        if column==0:active_group=identifier
                leaves=[];leaf_mcids=[];expected_leaves=[]
                for owner in dict.fromkeys(s['owner'] for s in segments):
                    owned=[s for s in segments if s['owner']==owner]
                    if owner not in reused:
                        leaf=targets[owner];reused.add(owner);leaf[N('/S')]=N('/P');leaf[N('/P')]=cell.indirect_reference
                    else:
                        leaf=new('P',cell,owner)
                        if '/Lang' in source_nodes[owner]:leaf[N('/Lang')]=source_nodes[owner]['/Lang']
                    mcids=[]
                    for segment in owned:
                        old=segment['mcid']
                        if old not in used_old:mcid=old;used_old.add(old)
                        else:mcid=next_mcid;next_mcid+=1;allocated+=1
                        _require(allocated<=MAX_NEW_MCIDS and mcid<=100000)
                        while len(array)<=mcid:array.append(NullObject())
                        array[mcid]=leaf.indirect_reference;mcids.append(mcid);leaf_mcids.append(mcid)
                        expected_members[mcid]=_paint_member(segment)
                        fragment=([ArrayObject([b._freeze(piece) for piece in segment['pieces']])],b'TJ')
                        replacements.setdefault(segment['op'],[]).append((segment['lo'],[
                            ([N('/P'),DictionaryObject({N('/MCID'):I(mcid)})],b'BDC'),fragment,([],b'EMC')]))
                    leaf[N('/K')]=ArrayObject([I(mcid) for mcid in mcids]);leaves.append(leaf.indirect_reference)
                    expected_leaves.append({'metadata':_metadata(leaf,list(writer.pages)),'mcids':list(mcids)})
                cell[N('/K')]=ArrayObject(leaves);cell_nodes.append(cell.indirect_reference)
                expected_cells.append({'role':'TH' if header else 'TD','scope':str(attrs.get('/Scope','')),
                    'colSpan':1,'rowSpan':span,'headers':[value.hex() for value in headers],
                    'id':identifier.hex() if header else None,'mcids':leaf_mcids,
                    'text':' '.join(s['text'] for owner in dict.fromkeys(s['owner'] for s in segments) for s in segments if s['owner']==owner),
                    'metadata':_metadata(cell,list(writer.pages)),'leaves':expected_leaves})
            row_node[N('/K')]=ArrayObject(cell_nodes);expected_rows.append(expected_cells)
            expected_row_metadata.append(_metadata(row_node,list(writer.pages)))
        for list_id,body in list_bodies.items():
            body[N('/K')]=ArrayObject(body_rows[list_id]);expected_bodies.append(_metadata(body,list(writer.pages)))
        table[N('/K')]=ArrayObject(row_nodes)
        for scope in detail['scopes'].values():removed.update((scope['start'],scope['end']))
        changed=[]
        background_starts={block['start'] for block in detail['backgrounds']}
        background_ends={block['end'] for block in detail['backgrounds']}
        for index,(args,op) in enumerate(ops):
            if index in background_starts:changed.append(([N('/Artifact')],b'BMC'))
            if index in removed:continue
            if index in replacements:
                for _,sequence in sorted(replacements[index]):changed.extend(sequence)
            else:changed.append(([b._freeze(arg) for arg in args] if op in b.SHOW else args,op))
            if index in background_ends:changed.append(([],b'EMC'))
        _require(v.drawing_fingerprint(ops,v.Canonicalizer(list(writer.pages)))==v.drawing_fingerprint(changed,v.Canonicalizer(list(writer.pages))))
        stream=ContentStream(None,writer);stream.operations=changed;page[N('/Contents')]=writer._add_object(stream)
        proof.tables.append({'id':table_id.hex(),'pageNumber':page_number,'rows':expected_rows,
            'metadata':_metadata(table,list(writer.pages)), 'rowMetadata':expected_row_metadata, 'bodyMetadata':expected_bodies,
            'layout':[(str(v.resolved(child)['/S'])[1:],len(b._children(v.resolved(child))) if v.resolved(child)['/S']=='/TBody' else 1) for child in row_nodes],
            'members':expected_members,'backgrounds':[_background_identity(block) for block in detail['backgrounds']]})
        changes.append({'code':'rebuild_grid_table','tagId':public['tagId'],'pageNumber':page_number,
            'candidateId':public['candidateId'],'relatedTagIds':public['relatedTagIds'],
            'message':'Rebuilt the existing table rows, cells and header relationships without changing the visible content.'})
    if selected:
        root[N('/IDTree')]=writer._add_object(DictionaryObject({N('/Names'):ArrayObject([
            value for identifier,node in sorted(id_entries.items()) for value in (ByteStringObject(bytes.fromhex(identifier)),b._reference(writer,node))])}))
    return {'changes':changes,'lineage':lineage,'verification':proof}


def verify_saved(reader, verification, *, _inspection=None):
    _require(type(verification) is _TableProof)
    if _inspection is not None:_require(type(_inspection) is b._DiscoveryInspection)
    inventory=_inspection.copy_for(reader) if _inspection is not None else v.structure_inventory(reader)
    tags={tag['id']:tag for tag in inventory['tags']}
    native_nodes=b.nodes(reader);_require(len(native_nodes)==len(tags))
    native={identifier:node for identifier,node in zip(tags,native_nodes)}
    pages=list(reader.pages)
    by_native={tag.get('nativeIdHex'):tag for tag in tags.values() if 'nativeIdHex' in tag}
    def children(tag):
        sequence=tag.get('contentSequence',[])
        _require(all(item.get('kind')=='childTag' and item.get('resolved') for item in sequence))
        result=[tags[item['tagId']] for item in sequence]
        _require(all(child['parentId']==tag['id'] for child in result))
        _require(all(v.resolved(native[child['id']].get('/P')) is native[tag['id']] for child in result))
        return result
    for expected in verification.tables:
        table=by_native.get(expected['id']);_require(table is not None and table['role']=='Table' and table.get('idTreeVerified'))
        _require(table.get('parentId') in native and
                 v.resolved(native[table['id']].get('/P')) is native[table['parentId']])
        _require(_metadata(native[table['id']],pages)==expected['metadata'])
        direct=children(table);bodies=[node for node in direct if node['role']=='TBody']
        _require([(node['role'],len(children(node)) if node['role']=='TBody' else 1) for node in direct]==expected['layout'])
        _require([_metadata(native[node['id']],pages) for node in bodies]==expected['bodyMetadata'])
        rows=[row for node in direct for row in (children(node) if node['role']=='TBody' else [node])]
        _require(len(rows)==len(expected['rows']))
        owners={}
        for row,wanted_cells,wanted_row_metadata in zip(rows,expected['rows'],expected['rowMetadata']):
            _require(_metadata(native[row['id']],pages)==wanted_row_metadata)
            _require(row['role']=='TR');cells=children(row);_require(len(cells)==len(wanted_cells))
            for cell,wanted in zip(cells,wanted_cells):
                _require(_metadata(native[cell['id']],pages)==wanted['metadata'])
                _require(cell['role']==wanted['role'] and not cell.get('attributeGaps'))
                attrs=[a for a in cell.get('attributes',[]) if a.get('owner')=='Table']
                _require(len(attrs)==1);attr=attrs[0]
                _require('/'+attr.get('scope','')==wanted['scope'] if wanted['scope'] else not attr.get('scope'))
                _require(attr.get('colSpan',1)==wanted['colSpan'] and attr.get('rowSpan',1)==wanted['rowSpan'] and attr.get('headersHex',[])==wanted['headers'])
                _require(cell.get('nativeIdHex')==wanted['id'])
                leaves=children(cell);marks=[part for leaf in leaves for part in leaf.get('contentSequence',[])]
                _require(len(leaves)==len(wanted['leaves']))
                for leaf,wanted_leaf in zip(leaves,wanted['leaves']):
                    _require(_metadata(native[leaf['id']],pages)==wanted_leaf['metadata'])
                    _require([part.get('mcid') for part in leaf.get('contentSequence',[])]==wanted_leaf['mcids'])
                    for mcid in wanted_leaf['mcids']:
                        _require(mcid not in owners);owners[mcid]=leaf['id']
                _require(all(leaf['role']=='P' and not leaf.get('textIncomplete') for leaf in leaves))
                _require(all(part.get('kind')=='markedContent' and part.get('resolved') and part.get('parentTreeVerified') and part.get('pageNumber')==expected['pageNumber'] for part in marks))
                _require([part['mcid'] for part in marks]==wanted['mcids'])
                _require(' '.join(' '.join(leaf.get('text','') for leaf in leaves).split())==wanted['text'])
                for identifier in wanted['headers']:
                    target=by_native.get(identifier)
                    _require(target is not None and target['role']=='TH' and target.get('idTreeVerified'))
                    header_row=tags.get(target['parentId'])
                    _require(header_row is not None and header_row['role']=='TR' and (header_row['parentId']==table['id'] or tags[header_row['parentId']]['role']=='TBody' and tags[header_row['parentId']]['parentId']==table['id']))
        page=reader.pages[expected['pageNumber']-1];operations=v.operations(page)
        if expected['backgrounds']:
            backgrounds=_background_blocks(page,operations,artifact=True)
            for wanted_background in expected['backgrounds']:
                _require(len([block for block in backgrounds if _background_identity(block)==wanted_background])==1)
        segments,scopes=_segments(reader,page,operations,owners)
        _require(len(segments)==len(expected['members']) and set(scopes)==set(expected['members']))
        seen=set()
        for segment in segments:
            mcid=segment['mcid'];_require(mcid not in seen and mcid in expected['members']);seen.add(mcid)
            scope=scopes[mcid]
            _require(scope['end']==scope['start']+2 and scope['shows']==[scope['start']+1])
            args,operator=operations[scope['start']]
            _require(args[0]=='/P' and operator==b'BDC')
            _require(_same_paint_member(_paint_member(segment),expected['members'][mcid]))
    return True
