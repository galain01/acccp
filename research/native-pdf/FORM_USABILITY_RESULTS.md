# Form usability results — 2026-10-21

The synthetic registration form now leaves “Send workshop materials” optional.
The Name field remains required. The repair clears only the checkbox's required
flag, using an explicit author decision and a hash-bound preservation check.

Actual Acrobat testing then exposed an editing-font problem that the previous
static render and machine checks had missed: an idle choice and focused text
field could display repeated incorrect characters while their stored values
remained correct. A separate embedded font for editing fixes the observed
display issue while preserving the original appearance streams and page layout.

The first Unicode-CID experiment worked in Acrobat but failed real PDFBox
saved-fill tests. The final font uses conventional glyph-ID CIDs, Identity
CID-to-GID mapping, genuine font widths and explicit Unicode mappings. See
[FORM_EDITING_TESTS.md](FORM_EDITING_TESTS.md) for the saved-edit regression.

## Completed automated evidence

- 500 Python research tests passed. The separately completed final PDFBox runner
  suite adds six distinct passing tests.
- 16 TypeScript audit, batch and page-policy tests passed; type checking passed.
- The final candidate passed all 23 real PDFBox saved-fill cases, covering all
  229 original encoding entries, accents, symbols, field boundaries and explicit
  unsupported-character refusals. The deliberate twenty-wide-letter case
  records overflow; arbitrary future text is not guaranteed to fit.
- Independent checks passed for the exact checkbox/font changes, protected
  native objects and unchanged original page pixels.
- The final candidate passed veraPDF's PDF/UA-1 machine checks.
- The fresh model audit retained one warning about missing final interactive
  and assistive-technology evidence. That run is preserved unchanged. The
  overall assessment remains blocked; no conformance or app-readiness claim is
  established.

## Actual desktop coverage

The test used Adobe Acrobat 26.2.21901.0 and portable NVDA 2026.2 on Windows,
with NVDA's desktop keyboard layout and English US David voice. NVDA Speech
Viewer supplied actual speech-output observations, separate from PDF tags.

On the checkbox-only candidate, Tab and Shift+Tab reached the fields in logical
order, the Name field was announced as required, the session choice exposed its
value, and the optional checkbox announced its unchecked/checked state. Arrow
keys changed the session and Space toggled the checkbox. That candidate still
had the visual editing-font defect described above.

On the first Unicode-font probe, accented text and symbols displayed correctly;
the choice and checkbox worked and a separate filled copy was saved. This probe
was superseded after the independent PDFBox test found its CID problem.

On the final candidate, Acrobat displayed the initialized form and the focused
Name field correctly. Final NVDA announcements, filling, save-and-reopen, and
broader table/chart/OCR reading checks were not completed. Testing stopped at
the user's request. Earlier successful observations are not silently applied
to the final file. Portable NVDA was closed after testing.

## Exact local evidence

The final file is outside Git:
`outputs/native-pdf-form-usability-2026-10-21/default-font-v2/registration-compatible-evaluation.pdf`
(workspace-relative), SHA256:
`232f6691d0b792a9b51821a404ed8cde8284989ddf4d3bc9cef4e5dde965ba88`.

The adjacent default-font ledger, repair bundle, independent checks,
`fresh-audit/` and `final-assessment/` bind the saved candidate. The sibling
`pdfbox-future-fill-v3/report.json` binds the final saved-fill results to the
candidate and runner hashes. Document-bearing reports remain outside Git.

This is a local research implementation. Native PDF repair remains outside the
application, and no release or deployment was made.
