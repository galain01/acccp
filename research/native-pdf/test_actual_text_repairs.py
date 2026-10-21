import hashlib
import io
from pathlib import Path
import tempfile
import unittest
from pypdf import PdfReader,PdfWriter
from pypdf.generic import ArrayObject,DecodedStreamObject,DictionaryObject,NameObject,NumberObject,TextStringObject
from actual_text_repairs import restore_authored_actual_text,_restore_inline_actual_text,_inline_scopes
from test_native_pdf_validation import pdf_bytes
from verify_pdf import compare_actual_text_associations,structure_inventory


def sample(*,source,artifact=False,conflict=False,merged=False):
    writer=PdfWriter(clone_from=PdfReader(io.BytesIO(pdf_bytes(tagged=True))))
    root=writer.root_object['/StructTreeRoot'];paragraph=root['/K'][0]['/K'][0].get_object();page=writer.pages[0]
    content=[]
    for mcid,text in [(0,'medica'),(1,' ' if artifact else '-'),(2,'tion')]:
        opening=b'/Artifact BMC ' if artifact and not source and mcid==1 else f'/P << /MCID {mcid if not merged or mcid!=0 else 1} >> BDC '.encode()
        content.append(opening+f'BT /F1 12 Tf {20+mcid*35} 40 Td ({text}) Tj ET EMC '.encode())
    stream=DecodedStreamObject();stream.set_data(b''.join(content));page[NameObject('/Contents')]=writer._add_object(stream)
    paragraph[NameObject('/K')]=ArrayObject([NumberObject(0),NumberObject(1),NumberObject(2)])
    parents=ArrayObject([paragraph.indirect_reference]*3)
    if source:
        span=writer._add_object(DictionaryObject({NameObject('/Type'):NameObject('/StructElem'),NameObject('/S'):NameObject('/Span'),NameObject('/P'):paragraph.indirect_reference,NameObject('/Pg'):page.indirect_reference,NameObject('/K'):NumberObject(1),NameObject('/ActualText'):TextStringObject('\n' if artifact else '\u00ad')}))
        paragraph[NameObject('/K')]=ArrayObject([NumberObject(0),NumberObject(2),span] if artifact else [NumberObject(0),span,NumberObject(2)])
        parents[1]=span
    elif artifact:paragraph[NameObject('/K')]=ArrayObject([NumberObject(0),NumberObject(2)])
    if conflict:paragraph[NameObject('/ActualText')]=TextStringObject('Existing authored replacement.')
    root['/ParentTree'][NameObject('/Nums')]=ArrayObject([NumberObject(0),parents])
    data=io.BytesIO();writer.write(data);return data.getvalue()


