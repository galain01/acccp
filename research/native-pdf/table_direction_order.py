"""Move reviewed next-page directions before their intact two-page tables.

Only Document sibling order changes. PDF 1.7 Table rows remain uninterrupted;
the existing direction retains its original page, text and marked-content owner.
The completed audit may include an appendix absent from the repair baseline.
Each selected subtree and its painted pages must still match that exact audit.
"""
from __future__ import annotations
import hashlib
import json
from pathlib import Path

from pypdf import PdfReader
from pypdf.generic import ArrayObject, NameObject
from conformance_repairs import _open, _save
from opening_order_repairs import digest, native_attributes, subtree_snapshot
from pdf_safety import resolved
from semantic_repairs import _tag_nodes
from structure_repairs import children
from table_repairs import FOOTNOTE_DIRECTION, _direction_signature
from verify_pdf import Canonicalizer, compare_pdfs, figure_association_inventory, structure_inventory


def _inventory(reader):
    tags={t['id']:t for t in structure_inventory(reader)['tags']}
    nodes=_tag_nodes(reader)
    if len(nodes)!=len(tags) or any(str(n.get('/S','')).lstrip('/')!=t['sourceRole'] for n,t in zip(nodes,tags.values())):
        raise ValueError('native_inventory_mismatch')
    return tags,dict(zip(tags,nodes))


def _pages(tags,identity):
    tag=tags[identity];result=set()
    for entry in tag['contentSequence']:
        if entry.get('resolved') is not True:raise ValueError('complete_table_content_required')
        if entry.get('kind')=='childTag':result.update(_pages(tags,entry['tagId']))
        elif entry.get('kind')=='markedContent' and entry.get('parentTreeVerified') is True and entry.get('streamId') is None:
            result.add(entry['pageNumber'])
        else:raise ValueError('page_bound_table_content_required')
    return result


def _native_snapshot(reader):
    """Own attributes, child order and parent identity, independent of tag labels."""
    result={}
    for node in _tag_nodes(reader):
        ref=node.indirect_reference
        parent=resolved(node.get('/P'));parent_ref=getattr(parent,'indirect_reference',None)
        parts=[]
        for raw in children(node):
            child=resolved(raw)
            if isinstance(child,dict) and '/S' in child:
                parts.append({'nativeChild':child.indirect_reference.idnum})
            else:parts.append({'content':Canonicalizer(list(reader.pages)).value(raw)})
        result[ref.idnum]={'parent':parent_ref.idnum if parent_ref else None,
            'attributes':Canonicalizer(list(reader.pages)).value({k:v for k,v in node.items() if k not in {'/P','/K'}}),
            'children':parts}
    return result


