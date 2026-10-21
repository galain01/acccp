"""Independent, explicit verification for an authorized description appendix.

The ordinary PDF verifier remains strict. This wrapper proves the new pages and
tags against an approved manifest, then compares the untouched original prefix
with that ordinary verifier. The actual full output remains the audit target.
"""
from __future__ import annotations
from collections import OrderedDict
import hashlib
import io
import json
from pathlib import Path
import re
import tempfile

import pypdfium2 as pdfium
from pypdf import PdfReader,PdfWriter
from pypdf.generic import ArrayObject,DictionaryObject,NameObject,NumberObject,TextStringObject
from reportlab.pdfbase.ttfonts import TTFontFace
import verify_pdf as v
from pdf_safety import reject_signed_pdf
from preserve_figures import parent_entries
from semantic_repairs import _tag_nodes

PINNED_PROGRAMS={
    'LiberationSans':'76d04c18ea243f426b7de1f3ad208e927008f961dc5945e5aad352d0dfde8ee8',
    'LiberationSans-Bold':'788abee4c806d660e8aee46689dd8540cd4bb98da03dcc9d171ce3efd99a9173',
}


def require(condition,code):
    if not condition:raise v.InspectionError(code)


def normalized(text):return re.sub(r'\s+',' ',text).strip()


def _reader(path):
    require(path.is_file() and path.stat().st_size<=v.MAX_FILE_BYTES,'appendix_file_out_of_bounds')
    reader=PdfReader(path,strict=True);require(not reader.is_encrypted,'encrypted_pdf_unsupported');reject_signed_pdf(reader)
    return reader


def _kids(node):
    value=v.resolved(node.get('/K'))
    return list(value) if isinstance(value,ArrayObject) else ([] if value is None else [node.raw_get('/K')])


def _figure_native_ids(reader, inventory):
    """Cross-check the two independent inventories before translating their IDs."""
    figures=v.figure_association_inventory(reader)['figures']
    tags=[tag for tag in inventory['tags'] if tag['role']=='Figure']
    require(len(figures)==len(tags),'appendix_figure_inventory_mismatch')
    result={}
    for figure,tag in zip(figures,tags):
        keys=[{'pageNumber':c['pageNumber'],'mcid':c['mcid']} for c in tag['contentSequence'] if c.get('kind')=='markedContent']
        require(figure['pageNumber']==tag['pageNumber'] and keys==figure['contentKeys'],'appendix_nested_figure_unsupported')
        result[figure['id']]=tag['id']
    return result


def _parent_value(value):
    if isinstance(value,DictionaryObject) and '/S' in value:
        require(value.indirect_reference is not None,'appendix_indirect_owner_required')
        return value.indirect_reference
    return value


def _structure_signature(reader,excluded):
    """Compare all original native attributes, ownership and child ordering."""
    root=v.resolved(reader.trailer['/Root']['/StructTreeRoot'])
    all_nodes=_tag_nodes(reader);excluded=set(excluded)
    for node in all_nodes:
        if id(v.resolved(node.get('/P'))) in excluded:excluded.add(id(node))
    original_nodes=[node for node in all_nodes if id(node) not in excluded]
    class NativeCanonicalizer(v.Canonicalizer):
        def __init__(self):
            super().__init__(list(reader.pages));self.native={id(node):i for i,node in enumerate(original_nodes)}
        def value(self,item,active=None,depth=0):
            target=v.resolved(item)
            if target is root:return {'originalStructureRoot':True}
            if id(target) in self.native:return {'originalNativeTag':self.native[id(target)]}
            if isinstance(target,DictionaryObject) and target.get('/Type')=='/StructElem':
                raise v.InspectionError('appendix_unapproved_native_cross_reference')
            return super().value(item,active,depth)
    seen=set();canonical=NativeCanonicalizer();native=[]
    def walk(value,parent,depth=0):
        require(depth<=64,'appendix_structure_depth_limit');value=v.resolved(value)
        if isinstance(value,ArrayObject):return [result for item in value if (result:=walk(item,parent,depth+1)) is not None]
        if isinstance(value,DictionaryObject) and '/S' in value:
            if id(value) in excluded:return None
            require(id(value) not in seen,'appendix_reused_tag');seen.add(id(value));native.append(value)
            require(v.resolved(value.get('/P')) is parent,'appendix_original_parent_changed')
            attributes={key:item for key,item in value.items() if key not in ('/P','/K')}
            kids=[result for item in _kids(value) if (result:=walk(item,value,depth+1)) is not None]
            return {'attributes':canonical.value(attributes),'children':kids}
        return {'content':canonical.value(value)}
    signature=[result for child in _kids(root) if (result:=walk(child,root)) is not None]
    root_attrs={key:value for key,value in root.items() if key not in ('/K','/ParentTree','/ParentTreeNextKey')}
    return {'attributes':canonical.value(root_attrs),'children':signature},native


