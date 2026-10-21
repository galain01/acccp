"""Independent explicit permission for embedded form-font substitutions.

Native fields and appearance programs remain exact. Approved glyph shapes may
change only inside independently checked character regions. This local check
does not claim that every PDF viewer supports every future field input.
"""
from __future__ import annotations

import copy
import io
import json
import math
import re
from pathlib import Path

import numpy as np
from pypdf import PdfReader, PdfWriter
from pypdf.generic import (ArrayObject, DecodedStreamObject, DictionaryObject,
                           NameObject, NumberObject, StreamObject, TextStringObject)
import pypdfium2 as pdfium

import verify_pdf as v
import font_validation as font_check
import form_label_validation as labels
from form_order_validation import compare_with_authorized_form_order

require = labels.require
FONT_SHA256 = '76d04c18ea243f426b7de1f3ad208e927008f961dc5945e5aad352d0dfde8ee8'
FONT_NAME = 'LiberationSans'
FONT_URL = 'https://github.com/liberationfonts/liberation-fonts/releases/tag/2.1.5'
FUTURE_ONLY_WIDTHS = {175: (333, 552), 177: (584, 549), 181: (556, 576),
                      183: (278, 333), 247: (584, 549)}
LEDGER_KEYS={'schemaVersion','operation','sourcePath','sourceSha256','inputPath','inputSha256','outputSha256',
             'orderLedgerPath','orderLedgerSha256','authorization','fontSource','substitutions','requiresFreshAudit','certification'}
SUBSTITUTION_KEYS={'resourcePath','encoding','undefinedCodes','currentUsedCodes','widthChanges','sourceFontSha256',
                   'sourceEncodingSha256','targetFontSha256','targetEncodingSha256'}
FONT_SOURCE_KEYS={'path','sha256','postscriptName','programSha256','releaseUrl','license'}


def original_encoding(font):
    """Resolve Adobe Standard/WinAnsi names and explicit Differences ourselves."""
    from reportlab.pdfbase import _fontdata
    from fontTools.agl import toUnicode
    require(font.get('/Subtype') == '/Type1' and font.get('/BaseFont') == '/Helvetica'
            and set(font) <= {'/Type','/Subtype','/BaseFont','/Encoding','/Name'}, 'form_font_source_font_unsupported')
    encoding = v.resolved(font.get('/Encoding'))
    if isinstance(encoding, NameObject):
        base, differences = str(encoding)[1:], []
    elif isinstance(encoding, dict):
        require(set(encoding) <= {'/Type','/BaseEncoding','/Differences'}, 'form_font_encoding_keys_unsupported')
        require('/Type' not in encoding or encoding['/Type']=='/Encoding','form_font_encoding_type_invalid')
        base = str(encoding.get('/BaseEncoding', '/StandardEncoding'))[1:]
        differences = v.resolved(encoding.get('/Differences', []))
    elif encoding is None:
        base, differences = 'StandardEncoding', []
    else:
        raise v.InspectionError('form_font_encoding_unsupported')
    require(base in ('StandardEncoding','WinAnsiEncoding') and isinstance(differences,list) and len(differences) <= 512,
            'form_font_encoding_unsupported')
    names = list(_fontdata.encodings[base]); next_code = None; altered = set()
    for item in differences:
        if type(item).__name__ in ('int','NumberObject'):
            require(0 <= int(item) <= 255, 'form_font_encoding_code_invalid'); next_code = int(item)
        else:
            require(isinstance(item, NameObject) and next_code is not None and next_code < 256 and next_code not in altered,
                    'form_font_encoding_difference_invalid')
            altered.add(next_code); names[next_code] = str(item)[1:]; next_code += 1
    rows=[]; undefined=[]
    for code,name in enumerate(names):
        if not name or name == '.notdef': undefined.append(code); continue
        text = toUnicode(name)
        require(len(text) == 1 and name in _fontdata.widthsByFontGlyph['Helvetica'], 'form_font_original_glyph_unresolved')
        rows.append({'code':code,'glyphName':name,'unicode':ord(text),
                     'sourceWidth':int(_fontdata.widthsByFontGlyph['Helvetica'][name])})
    require(len({row['unicode'] for row in rows}) == len(rows), 'form_font_original_unicode_ambiguous')
    return rows,undefined


def original_used_codes(slot, reader):
    if slot['kind'] != 'appearance': return []
    from pypdf.generic import ContentStream, ByteStringObject
    selected=None; stack=[]; used=set()
    for args,operator in ContentStream(slot['appearance'],reader).operations:
        if operator == b'q': stack.append(selected)
        elif operator == b'Q':
            require(stack,'form_font_graphics_unbalanced'); selected=stack.pop()
        elif operator == b'Tf':
            require(len(args)==2,'form_font_text_font_invalid'); selected=str(args[0])
        elif operator in (b'gs',b'Do'):
            raise v.InspectionError('form_font_indirect_appearance_text_unsupported')
        elif selected == str(slot['name']) and operator in (b'Tj',b'TJ',b"'",b'"'):
            values=args[0] if operator==b'TJ' else args[-1:]
            for value in values:
                if isinstance(value,TextStringObject):used.update(value.original_bytes)
                elif isinstance(value,(ByteStringObject,bytes)):used.update(bytes(value))
                else:require(isinstance(value,(int,float)),'form_font_text_bytes_unresolved')
    require(not stack,'form_font_graphics_unbalanced')
    return sorted(used)


