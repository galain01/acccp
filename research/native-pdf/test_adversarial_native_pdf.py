"""Saved-file preservation/refusal tests beyond the happy-path benchmark set."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import tempfile
import unittest

from pypdf import PdfReader, PdfWriter
from pypdf.generic import ArrayObject, DictionaryObject, NameObject, NumberObject, TextStringObject

import preserve_figures
from semantic_repairs import _tag_nodes
import synthetic_adversarial_fixtures as fixtures
import table_repairs
import verify_pdf as verify


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


class AdversarialNativePdfTests(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.folder = Path(folder.name)
        self.source = self.folder / 'source.pdf'
        self.candidate = self.folder / 'candidate.pdf'
        self.output = self.folder / 'repaired.pdf'

    def test_identical_form_programs_with_distinct_stream_owners_are_supported(self):
        fixtures.form_pages(self.source)
        info = verify.structure_inventory(PdfReader(self.source))
        self.assertTrue(info['checks_complete'], info['findings'])
        paragraphs = [tag for tag in info['tags'] if tag['role'] == 'P']
        self.assertEqual([tag['text'].strip() for tag in paragraphs], ['Shared-looking text'] * 2)
        self.assertEqual([tag['pageNumber'] for tag in paragraphs], [1, 2])
        self.assertTrue(all(ref['parentTreeVerified'] for tag in paragraphs for ref in tag['contentSequence']))

    def test_reused_semantic_form_across_pages_is_refused_without_modification(self):
        fixtures.form_pages(self.source, reused=True)
        before = self.source.read_bytes()
        report = verify.compare_pdfs(self.source, self.source)
        self.assertFalse(report['structure']['checks_complete'])
        self.assertFalse(report['passed'])
        self.assertTrue(any('form' in item['code'] for item in report['structure']['findings']), report)
        self.assertEqual(before, self.source.read_bytes())

    def test_aliases_cannot_disguise_repeated_semantic_form_invocations(self):
        fixtures.form_pages(self.source, aliases=True)
        info = verify.structure_inventory(PdfReader(self.source))
        self.assertFalse(info['checks_complete'])
        self.assertTrue(any('form' in finding['code'] for finding in info['findings']), info)

    def test_clipped_shaded_vector_figure_repair_preserves_all_paint_and_languages(self):
        fixtures.vector_figures(self.source)
        fixtures.vector_figures(self.candidate, candidate=True)
        originals = [p.read_bytes() for p in (self.source, self.candidate)]
        result = preserve_figures.preserve_figures(self.source, self.candidate, self.output)
        self.assertEqual(2, result['figuresRestored'])
        before, after = PdfReader(self.source), PdfReader(self.output)
        self.assertTrue(verify.compare_figure_associations(before, after)['passed'])
        self.assertEqual(verify.rendered_page_hashes(self.source), verify.rendered_page_hashes(self.output))
        figures = [t for t in verify.structure_inventory(after)['tags'] if t['role'] == 'Figure']
        self.assertEqual(['fr-FR', 'ja-JP'], [t['effectiveLanguage'] for t in figures])
        self.assertEqual(['Carré rouge : fréquence ≥ 1.', '曲線と色の変化を示すグラフ。'], [t['alt'] for t in figures])
        self.assertEqual(originals, [p.read_bytes() for p in (self.source, self.candidate)])

    def test_changed_vector_clip_is_not_repaired_as_equivalent_content(self):
        fixtures.vector_figures(self.source)
        fixtures.vector_figures(self.candidate, candidate=True, clip_width=20)
        originals = [sha(p) for p in (self.source, self.candidate)]
        with self.assertRaisesRegex(ValueError, 'painting_program_changed'):
            preserve_figures.preserve_figures(self.source, self.candidate, self.output)
        self.assertFalse(self.output.exists())
        self.assertEqual(originals, [sha(p) for p in (self.source, self.candidate)])

    def test_changed_shading_function_is_not_hidden_by_identical_path_operators(self):
        fixtures.vector_figures(self.source)
        fixtures.vector_figures(self.candidate, candidate=True, shading_end=0)
        with self.assertRaisesRegex(ValueError, 'page_resources_changed'):
            preserve_figures.preserve_figures(self.source, self.candidate, self.output)
        self.assertFalse(self.output.exists())

    def test_identical_descriptions_in_wrong_language_do_not_pass(self):
        fixtures.vector_figures(self.source)
        writer = PdfWriter(clone_from=self.source)
        for tag in _tag_nodes(writer):
            if tag.get('/S') == '/Figure': tag[NameObject('/Lang')] = TextStringObject('en-US')
        fixtures.save(writer, self.candidate)
        result = verify.compare_figure_associations(PdfReader(self.source), PdfReader(self.candidate))
        self.assertFalse(result['passed'])
        self.assertTrue(result['checksComplete'])
        self.assertTrue(all(item['failureCode'] == 'authored_figure_description_language_changed' for item in result['comparisons']))
        self.assertEqual(verify.rendered_page_hashes(self.source), verify.rendered_page_hashes(self.candidate))

    def test_description_inheritance_is_compared_by_effective_language(self):
        fixtures.vector_figures(self.source)
        writer = PdfWriter(clone_from=self.source)
        figures = [tag for tag in _tag_nodes(writer) if tag.get('/S') == '/Figure']
        del figures[0]['/Lang']
        writer.root_object[NameObject('/Lang')] = TextStringObject('fr-FR')
        fixtures.save(writer, self.candidate)
        result = verify.compare_figure_associations(PdfReader(self.source), PdfReader(self.candidate))
        self.assertTrue(result['passed'], result)

    def table_plan(self):
        self.candidate.write_bytes(self.source.read_bytes())
        table = table_repairs.table_snapshots(PdfReader(self.candidate))[0]
        rows = table['rows']
        row_headers = [rows[i]['cells'][0]['tagId'] for i in (4, 8)]
        tags = verify.structure_inventory(PdfReader(self.candidate))['tags']
        self.audit = self.folder / 'synthetic-review.json'
        self.audit.write_text(json.dumps({'status': 'complete', 'sourceSha256': sha(self.source),
            'outputSha256': sha(self.candidate), 'reviewedPages': [1, 2],
            'reviewedTagIds': [t['id'] for t in tags],
            'findings': [{'code': 'table-headers', 'tagIds': row_headers}]}), encoding='utf-8')
        return {'schemaVersion': 1, 'originalSha256': sha(self.source), 'inputSha256': sha(self.candidate),
            'auditCandidateSha256': sha(self.candidate), 'auditReportSha256': sha(self.audit),
            'tables': [{'tagId': table['tagId'], 'sourceTableIndex': 0,
                'snapshotSha256': table_repairs.digest(table),
                'columnHeaderRows': [rows[i]['tagId'] for i in (0, 1, 2, 5, 6, 7)],
                'rowHeaders': row_headers, 'groups': [{'tagId': rows[3]['cells'][0]['tagId'], 'rowHeaders': row_headers}],
                'noteCells': [rows[9]['cells'][0]['tagId']],
                'reason': 'Synthetic test: three authored column tiers and one category continue across two pages.'}]}

    def test_three_header_levels_and_continued_category_bind_each_saved_value(self):
        fixtures.three_tier_table(self.source)
        plan = self.table_plan()
        originals = [sha(p) for p in (self.source, self.candidate)]
        table_repairs.apply_table_header_plan(self.source, self.candidate, self.output, plan, audit_report=self.audit)
        reader = PdfReader(self.output)
        inventory = verify.structure_inventory(reader)
        self.assertTrue(inventory['checks_complete'], inventory['findings'])
        nodes = _tag_nodes(reader)
        # Follow raw persisted IDTree objects, not the repair helper's ledger.
        names = reader.root_object['/StructTreeRoot']['/IDTree']['/Names']
        by_id = {str(names[i]): names[i + 1].get_object() for i in range(0, len(names), 2)}
        texts = {id(node): inventory['tags'][i]['text'].strip() for i, node in enumerate(nodes)}
        def text(node):
            if texts[id(node)]: return texts[id(node)]
            kids = node.get('/K', [])
            kids = kids if isinstance(kids, list) else [kids]
            return ' '.join(text(child.get_object()) for child in kids if hasattr(child.get_object(), 'get') and '/S' in child.get_object()).strip()
        seen = []
        for node in nodes:
            if node.get('/S') != '/TD': continue
            value = text(node)
            attrs = node['/A']
            attrs = attrs if isinstance(attrs, list) else [attrs]
            table_attr = next(attr.get_object() for attr in attrs if attr.get_object().get('/O') == '/Table')
            headers = [text(by_id[str(key)]) for key in table_attr['/Headers']]
            seen.append((value, headers))
        self.assertEqual([
            ('10', ['Measures', '2024', 'Count', 'Northern campuses', 'Oak']),
            ('0.1', ['Measures', '2024', 'Rate', 'Northern campuses', 'Oak']),
            ('20', ['Measures', '2025', 'Count', 'Northern campuses', 'Oak']),
            ('0.2', ['Measures', '2025', 'Rate', 'Northern campuses', 'Oak']),
            ('30', ['Measures', '2024', 'Count', 'Northern campuses', 'Pine']),
            ('0.3', ['Measures', '2024', 'Rate', 'Northern campuses', 'Pine']),
            ('40', ['Measures', '2025', 'Count', 'Northern campuses', 'Pine']),
            ('0.4', ['Measures', '2025', 'Rate', 'Northern campuses', 'Pine'])], seen)
        self.assertEqual(1, sum(node.get('/S') == '/Note' for node in nodes))
        self.assertEqual(verify.rendered_page_hashes(self.source), verify.rendered_page_hashes(self.output))
        self.assertEqual(originals, [sha(p) for p in (self.source, self.candidate)])

    def test_merged_data_cell_is_refused_instead_of_inventing_header_associations(self):
        fixtures.three_tier_table(self.source, merged_data=True)
        plan = self.table_plan()
        with self.assertRaisesRegex(ValueError, 'explicit_simple_data_row_required'):
            table_repairs.apply_table_header_plan(self.source, self.candidate, self.output, plan, audit_report=self.audit)
        self.assertFalse(self.output.exists())

    def test_real_same_table_ids_do_not_make_cyclic_headers_valid(self):
        fixtures.three_tier_table(self.source)
        plan = self.table_plan()
        table_repairs.apply_table_header_plan(self.source, self.candidate, self.output, plan, audit_report=self.audit)
        writer = PdfWriter(clone_from=self.output)
        headers = [node for node in _tag_nodes(writer) if node.get('/S') == '/TH']
        # Measures already parents 2024; reverse that edge using real IDs in
        # the correct table. Pixel identity and ID resolution still hold.
        attrs = headers[1]['/A']
        attrs = attrs if isinstance(attrs, list) else [attrs]
        table_attr = next(attr.get_object() for attr in attrs if attr.get_object().get('/O') == '/Table')
        table_attr[NameObject('/Headers')] = ArrayObject([headers[2]['/ID']])
        tampered = self.folder / 'cyclic-headers.pdf'
        fixtures.save(writer, tampered)
        info = verify.structure_inventory(PdfReader(tampered))
        self.assertTrue(info['native_id_tree']['verified'])
        self.assertFalse(info['checks_complete'])
        self.assertFalse(info['machine_checks_passed'])
        self.assertIn('cyclic_table_header_relationship', [item['code'] for item in info['findings']])
        self.assertTrue(info['table_header_graph']['cycleDetected'])
        self.assertTrue(any(not attr['headersAcyclic'] for tag in info['tags'] if tag['role'] == 'TD'
            for attr in tag['attributes'] if 'headersAcyclic' in attr))
        self.assertEqual(verify.rendered_page_hashes(self.output), verify.rendered_page_hashes(tampered))

    def inspect_header_override(self, mode):
        fixtures.three_tier_table(self.source)
        plan = self.table_plan()
        table_repairs.apply_table_header_plan(self.source, self.candidate, self.output, plan, audit_report=self.audit)
        writer = PdfWriter(clone_from=self.output)
        headers = [node for node in _tag_nodes(writer) if node.get('/S') == '/TH']
        upper, child = headers[1:3]
        back_edge = DictionaryObject({NameObject('/O'): NameObject('/Table'),
            NameObject('/Headers'): ArrayObject([child['/ID']])})
        cleared = DictionaryObject({NameObject('/O'): NameObject('/Table'), NameObject('/Headers'): ArrayObject()})
        root = writer.root_object['/StructTreeRoot']
        root[NameObject('/ClassMap')] = DictionaryObject({NameObject('/Older'): back_edge, NameObject('/Newer'): cleared})
        if mode == 'direct-over-class':
            upper[NameObject('/C')] = NameObject('/Older')
            upper[NameObject('/A')] = cleared
        elif mode == 'later-direct':
            upper[NameObject('/A')] = ArrayObject([back_edge, cleared])
        elif mode == 'later-class':
            upper.pop('/A', None)
            upper[NameObject('/C')] = ArrayObject([NameObject('/Older'), NameObject('/Newer')])
        elif mode == 'revision':
            upper[NameObject('/A')] = ArrayObject([back_edge, NumberObject(0), cleared, NumberObject(1)])
            upper[NameObject('/R')] = NumberObject(1)
        else:
            raise AssertionError(mode)
        output = self.folder / ('header-override-' + mode + '.pdf')
        fixtures.save(writer, output)
        return verify.structure_inventory(PdfReader(output))

    def test_direct_empty_headers_override_class_cycle(self):
        info = self.inspect_header_override('direct-over-class')
        self.assertTrue(info['checks_complete'], info['findings'])
        self.assertFalse(info['table_header_graph']['cycleDetected'])

    def test_later_direct_headers_override_earlier_cycle(self):
        info = self.inspect_header_override('later-direct')
        self.assertTrue(info['checks_complete'], info['findings'])
        self.assertFalse(info['table_header_graph']['cycleDetected'])

    def test_later_class_headers_override_earlier_cycle(self):
        info = self.inspect_header_override('later-class')
        self.assertTrue(info['checks_complete'], info['findings'])
        self.assertFalse(info['table_header_graph']['cycleDetected'])

    def test_revisioned_header_attributes_are_explicitly_unsupported(self):
        info = self.inspect_header_override('revision')
        self.assertFalse(info['checks_complete'])
        self.assertIn('table_header_attribute_revisions_unsupported', [row['code'] for row in info['findings']])
        self.assertFalse(info['table_header_graph']['cycleDetected'])

    def test_multiscalar_combining_and_astral_unicode_survive_filtered_text_evidence(self):
        fixtures.mapped_unicode_text(self.source)
        original = self.source.read_bytes()
        reader = PdfReader(self.source)
        info = verify.structure_inventory(reader)
        text = next(tag['text'].strip() for tag in info['tags'] if tag['role'] == 'P')
        self.assertEqual('Éλ e\u0301 😀 你', text)
        self.assertEqual('É λ e\u0301 😀 你', info['page_content'][0]['artifactText'].strip())
        self.assertEqual('fr-FR', next(tag['effectiveLanguage'] for tag in info['tags'] if tag['role'] == 'P'))
        self.assertEqual(original, self.source.read_bytes())

    def test_embedded_latin_greek_cyrillic_and_languages_survive_real_metadata_repair(self):
        from repair_metadata import repair_metadata
        directory = Path(os.environ.get('NATIVE_PDF_FONT_DIR', str(Path(__file__).resolve().parents[4] /
            'work/pdf-native-tools/fonts/liberation-fonts-ttf-2.1.5')))
        font_path = directory / 'LiberationSans-Regular.ttf'
        if not font_path.exists(): self.skipTest('Local open-source Liberation fixture font is unavailable')
        fixtures.embedded_multilingual_text(self.source, font_path)
        original = self.source.read_bytes()
        changes = repair_metadata(self.source, self.output, 'en-US')
        self.assertTrue(changes)
        after = verify.structure_inventory(PdfReader(self.output))
        self.assertEqual(fixtures.MULTILINGUAL_PARAGRAPHS,
            [(tag['effectiveLanguage'], tag['text'].strip()) for tag in after['tags'] if tag['role'] == 'P'])
        self.assertTrue(after['checks_complete'], after['findings'])
        report = verify.compare_pdfs(self.source, self.output)
        self.assertTrue(report['preservation']['passed'], report['findings'])
        self.assertTrue(report['preservation']['fonts_identical'])
        self.assertEqual(verify.rendered_page_hashes(self.source), verify.rendered_page_hashes(self.output))
        self.assertEqual(original, self.source.read_bytes())


if __name__ == '__main__':
    unittest.main()
