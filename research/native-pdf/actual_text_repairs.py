"""Restore authored replacement-text Spans to their unchanged paint occurrences.

This source-bound repair restores the original text, including discretionary
hyphens, rather than inferring replacement words. It supports one page MCID per
Span, and an exact isolated Artifact scope with an unambiguous logical anchor.
No text-showing operator, glyph, resource, or source file is changed.
"""
from __future__ import annotations
import hashlib
import io
from pathlib import Path

from pypdf import PdfReader
from pypdf.generic import ArrayObject,ContentStream,DictionaryObject,NameObject,NullObject,NumberObject,TextStringObject
from conformance_repairs import _open,_save,MAX_BYTES
from pdf_safety import reject_signed_pdf,resolved
from preserve_figures import scan,atoms,parent_entries,refkey,props,PAINT
from semantic_repairs import _tag_nodes
from verify_pdf import Canonicalizer,structure_inventory,compare_pdfs


def _kids(node):
    value=resolved(node.get('/K'))
    return list(value) if isinstance(value,ArrayObject) else ([] if value is None else [node.raw_get('/K')])


def _leaf(value,inherited,page_ids):
    value=resolved(value)
    if isinstance(value,NumberObject) and value>=0:return inherited,int(value)
    if isinstance(value,DictionaryObject) and value.get('/Type')=='/MCR' and not set(value)-{'/Type','/Pg','/MCID'}:
        mcid=value.get('/MCID');page=page_ids.get(refkey(value.get('/Pg')),inherited if '/Pg' not in value else None)
        if isinstance(mcid,NumberObject) and mcid>=0 and page is not None:return page,int(mcid)
    return None


def _positions(rows,token_list):
    by={row['index']:row for row in rows};owned={};artifact=set();op_positions={}
    for position,(token,indices) in enumerate(token_list):
        if token[0]!='byte':continue
        values=[by[index] for index in indices]
        if any(row['op'] not in (b'Tj',b'TJ') for row in values):raise ValueError('unsupported_span_text_operator')
        owners={(row['mcid'],row['artifact']) for row in values}
        if len(owners)!=1:raise ValueError('ambiguous_span_boundary')
        mcid,is_artifact=next(iter(owners))
        if is_artifact:artifact.add(position)
        elif mcid is not None:owned.setdefault(mcid,set()).add(position)
        for index in indices:op_positions.setdefault(index,set()).add(position)
    return owned,artifact,op_positions,by


def _exact_artifact_scope(page,selected_ops,selected_positions,op_positions):
    operations=list(page.get_contents().operations);stack=[];matches=[]
    for index,(args,operator) in enumerate(operations):
        if operator in (b'BDC',b'BMC'):
            stack.append((index,args,operator,len(stack)))
        elif operator==b'EMC':
            if not stack:raise ValueError('unbalanced_candidate_scopes')
            begin,open_args,opening,depth=stack.pop()
            if selected_ops and all(begin<op<index for op in selected_ops):
                painted={n for n in range(begin+1,index) if operations[n][1] in PAINT}
                if (opening==b'BMC' and open_args==[NameObject('/Artifact')] and depth==0
                        and painted==selected_ops and not any(o in (b'BDC',b'BMC',b'EMC',b'MP',b'DP') for _,o in operations[begin+1:index])
                        and set().union(*(op_positions.get(n,set()) for n in selected_ops))==selected_positions):
                    matches.append(begin)
    if stack or len(matches)!=1:raise ValueError('isolated_authored_artifact_scope_required')
    return matches[0]


def _source_language(page,mcid):
    """Retain a simple authored scope language; reject other scoped semantics."""
    stack=[];languages=set()
    for args,operator in page.get_contents().operations:
        if operator in (b'BDC',b'BMC'):
            stack.append((str(args[0]),props(page,args[1]) if operator==b'BDC' else {}))
        elif operator==b'EMC':
            if not stack:raise ValueError('source_scope_unbalanced')
            stack.pop()
        elif operator in PAINT and any(p.get('/MCID')==mcid for _,p in stack):
            if len(stack)!=1 or stack[0][0]=='/Artifact' or set(stack[0][1])-{'/MCID','/Lang'}:
                raise ValueError('source_span_scope_semantics_unsupported')
            language=stack[0][1].get('/Lang')
            if language is not None and (not isinstance(language,TextStringObject) or not 1<=len(language)<=100):raise ValueError('source_span_language_invalid')
            languages.add(str(language) if language is not None else None)
    if stack or len(languages)!=1:raise ValueError('source_span_language_ambiguous')
    return next(iter(languages))


