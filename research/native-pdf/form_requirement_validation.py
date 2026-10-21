"""Verify one author-approved optional checkbox, retaining the prior repair chain."""
from __future__ import annotations

import copy
import json
from pathlib import Path

from pypdf.generic import NameObject, NumberObject

import verify_pdf as v
import form_label_validation as labels
from form_font_validation import compare_with_authorized_form_fonts

require=labels.require
LEDGER_KEYS={'schemaVersion','operation','sourcePath','sourceSha256','inputPath','inputSha256','outputSha256',
             'fontLedgerPath','fontLedgerSha256','authorDecisionPath','authorDecisionSha256','fieldPath',
             'widgetRef','tagId','beforeFlags','afterFlags','requiresFreshAudit','certification'}
DECISION_KEYS={'schemaVersion','candidateSha256','fieldPath','tooltip','clearRequired'}
MATERIALS_PATH=['materials']
MATERIALS_LABEL='Send workshop materials'


def read_bound_json(path,expected):
    path=Path(path)
    require(path.is_file() and path.stat().st_size<=512000,'form_requirement_evidence_size_limit')
    with path.open('rb') as handle:data=handle.read(512001)
    require(len(data)<=512000,'form_requirement_evidence_size_limit')
    require(v.digest(data)==expected,'form_requirement_evidence_hash_mismatch')
    result=json.loads(data.decode('utf-8-sig'))
    require(isinstance(result,dict),'form_requirement_evidence_object_required')
    return result


def authorize_form_requirement(original,final,ledger):
    require(isinstance(ledger,dict) and set(ledger)==LEDGER_KEYS
            and type(ledger.get('schemaVersion')) is int and ledger.get('schemaVersion')==1 and ledger.get('operation')=='native-form-requirement'
            and ledger.get('requiresFreshAudit') is True and ledger.get('certification') is False,
            'form_requirement_ledger_invalid')
    original,final,input_path=Path(original),Path(final),Path(ledger['inputPath'])
    source,sh=labels._snapshot(original);before,bh=labels._snapshot(input_path);after,ah=labels._snapshot(final)
    require(original.resolve()==Path(ledger['sourcePath']).resolve() and final.resolve() not in (original.resolve(),input_path.resolve())
            and (sh,bh,ah)==(ledger['sourceSha256'],ledger['inputSha256'],ledger['outputSha256']),
            'form_requirement_file_binding_mismatch')
    decision=read_bound_json(ledger['authorDecisionPath'],ledger['authorDecisionSha256'])
    require(set(decision)==DECISION_KEYS and type(decision.get('schemaVersion')) is int
            and decision.get('clearRequired') is True and decision=={'schemaVersion':1,'candidateSha256':bh,
            'fieldPath':MATERIALS_PATH,'tooltip':MATERIALS_LABEL,'clearRequired':True},
            'form_requirement_exact_author_decision_required')
    font_ledger=read_bound_json(ledger['fontLedgerPath'],ledger['fontLedgerSha256'])
    prior=compare_with_authorized_form_fonts(original,input_path,font_ledger)
    require(prior.get('passed') is True and prior.get('form_font_validation',{}).get('checksComplete') is True,
            'form_requirement_prior_font_chain_unverified')
    require(ledger['fieldPath']==MATERIALS_PATH,'form_requirement_field_not_authorized')
    keys=labels._refs([ledger['widgetRef']]);key=keys[0]
    fields=[labels._owners(reader) for reader in (before,after)]
    native=[labels._native_forms(reader,required=True) for reader in (before,after)]
    require(key in fields[0] and key in fields[1],'form_requirement_widget_missing')
    tag_id=ledger['tagId']
    require(isinstance(tag_id,str) and all(owners.get(key)==tag_id and forms[tag_id]['keys']==[key]
             for forms,owners,_ in native),'form_requirement_native_owner_mismatch')
    for field_map,(forms,_,_) in zip(fields,native):
        field,widget=field_map[key]
        require(list(field['path'])==MATERIALS_PATH and field['type']=='/Btn' and len(field['widgets'])==1
                and 0<=field['flags']<=0xFFFFFFFF and not(field['flags']&(32768|65536))
                and '/Opt' not in field['node'],'form_requirement_single_checkbox_required')
        require(field['tooltip']==forms[tag_id]['alt']==labels._text(widget.get('/Contents'))==MATERIALS_LABEL,
                'form_requirement_label_owner_mismatch')
        require('/Ff' in field['node'] and isinstance(field['node']['/Ff'],NumberObject)
                and int(field['node']['/Ff'])==field['flags'],'form_requirement_local_flags_required')
        normal=v.resolved(v.resolved(widget.get('/AP',{})).get('/N'))
        require(isinstance(normal,dict) and '/Off' in normal and len(normal)==2
                and field['value'] in normal and widget.get('/AS')==field['value'],
                'form_requirement_checkbox_states_unsupported')
    old,new=fields[0][key][0],fields[1][key][0]
    require(type(ledger['beforeFlags']) is int and type(ledger['afterFlags']) is int
            and ledger['beforeFlags']==old['flags'] and ledger['afterFlags']==new['flags']
            and old['flags']&2 and new['flags']==(old['flags']&~2),'form_requirement_only_required_bit_may_clear')
    saved_evidence=labels._saved_widget_evidence(fields[1],native[1])
    new['node'][NameObject('/Ff')]=old['node'].raw_get('/Ff')
    require(labels._document_graph(before)==labels._document_graph(after),'form_requirement_unlisted_native_change')
    pixels=[labels.initialized_form_pixels(path) for path in (input_path,final)]
    require(pixels[0]==pixels[1],'form_requirement_initialized_pixels_changed')
    for path,digest in ((original,sh),(input_path,bh),(final,ah),
            (Path(ledger['fontLedgerPath']),ledger['fontLedgerSha256']),
            (Path(ledger['authorDecisionPath']),ledger['authorDecisionSha256'])):
        require(v.digest(path.read_bytes())==digest,'form_requirement_input_changed_during_check')
    return {'passed':True,'checksComplete':True,'sourceSha256':sh,'inputSha256':bh,'outputSha256':ah,
            'fieldPath':MATERIALS_PATH,'widgetRef':dict(ledger['widgetRef']),'tagId':tag_id,
            'beforeFlags':old['flags'],'afterFlags':ledger['afterFlags'],'onlyRequiredBitCleared':True,
            'authorDecision':copy.deepcopy(decision),
            'authorDecisionSha256':ledger['authorDecisionSha256'],'priorFontLedgerSha256':ledger['fontLedgerSha256'],
            'allOtherNativeObjectsUnchanged':True,'initializedWidgetPixelsIdentical':True,
            'widgetEvidence':saved_evidence,'requiresFreshAudit':True,'certification':False},prior


