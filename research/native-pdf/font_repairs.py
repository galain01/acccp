"""Explicit, local font substitution for three unembedded standard PDF fonts.

The user has authorized similar open-source glyphs, subject to layout checks.
Only unmodified WinAnsi Helvetica, Helvetica-Bold and Courier are supported.
Real, pinned Liberation 2.1.5 TrueType programs are embedded in full; original
content streams, text codes and layout operators are left untouched. Every
result still needs independent font/layout validation and a fresh audit.
"""
from __future__ import annotations

import argparse
import ctypes
import hashlib
import io
import json
import math
from pathlib import Path

import pypdfium2 as pdfium
from pypdf import PdfReader
from pypdf.generic import (ArrayObject, ContentStream, DecodedStreamObject,
    DictionaryObject, FloatObject, NameObject, NumberObject)
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase._glyphlist import _glyphname2unicode
from reportlab.pdfbase.ttfonts import TTFontFace

from conformance_repairs import _open
from verify_pdf import Canonicalizer

FONT_RELEASE = "https://github.com/liberationfonts/liberation-fonts/releases/tag/2.1.5"
FONT_DOWNLOAD = "https://github.com/liberationfonts/liberation-fonts/files/7261482/liberation-fonts-ttf-2.1.5.tar.gz"
ARCHIVE_SHA256 = "7191c669bf38899f73a2094ed00f7b800553364f90e2637010a69c0e268f25d0"
FONTS = {
    "Helvetica": ("LiberationSans-Regular.ttf", "LiberationSans", "76d04c18ea243f426b7de1f3ad208e927008f961dc5945e5aad352d0dfde8ee8"),
    "Helvetica-Bold": ("LiberationSans-Bold.ttf", "LiberationSans-Bold", "788abee4c806d660e8aee46689dd8540cd4bb98da03dcc9d171ce3efd99a9173"),
    "Courier": ("LiberationMono-Regular.ttf", "LiberationMono", "f2b83c763e8afd21709333370bed4774337fae82267937e2b5aea7e2fbd922c1"),
}


def resolved(value):
    return value.get_object() if hasattr(value, "get_object") else value


def rounded(value):
    return int(math.floor(float(value) + .5))


def charmap(base):
    encoding = pdfmetrics.getFont(base).encoding.vector
    return {code: _glyphname2unicode[name] for code, name in enumerate(encoding) if name in _glyphname2unicode}


def layout_snapshot(data: bytes):
    result = []
    total_chars=0
    with pdfium.PdfDocument(data) as pdf:
        for page in pdf:
            text = page.get_textpage()
            try:
                chars=[]
                count=text.count_chars();total_chars+=count
                if count>200_000 or total_chars>500_000:raise ValueError("layout_character_limit")
                for index in range(count):
                    x,y=ctypes.c_double(),ctypes.c_double()
                    if not pdfium.raw.FPDFText_GetCharOrigin(text,index,ctypes.byref(x),ctypes.byref(y)):
                        raise ValueError("text_origin_unavailable")
                    chars.append((int(pdfium.raw.FPDFText_GetUnicode(text,index)),x.value,y.value,float(pdfium.raw.FPDFText_GetFontSize(text,index))))
                result.append({"size":page.get_size(),"chars":chars})
            finally:
                text.close();page.close()
    return result


def measure_layout(before, after):
    if len(before)!=len(after):raise ValueError("font_substitution_changed_pages")
    maximum=0.0; count=0
    for source,target in zip(before,after):
        if source['size']!=target['size'] or len(source['chars'])!=len(target['chars']):
            raise ValueError("font_substitution_changed_text_geometry")
        for a,b in zip(source['chars'],target['chars']):
            if a[0]!=b[0]:raise ValueError("font_substitution_changed_unicode")
            delta=max(abs(a[i]-b[i]) for i in (1,2,3));maximum=max(maximum,delta);count+=1
            if delta>.02:raise ValueError("font_substitution_moved_text")
    return {"pageCount":len(before),"characterCount":count,"unicodeSequenceIdentical":True,
            "maxCharacterOriginOrFontSizeDifferencePt":maximum,"tolerancePt":.02,
            "contentStreamsUnchanged":True,"independentGlyphBoundsAndRasterReviewRequired":True}


