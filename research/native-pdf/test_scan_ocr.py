"""Saved-file regressions for the bounded scan writer, using fictional text."""
from copy import deepcopy
import hashlib
import io
import json
from pathlib import Path

import tempfile
import unittest
import pypdfium2 as pdfium
from PIL import Image
from pypdf import PdfReader, PdfWriter
from pypdf.generic import ArrayObject, ContentStream, DictionaryObject, NameObject, NumberObject, TextStringObject
from reportlab.pdfgen import canvas
from reportlab.lib.utils import ImageReader
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont

from scan_ocr import file_hash,inspect_scan,repair_scan,finalize_ocr_evaluation
from scan_ocr_validation import compare_with_authorized_ocr

FONT_DIR=Path(__file__).resolve().parents[4]/'work/pdf-native-tools/fonts/liberation-fonts-ttf-2.1.5'
def cases(name,values):
    def decorate(function):function.case_values=values;return function
    return decorate


def raises(error,match=None):
    case=unittest.TestCase()
    return case.assertRaisesRegex(error,match) if match else case.assertRaises(error)
LINES=['Deadline October 30.','Submit one page.']


def create_source(folder,hidden=None,mode=3):
    pdfmetrics.registerFont(TTFont('ScanTestFont',str(FONT_DIR/'LiberationSans-Regular.ttf')))
    b=io.BytesIO();c=canvas.Canvas(b,pagesize=(300,200));c.setFont('ScanTestFont',12)
    for i,text in enumerate(LINES):c.drawString(20,160-i*30,text)
    c.showPage();c.save()
    with pdfium.PdfDocument(b.getvalue()) as pdf:
        page=pdf[0];bitmap=page.render(scale=2);image=bitmap.to_pil().copy();bitmap.close();page.close()
    b=io.BytesIO();c=canvas.Canvas(b,pagesize=(300,200));c.setTitle('Scan fixture');c.drawImage(ImageReader(image),0,0,300,200)
    if hidden:
        for i,text in enumerate(hidden):
            t=c.beginText(20,160-i*30);t.setFont('ScanTestFont',12);t.setTextRenderMode(mode);t.textLine(text);c.drawText(t)
    c.showPage();c.save();source=folder/'source.pdf';source.write_bytes(b.getvalue());return source


def evidence_and_plan(source,folder):
    inspected=inspect_scan(source);page_info=inspected['pages'][0]
    with pdfium.PdfDocument(str(source)) as pdf:
        page=pdf[0];bitmap=page.render(scale=300/72);image=bitmap.to_pil().convert('RGB');bitmap.close();page.close()
    image_path=folder/'page.png';image.save(image_path)
    evidence=dict(inspected,language='eng',dpi=300,pages=[dict(page_info,imagePath=str(image_path),imageSha256=file_hash(image_path),
        pixelSha256=hashlib.sha256(image.tobytes()).hexdigest(),widthPixels=image.width,heightPixels=image.height,
        ocrLines=[{'id':f'p1-l{i+1}','text':text,'confidence':99,'bbox':[83,130+i*125,600,178+i*125]} for i,text in enumerate(LINES)])])
    ep=folder/'evidence.json';ep.write_text(json.dumps(evidence))
    plan={'schemaVersion':1,'sourceSha256':file_hash(source),'ocrEvidenceSha256':file_hash(ep),'language':'en-US','title':'Scan fixture',
        'pages':[{'pageNumber':1,'textOnly':True,'readingOrderConfirmed':True,'textAccuracyConfirmed':True,'unresolved':[],
            'blocks':[{'role':'H1' if i==0 else 'P','lines':[{'id':f'p1-l{i+1}','text':text}]} for i,text in enumerate(LINES)]}]}
    rp=folder/'review.json';write_review(plan,rp)
    return plan,ep,rp


def write_review(plan,rp):
    rp.write_text(json.dumps({'complete':True,'reviewedPlan':{k:v for k,v in plan.items() if k!='reviewer'},'testOnly':'fictional expected source text'}))
    plan['reviewer']={'kind':'institutional_model','evidenceSha256':file_hash(rp)}


