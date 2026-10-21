"""Move reviewed opening-page blocks without changing their contents or other order.

A completed audit may address an earlier immutable candidate. Each moved subtree
and the insertion anchor must still have the exact same native content, roles,
attributes and page references. No audit hash is rebound to a different PDF.
"""
from __future__ import annotations
import hashlib
import json
from pathlib import Path

from pypdf import PdfReader
from pypdf.generic import ArrayObject, NameObject
from conformance_repairs import _open, _save
from semantic_repairs import _tag_nodes
from structure_repairs import children
from pdf_safety import resolved
from verify_pdf import structure_inventory, compare_pdfs, figure_association_inventory, Canonicalizer


def digest(value):
    return hashlib.sha256(json.dumps(value,sort_keys=True,ensure_ascii=True,separators=(',',':')).encode()).hexdigest()


def native_attributes(node,depth=0):
    if (depth>16 or set(node)-{'/Type','/S','/P','/K','/Pg','/A','/Lang','/Alt','/ActualText','/ID','/Ref'}
            or '/Ref' in node and (not isinstance(resolved(node['/Ref']),ArrayObject) or len(resolved(node['/Ref']))!=0)):
        raise ValueError('unsupported_opening_native_attributes')
    return {'attributes':Canonicalizer().value({k:v for k,v in node.items() if k not in {'/P','/K','/Pg'}}),
            'children':[native_attributes(resolved(k),depth+1) for k in children(node)
                        if isinstance(resolved(k),dict) and '/S' in resolved(k)]}


def subtree_snapshot(tags, identity, depth=0):
    if depth>16:raise ValueError('bounded_subtree_required')
    tag=tags[identity]
    if tag.get('textIncomplete') or tag.get('attributeGaps'):raise ValueError('complete_native_subtree_required')
    result={k:v for k,v in tag.items() if k not in {'id','parentId','contentSequence'}}
    # headerTagIds are inspector preorder labels, not native PDF IDs. Bind the
    # actual target ID so a reading-order permutation can safely renumber them.
    if 'attributes' in result:
        result['attributes']=json.loads(json.dumps(result['attributes']))
        for attribute in result['attributes']:
            if 'headerTagIds' in attribute:
                targets=[tags[key].get('nativeIdHex') for key in attribute['headerTagIds']]
                if any(not value for value in targets):raise ValueError('native_header_ids_required')
                attribute['headerTagIds']=targets
    result['contentSequence']=[]
    for entry in tag['contentSequence']:
        if entry.get('resolved') is not True:raise ValueError('complete_native_subtree_required')
        if entry.get('kind')=='childTag':
            result['contentSequence'].append({'kind':'childTag','subtree':subtree_snapshot(tags,entry['tagId'],depth+1)})
        else:result['contentSequence'].append(entry)
    return result


