"""Recover source-bound two-column tables without reconstructing their pages.

Candidates require repeated, aligned cells already separated by explicit PDF
spacing. A model can select a candidate, but cannot supply rows, text or offsets.
Every original text byte, spacing adjustment and native node remains present.
"""
from __future__ import annotations

import copy
import hashlib
import json
import math
import re

import pypdfium2 as pdfium
import pypdfium2.raw as pdfium_raw

from pypdf.generic import (ArrayObject, ByteStringObject, ContentStream,
    DictionaryObject, NameObject as N, NullObject, NumberObject as I, TextStringObject)

import bounded_semantic_structure as b
import verify_pdf as v

MAX_TABLES = 8
MAX_ROWS = 60
MAX_PAGE_OPERATIONS = 100_000
MAX_SEGMENTS = 4000
MAX_NEW_MCIDS = 1000
MAX_BACKGROUND_OBJECTS = 100_000


def _require(value):
    if not value:
        raise b.SemanticStructureError('native_pdf_invalid_plan')


def _raw_bytes(value):
    return value.original_bytes if hasattr(value, 'original_bytes') else bytes(value)


def _mm(a, c):
    return (a[0]*c[0]+a[1]*c[2], a[0]*c[1]+a[1]*c[3],
            a[2]*c[0]+a[3]*c[2], a[2]*c[1]+a[3]*c[3],
            a[4]*c[0]+a[5]*c[2]+c[4], a[4]*c[1]+a[5]*c[3]+c[5])


def _translate(matrix, x, y):
    return (*matrix[:4], matrix[4]+x*matrix[0]+y*matrix[2], matrix[5]+x*matrix[1]+y*matrix[3])


def _text(reader, page, font, size, pieces):
    page = copy.copy(page)
    operations = [([], b'BT'), ([font, size], b'Tf'),
                  ([1, 0, 0, 1, 0, 0], b'Tm'), ([ArrayObject(pieces)], b'TJ'), ([], b'ET')]
    page[N('/Contents')] = v.extraction_stream(operations, reader, page.get('/Resources', {}))
    return ' '.join((page.extract_text() or '').split())


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
                        and ends[offset]-positions[offset] >= max(20., size*physical[3]*4)
                        and any(isinstance(p, (str, bytes)) and _raw_bytes(p) for p in pieces[offset+1:])):
                    cuts.append(offset)
            cuts.append(len(pieces))
            if len(cuts) > 3: continue
            for lo, hi in zip(cuts, cuts[1:]):
                strings = [offset for offset in range(lo, hi) if isinstance(pieces[offset], (str, bytes)) and _raw_bytes(pieces[offset])]
                if not strings: continue
                output.append({'op': index, 'lo': lo, 'hi': hi, 'mcid': stack[-1]['mcid'],
                    'owner': owners[stack[-1]['mcid']], 'x': positions[strings[0]],
                    'right': ends[strings[-1]], 'y': physical[5], 'height': size*physical[3],
                    'font': font, 'size': size, 'pieces': pieces[lo:hi], 'paired': len(cuts) == 3,
                    'bold': bool(re.search(r'Bold|Black|Demi|Heavy|Medium|[-,]Bd(?:It)?$', str(resource.get('/BaseFont','')), re.I))})
                if len(output) > MAX_SEGMENTS: return [], {}
    if stack or saved: return [], {}
    return output, scopes


def _node_map(value, reader):
    if value is None: return {f'tag-{i+1}': node for i, node in enumerate(b.nodes(reader))}
    return value if isinstance(value, dict) else {f'tag-{i+1}': node for i, node in enumerate(value)}


