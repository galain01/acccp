"""Exercise saved form edits through PDFBox 3; evidence is separate from AT use.

Requires the pinned local toolchain and a new external output folder. This
runner never treats a successfully saved /V as proof that the appearance is
correct. Reopened Java evidence supplies the actual glyph codes and Unicode.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
from pathlib import Path
import subprocess

from PIL import ImageDraw
import pypdfium2 as pdfium
from pypdf import PdfReader

from form_font_repairs import encoding_map, FONT_PROGRAM_SHA256
from form_label_validation import _document_graph
from verify_pdf import Canonicalizer

REPO = Path(__file__).resolve().parents[2]
JAVA_SOURCE = Path(__file__).parent / 'java' / 'FormFillProbe.java'


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def json_write(path, value):
    with Path(path).open('x', encoding='utf-8') as handle:
        json.dump(value, handle, ensure_ascii=True, indent=2)


def fields(reader):
    result = {}
    for node in reader.root_object['/AcroForm']['/Fields']:
        node = node.get_object()
        if '/Kids' in node or str(node['/T']) in result:
            raise ValueError('flat_unique_fixture_fields_required')
        result[str(node['/T'])] = node
    return result


def check_saved_report(report, expected, expect_clipping=False):
    """Return explicit failed checks; never infer successful fallback."""
    errors = []
    if report.get('status') != 'saved' or report.get('pdfboxVersion') != '3.0.8':
        return ['editing_engine_refused_or_failed']
    records = {item['name']: item for item in report['fields']}
    if set(records) != set(expected):
        return ['saved_field_coverage_mismatch']
    for name, value in expected.items():
        record = records[name]
        saved = record['savedValue']
        if record['type'] == 'Ch':
            saved = saved[0] if isinstance(saved, list) and len(saved) == 1 else None
        if saved != value:
            errors.append(f'{name}:saved_value_mismatch')
        if not record['appearances']:
            errors.append(f'{name}:missing_appearance')
        for appearance in record['appearances']:
            if record['type'] == 'Btn':
                if appearance['appearanceState'] != value:
                    errors.append(f'{name}:checkbox_state_mismatch')
                continue
            if appearance['decodedUnicode'] != value:
                errors.append(f'{name}:appearance_unicode_mismatch')
            if appearance['fontProgramSha256'] != [FONT_PROGRAM_SHA256]:
                errors.append(f'{name}:unverified_font_program')
            glyphs = appearance['glyphs']
            if any(g.get('gid', 0) <= 0 or not g.get('hasGlyph') or not g.get('embedded')
                   or g.get('programSha256') != FONT_PROGRAM_SHA256 for g in glyphs):
                errors.append(f'{name}:missing_or_fallback_glyph')
            if any(g['fontSizePt'] != 12 for g in glyphs):
                errors.append(f'{name}:changed_font_size')
            if not (expect_clipping and name == 'participant') and any(g['inkClipped'] for g in glyphs):
                errors.append(f'{name}:unexpected_clipping')
    return errors


def outside_widget_pixels(path, rectangles):
    with pdfium.PdfDocument(path) as doc:
        doc.init_forms()
        if len(doc) != 1:
            raise ValueError('single_page_form_fixture_required')
        page = doc[0]
        bitmap = page.render(scale=2, may_draw_forms=True)
        image = bitmap.to_pil().convert('RGB').copy()
        bitmap.close(); page.close()
    masked = image.copy()
    draw = ImageDraw.Draw(masked)
    for x0,y0,x1,y1 in rectangles:
        # Two-pixel margin covers renderer antialiasing at a widget border.
        draw.rectangle((int(x0*2)-2,image.height-int(y1*2)-2,
                        int(x1*2)+2,image.height-int(y0*2)+2), fill='white')
    return image, hashlib.sha256(masked.tobytes()).hexdigest()


def native_unchanged(candidate, saved):
    before,after = PdfReader(candidate,strict=True),PdfReader(saved,strict=True)
    old,new = fields(before),fields(after)
    if set(old) != set(new):
        return False
    protected = ('/DA','/Ff','/Rect','/TU','/FT','/T','/Opt','/A','/AA','/BS','/MK','/StructParent','/P')
    # /P recursively contains changed appearances. Its exact page identity is
    # checked below, while all other protected values compare recursively.
    for name in old:
        for key in protected:
            if key == '/P':
                continue
            if Canonicalizer().value(old[name].get(key)) != Canonicalizer().value(new[name].get(key)):
                return False
    for reader,items in ((before,old),(after,new)):
        page=reader.pages[0]
        for node in items.values():
            if node.get('/P') != page.indirect_reference:
                return False
    if len(before.pages)!=len(after.pages):
        return False
    for left,right in zip(before.pages,after.pages):
        if left.get_contents().get_data()!=right.get_contents().get_data():
            return False
        for key in ('/Resources','/MediaBox','/CropBox','/Rotate','/UserUnit','/Tabs'):
            if Canonicalizer().value(left.get(key))!=Canonicalizer().value(right.get(key)):
                return False
    # Only requested values, choice indices, checkbox state and normal
    # appearances may change. Keep every other catalog/page/native object.
    for reader in (before,after):
        for node in fields(reader).values():
            for key in ('/V','/I','/AS','/AP'):
                node.pop(key,None)
    return _document_graph(before)==_document_graph(after)


def run(source, candidate, toolchain, output):
    source,candidate,output=Path(source).resolve(strict=True),Path(candidate).resolve(strict=True),Path(output).resolve()
    if output.exists() or output.is_relative_to(REPO):
        raise ValueError('new_external_output_directory_required')
    hashes={'sourceSha256':sha(source),'candidateSha256':sha(candidate)}
    output.mkdir(parents=True);classes=output/'classes';classes.mkdir()
    subprocess.run([toolchain['javac'],'-classpath',toolchain['pdfboxJar'],'-d',str(classes),str(JAVA_SOURCE)],check=True,capture_output=True,text=True,timeout=60)
    source_reader=PdfReader(source,strict=True)
    font=source_reader.root_object['/AcroForm']['/DR']['/Font']['/Helv'].get_object()
    entries,_=encoding_map(font)
    if len(entries)!=229:
        raise ValueError('bounded_229_character_fixture_required')
    characters=''.join(chr(entry['unicode']) for entry in entries)
    cases=[('ascii','Elodie Stone',False),('accents','Élodie Zoë Núñez',False),
           ('symbols','¯ ± µ · ÷',False),('punctuation','€ “Yes” — ﬁ ﬂ',False),
           ('boundary-fit','W'*19,False),('boundary-overflow','W'*20,True)]
    cases += [(f'encoding-{start:03}',characters[start:start+16],False) for start in range(0,len(characters),16)]
    candidate_reader=PdfReader(candidate,strict=True)
    rectangles=[list(map(float,node['/Rect'])) for node in fields(candidate_reader).values()]
    baseline,baseline_pixels=outside_widget_pixels(candidate,rectangles)
    baseline.save(output/'unchanged-input.png')
    results=[]
    for name,value,may_clip in cases + [('unsupported-cjk','漢字',False),('unsupported-emoji','🧪',False)]:
        expected={'participant':value,'session':'Afternoon','materials':'Yes'}
        plan=output/f'{name}.tsv'
        plan.write_text('\n'.join(base64.b64encode(k.encode()).decode()+'\t'+base64.b64encode(v.encode()).decode() for k,v in expected.items()),encoding='utf-8')
        saved=output/f'{name}.pdf'
        process=subprocess.run([toolchain['java'],'-cp',str(toolchain['pdfboxJar'])+';'+str(classes),
            'FormFillProbe',str(candidate),str(saved),str(plan)],capture_output=True,text=True,encoding='utf-8',timeout=30)
        report=json.loads(process.stdout)
        (output/f'{name}.stderr.txt').write_text(process.stderr,encoding='utf-8')
        json_write(output/f'{name}.json',report)
        negative=name.startswith('unsupported-')
        result={'case':name,'inputUnicode':value,'expectedRefusal':negative,'engineReport':str((output/f'{name}.json').resolve()),
                'savedPath':str(saved),'status':report['status'],'checks':{}}
        if negative:
            errors=[] if report['status']=='refused_or_failed' and not saved.exists() else ['unsupported_input_not_refused_before_save']
            result['checks']['noPartialOutput']=not saved.exists()
        else:
            errors=check_saved_report(report,expected,may_clip)
            if saved.exists():
                same_native=native_unchanged(candidate,saved)
                image,masked=outside_widget_pixels(saved,rectangles)
                result['checks'].update(protectedFieldAndPageObjectsUnchanged=same_native,outsideWidgetPixelsIdentical=masked==baseline_pixels)
                if not same_native: errors.append('protected_native_objects_changed')
                if masked!=baseline_pixels:errors.append('outside_widget_pixels_changed')
                if not name.startswith('encoding-'):image.save(output/f'{name}.png')
                result['outputSha256']=sha(saved)
                result['clippedGlyphs']=[{'field':field['name'],'index':i,'unicode':glyph['unicode'],'inkBounds':glyph['inkBounds'],'clipBounds':glyph['clipBounds']}
                    for field in report['fields'] for appearance in field['appearances'] for i,glyph in enumerate(appearance.get('glyphs',[])) if glyph['inkClipped']]
        result.update(passed=not errors,findings=errors);results.append(result)
    if (sha(source),sha(candidate))!=(hashes['sourceSha256'],hashes['candidateSha256']):
        raise ValueError('source_or_candidate_changed')
    summary={'schemaVersion':1,**hashes,'sourcePath':str(source),'candidatePath':str(candidate),
        'pdfboxVersion':'3.0.8','pdfboxJarSha256':sha(toolchain['pdfboxJar']),'runnerJavaSha256':sha(JAVA_SOURCE),
        'runnerPythonSha256':sha(Path(__file__)),'sourceEncodingEntryCount':len(entries),
        'sourceEncodingCharacters':characters,'sourceEncodingAllTested':len(entries)==229,
        'fontProgramSha256':FONT_PROGRAM_SHA256,'cases':results,'passed':all(r['passed'] for r in results),
        'limits':['PDFBox editing is not Acrobat or screen-reader testing.','A deliberate overflow case reports clipping; it does not promise arbitrary input length fits.','Only the bounded original character repertoire is supported; other inputs must be refused.'],
        'screenReaderTestPerformed':False,'standardConformanceEstablished':False}
    json_write(output/'report.json',summary)
    return summary


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source',type=Path);parser.add_argument('candidate',type=Path)
    parser.add_argument('--toolchain',type=Path,required=True);parser.add_argument('--output',type=Path,required=True)
    args=parser.parse_args()
    result=run(args.source,args.candidate,json.loads(args.toolchain.read_text(encoding='utf-8-sig')),args.output)
    print(json.dumps({'passed':result['passed'],'cases':len(result['cases']),'failedCases':[c['case'] for c in result['cases'] if not c['passed']]}))
    raise SystemExit(0 if result['passed'] else 1)