def move_reviewed_opening_blocks(candidate:Path,output:Path,plan:dict,*,audited_candidate:Path,audit_report:Path):
    if set(plan)!={'schemaVersion','inputSha256','auditCandidateSha256','auditReportSha256','blocks','before'} or plan['schemaVersion']!=1:
        raise ValueError('explicit_opening_order_plan_required')
    reader,writer=_open(candidate,output);audited,_=_open(audited_candidate,output)
    current_hash=hashlib.sha256(reader.stream.getvalue()).hexdigest()
    audited_hash=hashlib.sha256(audited.stream.getvalue()).hexdigest()
    if plan['inputSha256']!=current_hash or plan['auditCandidateSha256']!=audited_hash:
        raise ValueError('candidate_hash_mismatch')
    if audit_report.stat().st_size>2*1024*1024:raise ValueError('bounded_audit_required')
    audit_bytes=audit_report.read_bytes();audit=json.loads(audit_bytes)
    if (hashlib.sha256(audit_bytes).hexdigest()!=plan['auditReportSha256'] or audit.get('status')!='complete'
            or audit.get('outputSha256')!=audited_hash):raise ValueError('complete_matching_audit_required')
    current={t['id']:t for t in structure_inventory(reader)['tags']}
    old={t['id']:t for t in structure_inventory(audited)['tags']}
    if not isinstance(plan['blocks'],list) or not 1<=len(plan['blocks'])<=8:raise ValueError('bounded_blocks_required')
    current_nodes=_tag_nodes(writer);old_nodes=_tag_nodes(audited)
    if any(len(nodes)!=len(tags) or any(str(n.get('/S','')).lstrip('/')!=t['sourceRole'] for n,t in zip(nodes,tags.values()))
           for nodes,tags in [(current_nodes,current),(old_nodes,old)]):raise ValueError('native_inventory_mismatch')
    native=dict(zip(current,current_nodes));old_native=dict(zip(old,old_nodes));targets=[]
    # Same text/MCID numbers alone cannot prove an earlier audit still applies.
    # Bind the actual opening-page execution and resources before rebasing.
    paint_before=figure_association_inventory(audited)['pages'][1]
    paint_now=figure_association_inventory(reader)['pages'][1]
    if any(paint_before[k]!=paint_now[k] for k in ['executionHash','resourcesHash']):
        raise ValueError('audited_opening_paint_changed')
    geometry=('/MediaBox','/CropBox','/BleedBox','/TrimBox','/ArtBox','/Rotate','/UserUnit')
    if Canonicalizer().hash({k:audited.pages[0].get(k) for k in geometry})!=Canonicalizer().hash({k:reader.pages[0].get(k) for k in geometry}):
        raise ValueError('audited_opening_geometry_changed')
    for entry in [*plan['blocks'],plan['before']]:
        if not isinstance(entry,dict) or set(entry)!={'tagId','auditedTagId','snapshotSha256'}:
            raise ValueError('exact_subtree_plan_required')
        now=current[entry['tagId']];prior=old[entry['auditedTagId']]
        if (now['pageNumber']!=1 or prior['pageNumber']!=1 or now['role'] not in {'P','TOC','H1','H2','H3'}
                or entry['auditedTagId'] not in audit.get('reviewedTagIds',[])
                or 1 not in audit.get('reviewedPages',[])):
            raise ValueError('reviewed_opening_blocks_required')
        signature=digest(subtree_snapshot(current,now['id']))
        if signature!=entry['snapshotSha256'] or signature!=digest(subtree_snapshot(old,prior['id'])):
            raise ValueError('audited_subtree_changed')
        if native_attributes(native[now['id']])!=native_attributes(old_native[prior['id']]):
            raise ValueError('audited_native_attributes_changed')
        targets.append(native[now['id']])
    if len({id(n) for n in targets})!=len(targets):raise ValueError('unique_targets_required')
    audited_ids={e['auditedTagId'] for e in plan['blocks']}
    if not any(f.get('code')=='reading-order' and audited_ids<=set(f.get('tagIds',[])) for f in audit.get('findings',[])):
        raise ValueError('matching_opening_order_finding_required')
    parent=resolved(targets[0]['/P'])
    if parent.get('/S')!='/Document' or any(resolved(n['/P']) is not parent for n in targets):
        raise ValueError('same_document_parent_required')
    original=children(parent)
    if any(sum(resolved(k) is n for k in original)!=1 for n in targets):raise ValueError('unique_children_required')
    selected=targets[:-1];anchor=targets[-1]
    remaining=[k for k in original if all(resolved(k) is not n for n in selected)]
    at=next(i for i,k in enumerate(remaining) if resolved(k) is anchor)
    reordered=remaining[:at]+[n.indirect_reference for n in selected]+remaining[at:]
    # Only a stable permutation is allowed. Unselected native child order stays.
    parent[NameObject('/K')]=ArrayObject(reordered)
    output_hash=_save(writer,output)
    reopened=PdfReader(output,strict=True);saved=structure_inventory(reopened)
    saved_nodes=_tag_nodes(reopened);saved_tags={t['id']:t for t in saved['tags']}
    saved_parent=next(n for n in saved_nodes if n.indirect_reference.idnum==parent.indirect_reference.idnum)
    if [resolved(k).indirect_reference.idnum for k in children(saved_parent)]!=[resolved(k).indirect_reference.idnum for k in reordered]:
        raise ValueError('saved_permutation_changed')
    by_object={n.indirect_reference.idnum:saved['tags'][i]['id'] for i,n in enumerate(saved_nodes)}
    for identity,node in native.items():
        # Compare each node's own data; descendants' identifiers are allowed to
        # renumber after the checked permutation, but no descendant was edited.
        if node is parent:continue
        saved_id=by_object[node.indirect_reference.idnum]
        if digest(subtree_snapshot(current,identity))!=digest(subtree_snapshot(saved_tags,saved_id)):
            raise ValueError('saved_subtree_changed')
    if not compare_pdfs(candidate,output)['preservation']['passed']:raise ValueError('saved_page_content_changed')
    return {'experimental':True,'certification':False,'requiresFreshAudit':True,'inputSha256':current_hash,
            'outputSha256':output_hash,'auditCandidateSha256':audited_hash,'auditReportSha256':plan['auditReportSha256'],
            'movedAuditedTagIds':[entry['auditedTagId'] for entry in plan['blocks']]}
