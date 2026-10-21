"""Append approved, source-grounded image descriptions without repainting originals.

The appended pages use pinned embedded Liberation fonts and real native tags.
Each description group follows its existing Figure in the reading tree. This is
an experimental authoring operation, not an accessibility/conformance claim.
"""
from __future__ import annotations
from collections import OrderedDict
import hashlib
import json
from pathlib import Path
import re

from pypdf.generic import (ArrayObject, ByteStringObject, ContentStream, DecodedStreamObject,
    DictionaryObject, FloatObject, NameObject, NumberObject, TextStringObject)
from reportlab.pdfbase.ttfonts import TTFontFace

from conformance_repairs import _open, _save
from preserve_figures import parent_entries
from semantic_repairs import _tag_nodes
from pdf_safety import resolved
from verify_pdf import structure_inventory

FONTS = {
    'regular': ('LiberationSans-Regular.ttf','LiberationSans','76d04c18ea243f426b7de1f3ad208e927008f961dc5945e5aad352d0dfde8ee8'),
    'bold': ('LiberationSans-Bold.ttf','LiberationSans-Bold','788abee4c806d660e8aee46689dd8540cd4bb98da03dcc9d171ce3efd99a9173'),
}


def normalized(text):
    return re.sub(r'\s+',' ',text).strip()


def manifest_digest(manifest):
    return hashlib.sha256(json.dumps(manifest,sort_keys=True,separators=(',',':'),ensure_ascii=True).encode()).hexdigest()


def _parent_value(value):
    # Annotation ParentTree entries point directly at their native StructElem.
    # Re-embedding a resolved dictionary would detach it from the reading tree.
    if isinstance(value,DictionaryObject) and '/S' in value:
        if value.indirect_reference is None:raise ValueError('indirect_parent_owner_required')
        return value.indirect_reference
    return value


def validate_manifest(manifest, input_hash, evidence_files):
    if (not isinstance(manifest,dict) or set(manifest)!={'schemaVersion','inputSha256','approved','language','headingLevel','title','evidence','sections'}
            or manifest['schemaVersion']!=1 or manifest['approved'] is not True or manifest['inputSha256']!=input_hash):
        raise ValueError('approved_matching_appendix_manifest_required')
    if type(manifest['headingLevel']) is not int or not 2<=manifest['headingLevel']<=5:
        raise ValueError('explicit_appendix_heading_level_required')
    if not isinstance(manifest['language'],str) or not re.fullmatch(r'[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*',manifest['language']):
        raise ValueError('explicit_appendix_language_required')
    if not isinstance(manifest['evidence'],list) or not 1<=len(manifest['evidence'])<=8:
        raise ValueError('bounded_evidence_required')
    evidence={}
    for item in manifest['evidence']:
        if not isinstance(item,dict) or set(item)!={'id','sha256'} or not isinstance(item['id'],str) or item['id'] in evidence:
            raise ValueError('invalid_evidence_manifest')
        path=Path(evidence_files.get(item['id'],''))
        if not path.is_file() or path.stat().st_size>20*1024*1024 or hashlib.sha256(path.read_bytes()).hexdigest()!=item['sha256']:
            raise ValueError('evidence_hash_mismatch')
        evidence[item['id']]=str(path.resolve())
    if set(evidence_files)!=set(evidence):raise ValueError('exact_evidence_files_required')
    if not isinstance(manifest['sections'],list) or not 1<=len(manifest['sections'])<=12:
        raise ValueError('bounded_sections_required')
    strings=[manifest['title']];groups=OrderedDict()
    last=None
    for section in manifest['sections']:
        if (not isinstance(section,dict) or not {'figureTagId','sourcePageNumber','heading','paragraphs','evidenceIds'}<=set(section)
                or set(section)-{'figureTagId','sourcePageNumber','heading','paragraphs','evidenceIds','headingLevel'}
                or not isinstance(section['figureTagId'],str) or not re.fullmatch(r'tag-[1-9][0-9]{0,4}',section['figureTagId'])
                or type(section['sourcePageNumber']) is not int or section['sourcePageNumber']<1
                or not isinstance(section['paragraphs'],list) or not 1<=len(section['paragraphs'])<=30
                or not isinstance(section['evidenceIds'],list) or not section['evidenceIds']
                or any(identifier not in evidence for identifier in section['evidenceIds'])):
            raise ValueError('invalid_description_section')
        key=section['figureTagId']
        if key in groups and key!=last:raise ValueError('figure_sections_must_be_contiguous')
        groups.setdefault(key,[]).append(section);last=key
        strings.extend([section['heading'],*section['paragraphs']])
    for sections in groups.values():
        previous=manifest['headingLevel']
        for section in sections:
            level=section.get('headingLevel',manifest['headingLevel']+1)
            if type(level) is not int or not manifest['headingLevel']<level<=6 or level>previous+1:
                raise ValueError('invalid_appendix_heading_hierarchy')
            previous=level
    if len(groups)>2 or sum(len(value) for value in strings if isinstance(value,str))>16_000:
        raise ValueError('appendix_content_limit')
    for text in strings:
        if (not isinstance(text,str) or not 1<=len(text)<=5000 or not normalized(text)
                or any(ord(c)>0xffff or ord(c)<32 and c not in '\n\r\t' for c in text)):
            raise ValueError('unsupported_appendix_text')
    return groups,evidence


