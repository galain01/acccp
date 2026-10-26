"""Preserve existing broken navigation while repairing unrelated PDF content."""
import io
from pathlib import Path
import tempfile
import unittest

from pypdf import PdfReader, PdfWriter
from pypdf.generic import ArrayObject, DictionaryObject, NameObject as N, TextStringObject as S
import verify_pdf as v
from test_native_pdf_validation import named_link_reader


def saved(writer):
    stream = io.BytesIO()
    writer.write(stream)
    return stream.getvalue()


def edit(reader, callback):
    writer = PdfWriter(clone_from=reader)
    callback(writer)
    return PdfReader(io.BytesIO(saved(writer)))


class NavigationPreservationTests(unittest.TestCase):
    def compare(self, before, after):
        with tempfile.TemporaryDirectory() as directory:
            source, output = Path(directory) / 'source.pdf', Path(directory) / 'output.pdf'
            source.write_bytes(before.stream.getvalue())
            output.write_bytes(after.stream.getvalue())
            return v.compare_pdfs(source, output)

    def test_unrelated_duplicate_does_not_disable_unique_destination(self):
        def change(writer):
            values = writer.root_object['/Names']['/Dests']['/Kids'][0].get_object()['/Names']
            values.extend([S('unique'), ArrayObject([writer.pages[0].indirect_reference, N('/Fit')])])
            writer.pages[0]['/Annots'][0].get_object()['/A'][N('/D')] = S('unique')
        info = v.structure_inventory(edit(named_link_reader(duplicate=True), change))
        objr = next(tag for tag in info['tags'] if tag['role'] == 'Link')['contentSequence'][0]
        self.assertTrue(objr['destinationResolved'], info['findings'])
        self.assertTrue(info['checks_complete'], info['findings'])

    def test_inspected_missing_and_ambiguous_targets_warn_without_blocking_inspection(self):
        for options in ({'missing': True}, {'duplicate': True}, {'broken_page': True}):
            with self.subTest(options=options):
                info = v.structure_inventory(named_link_reader(**options))
                self.assertTrue(info['checks_complete'], info['findings'])
                self.assertTrue(info['machine_checks_passed'])
                self.assertTrue(info['navigation_checks_complete'])
                self.assertEqual(info['unresolved_local_destinations'], 1)
                issue = info['navigation_findings'][0]
                self.assertEqual(issue['annotationId'], 'p1-a1')
                self.assertEqual(issue['page'], 1)
                self.assertEqual(issue['severity'], 'warning')
                self.assertTrue(issue['message'])

    def test_unrelated_repair_preserves_broken_links_and_reports_original_problem(self):
        source = named_link_reader(missing=True)
        output = edit(source, lambda writer: writer.root_object.__setitem__(N('/Lang'), S('en-GB')))
        report = self.compare(source, output)
        self.assertTrue(report['preservation']['passed'], report['findings'])
        self.assertTrue(report['structure']['checks_complete'])
        self.assertTrue(report['navigation']['passed'])
        self.assertEqual(len(report['navigation']['sourceFindings']), 1)
        self.assertEqual(report['navigation']['sourceFindings'][0]['reason'], 'named_destination_missing')
        self.assertFalse(report['certification'])

    def test_different_broken_names_and_name_vs_string_are_distinct(self):
        source = named_link_reader(missing=True)
        different = edit(source, lambda writer: writer.pages[0]['/Annots'][0].get_object()['/A'].__setitem__(N('/D'), S('another-missing-target')))
        self.assertFalse(v.compare_annotations(source, different)['passed'])
        self.assertFalse(self.compare(source, different)['preservation']['passed'])
        legacy = edit(source, lambda writer: writer.pages[0]['/Annots'][0].get_object()['/A'].__setitem__(N('/D'), N('/chapter')))
        string = edit(source, lambda writer: writer.pages[0]['/Annots'][0].get_object()['/A'].__setitem__(N('/D'), S('/chapter')))
        self.assertFalse(v.compare_annotations(legacy, string)['passed'])
        self.assertFalse(self.compare(legacy, string)['preservation']['passed'])

    def test_duplicate_values_and_authored_metadata_cannot_change(self):
        source = named_link_reader(duplicate=True)
        for mutation in ('target', 'description', 'uri', 'drop'):
            def change(writer):
                annotation = writer.pages[0]['/Annots'][0].get_object()
                if mutation == 'target':
                    values = writer.root_object['/Names']['/Dests']['/Kids'][0].get_object()['/Names']
                    values[3] = ArrayObject([writer.pages[0].indirect_reference, N('/FitH'), S('bad-coordinate')])
                elif mutation == 'description':
                    annotation[N('/NM')] = S('Changed annotation identity')
                elif mutation == 'uri':
                    annotation[N('/A')] = DictionaryObject({N('/S'): N('/URI'), N('/URI'): S('https://example.org/guessed')})
                else:
                    writer.pages[0][N('/Annots')] = ArrayObject()
            with self.subTest(mutation=mutation):
                output = edit(source, change)
                self.assertFalse(v.compare_annotations(source, output)['passed'])
                self.assertFalse(self.compare(source, output)['preservation']['passed'])

    def test_unknown_or_chained_actions_remain_uninspected(self):
        source = named_link_reader(missing=True)
        for action in (DictionaryObject({N('/S'): N('/JavaScript'), N('/JS'): S('bad')}),
                       DictionaryObject({N('/S'): N('/GoTo'), N('/D'): S('chapter'), N('/Next'): DictionaryObject({N('/S'): N('/Named'), N('/N'): N('/NextPage')})})):
            with self.subTest(action=action):
                reader = edit(source, lambda writer: writer.pages[0]['/Annots'][0].get_object().__setitem__(N('/A'), action))
                info = v.structure_inventory(reader)
                self.assertFalse(info['checks_complete'])
                self.assertFalse(info['navigation_checks_complete'])
                self.assertFalse(self.compare(reader, reader)['preservation']['passed'])

    def test_annotation_ownership_failure_stays_a_separate_blocker(self):
        source = named_link_reader(missing=True)
        def change(writer):
            writer.root_object['/StructTreeRoot']['/ParentTree']['/Nums'][3] = writer.root_object['/StructTreeRoot']['/K'][0]
        info = v.structure_inventory(edit(source, change))
        self.assertFalse(info['checks_complete'])
        self.assertTrue(any(f['code'] == 'annotation_parent_tree_owner_mismatch' for f in info['findings']))


if __name__ == '__main__':
    unittest.main()
