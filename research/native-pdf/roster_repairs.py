"""Group reviewed roster entries using whole existing Form-content references.

No text, drawing operation, font, image or position is changed. This bounded
experiment accepts a unique, directly invoked Form and explicit MCID groups;
source painting and the completed audit remain bound to immutable file hashes.
"""
from __future__ import annotations
import hashlib
import io
import json
from pathlib import Path

from pypdf import PdfReader
from pypdf.generic import ArrayObject,ContentStream,DictionaryObject,NameObject,TextStringObject
from conformance_repairs import _open
from preserve_figures import parent_entries,obj as resolved
from semantic_repairs import _tag_nodes
from table_repairs import digest
import verify_pdf as v


def children(node):
    value=resolved(node.get('/K',[]));return list(value) if isinstance(value,list) else [node.raw_get('/K')]


def _form_context(reader,page_number,resource):
    if type(page_number) is not int or not 1<=page_number<=len(reader.pages) or not isinstance(resource,str) or not resource.startswith('/'):
        raise ValueError('explicit_form_locator_required')
    page=reader.pages[page_number-1];assets=resolved(resolved(page.get('/Resources',{})).get('/XObject',{}));form=resolved(assets.get(resource))
    if not isinstance(form,DictionaryObject) or form.get('/Subtype')!='/Form':raise ValueError('native_form_required')
    calls=[];work=0
    def visit(ops,resources,pn,depth,active):
        nonlocal work
        work+=len(ops)
        if depth>8 or work>200000:raise ValueError('form_invocation_limit')
        for args,op in ops:
            if op!=b'Do':continue
            if len(args)!=1:raise ValueError('invalid_form_invocation')
            target=resolved(resolved(resources.get('/XObject',{})).get(args[0]))
            if not isinstance(target,DictionaryObject) or target.get('/Subtype')!='/Form':continue
            if target is form:calls.append((pn,depth))
            if id(target) in active:raise ValueError('cyclic_form_invocation')
            visit(ContentStream(target,reader).operations,resolved(target.get('/Resources',resources)),pn,depth+1,active|{id(target)})
    for pn,p in enumerate(reader.pages,1):visit(v.operations(p),resolved(p.get('/Resources',{})),pn,0,set())
    if calls!=[(page_number,0)]:raise ValueError('unique_direct_form_invocation_required')
    canonical=v.Canonicalizer(list(reader.pages))
    return form,{'form':canonical.hash(form),'pagePainting':v.drawing_fingerprint(v.operations(page),v.Canonicalizer()),
                 'pageResources':v.Canonicalizer(list(reader.pages)).hash(page.get('/Resources',{})),
                 'pageGeometry':v.Canonicalizer().hash({k:page.get(k) for k in ('/MediaBox','/CropBox','/Rotate','/UserUnit')})}


def roster_snapshot(reader,tag_ids,page_number,resource,inventory=None):
    inventory=inventory or v.structure_inventory(reader);native=_tag_nodes(reader);tags=inventory['tags']
    if (len(native)!=len(tags)
            or any(str(node.get('/S','')).lstrip('/')!=tag['sourceRole'] for node,tag in zip(native,tags))):
        raise ValueError('roster_inventory_mismatch')
    lookup={tag['id']:(tag,node) for tag,node in zip(tags,native)}
    if not isinstance(tag_ids,list) or not 1<=len(tag_ids)<=20 or len(set(tag_ids))!=len(tag_ids) or any(i not in lookup for i in tag_ids):
        raise ValueError('bounded_roster_tags_required')
    form,context=_form_context(reader,page_number,resource)
    records=[];all_mcids=[];parent=None;languages=set()
    for identity in tag_ids:
        tag,node=lookup[identity]
        if (tag['role']!='P' or tag.get('textIncomplete') or tag.get('attributeGaps')
                or tag['pageNumber']!=page_number or set(node)-{'/Type','/S','/P','/Pg','/K','/Lang'}):
            raise ValueError('simple_roster_paragraph_required')
        if parent is None:parent=resolved(node['/P'])
        if resolved(node['/P']) is not parent:raise ValueError('shared_roster_parent_required')
        refs=children(node);parts=tag['contentSequence'];chunks=[]
        if not refs or len(refs)!=len(parts):raise ValueError('complete_native_roster_chunks_required')
        for ref,part in zip(refs,parts):
            ref=resolved(ref)
            if (not isinstance(ref,DictionaryObject) or ref.get('/Type')!='/MCR'
                    or set(ref)-{'/Type','/Pg','/Stm','/MCID'} or resolved(ref.get('/Stm')) is not form
                    or part.get('kind')!='markedContent' or part.get('resolved') is not True
                    or part.get('parentTreeVerified') is not True or part.get('pageNumber')!=page_number
                    or not part.get('streamId') or not isinstance(part.get('text'),str) or not part['text'].strip()):
                raise ValueError('whole_bound_form_mcr_required')
            mcid=v.integer(ref.get('/MCID'))
            if mcid is None or mcid!=part['mcid'] or mcid in all_mcids:raise ValueError('unique_roster_mcid_required')
            all_mcids.append(mcid);chunks.append({'mcid':mcid,'text':part['text']})
        language=tag.get('effectiveLanguage');languages.add(language)
        records.append({'tagId':identity,'nativeSha256':v.Canonicalizer(list(reader.pages)).hash({k:item for k,item in node.items() if k!='/P'}),'chunks':chunks})
    if len(languages)!=1 or not next(iter(languages)):raise ValueError('uniform_roster_language_required')
    siblings=[resolved(x) for x in children(parent)];selected=[lookup[i][1] for i in tag_ids]
    positions=[siblings.index(node) for node in selected]
    if positions!=list(range(positions[0],positions[0]+len(positions))):raise ValueError('contiguous_roster_paragraphs_required')
    if parent.get('/S') not in ('/Document','/Part','/Art','/Sect','/Div'):raise ValueError('block_roster_parent_required')
    # No arbitrary element reference can silently continue pointing at a removed P.
    for node in native:
        refs=resolved(node.get('/Ref',[]));refs=refs if isinstance(refs,list) else [refs]
        if any(any(resolved(ref) is item for item in selected) for ref in refs):raise ValueError('referenced_roster_paragraph_unsupported')
    return {'tagIds':tag_ids,'pageNumber':page_number,'formResource':resource,'context':context,
            'formStreamSha256':hashlib.sha256(form.get_data()).hexdigest(),'language':next(iter(languages)),'paragraphs':records}