def _constant_light_shading(resource):
    """A single constant, pale device color; gradients and opaque functions decline."""
    resource=v.resolved(resource)
    if (not isinstance(resource,dict) or set(resource)-{'/ShadingType','/ColorSpace','/Coords','/Function','/Domain','/Extend'}
            or resource.get('/ShadingType')!=2 or list(resource.get('/Domain',[0,1]))!=[0,1]):return False
    count={'/DeviceGray':1,'/DeviceRGB':3,'/DeviceCMYK':4}.get(str(resource.get('/ColorSpace')))
    if count is None:return False
    function=v.resolved(resource.get('/Function'))
    if not isinstance(function,dict) or list(function.get('/Domain',[]))!=[0,1]:return False
    if function.get('/FunctionType')==0:
        allowed={'/FunctionType','/Domain','/Range','/Size','/BitsPerSample','/Order','/Encode','/Decode',
                 '/Length','/Filter','/DecodeParms'}
        sizes=list(function.get('/Size',[]));bits=function.get('/BitsPerSample')
        limits=[number for _ in range(count) for number in (0,1)]
        if (set(function)-allowed or len(sizes)!=1 or not 1<=sizes[0]<=256
                or bits not in (8,16,24,32) or function.get('/Order',1) not in (1,3)
                or list(function.get('/Range',[]))!=limits or list(function.get('/Decode',limits))!=limits
                or list(function.get('/Encode',[0,sizes[0]-1]))!=[0,sizes[0]-1]
                or not hasattr(function,'get_data')):return False
        data=function.get_data();width=int(bits)//8;stride=width*count
        if len(data)!=sizes[0]*stride or any(data[start:start+stride]!=data[:stride]
                for start in range(stride,len(data),stride)):return False
        colors=[int.from_bytes(data[i:i+width],'big')/((1<<int(bits))-1) for i in range(0,stride,width)]
    elif function.get('/FunctionType')==2:
        if (set(function)-{'/FunctionType','/Domain','/Range','/C0','/C1','/N'}
                or list(function.get('/C0',[]))!=list(function.get('/C1',[]))
                or len(function.get('/C0',[]))!=count or float(function.get('/N',0))<=0):return False
        if '/Range' in function and list(function['/Range'])!=[n for _ in range(count) for n in (0,1)]:return False
        colors=list(map(float,function['/C0']))
    else:return False
    if not all(math.isfinite(c) and 0<=c<=1 for c in colors):return False
    rgb=colors*3 if count==1 else [(1-c)*(1-colors[3]) for c in colors[:3]] if count==4 else colors
    return min(rgb)>=.8 and max(rgb)-min(rgb)<=.12


def _safe_background_state(state):
    for key,value in state.items():
        if key=='/Type' and value=='/ExtGState':continue
        if key in ('/OP','/op','/AIS') and type(value).__name__=='BooleanObject' and not value.value:continue
        if key=='/SA' and type(value).__name__=='BooleanObject':continue
        if key in ('/BG2','/UCR2') and value=='/Default':continue
        if key=='/OPM' and value in (0,1):continue
        if key=='/SM' and isinstance(value,(float,int)) and 0<=value<=1:continue
        if key in ('/ca','/CA') and value==1:continue
        if key=='/BM' and value=='/Normal':continue
        if key=='/SMask' and value=='/None':continue
        return False
    return True


