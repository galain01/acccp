"""Small synthetic PDFs for native accessibility boundary tests.

These inputs are intentionally authored independently of the repair helpers.
Callers supply private temporary/output paths; no PDFs are stored in Git.
"""
from __future__ import annotations

import io
from pathlib import Path

from pypdf import PdfReader, PdfWriter
from pypdf.generic import (ArrayObject, BooleanObject, DecodedStreamObject,
    DictionaryObject, FloatObject, NameObject, NumberObject, TextStringObject)


def native_document():
    writer = PdfWriter()
    root = DictionaryObject({NameObject('/Type'): NameObject('/StructTreeRoot')})
    root_ref = writer._add_object(root)
    doc = DictionaryObject({NameObject('/Type'): NameObject('/StructElem'),
        NameObject('/S'): NameObject('/Document'), NameObject('/P'): root_ref})
    doc_ref = writer._add_object(doc)
    doc[NameObject('/K')] = ArrayObject()
    root[NameObject('/K')] = doc_ref
    root[NameObject('/ParentTree')] = DictionaryObject({NameObject('/Nums'): ArrayObject()})
    writer.root_object[NameObject('/StructTreeRoot')] = root_ref
    writer.root_object[NameObject('/Lang')] = TextStringObject('en-US')
    writer.root_object[NameObject('/MarkInfo')] = DictionaryObject({NameObject('/Marked'): BooleanObject(True)})
    return writer, root, doc


def stream(writer, raw):
    value = DecodedStreamObject()
    value.set_data(raw)
    return writer._add_object(value)


def font(writer):
    return writer._add_object(DictionaryObject({NameObject('/Type'): NameObject('/Font'),
        NameObject('/Subtype'): NameObject('/Type1'), NameObject('/BaseFont'): NameObject('/Helvetica')}))


def save(writer, path):
    with Path(path).open('xb') as target:
        writer.write(target)


def form_pages(path, *, reused=False, aliases=False):
    """Two pages with identically painted, separately owned leaf Forms.

    reused=True intentionally shares one semantic stream/ParentTree slot across
    pages; aliases=True also invokes it by a second resource name on page 1.
    Neither condition may be mistaken for independently owned content.
    """
    writer, root, doc = native_document()
    face = font(writer)
    form = None
    for index in range(2):
        page = writer.add_blank_page(240, 160)
        if form is None or not reused:
            asset = DecodedStreamObject()
            asset.set_data(b'/P <</MCID 0>> BDC BT /F1 12 Tf 10 25 Td (Shared-looking text) Tj ET EMC')
            asset.update({NameObject('/Type'): NameObject('/XObject'), NameObject('/Subtype'): NameObject('/Form'),
                NameObject('/BBox'): ArrayObject([NumberObject(v) for v in (0, 0, 220, 60)]),
                NameObject('/Resources'): DictionaryObject({NameObject('/Font'): DictionaryObject({NameObject('/F1'): face})}),
                NameObject('/StructParents'): NumberObject(index + 10)})
            form = writer._add_object(asset)
        resources = DictionaryObject({NameObject('/First'): form})
        raw = b'q 1 0 0 1 5 70 cm /First Do Q'
        if aliases and index == 0:
            resources[NameObject('/Alias')] = form
            raw += b' q 1 0 0 1 5 10 cm /Alias Do Q'
        page[NameObject('/Resources')] = DictionaryObject({NameObject('/XObject'): resources})
        page[NameObject('/Contents')] = stream(writer, raw)
        tag = DictionaryObject({NameObject('/Type'): NameObject('/StructElem'), NameObject('/S'): NameObject('/P'),
            NameObject('/P'): doc.indirect_reference, NameObject('/Pg'): page.indirect_reference,
            NameObject('/K'): DictionaryObject({NameObject('/Type'): NameObject('/MCR'), NameObject('/Pg'): page.indirect_reference,
                NameObject('/Stm'): form, NameObject('/MCID'): NumberObject(0)})})
        ref = writer._add_object(tag)
        doc['/K'].append(ref)
        if index == 0 or not reused:
            root['/ParentTree']['/Nums'].extend([NumberObject(index + 10), ArrayObject([ref])])
    save(writer, path)


