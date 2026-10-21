"""Independent saved-file validation of the narrowly authorized OCR exception.

The generic comparator remains strict. Temporary in-memory projections remove
only proven invisible text and the one verified new OCR font for that comparison.
The final saved PDF separately needs exact reviewed Unicode, native ownership,
unchanged pixels, and a fresh visual/semantic audit of every scanned page.
"""
from __future__ import annotations
import hashlib
import io
import json
import math
from pathlib import Path
import re
import tempfile

from pypdf import PdfReader, PdfWriter
from pypdf.generic import (ArrayObject, ContentStream, DictionaryObject, NameObject, TextStringObject)
import pypdfium2 as pdfium
from PIL import Image
from reportlab.pdfbase.ttfonts import TTFontFace

import verify_pdf as v
from description_appendix_validation import _verify_font
from pdf_safety import reject_signed_pdf


def require(condition,code):
    if not condition:raise ValueError(code)


def sha(path):return hashlib.sha256(Path(path).read_bytes()).hexdigest()
def digest(value):return hashlib.sha256(json.dumps(value,sort_keys=True,separators=(',',':'),ensure_ascii=True).encode()).hexdigest()


def _raw_text(value):
    return value.original_bytes if isinstance(value,TextStringObject) else bytes(value)


def _source_paint(reader):
    root=reader.trailer['/Root'];reject_signed_pdf(reader)
    require(not reader.is_encrypted and 1<=len(reader.pages)<=8,'unsupported_scan_source')
    require(not any(k in root for k in ('/StructTreeRoot','/AcroForm','/OCProperties','/OpenAction','/AA','/Collection','/AF')),'unsupported_scan_source_structure')
    result=[]
    for page in reader.pages:
        box=tuple(float(x) for x in page.mediabox)
        require(box[:2]==(0,0) and min(box[2:])>0 and max(box[2:])<=1440 and tuple(map(float,v.resolved(page.get('/CropBox',page['/MediaBox']))))==box
            and float(page.get('/Rotate',0))==0 and float(page.get('/UserUnit',1))==1,'unsupported_scan_geometry')
        require(not any(k in page for k in ('/Annots','/AA','/Group','/PresSteps')) and not v.resolved(page.get('/Trans',{})),'unsupported_scan_page_behavior')
        resources=v.resolved(page.get('/Resources'));require(set(resources)<={'/Font','/XObject','/ProcSet'},'unsupported_scan_source_resources')
        require('/OCRText' not in v.resolved(resources.get('/Font',{})),'ocr_font_collision')
        require(all(v.resolved(font).get('/Subtype')!='/Type3' for font in v.resolved(resources.get('/Font',{})).values()),'source_type3_font')
        images=v.resolved(resources.get('/XObject',{}));require(len(images)==1,'single_scan_image_required')
        image_name,image=next(iter(images.items()));image=v.resolved(image)
        require(image.get('/Subtype')=='/Image' and not any(k in image for k in ('/SMask','/Mask','/Alternates','/OPI','/OC'))
                and not v.pdf_boolean(image.get('/ImageMask')),'unsupported_scan_image')
        require(0<int(image.get('/Width',0))*int(image.get('/Height',0))<=20_000_000,'scan_image_limit')
        painting=[];inside=False;mode=0;stack=[];matrix=[1.,0.,0.,1.,0.,0.];count=0
        ops=v.operations(page);require(len(ops)<=20000,'scan_operator_limit')
        for args,op in ops:
            if op==b'BT':require(not inside,'nested_scan_text');inside=True;continue
            if op==b'ET':require(inside,'unbalanced_scan_text');inside=False;continue
            if inside:
                require(op in {b'Tf',b'TL',b'Tm',b'Td',b'TD',b'T*',b'Tc',b'Tw',b'Tz',b'Ts',b'Tr',b'Tj',b'TJ',b"'",b'"'},'unsupported_scan_text_state')
                if op==b'Tr':require(len(args)==1 and args[0] in (0,3),'scan_clipping_mode');mode=int(args[0])
                if op in {b'Tj',b'TJ',b"'",b'"'}:require(mode==3,'source_text_not_proven_invisible')
                continue
            if op==b'q':stack.append((list(matrix),mode))
            elif op==b'Q':require(bool(stack),'unbalanced_scan_graphics');matrix,mode=stack.pop()
            elif op==b'cm':
                require(len(args)==6 and all(math.isfinite(float(x)) for x in args),'scan_matrix_invalid')
                a,b,c,d,e,f=map(float,args);aa,bb,cc,dd,ee,ff=matrix
                matrix=[a*aa+b*cc,a*bb+b*dd,c*aa+d*cc,c*bb+d*dd,e*aa+f*cc+ee,e*bb+f*dd+ff]
            elif op==b'Do':
                require(args==[image_name] and all(abs(x-y)<.001 for x,y in zip(matrix,[box[2],0,0,box[3],0,0])),'scan_image_placement_invalid');count+=1
            else:raise ValueError('mixed_scan_paint_unsupported')
            painting.append((args,op))
        require(not inside and not stack and count==1,'incomplete_scan_paint')
        result.append(painting)
    return result