def _signature(snapshot):
    return {**{k:value for k,value in snapshot.items() if k not in ('tagIds','paragraphs')},
            'paragraphs':[{k:value for k,value in p.items() if k!='tagId'} for p in snapshot['paragraphs']]}


def apply_roster_plan(original:Path,candidate:Path,output:Path,plan:dict,*,audit_candidate:Path,audit_report:Path):
    if output.resolve()==original.resolve():raise ValueError('new_output_required')
    source,_=_open(original,output);reader,writer=_open(candidate,output);audited,_=_open(audit_candidate,output)
    hashes=[hashlib.sha256(r.stream.getvalue()).hexdigest() for r in (source,reader,audited)]
    if (not isinstance(plan,dict) or set(plan)!={'schemaVersion','originalSha256','inputSha256','auditCandidateSha256','auditReportSha256','rosters'}
            or plan['schemaVersion']!=1 or [plan[k] for k in ('originalSha256','inputSha256','auditCandidateSha256')]!=hashes):
        raise ValueError('matching_roster_plan_required')
    if not audit_report.is_file() or audit_report.stat().st_size>2*1024*1024:raise ValueError('bounded_complete_audit_required')
    audit_bytes=audit_report.read_bytes();audit=json.loads(audit_bytes)
    if (hashlib.sha256(audit_bytes).hexdigest()!=plan['auditReportSha256'] or audit.get('status')!='complete'
            or audit.get('sourceSha256')!=hashes[0] or audit.get('outputSha256')!=hashes[2]):raise ValueError('matching_complete_roster_audit_required')
    if not isinstance(plan['rosters'],list) or not 1<=len(plan['rosters'])<=8:raise ValueError('bounded_roster_plan_required')
    inventory=v.structure_inventory(reader);audit_inventory=v.structure_inventory(audited);nodes=_tag_nodes(writer)
    if (len(nodes)!=len(inventory['tags'])
            or any(str(node.get('/S','')).lstrip('/')!=tag['sourceRole'] for node,tag in zip(nodes,inventory['tags']))):
        raise ValueError('roster_writer_inventory_mismatch')
    root=resolved(writer.root_object['/StructTreeRoot']);parents=parent_entries(root);prepared=[];seen=set()
    for entry in plan['rosters']:
        if (not isinstance(entry,dict) or set(entry)!={'tagIds','auditedTagIds','pageNumber','formResource','snapshotSha256','items','reason'}
                or not isinstance(entry['reason'],str) or not 1<=len(entry['reason'])<=2000):raise ValueError('explicit_roster_entries_required')
        snapshot=roster_snapshot(reader,entry['tagIds'],entry['pageNumber'],entry['formResource'],inventory)
        old=roster_snapshot(audited,entry['auditedTagIds'],entry['pageNumber'],entry['formResource'],audit_inventory)
        if digest(snapshot)!=entry['snapshotSha256'] or _signature(snapshot)!=_signature(old):raise ValueError('audited_roster_snapshot_changed')
        _,source_context=_form_context(source,entry['pageNumber'],entry['formResource'])
        if source_context!=snapshot['context']:raise ValueError('original_roster_painting_changed')
        if (entry['pageNumber'] not in audit.get('reviewedPages',[]) or not set(entry['auditedTagIds'])<=set(audit.get('reviewedTagIds',[]))
                or not any(f.get('code')=='list-structure' and f.get('pageNumber')==entry['pageNumber'] and set(f.get('tagIds',[]))&set(entry['auditedTagIds']) for f in audit.get('findings',[]))):
            raise ValueError('matching_roster_audit_finding_required')
        expected=[chunk['mcid'] for paragraph in snapshot['paragraphs'] for chunk in paragraph['chunks']]
        groups=entry['items']
        if (not isinstance(groups,list) or not 2<=len(groups)<=100 or any(not isinstance(group,list) or not group or any(type(x)is not int for x in group) for group in groups)
                or [mcid for group in groups for mcid in group]!=expected):raise ValueError('exact_ordered_whole_chunk_partition_required')
        keys={(entry['pageNumber'],entry['formResource'],m) for m in expected}
        if seen&keys:raise ValueError('overlapping_roster_plan')
        seen|=keys;selected=[nodes[int(t[4:])-1] for t in entry['tagIds']]
        form,_=_form_context(writer,entry['pageNumber'],entry['formResource']);parent_key=v.integer(form.get('/StructParents'))
        owners=resolved(parents.get(parent_key));refs={}
        for node in selected:
            for ref in children(node):
                mcid=int(resolved(ref)['/MCID'])
                if not isinstance(owners,ArrayObject) or mcid>=len(owners) or resolved(owners[mcid]) is not node:raise ValueError('exact_form_parent_owner_required')
                refs[mcid]=ref
        if any(any(resolved(owner) is node for node in selected) and mcid not in refs for mcid,owner in enumerate(owners)):
            raise ValueError('unlisted_form_parent_owner')
        prepared.append((entry,snapshot,selected,owners,refs))
    records=[]
    def make(role,parent,page):
        node=DictionaryObject({NameObject('/Type'):NameObject('/StructElem'),NameObject('/S'):NameObject('/'+role),NameObject('/P'):parent.indirect_reference,NameObject('/Pg'):page.indirect_reference,NameObject('/K'):ArrayObject()})
        writer._add_object(node);return node
    for entry,snapshot,selected,owners,refs in prepared:
        parent=resolved(selected[0]['/P']);page=writer.pages[entry['pageNumber']-1];listing=make('L',parent,page)
        listing[NameObject('/Lang')]=TextStringObject(snapshot['language'])
        listing[NameObject('/A')]=DictionaryObject({NameObject('/O'):NameObject('/List'),NameObject('/ListNumbering'):NameObject('/None')})
        paragraphs=[]
        for group in entry['items']:
            item=make('LI',listing,page);body=make('LBody',item,page);paragraph=make('P',body,page)
            listing['/K'].append(item.indirect_reference);item['/K'].append(body.indirect_reference);body['/K'].append(paragraph.indirect_reference)
            paragraph[NameObject('/K')]=ArrayObject([refs[mcid] for mcid in group]);paragraphs.append(paragraph)
            for mcid in group:owners[mcid]=paragraph.indirect_reference
        siblings=children(parent);position=next(i for i,s in enumerate(siblings) if resolved(s) is selected[0])
        parent[NameObject('/K')]=ArrayObject(siblings[:position]+[listing.indirect_reference]+siblings[position+len(selected):])
        records.append((entry,snapshot,listing,paragraphs))
    buffer=io.BytesIO();writer.write(buffer);data=buffer.getvalue()
    if len(data)>4*1024*1024:raise ValueError('roster_output_size_limit')
    saved=PdfReader(io.BytesIO(data),strict=True);info=v.structure_inventory(saved);saved_nodes=_tag_nodes(saved)
    saved_tags={n.indirect_reference.idnum:t for n,t in zip(saved_nodes,info['tags'])};results=[]
    if info['unresolved_content_references'] or any(f.get('code') in ('duplicate_structure_content','parent_tree_owner_mismatch','structure_parent_mismatch') for f in info['findings']):
        raise ValueError('saved_roster_ownership_invalid')
    for entry,snapshot,listing,paragraphs in records:
        form,context=_form_context(saved,entry['pageNumber'],entry['formResource'])
        if context!=snapshot['context'] or hashlib.sha256(form.get_data()).hexdigest()!=snapshot['formStreamSha256']:raise ValueError('saved_roster_painting_changed')
        expected={chunk['mcid']:chunk['text'] for p in snapshot['paragraphs'] for chunk in p['chunks']};items=[]
        for group,paragraph in zip(entry['items'],paragraphs):
            tag=saved_tags[paragraph.indirect_reference.idnum];parts=tag['contentSequence']
            if ([p.get('mcid') for p in parts]!=group or any(p.get('text')!=expected[p['mcid']] or p.get('parentTreeVerified')is not True for p in parts)):
                raise ValueError('saved_roster_text_or_membership_changed')
            items.append({'tagId':tag['id'],'mcids':group,'text':tag['text']})
        results.append({'pageNumber':entry['pageNumber'],'listTagId':saved_tags[listing.indirect_reference.idnum]['id'],'items':items})
    output.parent.mkdir(parents=True,exist_ok=True)
    with output.open('xb') as handle:handle.write(data)
    return {'experimental':True,'certification':False,'requiresFreshAuditAndValidation':True,'originalSha256':hashes[0],'inputSha256':hashes[1],
            'outputSha256':hashlib.sha256(data).hexdigest(),'auditCandidateSha256':hashes[2],'auditReportSha256':plan['auditReportSha256'],'rosters':results}
