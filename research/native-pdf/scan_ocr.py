"""Bounded local OCR for reviewed text-only scans; no accessibility claim.

Render a copy for recognition, preserve the original raster, and replace only
provably invisible text objects. Real Unicode text gets native MCIDs and tags.
Image meaning and OCR accuracy require a separately saved source-image review.
No diagram, table, visible text, or existing semantic structure is discarded.

Primary references:
https://github.com/naptha/tesseract.js/blob/master/docs/api.md
https://ocrmypdf.readthedocs.io/en/stable/cookbook.html#redo-existing-ocr
"""
from __future__ import annotations
import hashlib
import io
import json
import math
import os
from pathlib import Path
import re
import subprocess
import tempfile
from xml.sax.saxutils import escape

from pypdf import PdfReader
from pypdf.generic import (ArrayObject, BooleanObject, ByteStringObject, ContentStream,
    DecodedStreamObject, DictionaryObject, FloatObject, NameObject, NumberObject, TextStringObject)
import pypdfium2 as pdfium
from PIL import Image

from conformance_repairs import _open, _save
from description_appendix import _font, manifest_digest
from pdf_safety import reject_signed_pdf
from verify_pdf import resolved

MAX_SCAN_PAGES = 8
MAX_RENDER_PIXELS = 20_000_000
DPI = 300
FONT_NAME = '/OCRText'
REPO = Path(__file__).resolve().parents[2]
TEXT_OPERATORS = {b'Tf', b'TL', b'Tm', b'Td', b'TD', b'T*', b'Tc', b'Tw', b'Tz', b'Ts', b'Tr', b'Tj', b'TJ', b"'", b'"'}
SHOW_OPERATORS = {b'Tj', b'TJ', b"'", b'"'}


