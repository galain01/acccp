"""Generic regressions for meaningful text wrongly marked as page artifacts.

These sources are synthetic. They reproduce the unrepresented reading-order
content found on the rotated acceptance page without embedding a public PDF.
"""
import io
import sys
import unittest
from unittest.mock import patch
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "research/native-pdf"))

from pypdf import PdfReader, PdfWriter
from pypdf.generic import (
    ArrayObject, BooleanObject, DecodedStreamObject, DictionaryObject,
    NameObject as N, NumberObject as I, TextStringObject,
)

import native_structure_pipeline as pipeline
import bounded_artifact_reading as repair
import verify_pdf as v


MEANINGFUL = (
    "Appendix instructions",
    "Use source code B04 when the recorded total is 0.",
    "Do NOT omit the appendix direction.",
)
DECORATIVE = "Repeated footer 1"


def saved(writer):
    output = io.BytesIO()
    writer.write(output)
    return output.getvalue()


def artifact_fixture(rotation=0, text=True):
    writer = PdfWriter()
    page = writer.add_blank_page(width=612, height=792)
    page[N("/Rotate")] = I(rotation)
    page[N("/StructParents")] = I(0)
    font = writer._add_object(DictionaryObject({
        N("/Type"): N("/Font"), N("/Subtype"): N("/Type1"),
        N("/BaseFont"): N("/Helvetica"),
    }))
    page[N("/Resources")] = DictionaryObject({
        N("/Font"): DictionaryObject({N("/F"): font}),
    })
    root = DictionaryObject({N("/Type"): N("/StructTreeRoot")})
    root_ref = writer._add_object(root)
    document = DictionaryObject({N("/Type"): N("/StructElem"),
        N("/S"): N("/Document"), N("/P"): root_ref})
    doc_ref = writer._add_object(document)
    footer = DictionaryObject({N("/Type"): N("/StructElem"),
        N("/S"): N("/P"), N("/P"): doc_ref,
        N("/Pg"): page.indirect_reference, N("/K"): I(0)})
    footer_ref = writer._add_object(footer)
    document[N("/K")] = ArrayObject([footer_ref])
    root[N("/K")] = doc_ref
    root[N("/ParentTree")] = writer._add_object(DictionaryObject({
        N("/Nums"): ArrayObject([I(0), ArrayObject([footer_ref])]),
    }))
    root[N("/ParentTreeNextKey")] = I(1)
    writer.root_object[N("/StructTreeRoot")] = root_ref
    writer.root_object[N("/Lang")] = TextStringObject("en-US")
    writer.root_object[N("/MarkInfo")] = DictionaryObject({N("/Marked"): BooleanObject(True)})
    lines = [b"q /Artifact BMC 0.9 g 20 740 570 30 re f EMC Q"]
    if text:
        for index, value in enumerate(MEANINGFUL):
            lines.append((
                "BT /F 12 Tf 1 0 0 1 40 %d Tm /Artifact BMC (%s) Tj EMC ET"
                % (710 - index * 26, value)
            ).encode("ascii"))
    # Explicit pagination is independently excluded and must not be swept into
    # a repair merely because it shares the page with an inaccessible heading.
    lines.append((
        "BT /F 8 Tf 1 0 0 1 40 25 Tm /Artifact << /Type /Pagination /Subtype /Footer >> BDC (%s) Tj EMC ET"
        % DECORATIVE
    ).encode("ascii"))
    lines.append(b"BT /F 8 Tf 1 0 0 1 500 25 Tm /P << /MCID 0 >> BDC (1) Tj EMC ET")
    stream = DecodedStreamObject()
    stream.set_data(b"\n".join(lines))
    page[N("/Contents")] = writer._add_object(stream)
    return writer


def restoration_candidates(reader):
    return [candidate for candidate in pipeline.discover_candidates(reader)
        if candidate["kind"] == "restore_artifact_text"]