def repair(source,folder,plan,ep,rp):
    out=folder/'candidate.pdf';ledger=repair_scan(source,out,plan,ep,rp,font_directory=FONT_DIR)
    return out,ledger


@cases('hidden',[None,LINES,['Deadline December 30.','Submit ten pages.']])
def test_saved_repair_preserves_pixels_and_exact_native_text(tmp_path,hidden):
    source=create_source(tmp_path,hidden);before=file_hash(source);plan,ep,rp=evidence_and_plan(source,tmp_path)
    out,ledger=repair(source,tmp_path,plan,ep,rp);checks=compare_with_authorized_ocr(source,out,ledger)
    assert checks['passed'],checks['findings']
    assert checks['ocr_validation']['savedTextByPage'][0]['lines']==[{'id':'p1-l1','text':LINES[0],'role':'H1'},{'id':'p1-l2','text':LINES[1],'role':'P'}]
    assert file_hash(source)==before
    text=PdfReader(out).pages[0].extract_text()
    assert text.count(LINES[0])==1 and text.count(LINES[1])==1 and 'December' not in text
    assert b'pdfuaid' not in PdfReader(out).trailer['/Root']['/Metadata'].get_data()


@cases('mode',[0,4,7])
def test_visible_and_clipping_text_rejected(tmp_path,mode):
    source=create_source(tmp_path,LINES,mode)
    with raises(ValueError):inspect_scan(source)


def test_mixed_vector_content_rejected(tmp_path):
    source=create_source(tmp_path);writer=PdfWriter(clone_from=source);page=writer.pages[0];stream=ContentStream(page.get_contents(),writer)
    stream.operations.extend([([NumberObject(0),NumberObject(0),NumberObject(20),NumberObject(20)],b're'),([],b'f')]);page[NameObject('/Contents')]=writer._add_object(stream)
    changed=tmp_path/'mixed.pdf'
    with changed.open('wb') as f:writer.write(f)
    with raises(ValueError,match='mixed_or_marked_scan'):inspect_scan(changed)


@cases('failure',['not_text_only','uncertain','missing_line','repeated_line','heading_skip'])
def test_review_blockers_cannot_write(tmp_path,failure):
    source=create_source(tmp_path);plan,ep,rp=evidence_and_plan(source,tmp_path);p=plan['pages'][0]
    if failure=='not_text_only':p['textOnly']=False
    elif failure=='uncertain':p['unresolved']=['A numeral cannot be read.']
    elif failure=='missing_line':p['blocks'].pop()
    elif failure=='repeated_line':p['blocks'][1]['lines']=deepcopy(p['blocks'][0]['lines'])
    elif failure=='heading_skip':p['blocks'][0]['role']='H3'
    write_review(plan,rp)
    with raises(ValueError):repair(source,tmp_path,plan,ep,rp)
    assert not (tmp_path/'candidate.pdf').exists()


def test_stale_or_unrelated_review_rejected(tmp_path):
    source=create_source(tmp_path);plan,ep,rp=evidence_and_plan(source,tmp_path)
    plan['pages'][0]['blocks'][0]['lines'][0]['text']='Deadline December 30.'
    with raises(ValueError,match='saved_review_plan_mismatch'):repair(source,tmp_path,plan,ep,rp)


def test_unrelated_render_with_rebound_hash_still_rejected(tmp_path):
    source=create_source(tmp_path);plan,ep,rp=evidence_and_plan(source,tmp_path)
    out,ledger=repair(source,tmp_path,plan,ep,rp)
    evidence=json.loads(ep.read_text());path=Path(evidence['pages'][0]['imagePath'])
    image=Image.open(path).convert('RGB');image.putpixel((10,10),(0,0,0));image.save(path)
    evidence['pages'][0]['imageSha256']=file_hash(path);ep.write_text(json.dumps(evidence));plan['ocrEvidenceSha256']=file_hash(ep);write_review(plan,rp)
    changed_ledger=dict(ledger,plan=plan,planSha256=__import__('scan_ocr').manifest_digest(plan))
    assert not compare_with_authorized_ocr(source,out,changed_ledger)['passed']
    with raises(ValueError,match='review_image_not_source_render'):
        repair_scan(source,tmp_path/'new.pdf',plan,ep,rp,font_directory=FONT_DIR)


