"""Exact saved bytes may share raw checks; caller dictionaries/readers may not."""
import base64
from collections import Counter
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from pypdf import PdfReader, PdfWriter
from pypdf.generic import NameObject, NumberObject, TextStringObject

import bounded_semantic_structure as semantic
import native_structure_pipeline as pipeline
import native_structure_repairs as ids
import worker
from test_native_pdf_validation import pdf_bytes
from test_bounded_table_structure import fixture, saved
from test_repair_inspection_budget import VALIDATION

v=worker.verify_pdf


class SavedPdfInspectionTests(unittest.TestCase):
    def setUp(self):
        temporary=tempfile.TemporaryDirectory();self.addCleanup(temporary.cleanup)
        self.folder=Path(temporary.name)
        self.source=self.folder/'source.pdf';self.output=self.folder/'output.pdf'
        self.source.write_bytes(pdf_bytes(tagged=False));self.output.write_bytes(pdf_bytes(tagged=True))

    def evidence(self):return v._PdfInspection(self.output.read_bytes())

    def test_capture_and_reuse_preserve_report_and_do_not_share_mutable_data(self):
        capture=v._PdfInspectionCapture()
        expected=v.compare_pdfs(self.source,self.output,_capture=capture)
        with patch.object(v,'structure_inventory',side_effect=AssertionError('unexpected rescan')):
            actual=v.compare_pdfs(self.source,self.output,_source_inspection=capture.source,_output_inspection=capture.output)
        self.assertEqual(actual,expected)
        expected['structure']['tags'].clear()
        snapshot=capture.output.copy_for(self.output.read_bytes())
        self.assertTrue(snapshot['tags'])
        self.assertNotIn('figure_counts',snapshot)
        snapshot['tags'].clear()
        self.assertTrue(capture.output.copy_for(self.output.read_bytes())['tags'])

    def test_raw_dict_writer_reader_and_subclass_cannot_supply_evidence(self):
        data=self.output.read_bytes()
        for value in ({'tags':[]},PdfReader(io.BytesIO(data)),PdfWriter(clone_from=PdfReader(io.BytesIO(data)))):
            with self.subTest(value=type(value).__name__),self.assertRaises(v.InspectionError):
                v._PdfInspection(value)
        class Fake(v._PdfInspection):pass
        for value in ({'tags':[]},Fake(data)):
            with self.subTest(value=type(value).__name__):
                report=v.compare_pdfs(self.source,self.output,_output_inspection=value)
                self.assertTrue(report['inspection_incomplete']);self.assertFalse(report['passed'])
                with self.assertRaises(semantic.SemanticStructureError):semantic._DiscoveryInspection._from_saved_pdf(value)

    def test_same_length_change_and_source_output_swap_are_rejected(self):
        capture=v._PdfInspectionCapture();v.compare_pdfs(self.source,self.output,_capture=capture)
        original=self.output.read_bytes()
        changed=original.replace(b'%PDF-1.3',b'%PDF-1.4',1)
        if changed==original:changed=original[:-1]+(b' ' if original[-1:]!=b' ' else b'\n')
        self.assertEqual(len(original),len(changed));self.assertNotEqual(original,changed)
        with self.assertRaises(v.InspectionError):capture.output.copy_for(changed)
        report=v.compare_pdfs(self.source,self.output,_source_inspection=capture.output,_output_inspection=capture.source)
        self.assertTrue(report['inspection_incomplete']);self.assertFalse(report['passed'])

    def test_new_bound_reader_cannot_reuse_another_or_mutated_exported_reader(self):
        evidence=self.evidence();changed=evidence.fresh_reader()
        semantic.nodes(changed)[1][NameObject('/S')]=NameObject('/H6')
        reader,inspection=semantic._DiscoveryInspection._from_saved_pdf(evidence)
        self.assertNotEqual(semantic.nodes(reader)[1]['/S'],'/H6')
        self.assertNotEqual(inspection.copy_for(reader)['tags'][1]['role'],'H6')
        with self.assertRaises(semantic.SemanticStructureError):inspection.copy_for(changed)
        with self.assertRaises(semantic.SemanticStructureError):inspection.copy_for(evidence.fresh_reader())

    def test_pipeline_rediscovers_candidates_without_repeating_current_inspection(self):
        evidence=v._PdfInspection(saved(fixture()))
        reader,inspection=semantic._DiscoveryInspection._from_saved_pdf(evidence)
        candidate=pipeline.discover_candidates(reader,_inspection=inspection)[0]
        operation={'type':'repair_structure','tagId':candidate['tagId'],'candidateId':candidate['candidateId']}
        writer=PdfWriter(clone_from=reader)
        with patch.object(v,'structure_inventory',side_effect=AssertionError('unexpected rescan')):
            result=pipeline.apply_operations(reader,writer,[operation],_inspection=inspection)
        reopened=PdfReader(io.BytesIO(saved(writer)))
        self.assertTrue(pipeline.verify_saved(reopened,result['verification']) is None)
        with self.assertRaises(semantic.SemanticStructureError):
            pipeline.apply_operations(evidence.fresh_reader(),PdfWriter(clone_from=reader),[operation],_inspection=inspection)

    def test_exact_process_scans_each_tagged_version_once_and_still_compares_twice(self):
        candidate=self.output.read_bytes();source=self.source.read_bytes()
        request=self.folder/'request.json'
        request.write_text(json.dumps({'sourcePdfBase64':base64.b64encode(source).decode(),
            'candidatePdfBase64':base64.b64encode(candidate).decode(),
            'plan':{'schemaVersion':1,'candidateSha256':worker.digest(candidate),'operations':[]}}))
        folder=self.folder/'job';folder.mkdir();counts=Counter();scan=v.structure_inventory
        def measured(reader):
            counts[worker.digest(reader.stream.getvalue())]+=1
            return scan(reader)
        with patch.object(v,'structure_inventory',side_effect=measured),patch.object(ids,'structure_inventory',side_effect=measured), \
             patch.object(v,'compare_pdfs',wraps=v.compare_pdfs) as compare,patch.object(worker,'validate_ua',return_value=VALIDATION):
            result=worker.process('repair',request,folder,{})
        self.assertEqual(counts[worker.digest(candidate)],1)
        self.assertEqual(counts[result['candidateSha256']],1)
        self.assertEqual(compare.call_count,2)
        self.assertTrue(result['machineChecks']['preservationPassed'])

    def test_reused_inventory_does_not_skip_paint_or_authored_replacement_checks(self):
        source_writer=PdfWriter(clone_from=PdfReader(io.BytesIO(pdf_bytes(tagged=True))))
        semantic.nodes(source_writer)[1][NameObject('/ActualText')]=TextStringObject('Original replacement')
        self.source.write_bytes(saved(source_writer))
        for mutation in ('replacement','paint'):
            writer=PdfWriter(clone_from=PdfReader(self.source))
            if mutation=='replacement':semantic.nodes(writer)[1][NameObject('/ActualText')]=TextStringObject('Changed replacement')
            else:
                page=writer.pages[0];content=page.get_contents()
                content.operations.insert(0,([NumberObject(value) for value in (2,0,0,2,0,0)],b'cm'))
                page[NameObject('/Contents')]=writer._add_object(content)
            self.output.write_bytes(saved(writer));evidence=self.evidence()
            with self.subTest(mutation=mutation),patch.object(v,'compare_figure_associations',wraps=v.compare_figure_associations) as figures, \
                 patch.object(v,'compare_actual_text_associations',wraps=v.compare_actual_text_associations) as actual:
                report=v.compare_pdfs(self.source,self.output,_output_inspection=evidence)
                self.assertFalse(report['preservation']['passed']);self.assertTrue(report['findings'])
                figures.assert_called_once();actual.assert_called_once()

    def test_changed_file_during_comparison_never_retains_success_flag(self):
        actual=v.compare_actual_text_associations
        def mutate(*args,**kwargs):
            result=actual(*args,**kwargs)
            self.output.write_bytes(self.output.read_bytes()+b'\n')
            return result
        with patch.object(v,'compare_actual_text_associations',side_effect=mutate):
            report=v.compare_pdfs(self.source,self.output,_output_inspection=self.evidence())
        self.assertTrue(report['inspection_incomplete']);self.assertFalse(report['passed'])
        self.assertFalse(report['preservation']['passed'])


if __name__=='__main__':unittest.main()