def build_font(writer, base, font_path, used_codes):
    filename,target_name,expected=FONTS[base]
    if font_path.name!=filename or not font_path.is_file() or font_path.stat().st_size>2*1024*1024:
        raise ValueError("verified_font_program_required")
    program=font_path.read_bytes()
    if hashlib.sha256(program).hexdigest()!=expected:raise ValueError("font_program_hash_mismatch")
    face=TTFontFace(str(font_path),validate=1)
    if face.name.decode('ascii')!=target_name:raise ValueError("font_program_name_mismatch")
    unicode_map=charmap(base)
    original=pdfmetrics.getFont(base)
    for code in used_codes:
        point=unicode_map.get(code)
        if point is None or point not in face.charToGlyph or face.charToGlyph[point]==0:
            raise ValueError("used_glyph_not_covered")
        old=original.face.glyphWidths.get(original.encoding.vector[code])
        if old is None or rounded(face.charWidths[point])!=old:
            raise ValueError("used_glyph_advance_not_equivalent")
    widths=[rounded(face.charWidths.get(unicode_map.get(code),face.defaultWidth)) for code in range(256)]
    fontfile=DecodedStreamObject();fontfile.set_data(program);fontfile[NameObject('/Length1')]=NumberObject(len(program))
    descriptor=DictionaryObject({NameObject('/Type'):NameObject('/FontDescriptor'),NameObject('/FontName'):NameObject('/'+target_name),
        NameObject('/Flags'):NumberObject((face.flags & ~4)|32),NameObject('/FontBBox'):ArrayObject([FloatObject(v) for v in face.bbox]),
        NameObject('/Ascent'):FloatObject(face.ascent),NameObject('/Descent'):FloatObject(face.descent),NameObject('/CapHeight'):FloatObject(face.capHeight),
        NameObject('/ItalicAngle'):FloatObject(face.italicAngle),NameObject('/StemV'):NumberObject(face.stemV),
        NameObject('/FontFile2'):writer._add_object(fontfile)})
    lines=['/CIDInit /ProcSet findresource begin','12 dict begin','begincmap',
        '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def','/CMapName /LiberationWinAnsi def','/CMapType 2 def',
        '1 begincodespacerange','<00> <FF>','endcodespacerange']
    pairs=list(unicode_map.items())
    for offset in range(0,len(pairs),100):
        batch=pairs[offset:offset+100];lines.append(str(len(batch))+' beginbfchar')
        lines.extend(f'<{code:02X}> <{chr(point).encode("utf-16-be").hex().upper()}>' for code,point in batch);lines.append('endbfchar')
    lines.extend(['endcmap','CMapName currentdict /CMap defineresource pop','end','end'])
    to_unicode=DecodedStreamObject();to_unicode.set_data(('\n'.join(lines)+'\n').encode('ascii'))
    return DictionaryObject({NameObject('/Type'):NameObject('/Font'),NameObject('/Subtype'):NameObject('/TrueType'),
        NameObject('/BaseFont'):NameObject('/'+target_name),NameObject('/Encoding'):NameObject('/WinAnsiEncoding'),
        NameObject('/FirstChar'):NumberObject(0),NameObject('/LastChar'):NumberObject(255),NameObject('/Widths'):ArrayObject([NumberObject(v) for v in widths]),
        NameObject('/FontDescriptor'):writer._add_object(descriptor),NameObject('/ToUnicode'):writer._add_object(to_unicode)})