def _background_blocks(page, operations, *, artifact=False):
    """Recognize self-contained rectangle-clipped constant fills, never arbitrary paint."""
    resources=v.resolved(page.get('/Resources',{}));shadings=v.resolved(resources.get('/Shading',{}))
    states=v.resolved(resources.get('/ExtGState',{}));spaces=v.resolved(resources.get('/ColorSpace',{}))
    if any(key in spaces for key in ('/DefaultGray','/DefaultRGB','/DefaultCMYK')):return []
    cm=(1.,0.,0.,1.,0.,0.);graphics={};clipped=False;in_text=False;pending_path=False;stack=[];marks=[];result=[]
    for index,(args,operator) in enumerate(operations):
        if operator in (b'BMC',b'BDC'):marks.append((index,args,operator))
        elif operator==b'EMC':
            if not marks:return []
            marks.pop()
        elif operator==b'BT':in_text=True
        elif operator==b'ET':in_text=False
        # The current path is not part of the q/Q graphics-state stack. An
        # inherited path would join this block's rectangle when W applies.
        elif operator in (b'm',b'l',b'c',b'v',b'y',b'h',b're'):pending_path=True
        elif operator in (b'S',b's',b'f',b'F',b'f*',b'B',b'B*',b'b',b'b*',b'n'):pending_path=False
        elif operator==b'q':stack.append((index,cm,dict(graphics),clipped,in_text,list(marks),pending_path))
        elif operator==b'cm':
            if len(args)!=6:return []
            cm=_mm(tuple(map(float,args)),cm)
        elif operator==b'gs':
            if len(args)!=1 or args[0] not in states:return []
            state=v.resolved(states[args[0]])
            if not isinstance(state,dict):return []
            graphics.update(state)
        elif operator in (b'W',b'W*'):clipped=True
        elif operator==b'Q':
            if not stack:return []
            start,before_matrix,before_state,before_clip,before_text,before_marks,before_path=stack.pop()
            cm,graphics,clipped=before_matrix,before_state,before_clip
            if before_clip or before_text or before_path or len(operations[start:index+1])>25 or not _safe_background_state(before_state):continue
            if artifact:
                if (len(before_marks)!=1 or before_marks[0]!=(start-1,[N('/Artifact')],b'BMC')
                        or index+1>=len(operations) or operations[index+1]!=([],b'EMC')):continue
            elif before_marks:continue
            if (not all(math.isfinite(n) for n in cm) or abs(cm[1])>1e-8 or abs(cm[2])>1e-8
                    or cm[0]<=0 or cm[3]<=0):continue
            body=operations[start+1:index];rectangles=[];cursor=0;valid=True
            while cursor<len(body) and body[cursor][1]!=b'sh':
                values,op=body[cursor]
                if op==b'i' and len(values)==1 and 0<=float(values[0])<=100:cursor+=1;continue
                if (op!=b're' or len(values)!=4 or cursor+2>=len(body)
                        or body[cursor+1] not in (([],b'W'),([],b'W*')) or body[cursor+2]!=([],b'n')):
                    valid=False;break
                x,y,width,height=map(float,values)
                if not all(math.isfinite(n) for n in (x,y,width,height)) or not width or not height:valid=False;break
                xs=(cm[0]*x+cm[4],cm[0]*(x+width)+cm[4]);ys=(cm[3]*y+cm[5],cm[3]*(y+height)+cm[5])
                rectangles.append((min(xs),min(ys),max(xs),max(ys)));cursor+=3
            if not valid or not 1<=len(rectangles)<=4 or cursor!=len(body)-1:continue
            shade_args,shade_op=body[cursor]
            if shade_op!=b'sh' or len(shade_args)!=1 or shade_args[0] not in shadings:continue
            shading=v.resolved(shadings[shade_args[0]])
            if not _constant_light_shading(shading):continue
            box=(max(r[0] for r in rectangles),max(r[1] for r in rectangles),min(r[2] for r in rectangles),min(r[3] for r in rectangles))
            if box[0]>=box[2] or box[1]>=box[3]:continue
            coords=list(shading.get('/Coords',[]));extend=list(shading.get('/Extend',[]))
            if len(coords)!=4 or extend and len(extend)!=2:continue
            x0,y0,x1,y1=map(float,coords);x0,y0=cm[0]*x0+cm[4],cm[3]*y0+cm[5];x1,y1=cm[0]*x1+cm[4],cm[3]*y1+cm[5]
            length=(x1-x0)**2+(y1-y0)**2
            if not math.isfinite(length) or length<=0:continue
            projections=[((x-x0)*(x1-x0)+(y-y0)*(y1-y0))/length for x in (box[0],box[2]) for y in (box[1],box[3])]
            tolerance=.01/math.sqrt(length)
            if (min(projections)<-tolerance and not (extend and v.pdf_boolean(extend[0]))) or (max(projections)>1+tolerance and not (extend and v.pdf_boolean(extend[1]))):continue
            program=b.raw([(args,op.decode()) for args,op in operations[start:index+1]])
            result.append({'start':start,'end':index,'bounds':box,'program':program,
                'resource':v.Canonicalizer().hash(shading),'matrix':cm,'state':b.raw(before_state)})
    return result if not stack and not marks else []


