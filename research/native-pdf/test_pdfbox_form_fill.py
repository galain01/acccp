"""Saved-file editing regressions independent of a successful native /V write."""
import base64
import json
from pathlib import Path
import subprocess
import unittest

from pypdf import PdfReader, PdfWriter
from pypdf.generic import NameObject, TextStringObject

import pdfbox_form_fill as probe
import test_form_default_font_repairs as fixture_module


class PdfBoxFormFillTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        config=Path(__file__).resolve().parents[4]/'work/pdf-native-tools/toolchain.json'
        if not config.is_file():
            raise unittest.SkipTest('Pinned local Java/PDFBox toolchain unavailable')
        cls.config=json.loads(config.read_text(encoding='utf-8-sig'))
        cls.fixture=fixture_module.FormDefaultFontRepairTests()
        cls.fixture.setUpClass();cls.fixture.setUp();cls.fixture.repair()
        cls.addClassCleanup(cls.fixture.doCleanups)
        cls.root=cls.fixture.directory
        cls.classes=cls.root/'classes';cls.classes.mkdir()
        subprocess.run([cls.config['javac'],'-classpath',cls.config['pdfboxJar'],'-d',str(cls.classes),str(probe.JAVA_SOURCE)],check=True,capture_output=True,text=True,timeout=60)

    def fill(self,name,value,source=None,destination=None):
        values={'participant':value,'session':'Afternoon','materials':'Yes'}
        plan=self.root/(name+'.tsv')
        plan.write_text('\n'.join(base64.b64encode(k.encode()).decode()+'\t'+base64.b64encode(v.encode()).decode() for k,v in values.items()),encoding='utf-8')
        output=destination or self.root/(name+'.pdf')
        result=subprocess.run([self.config['java'],'-cp',self.config['pdfboxJar']+';'+str(self.classes),
            'FormFillProbe',str(source or self.fixture.output),str(output),str(plan)],capture_output=True,text=True,encoding='utf-8',timeout=30)
        report=json.loads(result.stdout) if result.stdout.strip() else None
        return result,report,output,values

    def test_reopened_accent_values_and_appearances_agree(self):
        original=probe.sha(self.fixture.output)
        process,report,output,values=self.fill('accents','Élodie Zoë Núñez')
        self.assertEqual(0,process.returncode,process.stderr)
        self.assertEqual([],probe.check_saved_report(report,values))
        self.assertTrue(probe.native_unchanged(self.fixture.output,output))
        self.assertEqual(original,probe.sha(self.fixture.output))

    def test_saved_value_alone_cannot_hide_wrong_to_unicode(self):
        reader=PdfReader(self.fixture.output)
        cmap=reader.root_object['/AcroForm']['/DR']['/Font']['/UniForm']['/ToUnicode']
        data=cmap.get_data()
        # Font GID36 is A. Change only its extracted meaning; /V remains A.
        self.assertIn(b'<0024> <0041>',data)
        cmap.set_data(data.replace(b'<0024> <0041>',b'<0024> <0042>'))
        bad=self.root/'wrong-unicode.pdf'
        with bad.open('xb') as handle:PdfWriter(clone_from=reader).write(handle)
        process,report,_,values=self.fill('wrong-unicode-fill','A',bad)
        self.assertEqual(0,process.returncode)
        self.assertEqual('A',report['fields'][0]['savedValue'])
        self.assertIn('participant:appearance_unicode_mismatch',probe.check_saved_report(report,values))

    def test_unsupported_character_has_no_partial_saved_file(self):
        process,report,output,_=self.fill('unsupported','漢字')
        self.assertNotEqual(0,process.returncode)
        self.assertEqual('refused_or_failed',report['status'])
        self.assertFalse(output.exists())

    def test_unrelated_catalog_behavior_change_is_not_hidden_by_successful_fill(self):
        process,report,output,values=self.fill('catalog','A')
        self.assertEqual([],probe.check_saved_report(report,values))
        reader=PdfReader(output)
        reader.root_object[NameObject('/Lang')]=TextStringObject('fr')
        altered=self.root/'catalog-altered.pdf'
        with altered.open('xb') as handle:PdfWriter(clone_from=reader).write(handle)
        self.assertFalse(probe.native_unchanged(self.fixture.output,altered))

    def test_overwrite_is_refused_without_changing_output(self):
        destination=self.root/'existing.pdf';destination.write_bytes(b'keep this exact file')
        process,_,_,_=self.fill('overwrite','A',destination=destination)
        self.assertNotEqual(0,process.returncode)
        self.assertEqual(b'keep this exact file',destination.read_bytes())

    def test_overflow_is_reported_and_not_silently_accepted_as_fit(self):
        process,report,_,values=self.fill('overflow','W'*20)
        self.assertEqual(0,process.returncode)
        self.assertIn('participant:unexpected_clipping',probe.check_saved_report(report,values))
        self.assertEqual([],probe.check_saved_report(report,values,expect_clipping=True))
        glyphs=report['fields'][0]['appearances'][0]['glyphs']
        self.assertEqual([19],[i for i,g in enumerate(glyphs) if g['inkClipped']])


if __name__=='__main__':unittest.main()
