import hashlib
import json
from pathlib import Path
import tempfile
import unittest

from pypdf import PdfReader, PdfWriter
from pypdf.generic import ArrayObject, BooleanObject, ContentStream, DictionaryObject, NameObject, NumberObject

from form_label_repairs import repair_form_labels, _form_page_hashes
from form_order_repairs import repair_form_reading_order
from test_form_label_repairs import fixture, tagged, mutate, digest
from semantic_repairs import _tag_nodes
from verify_pdf import structure_inventory


def ordered_fixture(directory):
    original, tagged_path, labeled = [directory / name for name in ('source.pdf', 'tagged.pdf', 'labeled.pdf')]
    fixture(original)
    tagged(original, tagged_path)
    def label_tags(writer):
        writer.root_object[NameObject('/MarkInfo')] = DictionaryObject({NameObject('/Marked'): BooleanObject(True)})
        page = writer.pages[0]
        stream = ContentStream(page['/Contents'], writer)
        emitted, paragraph_refs, block = [], [], None
        root = writer.root_object['/StructTreeRoot']; document = root['/K']
        for operands, operation in stream.operations:
            if operation == b'BT': block = [(operands, operation)]
            elif block is not None:
                block.append((operands, operation))
                if operation == b'ET':
                    if any(op == b'Tj' for args, op in block):
                        mcid = len(paragraph_refs)
                        paragraph = DictionaryObject({NameObject('/Type'): NameObject('/StructElem'),
                            NameObject('/S'): NameObject('/P'), NameObject('/P'): document.indirect_reference,
                            NameObject('/Pg'): page.indirect_reference, NameObject('/K'): NumberObject(mcid)})
                        paragraph_refs.append(writer._add_object(paragraph))
                        emitted.append(([NameObject('/P'), DictionaryObject({NameObject('/MCID'): NumberObject(mcid)})], b'BDC'))
                        emitted.extend(block); emitted.append(([], b'EMC'))
                    else: emitted.extend(block)
                    block = None
            else: emitted.append((operands, operation))
        stream.operations = emitted
        page[NameObject('/Contents')] = writer._add_object(stream)
        page[NameObject('/StructParents')] = NumberObject(3)
        root['/ParentTree']['/Nums'].extend([NumberObject(3), ArrayObject(paragraph_refs)])
        document[NameObject('/K')] = ArrayObject([*paragraph_refs, *document['/K']])
    mutate(tagged_path, label_tags)
    ledger = repair_form_labels(original, tagged_path, labeled,
        expected_original_sha256=digest(original), expected_candidate_sha256=digest(tagged_path))
    ledger_path = directory / 'labels.json'; ledger_path.write_text(json.dumps(ledger), encoding='utf-8')
    tags = structure_inventory(PdfReader(labeled))['tags']
    ps, fs = [t for t in tags if t['role'] == 'P'], [t for t in tags if t['role'] == 'Form']
    pairs = [{'labelTagId': p['id'], 'formTagId': f['id']} for p, f in zip(ps, fs)]
    audit = {'status': 'complete', 'sourceSha256': digest(original), 'outputSha256': digest(labeled), 'reviewedPages': [1],
        'reviewedTagIds': [t['id'] for t in tags],
        'findings': [{'code': 'reading-order', 'pageNumber': 1, 'tagIds': [t['id'] for t in ps + fs]}]}
    audit_path = directory / 'audit.json'; audit_path.write_text(json.dumps(audit), encoding='utf-8')
    return original, labeled, ledger_path, audit_path, pairs


class FormOrderRepairTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        self.original, self.input, self.labels, self.audit, self.pairs = ordered_fixture(self.directory)
        self.output = self.directory / 'ordered.pdf'

    def repair(self, pairs=None):
        return repair_form_reading_order(self.original, self.input, self.output,
            audit_report=self.audit, label_ledger=self.labels, pairs=self.pairs if pairs is None else pairs,
            expected_original_sha256=digest(self.original), expected_candidate_sha256=digest(self.input))

    def test_saved_native_pairs_leave_text_controls_values_and_pixels_intact(self):
        source_bytes, input_bytes = self.original.read_bytes(), self.input.read_bytes()
        ledger = self.repair()
        tags = structure_inventory(PdfReader(self.output))['tags'][1:]
        self.assertEqual(['P', 'Form', 'P', 'Form', 'Form', 'P'], [t['role'] for t in tags])
        self.assertEqual('Participant name', tags[0]['text'].strip())
        self.assertEqual('Participant name', tags[1]['alt'])
        self.assertEqual('Preferred session', tags[2]['text'].strip())
        self.assertEqual('Send workshop materials', tags[-1]['text'].strip())
        self.assertEqual(_form_page_hashes(self.input), _form_page_hashes(self.output))
        self.assertEqual(digest(self.labels), ledger['labelLedgerSha256'])
        self.assertEqual(digest(self.audit), ledger['auditSha256'])
        self.assertEqual(source_bytes, self.original.read_bytes()); self.assertEqual(input_bytes, self.input.read_bytes())
        before, after = PdfReader(self.input).get_fields(), PdfReader(self.output).get_fields()
        self.assertEqual({key: value['/V'] for key, value in before.items()}, {key: value['/V'] for key, value in after.items()})

    def test_swapped_controls_rejected_by_visible_row_geometry(self):
        pairs = [dict(p) for p in self.pairs]
        pairs[0]['formTagId'], pairs[1]['formTagId'] = pairs[1]['formTagId'], pairs[0]['formTagId']
        with self.assertRaisesRegex(ValueError, 'same_visible_row'): self.repair(pairs)
        self.assertFalse(self.output.exists())

    def test_unreviewed_pair_rejected(self):
        audit = json.loads(self.audit.read_text()); audit['findings'][0]['tagIds'].remove(self.pairs[0]['formTagId'])
        self.audit.write_text(json.dumps(audit), encoding='utf-8')
        with self.assertRaisesRegex(ValueError, 'matching_audited'): self.repair()

    def test_omitted_or_duplicate_control_rejected(self):
        with self.assertRaisesRegex(ValueError, 'all_page_controls'): self.repair(self.pairs[:-1])
        with self.assertRaisesRegex(ValueError, 'unique_known'): self.repair([self.pairs[0], self.pairs[0]])

    def test_stale_audit_and_label_chain_rejected(self):
        audit = json.loads(self.audit.read_text()); audit['outputSha256'] = '0' * 64
        self.audit.write_text(json.dumps(audit), encoding='utf-8')
        with self.assertRaisesRegex(ValueError, 'matching_audit'): self.repair()
        ledger = json.loads(self.labels.read_text()); ledger['outputSha256'] = '1' * 64
        self.labels.write_text(json.dumps(ledger), encoding='utf-8')
        with self.assertRaisesRegex(ValueError, 'verified_prior_labels'): self.repair()

    def test_output_overwrite_refused(self):
        self.repair()
        with self.assertRaisesRegex(ValueError, 'new_output'): self.repair()

    def test_other_source_or_incomplete_audit_cannot_authorize_order(self):
        audit = json.loads(self.audit.read_text())
        audit['sourceSha256'] = '0' * 64
        self.audit.write_text(json.dumps(audit), encoding='utf-8')
        with self.assertRaisesRegex(ValueError, 'matching_audit'): self.repair()
        audit['sourceSha256'] = digest(self.original)
        audit['reviewedTagIds'].pop()
        self.audit.write_text(json.dumps(audit), encoding='utf-8')
        with self.assertRaisesRegex(ValueError, 'audit_coverage'): self.repair()


if __name__ == '__main__': unittest.main()