def _verified_background(reader, page_number, operations, rows):
    segments=[s for row in rows for cell in row['cells'] for s in cell]
    table=(min(s['x'] for s in segments),min(s['y'] for s in segments),
           max(s['right'] for s in segments),max(s['y']+s['height'] for s in segments))
    padding=max(12,max(s['height'] for s in segments)*1.5);owners={s['mcid'] for s in segments}
    options=[]
    for block in _background_blocks(reader.pages[page_number-1],operations):
        x0,y0,x1,y1=block['bounds']
        if (block['end']>=min(s['op'] for s in segments) or not x0-.01<=table[0]<=x0+padding
                or not y0-.01<=table[1]<=y0+padding or not x1-padding<=table[2]<=x1+.01
                or not y1-padding<=table[3]<=y1+.01):continue
        options.append(block)
    if len(options)!=1:return []
    block=options[0];box=block['bounds'];position=reader.stream.tell()
    try:
        reader.stream.seek(0);data=reader.stream.read(v.MAX_FILE_BYTES+1)
    finally:reader.stream.seek(position)
    if len(data)>v.MAX_FILE_BYTES:return []
    # Native object bounds catch foreign text, images and forms that our simple
    # table-font scanner intentionally does not interpret.
    with pdfium.PdfDocument(data) as document:
        page=document[page_number-1]
        try:
            if page.get_rotation()!=0:return []
            for count,item in enumerate(page.get_objects(max_depth=0),1):
                if count>MAX_BACKGROUND_OBJECTS:return []
                bounds=item.get_bounds()
                if not all(math.isfinite(n) for n in bounds):return []
                overlap=min(bounds[2],box[2])-max(bounds[0],box[0])>.01 and min(bounds[3],box[3])-max(bounds[1],box[1])>.01
                if not overlap:continue
                if item.type==pdfium_raw.FPDF_PAGEOBJ_TEXT and pdfium_raw.FPDFPageObj_GetMarkedContentID(item) not in owners:return []
                if item.type in (pdfium_raw.FPDF_PAGEOBJ_IMAGE,pdfium_raw.FPDF_PAGEOBJ_FORM):return []
        finally:page.close()
    return [block]


def _background_identity(block):
    return {key:value for key,value in block.items() if key not in ('start','end')}