def _review(plan,ledger,source):
    require(set(plan)=={'schemaVersion','sourceSha256','ocrEvidenceSha256','language','title','reviewer','pages'} and plan['schemaVersion']==1,'ocr_plan_schema_invalid')
    require(isinstance(plan['language'],str) and re.fullmatch(r'en(?:-[A-Za-z0-9]{2,8})*',plan['language']) and isinstance(plan['title'],str) and 1<=len(plan['title'])<=200
        and plan['title']==plan['title'].strip() and all(ord(c)>=32 and not 0xd800<=ord(c)<=0xdfff for c in plan['title']),'ocr_review_language_or_title_invalid')
    require(sha(source)==plan['sourceSha256']==ledger['sourceSha256'] and digest(plan)==ledger['planSha256'],'stale_ocr_plan')
    ep=Path(ledger['ocrEvidencePath']);rp=Path(ledger['reviewEvidencePath'])
    require(ep.stat().st_size<=4*1024*1024 and rp.stat().st_size<=4*1024*1024,'ocr_evidence_limit')
    require(sha(ep)==plan['ocrEvidenceSha256'] and plan['reviewer']=={'kind':'institutional_model','evidenceSha256':sha(rp)},'stale_ocr_review')
    evidence=json.loads(ep.read_text(encoding='utf-8'));review=json.loads(rp.read_text(encoding='utf-8'))
    require(review.get('complete') is True and review.get('reviewedPlan')=={k:value for k,value in plan.items() if k!='reviewer'},'ocr_saved_review_mismatch')
    require(evidence['sourceSha256']==plan['sourceSha256'] and evidence['dpi']==300 and evidence['language']=='eng','ocr_source_evidence_mismatch')
    require(len(evidence['pages'])==len(plan['pages']),'ocr_page_review_incomplete')
    previous_heading=0;total_characters=0
    with pdfium.PdfDocument(str(source)) as pdf:
        require(len(pdf)==len(plan['pages']),'ocr_page_review_incomplete')
        for number,(page_plan,page_evidence) in enumerate(zip(plan['pages'],evidence['pages'])):
            require(set(page_plan)=={'pageNumber','textOnly','readingOrderConfirmed','textAccuracyConfirmed','unresolved','blocks'} and 1<=len(page_plan['blocks'])<=200,'ocr_page_plan_invalid')
            require(page_plan['pageNumber']==page_evidence['pageNumber']==number+1,'ocr_page_identity_mismatch')
            require(all(page_plan.get(k) is True for k in ('textOnly','readingOrderConfirmed','textAccuracyConfirmed')) and page_plan.get('unresolved')==[],'ocr_review_unresolved')
            page=pdf[number];bitmap=page.render(scale=300/72);image=bitmap.to_pil().convert('RGB')
            require(hashlib.sha256(image.tobytes()).hexdigest()==page_evidence['pixelSha256'] and sha(page_evidence['imagePath'])==page_evidence['imageSha256'],'ocr_review_image_not_source')
            with Image.open(page_evidence['imagePath']) as png:
                png=png.convert('RGB');require(png.size==image.size and png.tobytes()==image.tobytes(),'ocr_review_png_not_source')
            require((image.width,image.height)==(page_evidence['widthPixels'],page_evidence['heightPixels']),'ocr_render_geometry_mismatch');bitmap.close();page.close()
            expected=[line['id'] for line in page_evidence['ocrLines']];used=[line['id'] for block in page_plan['blocks'] for line in block['lines']]
            require(1<=len(expected)<=500 and len(expected)==len(set(expected)) and len(used)==len(set(used)) and set(used)==set(expected),'ocr_line_review_incomplete')
            for line in page_evidence['ocrLines']:
                box=line['bbox'];require(isinstance(box,list) and len(box)==4 and all(type(x) in (int,float) and math.isfinite(x) for x in box)
                    and 0<=box[0]<box[2]<=page_evidence['widthPixels'] and 0<=box[1]<box[3]<=page_evidence['heightPixels'],'ocr_review_geometry_invalid')
            for block in page_plan['blocks']:
                require(set(block)=={'role','lines'} and block['role'] in {'P','H1','H2','H3','H4','H5','H6'} and block['lines'],'ocr_review_block_invalid')
                if block['role'].startswith('H'):
                    level=int(block['role'][1]);require(level<=previous_heading+1,'ocr_heading_skip');previous_heading=level
                for line in block['lines']:
                    text=line['text'];require(set(line)=={'id','text'} and isinstance(text,str) and text==text.strip() and 1<=len(text)<=1000
                        and all(32<=ord(c)<=0xffff and not 0xd800<=ord(c)<=0xdfff for c in text),'ocr_review_text_invalid');total_characters+=len(text)
    require(total_characters<=50_000,'ocr_review_text_limit')
    return evidence