def vector_figures(path, *, candidate=False, clip_width=35, shading_end=1):
    """A source chart uses curves, clipping, shading, text and authored language."""
    from test_figure_preservation import fixture
    writer = PdfWriter(clone_from=PdfReader(io.BytesIO(fixture(candidate=candidate))))
    page = writer.pages[0]
    function = DictionaryObject({NameObject('/FunctionType'): NumberObject(2),
        NameObject('/Domain'): ArrayObject([NumberObject(0), NumberObject(1)]),
        NameObject('/C0'): ArrayObject([NumberObject(0), NumberObject(0), NumberObject(1)]),
        NameObject('/C1'): ArrayObject([NumberObject(shading_end), NumberObject(0), NumberObject(0)]),
        NameObject('/N'): NumberObject(1)})
    page['/Resources'][NameObject('/Shading')] = DictionaryObject({NameObject('/Gradient'): writer._add_object(DictionaryObject({
        NameObject('/ShadingType'): NumberObject(2), NameObject('/ColorSpace'): NameObject('/DeviceRGB'),
        NameObject('/Coords'): ArrayObject([NumberObject(v) for v in (75, 100, 115, 100)]),
        NameObject('/Function'): function, NameObject('/Extend'): ArrayObject([BooleanObject(True), BooleanObject(True)])}))})
    raw = page.get_contents().get_data().replace(b'0 0 1 rg 80 100 10 20 re f 100 100 10 40 re f',
        f'q 75 95 {clip_width} 50 re W n /Gradient sh 0 0 0 RG 2 w 80 100 m 85 140 105 80 110 135 c S Q'.encode())
    page[NameObject('/Contents')] = stream(writer, raw)
    if not candidate:
        tags = [item.get_object() for item in writer.root_object['/StructTreeRoot']['/K'][0].get_object()['/K']]
        tags[1][NameObject('/Lang')] = TextStringObject('fr-FR')
        tags[1][NameObject('/Alt')] = TextStringObject('Carré rouge : fréquence ≥ 1.')
        tags[2][NameObject('/Lang')] = TextStringObject('ja-JP')
        tags[2][NameObject('/Alt')] = TextStringObject('曲線と色の変化を示すグラフ。')
        tags[2][NameObject('/ActualText')] = TextStringObject('グラフ：数値は 1 以上。')
    save(writer, path)


def three_tier_table(path, *, merged_data=False):
    """Repeated three-tier headers, a continuing category and two data pages."""
    writer, root, doc = native_document()
    face = font(writer)
    table = DictionaryObject({NameObject('/Type'): NameObject('/StructElem'), NameObject('/S'): NameObject('/Table'),
        NameObject('/P'): doc.indirect_reference, NameObject('/K'): ArrayObject()})
    table_ref = writer._add_object(table)
    doc['/K'].append(table_ref)
    headings = [[('Campus', 'TH', 3, 1), ('Measures', 'TH', 1, 4)],
        [('2024', 'TH', 1, 2), ('2025', 'TH', 1, 2)],
        [('Count', 'TH', 1, 1), ('Rate', 'TH', 1, 1), ('Count', 'TH', 1, 1), ('Rate', 'TH', 1, 1)]]
    data = [[*headings, [('Northern campuses', 'TD', 1, 5)],
        [('Oak', 'TD', 1, 1), ('10', 'TD', 1, 1), ('0.1', 'TD', 1, 1), ('20', 'TD', 1, 1), ('0.2', 'TD', 1, 1)]],
        [*headings, [('Pine', 'TD', 1, 1), ('30', 'TD', 1, 1), ('0.3', 'TD', 1, 1), ('40', 'TD', 1, 1), ('0.4', 'TD', 1, 1)],
        [('Fictional values; rates use a denominator of 100.', 'TD', 1, 5)]]]
    if merged_data:
        data[1][3] = [('Pine', 'TD', 1, 1), ('30 and 0.3', 'TD', 1, 2), ('40', 'TD', 1, 1), ('0.4', 'TD', 1, 1)]
    for page_index, rows in enumerate(data):
        page = writer.add_blank_page(540, 300)
        page[NameObject('/StructParents')] = NumberObject(page_index)
        page[NameObject('/Resources')] = DictionaryObject({NameObject('/Font'): DictionaryObject({NameObject('/F1'): face})})
        owners, commands = [], []
        for ri, cells in enumerate(rows):
            row = DictionaryObject({NameObject('/Type'): NameObject('/StructElem'), NameObject('/S'): NameObject('/TR'),
                NameObject('/P'): table_ref, NameObject('/K'): ArrayObject()})
            row_ref = writer._add_object(row)
            table['/K'].append(row_ref)
            # Geometry intentionally uses fixed authored cell positions; no repair
            # helper participates in layout or fixture construction.
            x = 10 if ri not in (1, 2) else 100
            for text, role, rs, cs in cells:
                cell = DictionaryObject({NameObject('/Type'): NameObject('/StructElem'), NameObject('/S'): NameObject('/' + role),
                    NameObject('/P'): row_ref, NameObject('/Pg'): page.indirect_reference})
                attrs = DictionaryObject({NameObject('/O'): NameObject('/Table')})
                if rs != 1: attrs[NameObject('/RowSpan')] = NumberObject(rs)
                if cs != 1: attrs[NameObject('/ColSpan')] = NumberObject(cs)
                if role == 'TH': attrs[NameObject('/Scope')] = NameObject('/Both')
                if len(attrs) > 1: cell[NameObject('/A')] = attrs
                cell_ref = writer._add_object(cell)
                paragraph = DictionaryObject({NameObject('/Type'): NameObject('/StructElem'), NameObject('/S'): NameObject('/P'),
                    NameObject('/P'): cell_ref, NameObject('/Pg'): page.indirect_reference, NameObject('/K'): NumberObject(len(owners))})
                ref = writer._add_object(paragraph)
                cell[NameObject('/K')] = ref
                row['/K'].append(cell_ref)
                commands.append(f'/P <</MCID {len(owners)}>> BDC BT /F1 9 Tf {x} {270-ri*45} Td ({text}) Tj ET EMC')
                owners.append(ref)
                x += 90 * cs
        page[NameObject('/Contents')] = stream(writer, '\n'.join(commands).encode('ascii'))
        root['/ParentTree']['/Nums'].extend([NumberObject(page_index), ArrayObject(owners)])
    save(writer, path)