class ArtifactReadingReliabilityTests(unittest.TestCase):
    def test_meaningful_artifact_text_has_a_source_bound_repair_candidate(self):
        source = PdfReader(io.BytesIO(saved(artifact_fixture())))
        inventory = v.structure_inventory(source)
        self.assertTrue(inventory["checks_complete"])
        self.assertTrue(all(text in inventory["page_content"][0]["artifactText"] for text in MEANINGFUL))
        self.assertEqual([tag["text"].strip() for tag in inventory["tags"] if tag.get("text")], ["1"])
        candidates = restoration_candidates(source)
        self.assertTrue(candidates, "Meaningful page text has no supported writer operation and is therefore only reported by the auditor")
        offered = "\n".join(candidate["text"] for candidate in candidates)
        for text in MEANINGFUL:
            self.assertIn(text, offered)
        self.assertNotIn(DECORATIVE, offered)
        self.assertEqual(len({candidate["candidateId"] for candidate in candidates}), len(candidates))

    def test_native_page_rotation_does_not_hide_restorable_text(self):
        for rotation in (0, 90, 180, 270):
            with self.subTest(rotation=rotation):
                source = PdfReader(io.BytesIO(saved(artifact_fixture(rotation=rotation))))
                candidates = restoration_candidates(source)
                self.assertTrue(candidates)
                offered = "\n".join(candidate["text"] for candidate in candidates)
                self.assertTrue(all(text in offered for text in MEANINGFUL))
                self.assertEqual(int(source.pages[0].get("/Rotate", 0)), rotation)

    def test_artifact_candidate_identity_is_bound_to_the_complete_source(self):
        first = PdfReader(io.BytesIO(saved(artifact_fixture())))
        changed = PdfWriter(clone_from=first)
        changed.add_metadata({"/Subject": "A distinct source, with identical visible words"})
        second = PdfReader(io.BytesIO(saved(changed)))
        before, after = restoration_candidates(first), restoration_candidates(second)
        self.assertTrue(before)
        self.assertTrue(after)
        self.assertNotEqual({candidate["candidateId"] for candidate in before},
            {candidate["candidateId"] for candidate in after})

    def test_graphic_decoration_and_explicit_pagination_are_not_promoted(self):
        source = PdfReader(io.BytesIO(saved(artifact_fixture(text=False))))
        self.assertEqual(restoration_candidates(source), [])

    def test_nested_graphic_or_authored_override_scopes_are_not_offered(self):
        original = b'/Artifact BMC (Appendix instructions) Tj EMC'
        replacements = (
            b'/Artifact BMC /Span BMC (Appendix instructions) Tj EMC EMC',
            b'/Artifact BMC 0 0 10 10 re f (Appendix instructions) Tj EMC',
            b'/Artifact << /ActualText (Authored alternative) >> BDC (Appendix instructions) Tj EMC',
        )
        for replacement in replacements:
            writer = artifact_fixture()
            stream = writer.pages[0]['/Contents']
            content = stream.get_data()
            self.assertIn(original, content)
            stream.set_data(content.replace(original, replacement))
            source = PdfReader(io.BytesIO(saved(writer)))
            with self.subTest(replacement=replacement):
                candidates = repair.discover_candidates(source)
                offered = '\n'.join(item['text'] for item in candidates)
                self.assertNotIn(MEANINGFUL[0], offered)
                self.assertTrue(all(text in offered for text in MEANINGFUL[1:]))