def _candidate_text(reader,source_reader,source_paint,plan,evidence):
    actual=[];expected_tags=[];projection=[];canonical=[v.Canonicalizer(list(source_reader.pages)),v.Canonicalizer(list(reader.pages))]
    font_codes=set();font_refs=[]
    for index,(page,reviewed,page_evidence) in enumerate(zip(reader.pages,plan['pages'],evidence['pages'])):
        old_images=v.resolved(v.resolved(source_reader.pages[index]['/Resources'])['/XObject'])
        new_images=v.resolved(v.resolved(page['/Resources']).get('/XObject',{}))
        require(set(old_images)==set(new_images),'ocr_scan_image_resources_changed')
        for name,ref in old_images.items():
            before=v.resolved(ref);after=v.resolved(new_images[name])
            require(getattr(before,'_data',None)==getattr(after,'_data',None)
                and v.Canonicalizer().hash([before.get('/Filter'),before.get('/DecodeParms')])==v.Canonicalizer().hash([after.get('/Filter'),after.get('/DecodeParms')]),'ocr_original_raster_payload_changed')
        ops=v.operations(page);paint=source_paint[index];prefix=len(paint)
        require(len(ops)>prefix+4 and ops[0]==([NameObject('/Artifact')],b'BMC') and ops[prefix+1]==([],b'EMC') and ops[prefix+2]==([],b'q') and ops[-1]==([],b'Q'),'ocr_original_paint_scope_invalid')
        require(canonical[0].hash(paint)==canonical[1].hash(ops[1:prefix+1]),'ocr_original_paint_changed')
        projection.append(ops[1:prefix+1]);at=prefix+3
        fonts=v.resolved(v.resolved(page['/Resources']).get('/Font',{}));require('/OCRText' in fonts,'ocr_font_missing')
        font=v.resolved(fonts['/OCRText']);font_refs.append(font)
        child=v.resolved(v.resolved(font['/DescendantFonts'])[0]);program=v.resolved(v.resolved(child['/FontDescriptor'])['/FontFile2']).get_data()
        face=TTFontFace(io.BytesIO(program),validate=1);lines={line['id']:line for line in page_evidence['ocrLines']};saved=[]
        for mcid,block in enumerate(reviewed['blocks']):
            role=block['role'];require(role in {'P','H1','H2','H3','H4','H5','H6'},'ocr_role_invalid')
            def take(operator,count=None):
                nonlocal at
                require(at<len(ops)-1 and ops[at][1]==operator,'ocr_unapproved_operator_sequence')
                args=ops[at][0];at+=1
                if count is not None:require(len(args)==count,'ocr_operator_arguments_invalid')
                return args
            args=take(b'BDC',2);require(args[0]=='/'+role and isinstance(args[1],DictionaryObject) and set(args[1])=={'/MCID'} and args[1]['/MCID']==mcid,'ocr_native_scope_mismatch')
            take(b'BT',0);require(take(b'Tr',1)==[3],'ocr_text_not_invisible')
            block_text=''
            for line_index,line in enumerate(block['lines']):
                text=line['text']+(' ' if line_index<len(block['lines'])-1 else '')
                x0,y0,x1,y1=lines[line['id']]['bbox'];scale=72/300;size=(y1-y0)*scale/((face.ascent-face.descent)/1000)
                width=sum(face.charWidths[ord(c)] for c in text)*size/1000;stretch=(x1-x0)*scale/width*100
                font_args=take(b'Tf',2);require(font_args[0]=='/OCRText' and abs(float(font_args[1])-size)<.00001,'ocr_font_geometry_changed')
                require(abs(float(take(b'Tz',1)[0])-stretch)<.00001,'ocr_text_width_changed')
                matrix=take(b'Tm',6);wanted=[1,0,0,1,x0*scale,page_evidence['heightPt']-y1*scale-face.descent*size/1000]
                require(all(abs(float(a)-b)<.00001 for a,b in zip(matrix,wanted)),'ocr_text_location_changed')
                rendered=_raw_text(take(b'Tj',1)[0]).decode('utf-16-be');require(rendered==text,'ocr_saved_text_differs_from_review')
                font_codes.update(map(ord,text));block_text+=text;saved.append({'id':line['id'],'text':line['text'],'role':role})
            take(b'ET',0);take(b'EMC',0);expected_tags.append({'role':role,'text':block_text,'pageNumber':index+1})
        require(at==len(ops)-1,'ocr_unapproved_extra_content');actual.append({'pageNumber':index+1,'lines':saved})
    for font in font_refs:_verify_font(font,font_codes)
    inventory=v.structure_inventory(reader);tags=inventory['tags']
    tree=v.resolved(reader.trailer['/Root'].get('/StructTreeRoot'))
    require(isinstance(tree,DictionaryObject) and set(tree)=={'/Type','/K','/ParentTree','/ParentTreeNextKey'},'ocr_structure_root_unapproved_attributes')
    children=v.resolved(tree['/K']);require(isinstance(children,ArrayObject) and len(children)==1,'ocr_document_root_required')
    document=v.resolved(children[0]);require(set(document)=={'/Type','/S','/P','/K'},'ocr_document_unapproved_attributes')
    leaves=v.resolved(document['/K']);require(isinstance(leaves,ArrayObject),'ocr_leaf_array_required')
    for leaf in leaves:require(set(v.resolved(leaf))=={'/Type','/S','/P','/Pg','/K'},'ocr_leaf_unapproved_attributes')
    require(len(tags)==1+len(expected_tags) and tags[0]['role']=='Document','ocr_native_tree_unexpected')
    require(all(not any(k in tag for k in ('alt','actualText')) and tag.get('effectiveLanguage')==plan['language'] for tag in tags),'ocr_unapproved_text_or_language_override')
    for tag,expected in zip(tags[1:],expected_tags):
        require(tag['parentId']==tags[0]['id'] and tag.get('role')==expected['role'] and tag.get('pageNumber')==expected['pageNumber']
            and ' '.join(tag.get('text','').split())==' '.join(expected['text'].split()) and not tag.get('textIncomplete'),'ocr_native_reading_text_mismatch')
        require(not any(k in tag for k in ('alt','actualText')),'ocr_unapproved_text_override')
    return actual,inventory,projection