def _unicode_map(font):
    stream=v.resolved(font.get('/ToUnicode'))
    require(isinstance(stream,StreamObject),'form_font_unicode_missing')
    require(set(stream)<={'/Length','/Filter','/DecodeParms'},'form_font_unicode_stream_keys_unsupported')
    data=stream.get_data()
    require(len(data)<=100000,'form_font_unicode_limit')
    text=data.decode('ascii','strict')
    require('usecmap' not in text and 'beginbfrange' not in text and 'begincid' not in text,
            'form_font_unicode_map_unsupported')
    spaces=re.findall(r'([0-9]+)\s+begincodespacerange\s*(.*?)\s*endcodespacerange',text,re.S)
    require(len(spaces)==1 and spaces[0][0]=='1'
            and re.fullmatch(r'<00>\s*<FF>',spaces[0][1],re.I), 'form_font_unicode_codespace_invalid')
    mapping={}
    blocks=re.findall(r'([0-9]+)\s+beginbfchar\s*(.*?)\s*endbfchar',text,re.S)
    require(blocks and len(blocks)<=16,'form_font_unicode_blocks_invalid')
    for count,body in blocks:
        pairs=re.findall(r'<([0-9A-Fa-f]{2})>\s*<([0-9A-Fa-f]{4})>',body)
        require(len(pairs)==int(count) and not re.sub(r'<[0-9A-Fa-f]{2}>\s*<[0-9A-Fa-f]{4}>','',body).strip(),
                'form_font_unicode_pairs_invalid')
        for code,unicode in pairs:
            code=int(code,16);require(code not in mapping,'form_font_unicode_duplicate_code')
            mapping[code]=int(unicode,16)
    # No fallback CMaps, additional mappings, or embedded PostScript programs.
    stripped=re.sub(r'[0-9]+\s+beginbfchar\s*.*?\s*endbfchar','',text,flags=re.S)
    preamble=(r'/CIDInit\s+/ProcSet\s+findresource\s+begin\s+12\s+dict\s+begin\s+begincmap\s+'
              r'/CIDSystemInfo\s*<<\s*/Registry\s*\(Adobe\)\s*/Ordering\s*\(UCS\)\s*/Supplement\s+0\s*>>\s*def\s+'
              r'/CMapName\s+/[A-Za-z0-9_-]{1,64}\s+def\s+/CMapType\s+2\s+def\s+'
              r'1\s+begincodespacerange\s*<00>\s*<FF>\s*endcodespacerange\s*'
              r'endcmap\s+CMapName\s+currentdict\s+/CMap\s+defineresource\s+pop\s+end\s+end\s*')
    require(re.fullmatch(preamble,stripped),'form_font_unicode_program_unsupported')
    return mapping


def validate_form_font_pair(before,after,entry,source_font_bytes,used_codes):
    from fontTools.ttLib import TTFont
    require(v.digest(source_font_bytes)==FONT_SHA256,'form_font_unapproved_source_program')
    require(labels.ExactGraph([]).hash(before)==entry.get('sourceFontSha256')
            and labels.ExactGraph([]).hash(after)==entry.get('targetFontSha256'),'form_font_dictionary_hash_mismatch')
    require(v.Canonicalizer().hash(before.get('/Encoding'))==entry.get('sourceEncodingSha256')
            and v.Canonicalizer().hash(after.get('/Encoding'))==entry.get('targetEncodingSha256'),
            'form_font_encoding_hash_mismatch')
    rows,undefined=original_encoding(before)
    require(after.get('/Subtype')=='/TrueType' and after.get('/BaseFont')=='/'+FONT_NAME
            and set(after)<={'/Type','/Subtype','/BaseFont','/Encoding','/Name','/FirstChar','/LastChar','/Widths','/FontDescriptor','/ToUnicode'},
            'form_font_target_dictionary_unsupported')
    require(after.get('/FirstChar')==0 and after.get('/LastChar')==255,'form_font_complete_widths_required')
    widths=v.resolved(after.get('/Widths'))
    require(isinstance(widths,list) and len(widths)==256 and all(v.integer(x) is not None for x in widths),
            'form_font_widths_invalid')
    descriptor=v.resolved(after.get('/FontDescriptor'))
    require(isinstance(descriptor,dict) and descriptor.get('/FontName')=='/'+FONT_NAME
            and descriptor.get('/Flags')==32 and '/FontFile' not in descriptor and '/FontFile3' not in descriptor,
            'form_font_descriptor_unsupported')
    require(set(descriptor)=={'/Type','/FontName','/Flags','/FontBBox','/Ascent','/Descent','/CapHeight','/ItalicAngle','/StemV','/FontFile2'}
            and descriptor.get('/Type')=='/FontDescriptor', 'form_font_descriptor_keys_unsupported')
    program=v.resolved(descriptor.get('/FontFile2'))
    require(isinstance(program,StreamObject) and v.digest(program.get_data())==FONT_SHA256,
            'form_font_embedded_program_not_approved')
    require(set(program)<={'/Length','/Filter','/DecodeParms','/Length1'}
            and program.get('/Length1')==len(program.get_data()),'form_font_program_stream_keys_or_length_invalid')
    # TrueType requires an explicit supported base encoding. Override every
    # byte so the old StandardEncoding+Differences map remains exact.
    encoding=v.resolved(after.get('/Encoding'))
    require(isinstance(encoding,dict) and set(encoding)<={'/Type','/BaseEncoding','/Differences'}
            and encoding.get('/BaseEncoding')=='/WinAnsiEncoding', 'form_font_target_encoding_unsupported')
    differences=v.resolved(encoding.get('/Differences'))
    names={row['code']:row['glyphName'] for row in rows}
    require(isinstance(differences,list) and len(differences)==257 and v.integer(differences[0])==0
            and all(isinstance(differences[code+1],NameObject)
                    and str(differences[code+1])=='/'+names.get(code,'.notdef') for code in range(256)),
            'form_font_target_encoding_not_source_equivalent')
    parsed=TTFont(io.BytesIO(source_font_bytes),lazy=False)
    try:
        head=parsed['head']; units=int(head.unitsPerEm); cmap=parsed.getBestCmap()
        require(units>0 and isinstance(cmap,dict) and parsed['OS/2'].fsType==0, 'form_font_program_units_unsupported')
        require(font_check.max_delta([float(x) for x in v.resolved(descriptor.get('/FontBBox',[]))],
                [getattr(head,key)*1000/units for key in ('xMin','yMin','xMax','yMax')]) <= .0001,
                'form_font_descriptor_bounds_changed')
        expected_metrics={'/Ascent':parsed['OS/2'].sTypoAscender*1000/units,
                          '/Descent':parsed['OS/2'].sTypoDescender*1000/units,
                          '/CapHeight':parsed['OS/2'].sCapHeight*1000/units,
                          '/ItalicAngle':parsed['post'].italicAngle,'/StemV':87}
        require(all(abs(float(descriptor[key])-expected)<=.0001 for key,expected in expected_metrics.items()),
                'form_font_descriptor_metrics_changed')
        allowed_differences=[]
        for row in rows:
            glyph=cmap.get(row['unicode']); require(glyph is not None and glyph!='.notdef','form_font_program_glyph_missing')
            target_width=round(parsed['hmtx'].metrics[glyph][0]*1000/units)
            row['targetWidth']=target_width
            require(int(widths[row['code']])==target_width,'form_font_declared_width_not_program_width')
            if target_width != row['sourceWidth']:
                require(FUTURE_ONLY_WIDTHS.get(row['unicode'])==(row['sourceWidth'],target_width)
                        and row['code'] not in used_codes,'form_font_existing_text_advance_changed')
                allowed_differences.append(dict(row))
        require(all(int(widths[code])==0 for code in undefined),'form_font_undefined_width_invalid')
    finally:parsed.close()
    require(_unicode_map(after)=={row['code']:row['unicode'] for row in rows},'form_font_unicode_mapping_changed')
    ledger_rows=[{**{key:value for key,value in row.items() if key!='sourceWidth'},'width':row['sourceWidth']} for row in rows]
    require(entry.get('encoding')==ledger_rows and entry.get('undefinedCodes')==undefined
            and entry.get('currentUsedCodes')==used_codes,'form_font_encoding_evidence_mismatch')
    require(entry.get('widthChanges')==allowed_differences,'form_font_width_change_evidence_mismatch')
    require(not(set(used_codes)&set(undefined)),'form_font_current_undefined_code')
    return {'definedCodeCount':len(rows),'undefinedCodeCount':len(undefined),'currentUsedCodes':used_codes,
            'allUnicodeMappingsVerified':True,'allDeclaredWidthsMatchProgram':True,
            'originalCurrentAdvanceWidthsPreserved':True,'futureInputWidthDifferences':allowed_differences,
            'embeddedProgramSha256':FONT_SHA256,'fontSourceSha256':FONT_SHA256}