def _discover(reader, *, _inspection=None):
    if _inspection is not None and type(_inspection) is not b._DiscoveryInspection:
        _require(False)
    inventory = _inspection.copy_for(reader) if _inspection is not None else v.structure_inventory(reader)
    tags = {tag['id']: tag for tag in inventory['tags']}
    nodes = _node_map(None, reader)
    eligible = {}
    for identifier, tag in tags.items():
        node = nodes[identifier]
        if (tag['role'] != 'P' or tag['sourceRole'] != 'P' or tag.get('attributeGaps')
                or tag.get('textIncomplete') or set(node)-b.SIMPLE_KEYS or tag.get('attributes')
                or not tag.get('contentSequence') or any(item.get('kind') != 'markedContent'
                or not item.get('resolved') or not item.get('parentTreeVerified')
                or 'streamId' in item for item in tag['contentSequence'])):
            continue
        if len({item.get('pageNumber') for item in tag['contentSequence']}) != 1:
            continue
        native_content = b._children(node)
        if (len(native_content) != len(tag['contentSequence']) or any(
                v.integer(native) != item['mcid'] for native,item in zip(native_content,tag['contentSequence']))):
            continue
        current, seen, safe = node, set(), True
        while isinstance(current, dict) and '/S' in current:
            if id(current) in seen or any(key in current for key in ('/ID', '/Alt', '/ActualText', '/E')):
                safe = False; break
            seen.add(id(current)); current = v.resolved(current.get('/P'))
        if safe: eligible[identifier] = tag
    source_hash, candidates = b.source_digest(reader), []
    for page_number, page in enumerate(reader.pages, 1):
        owners = {item['mcid']: identifier for identifier, tag in eligible.items()
                  for item in tag['contentSequence'] if item.get('pageNumber') == page_number}
        if not owners: continue
        operations = v.operations(page)
        if len(operations) > MAX_PAGE_OPERATIONS: continue
        segments, scopes = _segments(reader, page, operations, owners)
        seeds = {}
        for segment in segments:
            if segment['paired']: seeds.setdefault(segment['op'], []).append(segment)
        pairs = sorted([sorted(row, key=lambda s:s['x']) for row in seeds.values() if len(row)==2], key=lambda row:-row[0]['y'])
        groups = []
        for pair in pairs:
            found = next((group for group in groups if abs(group[0][0]['x']-pair[0]['x']) <= 12
                and abs(group[0][1]['x']-pair[1]['x']) <= 14
                and 0 < group[-1][0]['y']-pair[0]['y'] <= 70), None)
            if found is None: groups.append([pair])
            else: found.append(pair)
        for group in groups:
            if not 3 <= len(group) <= MAX_ROWS: continue
            left = min(row[0]['x'] for row in group)
            split = min(row[1]['x'] for row in group)-2
            right = max(row[1]['right'] for row in group)+2
            high, low = group[0][0]['y'], group[-1][0]['y']
            selected = [s for s in segments if low-.5 <= s['y'] <= high+.5
                        and left-2 <= s['x'] < right and s['right'] <= right+1]
            lines = []
            for segment in sorted(selected, key=lambda s:(-s['y'],s['x'],s['op'],s['lo'])):
                if not lines or abs(lines[-1][0]['y']-segment['y']) > 1.5: lines.append([segment])
                else: lines[-1].append(segment)
            rows, safe = [], True
            for line in lines:
                cells = [[s for s in line if s['x'] < split], [s for s in line if s['x'] >= split]]
                if cells[0] and cells[1]:
                    if max(s['right'] for s in cells[0]) > min(s['x'] for s in cells[1])-2: safe=False; break
                    rows.append({'kind':'data', 'cells':cells, 'y':line[0]['y']})
                elif cells[0] and rows and rows[-1]['kind']=='data' and rows[-1]['y']-line[0]['y'] <= line[0]['height']*1.35 and abs(cells[0][0]['x']-rows[-1]['cells'][0][0]['x']) < 2:
                    rows[-1]['cells'][0].extend(cells[0])
                elif cells[0] and abs(cells[0][0]['x']-left) < 2:
                    rows.append({'kind':'group', 'cells':[cells[0]], 'y':line[0]['y']})
                else: safe=False; break
            if not safe or not 3 <= len(rows) <= MAX_ROWS or rows[0]['kind'] != 'data' or rows[-1]['kind'] != 'data': continue
            rows[0]['kind'] = 'header'
            touched = {s['mcid'] for row in rows for cell in row['cells'] for s in cell}
            selected_ops = {s['op'] for row in rows for cell in row['cells'] for s in cell}
            if any(mcid not in scopes or set(scopes[mcid]['shows'])-selected_ops
                   or any(op not in b.TEXT_ONLY | {b'BT',b'ET'} for _,op in operations[scopes[mcid]['start']+1:scopes[mcid]['end']])
                   for mcid in touched): continue
            identifiers = list(dict.fromkeys(s['owner'] for row in rows for cell in row['cells'] for s in cell))
            parents = {tags[identifier]['parentId'] for identifier in identifiers}
            if len(parents) != 1: continue
            parent_id = next(iter(parents)); parent = nodes.get(parent_id)
            if parent is None or parent.get('/S') not in ('/Document','/Sect','/Part','/Div','/Art'): continue
            siblings = b._children(parent)
            indices = [next((i for i,item in enumerate(siblings) if v.resolved(item) is nodes[identifier]), -1) for identifier in identifiers]
            if -1 in indices or set(range(min(indices),max(indices)+1)) != set(indices): continue
            residual = {identifier:[item['mcid'] for item in tags[identifier]['contentSequence'] if item['mcid'] not in touched] for identifier in identifiers}
            if any(remain and (indices[identifiers.index(identifier)] != max(indices)
                    or any(item['mcid'] in touched for item in tags[identifier]['contentSequence'][len(tags[identifier]['contentSequence'])-len(remain):])) for identifier,remain in residual.items()): continue
            try:
                for row in rows:
                    for cell in row['cells']:
                        for s in cell: s['text'] = _text(reader,page,s['font'],s['size'],s['pieces'])
                if any(not all(any(char.isalpha() for char in s['text']) for s in cell) for cell in rows[0]['cells']): continue
                if any(not ''.join(s['text'] for s in cell).strip() for row in rows for cell in row['cells']): continue
            except Exception: continue
            preview = '\n'.join(row['kind']+': '+' | '.join(' '.join(s['text'] for s in cell) for cell in row['cells']) for row in rows)
            public = {'kind':'rebuild_table','tagId':identifiers[0],'pageNumber':page_number,
                'text':'\n'.join(tags[identifier]['text'] for identifier in identifiers)[:20000],
                'preview':preview[:20000],'relatedTagIds':identifiers[1:]}
            detail = {'rows':rows,'owners':identifiers,'residual':residual,'parentId':parent_id,
                      'scopes':{mcid:scopes[mcid] for mcid in touched},
                      'backgrounds':_verified_background(reader,page_number,operations,rows)}
            if detail['backgrounds']:public['preview']+='\nBackground: verified uniform table fill.'
            public['candidateId'] = hashlib.sha256(json.dumps({'source':source_hash, **public,
                'rows':[[[(s['op'],s['lo'],s['hi'],s['mcid'],s['owner']) for s in cell] for cell in row['cells']] for row in rows]},sort_keys=True).encode()).hexdigest()
            candidates.append((public,detail))
            if len(candidates) >= MAX_TABLES: return candidates,inventory,nodes
    return candidates,inventory,nodes