def compare_with_authorized_ocr(original,final,ledger):
    report={'passed':False,'certification':False,'accessibility_ready':False,'semantic_review_required':True,
        'preservation':{'passed':False},'ocr_validation':{'passed':False},'findings':[]}
    try:
        original=Path(original);final=Path(final)
        require(original.stat().st_size<=4*1024*1024 and final.stat().st_size<=4*1024*1024,'ocr_file_limit')
        require(sha(final)==ledger['candidateSha256'],'stale_ocr_candidate')
        source=PdfReader(original,strict=True);candidate=PdfReader(final,strict=True)
        require(not candidate.is_encrypted and len(source.pages)==len(candidate.pages),'ocr_output_page_count_changed')
        source_paint=_source_paint(source);plan=ledger['plan'];evidence=_review(plan,ledger,original)
        saved,inventory,candidate_paint=_candidate_text(candidate,source,source_paint,plan,evidence)
        require(str(candidate.trailer['/Root'].get('/Lang',''))==plan['language'] and str((candidate.metadata or {}).get('/Title',''))==plan['title'],'ocr_metadata_plan_mismatch')
        # Compare exact original drawing/resources/behavior after removing ONLY
        # the authorized invisible layers and verified added font resource.
        with tempfile.TemporaryDirectory(prefix='ocr-preservation-') as directory:
            paths=[]
            for reader,paintings,is_output in ((source,source_paint,False),(candidate,candidate_paint,True)):
                writer=PdfWriter(clone_from=reader)
                for page_index,(page,paint) in enumerate(zip(writer.pages,paintings)):
                    stream=ContentStream(None,writer);stream.operations=paint;page[NameObject('/Contents')]=writer._add_object(stream)
                    if is_output:
                        resources=DictionaryObject(v.resolved(page['/Resources']));fonts=DictionaryObject(v.resolved(resources['/Font']));del fonts['/OCRText']
                        # Match an originally absent /Font resource exactly.
                        source_resources=v.resolved(source.pages[page_index].get('/Resources',{}))
                        if fonts or '/Font' in source_resources:resources[NameObject('/Font')]=fonts
                        else:del resources['/Font']
                        page[NameObject('/Resources')]=resources
                    page.pop('/StructParents',None)
                writer.root_object.pop('/StructTreeRoot',None);writer.root_object.pop('/MarkInfo',None)
                path=Path(directory)/('candidate.pdf' if is_output else 'source.pdf')
                with path.open('xb') as handle:writer.write(handle)
                paths.append(path)
            preserved=v.compare_pdfs(*paths)
        require(preserved['preservation']['passed'],'ocr_unauthorized_preservation_change')
        original_pixels=v.rendered_page_hashes(original);candidate_pixels=v.rendered_page_hashes(final)
        require(original_pixels==candidate_pixels,'ocr_original_pixels_changed')
        full=v.compare_pdfs(final,final)
        report.update(full);report['preservation']=preserved['preservation'];report['preservation']['authorized_change']='Reviewed invisible OCR text replacement and pinned embedded font only'
        report['ocr_validation']={'passed':True,'requiredAuditPages':list(range(1,len(candidate.pages)+1)),
            'savedTextByPage':saved,'sourceRasterClassification':'text-only scan, subject to fresh source-image audit',
            'reviewedPlanSha256':ledger['planSha256'],'originalPixelsIdentical':True,'originalRasterAndDrawingIdentical':True,
            'exactReviewedNativeTextVerified':True,'embeddedPinnedFontVerified':True,'ocrConfidenceEstablishesAccuracy':False}
        require(sha(original)==ledger['sourceSha256'] and sha(final)==ledger['candidateSha256'] and digest(plan)==ledger['planSha256']
            and sha(ledger['ocrEvidencePath'])==plan['ocrEvidenceSha256'] and sha(ledger['reviewEvidencePath'])==plan['reviewer']['evidenceSha256']
            and all(sha(p['imagePath'])==p['imageSha256'] for p in evidence['pages']),'ocr_files_changed_during_validation')
        report['passed']=bool(full['passed'] and preserved['preservation']['passed'])
    except Exception as error:
        report['passed']=False;report['preservation']['passed']=False;report['inspection_incomplete']=True
        report['ocr_validation']['passed']=False
        report['findings'].append({'severity':'error','code':str(error) if isinstance(error,ValueError) else 'ocr_inspection_incomplete',
            'message':'The saved OCR candidate did not pass the bounded independent authorization checks.'})
    return report
