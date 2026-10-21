"""Independent saved-byte checks for the form-font permission and limits."""
import copy
import io
import json
import logging
import unittest
from unittest.mock import patch
from pathlib import Path

from pypdf import PdfReader, PdfWriter
from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject, NumberObject

import form_font_validation as f
import test_form_font_repairs as fixture_module
import verify_pdf as v
from conformance_repairs import stage_pdfua1_declaration


def add_fixture_metadata(fixture,ledger):
    """Give every synthetic chain stage the same authored metadata, then bind it."""
    order=json.loads(fixture.order.read_text());label_path=Path(order['labelLedgerPath'])
    labels=json.loads(label_path.read_text());audit_path=Path(order['auditPath'])
    audit=json.loads(audit_path.read_text())
    paths={fixture.original,Path(labels['inputPath']),Path(order['inputPath']),fixture.input,fixture.output}
    for path in paths:
        writer=PdfWriter(clone_from=path);stream=DecodedStreamObject()
        stream.set_data(b'<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/" rdf:about=""><dc:title>Original fictional form title</dc:title></rdf:Description></rdf:RDF></x:xmpmeta>')
        stream.update({NameObject('/Type'):NameObject('/Metadata'),NameObject('/Subtype'):NameObject('/XML')})
        writer.root_object[NameObject('/Metadata')]=writer._add_object(stream)
        with path.open('wb') as handle:writer.write(handle)
    digest=lambda path:v.digest(Path(path).read_bytes())
    labels.update(sourceSha256=digest(fixture.original),inputSha256=digest(labels['inputPath']),outputSha256=digest(order['inputPath']))
    label_path.write_text(json.dumps(labels),encoding='utf-8')
    audit.update(sourceSha256=digest(fixture.original),outputSha256=digest(order['inputPath']))
    audit_path.write_text(json.dumps(audit),encoding='utf-8')
    order.update(sourceSha256=digest(fixture.original),inputSha256=digest(order['inputPath']),outputSha256=digest(fixture.input),
                 labelLedgerSha256=digest(label_path),auditSha256=digest(audit_path))
    fixture.order.write_text(json.dumps(order),encoding='utf-8')
    ledger.update(sourceSha256=digest(fixture.original),inputSha256=digest(fixture.input),outputSha256=digest(fixture.output),
                  orderLedgerSha256=digest(fixture.order))


def stage_fixture(fixture,ledger):
    add_fixture_metadata(fixture,ledger)
    raw_ledger=fixture.directory/'raw-font-ledger.json';raw_ledger.write_text(json.dumps(ledger),encoding='utf-8')
    staged=fixture.directory/'evaluation.pdf'
    stage_pdfua1_declaration(fixture.output,staged,expected_sha256=ledger['outputSha256'],evaluation_only=True)
    stage={'rawCandidatePath':str(fixture.output),'rawCandidateSha256':ledger['outputSha256'],
           'rawLedgerPath':str(raw_ledger),'rawLedgerSha256':v.digest(raw_ledger.read_bytes()),'evaluationOnly':True}
    return staged,dict(ledger,outputSha256=v.digest(staged.read_bytes()),evaluationStage=stage)


class FormFontValidationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        fixture_module.FormFontRepairTests.setUpClass()

    def setUp(self):
        self.fixture=fixture_module.FormFontRepairTests()
        self.fixture.setUp();self.addCleanup(self.fixture.doCleanups)
        self.ledger=self.fixture.repair()
        logging.getLogger('pypdf').setLevel(logging.ERROR)

    def check(self):
        return f.authorize_form_fonts(self.fixture.original,self.fixture.output,self.ledger)[0]

    def test_exact_saved_chain_current_geometry_and_future_values(self):
        hashes=[v.digest(path.read_bytes()) for path in (self.fixture.original,self.fixture.input,self.fixture.output)]
        result=self.check()
        self.assertTrue(result['passed']);self.assertEqual(3,len(result['substitutions']))
        for proof in result['substitutions']:
            self.assertEqual(229,proof['definedCodeCount']);self.assertEqual(5,len(proof['futureInputWidthDifferences']))
            self.assertTrue(proof['allUnicodeMappingsVerified']);self.assertTrue(proof['allDeclaredWidthsMatchProgram'])
        for appearance in result['layout']['appearanceLayouts']:
            self.assertEqual(0,appearance['layout'][0]['maxCharacterOriginDeltaPt'])
        self.assertEqual(0,result['layout']['pages'][0]['changedPixelsOutsideGlyphs'])
        for case in result['futureFillTests']:
            self.assertTrue(case['savedAsInteractiveForm'])
            for widget in case['widgets']:
                if widget['fieldType']!='Btn':
                    self.assertEqual(widget['value'],widget['savedAppearanceText'])
                    self.assertTrue(widget['textContained']);self.assertEqual(1,widget['lineCount'])
        self.assertEqual(hashes,[v.digest(path.read_bytes()) for path in (self.fixture.original,self.fixture.input,self.fixture.output)])

    def test_retained_filler_boundaries_are_explicit_and_not_universal_fit_claim(self):
        evidence=self.check()['retainedFillerBoundaryTests']
        self.assertEqual(['leading-standalone-macron','fixed-field-overflow'],[x['case'] for x in evidence])
        self.assertTrue(all(x['sourceAlreadyClips'] and x['repairedClips'] for x in evidence))
        self.assertTrue(all(x['sameClippedCharacters'] and not x['newClippedCharactersOrSides'] for x in evidence))

    def test_new_clipped_character_cannot_hide_behind_existing_overflow(self):
        before,after=self.fixture.input.read_bytes(),self.fixture.output.read_bytes()
        actual_fill=f._fill_bytes
        def altered(data,values):
            result=actual_fill(data,values)
            if data==after and values.get('participant')=='W'*20:
                writer=PdfWriter(clone_from=PdfReader(io.BytesIO(result)))
                ap=writer.pages[0]['/Annots'][0].get_object()['/AP']['/N']
                ap.set_data(ap.get_data().replace(b'2 7.',b'14 7.'))
                output=io.BytesIO();writer.write(output);result=output.getvalue()
            return result
        with patch.object(f,'_fill_bytes',side_effect=altered):
            with self.assertRaisesRegex(v.InspectionError,'future_new_boundary_clipping'):
                f.verify_retained_filler_boundaries(before,after)

    def test_default_encoding_is_standard_not_winansi_and_glyphs_are_not_renumbered(self):
        font=DictionaryObject({NameObject('/Type'):NameObject('/Font'),NameObject('/Subtype'):NameObject('/Type1'),
                               NameObject('/BaseFont'):NameObject('/Helvetica')})
        rows,_=f.original_encoding(font);mapping={row['code']:row for row in rows}
        self.assertEqual(0x2019,mapping[39]['unicode'])
        saved=f.font_slots(PdfReader(self.fixture.input))['AcroForm/DR/Font/Helv']['font']
        rows,_=f.original_encoding(saved);mapping={row['code']:row for row in rows}
        self.assertEqual(0x20ac,mapping[160]['unicode']);self.assertEqual(0xfb01,mapping[147]['unicode'])
        self.assertEqual(0xfb02,mapping[148]['unicode'])

    def test_current_font_change_codes_in_non_normal_appearance_are_read(self):
        reader=PdfReader(self.fixture.input);widget=reader.pages[0]['/Annots'][0].get_object()
        ap=widget['/AP']['/N'];rollover=DecodedStreamObject();rollover.update(dict(ap))
        rollover.set_data(b'BT /Helv 12 Tf 2 7 Td <AF> Tj ET')
        widget['/AP'][NameObject('/R')]=rollover
        slots=f.font_slots(reader);slot=slots['page/1/Annots/1/AP/R/Resources/Font/Helv']
        self.assertEqual([175],f.original_used_codes(slot,reader))

    def test_actual_rectangular_clip_is_tighter_than_bbox(self):
        data=f._fill_bytes(self.fixture.output.read_bytes(),{'participant':'Alex'})
        reader=PdfReader(io.BytesIO(data));ap=reader.pages[0]['/Annots'][0].get_object()['/AP']['/N']
        clip=f._appearance_text_clip(reader,ap)
        self.assertEqual((2.,1.,218.,23.),clip)
        ap.set_data(ap.get_data().replace(b'216.0',b'1.0'))
        narrow=f._appearance_text_clip(reader,ap)
        self.assertEqual(3.,narrow[2])
        chars=f._projection_characters(f.appearance_projection(reader,ap))
        self.assertTrue(any(c['box'][2]>narrow[2] for c in chars))

    def test_extra_authorization_or_schema_keys_fail_closed(self):
        for location in ('top','authorization','provenance','entry'):
            with self.subTest(location=location):
                ledger=copy.deepcopy(self.ledger)
                target={'top':ledger,'authorization':ledger['authorization'],'provenance':ledger['fontSource'],
                        'entry':ledger['substitutions'][0]}[location]
                target['allowAnything']=True
                with self.assertRaises(v.InspectionError):f.authorize_form_fonts(self.fixture.original,self.fixture.output,ledger)

    def test_stale_prior_chain_does_not_authorize_substitution(self):
        self.ledger['orderLedgerSha256']='0'*64
        with self.assertRaisesRegex(v.InspectionError,'prior_ledger_hash_mismatch'):self.check()

    def test_unused_page_font_alias_is_not_swept_into_form_permission(self):
        before,after=PdfReader(self.fixture.input),PdfReader(self.fixture.output)
        for reader in (before,after):
            reader.pages[0]['/Resources']['/Font'][NameObject('/HiddenAlias')]=reader.root_object['/AcroForm']['/DR']['/Font'].raw_get('/Helv')
        paths={entry['resourcePath'] for entry in self.ledger['substitutions']}
        with self.assertRaisesRegex(v.InspectionError,'unlisted_page_resource_change'):
            f._restore_exact_font_slots(before,after,paths)

    def test_stage_permits_exact_ua1_addition_and_keeps_raw_chain(self):
        staged,ledger=stage_fixture(self.fixture,self.ledger)
        raw=self.fixture.output.read_bytes()
        report=f.compare_with_authorized_form_fonts(self.fixture.original,staged,ledger)
        self.assertTrue(report['form_font_validation']['passed'],report['form_font_validation'])
        self.assertTrue(report['passed']);self.assertEqual(raw,self.fixture.output.read_bytes())
        self.assertTrue(report['form_font_validation']['evaluationStage']['exactUa1MetadataAdditionVerified'])

    def test_stage_cannot_repoint_raw_file_or_nest_stages(self):
        staged,ledger=stage_fixture(self.fixture,self.ledger)
        bad=copy.deepcopy(ledger);bad['evaluationStage']['rawCandidatePath']=str(self.fixture.input)
        with self.assertRaisesRegex(v.InspectionError,'evaluation_hash_mismatch'):
            f.authorize_form_fonts(self.fixture.original,staged,bad)
        raw_path=self.fixture.directory/'nested.json';raw_path.write_text(json.dumps(ledger))
        bad=copy.deepcopy(ledger);bad['evaluationStage'].update(rawLedgerPath=str(raw_path),rawLedgerSha256=v.digest(raw_path.read_bytes()))
        with self.assertRaisesRegex(v.InspectionError,'evaluation_ledger_changed'):
            f.authorize_form_fonts(self.fixture.original,staged,bad)


if __name__=='__main__':unittest.main()