def mapped_unicode_text(path):
    """One-byte CMap deliberately maps glyph codes to multiple Unicode scalars.

    This tests evidence decoding, not visual font coverage or conformance.
    It includes an astral character and a combining sequence, which must not be
    truncated or normalized away by filtered native-text extraction.
    """
    writer, root, doc = native_document()
    page = writer.add_blank_page(320, 200)
    face = font(writer)
    cmap = b'''/CIDInit /ProcSet findresource begin 12 dict begin begincmap
/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def
/CMapName /SyntheticUnicode def /CMapType 2 def
1 begincodespacerange <00> <ff> endcodespacerange
5 beginbfchar <41> <00c9> <42> <03bb> <43> <00650301> <44> <d83dde00> <45> <4f60> endbfchar
endcmap CMapName currentdict /CMap defineresource pop end end'''
    face.get_object()[NameObject('/ToUnicode')] = stream(writer, cmap)
    page[NameObject('/Resources')] = DictionaryObject({NameObject('/Font'): DictionaryObject({NameObject('/F1'): face})})
    page[NameObject('/StructParents')] = NumberObject(0)
    tag = DictionaryObject({NameObject('/Type'): NameObject('/StructElem'), NameObject('/S'): NameObject('/P'),
        NameObject('/P'): doc.indirect_reference, NameObject('/Pg'): page.indirect_reference,
        NameObject('/Lang'): TextStringObject('fr-FR'), NameObject('/K'): NumberObject(0)})
    ref = writer._add_object(tag)
    doc['/K'].append(ref)
    root['/ParentTree']['/Nums'].extend([NumberObject(0), ArrayObject([ref])])
    page[NameObject('/Contents')] = stream(writer,
        b'/P <</MCID 0>> BDC BT /F1 12 Tf 20 140 Td [(A) 120 (B C D E)] TJ ET EMC '
        b'/Artifact BMC BT /F1 12 Tf 20 40 Td (A B C D E) Tj ET EMC')
    save(writer, path)


MULTILINGUAL_PARAGRAPHS = [
    ('en-US', 'The result is at least 3; compare the values.'),
    ('fr-FR', 'Le café est ouvert : résultat supérieur ou égal à 3.'),
    ('el-GR', 'Η δοκιμή διατηρεί το ελληνικό κείμενο.'),
    ('ru-RU', 'Проверка сохраняет исходный русский текст.'),
]


def embedded_multilingual_text(path, font_path):
    """Real embedded glyphs plus independent native per-paragraph languages."""
    from reportlab.pdfgen import canvas
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont
    name = 'SyntheticAdversarialLiberation'
    face = TTFont(name, str(font_path))
    if any(ord(char) not in face.face.charToGlyph for _, text in MULTILINGUAL_PARAGRAPHS for char in text):
        raise ValueError('fixture_font_glyph_missing')
    pdfmetrics.registerFont(face)
    buffer = io.BytesIO()
    drawing = canvas.Canvas(buffer, pagesize=(520, 180))
    for _, text in MULTILINGUAL_PARAGRAPHS:
        drawing.setFont(name, 13)
        drawing.drawString(20, 100, text)
        drawing.showPage()
    drawing.save()
    visible = PdfReader(io.BytesIO(buffer.getvalue()))
    writer, root, doc = native_document()
    writer.add_metadata({'/Title': 'Multilingual preservation test'})
    for index, ((language, _), original) in enumerate(zip(MULTILINGUAL_PARAGRAPHS, visible.pages)):
        page = writer.add_page(original)
        page[NameObject('/StructParents')] = NumberObject(index)
        tag = DictionaryObject({NameObject('/Type'): NameObject('/StructElem'), NameObject('/S'): NameObject('/P'),
            NameObject('/P'): doc.indirect_reference, NameObject('/Pg'): page.indirect_reference,
            NameObject('/Lang'): TextStringObject(language), NameObject('/K'): NumberObject(0)})
        ref = writer._add_object(tag)
        doc['/K'].append(ref)
        root['/ParentTree']['/Nums'].extend([NumberObject(index), ArrayObject([ref])])
        page[NameObject('/Contents')] = stream(writer,
            b'/P <</MCID 0>> BDC\n' + page.get_contents().get_data() + b'\nEMC')
    save(writer, path)