def font_slots(reader):
    """Enumerate each slot, retaining shared-font occurrences as separate keys."""
    slots = {}
    def add(resources, prefix, info):
        resources = v.resolved(resources)
        require(isinstance(resources, dict), 'form_font_resources_invalid')
        fonts = v.resolved(resources.get('/Font', {}))
        require(isinstance(fonts, dict) and len(fonts) <= 64, 'form_font_resources_invalid')
        # Nested Form text requires a separate placement model, not a broad mask.
        objects = v.resolved(resources.get('/XObject', {}))
        require(isinstance(objects, dict) and all(v.resolved(item).get('/Subtype') != '/Form'
                for item in objects.values()), 'form_font_nested_appearance_unsupported')
        for name, reference in sorted(fonts.items()):
            require(isinstance(name, NameObject) and '/' not in str(name)[1:] and not any(c.isspace() for c in str(name)),
                    'form_font_resource_name_invalid')
            font = v.resolved(reference)
            require(isinstance(font, dict) and font.get('/Type') == '/Font', 'form_font_dictionary_invalid')
            path = prefix + '/Font/' + str(name)[1:]
            require(path not in slots and len(slots) < 256, 'form_font_slot_limit')
            slots[path] = {'owner': fonts, 'name': name, 'font': font, **info}
    form = v.resolved(reader.root_object.get('/AcroForm'))
    require(isinstance(form, dict), 'form_font_acroform_missing')
    add(form.get('/DR', {}), 'AcroForm/DR', {'kind': 'defaultResources'})
    owners = labels._owners(reader)
    for (page, ordinal), (_, widget) in sorted(owners.items()):
        appearances = v.resolved(widget.get('/AP'))
        require(isinstance(appearances, dict), 'form_font_appearance_missing')
        for kind, item in sorted(appearances.items()):
            require(kind in ('/N', '/R', '/D'), 'form_font_appearance_kind_unsupported')
            item = v.resolved(item)
            alternatives = [('', item)] if isinstance(item, StreamObject) else list(item.items()) if isinstance(item, dict) else []
            require(alternatives and len(alternatives) <= 32, 'form_font_appearance_states_invalid')
            for state, appearance in alternatives:
                appearance = v.resolved(appearance)
                require(isinstance(appearance, StreamObject) and appearance.get('/Subtype') == '/Form', 'form_font_appearance_stream_required')
                suffix = str(kind) + (str(state) if state else '')
                prefix = f'page/{page}/Annots/{ordinal}/AP{suffix}/Resources'
                add(appearance.get('/Resources', {}), prefix,
                    {'kind': 'appearance', 'pageNumber': page, 'annotationIndex': ordinal,
                     'appearanceKind': str(kind), 'appearanceState': str(state) if state else None,
                     'appearance': appearance, 'widget': widget})
    return slots


def appearance_projection(reader, appearance):
    """Expose saved AP text to an independent renderer without filling a field."""
    bbox = v.resolved(appearance.get('/BBox'))
    matrix = v.resolved(appearance.get('/Matrix', [1, 0, 0, 1, 0, 0]))
    require(isinstance(bbox, list) and len(bbox) == 4 and [float(x) for x in bbox[:2]] == [0, 0]
            and all(math.isfinite(float(n)) for n in bbox) and bbox[2] > 0 and bbox[3] > 0,
            'form_font_appearance_box_unsupported')
    require(list(matrix) == [1, 0, 0, 1, 0, 0], 'form_font_appearance_matrix_unsupported')
    writer = PdfWriter()
    page = writer.add_blank_page(float(bbox[2]), float(bbox[3]))
    # Clone only this AP's saved resources and decoded program. All original
    # page and widget rectangles are verified separately against the input.
    page[NameObject('/Resources')] = appearance.get('/Resources', DictionaryObject()).clone(writer)
    stream = DecodedStreamObject(); stream.set_data(appearance.get_data())
    page[NameObject('/Contents')] = writer._add_object(stream)
    data = io.BytesIO(); writer.write(data)
    return data.getvalue()


