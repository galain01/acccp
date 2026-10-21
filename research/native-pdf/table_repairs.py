"""Apply an explicit, source-bound header plan to existing rectangular tables.

ISO 32000-1:2008 tables 322, 323, 337 and 349 define IDTree, ID,
TH/TD, spans, Scope and recursive Headers associations. The source remains
immutable. Header roles/associations are repaired, and existing full-width
footnotes become Notes after the table and its retained page direction.
This bounded experiment requires a new independent validation and audit.

https://opensource.adobe.com/dc-acrobat-sdk-docs/pdfstandards/PDF32000_2008.pdf
https://www.w3.org/WAI/WCAG22/Techniques/pdf/PDF6
"""
from __future__ import annotations

import hashlib
import io
import json
from pathlib import Path

from pypdf import PdfReader
from pypdf.generic import ArrayObject, ByteStringObject, DictionaryObject, NameObject
from conformance_repairs import _open
from preserve_figures import atoms, scan, obj as resolved, PAINT
from semantic_repairs import _tag_nodes
from verify_pdf import Canonicalizer, structure_inventory


def digest(value):
    return hashlib.sha256(json.dumps(value,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()).hexdigest()


def _children(node):
    kids=resolved(node.get('/K',[]));kids=kids if isinstance(kids,list) else [kids]
    result=[resolved(x) for x in kids]
    if any(not isinstance(x,DictionaryObject) or '/S' not in x for x in result):
        raise ValueError('direct_structure_children_required')
    return result


def _table_attributes(cell):
    if '/C' in cell or '/R' in cell:
        raise ValueError('table_attribute_classes_or_revisions_unsupported')
    attrs=resolved(cell.get('/A',[]));attrs=attrs if isinstance(attrs,list) else [attrs]
    if len(attrs)>8 or any(not isinstance(resolved(a),DictionaryObject) for a in attrs):
        raise ValueError('table_attributes_unsupported')
    tables=[resolved(a) for a in attrs if resolved(a).get('/O')=='/Table']
    if len(tables)>1 or any(set(a)-{'/O','/Scope','/RowSpan','/ColSpan','/Headers'} for a in tables):
        raise ValueError('table_attributes_unsupported')
    return tables[0] if tables else DictionaryObject()


def table_snapshots(reader):
    """Exact text/paint-bound table inventory used to review and bind a plan."""
    nodes=_tag_nodes(reader);inventory=structure_inventory(reader)
    if len(nodes)!=len(inventory['tags']):raise ValueError('tag_inventory_mismatch')
    ids={id(n):f'tag-{i+1}' for i,n in enumerate(nodes)}
    tags={t['id']:t for t in inventory['tags']}
    by_parent={}
    for t in inventory['tags']:by_parent.setdefault(t['parentId'],[]).append(t)
    memberships={};page_programs={};page_resources={}
    def binding(page_number):
        if page_number in page_programs:return
        page=reader.pages[page_number-1];rows=scan(page);lookup={r['index']:r for r in rows}
        normalized=atoms(rows);page_programs[page_number]=digest([token for token,_ in normalized])
        page_resources[page_number]=Canonicalizer(list(reader.pages)).hash(page.get('/Resources',{}))
        for index,(_,owners) in enumerate(normalized):
            for owner in owners:
                row=lookup[owner]
                if row['op'] in PAINT and row['mcid'] is not None and not row['artifact']:
                    memberships.setdefault((page_number,row['mcid']),set()).add(index)
    def contents(tag):
        found=[tag]
        for child in by_parent.get(tag['id'],[]):found.extend(contents(child))
        return found
    result=[]
    for table in (n for n in nodes if n.get('/S')=='/Table'):
        rows=_children(table)
        if not 1<=len(rows)<=500 or any(r.get('/S')!='/TR' for r in rows):
            raise ValueError('simple_table_rows_required')
        snapshot={'tagId':ids[id(table)],'rows':[]};occupied={};width=None
        for ri,row in enumerate(rows):
            cells=_children(row);items=[];column=0
            if not cells or len(cells)>100:raise ValueError('table_cell_limit')
            for cell in cells:
                if cell.get('/S') not in ('/TH','/TD'):raise ValueError('native_table_cells_required')
                attr=_table_attributes(cell);span=attr.get('/ColSpan',1);rowspan=attr.get('/RowSpan',1)
                if type(span).__name__ not in ('int','NumberObject') or type(rowspan).__name__ not in ('int','NumberObject') or not 1<=span<=100 or not 1<=rowspan<=100:
                    raise ValueError('invalid_cell_span')
                while (ri,column) in occupied:column+=1
                for r in range(ri,ri+rowspan):
                    for c in range(column,column+span):
                        if (r,c) in occupied or r>=len(rows):raise ValueError('overlapping_or_outside_cells')
                        occupied[r,c]=True
                descendants=contents(tags[ids[id(cell)]]);pieces=[];refs=[]
                for child in descendants:
                    if child.get('textIncomplete') or child.get('attributeGaps'):raise ValueError('incomplete_cell_evidence')
                    if child['text']:pieces.append(child['text'])
                    for ref in child.get('contentSequence',[]):
                        if ref.get('kind')=='childTag' and ref.get('resolved') is True:
                            continue
                        if ref.get('kind')!='markedContent' or ref.get('resolved') is not True or ref.get('parentTreeVerified') is not True or ref.get('streamId') is not None:
                            raise ValueError('simple_bound_cell_content_required')
                        key=(ref['pageNumber'],ref['mcid']);binding(key[0]);positions=memberships.get(key)
                        if not positions:raise ValueError('cell_content_missing')
                        refs.append([key[0],sorted(positions)])
                text=' '.join(' '.join(pieces).split())
                if not text or not refs:raise ValueError('nonempty_bound_cells_required')
                # Original footnote tags may put a marker after its text. Bind
                # the actual painted content set, not those internal tag breaks.
                # The exact candidate text/structure remains in the plan snapshot.
                paint_by_page={}
                for p,positions in refs:paint_by_page.setdefault(p,set()).update(positions)
                painted=[[p,sorted(positions)] for p,positions in sorted(paint_by_page.items())]
                items.append({'tagId':ids[id(cell)],'role':str(cell['/S'])[1:],'text':text,'row':ri,'column':column,'rowSpan':int(rowspan),'colSpan':int(span),
                              'bindingSha256':digest(painted),'pages':sorted({p for p,_ in refs}),
                              'attributesSha256':Canonicalizer().hash(cell.get('/A',[]))})
                column+=span
            extent=max(c for r,c in occupied if r==ri)+1
            if width is None:width=extent
            if extent!=width or any((ri,c) not in occupied for c in range(width)):raise ValueError('nonrectangular_table')
            snapshot['rows'].append({'tagId':ids[id(row)],'cells':items})
        snapshot['columns']=width;snapshot['pages']=sorted({p for r in snapshot['rows'] for c in r['cells'] for p in c['pages']})
        snapshot['pagePrograms']={str(p):page_programs[p] for p in snapshot['pages']}
        snapshot['pageResources']={str(p):page_resources[p] for p in snapshot['pages']}
        result.append(snapshot)
    return result


def _source_signature(table):
    return {'columns':table['columns'],'pagePrograms':table['pagePrograms'],'pageResources':table['pageResources'],
            'rows':[[{k:c[k] for k in ('row','column','rowSpan','colSpan','bindingSha256','pages')} for c in r['cells']] for r in table['rows']]}


def _note_signature(reader,node):
    children=_children(node)
    if not children or any(c.get('/S')!='/P' for c in children):raise ValueError('simple_note_paragraphs_required')
    for child in children:
        contents=resolved(child.get('/K',[]));contents=contents if isinstance(contents,list) else [contents]
        if any(isinstance(resolved(x),DictionaryObject) and resolved(x).get('/Type')!='/MCR' for x in contents):
            raise ValueError('simple_note_content_required')
    return Canonicalizer(list(reader.pages)).hash([
        {k:v for k,v in node.items() if k not in ('/S','/P','/A','/ID','/K')},
        [{k:v for k,v in c.items() if k!='/P'} for c in children]])


FOOTNOTE_DIRECTION='See table footnotes on the next page.'


def _direction_signature(reader,node,tag):
    """Bind a retained direction to its exact text and native page paint."""
    refs=tag.get('contentSequence',[])
    if (tag['role']!='P' or ' '.join(tag.get('text','').split())!=FOOTNOTE_DIRECTION
            or tag.get('textIncomplete') or not refs or not tag.get('pageNumber')
            or set(node)-{'/Type','/S','/P','/K','/Pg','/Lang'}
            or any(r.get('kind')!='markedContent' or r.get('resolved') is not True
                   or r.get('parentTreeVerified') is not True or r.get('streamId') is not None
                   or r.get('pageNumber')!=tag['pageNumber'] for r in refs)):
        raise ValueError('simple_bound_footnote_direction_required')
    mcids=[r['mcid'] for r in refs]
    if len(set(mcids))!=len(mcids):raise ValueError('unique_direction_content_required')
    rows=scan(reader.pages[tag['pageNumber']-1])
    painted=[r for r in rows if r['mcid'] in mcids and r['op'] in PAINT]
    if (not painted or {r['mcid'] for r in painted}!=set(mcids)
            or any(r['artifact'] or r['op'] not in (b'Tj',b'TJ',b"'",b'"') for r in painted)):
        raise ValueError('direction_must_contain_bound_text_only')
    paint_indices={r['index'] for r in painted}
    positions=[i for i,(_,owners) in enumerate(atoms(rows)) if any(o in paint_indices for o in owners)]
    return {'text':FOOTNOTE_DIRECTION,'pageNumber':tag['pageNumber'],'paintSha256':digest(positions),
            'nativeSha256':Canonicalizer(list(reader.pages)).hash({k:v for k,v in node.items() if k!='/P'})}


def _associations(table,plan):
    if set(plan)!={'tagId','sourceTableIndex','snapshotSha256','columnHeaderRows','rowHeaders','groups','noteCells','reason'}:
        raise ValueError('invalid_table_plan')
    if not isinstance(plan['reason'],str) or not 1<=len(plan['reason'])<=2000:raise ValueError('review_reason_required')
    rows=table['rows'];cells={c['tagId']:c for r in rows for c in r['cells']};row_ids={r['tagId'] for r in rows}
    for key,valid in [('columnHeaderRows',row_ids),('rowHeaders',set(cells)),('noteCells',set(cells))]:
        value=plan[key]
        if not isinstance(value,list) or any(not isinstance(v,str) for v in value) or len(set(value))!=len(value) or not set(value)<=valid:
            raise ValueError('invalid_table_plan_references')
    header_rows=set(plan['columnHeaderRows']);row_headers=set(plan['rowHeaders']);notes=set(plan['noteCells'])
    if not header_rows or not row_headers:raise ValueError('headers_required')
    groups={};category_for={}
    if not isinstance(plan['groups'],list):raise ValueError('invalid_groups')
    for group in plan['groups']:
        if not isinstance(group,dict) or set(group)!={'tagId','rowHeaders'} or group['tagId'] not in cells or group['tagId'] in groups:
            raise ValueError('invalid_group')
        cell=cells[group['tagId']];members=group['rowHeaders']
        if cell['column']!=0 or cell['colSpan']!=table['columns'] or cell['rowSpan']!=1 or not isinstance(members,list) or not members or len(set(members))!=len(members) or not set(members)<=row_headers:
            raise ValueError('invalid_category_members')
        positions=[cells[x]['row'] for x in members]
        if positions!=sorted(positions) or positions[0]<=cell['row'] or any(x in category_for for x in members):raise ValueError('invalid_category_order')
        # Exact interval membership, allowing repeated column headers between pages.
        expected=[c['tagId'] for r in rows[cell['row']+1:positions[-1]+1] if r['tagId'] not in header_rows for c in r['cells'] if c['column']==0]
        if expected!=members:raise ValueError('noncontiguous_category_members')
        groups[group['tagId']]=members;category_for.update({x:group['tagId'] for x in members})
    if (row_headers&notes or row_headers&set(groups) or notes&set(groups)):raise ValueError('overlapping_cell_classification')
    changes={};active=[]
    for row in rows:
        rc=row['cells']
        if row['tagId'] in header_rows:
            # A new top header row covers column zero; a second tier fills other columns.
            if rc[0]['column']==0:active=[]
            if any(c['role']!='TH' for c in rc):raise ValueError('authored_column_headers_required')
            for c in rc:
                higher=[h['tagId'] for h in active if h['column']<=c['column'] and h['column']+h['colSpan']>=c['column']+c['colSpan']]
                changes[c['tagId']]={'role':'TH','scope':'Column','headers':higher}
            active.extend(rc);continue
        if len(rc)==1 and rc[0]['tagId'] in groups:
            changes[rc[0]['tagId']]={'role':'TH','scope':None,'headers':[]};continue
        if len(rc)==1 and rc[0]['tagId'] in notes:
            c=rc[0]
            if row is not rows[-1] or len(notes)!=1 or c['colSpan']!=table['columns'] or c['rowSpan']!=1:raise ValueError('final_full_width_note_required')
            changes[c['tagId']]={'role':'Note','scope':None,'headers':[]};continue
        if len(rc)!=table['columns'] or any(c['rowSpan']!=1 or c['colSpan']!=1 for c in rc) or rc[0]['tagId'] not in row_headers:
            raise ValueError('explicit_simple_data_row_required')
        label=rc[0]['tagId'];group=category_for.get(label)
        for c in rc:
            column=[h['tagId'] for h in active if h['column']<=c['column']<h['column']+h['colSpan']]
            if not column:raise ValueError('missing_column_header')
            headers=column+([group] if group else [])+([label] if c['column'] else [])
            changes[c['tagId']]={'role':'TH' if c['column']==0 else 'TD','scope':'Row' if c['column']==0 else None,'headers':headers}
    if set(changes)!=set(cells) or set(row_headers)!={k for k,v in changes.items() if v['scope']=='Row'}:
        raise ValueError('incomplete_table_classification')
    for identity,change in changes.items():
        if identity in change['headers'] or len(set(change['headers']))!=len(change['headers']) or any(changes[h]['role']!='TH' for h in change['headers']):raise ValueError('invalid_header_graph')
    return changes


def apply_table_header_plan(original:Path,candidate:Path,output:Path,plan:dict,*,audit_report:Path,audit_candidate:Path|None=None):
    if output.resolve()==original.resolve():raise ValueError('new_output_required')
    source,_=_open(original,output);reader,writer=_open(candidate,output)
    source_hash=hashlib.sha256(source.stream.getvalue()).hexdigest();input_hash=hashlib.sha256(reader.stream.getvalue()).hexdigest()
    if not isinstance(plan,dict) or set(plan)!={'schemaVersion','originalSha256','inputSha256','auditCandidateSha256','auditReportSha256','tables'} or plan['schemaVersion']!=1:raise ValueError('invalid_table_plan')
    if plan['originalSha256']!=source_hash or plan['inputSha256']!=input_hash:raise ValueError('input_hash_mismatch')
    if not audit_report.is_file() or audit_report.stat().st_size>2*1024*1024:raise ValueError('bounded_audit_required')
    audit_bytes=audit_report.read_bytes();audit=json.loads(audit_bytes)
    if plan['auditReportSha256']!=hashlib.sha256(audit_bytes).hexdigest():raise ValueError('audit_hash_mismatch')
    audited,_=_open(audit_candidate or candidate,output)
    audit_input_hash=hashlib.sha256(audited.stream.getvalue()).hexdigest()
    if plan['auditCandidateSha256']!=audit_input_hash or audit.get('status')!='complete' or audit.get('sourceSha256')!=source_hash or audit.get('outputSha256')!=audit_input_hash:raise ValueError('complete_matching_audit_required')
    nodes=_tag_nodes(writer);root=writer.root_object['/StructTreeRoot']
    if '/IDTree' in root or any('/ID' in n for n in nodes):raise ValueError('existing_element_identifiers_require_separate_review')
    tables=table_snapshots(reader);original_tables=table_snapshots(source);audited_tables=table_snapshots(audited);lookup={t['tagId']:t for t in tables};all_changes={};used=set();notes_to_move=[]
    reader_nodes=_tag_nodes(reader);audited_nodes=_tag_nodes(audited)
    reader_tags=structure_inventory(reader)['tags'];audited_tags=structure_inventory(audited)['tags']
    tags_by_node={id(node):tag for node,tag in zip(nodes,reader_tags)}
    if not isinstance(plan['tables'],list) or not 1<=len(plan['tables'])<=8:raise ValueError('table_count_limit')
    for entry in plan['tables']:
        if not isinstance(entry,dict) or entry.get('tagId') not in lookup or entry['tagId'] in used:raise ValueError('invalid_table_target')
        used.add(entry['tagId']);table=lookup[entry['tagId']];index=entry.get('sourceTableIndex')
        if type(index) is not int or not 0<=index<len(original_tables) or digest(_source_signature(original_tables[index]))!=digest(_source_signature(table)):
            raise ValueError('source_table_content_or_membership_changed')
        if entry.get('snapshotSha256')!=digest(table):raise ValueError('table_snapshot_mismatch')
        matches=[t for t in audited_tables if _source_signature(t)==_source_signature(table)]
        if len(matches)!=1:raise ValueError('audited_table_membership_changed_or_ambiguous')
        audited_table=matches[0]
        # Any earlier repair must also have left this table's roles and attributes
        # untouched. Only preorder identifiers may differ after outside edits.
        old_cells=[c for r in audited_table['rows'] for c in r['cells']];new_cells=[c for r in table['rows'] for c in r['cells']]
        if any(a['role']!=b['role'] or a['text']!=b['text'] or a['attributesSha256']!=b['attributesSha256'] for a,b in zip(old_cells,new_cells)):
            raise ValueError('audited_table_semantics_changed')
        cell_ids={c['tagId'] for c in old_cells}
        if not cell_ids<=set(audit.get('reviewedTagIds',[])) or not set(table['pages'])<=set(audit.get('reviewedPages',[])) or not any(f.get('code')=='table-headers' and set(f.get('tagIds',[]))&cell_ids for f in audit.get('findings',[])):
            raise ValueError('matching_table_audit_required')
        all_changes.update(_associations(table,entry))
        for tag in entry['noteCells']:
            table_node=nodes[int(table['tagId'][4:])-1];note_node=nodes[int(tag[4:])-1]
            note_row=resolved(note_node['/P']);parent=resolved(table_node['/P'])
            if parent.get('/S') not in ('/Document','/Part','/Sect','/Div','/Art') or _children(table_node)[-1] is not note_row or _children(note_row)!=[note_node]:
                raise ValueError('note_container_move_unsupported')
            siblings=_children(parent);at=siblings.index(table_node);direction=None;direction_signature=None
            if at+1<len(siblings) and ' '.join(tags_by_node[id(siblings[at+1])].get('text','').split())==FOOTNOTE_DIRECTION:
                direction=siblings[at+1];direction_tag=tags_by_node[id(direction)]
                direction_signature=_direction_signature(reader,reader_nodes[int(direction_tag['id'][4:])-1],direction_tag)
                note_cell=next(c for row in table['rows'] for c in row['cells'] if c['tagId']==tag)
                if (direction_tag['pageNumber']!=min(table['pages'])
                        or note_cell['pages']!=[direction_tag['pageNumber']+1]):
                    raise ValueError('direction_footnote_page_association_mismatch')
                audited_node=audited_nodes[int(audited_table['tagId'][4:])-1]
                audited_siblings=_children(resolved(audited_node['/P']));old_at=audited_siblings.index(audited_node)
                if old_at+1>=len(audited_siblings):raise ValueError('audited_direction_missing')
                audited_direction=audited_siblings[old_at+1];old_index=next(i for i,n in enumerate(audited_nodes) if n is audited_direction)
                audited_tag=audited_tags[old_index]
                if (audited_tag['id'] not in audit.get('reviewedTagIds',[])
                        or _direction_signature(audited,audited_direction,audited_tag)!=direction_signature):
                    raise ValueError('audited_direction_changed')
                # The table's source signature above proves the entire original
                # page's drawing program/resources, including this exact paint.
            notes_to_move.append((table_node,note_node,note_row,parent,_note_signature(writer,note_node),direction,direction_signature))
    ids={tag:f'native-table-{tag}'.encode('ascii') for tag,change in all_changes.items() if change['role'] in ('TH','Note')}
    names=[]
    for tag,change in all_changes.items():
        node=nodes[int(tag[4:])-1];node[NameObject('/S')]=NameObject('/'+change['role'])
        existing=resolved(node.get('/A',[]));existing=existing if isinstance(existing,list) else [existing]
        others=[a for a in existing if resolved(a).get('/O')!='/Table']
        if change['role']=='Note':
            if others:node[NameObject('/A')]=ArrayObject(others)
            else:node.pop('/A',None)
        else:
            attr=DictionaryObject(_table_attributes(node));attr[NameObject('/O')]=NameObject('/Table');attr.pop('/Scope',None)
            if change['scope']:attr[NameObject('/Scope')]=NameObject('/'+change['scope'])
            attr[NameObject('/Headers')]=ArrayObject([ByteStringObject(ids[x]) for x in change['headers']])
            node[NameObject('/A')]=ArrayObject(others+[attr])
        if tag in ids:
            node[NameObject('/ID')]=ByteStringObject(ids[tag]);names.append((ids[tag],node.indirect_reference))
    for table_node,note_node,note_row,parent,signature,direction,direction_signature in notes_to_move:
        table_node[NameObject('/K')]=ArrayObject([n.indirect_reference for n in _children(table_node) if n is not note_row])
        siblings=_children(parent);matches=[i for i,n in enumerate(siblings) if n is table_node]
        if len(matches)!=1:raise ValueError('unique_table_parent_required')
        siblings.insert(matches[0]+(2 if direction is not None else 1),note_node);parent[NameObject('/K')]=ArrayObject([n.indirect_reference for n in siblings]);note_node[NameObject('/P')]=parent.indirect_reference
    root[NameObject('/IDTree')]=writer._add_object(DictionaryObject({NameObject('/Names'):ArrayObject([v for identifier,ref in sorted(names) for v in (ByteStringObject(identifier),ref)])}))
    buffer=io.BytesIO();writer.write(buffer);data=buffer.getvalue()
    if len(data)>4*1024*1024:raise ValueError('output_size_limit')
    saved=PdfReader(io.BytesIO(data),strict=True);reopened_nodes=_tag_nodes(saved);saved_names={n.indirect_reference.idnum:f'tag-{i+1}' for i,n in enumerate(reopened_nodes)}
    saved_tables={t['tagId']:t for t in table_snapshots(saved)}
    for tag in used:
        before=dict(lookup[tag]);before['rows']=[r for r in before['rows'] if not (len(r['cells'])==1 and all_changes[r['cells'][0]['tagId']]['role']=='Note')]
        actual_id=saved_names[nodes[int(tag[4:])-1].indirect_reference.idnum]
        if _source_signature(before)!=_source_signature(saved_tables[actual_id]):raise ValueError('saved_table_membership_changed')
    saved_tags=structure_inventory(saved)['tags'];saved_tags_by_node={id(n):t for n,t in zip(reopened_nodes,saved_tags)}
    for table_node,note_node,note_row,parent,signature,direction,direction_signature in notes_to_move:
        saved_note=saved.get_object(note_node.indirect_reference.idnum);saved_parent=saved.get_object(parent.indirect_reference.idnum);saved_table=saved.get_object(table_node.indirect_reference.idnum)
        siblings=_children(saved_parent);at=siblings.index(saved_table)
        note_at=at+(2 if direction is not None else 1)
        if siblings[note_at] is not saved_note or resolved(saved_note['/P']) is not saved_parent or _note_signature(saved,saved_note)!=signature:
            raise ValueError('saved_note_content_or_order_changed')
        if direction is not None:
            saved_direction=saved.get_object(direction.indirect_reference.idnum)
            if (siblings[at+1] is not saved_direction or resolved(saved_direction['/P']) is not saved_parent
                    or _direction_signature(saved,saved_direction,saved_tags_by_node[id(saved_direction)])!=direction_signature):
                raise ValueError('saved_direction_content_or_order_changed')
    # Native roles/attributes/IDTree are checked after serialization, not just in memory.
    name_array=saved.root_object['/StructTreeRoot']['/IDTree']['/Names']
    saved_ids={bytes(name_array[i]) if isinstance(name_array[i],bytes) else name_array[i].original_bytes:resolved(name_array[i+1]) for i in range(0,len(name_array),2)}
    for tag,change in all_changes.items():
        node=saved.get_object(nodes[int(tag[4:])-1].indirect_reference.idnum);attr=_table_attributes(node)
        expected_headers=[ids[x] for x in change['headers']]
        actual_headers=[x.original_bytes if isinstance(x,str) else bytes(x) for x in attr.get('/Headers',[])]
        if str(node['/S'])!='/'+change['role'] or actual_headers!=expected_headers or str(attr.get('/Scope','')).lstrip('/')!=(change['scope'] or ''):raise ValueError('saved_header_association_changed')
        if tag in ids and saved_ids.get(ids[tag]) is not node:raise ValueError('saved_identifier_tree_changed')
    output.parent.mkdir(parents=True,exist_ok=True)
    with output.open('xb') as handle:handle.write(data)
    return {'experimental':True,'certification':False,'requires_revalidation':True,'originalSha256':source_hash,'inputSha256':input_hash,'outputSha256':hashlib.sha256(data).hexdigest(),
            'auditCandidateSha256':audit_input_hash,'auditReportSha256':plan['auditReportSha256'],'tablesRepaired':len(used),'cellsReviewed':len(all_changes),'headersIdentified':sum(c['role']=='TH' for c in all_changes.values()),'footnoteContainersPromoted':len(notes_to_move),
            'retainedFootnoteDirections':[{'pageNumber':sig['pageNumber'],'text':sig['text'],'outputTagId':saved_names[direction.indirect_reference.idnum]} for _,_,_,_,_,direction,sig in notes_to_move if direction is not None],
            'changes':[{'inputTagId':tag,'outputTagId':saved_names[nodes[int(tag[4:])-1].indirect_reference.idnum],**change} for tag,change in all_changes.items()]}