def _inline_scopes(page):
    """Inspect whitespace-only inline replacements independently of MCIDs.

    Non-whitespace inline overrides need separate inherited-language evidence;
    this initial subset retains authored spacing only.
    """
    stack=[];found=[];operations=list(page.get_contents().operations)
    for index,(args,operator) in enumerate(operations):
        if operator in (b'BDC',b'BMC'):
            properties=props(page,args[1]) if operator==b'BDC' else {}
            replacement=properties.get('/ActualText')
            if replacement is not None:
                if (str(args[0])!='/Span' or set(properties)!={'/ActualText'}
                        or not isinstance(replacement,TextStringObject) or not 1<=len(replacement)<=2048
                        or not str(replacement).isspace()
                        or any(item[1] is not None for item in stack)):
                    raise ValueError('simple_inline_actualtext_required')
            stack.append((index,replacement))
        elif operator==b'EMC':
            if not stack:raise ValueError('inline_scope_unbalanced')
            start,replacement=stack.pop()
            if replacement is None:continue
            inner=operations[start+1:index]
            if any(op not in (b'Tj',b'TJ',b'Tm',b'Td',b'TD',b'T*') for _,op in inner):
                raise ValueError('inline_replacement_scope_operator_unsupported')
            shows=[n for n in range(start+1,index) if operations[n][1] in (b'Tj',b'TJ')]
            if len(shows)!=1:raise ValueError('single_inline_text_show_required')
            found.append({'start':start,'show':shows[0],'actualText':str(replacement)})
    if stack:raise ValueError('inline_scope_unbalanced')
    return found


def _restore_inline_actual_text(source,writer):
    """Restore only source-owned inline text overrides to exact paint occurrences."""
    changes=[]
    for number,(src,dst) in enumerate(zip(source.pages,writer.pages),1):
        original=_inline_scopes(src);existing=_inline_scopes(dst)
        if not original and not existing:continue
        if Canonicalizer().hash(src['/Resources'])!=Canonicalizer().hash(dst['/Resources']):
            raise ValueError('inline_page_resources_changed')
        sa,da=atoms(scan(src)),atoms(scan(dst))
        if [item[0] for item in sa]!=[item[0] for item in da]:raise ValueError('inline_page_paint_changed')
        def positions(items):
            result={}
            for index,(token,owners) in enumerate(items):
                if token[0]=='byte':
                    for owner in owners:result.setdefault(owner,set()).add(index)
            return result
        source_positions,candidate_positions=positions(sa),positions(da)
        existing_by={}
        for scope in existing:
            membership=frozenset(candidate_positions.get(scope['show'],set()))
            if not membership or membership in existing_by:raise ValueError('ambiguous_existing_inline_scope')
            existing_by[membership]=scope
        used=set();wrap={}
        for scope in original:
            membership=frozenset(source_positions.get(scope['show'],set()))
            if not membership or membership in used:raise ValueError('ambiguous_source_inline_scope')
            used.add(membership)
            if membership in existing_by:
                if existing_by[membership]['actualText']!=scope['actualText']:
                    raise ValueError('existing_inline_actualtext_conflict')
                continue
            matches=[index for index,values in candidate_positions.items() if values==membership]
            if len(matches)!=1:raise ValueError('exact_inline_paint_occurrence_required')
            show=matches[0]
            if show in wrap:raise ValueError('duplicate_inline_replacement')
            wrap[show]=scope['actualText']
            changes.append({'pageNumber':number,'sourceShowOperation':scope['show'],
                'candidateShowOperation':show,'actualText':scope['actualText']})
        if set(existing_by)-used:raise ValueError('unapproved_extra_inline_actualtext')
        if wrap:
            rewritten=[]
            for index,operation in enumerate(dst.get_contents().operations):
                if index in wrap:
                    rewritten.append(([NameObject('/Span'),DictionaryObject({NameObject('/ActualText'):TextStringObject(wrap[index])})],b'BDC'))
                rewritten.append(operation)
                if index in wrap:rewritten.append(([],b'EMC'))
            stream=ContentStream(None,writer);stream.operations=rewritten;dst.replace_contents(stream)
    return changes