def _projection_characters(data):
    document = pdfium.PdfDocument(data)
    try:
        page = document[0]
        try:
            textpage = page.get_textpage()
            try:
                return font_check.char_inventory(textpage)
            finally:
                textpage.close()
        finally:
            page.close()
    finally:
        document.close()


def verify_form_layout(before_data, after_data, before, after, changed_paths):
    """Saved AP geometry and full initialized forms permit glyph-only pixels."""
    left_slots, right_slots = font_slots(before), font_slots(after)
    masks_by_page, ap_reports, seen_appearances = {}, [], set()
    for path in sorted(changed_paths):
        left, right = left_slots[path], right_slots[path]
        if left['kind'] != 'appearance':
            continue
        identity = (left['pageNumber'], left['annotationIndex'], left['appearanceKind'], left['appearanceState'])
        if identity in seen_appearances: continue
        seen_appearances.add(identity)
        appearance, saved = left['appearance'], right['appearance']
        a, b = appearance_projection(before, appearance), appearance_projection(after, saved)
        names = {font_check.font_name(slot['font']['/BaseFont']):
                 font_check.font_name(right_slots[slot_path]['font']['/BaseFont'])
                 for slot_path, slot in left_slots.items() if slot_path in changed_paths
                 and slot.get('appearance') is appearance}
        layout = font_check.verify_rendered_layout(a, b, {1: names})
        old_chars, new_chars = _projection_characters(a), _projection_characters(b)
        require(len(old_chars) == len(new_chars), 'form_font_appearance_character_count_changed')
        rect = [float(n) for n in v.resolved(left['widget']['/Rect'])]
        box = [float(n) for n in v.resolved(appearance['/BBox'])]
        require(len(rect) == 4 and abs((rect[2]-rect[0])-box[2]) <= .00001
                and abs((rect[3]-rect[1])-box[3]) <= .00001, 'form_font_scaled_widget_unsupported')
        glyphs = []
        for old, new in zip(old_chars, new_chars):
            if old['font'] in names and new['font'] == names[old['font']] and not old['generated'] and not chr(old['codepoint']).isspace():
                for char in (old, new):
                    x0,y0,x1,y1 = char['box']
                    glyphs.append((x0+rect[0],y0+rect[1],x1+rect[0],y1+rect[1]))
        # Only the currently shown /N state contributes to a full-page mask.
        selected = str(left['widget'].get('/AS')) if '/AS' in left['widget'] else None
        if left['appearanceKind'] == '/N' and left['appearanceState'] == selected:
            masks_by_page.setdefault(left['pageNumber'], []).extend(glyphs)
        ap_reports.append({'pageNumber': identity[0], 'annotationIndex': identity[1],
                           'appearanceKind': identity[2], 'appearanceState': identity[3], 'layout': layout,
                           'decodedText': ''.join(chr(c['codepoint']) for c in new_chars), 'glyphRegionCount': len(glyphs)})
    docs = [pdfium.PdfDocument(data) for data in (before_data, after_data)]
    pages = []
    try:
        for document in docs: document.init_forms()
        require(len(docs[0]) == len(docs[1]), 'form_font_page_count_changed')
        for page_number in range(1, len(docs[0])+1):
            handles = [document[page_number-1] for document in docs]
            bitmaps = []
            try:
                sizes = [page.get_size() for page in handles]
                require(sizes[0] == sizes[1] and all(page.get_rotation() == 0 for page in handles), 'form_font_page_geometry_changed')
                width,height=sizes[0]
                require(math.ceil(width*v.RENDER_SCALE)*math.ceil(height*v.RENDER_SCALE) <= v.MAX_PAGE_PIXELS, 'form_font_render_limit')
                bitmaps = [page.render(scale=v.RENDER_SCALE,draw_annots=True,may_draw_forms=True) for page in handles]
                pixels = [np.asarray(bitmap.to_pil().convert('RGB')) for bitmap in bitmaps]
                require(pixels[0].shape == pixels[1].shape, 'form_font_render_dimensions_changed')
                changed = np.any(pixels[0] != pixels[1],axis=2)
                allowed = np.zeros(changed.shape,dtype=bool)
                for box in masks_by_page.get(page_number,[]): font_check.box_mask(allowed,box,height,v.RENDER_SCALE)
                outside = int(np.count_nonzero(changed & ~allowed))
                require(outside == 0, 'form_font_pixels_changed_outside_glyphs')
                pages.append({'pageNumber':page_number,'changedPixels':int(np.count_nonzero(changed)),
                              'changedPixelsOutsideGlyphs':outside,'initializedFormsRendered':True})
            finally:
                for value in bitmaps+handles:value.close()
    finally:
        for document in docs:document.close()
    return {'appearanceLayouts':ap_reports,'pages':pages,'glyphOnlyChangesVerified':True}


def _read_json(path, expected, limit=512000):
    path=Path(path)
    require(path.is_file() and path.stat().st_size<=limit,'form_font_ledger_size_limit')
    raw=path.read_bytes();require(v.digest(raw)==expected,'form_font_prior_ledger_hash_mismatch')
    value=json.loads(raw.decode('utf-8-sig'));require(isinstance(value,dict),'form_font_ledger_object_required')
    return value


def _restore_exact_font_slots(before, after, changed_paths):
    """Undo only declared resource fonts, keeping existing encoding aliases."""
    left,right=font_slots(before),font_slots(after)
    # In-place normalization must not sweep an unlisted page resource into the
    # exception through a shared font reference, even when that font is unused.
    require(len(before.pages)==len(after.pages) and all(
        labels.ExactGraph(list(before.pages)).hash(a.get('/Resources',{}))==
        labels.ExactGraph(list(after.pages)).hash(b.get('/Resources',{}))
        for a,b in zip(before.pages,after.pages)), 'form_font_unlisted_page_resource_change')
    old_enc=v.resolved(v.resolved(before.root_object['/AcroForm'].get('/DR',{})).get('/Encoding',{}))
    new_enc=v.resolved(v.resolved(after.root_object['/AcroForm'].get('/DR',{})).get('/Encoding',{}))
    require(isinstance(old_enc,dict) and isinstance(new_enc,dict) and set(old_enc)==set(new_enc),
            'form_font_default_encoding_resources_changed')
    replacements={}
    for name,item in old_enc.items():
        require(labels.ExactGraph([]).hash(item)==labels.ExactGraph([]).hash(new_enc[name]),
                'form_font_default_encoding_resources_changed')
        replacements[id(v.resolved(item))]=new_enc.raw_get(name)
    restored=set()
    for path in sorted(changed_paths):
        a,b=left[path]['font'],right[path]['font']
        if id(b) in restored:continue
        restored.add(id(b));values={}
        for key,value in a.items():
            values[key]=replacements.get(id(v.resolved(value)),value)
        b.clear();b.update(values)
    require(labels._document_graph(before)==labels._document_graph(after),'form_font_unlisted_native_change')