def file_hash(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def module_digest(module_root):
    files=sorted(p for p in Path(module_root).rglob('*') if p.is_file())
    if not files or len(files)>3000:raise ValueError('bounded_ocr_runtime_required')
    return manifest_digest([(p.relative_to(module_root).as_posix(),file_hash(p)) for p in files])


def _read(source):
    source=Path(source)
    if not source.is_file() or source.stat().st_size>4*1024*1024:raise ValueError('scan_file_limit')
    reader=PdfReader(io.BytesIO(source.read_bytes()),strict=True)
    if reader.is_encrypted or not 1<=len(reader.pages)<=MAX_SCAN_PAGES:raise ValueError('scan_page_or_encryption_limit')
    reject_signed_pdf(reader)
    root=reader.trailer['/Root']
    if any(key in root for key in ('/StructTreeRoot','/AcroForm','/OCProperties','/OpenAction','/AA','/Collection','/AF')):
        raise ValueError('structured_or_interactive_scan_unsupported')
    return reader


def scan_page(page,reader):
    """Parse a deliberately small grammar, proving all discarded text invisible."""
    box=[float(x) for x in page.mediabox];w,h=box[2:]
    if (box[:2]!=[0,0] or min(w,h)<=0 or max(w,h)>1440 or float(page.get('/Rotate',0))!=0
            or float(page.get('/UserUnit',1))!=1 or [float(x) for x in resolved(page.get('/CropBox',page['/MediaBox']))]!=box
            or any(key in page for key in ('/Annots','/AA','/Group','/PresSteps')) or bool(resolved(page.get('/Trans',{})))):
        raise ValueError('scan_geometry_or_interaction_unsupported')
    resources=resolved(page.get('/Resources',{}))
    if set(resources)-{'/Font','/XObject','/ProcSet'}:raise ValueError('scan_resources_unsupported')
    if FONT_NAME in resolved(resources.get('/Font',{})):raise ValueError('ocr_font_name_collision')
    for font in resolved(resources.get('/Font',{})).values():
        if resolved(font).get('/Subtype')=='/Type3':raise ValueError('type3_scan_font_unsupported')
    images=resolved(resources.get('/XObject',{}))
    if len(images)!=1:raise ValueError('single_full_page_raster_required')
    name,image=next(iter(images.items()));image=resolved(image)
    if (image.get('/Subtype')!='/Image' or any(k in image for k in ('/SMask','/Mask','/Alternates','/OPI','/OC'))
            or bool(getattr(image.get('/ImageMask'), 'value', False))):raise ValueError('plain_scan_image_required')
    if int(image.get('/Width',0))*int(image.get('/Height',0))>MAX_RENDER_PIXELS:raise ValueError('scan_image_limit')
    ops=ContentStream(page.get_contents(),reader).operations
    if len(ops)>20000:raise ValueError('scan_operator_limit')
    kept=[];in_text=False;mode=0;stack=[];matrix=[1.,0.,0.,1.,0.,0.];draws=shows=0
    for args,op in ops:
        if op==b'BT':
            if in_text:raise ValueError('nested_text_object')
            in_text=True;continue
        if op==b'ET':
            if not in_text:raise ValueError('unbalanced_text_object')
            in_text=False;continue
        if in_text:
            if op not in TEXT_OPERATORS:raise ValueError('unsupported_text_operator')
            if op==b'Tr':
                if len(args)!=1 or int(args[0]) not in (0,3) or float(args[0])!=int(args[0]):raise ValueError('clipping_text_mode_unsupported')
                mode=int(args[0])
            if op in SHOW_OPERATORS:
                if mode!=3:raise ValueError('visible_text_scan_unsupported')
                shows+=1
            continue
        if op==b'q':stack.append((list(matrix),mode))
        elif op==b'Q':
            if not stack:raise ValueError('unbalanced_graphics_state')
            matrix,mode=stack.pop()
        elif op==b'cm':
            if len(args)!=6 or any(not math.isfinite(float(x)) for x in args):raise ValueError('invalid_scan_matrix')
            a,b,c,d,e,f=map(float,args);aa,bb,cc,dd,ee,ff=matrix
            matrix=[a*aa+b*cc,a*bb+b*dd,c*aa+d*cc,c*bb+d*dd,e*aa+f*cc+ee,e*bb+f*dd+ff]
        elif op==b'Do':
            if len(args)!=1 or args[0]!=name or any(abs(x-y)>.001 for x,y in zip(matrix,[w,0,0,h,0,0])):
                raise ValueError('full_page_unrotated_raster_required')
            draws+=1
        else:raise ValueError('mixed_or_marked_scan_unsupported')
        kept.append((args,op))
    if in_text or stack or draws!=1:raise ValueError('incomplete_scan_page')
    return {'widthPt':w,'heightPt':h,'oldHiddenTextShows':shows,'imageName':str(name)},kept


def inspect_scan(source):
    reader=_read(source)
    return {'schemaVersion':1,'sourceSha256':file_hash(source),'supportedSyntax':True,
        'textOnlyReviewRequired':True,'pages':[dict(pageNumber=i+1,**scan_page(p,reader)[0]) for i,p in enumerate(reader.pages)]}


def recognize_scan(source,output_dir,toolchain):
    """Recognize locally with pinned installed modules; never download at runtime."""
    source=Path(source);folder=Path(output_dir).resolve();inspection=inspect_scan(source)
    if folder.exists() or folder.is_relative_to(REPO):raise ValueError('new_external_ocr_folder_required')
    node=Path(toolchain['nodePath']);modules=Path(toolchain['moduleRoot'])
    if (not node.is_absolute() or not modules.is_absolute() or file_hash(node)!=toolchain['nodeSha256']
            or module_digest(modules)!=toolchain['moduleSha256']):raise ValueError('ocr_toolchain_hash_mismatch')
    runner=Path(__file__).with_name('scan_ocr_worker.cjs');folder.mkdir(parents=True)
    evidence={k:v for k,v in inspection.items() if k!='pages'}
    evidence.update(language='eng',dpi=DPI,toolchain=dict(toolchain,runnerSha256=file_hash(runner)),pages=[])
    environment={k:os.environ[k] for k in ('SystemRoot','WINDIR','TEMP','TMP','PATH') if k in os.environ}
    with pdfium.PdfDocument(str(source)) as pdf:
        for info in inspection['pages']:
            page=pdf[info['pageNumber']-1];width=math.ceil(info['widthPt']*DPI/72);height=math.ceil(info['heightPt']*DPI/72)
            if width*height>MAX_RENDER_PIXELS:raise ValueError('scan_render_limit')
            bitmap=page.render(scale=DPI/72);image=bitmap.to_pil().convert('RGB');image_path=folder/f"page-{info['pageNumber']}.png"
            image.save(image_path);bitmap.close();page.close()
            raw_path=folder/f"page-{info['pageNumber']}-recognition.json"
            result=subprocess.run([str(node),'--max-old-space-size=768',str(runner),str(modules),str(image_path),str(raw_path)],
                stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,env=environment,timeout=120,
                creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
            if result.returncode or not raw_path.is_file() or raw_path.stat().st_size>2*1024*1024:raise ValueError('local_ocr_failed')
            raw=json.loads(raw_path.read_text(encoding='utf-8'))
            lines=[dict(id=f"p{info['pageNumber']}-l{i+1}",**line) for i,line in enumerate(raw['lines'])]
            evidence['pages'].append(dict(info,imagePath=str(image_path),imageSha256=file_hash(image_path),
                pixelSha256=hashlib.sha256(image.tobytes()).hexdigest(),widthPixels=image.width,heightPixels=image.height,ocrLines=lines))
    if file_hash(source)!=evidence['sourceSha256']:raise ValueError('source_changed_during_ocr')
    (folder/'ocr-evidence.json').write_text(json.dumps(evidence,indent=2),encoding='utf-8')
    return evidence


def validate_plan(source,plan,evidence_path,review_path):
    inspection=inspect_scan(source);evidence_path=Path(evidence_path);review_path=Path(review_path)
    if evidence_path.stat().st_size>4*1024*1024 or review_path.stat().st_size>4*1024*1024:raise ValueError('ocr_evidence_limit')
    evidence=json.loads(evidence_path.read_text(encoding='utf-8'))
    if (set(plan)!={'schemaVersion','sourceSha256','ocrEvidenceSha256','language','title','reviewer','pages'}
            or plan['schemaVersion']!=1 or plan['sourceSha256']!=inspection['sourceSha256']
            or plan['ocrEvidenceSha256']!=file_hash(evidence_path) or evidence['sourceSha256']!=plan['sourceSha256']
            or plan['reviewer']!={'kind':'institutional_model','evidenceSha256':file_hash(review_path)}):
        raise ValueError('exact_ocr_review_evidence_required')
    # Binding the review JSON to the entire reviewed plan avoids accepting a
    # changed approval flag/text with an unrelated response hash.
    review=json.loads(review_path.read_text(encoding='utf-8'))
    reviewed={k:v for k,v in plan.items() if k!='reviewer'}
    if review.get('reviewedPlan')!=reviewed or review.get('complete') is not True:raise ValueError('saved_review_plan_mismatch')
    if not re.fullmatch(r'en(?:-[A-Za-z0-9]{2,8})*',plan['language']):raise ValueError('english_scan_subset_required')
    if (not isinstance(plan['title'],str) or not 1<=len(plan['title'])<=200 or plan['title']!=plan['title'].strip()
            or any(ord(c)<32 or 0xd800<=ord(c)<=0xdfff for c in plan['title'])):raise ValueError('reviewed_scan_title_required')
    if len(plan['pages'])!=len(inspection['pages']) or len(evidence['pages'])!=len(plan['pages']):raise ValueError('complete_page_review_required')
    previous_heading=0;characters=0
    for index,(page,seen,original) in enumerate(zip(plan['pages'],evidence['pages'],inspection['pages'])):
        if (set(page)!={'pageNumber','textOnly','readingOrderConfirmed','textAccuracyConfirmed','unresolved','blocks'}
                or page['pageNumber']!=index+1 or seen['pageNumber']!=index+1
                or any(page[k] is not True for k in ('textOnly','readingOrderConfirmed','textAccuracyConfirmed'))
                or page['unresolved']!=[] or not isinstance(page['blocks'],list) or not 1<=len(page['blocks'])<=200):
            raise ValueError('complete_text_only_scan_review_required')
        if any(seen[k]!=original[k] for k in ('widthPt','heightPt','oldHiddenTextShows','imageName')):
            raise ValueError('ocr_source_geometry_mismatch')
        if (evidence.get('dpi')!=DPI or seen['widthPixels']!=math.ceil(original['widthPt']*(DPI/72))
                or seen['heightPixels']!=math.ceil(original['heightPt']*(DPI/72))
                or file_hash(seen['imagePath'])!=seen['imageSha256']):raise ValueError('ocr_render_evidence_mismatch')
        lines={line['id']:line for line in seen['ocrLines']}
        if not 1<=len(lines)<=500 or len(lines)!=len(seen['ocrLines']):raise ValueError('ocr_line_inventory_invalid')
        used=[]
        for block in page['blocks']:
            if set(block)!={'role','lines'} or block['role'] not in {'P','H1','H2','H3','H4','H5','H6'} or not isinstance(block['lines'],list) or not block['lines']:
                raise ValueError('bounded_scan_text_blocks_required')
            if block['role'].startswith('H'):
                level=int(block['role'][1])
                if level>previous_heading+1:raise ValueError('scan_heading_level_skip')
                previous_heading=level
            for line in block['lines']:
                if set(line)!={'id','text'} or line['id'] not in lines or line['id'] in used:raise ValueError('unique_complete_scan_line_mapping_required')
                text=line['text'];bbox=lines[line['id']]['bbox']
                if (not isinstance(text,str) or text!=text.strip() or not text or len(text)>1000
                        or any(ord(c)<32 or ord(c)>0xffff or 0xd800<=ord(c)<=0xdfff for c in text)):raise ValueError('bounded_reviewed_scan_text_required')
                if (not isinstance(bbox,list) or len(bbox)!=4 or any(type(x) not in (int,float) or not math.isfinite(x) for x in bbox)
                        or not 0<=bbox[0]<bbox[2]<=seen['widthPixels'] or not 0<=bbox[1]<bbox[3]<=seen['heightPixels']):raise ValueError('scan_line_geometry_invalid')
                used.append(line['id']);characters+=len(text)
        if set(used)!=set(lines):raise ValueError('unique_complete_scan_line_mapping_required')
    if characters>50_000:raise ValueError('scan_text_limit')
    with pdfium.PdfDocument(str(source)) as pdf:
        for number,seen in enumerate(evidence['pages']):
            page=pdf[number];bitmap=page.render(scale=DPI/72);render=bitmap.to_pil().convert('RGB')
            with Image.open(seen['imagePath']) as saved:
                saved=saved.convert('RGB')
                if (saved.size!=render.size or saved.tobytes()!=render.tobytes()
                        or hashlib.sha256(render.tobytes()).hexdigest()!=seen['pixelSha256']):
                    raise ValueError('review_image_not_source_render')
            bitmap.close();page.close()
    return evidence


def repair_scan(source,output,plan,ocr_evidence_path,review_evidence_path,*,font_directory):
    source=Path(source);output=Path(output)
    if output.resolve().is_relative_to(REPO):raise ValueError('external_ocr_output_required')
    evidence=validate_plan(source,plan,ocr_evidence_path,review_evidence_path)
    reader,writer=_open(source,output)
    all_text=' '.join(line['text'] for p in plan['pages'] for b in p['blocks'] for line in b['lines'])
    font,face=_font(writer,Path(font_directory),'regular',all_text+' ')
    root=writer.root_object;tree=DictionaryObject({NameObject('/Type'):NameObject('/StructTreeRoot')});tree_ref=writer._add_object(tree)
    document=DictionaryObject({NameObject('/Type'):NameObject('/StructElem'),NameObject('/S'):NameObject('/Document'),NameObject('/P'):tree_ref,NameObject('/K'):ArrayObject()})
    doc_ref=writer._add_object(document);tree[NameObject('/K')]=ArrayObject([doc_ref]);parents=ArrayObject()
    for index,(page,reviewed,seen) in enumerate(zip(writer.pages,plan['pages'],evidence['pages'])):
        _,original_ops=scan_page(page,writer)
        ops=[([NameObject('/Artifact')],b'BMC'),*original_ops,([],b'EMC'),([],b'q')]
        resources=resolved(page['/Resources']);fonts=DictionaryObject(resolved(resources.get('/Font',{})))
        fonts[NameObject(FONT_NAME)]=font;resources=DictionaryObject(resources);resources[NameObject('/Font')]=fonts
        page[NameObject('/Resources')]=resources;page[NameObject('/StructParents')]=NumberObject(index)
        owners=ArrayObject();by_id={line['id']:line for line in seen['ocrLines']}
        for block in reviewed['blocks']:
            mcid=len(owners);role=block['role']
            node=DictionaryObject({NameObject('/Type'):NameObject('/StructElem'),NameObject('/S'):NameObject('/'+role),NameObject('/P'):doc_ref,
                NameObject('/Pg'):page.indirect_reference,NameObject('/K'):NumberObject(mcid)})
            node_ref=writer._add_object(node);document['/K'].append(node_ref);owners.append(node_ref)
            ops.extend([([NameObject('/'+role),DictionaryObject({NameObject('/MCID'):NumberObject(mcid)})],b'BDC'),([],b'BT'),([NumberObject(3)],b'Tr')])
            for line_index,line in enumerate(block['lines']):
                x0,y0,x1,y1=by_id[line['id']]['bbox'];scale=72/DPI
                size=(y1-y0)*scale/((face.ascent-face.descent)/1000)
                text=line['text']+(' ' if line_index<len(block['lines'])-1 else '')
                width=sum(face.charWidths[ord(c)] for c in text)*size/1000
                if not 1<=size<=100 or width<=0:raise ValueError('ocr_text_geometry_out_of_bounds')
                stretch=(x1-x0)*scale/width*100
                if not 10<=stretch<=1000:raise ValueError('ocr_text_stretch_out_of_bounds')
                y=seen['heightPt']-y1*scale-face.descent*size/1000
                ops.extend([([NameObject(FONT_NAME),FloatObject(size)],b'Tf'),([FloatObject(stretch)],b'Tz'),
                    ([NumberObject(1),NumberObject(0),NumberObject(0),NumberObject(1),FloatObject(x0*scale),FloatObject(y)],b'Tm'),
                    ([ByteStringObject(text.encode('utf-16-be'))],b'Tj')])
            ops.extend([([],b'ET'),([],b'EMC')])
        ops.append(([],b'Q'));stream=ContentStream(None,writer);stream.operations=ops
        page[NameObject('/Contents')]=writer._add_object(stream);parents.extend([NumberObject(index),owners])
    tree[NameObject('/ParentTree')]=writer._add_object(DictionaryObject({NameObject('/Nums'):parents}));tree[NameObject('/ParentTreeNextKey')]=NumberObject(len(writer.pages))
    root[NameObject('/StructTreeRoot')]=tree_ref;root[NameObject('/MarkInfo')]=DictionaryObject({NameObject('/Marked'):BooleanObject(True)})
    if root.get('/Lang') and str(root['/Lang'])!=plan['language']:raise ValueError('authored_language_conflict')
    root[NameObject('/Lang')]=TextStringObject(plan['language']);writer.add_metadata({'/Title':plan['title']})
    prefs=DictionaryObject(resolved(root.get('/ViewerPreferences',{})));prefs[NameObject('/DisplayDocTitle')]=BooleanObject(True);root[NameObject('/ViewerPreferences')]=prefs
    if '/Metadata' not in root:
        metadata=DecodedStreamObject();metadata[NameObject('/Type')]=NameObject('/Metadata');metadata[NameObject('/Subtype')]=NameObject('/XML')
        metadata.set_data(('<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title><rdf:Alt><rdf:li xml:lang="x-default">'+escape(plan['title'])+'</rdf:li></rdf:Alt></dc:title><dc:language><rdf:Bag><rdf:li>'+escape(plan['language'])+'</rdf:li></rdf:Bag></dc:language></rdf:Description></rdf:RDF></x:xmpmeta>').encode())
        root[NameObject('/Metadata')]=writer._add_object(metadata)
    output_hash=_save(writer,output)
    return {'schemaVersion':1,'experimental':True,'certification':False,'requiresFreshAuditAndValidation':True,
        'sourceSha256':plan['sourceSha256'],'candidateSha256':output_hash,'plan':plan,'planSha256':manifest_digest(plan),
        'ocrEvidencePath':str(Path(ocr_evidence_path).resolve()),'reviewEvidencePath':str(Path(review_evidence_path).resolve()),
        'originalPageCount':len(reader.pages),'removedInvisibleTextShows':sum(p['oldHiddenTextShows'] for p in evidence['pages']),
        'insertedLineCount':sum(len(p['ocrLines']) for p in evidence['pages'])}


def finalize_ocr_evaluation(original,raw_candidate,output,ledger,*,evaluation_only=False):
    """Explicit internal evaluation stage; fresh final-file audit remains required."""
    from conformance_repairs import repair_conformance_details, stage_pdfua1_declaration
    from scan_ocr_validation import compare_with_authorized_ocr
    output=Path(output);raw_candidate=Path(raw_candidate)
    if evaluation_only is not True or output.exists() or output.resolve().is_relative_to(REPO):raise ValueError('explicit_new_ocr_evaluation_required')
    initial=compare_with_authorized_ocr(original,raw_candidate,ledger)
    if not initial['passed']:raise ValueError('original_ocr_candidate_not_verified')
    with tempfile.TemporaryDirectory(prefix='ocr-technical-') as directory:
        technical=Path(directory)/'technical.pdf'
        repairs=repair_conformance_details(raw_candidate,technical)
        if repairs['unresolved']:raise ValueError('ocr_technical_issues_unresolved')
        staging=stage_pdfua1_declaration(technical,output,expected_sha256=file_hash(technical),evaluation_only=True)
    final_ledger=dict(ledger,candidateSha256=file_hash(output),evaluationOnly=True,
        evaluationLineage={'initialCandidateSha256':ledger['candidateSha256'],'technicalRepairs':repairs,'declarationStage':staging})
    checked=compare_with_authorized_ocr(original,output,final_ledger)
    if not checked['passed']:raise ValueError('final_ocr_evaluation_not_verified')
    return final_ledger,checked