def _font(writer,font_directory,kind,characters):
    filename,name,expected=FONTS[kind];path=font_directory/filename
    if not path.is_file() or path.stat().st_size>2*1024*1024:raise ValueError('verified_font_required')
    data=path.read_bytes()
    if hashlib.sha256(data).hexdigest()!=expected:raise ValueError('font_program_hash_mismatch')
    face=TTFontFace(str(path),validate=1)
    if face.name.decode('ascii')!=name:raise ValueError('font_name_mismatch')
    codes=sorted({ord(c) for c in characters})
    if any(code not in face.charToGlyph or face.charToGlyph[code]==0 for code in codes):raise ValueError('appendix_glyph_missing')
    program=DecodedStreamObject();program.set_data(data);program[NameObject('/Length1')]=NumberObject(len(data))
    descriptor=DictionaryObject({NameObject('/Type'):NameObject('/FontDescriptor'),NameObject('/FontName'):NameObject('/'+name),
        NameObject('/Flags'):NumberObject((face.flags & ~4)|32),NameObject('/FontBBox'):ArrayObject([FloatObject(x) for x in face.bbox]),
        NameObject('/Ascent'):FloatObject(face.ascent),NameObject('/Descent'):FloatObject(face.descent),NameObject('/CapHeight'):FloatObject(face.capHeight),
        NameObject('/ItalicAngle'):FloatObject(face.italicAngle),NameObject('/StemV'):NumberObject(face.stemV),NameObject('/FontFile2'):writer._add_object(program)})
    glyphs=bytearray((max(codes)+1)*2)
    for code in codes:glyphs[code*2:code*2+2]=int(face.charToGlyph[code]).to_bytes(2,'big')
    mapping=DecodedStreamObject();mapping.set_data(bytes(glyphs))
    descendant=DictionaryObject({NameObject('/Type'):NameObject('/Font'),NameObject('/Subtype'):NameObject('/CIDFontType2'),NameObject('/BaseFont'):NameObject('/'+name),
        NameObject('/CIDSystemInfo'):DictionaryObject({NameObject('/Registry'):TextStringObject('Adobe'),NameObject('/Ordering'):TextStringObject('Identity'),NameObject('/Supplement'):NumberObject(0)}),
        NameObject('/FontDescriptor'):writer._add_object(descriptor),NameObject('/CIDToGIDMap'):writer._add_object(mapping),NameObject('/DW'):NumberObject(1000),
        NameObject('/W'):ArrayObject([item for code in codes for item in (NumberObject(code),ArrayObject([FloatObject(face.charWidths[code])]))])})
    cmap=['/CIDInit /ProcSet findresource begin','12 dict begin','begincmap',
          '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def',
          '/CMapName /AppendixUnicode def','/CMapType 2 def','1 begincodespacerange','<0000> <FFFF>','endcodespacerange']
    for start in range(0,len(codes),100):
        batch=codes[start:start+100];cmap.append(f'{len(batch)} beginbfchar')
        cmap.extend(f'<{code:04X}> <{code:04X}>' for code in batch);cmap.append('endbfchar')
    cmap.extend(['endcmap','CMapName currentdict /CMap defineresource pop','end','end'])
    unicode=DecodedStreamObject();unicode.set_data(('\n'.join(cmap)+'\n').encode('ascii'))
    font=DictionaryObject({NameObject('/Type'):NameObject('/Font'),NameObject('/Subtype'):NameObject('/Type0'),NameObject('/BaseFont'):NameObject('/'+name),
        NameObject('/Encoding'):NameObject('/Identity-H'),NameObject('/DescendantFonts'):ArrayObject([writer._add_object(descendant)]),NameObject('/ToUnicode'):writer._add_object(unicode)})
    return writer._add_object(font),face


