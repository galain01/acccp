"""Exercise source-bound kernels through the real writer and saved verifier."""
import io
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from pypdf import PdfReader, PdfWriter
from pypdf.generic import NameObject

import worker
import native_structure_pipeline as pipeline
import bounded_semantic_structure as semantic
from test_bounded_table_structure import fixture as table_fixture, saved
from test_bounded_reading_order import fixture as reading_fixture
from test_bounded_semantic_structure import fixture as semantic_fixture
from test_bounded_chart_structure import fixture as chart_fixture, ALT


class StructurePipelineTests(unittest.TestCase):
    def sources(self):
        heading = semantic_fixture()[0]
        # The semantic fixture also carries an intentionally partial XFA packet
        # for low-level preservation tests; this worker test is a text PDF.
        heading.root_object.pop('/AcroForm', None)
        for page in heading.pages:
            page.pop('/Annots', None)
        return (('rebuild_table', table_fixture()),
                ('move_callout', reading_fixture()[0]),
                ('split_heading', heading),
                ('describe_chart', chart_fixture()[0]))

    def test_worker_applies_and_reopens_each_supported_structure(self):
        for kind, fixture in self.sources():
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as directory:
                source = PdfReader(io.BytesIO(saved(fixture)))
                inventory = worker.enrich_inventory(source, source)
                candidates = [item for item in inventory['structureCandidates'] if item['kind'] == kind]
                self.assertTrue(candidates)
                tags = {item['id']: item for item in inventory['tags']}
                operations = [{'type': 'repair_structure', 'tagId': item['tagId'],
                    'candidateId': item['candidateId'], 'expected': tags[item['tagId']]['snapshot'],
                    **({'role': 'H2'} if kind == 'split_heading' else {}),
                    **({'alt': ALT} if kind == 'describe_chart' else {})} for item in candidates]
                plan = {'schemaVersion': 1, 'candidateSha256': worker.digest(source.stream.getvalue()),
                        'operations': operations}
                lineage = {}
                output = Path(directory) / 'output.pdf'
                changes = worker.apply_plan(source, source, plan, output, lineage=lineage)
                after = PdfReader(io.BytesIO(output.read_bytes()))
                current = semantic.v.structure_inventory(after)
                self.assertTrue(any(item['code'] == kind for item in changes))
                self.assertEqual(len(lineage['sourceTagLineage']), len(inventory['tags']))
                self.assertEqual(len(lineage['sourceTagIds']), len(current['tags']))
                self.assertEqual(source.pages[0].extract_text(), after.pages[0].extract_text())

    def test_forged_candidate_and_overlapping_operation_are_rejected(self):
        source = PdfReader(io.BytesIO(saved(table_fixture())))
        candidate = pipeline.discover_candidates(source)[0]
        operation = {'type': 'repair_structure', 'tagId': candidate['tagId'], 'candidateId': candidate['candidateId']}
        for operations in ([{**operation, 'candidateId': 'a'*64}], [operation, operation]):
            with self.assertRaises(semantic.SemanticStructureError):
                pipeline.apply_operations(source, PdfWriter(clone_from=source), operations)

    def test_a_saved_reading_order_change_must_pass_its_specific_proof(self):
        source = PdfReader(io.BytesIO(saved(reading_fixture()[0])))
        candidate = pipeline.discover_candidates(source)[0]
        writer = PdfWriter(clone_from=source)
        result = pipeline.apply_operations(source, writer, [{'type': 'repair_structure',
            'tagId': candidate['tagId'], 'candidateId': candidate['candidateId']}])
        reopened = PdfReader(io.BytesIO(saved(writer)))
        pipeline.verify_saved(reopened, result['verification'])
        wrapper = next(item['node'] for item in result['lineage']
                       if str(item['node'].get('/S')) == '/Span')
        wrapper[NameObject('/S')] = NameObject('/P')
        with self.assertRaises(semantic.SemanticStructureError):
            pipeline.verify_saved(PdfReader(io.BytesIO(saved(writer))), result['verification'])

    def test_discovery_uses_one_reader_inspection_for_every_kernel(self):
        source = PdfReader(io.BytesIO(saved(table_fixture())))
        original = semantic.v.structure_inventory
        with patch.object(semantic.v, 'structure_inventory', wraps=original) as inspect:
            pipeline.discover_candidates(source)
        self.assertEqual(inspect.call_count, 1)


if __name__ == '__main__':
    unittest.main()