def substitute_fonts(source: Path, output: Path, font_directory: Path, *, allow_font_substitution=False):
    if allow_font_substitution is not True:raise ValueError("explicit_font_substitution_required")
    reader,writer=_open(source,output)
    original_bytes=reader.stream.getvalue();input_hash=hashlib.sha256(original_bytes).hexdigest()
    planned={};resources=[];used={};used_by_resource={}
    for page_number,page in enumerate(reader.pages,1):
        if resolved(page.get('/Resources',{})).get('/Pattern') is not None:
            raise ValueError('pattern_fonts_unsupported')
        fonts=resolved(resolved(page.get('/Resources',{})).get('/Font',{}))
        for name,ref in fonts.items():
            font=resolved(ref);base=str(font.get('/BaseFont','')).lstrip('/')
            if base not in FONTS:continue
            if font.get('/FontDescriptor') is not None:continue
            if (font.get('/Subtype')!='/Type1' or font.get('/Encoding')!='/WinAnsiEncoding'
                or set(font)-{'/Type','/Subtype','/BaseFont','/Encoding','/Name'}):
                raise ValueError('unsupported_source_font_encoding_or_metrics')
            key=(ref.idnum,ref.generation) if hasattr(ref,'idnum') else ('direct',id(font))
            planned[key]=(base,font);used.setdefault(key,set())
            resources.append((page_number,str(name),key))
            used_by_resource[page_number,str(name)]=set()
        page_targets={name:key for p,name,key in resources if p==page_number}
        current=None;stack=[]
        content=page.get('/Contents')
        ops=ContentStream(content,reader,'bytes').operations if content is not None else []
        if len(ops)>200_000:raise ValueError('operator_limit')
        for args,op in ops:
            if op==b'q':stack.append(current)
            elif op==b'Q':
                if not stack:raise ValueError('unbalanced_graphics_state')
                current=stack.pop()
            elif op==b'Tf':current=str(args[0])
            elif op==b'Do':
                asset=resolved(resolved(resolved(page.get('/Resources',{})).get('/XObject',{})).get(args[0]))
                if isinstance(asset,dict) and asset.get('/Subtype')=='/Form':raise ValueError('form_fonts_unsupported')
            elif op==b'gs':
                state=resolved(resolved(resolved(page.get('/Resources',{})).get('/ExtGState',{})).get(args[0]))
                if isinstance(state,dict) and '/Font' in state:raise ValueError('graphics_state_font_unsupported')
            elif op in (b'Tj',b'TJ',b"'",b'"') and current in page_targets:
                pieces=args[0] if op==b'TJ' else args[-1:]
                for piece in pieces:
                    if isinstance(piece,bytes):
                        used[page_targets[current]].update(piece)
                        used_by_resource[page_number,current].update(piece)
                    elif isinstance(piece,str):raise ValueError('raw_text_codes_required')
        if stack:raise ValueError('unbalanced_graphics_state')
    if not planned:raise ValueError('no_supported_unembedded_fonts')
    # This first experiment deliberately excludes forms and annotations with
    # appearances: text in those streams needs its own occurrence/layout evidence.
    if reader.trailer['/Root'].get('/AcroForm') is not None:raise ValueError('form_fonts_unsupported')
    for page in reader.pages:
        if any(resolved(annotation).get('/AP') is not None for annotation in resolved(page.get('/Annots',[]))):
            raise ValueError('annotation_appearance_fonts_unsupported')
    replacements={}
    for key,(base,font) in planned.items():
        if not used[key]:raise ValueError('unused_font_substitution_not_supported')
        replacements[key]=build_font(writer,base,font_directory/FONTS[base][0],used[key])
    ledger=[];mutated=set()
    for page_number,name,key in resources:
        font=resolved(writer.pages[page_number-1]['/Resources']['/Font'][name])
        base,old=planned[key]
        source_digest=Canonicalizer().hash(old)
        if id(font) not in mutated:
            old_name=font.get('/Name');font.clear();font.update(replacements[key])
            if old_name is not None:font[NameObject('/Name')]=old_name
            mutated.add(id(font))
        ledger.append({'pageNumber':page_number,'resourceName':name,'resourcePath':f'page/{page_number}/Resources/Font/{name.lstrip("/")}',
            'sourceBaseFont':base,'targetBaseFont':FONTS[base][1],'sourceFontSha256':source_digest,'targetFontSha256':Canonicalizer().hash(font),
            'fontProgramSha256':FONTS[base][2],'fontProgramVersion':'2.1.5','license':'OFL-1.1','sourceUrl':FONT_DOWNLOAD,
            'usedCharacterCodes':sorted(used_by_resource[page_number,name]),'documentUsedCharacterCodes':sorted(used[key]),'usedAdvanceWidthsMatched':True,'glyphShapesMayDiffer':True})
    buffer=io.BytesIO();writer.write(buffer);candidate_bytes=buffer.getvalue()
    if len(candidate_bytes)>4*1024*1024:raise ValueError('candidate_size_limit')
    reopened=PdfReader(io.BytesIO(candidate_bytes),strict=True)
    for entry in ledger:
        saved_font=reopened.pages[entry['pageNumber']-1]['/Resources']['/Font'][entry['resourceName']]
        entry['targetFontSha256']=Canonicalizer().hash(saved_font)
    layout=measure_layout(layout_snapshot(original_bytes),layout_snapshot(candidate_bytes))
    output.parent.mkdir(parents=True,exist_ok=True)
    with output.open('xb') as stream:stream.write(candidate_bytes)
    output_hash=hashlib.sha256(candidate_bytes).hexdigest()
    return {'schemaVersion':1,'inputSha256':input_hash,'outputSha256':output_hash,'sourceSha256':input_hash,'candidateSha256':output_hash,
        'authorization':{'fontSubstitution':True,'glyphAppearanceMayChange':True},'experimental':True,'certification':False,
        'substitutions':ledger,'layout':layout,'provenance':{'releaseUrl':FONT_RELEASE,'archiveSha256':ARCHIVE_SHA256,'license':'OFL-1.1'},
        'requiresFreshAuditAndIndependentFontValidation':True}


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('source',type=Path);parser.add_argument('output',type=Path)
    parser.add_argument('--font-directory',required=True,type=Path);parser.add_argument('--allow-font-substitution',action='store_true')
    args=parser.parse_args();print(json.dumps(substitute_fonts(args.source,args.output,args.font_directory,allow_font_substitution=args.allow_font_substitution),indent=2))