def _verify_font(font,codes):
    font=v.resolved(font);name=str(font.get('/BaseFont','')).lstrip('/')
    require(name in PINNED_PROGRAMS and font.get('/Subtype')=='/Type0' and font.get('/Encoding')=='/Identity-H','appendix_font_type_unsupported')
    descendants=v.resolved(font.get('/DescendantFonts'));require(isinstance(descendants,ArrayObject) and len(descendants)==1,'appendix_font_descendant_invalid')
    child=v.resolved(descendants[0]);require(child.get('/Subtype')=='/CIDFontType2','appendix_font_subtype_invalid')
    descriptor=v.resolved(child.get('/FontDescriptor'));program=v.resolved(descriptor.get('/FontFile2')).get_data()
    require(hashlib.sha256(program).hexdigest()==PINNED_PROGRAMS[name],'appendix_font_program_not_pinned')
    face=TTFontFace(io.BytesIO(program),validate=1);glyphs=v.resolved(child.get('/CIDToGIDMap')).get_data();widths={}
    array=v.resolved(child.get('/W'));require(isinstance(array,ArrayObject) and len(array)%2==0,'appendix_font_widths_unsupported')
    for i in range(0,len(array),2):
        code=v.integer(array[i]);values=v.resolved(array[i+1]);require(code is not None and isinstance(values,ArrayObject),'appendix_font_widths_invalid')
        for offset,value in enumerate(values):require(code+offset not in widths,'appendix_duplicate_width');widths[code+offset]=float(value)
    for code in codes:
        require(code in face.charToGlyph and face.charToGlyph[code]!=0 and code*2+2<=len(glyphs),'appendix_font_glyph_missing')
        require(int.from_bytes(glyphs[code*2:code*2+2],'big')==face.charToGlyph[code],'appendix_glyph_mapping_changed')
        require(code in widths and abs(widths[code]-face.charWidths[code])<.01,'appendix_font_advance_changed')
    require(font.get('/ToUnicode') is not None,'appendix_unicode_map_missing')