class ActualTextRestorationTests(unittest.TestCase):
    def setUp(self):
        temporary=tempfile.TemporaryDirectory();self.addCleanup(temporary.cleanup);directory=Path(temporary.name)
        self.original=directory/'original.pdf';self.candidate=directory/'candidate.pdf';self.output=directory/'output.pdf'
        self.original.write_bytes(sample(source=True));self.candidate.write_bytes(sample(source=False))
    def restore(self):
        return restore_authored_actual_text(self.original,self.candidate,self.output,
            expected_original_sha256=hashlib.sha256(self.original.read_bytes()).hexdigest(),expected_candidate_sha256=hashlib.sha256(self.candidate.read_bytes()).hexdigest())
    def test_soft_hyphen_is_restored_to_exact_original_glyph(self):
        source=self.original.read_bytes();candidate=self.candidate.read_bytes();report=self.restore()
        self.assertEqual(1,len(report['restored']));self.assertEqual('\u00ad',report['restored'][0]['actualText'])
        self.assertTrue(compare_actual_text_associations(PdfReader(self.original),PdfReader(self.output))['passed'])
        self.assertEqual(source,self.original.read_bytes());self.assertEqual(candidate,self.candidate.read_bytes())
    def test_isolated_artifact_newline_uses_original_logical_order(self):
        self.original.write_bytes(sample(source=True,artifact=True));self.candidate.write_bytes(sample(source=False,artifact=True));report=self.restore()
        self.assertTrue(report['restored'][0]['restoredFromArtifact'])
        tags=structure_inventory(PdfReader(self.output))['tags'];paragraph=next(t for t in tags if t['role']=='P')
        self.assertEqual(['markedContent','markedContent','childTag'],[c['kind'] for c in paragraph['contentSequence']])
        self.assertEqual('\n',next(t for t in tags if t['role']=='Span')['actualText'])
        self.assertEqual(0,structure_inventory(PdfReader(self.output))['unresolved_content_references'])
    def test_existing_authored_replacement_is_not_overwritten(self):
        self.candidate.write_bytes(sample(source=False,conflict=True))
        with self.assertRaisesRegex(ValueError,'replacement_text_conflict'):self.restore()
        self.assertFalse(self.output.exists())
    def test_source_scope_language_is_retained_without_other_scope_overrides(self):
        writer=PdfWriter(clone_from=self.original);page=writer.pages[0];stream=DecodedStreamObject()
        stream.set_data(page.get_contents().get_data().replace(b'/MCID 1',b'/Lang (en-GB) /MCID 1'));page[NameObject('/Contents')]=writer._add_object(stream)
        with self.original.open('wb') as handle:writer.write(handle)
        report=self.restore();self.assertEqual('en-GB',report['restored'][0]['language'])
        span=next(t for t in structure_inventory(PdfReader(self.output))['tags'] if t['role']=='Span');self.assertEqual('en-GB',span['effectiveLanguage'])
    def test_original_toc_entry_break_is_restored_inside_its_retained_owner(self):
        for path,is_source in [(self.original,True),(self.candidate,False)]:
            path.write_bytes(sample(source=is_source,artifact=True));writer=PdfWriter(clone_from=path)
            writer.root_object['/StructTreeRoot']['/K'][0]['/K'][0].get_object()[NameObject('/S')]=NameObject('/TOCI')
            with path.open('wb') as handle:writer.write(handle)
        report=self.restore();self.assertTrue(report['authoredActualTextAssociations']['passed'])
        info=structure_inventory(PdfReader(self.output));span=next(t for t in info['tags'] if t['role']=='Span');parent=next(t for t in info['tags'] if t['id']==span['parentId'])
        self.assertEqual('TOCI',parent['role'])
    def test_already_preserved_span_remains_unchanged(self):
        self.candidate.write_bytes(self.original.read_bytes());report=self.restore()
        self.assertEqual(1,report['alreadyPreserved']);self.assertEqual([],report['restored'])
    def test_existing_span_with_changed_authored_language_is_rejected(self):
        for path,language in [(self.original,'en-GB'),(self.candidate,'fr')]:
            path.write_bytes(sample(source=True));writer=PdfWriter(clone_from=path)
            paragraph=writer.root_object['/StructTreeRoot']['/K'][0]['/K'][0].get_object()
            paragraph['/K'][1].get_object()[NameObject('/Lang')]=TextStringObject(language)
            with path.open('wb') as handle:writer.write(handle)
        with self.assertRaisesRegex(ValueError,'existing_replacement_language_conflict'):self.restore()
        self.assertFalse(self.output.exists())
    def test_inline_scope_restores_exact_text_occurrence_and_preserves_other_operators(self):
        original=PdfWriter(clone_from=self.original);page=original.pages[0];stream=DecodedStreamObject()
        stream.set_data(page.get_contents().get_data().replace(b'(medica) Tj',b'/Span << /ActualText (\\t) >> BDC (medica) Tj EMC'))
        page[NameObject('/Contents')]=original._add_object(stream);data=io.BytesIO();original.write(data)
        source=PdfReader(data);candidate=PdfWriter(clone_from=self.candidate)
        report=_restore_inline_actual_text(source,candidate)
        self.assertEqual(1,len(report));self.assertEqual('\t',report[0]['actualText'])
        self.assertEqual('\t',_inline_scopes(candidate.pages[0])[0]['actualText'])
        self.assertEqual([], _restore_inline_actual_text(source,candidate))
    def test_inline_scope_cannot_hide_additional_painted_text_or_overwrite_authored_value(self):
        original=PdfWriter(clone_from=self.original);page=original.pages[0];stream=DecodedStreamObject()
        stream.set_data(page.get_contents().get_data().replace(b'(medica) Tj',b'/Span << /ActualText (\\t) >> BDC (medica) Tj EMC'))
        page[NameObject('/Contents')]=original._add_object(stream);data=io.BytesIO();original.write(data);source=PdfReader(data)
        candidate=PdfWriter(clone_from=self.candidate);_restore_inline_actual_text(source,candidate)
        stream=candidate.pages[0].get_contents();opening=_inline_scopes(candidate.pages[0])[0]['start']
        stream.operations[opening][0][1][NameObject('/ActualText')]=TextStringObject('\r');candidate.pages[0].replace_contents(stream)
        with self.assertRaisesRegex(ValueError,'existing_inline_actualtext_conflict'):_restore_inline_actual_text(source,candidate)
        candidate=PdfWriter(clone_from=self.candidate);stream=DecodedStreamObject()
        stream.set_data(candidate.pages[0].get_contents().get_data().replace(b'(medica) Tj',b'/Span << /ActualText (\\r) >> BDC (medica) Tj (extra) Tj EMC'))
        candidate.pages[0][NameObject('/Contents')]=candidate._add_object(stream)
        with self.assertRaisesRegex(ValueError,'single_inline_text_show_required'):_restore_inline_actual_text(source,candidate)
    def test_nonwhitespace_inline_override_requires_a_separate_language_aware_path(self):
        writer=PdfWriter(clone_from=self.original);page=writer.pages[0];stream=DecodedStreamObject()
        stream.set_data(page.get_contents().get_data().replace(b'(medica) Tj',b'/Span << /ActualText (French replacement) >> BDC (medica) Tj EMC'))
        page[NameObject('/Contents')]=writer._add_object(stream)
        with self.assertRaisesRegex(ValueError,'simple_inline_actualtext_required'):_inline_scopes(page)
    def test_full_restore_authorizes_only_exact_source_owned_new_inline_scope(self):
        for path,source in [(self.original,True),(self.candidate,False)]:
            writer=PdfWriter(clone_from=path);page=writer.pages[0];stream=DecodedStreamObject()
            replacement=b'/Span << /ActualText (\\t) >> BDC ( ) Tj EMC' if source else b'( ) Tj'
            stream.set_data(page.get_contents().get_data().replace(b'(medica) Tj',replacement));page[NameObject('/Contents')]=writer._add_object(stream)
            with path.open('wb') as handle:writer.write(handle)
        report=self.restore()
        self.assertEqual(1,len(report['restoredInlineScopes']))
        self.assertTrue(report['authoredActualTextAssociations']['passed'])
    def test_changed_paint_or_resource_is_rejected(self):
        writer=PdfWriter(clone_from=self.candidate);page=writer.pages[0];stream=DecodedStreamObject();stream.set_data(page.get_contents().get_data().replace(b'medica',b'change'));page[NameObject('/Contents')]=writer._add_object(stream)
        with self.candidate.open('wb') as handle:writer.write(handle)
        with self.assertRaisesRegex(ValueError,'painting_program_changed'):self.restore()
        self.assertFalse(self.output.exists())
    def test_invalid_hash_existing_output_and_signature_are_rejected(self):
        with self.assertRaisesRegex(ValueError,'source_hash_mismatch'):
            restore_authored_actual_text(self.original,self.candidate,self.output,expected_original_sha256='0'*64,expected_candidate_sha256=hashlib.sha256(self.candidate.read_bytes()).hexdigest())
        self.output=self.original
        with self.assertRaises(ValueError):self.restore()
        self.output=self.original.with_name('output.pdf');writer=PdfWriter(clone_from=self.original)
        field=writer._add_object(DictionaryObject({NameObject('/FT'):NameObject('/Sig'),NameObject('/T'):TextStringObject('Signature')}));writer.root_object[NameObject('/AcroForm')]=DictionaryObject({NameObject('/Fields'):ArrayObject([field])})
        with self.original.open('wb') as handle:writer.write(handle)
        with self.assertRaisesRegex(ValueError,'signed_pdf_not_supported'):self.restore()


if __name__=='__main__':unittest.main()