def _fill_bytes(data, values):
    writer=PdfWriter(clone_from=PdfReader(io.BytesIO(data),strict=True))
    writer.update_page_form_field_values(None,values,auto_regenerate=False,flatten=False)
    # auto_regenerate=False changes NeedAppearances; it is an API-generated
    # fixture setting, not an authorization to change the delivered document.
    output=io.BytesIO();writer.write(output);return output.getvalue()


def _saved_appearance_text(reader, appearance):
    from pypdf.generic import ContentStream
    fonts=v.resolved(v.resolved(appearance['/Resources'])['/Font']);selected=None;parts=[]
    for args,op in ContentStream(appearance,reader,'bytes').operations:
        if op==b'Tf':selected=str(args[0])
        elif op in (b'Tj',b'TJ',b"'",b'"'):
            require(selected in fonts,'form_font_future_unknown_font')
            mapping=_unicode_map(v.resolved(fonts[selected]))
            pieces=args[0] if op==b'TJ' else args[-1:]
            for piece in pieces:
                if isinstance(piece,bytes):
                    require(all(code in mapping for code in piece),'form_font_future_undefined_character')
                    parts.extend(chr(mapping[code]) for code in piece)
                else:require(isinstance(piece,(int,float)),'form_font_future_character_bytes_unresolved')
    return ''.join(parts)


def _appearance_text_clip(reader, appearance):
    """Bound generated single-line APs to their actual rectangular text clip."""
    from pypdf.generic import ContentStream
    clip=tuple(float(n) for n in appearance['/BBox']);stack=[];path=None;clips=[]
    for args,op in ContentStream(appearance,reader,'bytes').operations:
        if op==b'q':stack.append(clip)
        elif op==b'Q':
            require(bool(stack),'form_font_future_clip_unbalanced');clip=stack.pop()
        elif op==b'cm':require([float(x) for x in args]==[1,0,0,1,0,0],'form_font_future_transformed_clip_unsupported')
        elif op==b're':
            require(path is None and len(args)==4 and all(math.isfinite(float(x)) for x in args),'form_font_future_complex_clip_unsupported')
            x,y,w,h=map(float,args);require(w>0 and h>0,'form_font_future_clip_invalid');path=(x,y,x+w,y+h)
        elif op in (b'W',b'W*'):
            require(path is not None,'form_font_future_nonrectangular_clip_unsupported')
            clip=(max(clip[0],path[0]),max(clip[1],path[1]),min(clip[2],path[2]),min(clip[3],path[3]))
            require(clip[0]<clip[2] and clip[1]<clip[3],'form_font_future_empty_clip');path=None
        elif op in (b'n',b'f',b'f*',b'S',b's',b'B',b'B*',b'b',b'b*'):path=None
        elif op in (b'm',b'l',b'c',b'v',b'y',b'h',b'gs',b'Do',b'BI'):
            raise v.InspectionError('form_font_future_complex_clip_unsupported')
        elif op in (b'Tj',b'TJ',b"'",b'"'):clips.append(clip)
    require(not stack and clips and len(set(clips))==1,'form_font_future_clip_scope_unsupported')
    return clips[0]