def _verify_new_pages(path,reader,start,expected_text):
    actual=[];font_codes={};font_objects={}
    for page_number in range(start,len(reader.pages)):
        page=reader.pages[page_number];require(tuple(float(x) for x in page.mediabox)==(0,0,612,792),'appendix_page_size_changed')
        require(set(page)<={'/Type','/Parent','/Resources','/MediaBox','/Contents','/StructParents','/Tabs'} and page.get('/Tabs')=='/S','appendix_page_properties_unsupported')
        require(not page.get('/Annots') and not page.get('/AA'),'appendix_page_behavior_unsupported')
        resources=v.resolved(page.get('/Resources'));require(set(resources)=={'/Font'},'appendix_resources_unsupported')
        fonts=v.resolved(resources['/Font']);require(set(fonts)=={'/FR','/FB'},'appendix_fonts_unexpected')
        for font_ref in fonts.values():
            font=v.resolved(font_ref);font_objects[id(font)]=font;font_codes.setdefault(id(font),set())
        selected=None;point_size=None;matrix=None;previous_y=None;in_text=False;in_mark=False
        for args,operator in v.operations(page):
            require(operator in {b'BDC',b'EMC',b'BT',b'ET',b'Tf',b'Tm',b'Tj'},'appendix_unapproved_painting_operator')
            if operator==b'BDC':require(not in_mark and len(args)==2 and isinstance(args[1],DictionaryObject) and set(args[1])=={'/MCID'},'appendix_scope_invalid');in_mark=True
            elif operator==b'EMC':require(in_mark and not in_text,'appendix_scope_unbalanced');in_mark=False
            elif operator==b'BT':require(in_mark and not in_text,'appendix_text_state_invalid');in_text=True
            elif operator==b'ET':require(in_text,'appendix_text_state_invalid');in_text=False
            elif operator==b'Tf':
                require(in_text and len(args)==2 and args[0] in fonts and float(args[1]) in (11,12,15),'appendix_text_font_invalid')
                selected=str(args[0]);point_size=float(args[1])
            elif operator==b'Tm':
                require(in_text and len(args)==6 and tuple(float(x) for x in args[:4])==(1,0,0,1) and float(args[4])==42 and 42<=float(args[5])<=750,'appendix_text_geometry_invalid');matrix=args
            elif operator==b'Tj':
                require(in_text and in_mark and selected is not None and matrix is not None and len(args)==1,'appendix_text_unowned')
                raw=args[0].original_bytes if isinstance(args[0],TextStringObject) else bytes(args[0]);require(len(raw)%2==0,'appendix_text_encoding_invalid')
                text=raw.decode('utf-16-be');require(text and '\ufffd' not in text,'appendix_text_invalid');actual.append(text)
                y=float(matrix[5]);require(previous_y is None or previous_y-y>=14,'appendix_overlapping_lines');previous_y=y
                font=v.resolved(fonts[selected]);key=id(font);font_objects[key]=font;font_codes.setdefault(key,set()).update(ord(c) for c in text)
        require(not in_mark and not in_text,'appendix_text_state_unbalanced')
    require(normalized(' '.join(actual))==normalized(expected_text),'appendix_text_differs_from_approved_manifest')
    for key,codes in font_codes.items():_verify_font(font_objects[key],codes)
    rendered=[]
    with pdfium.PdfDocument(str(path)) as document:
        for number in range(start,len(document)):
            page=document[number];text=page.get_textpage()
            try:
                rendered.append(text.get_text_bounded())
                for index in range(text.count_chars()):
                    if text.get_text_range(index,1).isspace():continue
                    left,bottom,right,top=text.get_charbox(index)
                    require(40<=left<=right<=572 and 35<=bottom<=top<=770,'appendix_glyph_clipped_or_outside_margin')
            finally:text.close();page.close()
    require(normalized(' '.join(rendered))==normalized(expected_text),'appendix_rendered_unicode_differs')
    return {'passed':True,'embeddedPinnedFontsVerified':True,'exactApprovedTextVerified':True,'pageCount':len(reader.pages)-start,'glyphBoundsVerified':True}