@cases('change',['visible_text','extra_text','image_matrix','crop','root_override','text'])
def test_tampered_saved_output_fails_even_with_rebound_file_hash(tmp_path,change):
    source=create_source(tmp_path,LINES);plan,ep,rp=evidence_and_plan(source,tmp_path);out,ledger=repair(source,tmp_path,plan,ep,rp)
    writer=PdfWriter(clone_from=out);page=writer.pages[0];stream=ContentStream(page.get_contents(),writer);ops=stream.operations
    if change=='visible_text':next(args for args,op in ops if op==b'Tr')[0]=NumberObject(0)
    elif change=='extra_text':ops.insert(-1,([NameObject('/Artifact')],b'BMC'));ops.insert(-1,([],b'EMC'))
    elif change=='image_matrix':next(args for args,op in ops if op==b'cm' and args[0]==300)[0]=NumberObject(299)
    elif change=='crop':page[NameObject('/CropBox')]=ArrayObject([NumberObject(0),NumberObject(0),NumberObject(299),NumberObject(200)])
    elif change=='root_override':writer.root_object['/StructTreeRoot']['/K'][0].get_object()[NameObject('/ActualText')]=TextStringObject('Wrong text')
    elif change=='text':next(args for args,op in ops if op==b'Tj')[0]=TextStringObject('Wrong text')
    stream.operations=ops;page[NameObject('/Contents')]=writer._add_object(stream);changed=tmp_path/'tampered.pdf'
    with changed.open('wb') as f:writer.write(f)
    changed_ledger=dict(ledger,candidateSha256=file_hash(changed));checks=compare_with_authorized_ocr(source,changed,changed_ledger)
    assert not checks['passed'] and not checks['ocr_validation']['passed']


def test_source_signature_and_overwrite_excluded(tmp_path):
    source=create_source(tmp_path);plan,ep,rp=evidence_and_plan(source,tmp_path)
    with raises(ValueError):repair_scan(source,source,plan,ep,rp,font_directory=FONT_DIR)
    writer=PdfWriter(clone_from=source);writer.root_object[NameObject('/Perms')]=DictionaryObject();signed=tmp_path/'signed.pdf'
    with signed.open('wb') as f:writer.write(f)
    with raises(ValueError):inspect_scan(signed)


def test_staging_is_explicit_and_revalidates_saved_file(tmp_path):
    source=create_source(tmp_path);plan,ep,rp=evidence_and_plan(source,tmp_path);out,ledger=repair(source,tmp_path,plan,ep,rp)
    with raises(ValueError):finalize_ocr_evaluation(source,out,tmp_path/'stage.pdf',ledger)
    final_ledger,checks=finalize_ocr_evaluation(source,out,tmp_path/'stage.pdf',ledger,evaluation_only=True)
    assert checks['passed'] and final_ledger['candidateSha256']==file_hash(tmp_path/'stage.pdf')
    assert final_ledger['evaluationLineage']['initialCandidateSha256']==ledger['candidateSha256']


def load_tests(loader,tests,pattern):
    suite=unittest.TestSuite()
    for name,function in list(globals().items()):
        if not name.startswith('test_') or not callable(function):continue
        for index,value in enumerate(getattr(function,'case_values',[None])):
            def run(function=function,value=value):
                with tempfile.TemporaryDirectory() as directory:
                    args=[Path(directory)]
                    if hasattr(function,'case_values'):args.append(value)
                    function(*args)
            run.__name__=f'{name}_{index}'
            run=unittest.skipUnless((FONT_DIR/'LiberationSans-Regular.ttf').is_file(),'Pinned local font fixture unavailable')(run)
            suite.addTest(unittest.FunctionTestCase(run,description=run.__name__))
    return suite


if __name__=='__main__':unittest.main()
