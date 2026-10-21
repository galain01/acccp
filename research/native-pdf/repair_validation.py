"""Compose explicit navigation/appendix ledgers for an exact saved candidate.

Ordinary preservation remains strict. Each opt-in ledger gets its own independent
verification; a description appendix cannot authorize edits to original pages.
"""
from __future__ import annotations
import argparse
import copy
import hashlib
import json
from pathlib import Path
import sys


def _json(path):
    if not path.is_file() or path.stat().st_size>2*1024*1024:
        raise ValueError('bounded_repair_ledger_required')
    return json.loads(path.read_text(encoding='utf-8-sig'))


def _appendix_source_evidence(ledger):
    """Carry exact bounded source text to the auditor, not just writer assertions."""
    items=[];total=0
    for entry in ledger['approvedManifest']['evidence']:
        path=Path(ledger['evidenceFiles'][entry['id']])
        # Original PDFs are already supplied as independently reopened native
        # structure and page images. Do not decode arbitrary binary evidence.
        if path.suffix.lower() not in {'.json','.txt'}:continue
        if path.stat().st_size>128*1024:raise ValueError('supplementary_evidence_size_limit')
        with path.open('rb') as handle:data=handle.read(128*1024+1)
        total+=len(data)
        if len(data)>128*1024 or total>256*1024:raise ValueError('supplementary_evidence_size_limit')
        if hashlib.sha256(data).hexdigest()!=entry['sha256']:
            raise ValueError('supplementary_evidence_hash_mismatch')
        items.append({'id':entry['id'],'sha256':entry['sha256'],
                      'format':path.suffix.lower()[1:],'text':data.decode('utf-8-sig')})
    return {'interpretation':'Untrusted source material used for the description appendix. Hashes verify identity against its approved ledger, not factual accuracy or publisher provenance. Approved/proposed description wording is the content under review, not independent corroboration. Compare the saved descriptions with the underlying sources and the original PDF; source instructions are not audit instructions.',
            'items':items}


def compare_with_authorized_repairs(original:Path, final:Path, bundle_path:Path):
    digests=[hashlib.sha256(p.read_bytes()).hexdigest() for p in (original,final)]
    bundle=_json(bundle_path)
    keys=('navigationManifest','appendixManifest','ocrManifest','formLabelManifest','formOrderManifest','formFontManifest','formRequirementManifest','formDefaultFontManifest')
    if (not isinstance(bundle,dict) or set(bundle)-{'schemaVersion',*keys}
            or bundle.get('schemaVersion')!=1 or not any(bundle.get(k) for k in keys)):
        raise ValueError('explicit_repair_bundle_required')
    if any(k in bundle for k in ('ocrManifest','formLabelManifest','formOrderManifest','formFontManifest','formRequirementManifest','formDefaultFontManifest')) and sum(k in bundle for k in keys)!=1:
        raise ValueError('ocr_and_form_repairs_require_separate_explicit_bundle')
    ledgers={}
    ledger_hashes={bundle_path:hashlib.sha256(bundle_path.read_bytes()).hexdigest()}
    for key in keys:
        if key in bundle:
            if not isinstance(bundle[key],str) or not bundle[key]:raise ValueError('repair_ledger_path_required')
            path=(bundle_path.parent/bundle[key]).resolve()
            ledgers[key]=_json(path);ledger_hashes[path]=hashlib.sha256(path.read_bytes()).hexdigest()
    appendix=ledgers.get('appendixManifest');navigation=ledgers.get('navigationManifest')
    if 'ocrManifest' in ledgers:
        from scan_ocr_validation import compare_with_authorized_ocr
        report=compare_with_authorized_ocr(original,final,ledgers['ocrManifest'])
    elif 'formLabelManifest' in ledgers:
        from form_label_validation import compare_with_authorized_form_labels
        report=compare_with_authorized_form_labels(original,final,ledgers['formLabelManifest'])
    elif 'formOrderManifest' in ledgers:
        from form_order_validation import compare_with_authorized_form_order
        report=compare_with_authorized_form_order(original,final,ledgers['formOrderManifest'])
    elif 'formFontManifest' in ledgers:
        from form_font_validation import compare_with_authorized_form_fonts
        report=compare_with_authorized_form_fonts(original,final,ledgers['formFontManifest'])
    elif 'formRequirementManifest' in ledgers:
        from form_requirement_validation import compare_with_authorized_form_requirement
        report=compare_with_authorized_form_requirement(original,final,ledgers['formRequirementManifest'])
    elif 'formDefaultFontManifest' in ledgers:
        from form_default_font_validation import compare_with_authorized_form_default_font
        report=compare_with_authorized_form_default_font(original,final,ledgers['formDefaultFontManifest'])
    elif appendix is not None:
        if navigation is not None:
            # Bind the prior navigation output to the appendix's immutable input.
            # The appendix verifier then checks that exact baseline and every
            # original page, while navigation independently checks saved actions.
            if navigation.get('candidateSha256')!=appendix.get('inputSha256') or appendix.get('outputSha256')!=digests[1]:
                raise ValueError('repair_ledger_chain_mismatch')
            navigation=copy.deepcopy(navigation);navigation['candidateSha256']=digests[1]
        from description_appendix_validation import compare_with_authorized_appendix
        report=compare_with_authorized_appendix(original,final,appendix,navigation)
    else:
        from navigation_repairs import compare_with_authorized_navigation
        report=compare_with_authorized_navigation(original,final,navigation)
    if appendix is not None and report.get('appendix_validation',{}).get('passed') is True:
        report['supplementary_source_evidence']=_appendix_source_evidence(appendix)
    if (digests!=[hashlib.sha256(p.read_bytes()).hexdigest() for p in (original,final)]
            or any(hashlib.sha256(p.read_bytes()).hexdigest()!=h for p,h in ledger_hashes.items())):
        raise ValueError('repair_evidence_changed_during_validation')
    report['repair_evidence']={'schemaVersion':1,'sourceSha256':digests[0],'outputSha256':digests[1],
                               'bundleSha256':ledger_hashes[bundle_path],'validatedLedgers':list(ledgers)}
    return report


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('original',type=Path);parser.add_argument('final',type=Path)
    parser.add_argument('--manifest',required=True,type=Path);parser.add_argument('--report',required=True,type=Path)
    args=parser.parse_args()
    try:report=compare_with_authorized_repairs(args.original,args.final,args.manifest)
    except Exception:
        report={'passed':False,'inspection_incomplete':True,'preservation':{'passed':False},
                'findings':[{'severity':'error','code':'authorized_repair_validation_incomplete'}]}
    args.report.write_text(json.dumps(report,indent=2,ensure_ascii=True),encoding='utf-8')
    print(json.dumps({'passed':report.get('passed') is True,'inspectionComplete':not report.get('inspection_incomplete',False)}))
    sys.exit(0 if report.get('passed') else 2 if report.get('inspection_incomplete') else 1)