class ArtifactSavedRepairTests(unittest.TestCase):
    def source(self, rotation=0):
        return PdfReader(io.BytesIO(saved(artifact_fixture(rotation=rotation))))

    def operation(self, source, selected=None, **extra):
        candidate = repair.discover_candidates(source)[0]
        scopes = candidate['textScopes'] if selected is None else [candidate['textScopes'][index] for index in selected]
        return {'type': 'repair_structure', 'tagId': candidate['tagId'],
            'candidateId': candidate['candidateId'], 'selections': [
                {'scopeId': scope['scopeId'], 'role': 'H2' if index == 0 else 'P'}
                for index, scope in enumerate(scopes)], **extra}

    def apply(self, source, operation=None):
        writer = PdfWriter(clone_from=source)
        result = repair.apply_operations(source, writer, [operation or self.operation(source)])
        data = saved(writer)
        reopened = PdfReader(io.BytesIO(data))
        self.assertTrue(repair.verify_saved(reopened, result['verification']))
        return reopened, result, data

    def test_saved_words_order_roles_owners_and_visible_pixels_are_preserved(self):
        import pypdfium2 as pdfium
        for rotation in (0, 90, 180, 270):
            with self.subTest(rotation=rotation):
                source = self.source(rotation)
                output, proof, data = self.apply(source)
                inventory = v.structure_inventory(output)
                self.assertTrue(inventory['checks_complete'])
                self.assertEqual([tag['role'] for tag in inventory['tags']], ['Document', 'H2', 'P', 'P', 'P'])
                self.assertEqual([tag['text'].strip() for tag in inventory['tags'] if tag['text']], [*MEANINGFUL, '1'])
                self.assertEqual(inventory['page_content'][0]['artifactText'].strip(), DECORATIVE)
                self.assertEqual(source.pages[0].extract_text(), output.pages[0].extract_text())
                self.assertEqual(repair._paint(v.operations(source.pages[0])), repair._paint(v.operations(output.pages[0])))
                self.assertEqual(int(output.pages[0].get('/Rotate', 0)), rotation)
                images = []
                for pdf_bytes in (saved(PdfWriter(clone_from=source)), data):
                    document = pdfium.PdfDocument(pdf_bytes)
                    page = document[0]
                    bitmap = page.render(scale=1)
                    try:
                        images.append(bitmap.to_pil().convert('RGB').tobytes())
                    finally:
                        bitmap.close(); page.close(); document.close()
                self.assertEqual(images[0], images[1])
                self.assertEqual(len(proof['lineage']), 3)

    def test_unselected_artifact_scopes_stay_excluded(self):
        source = self.source()
        output, _, _ = self.apply(source, self.operation(source, selected=[0]))
        inventory = v.structure_inventory(output)
        self.assertEqual([tag['text'].strip() for tag in inventory['tags'] if tag['text']], [MEANINGFUL[0], '1'])
        remaining = inventory['page_content'][0]['artifactText']
        self.assertTrue(all(text in remaining for text in (*MEANINGFUL[1:], DECORATIVE)))
        self.assertNotIn(MEANINGFUL[0], remaining)

    def test_extraction_budget_is_enforced_before_reparsing_another_scope(self):
        source = self.source()
        operations = v.operations(source.pages[0])
        with patch.object(repair, 'MAX_EXTRACTION_WORK', len(operations)), \
                patch.object(repair.semantic, '_show_text', wraps=repair.semantic._show_text) as extraction:
            with self.assertRaisesRegex(repair.ArtifactReadingError, 'pdf_complexity_limit'):
                repair._text_scopes(source, source.pages[0], operations)
            self.assertEqual(extraction.call_count, 1)

    def test_exact_plan_and_source_binding_reject_arbitrary_or_replayed_changes(self):
        source = self.source()
        operation = self.operation(source)
        scope = operation['selections'][0]
        invalid = [
            {**operation, 'candidateId': '0' * 64},
            {**operation, 'tagId': 'tag-999'},
            {**operation, 'selections': [scope, scope]},
            {**operation, 'selections': [{'scopeId': '0' * 64, 'role': 'P'}]},
            {**operation, 'selections': [{**scope, 'role': 'Figure'}]},
            {**operation, 'selections': [{**scope, 'text': 'replacement wording'}]},
            {**operation, 'selections': []},
            {**operation, 'arbitrary': 'PDF code'},
            {**operation, 'anchorRole': 'H1'},
            {**operation, 'anchorRole': 'unknown'},
        ]
        for plan in invalid:
            with self.subTest(plan=plan), self.assertRaises(repair.ArtifactReadingError):
                repair.apply_operations(source, PdfWriter(clone_from=source), [plan])
        changed = PdfWriter(clone_from=source)
        changed.add_metadata({'/Subject': 'Another original'})
        changed = PdfReader(io.BytesIO(saved(changed)))
        with self.assertRaises(repair.ArtifactReadingError):
            repair.apply_operations(changed, PdfWriter(clone_from=changed), [operation])

    def test_optional_anchor_demotion_is_verified_on_the_saved_result(self):
        source_writer = artifact_fixture()
        source_writer.root_object['/StructTreeRoot']['/K']['/K'][0].get_object()[N('/S')] = N('/H2')
        source = PdfReader(io.BytesIO(saved(source_writer)))
        output, _, _ = self.apply(source, self.operation(source, anchorRole='P'))
        inventory = v.structure_inventory(output)
        self.assertEqual(inventory['tags'][-1]['role'], 'P')
        self.assertEqual(inventory['tags'][-1]['text'].strip(), '1')

    def test_multiple_pages_may_restore_into_the_same_document_parent(self):
        writer = artifact_fixture()
        page = writer.add_blank_page(width=612, height=792)
        page[N('/StructParents')] = I(1)
        page[N('/Contents')] = writer.pages[0].raw_get('/Contents')
        page[N('/Resources')] = writer.pages[0].raw_get('/Resources')
        root = writer.root_object['/StructTreeRoot']
        document = root['/K']
        footer = DictionaryObject({N('/Type'): N('/StructElem'), N('/S'): N('/P'),
            N('/P'): document.indirect_reference, N('/Pg'): page.indirect_reference, N('/K'): I(0)})
        footer_ref = writer._add_object(footer)
        document['/K'].append(footer_ref)
        root['/ParentTree']['/Nums'].extend([I(1), ArrayObject([footer_ref])])
        root[N('/ParentTreeNextKey')] = I(2)
        source = PdfReader(io.BytesIO(saved(writer)))
        candidates = repair.discover_candidates(source)
        self.assertEqual(len(candidates), 2)
        operations = [{'type': 'repair_structure', 'tagId': item['tagId'],
            'candidateId': item['candidateId'], 'selections': [
                {'scopeId': scope['scopeId'], 'role': 'P'} for scope in item['textScopes']]}
            for item in candidates]
        output = PdfWriter(clone_from=source)
        result = repair.apply_operations(source, output, operations)
        reopened = PdfReader(io.BytesIO(saved(output)))
        self.assertTrue(repair.verify_saved(reopened, result['verification']))
        self.assertEqual(len(result['lineage']), 6)

    def callout_source(self, position='after'):
        from test_bounded_reading_order import fixture
        writer, _ = fixture()
        stream = writer.pages[0]['/Contents']
        artifact = b'\n/Artifact BMC 1 0 0 1 40 100 Tm (Additional source direction.) Tj EMC\n'
        content = stream.get_data()
        if position == 'after':
            content = content.replace(b'ET', artifact + b'ET')
        else:
            content = content.replace(b'/P << /MCID 1 >> BDC', artifact + b'/P << /MCID 1 >> BDC')
        stream.set_data(content)
        return PdfReader(io.BytesIO(saved(writer)))

    def test_artifact_restore_composes_with_callout_in_the_same_parent(self):
        source = self.callout_source()
        candidates = pipeline.discover_candidates(source)
        callout = next(item for item in candidates if item['kind'] == 'move_callout')
        artifact = next(item for item in candidates if item['kind'] == 'restore_artifact_text')
        operations = [{'type': 'repair_structure', 'tagId': callout['tagId'],
            'candidateId': callout['candidateId']},
            {'type': 'repair_structure', 'tagId': artifact['tagId'],
            'candidateId': artifact['candidateId'], 'selections': [
                {'scopeId': item['scopeId'], 'role': 'P'} for item in artifact['textScopes']]}]
        writer = PdfWriter(clone_from=source)
        result = pipeline.apply_operations(source, writer, operations)
        reopened = PdfReader(io.BytesIO(saved(writer)))
        pipeline.verify_saved(reopened, result['verification'])
        self.assertEqual(reopened.pages[0].extract_text(), source.pages[0].extract_text())
        self.assertIn('Additional source direction.', '\n'.join(
            tag['text'] for tag in v.structure_inventory(reopened)['tags']))

    def test_artifact_restore_cannot_split_a_verified_callout_reading_window(self):
        import bounded_reading_order as reading
        source = self.callout_source(position='inside')
        writer = PdfWriter(clone_from=source)
        source_nodes = {f'tag-{i + 1}': node for i, node in enumerate(repair.semantic.nodes(source))}
        target_nodes = {f'tag-{i + 1}': node for i, node in enumerate(repair.semantic.nodes(writer))}
        candidate = reading.discover_candidates(source)[0]
        previous = reading.apply_operations(source, writer, [{'type': 'repair_structure',
            'tagId': candidate['tagId'], 'candidateId': candidate['candidateId']}])
        operation = self.operation(source)
        with self.assertRaises(repair.ArtifactReadingError):
            repair.apply_operations(source, writer, [operation], _source_nodes=source_nodes,
                _target_nodes=target_nodes, _prior_verifications=((reading, previous['verification']),))

    def continuation_source(self, position='after'):
        from test_bounded_reading_order import continuation_fixture
        writer, named = continuation_fixture()
        page, document = writer.pages[1], named['document']
        array = v.number_tree(writer.root_object['/StructTreeRoot']['/ParentTree'])[0]
        mcid = len(array)
        footer = DictionaryObject({N('/Type'): N('/StructElem'), N('/S'): N('/P'),
            N('/P'): document.indirect_reference, N('/Pg'): page.indirect_reference, N('/K'): I(mcid)})
        footer_ref = writer._add_object(footer)
        array.append(footer_ref)
        document['/K'].append(footer_ref)
        artifact = b'\n/Artifact BMC BT /F1 8 Tf 1 0 0 1 40 100 Tm (Additional appendix direction.) Tj ET EMC\n'
        footer_paint = ('\n/P << /MCID %d >> BDC BT /F1 8 Tf 1 0 0 1 40 20 Tm (2) Tj ET EMC\n' % mcid).encode('ascii')
        content = page['/Contents'].get_data()
        if position == 'after':
            content += footer_paint + artifact
        else:
            token = ('/Content << /MCID %d >> BDC' % int(named['prose']['/K'])).encode('ascii')
            self.assertIn(token, content)
            content = content.replace(token, artifact + token) + footer_paint
        page['/Contents'].set_data(content)
        return PdfReader(io.BytesIO(saved(writer)))

    def test_artifact_restore_composes_with_next_page_continuation(self):
        source = self.continuation_source()
        candidates = pipeline.discover_candidates(source)
        moved = next(item for item in candidates if item['kind'] == 'move_page_continuation')
        artifact = next(item for item in candidates if item['kind'] == 'restore_artifact_text')
        operations = [{'type': 'repair_structure', 'tagId': moved['tagId'],
            'candidateId': moved['candidateId']},
            {'type': 'repair_structure', 'tagId': artifact['tagId'],
            'candidateId': artifact['candidateId'], 'selections': [
                {'scopeId': item['scopeId'], 'role': 'P'} for item in artifact['textScopes']]}]
        writer = PdfWriter(clone_from=source)
        result = pipeline.apply_operations(source, writer, operations)
        reopened = PdfReader(io.BytesIO(saved(writer)))
        pipeline.verify_saved(reopened, result['verification'])
        self.assertEqual(source.pages[1].extract_text(), reopened.pages[1].extract_text())

    def test_artifact_restore_cannot_split_a_verified_page_continuation(self):
        import bounded_reading_order as reading
        source = self.continuation_source(position='inside')
        writer = PdfWriter(clone_from=source)
        source_nodes = {f'tag-{i + 1}': node for i, node in enumerate(repair.semantic.nodes(source))}
        target_nodes = {f'tag-{i + 1}': node for i, node in enumerate(repair.semantic.nodes(writer))}
        candidate = next(item for item in reading.discover_candidates(source)
            if item['kind'] == 'move_page_continuation')
        previous = reading.apply_operations(source, writer, [{'type': 'repair_structure',
            'tagId': candidate['tagId'], 'candidateId': candidate['candidateId']}])
        with self.assertRaises(repair.ArtifactReadingError):
            repair.apply_operations(source, writer, [self.operation(source)], _source_nodes=source_nodes,
                _target_nodes=target_nodes, _prior_verifications=((reading, previous['verification']),))

    def test_saved_role_order_ownership_text_and_mark_corruption_are_detected(self):
        source = self.source()
        for corruption in ('role', 'order', 'owner', 'paint', 'marks'):
            changed = PdfWriter(clone_from=source)
            result = repair.apply_operations(source, changed, [self.operation(source)])
            nodes = repair.semantic.nodes(changed)
            if corruption == 'role':
                nodes[1][N('/S')] = N('/P')
            elif corruption == 'order':
                nodes[0]['/K'][0], nodes[0]['/K'][1] = nodes[0]['/K'][1], nodes[0]['/K'][0]
            elif corruption == 'owner':
                parents = v.number_tree(changed.root_object['/StructTreeRoot']['/ParentTree'])
                parents[0][1] = nodes[-1].indirect_reference
            else:
                stream = DecodedStreamObject()
                original = changed.pages[0]['/Contents'].get_data()
                if corruption == 'paint':
                    # The writer freezes original text operands as exact hex
                    # strings, so mutate their actual serialized bytes.
                    self.assertIn(b'4e4f54', original)
                    original = original.replace(b'4e4f54', b'594553')
                else:
                    original = original.replace(b'/H2', b'/P', 1)
                stream.set_data(original)
                changed.pages[0][N('/Contents')] = changed._add_object(stream)
            with self.subTest(corruption=corruption), self.assertRaises(repair.ArtifactReadingError):
                repair.verify_saved(PdfReader(io.BytesIO(saved(changed))), result['verification'])


if __name__ == "__main__":
    unittest.main()
