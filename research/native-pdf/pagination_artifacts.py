"""Exclude only proved duplicate continuation captions.

The first table caption, page directions and full table footnotes stay in
reading order. Exact source snapshots and a hash-bound plan prevent arbitrary
paragraph exclusion. Every excluded passage still needs the independent audit.
"""
from __future__ import annotations
import hashlib
from pathlib import Path
import re
from pypdf import PdfReader
from pypdf.generic import ArrayObject, ContentStream, DictionaryObject, NameObject, NullObject
from conformance_repairs import _open, _save
from pdf_safety import resolved
from preserve_figures import parent_entries, props
from semantic_repairs import _tag_nodes
from structure_repairs import snapshot, children
from verify_pdf import structure_inventory, compare_figure_associations


def normalized(text):
    return re.sub(r'\s+', ' ', text).strip()


def mark_redundant_table_pagination(source: Path, output: Path, plan: dict):
    if (not isinstance(plan, dict) or set(plan) != {'schemaVersion','inputSha256','repairs'}
            or plan['schemaVersion'] != 1 or not isinstance(plan['repairs'],list) or not 1 <= len(plan['repairs']) <= 12):
        raise ValueError('invalid_pagination_plan')
    reader,writer=_open(source,output)
    digest=hashlib.sha256(reader.stream.getvalue()).hexdigest()
    if digest != plan['inputSha256']:raise ValueError('candidate_hash_mismatch')
    inventory=structure_inventory(reader);tags={t['id']:t for t in inventory['tags']}
    source_nodes=_tag_nodes(reader);nodes=dict(zip(tags,_tag_nodes(writer)))
    if len(source_nodes)!=len(tags) or len(nodes)!=len(tags):raise ValueError('tag_inventory_mismatch')
    root=resolved(writer.root_object['/StructTreeRoot']);parents=parent_entries(root)
    prepared=[];seen=set()
    for repair in plan['repairs']:
        if not isinstance(repair,dict) or set(repair)!={'tagId','expected','firstCaptionId','firstCaptionExpected','tableId','tableExpected','kind'}:
            raise ValueError('invalid_pagination_repair')
        ids=[repair['tagId'],repair['firstCaptionId'],repair['tableId']]
        if len(set(ids))!=3 or any(i not in tags for i in ids) or ids[0] in seen:raise ValueError('invalid_pagination_targets')
        seen.add(ids[0])
        tag,caption,table=[tags[i] for i in ids];node=nodes[ids[0]]
        if any(snapshot(t)!=repair[k] for t,k in zip([tag,caption,table],['expected','firstCaptionExpected','tableExpected'])):
            raise ValueError('pagination_snapshot_mismatch')
        if (tag['role']!='P' or caption['role'] not in {'P','Caption'} or table['role']!='Table'
                or tag.get('parentId')!=caption.get('parentId') or tag.get('parentId')!=table.get('parentId')
                or tag.get('textIncomplete') or caption.get('textIncomplete')
                or any(key in node for key in ('/Alt','/ActualText','/ID','/Ref','/AF'))
                or not tag['contentSequence'] or not tag['mcids']
                or any(p.get('kind')!='markedContent' or p.get('resolved') is not True
                       or p.get('pageNumber')!=tag['pageNumber']
                       or p.get('parentTreeVerified') is not True or p.get('streamId') is not None
                       for p in tag['contentSequence'])
                or {p.get('mcid') for p in tag['contentSequence']}!=set(tag['mcids'])):
            raise ValueError('unsupported_pagination_target')
        table_pages=set()
        for t in tags.values():
            current=t
            while current.get('parentId') in tags:
                if current['parentId']==table['id']:
                    table_pages.update(p['pageNumber'] for p in t['content'] if p.get('pageNumber'))
                    break
                current=tags[current['parentId']]
        if len(table_pages)<2 or caption['pageNumber']!=min(table_pages) or tag['pageNumber'] not in table_pages:
            raise ValueError('continued_table_required')
        caption_text=normalized(caption['text'])
        if not re.match(r'^TABLE\s+\d+\.',caption_text):raise ValueError('numbered_table_caption_required')
        if repair['kind']=='continued-caption':
            text=normalized(re.sub(r'\(\s*Continued\s*\)', '',tag['text']))
            if text!=caption_text or tag['pageNumber']==caption['pageNumber'] or not re.search(r'\(\s*Continued\s*\)',tag['text']):
                raise ValueError('exact_duplicate_caption_required')
        else:raise ValueError('unsupported_pagination_kind')
        parent=resolved(node['/P']);kids=children(parent)
        if sum(resolved(k) is node for k in kids)!=1:raise ValueError('unique_pagination_child_required')
        parent_ids=[next((i for i,n in nodes.items() if resolved(k) is n),None) for k in kids]
        if not parent_ids.index(caption['id']) < parent_ids.index(table['id']) < parent_ids.index(tag['id']):
            raise ValueError('retained_table_reading_order_required')
        page=writer.pages[tag['pageNumber']-1]
        array=resolved(parents[int(page['/StructParents'])])
        for mcid in tag['mcids']:
            if resolved(array[mcid]) is not node:raise ValueError('pagination_owner_mismatch')
        prepared.append((repair,tag,node,page,array))
    # Preflight every selected wrapper before any mutation. Preserve all other
    # operators/properties, including Figure metadata and optional-content scopes.
    page_plans={}
    for _,tag,node,page,array in prepared:
        key=tag['pageNumber'];page_plans.setdefault(key,{'page':page,'ids':set(),'ops':list(page.get_contents().operations)})['ids'].update(tag['mcids'])
    for value in page_plans.values():
        found=set();stack=[];new=[]
        for args,op in value['ops']:
            if op in (b'BDC',b'BMC'):
                properties=props(value['page'],args[1]) if op==b'BDC' else {}
                mcid=properties.get('/MCID');selected=mcid in value['ids']
                if selected:
                    if mcid in found or stack or set(properties)-{'/MCID'}:raise ValueError('pagination_scope_unsupported')
                    found.add(mcid)
                    args=[NameObject('/Artifact'),DictionaryObject({NameObject('/Type'):NameObject('/Pagination')})]
                elif any(stack):raise ValueError('nested_pagination_scope_unsupported')
                stack.append(selected)
            elif op==b'EMC':
                if not stack:raise ValueError('unbalanced_scopes')
                stack.pop()
            elif any(stack) and op in {b'Do',b'INLINE IMAGE',b'S',b's',b'f',b'F',b'f*',b'B',b'B*',b'b',b'b*',b'sh',b'm',b'l',b'c',b'v',b'y',b'h',b're'}:
                raise ValueError('pagination_must_contain_text_only')
            new.append((args,op))
        if stack or found!=value['ids']:raise ValueError('pagination_scope_not_found')
        value['new']=new
    for value in page_plans.values():
        stream=ContentStream(None,writer);stream.operations=value['new']
        value['page'].replace_contents(stream)
    for _,tag,node,_,array in prepared:
        parent=resolved(node['/P']);parent[NameObject('/K')]=ArrayObject([k for k in children(parent) if resolved(k) is not node])
        for mcid in tag['mcids']:array[mcid]=NullObject()
    output_hash=_save(writer,output)
    reopened=PdfReader(output,strict=True)
    if not compare_figure_associations(reader,reopened)['passed']:raise ValueError('figure_bindings_changed')
    return {'experimental':True,'certification':False,'requires_revalidation':True,'inputSha256':digest,'outputSha256':output_hash,
            'excludedPagination':[{'pageNumber':t['pageNumber'],'text':t['text'],'kind':r['kind']} for r,t,_,_,_ in prepared]}