def compare_with_authorized_form_requirement(original,final,ledger):
    report=v.compare_pdfs(Path(original),Path(final))
    evidence={'passed':False,'checksComplete':False,'findings':[],'certification':False}
    report['form_requirement_validation']=evidence
    try:
        require(not report.get('inspection_incomplete'),'form_requirement_strict_inspection_incomplete')
        checked,prior=authorize_form_requirement(original,final,ledger);evidence.update(checked)
        previous=prior['form_font_validation']['strictFindingsExplainedByVerifiedChain']
        # The exact graph proof above permits this one field behavior change.
        # Prior font/label exceptions retain their own independently checked chain.
        explained=[finding for finding in report['findings'] if finding in previous
                   or finding['code'] in {'form_fields_changed','catalog_behavior_changed','page_properties_changed'}]
        report['findings']=[finding for finding in report['findings'] if finding not in explained]
        evidence['strictFindingsExplainedByVerifiedChain']=explained
        for name in ('form_label_validation','form_order_validation','form_font_validation'):
            report[name]=copy.deepcopy(prior[name])
            report[name]['validatedIntermediateOutputSha256']=checked['inputSha256']
            report[name]['widgetEvidence']=checked['widgetEvidence']
            report[name]['widgetEvidenceAppliesToOutputSha256']=checked['outputSha256']
        report['structure']['authored_alternative_associations_verified']=prior['structure']['authored_alternative_associations_verified']
        report['preservation'].update(authorized_form_labels_verified=True,authorized_form_reading_order_verified=True,
            authorized_form_fonts_verified=True,authorized_form_requirement_verified=True,passed=not report['findings'])
        report['mechanical_checks_passed']=report['preservation']['passed'] and report['structure'].get('passed',False)
        report['passed']=(report['mechanical_checks_passed'] and report['structure'].get('checks_complete',False)
                         and not report['structure'].get('findings') and report['structure']['authored_alternative_associations_verified'])
    except Exception as error:
        evidence.update(passed=False,checksComplete=False)
        evidence['findings'].append({'severity':'error','code':str(error) if isinstance(error,v.InspectionError) else 'form_requirement_validation_failed'})
        report['passed']=report['mechanical_checks_passed']=report['preservation']['passed']=False
    return report