def restore_authored_actual_text(original:Path,candidate:Path,output:Path,*,expected_original_sha256:str,expected_candidate_sha256:str):
    reader,writer=_open(candidate,output)
    candidate_hash=hashlib.sha256(reader.stream.getvalue()).hexdigest()
    if candidate_hash!=expected_candidate_sha256:raise ValueError('candidate_hash_mismatch')
    if not original.is_file() or original.stat().st_size>MAX_BYTES:raise ValueError('bounded_original_required')
    source_bytes=original.read_bytes();source_hash=hashlib.sha256(source_bytes).hexdigest()
    if source_hash!=expected_original_sha256:raise ValueError('source_hash_mismatch')
    source=PdfReader(io.BytesIO(source_bytes),strict=True)
    if source.is_encrypted or len(source.pages)!=len(reader.pages):raise ValueError('matching_unencrypted_pages_required')
    reject_signed_pdf(source)
    source_info=structure_inventory(source);candidate_info=structure_inventory(reader)
    source_native=_tag_nodes(source);candidate_native=_tag_nodes(writer)
    for info,native in [(source_info,source_native),(candidate_info,candidate_native)]:
        if len(info['tags'])!=len(native) or any(str(node.get('/S','')).lstrip('/')!=tag['sourceRole'] for node,tag in zip(native,info['tags'])):
            raise ValueError('native_tag_inventory_mismatch')
    source_nodes=dict(zip([t['id'] for t in source_info['tags']],source_native))
    candidate_nodes=dict(zip([t['id'] for t in candidate_info['tags']],candidate_native))
    candidate_tags={tag['id']:tag for tag in candidate_info['tags']}
    node_ids={id(node):tag_id for tag_id,node in candidate_nodes.items()}
    source_pages={refkey(page):number for number,page in enumerate(source.pages,1)}
    candidate_pages={refkey(page):number for number,page in enumerate(writer.pages,1)}
    parents=parent_entries(resolved(writer.root_object['/StructTreeRoot']))
    replacements=[tag for tag in source_info['tags'] if 'actualText' in tag and tag['role']!='Figure']
    if len(replacements)>1000:raise ValueError('replacement_span_limit')
    pages={};prepared=[];used=set()
    for tag in replacements:
        node=source_nodes[tag['id']];seq=tag['contentSequence']
        if (tag['role']!='Span' or tag['sourceRole']!='Span' or len(seq)!=1 or len(tag['mcids'])!=1
                or seq[0].get('kind')!='markedContent' or not seq[0].get('parentTreeVerified')
                or seq[0].get('streamId') is not None or seq[0].get('pageNumber')!=tag['pageNumber']
                or set(node)-{'/Type','/S','/K','/P','/Pg','/ActualText','/Lang'}
                or not isinstance(node['/ActualText'],TextStringObject) or len(tag['actualText'])>2048):
            raise ValueError('simple_authored_actualtext_span_required')
        number=tag['pageNumber'];source_mcid=tag['mcids'][0]
        if number not in pages:
            src=source.pages[number-1];dst=writer.pages[number-1]
            if Canonicalizer().hash(src['/Resources'])!=Canonicalizer().hash(dst['/Resources']):raise ValueError('span_page_resources_changed')
            sr,dr=scan(src),scan(dst);sa,da=atoms(sr),atoms(dr)
            if [a[0] for a in sa]!=[a[0] for a in da]:raise ValueError('span_painting_program_changed')
            pages[number]={'sourceRows':sr,'candidateRows':dr,'sourceAtoms':sa,'candidateAtoms':da,
                'source':_positions(sr,sa),'candidate':_positions(dr,da),'page':dst,'scopeChanges':{}}
        page=pages[number];sowned,_,_,sby=page['source'];owned,artifact,op_positions,dby=page['candidate']
        positions=sowned.get(source_mcid,set())
        source_paint=[row for row in page['sourceRows'] if row['mcid']==source_mcid and row['op'] in PAINT]
        if (not positions or not source_paint or any(row['op'] not in (b'Tj',b'TJ') or row['placedMetadata'] for row in source_paint)):
            raise ValueError('authored_text_paint_required')
        scope_language=_source_language(source.pages[number-1],source_mcid)
        if '/Lang' in node and scope_language is not None and node['/Lang']!=scope_language:raise ValueError('conflicting_source_span_languages')
        language=scope_language or tag.get('effectiveLanguage')
        matching=[mcid for mcid,items in owned.items() if items==positions]
        page_array=resolved(parents[int(page['page']['/StructParents'])])
        if not isinstance(page_array,ArrayObject):raise ValueError('page_parent_array_required')
        kind='existing';scope=None;anchor=None
        if len(matching)==1:
            mcid=matching[0];owner=resolved(page_array[mcid])
            selected_rows=[row for row in page['candidateRows'] if row['mcid']==mcid and row['op'] in PAINT]
            if any(row['op'] not in (b'Tj',b'TJ') or row['scopedProperties'] or row['placedMetadata'] for row in selected_rows):raise ValueError('candidate_scope_override_unsupported')
            if owner.get('/S')=='/Span' and owner.get('/ActualText')==node['/ActualText']:
                if language and candidate_tags.get(node_ids.get(id(owner)),{}).get('effectiveLanguage')!=language:
                    raise ValueError('existing_replacement_language_conflict')
                prepared.append({'unchanged':True,'tag':tag,'candidateMcid':mcid});continue
            if '/ActualText' in owner:raise ValueError('existing_replacement_text_conflict')
            inherited=candidate_pages.get(refkey(owner.get('/Pg')))
            indexes=[i for i,child in enumerate(_kids(owner)) if _leaf(child,inherited,candidate_pages)==(number,mcid)]
            if len(indexes)!=1:raise ValueError('exact_candidate_mcid_child_required')
            anchor=indexes[0]
        elif not matching and positions<=artifact:
            kind='artifact';selected_ops={index for i in positions for index in page['candidateAtoms'][i][1]}
            scope=_exact_artifact_scope(page['page'],selected_ops,positions,op_positions)
            source_parent=resolved(node['/P']);source_kids=_kids(source_parent)
            indexes=[i for i,child in enumerate(source_kids) if resolved(child) is node]
            if len(indexes)!=1 or indexes[0]==0:raise ValueError('source_logical_predecessor_required')
            inherited=source_pages.get(refkey(source_parent.get('/Pg')))
            previous=_leaf(source_kids[indexes[0]-1],inherited,source_pages)
            if previous is None or previous[0]!=number:raise ValueError('same_page_source_predecessor_required')
            previous_positions=sowned.get(previous[1],set())
            anchors=[m for m,items in owned.items() if previous_positions and items==previous_positions]
            if len(anchors)!=1:raise ValueError('unchanged_logical_predecessor_required')
            previous_mcid=anchors[0];owner=resolved(page_array[previous_mcid])
            if '/ActualText' in owner:raise ValueError('replacement_text_anchor_conflict')
            inherited=candidate_pages.get(refkey(owner.get('/Pg')))
            indexes=[i for i,child in enumerate(_kids(owner)) if _leaf(child,inherited,candidate_pages)==(number,previous_mcid)]
            if len(indexes)!=1:raise ValueError('exact_predecessor_child_required')
            anchor=previous_mcid;mcid=None
        else:raise ValueError('exact_authored_paint_occurrence_required')
        if id(owner) not in node_ids or owner.get('/S') not in {'/P','/Span','/Link','/TOCI','/TD','/TH','/Caption','/H1','/H2','/H3','/H4','/H5','/H6'}:
            raise ValueError('supported_native_text_owner_required')
        identity=(number,tuple(sorted(positions)))
        if identity in used:raise ValueError('duplicate_authored_replacement_membership')
        used.add(identity)
        prepared.append({'unchanged':False,'tag':tag,'sourceNode':node,'number':number,'page':page,'array':page_array,
            'mcid':mcid,'owner':owner,'ownerId':node_ids[id(owner)],'anchor':anchor,'kind':kind,'scope':scope,'language':language})
    changes=[]
    for repair in prepared:
        if repair['unchanged']:continue
        tag=repair['tag'];owner=repair['owner'];page=repair['page'];kids=_kids(owner)
        inherited=candidate_pages.get(refkey(owner.get('/Pg')))
        if repair['kind']=='existing':
            mcid=repair['mcid'];indexes=[i for i,child in enumerate(kids) if _leaf(child,inherited,candidate_pages)==(repair['number'],mcid)]
            if len(indexes)!=1:raise ValueError('candidate_child_changed_during_repair')
            at=indexes[0];leaf=kids[at]
        else:
            # Resolve the pinned original child again after earlier insertions.
            indexes=[i for i,child in enumerate(kids) if _leaf(child,inherited,candidate_pages)==(repair['number'],repair['anchor'])]
            if len(indexes)!=1:raise ValueError('artifact_anchor_changed')
            at=indexes[0]+1;mcid=len(repair['array']);repair['array'].append(NullObject())
            leaf=DictionaryObject({NameObject('/Type'):NameObject('/MCR'),NameObject('/Pg'):page['page'].indirect_reference,NameObject('/MCID'):NumberObject(mcid)})
            if repair['scope'] in page['scopeChanges']:raise ValueError('duplicate_artifact_scope')
            page['scopeChanges'][repair['scope']]=mcid
        span=DictionaryObject({NameObject('/Type'):NameObject('/StructElem'),NameObject('/S'):NameObject('/Span'),
            NameObject('/P'):owner.indirect_reference,NameObject('/Pg'):page['page'].indirect_reference,
            NameObject('/K'):leaf,NameObject('/ActualText'):TextStringObject(tag['actualText'])})
        if repair['language']:span[NameObject('/Lang')]=TextStringObject(repair['language'])
        reference=writer._add_object(span)
        if repair['kind']=='existing':kids[at]=reference
        else:kids.insert(at,reference)
        owner[NameObject('/K')]=ArrayObject(kids);repair['array'][mcid]=reference
        changes.append({'sourceTagId':tag['id'],'pageNumber':repair['number'],'sourceMcid':tag['mcids'][0],
            'candidateOwnerTagId':repair['ownerId'],'candidateMcid':mcid,'actualText':tag['actualText'],'language':repair['language'],'restoredFromArtifact':repair['kind']=='artifact'})
    for page in pages.values():
        if not page['scopeChanges']:continue
        operations=list(page['page'].get_contents().operations)
        for index,mcid in page['scopeChanges'].items():
            operations[index]=([NameObject('/Span'),DictionaryObject({NameObject('/MCID'):NumberObject(mcid)})],b'BDC')
        stream=ContentStream(None,writer);stream.operations=operations;page['page'].replace_contents(stream)
    inline_changes=_restore_inline_actual_text(source,writer)
    output_hash=_save(writer,output)
    preservation=compare_pdfs(candidate,output)
    from verify_pdf import compare_actual_text_associations
    associations=compare_actual_text_associations(source,PdfReader(output,strict=True))
    if not associations['passed']:raise ValueError('saved_authored_actualtext_association_failed')
    # The intermediate input has lost these exact source-owned scopes. The
    # independent original comparison above authorizes their restoration only;
    # it does not waive any changed painting, resource, language, or other text.
    if not preservation['preservation']['passed']:
        expected_additions=preservation.get('actual_text_associations',{}).get('unexpectedOutputInlineReplacements',[])
        if (preservation.get('inspection_incomplete') or not inline_changes
                or len(expected_additions)!=len(inline_changes)
                or not preservation.get('findings')
                or any(item.get('code')!='unexpected_inline_actual_text' for item in preservation['findings'])):
            raise ValueError('actualtext_repair_changed_original_paint')
    return {'schemaVersion':1,'experimental':True,'certification':False,'requiresFreshAuditAndValidation':True,
        'sourceSha256':source_hash,'inputSha256':candidate_hash,'outputSha256':output_hash,'restored':changes,'restoredInlineScopes':inline_changes,
        'alreadyPreserved':sum(item['unchanged'] for item in prepared),'originalPagePreservation':True,'authoredActualTextAssociations':associations}