def compare_with_authorized_appendix(original:Path,final:Path,manifest:dict,navigation_manifest=None):
    report={'passed':False,'certification':False,'accessibility_ready':False,'semantic_review_required':True,'preservation':{'passed':False},'appendix_validation':{'passed':False},'findings':[]}
    try:
        before=_reader(original);after=_reader(final)
        require(isinstance(manifest,dict) and manifest.get('schemaVersion')==1 and manifest.get('outputSha256')==v.digest(final.read_bytes()),'appendix_final_hash_mismatch')
        baseline_path=Path(manifest.get('baselinePath',''));baseline=_reader(baseline_path)
        require(v.digest(baseline_path.read_bytes())==manifest.get('inputSha256'),'appendix_baseline_hash_mismatch')
        require(after.trailer['/Root'].get('/Lang')==baseline.trailer['/Root'].get('/Lang'),'appendix_original_language_changed')
        approved=manifest.get('approvedManifest');require(isinstance(approved,dict) and approved.get('approved') is True and approved.get('schemaVersion')==1 and approved.get('inputSha256')==manifest['inputSha256'],'appendix_approval_mismatch')
        require(v.digest(json.dumps(approved,sort_keys=True,separators=(',',':'),ensure_ascii=True).encode())==manifest.get('manifestSha256'),'appendix_manifest_hash_mismatch')
        require(type(approved.get('headingLevel')) is int and 2<=approved['headingLevel']<=5,'appendix_heading_level_invalid')
        require(len(before.pages)==len(baseline.pages) and 1<=len(after.pages)-len(before.pages)<=2 and len(after.pages)<=60,'appendix_page_count_invalid')
        evidence=manifest.get('evidenceFiles',{})
        require(set(evidence)=={e['id'] for e in approved['evidence']},'appendix_evidence_ids_invalid')
        for item in approved['evidence']:
            path=Path(evidence[item['id']]);require(path.is_file() and path.stat().st_size<=20*1024*1024 and v.digest(path.read_bytes())==item['sha256'],'appendix_evidence_hash_mismatch')
        source_count=len(before.pages);base_info=v.structure_inventory(baseline);full_info=v.structure_inventory(after)
        base_tags={t['id']:t for t in base_info['tags']};after_tags={t['id']:t for t in full_info['tags']};after_nodes=dict(zip(after_tags,_tag_nodes(after)))
        associations=v.compare_figure_associations(baseline,after);require(associations['passed'],'appendix_original_figure_association_changed')
        base_figure_ids=_figure_native_ids(baseline,base_info);after_figure_ids=_figure_native_ids(after,full_info)
        association_map={base_figure_ids[item['sourceFigureId']]:after_figure_ids[item['outputFigureId']] for item in associations['comparisons']}
        groups=OrderedDict()
        for section in approved['sections']:groups.setdefault(section['figureTagId'],[]).append(section)
        require(1<=len(groups)<=2,'appendix_group_count_invalid')
        for sections in groups.values():
            previous=approved['headingLevel']
            for section in sections:
                level=section.get('headingLevel',approved['headingLevel']+1)
                require(type(level) is int and approved['headingLevel']<level<=6 and level<=previous+1,'appendix_heading_hierarchy_invalid')
                previous=level
        roots=[];expected_text=[]
        for figure_id,sections in groups.items():
            require(figure_id in association_map,'appendix_source_figure_missing');figure=after_nodes[association_map[figure_id]]
            require(all(section['sourcePageNumber']==base_tags[figure_id]['pageNumber'] for section in sections),'appendix_source_page_mismatch')
            parent=v.resolved(figure['/P']);kids=_kids(parent);positions=[i for i,kid in enumerate(kids) if v.resolved(kid) is figure]
            require(len(positions)==1 and positions[0]+1<len(kids),'appendix_not_after_figure')
            section_root=v.resolved(kids[positions[0]+1]);require(section_root.get('/S')=='/Sect' and v.resolved(section_root.get('/P')) is parent and section_root.get('/Lang')==approved['language'],'appendix_section_invalid')
            require(set(section_root)=={'/Type','/S','/P','/K','/Lang','/Pg'},'appendix_section_override_unsupported')
            require(id(section_root) not in {id(x) for x in roots},'appendix_duplicate_section');roots.append(section_root)
            expected=[('H'+str(approved['headingLevel']),approved['title'])]
            for section in sections:expected.extend([('H'+str(section.get('headingLevel',approved['headingLevel']+1)),section['heading']),*[('P',p) for p in section['paragraphs']]])
            native_children=_kids(section_root);require(len(native_children)==len(expected),'appendix_unexpected_semantic_content')
            for child,(role,text) in zip(native_children,expected):
                node=v.resolved(child);tag=next((t for i,t in after_tags.items() if after_nodes[i] is node),None)
                require(set(node)=={'/Type','/S','/P','/K','/Pg'},'appendix_child_override_unsupported')
                require(tag is not None and tag['role']==role and not tag.get('textIncomplete') and normalized(tag['text'])==normalized(text),'appendix_semantic_text_mismatch')
                require(tag['contentSequence'] and all(c.get('kind')=='markedContent' and c.get('resolved') and c.get('parentTreeVerified') and c.get('streamId') is None and source_count<c['pageNumber']<=len(after.pages) for c in tag['contentSequence']),'appendix_content_reference_invalid')
                require(not any(k in node for k in ('/Alt','/ActualText')),'appendix_text_override_unsupported')
                expected_text.append(text)
        base_signature,base_nodes=_structure_signature(baseline,set());final_signature,old_nodes=_structure_signature(after,{id(x) for x in roots})
        require(base_signature==final_signature,'appendix_original_structure_changed')
        base_parents=parent_entries(v.resolved(baseline.trailer['/Root']['/StructTreeRoot']));final_parents=parent_entries(v.resolved(after.trailer['/Root']['/StructTreeRoot']))
        lineage={id(left):right for left,right in zip(base_nodes,old_nodes)}
        for key,value in base_parents.items():
            require(key in final_parents,'appendix_original_parent_key_lost');a=v.resolved(value);b=v.resolved(final_parents[key])
            left_entries=list(a) if isinstance(a,ArrayObject) else [a];right_entries=list(b) if isinstance(b,ArrayObject) else [b]
            require(len(left_entries)==len(right_entries),'appendix_original_parent_array_changed')
            for left,right in zip(left_entries,right_entries):
                left=v.resolved(left);right=v.resolved(right)
                require((type(left).__name__=='NullObject' and type(right).__name__=='NullObject') or id(left) in lineage and lineage[id(left)] is right,'appendix_original_parent_owner_changed')
        report['appendix_validation']=_verify_new_pages(final,after,source_count,' '.join(expected_text))
        report['appendix_validation'].update({'originalNativeTagsAndRelativeOrderPreserved':True,'originalParentTreeOwnersPreserved':True,'originalFigureAssociationsPreserved':True,'manifestSha256':manifest['manifestSha256']})
        # Remove only the independently identified new sections/pages from a
        # temporary comparison projection. The actual final file stays intact.
        normalized_reader=after
        if navigation_manifest is not None:
            from navigation_repairs import authorize_navigation
            _,normalized_reader,nav=authorize_navigation(original,final,navigation_manifest);report['navigation_validation']={'passed':True,'changes':nav}
        projection=PdfWriter(clone_from=normalized_reader);project_nodes=_tag_nodes(projection);positions={id(node):i for i,node in enumerate(_tag_nodes(after))}
        for section_root in roots:
            node=project_nodes[positions[id(section_root)]];parent=v.resolved(node['/P']);parent[NameObject('/K')]=ArrayObject([kid for kid in _kids(parent) if v.resolved(kid) is not node])
        projected_root=v.resolved(projection.root_object['/StructTreeRoot']);keys=parent_entries(projected_root)
        projected_root[NameObject('/ParentTree')]=projection._add_object(DictionaryObject({NameObject('/Nums'):ArrayObject([value for key in sorted(base_parents) for value in (NumberObject(key),_parent_value(keys[key]))])}))
        while len(projection.pages)>source_count:projection.remove_page(len(projection.pages)-1)
        with tempfile.TemporaryDirectory(prefix='pdf-appendix-verify-') as directory:
            prefix=Path(directory)/'verified-original-prefix.pdf'
            with prefix.open('xb') as handle:projection.write(handle)
            prefix_report=v.compare_pdfs(original,prefix)
        report['preservation']=prefix_report['preservation'];report['figure_associations']=v.compare_figure_associations(before,after)
        report['actual_text_associations']=v.compare_actual_text_associations(before,after)
        full_info['authored_alternative_associations_verified']=report['figure_associations']['passed'] and prefix_report.get('structure',{}).get('authored_alternative_associations_verified') is True
        full_info['passed']=full_info['machine_checks_passed']
        report['source_structure']=v.structure_inventory(before);report['structure']=full_info
        report['findings']=prefix_report['findings'];report['mechanical_checks_passed']=report['preservation']['passed'] and report['appendix_validation']['passed'] and full_info['machine_checks_passed'] and report['figure_associations']['passed'] and report['actual_text_associations']['passed'] and not report['findings']
        report['passed']=report['mechanical_checks_passed'] and full_info['checks_complete'] and not full_info['findings'] and full_info['authored_alternative_associations_verified']
    except Exception as error:
        report['inspection_incomplete']=True
        report['findings'].append({'severity':'error','code':str(error) if isinstance(error,v.InspectionError) else 'appendix_verification_incomplete'})
    return report