def discover_candidates(reader, *, _inspection=None):
    try:
        return [public for public,_ in _discover(reader,_inspection=_inspection)[0]]
    except (ValueError,TypeError,KeyError,IndexError,AttributeError):
        return []


class _TableProof:
    def __init__(self): self.tables=[]


class _MetadataCanonicalizer(v.Canonicalizer):
    def value(self, item, active=None, depth=0):
        # A byte-string ID may reopen as a decoded TextStringObject. Bind its
        # original encoded bytes, rather than depending on the parser's type.
        value = v.resolved(item)
        if self.owned_reference(item) in self.page_refs or id(value) in self.pages:
            return super().value(item, active, depth)
        if isinstance(value, TextStringObject):
            item = ByteStringObject(value.original_bytes)
        elif isinstance(value, dict):
            # General preservation intentionally ignores a few structural keys.
            # This proof binds *all* native metadata keys, including unexpected
            # additions, so encode dictionaries as typed key/value sequences.
            item = ('native_dictionary', [(str(key),value[key]) for key in sorted(value)])
        elif isinstance(value, ArrayObject):
            item = ('native_array', list(value))
        return super().value(item, active, depth)


def _metadata(node, pages):
    # Relationships and marked-content membership have separate exact checks.
    # Every other property is bound, including Pg, Lang, Alt and ActualText.
    return _MetadataCanonicalizer(pages).hash({key:value for key,value in node.items()
                                             if key not in ('/K','/P')})


def _paint_member(segment):
    return {name:segment[name] for name in ('x','right','y','height','font','size')} | {
        'pieces':b.raw(segment['pieces'])}


