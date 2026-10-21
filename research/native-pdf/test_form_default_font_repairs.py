import hashlib
import io
import json
from pathlib import Path
import tempfile
import unittest

from pypdf import PdfReader
from pypdf.generic import NameObject, NumberObject, TextStringObject

import form_default_font_repairs as r
from form_font_repairs import FONT_FILE_SHA256, encoding_map
from form_label_validation import _document_graph
from form_requirement_repairs import repair_optional_materials
from test_form_requirement_repairs import font_fixture


class FormDefaultFontRepairTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        config = Path(__file__).resolve().parents[4] / 'work/pdf-native-tools/toolchain.json'
        if not config.is_file(): raise unittest.SkipTest('Local pinned font toolchain unavailable')
        cls.font = Path(json.loads(config.read_text())['fontDirectory']) / 'LiberationSans-Regular.ttf'

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        self.source, embedded, fonts = font_fixture(self.directory, self.font)
        author = self.directory / 'author.json'
        author.write_text(json.dumps({'schemaVersion': 1, 'candidateSha256': r.sha(embedded),
            'fieldPath': ['materials'], 'tooltip': 'Send workshop materials', 'clearRequired': True}))
        self.input = self.directory / 'optional.pdf'
        ledger = repair_optional_materials(self.source, embedded, self.input, font_ledger=fonts,
            author_decision=author, expected_original_sha256=r.sha(self.source), expected_candidate_sha256=r.sha(embedded))
        self.ledger = self.directory / 'requirement.json'; self.ledger.write_text(json.dumps(ledger))
        self.output = self.directory / 'compatible.pdf'

    def repair(self, source_hash=None):
        return r.repair_unicode_form_defaults(self.source, self.input, self.output,
            requirement_ledger=self.ledger, expected_original_sha256=source_hash or r.sha(self.source),
            expected_candidate_sha256=r.sha(self.input))

    def test_saved_default_font_covers_original_repertoire_without_touching_appearances(self):
        from fontTools.ttLib import TTFont
        before_hashes = [r.sha(path) for path in (self.source, self.input, self.ledger)]
        ledger = self.repair(); before, after = PdfReader(self.input), PdfReader(self.output)
        source = PdfReader(self.source)
        entries, _ = encoding_map(source.root_object['/AcroForm']['/DR']['/Font']['/Helv'])
        font = after.root_object['/AcroForm']['/DR']['/Font']['/UniForm']
        self.assertEqual('/Type0', font['/Subtype']); self.assertEqual('/Identity-H', font['/Encoding'])
        descendant = font['/DescendantFonts'][0].get_object()
        embedded = descendant['/FontDescriptor']['/FontFile2'].get_data()
        self.assertEqual(FONT_FILE_SHA256, hashlib.sha256(embedded).hexdigest())
        parsed = TTFont(io.BytesIO(embedded)); cmap = parsed.getBestCmap()
        self.assertEqual('/Identity', descendant['/CIDToGIDMap'])
        widths = dict(zip(descendant['/W'][::2], descendant['/W'][1::2]))
        for entry in entries:
            point = entry['unicode']; glyph = cmap[point]
            gid = parsed.getGlyphID(glyph)
            self.assertEqual(round(parsed['hmtx'].metrics[glyph][0] * 1000 / parsed['head'].unitsPerEm), widths[gid][0])
            self.assertIn(f'<{gid:04X}> <{point:04X}>'.encode(), font['/ToUnicode'].get_data())
        self.assertEqual(len(entries), len(widths)); parsed.close()
        for old, new in zip(before.pages[0]['/Annots'], after.pages[0]['/Annots']):
            old, new = old.get_object(), new.get_object()
            if hasattr(old['/AP']['/N'], 'get_data'):
                self.assertEqual(old['/AP']['/N'].get_data(), new['/AP']['/N'].get_data())
            self.assertEqual(old['/Ff'], new['/Ff']); self.assertEqual(old['/V'], new['/V'])
        self.assertEqual(0, after.get_fields()['materials']['/Ff'])
        self.assertEqual(r._pixels(self.input.read_bytes()), r._pixels(self.output.read_bytes()))
        self.assertEqual(before_hashes, [r.sha(path) for path in (self.source, self.input, self.ledger)])
        # Undo exactly the declared DA references/new resource, independently of
        # font contents, to establish there were no appearance or native edits.
        fields = {field['/T']: field for field in (a.get_object() for a in after.pages[0]['/Annots'])}
        for record in ledger['defaultAppearances']:
            node = after.root_object['/AcroForm'] if record['target'] == 'document' else fields[record['fieldPath'][0]]
            self.assertEqual(record['beforeValue'].replace('/Helv', '/UniForm'), str(node['/DA']))
            node[NameObject('/DA')] = TextStringObject(record['beforeValue'])
        del after.root_object['/AcroForm']['/DR']['/Font']['/UniForm']
        self.assertEqual(_document_graph(before), _document_graph(after))

    def test_unapproved_or_missing_requirement_chain_rejected(self):
        ledger = json.loads(self.ledger.read_text()); ledger['outputSha256'] = '0' * 64
        self.ledger.write_text(json.dumps(ledger))
        with self.assertRaisesRegex(ValueError, 'verified_prior_requirement'): self.repair()
        self.assertFalse(self.output.exists())

    def test_existing_resource_alias_cannot_be_overwritten(self):
        reader = PdfReader(self.input); fonts = reader.root_object['/AcroForm']['/DR']['/Font']
        fonts[NameObject('/UniForm')] = fonts.raw_get('/Helv')
        with self.assertRaisesRegex(ValueError, 'new_unicode_default_font'): r._plan(reader)

    def test_da_rewrite_is_one_font_token_and_never_changes_size_or_color(self):
        value = TextStringObject(' /Helv 12 Tf  .1 .2 .3 rg ')
        self.assertEqual(' /UniForm 12 Tf  .1 .2 .3 rg ', r._da(value))
        for bad in ('/Other 12 Tf 0 g', '/Helv 12 Tf /Helv 9 Tf', '/Helv 12 Tf 1 Tr',
                    '/Helv 12 Tf /Unknown gs', '0 g', '/Helv 12 Tf (hidden text) Tj'):
            with self.subTest(value=bad), self.assertRaises(ValueError): r._da(TextStringObject(bad))

    def test_inherited_default_and_complex_field_modes_rejected(self):
        reader = PdfReader(self.input); field = reader.pages[0]['/Annots'][0].get_object()
        del field['/DA']
        with self.assertRaisesRegex(ValueError, 'simple_local_editable_field'): r._plan(reader)
        reader = PdfReader(self.input); field = reader.pages[0]['/Annots'][0].get_object()
        field[NameObject('/Ff')] = NumberObject(int(field['/Ff']) | 33554432)
        with self.assertRaisesRegex(ValueError, 'simple_local_editable_field'): r._plan(reader)

    def test_wrong_input_hash_and_output_overwrite_rejected(self):
        with self.assertRaisesRegex(ValueError, 'exact_input_hashes'): self.repair('0' * 64)
        self.repair(); saved = self.output.read_bytes()
        with self.assertRaisesRegex(ValueError, 'new_output'): self.repair()
        self.assertEqual(saved, self.output.read_bytes())


if __name__ == '__main__': unittest.main()