def verify_future_fills(before_data, after_data, source_rows):
    """Regenerate appearances in memory; inspect persisted Unicode and bounds."""
    original=PdfReader(io.BytesIO(after_data),strict=True);fields=labels._owners(original)
    require(len(fields)<=20,'form_font_fill_widget_limit')
    unicode_to_code={row['unicode']:row['code'] for row in source_rows}
    scenarios=[('extended-latin-and-ligatures','Élodie €125 “A–B” ﬁ ﬂ'),
               ('permitted-future-widths','Symbols: ¯ ± µ · ÷ 1⁄2')]
    reports=[]
    for scenario,text in scenarios:
        require(all(ord(c) in unicode_to_code for c in text),'form_font_fill_test_encoding_unavailable')
        values={};seen=set()
        for field,_ in fields.values():
            path='.'.join(field['path'])
            if path in seen:continue
            seen.add(path)
            require(len(field['widgets'])==1,'form_font_future_multiple_widgets_unsupported')
            if field['type']=='/Tx':
                require(not(field['flags'] & (4096|8192|16777216|33554432)),'form_font_future_text_mode_unsupported')
                maximum=field['node'].get('/MaxLen',1000)
                require(v.integer(maximum) is not None and len(text)<=int(maximum),'form_font_fill_text_exceeds_maxlen')
                values[path]=text
            elif field['type']=='/Ch':
                options=field['options'];require(isinstance(options,list) and options and all(isinstance(x,str) for x in options),
                                                'form_font_future_choice_unsupported')
                values[path]=str(options[-1])
            else:
                require(not(field['flags']&(32768|65536)),'form_font_future_button_unsupported')
                key=field['widgets'][0];widget=fields[key][1]
                states=v.resolved(v.resolved(widget['/AP'])['/N'])
                active=[str(name) for name in states if str(name)!='/Off']
                require(len(active)==1,'form_font_future_checkbox_state_ambiguous')
                values[path]=active[0] if field['value']=='/Off' else '/Off'
        generated=[_fill_bytes(data,values) for data in (before_data,after_data)]
        readers=[PdfReader(io.BytesIO(data),strict=True) for data in generated]
        mappings=[labels._owners(reader) for reader in readers]
        per_widget=[]
        for key,(field,widget) in fields.items():
            pair=[mapping[key] for mapping in mappings]
            name='.'.join(field['path']);expected=values[name]
            require(all(saved['type']==field['type'] and saved['flags']==field['flags']
                        and saved['path']==field['path'] and saved['options']==field['options']
                        and str(saved['value'])==expected and saved['defaultValue']==field['defaultValue']
                        for saved,_ in pair),'form_font_future_field_semantics_changed')
            if field['type']=='/Btn':
                require(all(str(w.get('/AS'))==expected and v.Canonicalizer().hash(w['/AP'])==v.Canonicalizer().hash(widget['/AP'])
                            for _,w in pair),'form_font_future_checkbox_appearance_changed')
                per_widget.append({'pageNumber':key[0],'annotationIndex':key[1],'fieldPath':list(field['path']),
                                   'fieldType':'Btn','value':expected,'stateAppearanceRetained':True})
                continue
            aps=[v.resolved(w['/AP']['/N']) for _,w in pair]
            projected=[appearance_projection(r,ap) for r,ap in zip(readers,aps)]
            chars=[_projection_characters(data) for data in projected]
            actual=[''.join(chr(c['codepoint']) for c in items if not c['generated']) for items in chars]
            native_text=_saved_appearance_text(readers[1],aps[1])
            require(native_text==expected and actual[1]==expected.replace('\ufb01','fi').replace('\ufb02','fl'),
                    'form_font_future_saved_unicode_mismatch')
            # The legacy fallback renderer may map an Adobe glyph name to a
            # different Unicode alias. The new embedded ToUnicode must match
            # the exact submitted value; original code mapping is separately
            # proved for every defined code above.
            visible=[c for c in chars[1] if not c['generated'] and not chr(c['codepoint']).isspace()]
            box=_appearance_text_clip(readers[1],aps[1])
            require(all(c['box'][0]>=box[0] and c['box'][1]>=box[1] and c['box'][2]<=box[2] and c['box'][3]<=box[3]
                        for c in visible),'form_font_future_text_clipped')
            old_lines=sorted({round(c['origin'][1],2) for c in chars[0] if not c['generated']})
            new_lines=sorted({round(c['origin'][1],2) for c in chars[1] if not c['generated']})
            require(len(old_lines)==len(new_lines)==1 and abs(old_lines[0]-new_lines[0])<=.1,
                    'form_font_future_line_layout_changed')
            old_words,new_words=map(font_check.words,chars)
            require(len(old_words)==len(new_words),'form_font_future_word_count_changed')
            font_check.verify_word_collisions(old_words,new_words)
            resources=v.resolved(aps[1]['/Resources']['/Font'])
            for saved_font in resources.values():
                saved_font=v.resolved(saved_font);descriptor=v.resolved(saved_font.get('/FontDescriptor',{}))
                program=v.resolved(descriptor.get('/FontFile2'))
                require(saved_font.get('/BaseFont')=='/'+FONT_NAME and isinstance(program,StreamObject)
                        and v.digest(program.get_data())==FONT_SHA256,'form_font_future_fallback_font_used')
            per_widget.append({'pageNumber':key[0],'annotationIndex':key[1],'fieldPath':list(field['path']),
                               'fieldType':field['type'][1:],'value':expected,'savedAppearanceText':native_text,
                               'rendererText':actual[1],'rendererExpandsFiFlLigatures':True,
                               'effectiveTextClip':list(box),
                               'lineCount':len(new_lines),'textContained':True,'newWordOverlap':False,
                               'legacyFallbackText':actual[0],'exactFutureCharacterOriginsClaimed':False})
        # Render initialized states too: this checks that generated widget APs
        # can be displayed in a real renderer, without flattening the document.
        for data in generated:
            document=pdfium.PdfDocument(data);document.init_forms()
            try:
                for i in range(len(document)):
                    page=document[i]
                    try:
                        bitmap=page.render(scale=1,draw_annots=True,may_draw_forms=True);bitmap.close()
                    finally:page.close()
            finally:document.close()
        reports.append({'case':scenario,'widgets':per_widget,'initializedFormsRendered':True,
                        'savedAsInteractiveForm':bool(readers[1].root_object.get('/AcroForm')),
                        'filler':'pypdf','fillerAppearanceLimit':'Regenerates text-field appearance styling on both source and repaired copies; the delivered PDF retains the original saved appearance programs.'})
    return reports


