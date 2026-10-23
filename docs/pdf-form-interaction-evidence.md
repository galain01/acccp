# Prior PDF form interaction tests

The native PDF pipeline can recognize a form whose interactive behavior was previously tested in Acrobat and NVDA. It shows the recorded checks separately from remaining review questions. This avoids repeatedly asking an instructor to perform the same checks while retaining actual defects and untested interactions.

## What matches

`lib/native-pdf-interaction-evidence.ts` contains a reviewed, versioned application registry. A record requires the exact original upload SHA-256 and a matching fingerprint of the saved output's form behavior. The W-9 record covers the blank March 2024 form tested on October 22–23, 2026, in Adobe Acrobat 64-bit on Windows with NVDA 2026.2. Version 3 includes control-by-control observations from the production download, independent verification of the saved fictional test copies, and Acrobat/NVDA reopening checks for every classification choice. The displayed test date is the last verification date; it does not imply that all checks were repeated that day.

The worker computes the fingerprint from the reopened PDF. It covers the supported AcroForm/XFA form graph, labels and speech settings, scripts, values, widget and annotation order, navigation-related structure, and relevant document/page settings. Object numbering and unrelated page content/tag repairs can change without changing the fingerprint. Ambiguous or unsupported fingerprint inputs produce no match. Source identity, preservation checks, complete inspection, page/field counts, and current field identities must also agree.

Matching runs after preparation and again after final repair. A prepared match cannot authorize the final result when its form behavior changes. Matching is never based on filename, PDF claims about past tests, or model assertions. A different or filled source PDF needs its own reviewed evidence; the initial record does not automatically cover every W-9.

## Recorded W-9 coverage

| Interaction | Recorded coverage |
| --- | --- |
| Spoken descriptions | NVDA announced all 23 original form controls, including the name requirement and each SSN/EIN segment |
| Keyboard navigation | Tab reached all 23 original form controls |
| Checkbox operation | Keyboard operation of all seven classification choices and the independent line 3b checkbox; changing classification cleared the previous choice |
| Text entry | Fictional values entered in all 15 text fields |
| Save and reopen | All 15 text values and all eight checkbox choices retained after reopening. NVDA announced the five classification selections reopened on October 23, and the recorded tests also include announcements of the saved business value, LLC code and SSN middle-segment value |

The broad reminder about untouched controls is removed. On October 23, the Individual/sole proprietor, S corporation, Partnership, Trust/estate and LLC snapshots were each reopened in Acrobat; their choices remained visibly selected and NVDA announced the checked state after keyboard navigation. The LLC code also remained present and was announced. Together with the earlier tests, these observations cover saving and reopening all 23 original controls, so the classification-reopening reminder is removed. Signing, dating and crossing out certification item 2 remain separate from those controls. Missing signature widgets alone do not establish that an accessible completion method is unavailable.

The signing test entered a fictional signature through Acrobat's controls, but placement used a mouse. The saved and reopened signature was visible. Independent inspection found a graphic without an accessible text alternative, and Acrobat had marked the original fields read-only after signing. This establishes neither keyboard-only placement nor screen-reader verification of the saved signature. The app retains a precise signing review explaining that remaining limitation.

Dating and certification cross-out were investigated on October 23 using a fresh unsigned test copy. Acrobat's Add text and line tools were unavailable, and NVDA announced the unavailable tool state. The Comments panel also reported that this form did not allow comments or other changes. Document properties showed no security and allowed commenting, filling and signing, alongside a note that the PDF form restricts some operations. These observations establish the tested tools' unavailability; they do not establish a password restriction or rule out every alternative completion method. The app retains separate date and item-2 cross-out reviews with these specific limitations. Neither action is recorded as passed. These are completion-method checks; they do not describe the original repaired form fields as broken.

Independent verification confirmed all 23 fields in the full saved copy: each expected native value agreed with XFA data and its appearance; all original labels, speech settings, field flags, widget geometry and order were retained. The exact XFA template and six-page count were unchanged. These checks establish persisted data and form metadata. Keyboard and NVDA observations supply the separate interaction evidence; they do not follow from static field counts or file inspection.

The UI section **Previously tested form behavior** shows the date, environment, observed checks, and coverage limits. `screenReaderTestPerformed` remains `false` for the current conversion; the separate prior-test record does not claim a fresh interactive test or PDF/UA conformance.

## Review reconciliation

Both model stages receive only the app-matched record for their current saved PDF. The prompts distinguish an observed problem from a request to perform an unrecorded test.

Requests based solely on missing test evidence use `code: "form-interaction-review"` with a validated `interactionReview` object (`basis: "not-tested"`, a supported action, and exact current field IDs). Ordinary field actions require existing IDs on the assigned page. Signing, dating, and certification cross-out use a precise page/location and no field IDs. Errors and concrete defects must use ordinary findings.

For a matched W-9, the registry's specific remaining review items replace the worker's blanket interaction reminder. A typed model request is consolidated only when every requested action/field is explicitly covered by a recorded test or a displayed remaining-review item. Signing, dating, and crossing out require an explicit action match. Page overlap alone never establishes a duplicate. For unmatched forms, the existing worker reminder stays. Unknown, free-text, mixed, malformed, and concrete-defect findings remain visible; machine defects and incomplete audits cannot be cleared by this evidence.

## Persistence and retention

The bounded public summary is stored with the review JSON and the successful job event, including the attempt number. Reload reads only the current attempt's successful result; a retry clears prior UI evidence. No database migration is needed. Existing saved reports are not rewritten; they receive the new behavior after reconversion.

Job summaries and review artifacts follow the document's existing 14-day retention period. The source-controlled registry contains hashes and nonpersonal test observations only. Raw PDFs, entered values, screenshots, speech logs, and local evaluation reports stay outside Git. The registry is a maintained record of tested software behavior, not an archive of user documents.

## Adding or changing evidence

1. Test a known saved PDF in the named reader and assistive technology. Record exactly which controls and actions passed, including save/reopen where claimed.
2. Keep the tested blank output and saved test-copy hashes with the local evidence. Do not check entered values or document contents into Git.
3. Compute the fingerprint using the current worker helper, verify it against the actual tested file, and create a reviewed registry record with exact source identity and field names.
4. List all remaining interaction categories explicitly. Never broaden partial observations into all-control or cross-reader claims.
5. Test source/fingerprint mismatches, final-output rematching, duplicate consolidation, actual-defect preservation, persistence, and UI presentation. Run a real conversion to verify both model stages receive the intended scope.

A fingerprint schema change requires recomputing and reviewing registry matches against the tested files. New unrelated forms remain unverified until corresponding evidence exists.