def _lines(text,face,size):
    result=[];line=''
    width=lambda s:sum(face.charWidths[ord(c)] for c in s)*size/1000
    for word in normalized(text).split(' '):
        if width(word)>528:raise ValueError('appendix_word_too_wide')
        proposed=line+' '+word if line else word
        if width(proposed)>528:result.append(line);line=word
        else:line=proposed
    if line:result.append(line)
    return result


def append_description_pages(source:Path,output:Path,approved_manifest:dict,*,evidence_files:dict[str,Path],font_directory:Path):
    reader,writer=_open(source,output);source_hash=hashlib.sha256(reader.stream.getvalue()).hexdigest()
    groups,evidence=validate_manifest(approved_manifest,source_hash,evidence_files)
    if len(reader.pages)>58:raise ValueError('appendix_total_page_limit')
    inventory=structure_inventory(reader);tags={tag['id']:tag for tag in inventory['tags']};nodes=dict(zip(tags,_tag_nodes(writer)))
    if len(nodes)!=len(tags):raise ValueError('native_tag_inventory_mismatch')
    parents=[]
    for figure_id,sections in groups.items():
        tag=tags.get(figure_id);figure=nodes.get(figure_id)
        if (tag is None or tag['role']!='Figure' or tag.get('textIncomplete')
                or any(s['sourcePageNumber']!=tag['pageNumber'] for s in sections)
                or tags.get(tag['parentId'],{}).get('role') not in {'Document','Part','Art','Sect','Div'}):
            raise ValueError('verified_block_figure_required')
        parent=resolved(figure.get('/P'));kids=resolved(parent.get('/K'));kids=list(kids) if isinstance(kids,ArrayObject) else [parent.raw_get('/K')]
        if sum(resolved(kid) is figure for kid in kids)!=1:raise ValueError('unique_figure_position_required')
        parents.append((figure_id,figure,parent))
    characters=''.join(normalized(t) for t in [approved_manifest['title'],*[text for s in approved_manifest['sections'] for text in [s['heading'],*s['paragraphs']]]])+' '
    font_data={kind:_font(writer,font_directory,kind,characters) for kind in FONTS}
    root=resolved(writer.root_object['/StructTreeRoot']);tree=parent_entries(root);next_key=max(tree,default=-1)+1
    original_pages=len(reader.pages);page=None;page_ops=[];page_owners=[];y=750;new_pages=[];group_records=[]
    def finish_page():
        if page is not None:
            stream=ContentStream(None,writer);stream.operations=page_ops
            page[NameObject('/Contents')]=writer._add_object(stream)
            tree[int(page['/StructParents'])]=ArrayObject(page_owners)
    def start_page():
        nonlocal page,page_ops,page_owners,y,next_key
        finish_page()
        if len(writer.pages)-original_pages>=2:raise ValueError('appendix_two_page_limit')
        page=writer.add_blank_page(612,792);page[NameObject('/StructParents')]=NumberObject(next_key);next_key+=1
        page[NameObject('/Tabs')]=NameObject('/S')
        page[NameObject('/Resources')]=DictionaryObject({NameObject('/Font'):DictionaryObject({NameObject('/FR'):font_data['regular'][0],NameObject('/FB'):font_data['bold'][0]})})
        page_ops=[];page_owners=[];y=750;new_pages.append(len(writer.pages))
    def node(role,parent):
        value=DictionaryObject({NameObject('/Type'):NameObject('/StructElem'),NameObject('/S'):NameObject('/'+role),NameObject('/P'):parent.indirect_reference,NameObject('/K'):ArrayObject()})
        writer._add_object(value);return value
    def text_block(role,text,section):
        nonlocal y
        title_role='H'+str(approved_manifest['headingLevel'])
        kind='regular' if role=='P' else 'bold';size=11 if role=='P' else 15 if role==title_role else 12;leading=15 if role=='P' else 19 if role==title_role else 16
        lines=_lines(text,font_data[kind][1],size);value=node(role,section);section['/K'].append(value.indirect_reference)
        while lines:
            if y<57:start_page()
            if '/Pg' not in value:value[NameObject('/Pg')]=page.indirect_reference
            take=min(len(lines),max(1,int((y-42)//leading)+1));chunk=lines[:take];lines=lines[take:]
            mcid=len(page_owners);page_owners.append(value.indirect_reference)
            value['/K'].append(DictionaryObject({NameObject('/Type'):NameObject('/MCR'),NameObject('/Pg'):page.indirect_reference,NameObject('/MCID'):NumberObject(mcid)}))
            page_ops.append(([NameObject('/'+role),DictionaryObject({NameObject('/MCID'):NumberObject(mcid)})],b'BDC'))
            page_ops.append(([],b'BT'));page_ops.append(([NameObject('/FR' if kind=='regular' else '/FB'),NumberObject(size)],b'Tf'))
            for line_number,line in enumerate(chunk):
                # Preserve the word boundary when one semantic paragraph spans
                # separate page MCRs; its native text joins those chunks directly.
                if lines and line_number==len(chunk)-1:line+=' '
                page_ops.append(([NumberObject(1),NumberObject(0),NumberObject(0),NumberObject(1),NumberObject(42),FloatObject(y)],b'Tm'))
                page_ops.append(([ByteStringObject(line.encode('utf-16-be'))],b'Tj'));y-=leading
            page_ops.append(([],b'ET'));page_ops.append(([],b'EMC'))
        y-=7
    for figure_id,figure,parent in parents:
        start_page();section=node('Sect',parent);section[NameObject('/Lang')]=TextStringObject(approved_manifest['language']);section[NameObject('/Pg')]=page.indirect_reference
        kids=resolved(parent['/K']);kids=list(kids) if isinstance(kids,ArrayObject) else [parent.raw_get('/K')]
        at=next(i for i,kid in enumerate(kids) if resolved(kid) is figure);kids.insert(at+1,section.indirect_reference);parent[NameObject('/K')]=ArrayObject(kids)
        text_block('H'+str(approved_manifest['headingLevel']),approved_manifest['title'],section)
        for part in groups[figure_id]:
            text_block('H'+str(part.get('headingLevel',approved_manifest['headingLevel']+1)),part['heading'],section)
            for paragraph in part['paragraphs']:text_block('P',paragraph,section)
        group_records.append({'figureTagId':figure_id,'sourcePageNumber':groups[figure_id][0]['sourcePageNumber']})
    finish_page()
    root[NameObject('/ParentTree')]=writer._add_object(DictionaryObject({NameObject('/Nums'):ArrayObject([value for key,entries in sorted(tree.items()) for value in (NumberObject(key),_parent_value(entries))])}))
    root[NameObject('/ParentTreeNextKey')]=NumberObject(next_key)
    output_hash=_save(writer,output)
    if output.stat().st_size>4*1024*1024:raise ValueError('appendix_output_size_limit')
    return {'schemaVersion':1,'experimental':True,'certification':False,'requiresFreshAuditAndValidation':True,
        'baselinePath':str(source.resolve()),'inputSha256':source_hash,'outputSha256':output_hash,
        'approvedManifest':approved_manifest,'manifestSha256':manifest_digest(approved_manifest),'evidenceFiles':evidence,
        'originalPageCount':original_pages,'appendedPageNumbers':new_pages,'groups':group_records,
        'fontPrograms':{kind:{'filename':values[0],'sha256':values[2],'version':'2.1.5','license':'OFL-1.1'} for kind,values in FONTS.items()}}