def move_table_directions(candidate:Path,output:Path,plan:dict,*,audited_candidate:Path,audit_report:Path):
    if (not isinstance(plan,dict) or set(plan)!={'schemaVersion','inputSha256','auditCandidateSha256','auditReportSha256','moves'}
            or plan['schemaVersion']!=1 or not isinstance(plan['moves'],list) or not 1<=len(plan['moves'])<=2):
        raise ValueError('bounded_direction_order_plan_required')
    reader,writer=_open(candidate,output);audited,_=_open(audited_candidate,output)
    current_hash=hashlib.sha256(reader.stream.getvalue()).hexdigest();audited_hash=hashlib.sha256(audited.stream.getvalue()).hexdigest()
    if plan['inputSha256']!=current_hash or plan['auditCandidateSha256']!=audited_hash:raise ValueError('candidate_hash_mismatch')
    if not audit_report.is_file() or audit_report.stat().st_size>2*1024*1024:raise ValueError('bounded_audit_required')
    audit_bytes=audit_report.read_bytes();audit=json.loads(audit_bytes)
    if (hashlib.sha256(audit_bytes).hexdigest()!=plan['auditReportSha256'] or audit.get('status')!='complete'
            or audit.get('outputSha256')!=audited_hash):raise ValueError('complete_matching_audit_required')
    current,native=_inventory(reader);old,old_native=_inventory(audited)
    writer_nodes=_tag_nodes(writer)
    if len(writer_nodes)!=len(current) or any(str(n.get('/S','')).lstrip('/')!=t['sourceRole'] for n,t in zip(writer_nodes,current.values())):
        raise ValueError('writer_inventory_mismatch')
    writer_native=dict(zip(current,writer_nodes))
    current_paint=figure_association_inventory(reader)['pages'];old_paint=figure_association_inventory(audited)['pages']
    prepared=[];selected=set();reviewed_directions=set();paint_pages=set()
    for move in plan['moves']:
        if not isinstance(move,dict) or set(move)!={'title','direction','table','note'}:raise ValueError('exact_direction_context_required')
        context={}
        for key,expected in [('title','P'),('direction','P'),('table','Table'),('note','Note')]:
            entry=move[key]
            if not isinstance(entry,dict) or set(entry)!={'tagId','auditedTagId','snapshotSha256'}:
                raise ValueError('exact_subtree_plan_required')
            now=current[entry['tagId']];prior=old[entry['auditedTagId']]
            if now['role']!=expected or prior['role']!=expected:raise ValueError('expected_table_context_role_required')
            if entry['tagId'] in selected:raise ValueError('unique_direction_targets_required')
            selected.add(entry['tagId'])
            if entry['auditedTagId'] not in audit.get('reviewedTagIds',[]):raise ValueError('reviewed_table_context_required')
            signature=digest(subtree_snapshot(current,entry['tagId']))
            if signature!=entry['snapshotSha256'] or signature!=digest(subtree_snapshot(old,entry['auditedTagId'])):
                raise ValueError('audited_subtree_changed')
            if native_attributes(native[entry['tagId']])!=native_attributes(old_native[entry['auditedTagId']]):
                raise ValueError('audited_native_attributes_changed')
            context[key]=(entry['tagId'],entry['auditedTagId'])
        title,direction,table,note=(current[context[k][0]] for k in ('title','direction','table','note'))
        page=direction['pageNumber']
        if (not isinstance(page,int) or title['pageNumber']!=page or table['pageNumber']!=page
                or not ' '.join(title['text'].split()).startswith('TABLE ')
                or _pages(current,table['id'])!={page,page+1} or _pages(current,note['id'])!={page+1}
                or not {page,page+1}<=set(audit.get('reviewedPages',[]))):
            raise ValueError('two_page_table_direction_context_required')
        if _direction_signature(reader,native[direction['id']],direction)!=_direction_signature(
                audited,old_native[context['direction'][1]],old[context['direction'][1]]):
            raise ValueError('audited_direction_paint_changed')
        for nodes,ids in [(native,[context[k][0] for k in ('title','table','direction','note')]),
                          (old_native,[context[k][1] for k in ('title','table','direction','note')])]:
            parent=resolved(nodes[ids[0]]['/P'])
            if parent.get('/S')!='/Document' or any(resolved(nodes[key]['/P']) is not parent for key in ids):
                raise ValueError('same_document_siblings_required')
            siblings=[resolved(k) for k in children(parent)]
            indexes=[next((i for i,n in enumerate(siblings) if n is nodes[key]),-1) for key in ids]
            if indexes!=list(range(indexes[0],indexes[0]+4)) or indexes[0]<0:
                raise ValueError('consecutive_title_table_direction_note_required')
            if any(sum(n is nodes[key] for n in siblings)!=1 for key in ids):raise ValueError('unique_document_children_required')
        paint_pages.update({page,page+1});reviewed_directions.add(context['direction'][1])
        prepared.append({'context':context,'page':page})
    if not any(f.get('code')=='reading-order' and set(f.get('tagIds',[]))&reviewed_directions for f in audit.get('findings',[])):
        raise ValueError('matching_direction_order_finding_required')
    geometry=('/MediaBox','/CropBox','/BleedBox','/TrimBox','/ArtBox','/Rotate','/UserUnit')
    for page in paint_pages:
        if page not in old_paint or any(current_paint[page][key]!=old_paint[page][key] for key in ('executionHash','resourcesHash')):
            raise ValueError('audited_table_paint_changed')
        if Canonicalizer().hash({k:reader.pages[page-1].get(k) for k in geometry})!=Canonicalizer().hash({k:audited.pages[page-1].get(k) for k in geometry}):
            raise ValueError('audited_table_geometry_changed')
    expected=_native_snapshot(writer)
    changes=[]
    for repair in prepared:
        context=repair['context'];direction=writer_native[context['direction'][0]];table=writer_native[context['table'][0]]
        parent=resolved(direction['/P']);siblings=children(parent)
        remaining=[k for k in siblings if resolved(k) is not direction]
        at=next(i for i,k in enumerate(remaining) if resolved(k) is table)
        reordered=remaining[:at]+[direction.indirect_reference]+remaining[at:]
        parent[NameObject('/K')]=ArrayObject(reordered)
        expected[parent.indirect_reference.idnum]['children']=[{'nativeChild':resolved(k).indirect_reference.idnum} for k in reordered]
        changes.append({'pageNumber':repair['page'],'directionText':FOOTNOTE_DIRECTION,
            'auditedDirectionTagId':context['direction'][1], 'auditedTableTagId':context['table'][1],
            'order':['title','direction','table','footnote-note']})
    output_hash=_save(writer,output)
    if _native_snapshot(PdfReader(output,strict=True))!=expected:raise ValueError('saved_native_structure_changed')
    if not compare_pdfs(candidate,output)['preservation']['passed']:raise ValueError('saved_original_page_content_changed')
    return {'schemaVersion':1,'experimental':True,'certification':False,'requiresFreshAuditAndValidation':True,
        'inputSha256':current_hash,'outputSha256':output_hash,'auditCandidateSha256':audited_hash,
        'auditReportSha256':plan['auditReportSha256'],'movedDirections':changes,
        'originalSubtreesAndOwnershipPreserved':True,'originalPagesPreserved':True}
