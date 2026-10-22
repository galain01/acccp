# Prior PDF form interaction tests

The native PDF pipeline can recognize a form whose interactive behavior was previously tested in Acrobat and NVDA. It shows the recorded checks separately from remaining review questions. This avoids repeatedly asking an instructor to perform the same checks while retaining actual defects and untested interactions.

## What matches

`lib/native-pdf-interaction-evidence.ts` contains a reviewed, versioned application registry. A record requires the exact original upload SHA-256 and a matching fingerprint of the saved output's form behavior. The initial record covers the blank March 2024 W-9 tested on October 22, 2026, in Adobe Acrobat 64-bit on Windows with NVDA 2026.2.

The worker computes the fingerprint from the reopened PDF. It covers the supported AcroForm/XFA form graph, labels and speech settings, scripts, values, widget and annotation order, navigation-related structure, and relevant document/page settings. Object numbering and unrelated page content/tag repairs can change without changing the fingerprint. Ambiguous or unsupported fingerprint inputs produce no match. Source identity, preservation checks, complete inspection, page/field counts, and current field identities must also agree.

Matching runs after preparation and again after final repair. A prepared match cannot authorize the final result when its form behavior changes. Matching is never based on filename, PDF claims about past tests, or model assertions. A different or filled source PDF needs its own reviewed evidence; the initial record does not automatically cover every W-9.

## Recorded W-9 coverage

| Interaction | Recorded coverage |
| --- | --- |
| Spoken descriptions | Required name; Individual/sole proprietor and C corporation choices; SSN middle/last and EIN last segments |
| Keyboard navigation | Name, business name, and the first two classification choices |
| Checkbox operation | Space selected Individual/sole proprietor, then C corporation; the first selection cleared |
| Text entry | Fictional name and all five SSN/EIN segments |
| Save and reopen | Those entered values and the selected C corporation choice persisted; the SSN middle segment's label and value were announced |

Two specific review items remain for a matching W-9: controls and spoken descriptions not covered above, and the accepted keyboard/screen-reader methods for signing, dating, and crossing out certification item 2. Navigation to business name is covered; its announcement, entry, and saving still need checking. Keyboard navigation among SSN/EIN segments and persistence of a selected Individual/sole proprietor choice also remain unrecorded. Missing signature widgets alone do not establish that an accessible completion method is unavailable.

The UI section **Previously tested form behavior** shows the date, environment, observed checks, and coverage limits. `screenReaderTestPerformed` remains `false` for the current conversion; the separate prior-test record does not claim a fresh interactive test or PDF/UA conformance.

## Review reconciliation

Both model stages receive only the app-matched record for their current saved PDF. The prompts distinguish an observed problem from a request to perform an unrecorded test.

Requests based solely on missing test evidence use `code: "form-interaction-review"` with a validated `interactionReview` object (`basis: "not-tested"`, a supported action, and exact current field IDs). Ordinary field actions require existing IDs on the assigned page. Signing, dating, and certification cross-out use a precise page/location and no field IDs. Errors and concrete defects must use ordinary findings.

For a matched W-9, the two registry review items replace the worker's blanket interaction reminder. A typed model request is consolidated only when every requested action/field is explicitly covered by a recorded test or a displayed remaining-review item. Signing, dating, and crossing out require an explicit action match. Page overlap alone never establishes a duplicate. For unmatched forms, the existing worker reminder stays. Unknown, free-text, mixed, malformed, and concrete-defect findings remain visible; machine defects and incomplete audits cannot be cleared by this evidence.

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
