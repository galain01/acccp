import hashlib,json,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
from repair_validation import compare_with_authorized_repairs,_appendix_source_evidence


class RepairLedgerCompositionTests(unittest.TestCase):
    def setUp(self):
        temp=tempfile.TemporaryDirectory();self.addCleanup(temp.cleanup);self.root=Path(temp.name)
        self.source=self.root/'source.pdf';self.final=self.root/'final.pdf'
        self.source.write_bytes(b'source');self.final.write_bytes(b'final')
        self.bundle=self.root/'bundle.json'
        self.nav={'candidateSha256':'baseline'};self.appendix={'inputSha256':'baseline','outputSha256':hashlib.sha256(b'final').hexdigest()}
        (self.root/'nav.json').write_text(json.dumps(self.nav));(self.root/'appendix.json').write_text(json.dumps(self.appendix))
        self.bundle.write_text(json.dumps({'schemaVersion':1,'navigationManifest':'nav.json','appendixManifest':'appendix.json'}))

    def test_navigation_rebind_requires_exact_appendix_chain(self):
        with patch('description_appendix_validation.compare_with_authorized_appendix',return_value={'passed':True}) as verify:
            result=compare_with_authorized_repairs(self.source,self.final,self.bundle)
            self.assertTrue(result['passed'])
            self.assertEqual(verify.call_args.args[3]['candidateSha256'],hashlib.sha256(b'final').hexdigest())
        self.appendix['inputSha256']='another candidate';(self.root/'appendix.json').write_text(json.dumps(self.appendix))
        with self.assertRaisesRegex(ValueError,'chain_mismatch'):compare_with_authorized_repairs(self.source,self.final,self.bundle)

    def test_validator_failure_is_retained(self):
        with patch('description_appendix_validation.compare_with_authorized_appendix',return_value={'passed':False,'findings':[{'code':'changed'}]}):
            result=compare_with_authorized_repairs(self.source,self.final,self.bundle)
            self.assertFalse(result['passed']);self.assertEqual(result['findings'][0]['code'],'changed')

    def test_inputs_and_ledgers_cannot_change_during_verification(self):
        def mutation(*args):
            self.final.write_bytes(b'changed');return {'passed':True}
        with patch('description_appendix_validation.compare_with_authorized_appendix',side_effect=mutation):
            with self.assertRaisesRegex(ValueError,'evidence_changed'):compare_with_authorized_repairs(self.source,self.final,self.bundle)

    def test_unknown_authorization_fields_rejected(self):
        self.bundle.write_text(json.dumps({'schemaVersion':1,'navigationManifest':'nav.json','ignoreFailures':True}))
        with self.assertRaisesRegex(ValueError,'explicit_repair_bundle_required'):compare_with_authorized_repairs(self.source,self.final,self.bundle)

    def test_scan_and_form_exceptions_require_their_own_verifier_and_bundle(self):
        for key,target in [('ocrManifest','scan_ocr_validation.compare_with_authorized_ocr'),
                           ('formLabelManifest','form_label_validation.compare_with_authorized_form_labels'),
                           ('formOrderManifest','form_order_validation.compare_with_authorized_form_order'),
                           ('formFontManifest','form_font_validation.compare_with_authorized_form_fonts'),
                           ('formRequirementManifest','form_requirement_validation.compare_with_authorized_form_requirement'),
                           ('formDefaultFontManifest','form_default_font_validation.compare_with_authorized_form_default_font')]:
            with self.subTest(key=key):
                self.bundle.write_text(json.dumps({'schemaVersion':1,key:'nav.json'}))
                with patch(target,return_value={'passed':False,'findings':[{'code':'exact_check_failed'}]}) as verify:
                    result=compare_with_authorized_repairs(self.source,self.final,self.bundle)
                    self.assertFalse(result['passed'])
                    self.assertEqual(verify.call_args.args,(self.source,self.final,self.nav))
                    self.assertEqual(result['repair_evidence']['validatedLedgers'],[key])
                self.bundle.write_text(json.dumps({'schemaVersion':1,key:'nav.json','appendixManifest':'appendix.json'}))
                with self.assertRaisesRegex(ValueError,'separate_explicit_bundle'):
                    compare_with_authorized_repairs(self.source,self.final,self.bundle)

    def evidence_ledger(self,data=b'{"rows": [["All", 44.5]]}'):
        evidence=self.root/'evidence.json';evidence.write_bytes(data)
        return {'approvedManifest':{'evidence':[{'id':'supplement','sha256':hashlib.sha256(data).hexdigest()}]},
                'evidenceFiles':{'supplement':str(evidence)}}

    def test_source_text_and_hash_reach_auditor_without_local_paths(self):
        ledger=self.evidence_ledger();result=_appendix_source_evidence(ledger)
        self.assertEqual(result['items'][0]['text'],'{"rows": [["All", 44.5]]}')
        self.assertNotIn(str(self.root),json.dumps(result))
        self.assertIn('not factual accuracy',result['interpretation'])

    def test_changed_source_evidence_rejected(self):
        ledger=self.evidence_ledger();(self.root/'evidence.json').write_bytes(b'changed')
        with self.assertRaisesRegex(ValueError,'hash_mismatch'):_appendix_source_evidence(ledger)

    def test_oversized_source_evidence_rejected(self):
        with self.assertRaisesRegex(ValueError,'size_limit'):_appendix_source_evidence(self.evidence_ledger(b'x'*(128*1024+1)))

    def test_pdf_evidence_is_not_decoded_as_text(self):
        ledger=self.evidence_ledger();ledger['evidenceFiles']['supplement']=str(self.source)
        self.assertEqual(_appendix_source_evidence(ledger)['items'],[])


if __name__=='__main__':unittest.main()
