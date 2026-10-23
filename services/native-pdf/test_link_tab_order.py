"""Set a missing keyboard order only for fully tagged, link-only pages."""
import io
import tempfile
import unittest
from pathlib import Path

from pypdf import PdfReader, PdfWriter
from pypdf.generic import NameObject as N, NumberObject as I, TextStringObject

import worker
from test_bounded_reading_order import fixture, saved


class LinkTabOrderTests(unittest.TestCase):
    def test_worker_sets_and_verifies_structure_order_for_links(self):
        source = PdfReader(io.BytesIO(saved(fixture()[0])))
        plan = {'schemaVersion': 1, 'candidateSha256': worker.digest(source.stream.getvalue()), 'operations': []}
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / 'out.pdf'
            changes = worker.apply_plan(source, source, plan, output)
            after = PdfReader(io.BytesIO(output.read_bytes()))
        self.assertEqual(after.pages[0]['/Tabs'], '/S')
        self.assertTrue(any(item['code'] == 'link_tab_order' for item in changes))
        worker.verify_link_tab_order(source, after, [1], worker._DiscoveryInspection(after))
        after.pages[0][N('/Tabs')] = N('/R')
        with self.assertRaises(worker.WorkerError):
            worker.verify_link_tab_order(source, after, [1], worker._DiscoveryInspection(after))
        after.pages[0][N('/Tabs')] = TextStringObject('/S')
        with self.assertRaises(worker.WorkerError):
            worker.verify_link_tab_order(source, after, [1], worker._DiscoveryInspection(after))

    def test_authored_order_forms_and_unowned_links_are_ineligible(self):
        for alteration in ('order', 'widget', 'unowned'):
            with self.subTest(alteration=alteration):
                pdf, named = fixture()
                if alteration == 'order':
                    pdf.pages[0][N('/Tabs')] = N('/R')
                elif alteration == 'widget':
                    named['annotation'][N('/Subtype')] = N('/Widget')
                else:
                    named['annotation'][N('/StructParent')] = I(999)
                source = PdfReader(io.BytesIO(saved(pdf)))
                inspection = worker._DiscoveryInspection(source)
                self.assertEqual(worker.link_tab_order_pages(source, inspection.copy_for(source)), [])

    def test_preparation_cannot_drop_an_original_authored_tab_order(self):
        original_writer, _ = fixture()
        original_writer.pages[0][N('/Tabs')] = N('/R')
        original = PdfReader(io.BytesIO(saved(original_writer)))
        candidate_writer = PdfWriter(clone_from=original)
        del candidate_writer.pages[0]['/Tabs']
        candidate = PdfReader(io.BytesIO(saved(candidate_writer)))
        plan = {'schemaVersion': 1, 'candidateSha256': worker.digest(candidate.stream.getvalue()), 'operations': []}
        with tempfile.TemporaryDirectory() as directory, self.assertRaises(worker.WorkerError):
            worker.apply_plan(original, candidate, plan, Path(directory) / 'out.pdf')


if __name__ == '__main__':
    unittest.main()
