# Scanned text and form repair results

The later [form-font follow-up](FORM_FONT_RESULTS.md) resolves the font failures
recorded below. The remaining checkbox requirement still needs author review.
This report retains the earlier candidates and their original results.

The 2026-10-21 follow-up fixes missing or incorrect hidden text in a bounded
text-only scan workflow and restores authored form descriptions. It also repairs
an audited form reading-order defect without changing visible pages or controls.
All work remains local on `feature/native-pdf-repair`; no app route, database,
production service or deployment changed.

## Saved-file results

Each final candidate was reopened independently, checked for native text/tag
ownership and source preservation, validated with veraPDF 1.30.3's explicit
PDF/UA-1 profile, and audited against its original page images. The audit records
both source and candidate hashes. Every scanned page needs an explicit fresh
OCR-accuracy and text-only-content verdict; an ordinary clean audit is insufficient.

| Case | Pages | Source appearance | Failed UA1 checks | Final semantic findings | Assessment |
| --- | ---: | --- | ---: | ---: | --- |
| Image-only scan | 1 | Identical | 0 | 0 | Automated checks pass; manual review required |
| Scan with correct hidden text | 1 | Identical | 0 | 0 | Automated checks pass; manual review required |
| Scan with incorrect hidden text | 1 | Identical | 0 | 0 | Automated checks pass; manual review required |
| Dense fictional scan | 2 | Identical | 0 | 0 | Automated checks pass; manual review required |
| Interactive registration form | 1 | Identical, including initialized controls | 3 | 1 | Blocked |

The first three cases share one visible page and test missing/correct/incorrect
layers rather than broad recognition accuracy. In the incorrect case, the old
hidden text said “Submit ten pages. Deadline December 30.” The saved text now
matches the visible page: “Submit one page. Deadline October 30.” No duplicate
old reading layer remains.

The two-page scan has 50 lines of fictional prose rendered at 200 dpi. All saved
lines match independent known source text after whitespace normalization,
including dates, money, decimals, negation and accented words. Source-image review
corrected Tesseract's `naive` to the visible `naïve` before writing.

A separate image-only chart tested the boundary of this route. The model identified
bar heights, spatial labels and legend colors as meaningful information absent
from plain OCR. It returned six review notes with `textOnly=false`; the writer
refused that plan and created no candidate. This test demonstrates a correct
stop, not chart remediation.

## Form labels and the remaining ambiguity

The registration form now has six useful descriptions in place of `Annotation`:
three Form alternatives and three widget descriptions, copied from each actual
terminal field's authored tooltip. A parent field group's tooltip is never
treated as an individual child's label. Ambiguous radio/button choices, missing
labels and unsupported XFA remain review cases.

The first fresh audit found that the generated tag order placed every label
before every control. A separate repair paired each exact visible label with its
control, using the source geometry and audit finding. The final order is title,
name label/input, session label/choice, then materials checkbox/label. A separate
ledger and independent check authorize only that anchored sibling permutation;
the earlier label ledger remains bound to its original saved file.

The final audit no longer reports generic labels or the reading-order defect.
It found an ambiguity already present in the original: “Send workshop materials”
looks optional, but the checkbox's required flag is set. Making it optional or
changing the visible wording requires knowing the author's intention. The repair
retains the original flag and reports the issue.

veraPDF reports two pre-existing unembedded Helvetica fonts in widget appearance
streams, plus the absent PDF/UA identifier. Form appearance/default fonts with
custom encodings are outside the current font substitution helper. The form
therefore has no overall automated pass or conformance declaration. Adding an
identifier alone would not resolve its font or semantic defects.

Independent checks preserve terminal field identities, types, required/read-only
flags, values, choices, actions, widget states, appearance streams, and tag/object
ownership. Programmatic fill tests saved a new text value, selected another
session, and checked the box in both original and repaired copies. Values and
initialized-form renderings matched; controls were not flattened. Keyboard and
screen-reader operation still need hands-on testing.

## Verification and support limits

- 428 Python regression tests passed, with no failures or skips.
- 21 TypeScript research tests passed; repository TypeScript checking passed.
- Fresh assessments of the two previously repaired CDC PDFs still pass their
  machine/preservation gates with the existing exact-hash audits. Their candidate
  bytes were unchanged.
- Tampering tests cover wrong text, visible/clipping text, altered raster payloads,
  misplaced text, stale source/review hashes, unrelated PNGs, transparency, hidden
  PNG metadata/trailing data, wrong field labels, unresolved button choices,
  changed field values, broken native ownership, and unauthorized sibling moves.

OCR recognition uses local Tesseract.js 7.0.0 with pinned English language data.
The source-image review and independent final audit use the configured
institutional LiteLLM model; every call's usage/cost evidence stays in the private
local report directories. Only fresh renders of the specified source and bounded
OCR fields are sent for source review. The child OCR/preflight processes receive
no API credentials.

The scan subset is English, one-column text with ordinary headings/paragraphs,
at most eight pages and 4 MiB, with one unrotated full-page raster per page. Lists,
tables, meaningful graphics, handwriting, mixed visible native text, clipping
text, unusual geometry, forms, signatures and encryption need other handling.
The engine does not rasterize arbitrary PDFs to force them into this subset.

The target remains PDF/UA-1 (ISO 14289-1:2014). Every assessment records
`standardConformanceEstablished=false` and `readyForApp=false`. Automated passes
still require the human checkpoints in the existing manual review protocol;
these samples do not establish support for all PDFs.

## Local evidence

Paths below are relative to the workspace containing this checkout:

- `outputs/native-pdf-ocr-2026-10-21/`: source OCR/review evidence, four final
  `evaluation-candidate.pdf` files, final audits, repair bundles, assessments,
  known-text comparison, and the chart refusal result.
- `outputs/native-pdf-form-labels-2026-10-21/`: `registration-ordered.pdf`, original
  and order ledgers, `ordered-audit/`, final `assessment/`, and initialized-control
  fill evidence.
- `outputs/native-pdf-scan-form-tests-2026-10-21/`: chart fixture, previous CDC
  regression assessments, and the final local results summary.

Implementation, setup and reproduction are described in [SCAN_OCR.md](SCAN_OCR.md)
and [FORM_REPAIR.md](FORM_REPAIR.md). Sources, generated PDFs, model responses,
tool binaries, installed OCR packages and credentials stay outside Git.