def _same_paint_member(left, right):
    return (all(abs(left[name]-right[name]) < 1e-6 for name in ('x','right','y','height','size'))
            and left['font']==right['font'] and left['pieces']==right['pieces'])


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
        _require(operation['tagId']==public['tagId'] and not used.intersection(detail['owners']))
        used.update(detail['owners'])
        for identifier in detail['owners']:
            _require(identifier in targets and identifier in source_nodes)
            old,new=source_nodes[identifier],targets[identifier]
            _require(v.Canonicalizer(list(source_reader.pages)).hash({k:x for k,x in old.items() if k not in ('/P','/Pg')})==v.Canonicalizer(list(writer.pages)).hash({k:x for k,x in new.items() if k not in ('/P','/Pg')}))
            _require(v.resolved(new['/P']) is targets[detail['parentId']])
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
        insertion=min(i for i,item in enumerate(siblings) if any(v.resolved(item) is targets[identifier] for identifier in detail['owners']))
        kept=[item for item in siblings if not any(v.resolved(item) is targets[identifier] and not detail['residual'][identifier] for identifier in detail['owners'])]
        # The first involved node cannot have outside content under discovery's
        # trailing-remainder rule, so its old position remains the insert point.
        kept.insert(insertion,table.indirect_reference);parent[N('/K')]=ArrayObject(kept)
        reused=set(); replacements={}; removed=set(); allocated=0
        original_ids=set(detail['scopes']); next_mcid=max(len(array),max(original_ids,default=-1)+1)
        used_old=set(); expected_rows=[]; expected_row_metadata=[]; expected_members={}
        active_groups=[]; top_headers=[]; group_levels=[]
        for identifier,residual in detail['residual'].items():
            if residual:targets[identifier][N('/K')]=ArrayObject([I(mcid) for mcid in residual]);reused.add(identifier)
        row_nodes=[]
        for row_index,row in enumerate(detail['rows']):
            row_node=new('TR',table,row['cells'][0][0]['owner']);row_nodes.append(row_node.indirect_reference)
            cell_nodes=[]; expected_cells=[]; row_header=None
            if row['kind']=='group':
                bold=all(s['bold'] for s in row['cells'][0])
                # A bold full-width section contains subsequent regular-weight
                # subgroup labels until the next bold section starts.
                group_levels=[] if bold else [(identifier,level) for identifier,level in group_levels if level]
                active_groups=[identifier for identifier,_ in group_levels]
            for column,segments in enumerate(row['cells']):
                header=row['kind'] in ('header','group') or column==0
                cell=new('TH' if header else 'TD',row_node,segments[0]['owner'])
                attrs=DictionaryObject({N('/O'):N('/Table')})
                if header:attrs[N('/Scope')]=N('/Column' if row['kind'] in ('header','group') else '/Row')
                if row['kind']=='group':attrs[N('/ColSpan')]=I(2)
                identifier=table_id+b'-r'+str(row_index).encode()+b'-c'+str(column).encode()
                headers=[] if row['kind']=='header' else list(top_headers if row['kind']=='group' else top_headers[column:column+1])+active_groups
                if row_header is not None and column:headers.append(row_header)
                if headers:attrs[N('/Headers')]=ArrayObject([ByteStringObject(value) for value in headers])
                cell[N('/A')]=attrs
                if header:
                    cell[N('/ID')]=ByteStringObject(identifier);id_entries[identifier.hex()]=cell
                    if row['kind']=='header':top_headers.append(identifier)
                    elif row['kind']=='group':
                        active_groups.append(identifier);group_levels.append((identifier,bold))
                    else:row_header=identifier
                leaves=[]; leaf_mcids=[]; expected_leaves=[]
                for owner in dict.fromkeys(s['owner'] for s in segments):
                    owned=[s for s in segments if s['owner']==owner]
                    if owner not in reused:
                        leaf=targets[owner];reused.add(owner);leaf[N('/P')]=cell.indirect_reference
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
                    'colSpan':int(attrs.get('/ColSpan',1)),'headers':[value.hex() for value in headers],
                    'id':identifier.hex() if header else None,'mcids':leaf_mcids,
                    'text':' '.join(s['text'] for s in segments),
                    'metadata':_metadata(cell,list(writer.pages)),'leaves':expected_leaves})
            row_node[N('/K')]=ArrayObject(cell_nodes);expected_rows.append(expected_cells)
            expected_row_metadata.append(_metadata(row_node,list(writer.pages)))
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
            'metadata':_metadata(table,list(writer.pages)), 'rowMetadata':expected_row_metadata,
            'members':expected_members,'backgrounds':[_background_identity(block) for block in detail['backgrounds']]})
        changes.append({'code':'rebuild_table','tagId':public['tagId'],'pageNumber':page_number,
            'candidateId':public['candidateId'],'relatedTagIds':public['relatedTagIds'],
            'message':'Rebuilt the existing table’s rows, cells and header relationships without changing its visible content.'})
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
        rows=children(table);_require(len(rows)==len(expected['rows']))
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
                _require(attr.get('colSpan',1)==wanted['colSpan'] and attr.get('headersHex',[])==wanted['headers'])
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
                    _require(header_row is not None and header_row['role']=='TR' and header_row['parentId']==table['id'])
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