def verify_retained_filler_boundaries(before_data,after_data):
    """Make preexisting fixed-field clipping visible rather than claiming all fills fit."""
    reader=PdfReader(io.BytesIO(after_data),strict=True)
    options=[(key,field) for key,(field,_) in labels._owners(reader).items() if field['type']=='/Tx']
    require(bool(options),'form_font_boundary_text_field_required')
    key,field=options[0];name='.'.join(field['path']);reports=[]
    for case,value in [('leading-standalone-macron','¯'),('fixed-field-overflow','W'*20)]:
        bounds=[];clip_characters=[];all_chars=[];all_clips=[]
        for data in (before_data,after_data):
            filled=PdfReader(io.BytesIO(_fill_bytes(data,{name:value})),strict=True)
            widget=labels._owners(filled)[key][1];ap=v.resolved(widget['/AP']['/N'])
            clip=_appearance_text_clip(filled,ap)
            chars=_projection_characters(appearance_projection(filled,ap))
            visible=[c for c in chars if not c['generated'] and not chr(c['codepoint']).isspace()]
            require(bool(visible),'form_font_boundary_text_missing')
            all_chars.append(visible);all_clips.append(clip)
            clipped={}
            for index,char in enumerate(visible):
                box=char['box'];edges=[clip[0]-box[0],clip[1]-box[1],box[2]-clip[2],box[3]-clip[3]]
                sides={side for side,value in enumerate(edges) if value>.02}
                if sides:clipped[index]=sides
            clip_characters.append(clipped)
            overflow=[max(0.,max(clip[0]-c['box'][0] for c in visible)),
                      max(0.,max(clip[1]-c['box'][1] for c in visible)),
                      max(0.,max(c['box'][2]-clip[2] for c in visible)),
                      max(0.,max(c['box'][3]-clip[3] for c in visible))]
            bounds.append(overflow)
        require(font_check.max_delta(all_clips[0],all_clips[1])<=.02,'form_font_future_boundary_clip_changed')
        require(len(all_chars[0])==len(all_chars[1])
                and all(a['codepoint']==b['codepoint'] for a,b in zip(*all_chars)), 'form_font_boundary_characters_changed')
        require(all(index in clip_characters[0] and sides<=clip_characters[0][index]
                    for index,sides in clip_characters[1].items()),'form_font_future_new_boundary_clipping')
        max_outline_delta=0.
        for old,new in zip(*all_chars):
            delta=font_check.max_delta(old['box'],new['box']);max_outline_delta=max(max_outline_delta,delta)
            require(delta<=max(font_check.GLYPH_BOX_TOLERANCE_PT,old['size']*font_check.GLYPH_BOX_TOLERANCE_EM),
                    'form_font_boundary_outline_change_exceeded')
        reports.append({'case':case,'sampleValue':value,'fieldPath':list(field['path']),
                        'sourceOverflowPt':bounds[0],'repairedOverflowPt':bounds[1],
                        'sourceAlreadyClips':any(x>.02 for x in bounds[0]),
                        'repairedClips':any(x>.02 for x in bounds[1]),
                        'sourceClippedCharacterIndices':sorted(clip_characters[0]),
                        'repairedClippedCharacterIndices':sorted(clip_characters[1]),
                        'sameClippedCharacters':set(clip_characters[0])==set(clip_characters[1]),
                        'newClippedCharactersOrSides':False,'maxGlyphBoxEdgeDeltaPt':max_outline_delta,
                        'outlineDifferenceWithinVerifiedTolerance':True,
                        'interpretation':'A retained filler or fixed-control boundary, not a claim that arbitrary future input fits.'})
    return reports


def authorize_form_fonts(original, final, ledger):
    original,final=Path(original),Path(final)
    require(isinstance(ledger,dict) and ledger.get('schemaVersion')==1 and ledger.get('operation')=='native-form-fonts'
            and ledger.get('requiresFreshAudit') is True and ledger.get('certification') is False,'form_font_ledger_invalid')
    require(set(ledger)==LEDGER_KEYS | ({'evaluationStage'} if 'evaluationStage' in ledger else set()),'form_font_ledger_keys_invalid')
    if 'evaluationStage' in ledger:
        return _authorize_staged_evaluation(original,final,ledger)
    source,source_hash=labels._snapshot(original);after,output_hash=labels._snapshot(final)
    before_path=Path(ledger['inputPath']);before,input_hash=labels._snapshot(before_path)
    require(original.resolve()==Path(ledger['sourcePath']).resolve() and before_path.resolve()!=final.resolve()
            and (source_hash,input_hash,output_hash)==(ledger.get('sourceSha256'),ledger.get('inputSha256'),ledger.get('outputSha256')),
            'form_font_file_binding_mismatch')
    require(ledger.get('authorization')=={'fontSubstitution':True,'glyphAppearanceMayChange':True,'futureInputMetricDifferences':True},
            'form_font_explicit_authorization_required')
    prior_ledger=_read_json(ledger['orderLedgerPath'],ledger['orderLedgerSha256'])
    prior=compare_with_authorized_form_order(original,before_path,prior_ledger)
    require(prior.get('passed') is True,'form_font_prior_repairs_unverified')
    provenance=ledger.get('fontSource',{})
    require(isinstance(provenance,dict) and set(provenance)==FONT_SOURCE_KEYS
            and provenance.get('sha256')==provenance.get('programSha256')==FONT_SHA256
            and provenance.get('postscriptName')==FONT_NAME and provenance.get('releaseUrl')==FONT_URL
            and provenance.get('license')=='OFL-1.1','form_font_provenance_not_approved')
    font_path=Path(provenance['path']);require(font_path.is_file() and font_path.stat().st_size<=2000000,'form_font_program_size_limit')
    font_data=font_path.read_bytes();require(v.digest(font_data)==FONT_SHA256,'form_font_unapproved_source_program')
    entries=ledger.get('substitutions')
    require(isinstance(entries,list) and 1<=len(entries)<=64
            and all(isinstance(row,dict) and set(row)==SUBSTITUTION_KEYS for row in entries),'form_font_substitution_limit')
    paths=[row.get('resourcePath') for row in entries]
    require(all(isinstance(path,str) for path in paths) and len(set(paths))==len(paths),'form_font_duplicate_or_invalid_path')
    old_slots,new_slots=font_slots(before),font_slots(after)
    require(set(old_slots)==set(new_slots) and all(path in old_slots for path in paths),'form_font_resource_paths_changed')
    changed={path for path in old_slots if labels.ExactGraph([]).hash(old_slots[path]['font'])!=labels.ExactGraph([]).hash(new_slots[path]['font'])}
    require(changed==set(paths),'form_font_unlisted_or_unchanged_substitution')
    proof=[]
    for entry in entries:
        path=entry['resourcePath'];a,b=old_slots[path],new_slots[path]
        codes=original_used_codes(a,before)
        require(codes==original_used_codes(b,after),'form_font_appearance_character_codes_changed')
        proof.append(dict(validate_form_font_pair(a['font'],b['font'],entry,font_data,codes),resourcePath=path))
    before_data=before_path.read_bytes();after_data=final.read_bytes()
    layout=verify_form_layout(before_data,after_data,before,after,set(paths))
    saved_evidence=labels._saved_widget_evidence(labels._owners(after),labels._native_forms(after,required=True))
    future=verify_future_fills(before_data,after_data,original_encoding(old_slots[paths[0]]['font'])[0])
    boundaries=verify_retained_filler_boundaries(before_data,after_data)
    _restore_exact_font_slots(before,after,set(paths))
    for path,sha in ((original,source_hash),(before_path,input_hash),(final,output_hash),
                     (Path(ledger['orderLedgerPath']),ledger['orderLedgerSha256']),(font_path,FONT_SHA256)):
        require(v.digest(path.read_bytes())==sha,'form_font_input_changed_during_check')
    return {'passed':True,'checksComplete':True,'sourceSha256':source_hash,'inputSha256':input_hash,'outputSha256':output_hash,
            'substitutions':proof,'layout':layout,'futureFillTests':future,'retainedFillerBoundaryTests':boundaries,
            'widgetEvidence':saved_evidence,
            'allOtherNativeObjectsUnchanged':True,'priorOrderLedgerSha256':ledger['orderLedgerSha256'],
            'requiresFreshAudit':True,'certification':False},prior


