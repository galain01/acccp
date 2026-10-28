"""Description checks need full annotation hashes only for actual additions."""
import io
import unittest
from unittest.mock import patch

from pypdf import PdfReader, PdfWriter
from pypdf.generic import NameObject as N, TextStringObject as S

import worker
from test_worker import link_bytes


def saved(writer):
    output = io.BytesIO()
    writer.write(output)
    return worker.open_pdf(output.getvalue())


class LinkInspectionWorkTests(unittest.TestCase):
    def test_no_added_description_needs_no_annotation_graph_hash(self):
        for existing in (None, '', 'An authored link label'):
            source = worker.open_pdf(link_bytes())
            if existing is not None:
                writer = PdfWriter(clone_from=source)
                writer.pages[0]['/Annots'][0].get_object()[N('/Contents')] = S(existing)
                source = saved(writer)
            candidate = PdfReader(io.BytesIO(source.stream.getvalue()), strict=True)
            with self.subTest(existing=existing), patch.object(worker, 'annotation_states') as hashes:
                worker.verify_added_link_descriptions(source, candidate)
            hashes.assert_not_called()
            self.assertEqual(source.stream.getvalue(), candidate.stream.getvalue())

    def test_ineligible_link_does_not_hash_unrelated_annotations(self):
        for label in ('click here', 'image'):
            reader = worker.open_pdf(link_bytes(label))
            with self.subTest(label=label), patch.object(worker, 'annotation_states') as hashes:
                self.assertEqual(worker.native_link_descriptions(reader), {})
            hashes.assert_not_called()

    def test_unapproved_addition_still_fails_the_independent_check(self):
        source = worker.open_pdf(link_bytes())
        writer = PdfWriter(clone_from=source)
        writer.pages[0]['/Annots'][0].get_object()[N('/Contents')] = S('An invented destination')
        with self.assertRaises(worker.WorkerError) as failure:
            worker.verify_added_link_descriptions(source, saved(writer))
        self.assertEqual(str(failure.exception), 'native_pdf_preservation')


if __name__ == '__main__':
    unittest.main()
