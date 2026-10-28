"""Skip source text extraction only when no native description can be hidden."""
import io
import unittest
from unittest.mock import patch

from pypdf import PdfReader, PdfWriter
from pypdf.generic import NameObject as N, TextStringObject as S

import worker
import bounded_semantic_structure as semantic
from test_native_pdf_validation import figure_reader, pdf_bytes


v = worker.verify_pdf
ABSENT = object()


def save(writer):
    stream = io.BytesIO()
    writer.write(stream)
    return PdfReader(io.BytesIO(stream.getvalue()), strict=True)


def vector_figure(*, alt=ABSENT, actual_text=ABSENT, ancestor=None):
    writer = PdfWriter(clone_from=figure_reader(kind='vector', alts=('image 1',)))
    document, figure = semantic.nodes(writer)
    if alt is ABSENT:
        figure.pop('/Alt')
    else:
        figure[N('/Alt')] = S(alt)
    if actual_text is not ABSENT:
        figure[N('/ActualText')] = S(actual_text)
    if ancestor is not None:
        name, value = ancestor
        document[N(name)] = S(value)
    return save(writer)


def prepared_candidate(original, mutation=None):
    writer = PdfWriter(clone_from=original)
    # A distinct saved version prevents accidental reuse based on identity or
    # equal bytes while retaining the Figure's exact painted content scope.
    writer.add_metadata({'/Title': 'Synthetic prepared candidate'})
    if mutation is not None:
        mutation(writer)
    return save(writer)


class WorkerDescriptionBudgetTests(unittest.TestCase):
    def enrichment(self, candidate, original):
        evidence = semantic._DiscoveryInspection(candidate)
        expected = worker.enrich_inventory(candidate, original, _inspection=evidence)
        original_bytes = original.stream.getvalue()
        candidate_bytes = candidate.stream.getvalue()
        with patch.object(v, 'structure_inventory', wraps=v.structure_inventory) as scan:
            actual = worker.enrich_inventory(candidate, original, _inspection=evidence)
        self.assertEqual(actual, expected)
        self.assertEqual(original.stream.getvalue(), original_bytes)
        self.assertEqual(candidate.stream.getvalue(), candidate_bytes)
        self.assertNotEqual(original_bytes, candidate_bytes)
        return actual, scan

    def test_source_without_any_native_description_is_not_reextracted(self):
        figure = vector_figure()
        no_tree = PdfWriter(clone_from=figure)
        no_tree.root_object.pop('/StructTreeRoot')
        no_tree.root_object.pop('/MarkInfo', None)
        originals = (
            ('absent source tree', save(no_tree), prepared_candidate(figure)),
            ('native Figure missing alternative', figure, prepared_candidate(figure)),
            ('native text only', PdfReader(io.BytesIO(pdf_bytes(tagged=True)), strict=True), None),
        )
        for label, original, candidate in originals:
            with self.subTest(source=label):
                candidate = prepared_candidate(original) if candidate is None else candidate
                actual, scan = self.enrichment(candidate, original)
                if label != 'native text only':
                    target = next(tag for tag in actual['tags'] if tag['role'] == 'Figure')
                    self.assertNotIn('alt', target)
                    self.assertTrue(target['editable']['alt'])
                    self.assertTrue(any(finding['code'] == 'missing_figure_alternative'
                                        for finding in actual['findings']))
                scan.assert_not_called()

    def test_useful_authored_figure_description_keeps_source_scan_and_protection(self):
        original = vector_figure(alt='A filled black rectangle with the visible label Label0.')
        for candidate_alt in ('A filled black rectangle with the visible label Label0.', 'image 1'):
            with self.subTest(candidate_alt=candidate_alt):
                candidate = prepared_candidate(original, lambda writer:
                    semantic.nodes(writer)[1].__setitem__(N('/Alt'), S(candidate_alt)))
                actual, scan = self.enrichment(candidate, original)
                target = next(tag for tag in actual['tags'] if tag['role'] == 'Figure')
                self.assertFalse(target['editable']['alt'])
                scan.assert_called_once_with(original)

    def test_actual_text_presence_keeps_protection_even_if_empty_or_removed_from_candidate(self):
        for value in ('Authored replacement wording', ''):
            original = vector_figure(alt='image 1', actual_text=value)
            for remove in (False, True):
                with self.subTest(value=value, removed_from_candidate=remove):
                    def prepare(writer):
                        if remove:
                            semantic.nodes(writer)[1].pop('/ActualText')
                    actual, scan = self.enrichment(prepared_candidate(original, prepare), original)
                    target = next(tag for tag in actual['tags'] if tag['role'] == 'Figure')
                    self.assertFalse(target['editable']['alt'])
                    scan.assert_called_once_with(original)

    def test_ancestor_alt_or_actual_text_including_empty_keeps_full_source_protection(self):
        for property_name in ('/Alt', '/ActualText'):
            for value in ('Authored surrounding meaning', ''):
                with self.subTest(property_name=property_name, value=value):
                    original = vector_figure(alt='image 1', ancestor=(property_name, value))
                    actual, scan = self.enrichment(prepared_candidate(original), original)
                    target = next(tag for tag in actual['tags'] if tag['role'] == 'Figure')
                    ancestor = next(tag for tag in actual['tags'] if tag['role'] == 'Document')
                    self.assertIn('alt' if property_name == '/Alt' else 'actualText', ancestor)
                    self.assertFalse(target['editable']['alt'])
                    scan.assert_called_once_with(original)

    def test_empty_or_generic_alt_is_present_evidence_but_still_obviously_repairable(self):
        for value in ('', 'image 1'):
            with self.subTest(value=value):
                original = vector_figure(alt=value)
                actual, scan = self.enrichment(prepared_candidate(original), original)
                target = next(tag for tag in actual['tags'] if tag['role'] == 'Figure')
                self.assertIn('alt', target)
                self.assertEqual(target['alt'], value)
                self.assertTrue(target['editable']['alt'])
                scan.assert_called_once_with(original)


if __name__ == '__main__':
    unittest.main()