def _authorize_staged_evaluation(original, final, ledger):
    stage=ledger['evaluationStage']
    require(isinstance(stage,dict) and set(stage)=={'rawCandidatePath','rawCandidateSha256','rawLedgerPath','rawLedgerSha256','evaluationOnly'}
            and stage['evaluationOnly'] is True,'form_font_evaluation_stage_invalid')
    raw_ledger=_read_json(stage['rawLedgerPath'],stage['rawLedgerSha256'])
    require('evaluationStage' not in raw_ledger and ledger==dict(raw_ledger,outputSha256=ledger['outputSha256'],evaluationStage=stage)
            and raw_ledger['outputSha256']==stage['rawCandidateSha256'],'form_font_evaluation_ledger_changed')
    raw_path=Path(stage['rawCandidatePath'])
    require(raw_path.resolve()!=Path(final).resolve(),'form_font_evaluation_new_output_required')
    before,before_hash=labels._snapshot(raw_path);after,after_hash=labels._snapshot(final)
    require(before_hash==stage['rawCandidateSha256'] and after_hash==ledger['outputSha256'],'form_font_evaluation_hash_mismatch')
    prior=compare_with_authorized_form_fonts(original,raw_path,raw_ledger)
    require(prior.get('passed') is True,'form_font_raw_evaluation_not_verified')
    old_metadata=v.resolved(before.root_object.get('/Metadata'));new_metadata=v.resolved(after.root_object.get('/Metadata'))
    require(isinstance(old_metadata,StreamObject) and isinstance(new_metadata,StreamObject),'form_font_evaluation_metadata_missing')
    old_data,new_data=old_metadata.get_data(),new_metadata.get_data()
    require(len(old_data)<=256000 and old_data.count(b'</rdf:RDF>')==1 and b'pdfuaid' not in old_data
            and b'http://www.aiim.org/pdfua/ns/id/' not in old_data,'form_font_evaluation_existing_or_unsupported_declaration')
    declaration=(b'<rdf:Description xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" '
                 b'xmlns:pdfuaid="http://www.aiim.org/pdfua/ns/id/" rdf:about=""><pdfuaid:part>1</pdfuaid:part></rdf:Description>')
    require(new_data==old_data.replace(b'</rdf:RDF>',declaration+b'</rdf:RDF>'),
            'form_font_evaluation_metadata_not_exact_addition')
    stream_keys=lambda value:{key:item for key,item in value.items() if key not in ('/Length','/Filter','/DecodeParms')}
    require(labels.ExactGraph([]).hash(stream_keys(old_metadata))==labels.ExactGraph([]).hash(stream_keys(new_metadata)),
            'form_font_evaluation_metadata_dictionary_changed')
    after.root_object[NameObject('/Metadata')]=old_metadata
    require(labels._document_graph(before)==labels._document_graph(after),'form_font_evaluation_unlisted_native_change')
    require(labels.initialized_form_pixels(raw_path)==labels.initialized_form_pixels(final),'form_font_evaluation_pixels_changed')
    for path,expected in ((raw_path,before_hash),(Path(final),after_hash),(Path(stage['rawLedgerPath']),stage['rawLedgerSha256'])):
        require(v.digest(path.read_bytes())==expected,'form_font_evaluation_input_changed_during_check')
    checked=copy.deepcopy(prior['form_font_validation'])
    checked.update(outputSha256=after_hash,evaluationStage={'rawCandidateSha256':before_hash,
                   'rawLedgerSha256':stage['rawLedgerSha256'],'exactUa1MetadataAdditionVerified':True,
                   'allOtherNativeObjectsUnchanged':True,'pixelsIdentical':True,'evaluationOnly':True})
    return checked,prior


def compare_with_authorized_form_fonts(original, final, ledger):
    report=v.compare_pdfs(Path(original),Path(final))
    evidence={'passed':False,'checksComplete':False,'findings':[],'certification':False}
    report['form_font_validation']=evidence
    try:
        require(not report.get('inspection_incomplete'),'form_font_strict_inspection_incomplete')
        checked,prior=authorize_form_fonts(original,final,ledger);evidence.update(checked)
        labels_explained=prior['form_label_validation']['strictFindingsExplainedByAuthoredLabels']
        allowed={'catalog_behavior_changed','page_properties_changed','resources_changed','fonts_changed','page_pixels_changed'}
        explained=[f for f in report['findings'] if f in labels_explained or f['code'] in allowed]
        report['findings']=[f for f in report['findings'] if f not in explained]
        evidence['strictFindingsExplainedByVerifiedChain']=explained
        for key in ('form_label_validation','form_order_validation'):
            report[key]=copy.deepcopy(prior[key]);report[key]['widgetEvidence']=checked['widgetEvidence']
            report[key]['evidenceAppliesToOutputSha256']=checked['outputSha256']
        report['structure']['authored_alternative_associations_verified']=prior['structure']['authored_alternative_associations_verified']
        report['preservation'].update(authorized_form_labels_verified=True,authorized_form_reading_order_verified=True,
                                      authorized_form_fonts_verified=True,passed=not report['findings'])
        report['mechanical_checks_passed']=report['preservation']['passed'] and report['structure'].get('passed',False)
        report['passed']=(report['mechanical_checks_passed'] and report['structure'].get('checks_complete',False)
                          and not report['structure'].get('findings') and report['structure']['authored_alternative_associations_verified'])
    except Exception as error:
        evidence.update(passed=False,checksComplete=False)
        evidence['findings'].append({'severity':'error','code':str(error) if isinstance(error,v.InspectionError) else 'form_font_validation_failed'})
        report['passed']=report['mechanical_checks_passed']=report['preservation']['passed']=False
    return report
