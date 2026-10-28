# Static W-4 form support

The 2026 blank IRS W-4 now completes native PDF repair and its independent model
audit. The application preserves the five original pages and all 48 form controls.
This follows the earlier corpus run, where this file stopped before model work.
It does not establish PDF/UA conformance or completed interaction testing.

## Supported form variants

Admission recognizes three additional bounded variants of the existing static
XFA/AcroForm path:

- One empty XFDF annotation envelope, with its original namespace and optional
  `xml:space="preserve"`. Populated annotations, fields, external references,
  unknown attributes and processing instructions remain unsupported.
- Up to three identical copies of the already recognized legacy checkbox
  handler in a checkbox's `mouseUp` event. Recognition never executes,
  deduplicates or rewrites the script. Different programs or additional behavior
  remain unsupported.
- Embedded monochrome, uncompressed BMP drawings in a native XFA
  `subform/draw/value/image`. Header, dimensions, palette, byte count and optional
  exact zero alignment padding are checked. Other image encodings, field images,
  malformed data and external resources remain unsupported.

All original XFA packets, scripts, bitmap data, field values, bindings and widget
positions remain protected. Preparation copies authored descriptions to absent
standard-PDF field labels and enables the existing supported speech prompts.
Only verified obsolete Adobe Reader usage rights are removed from the repaired
copy. The uploaded source remains unchanged.

## Preservation and processing time

The dense worksheet revealed repeated extraction of graphics-only content.
Disposable text views now omit known text-independent painting instructions and
avoid decoding scopes that the complete native scan proves contain no text-show
instruction. Fonts, transforms, text state, unknown instructions, ownership and
the complete original painting remain independently checked. Paragraphs without
possible page-local note targets no longer trigger futile isolated-marker
decoding; supported note/reference discovery remains unchanged.

Fresh private inspections of exact saved bytes can be shared within one native
request. Separate saved versions receive new inspections; dictionaries,
subclasses, other readers and changed input bytes cannot substitute for evidence.
Both original-to-candidate and original-to-output preservation comparisons still
run. Hybrid normalization retains its separate independent verification.

Structural writers also preserve parsed floating-point operands with local
round-trip decimal serialization. This prevents tag edits from rounding an
unrelated image transform elsewhere on the page. No global pypdf setting or
general geometric tolerance was changed.

Model evidence uses a documented compact hierarchy and summaries of redundant
ownership indexes. Assigned semantic content, descriptions, candidate context,
form labels, current machine findings and complete page/tag audit coverage remain.
Writer-only expected-state snapshots stay in immutable application state and are
attached after plan validation. All model calls, including failed attempts, retain
the existing usage/cost accounting. File, page, operator, native 90-second,
four-request model-pool and application 260-second bounds are unchanged.

## Local verification on 2026-10-28

The final real `repairNativePdf` run, using `gpt-6.1-sol-2026-09-29` for both
stages, completed in **229.342 seconds**. Preparation took about 27 seconds and
native repair about 46 seconds. All **22** completed model calls are recorded:
11 repair and 11 audit calls, **3,233,324 tokens**, **USD 5.3014592** as reported
by the gateway. The final audit covered every assigned page and tag. Including
the earlier failed and incomplete runs, this follow-up used 48 recorded calls,
6,496,065 tokens and USD 12.0007236.

Independent reopening of the exact final output confirmed:

- Identical pixels at 1.5 scale on all five pages, unchanged page boxes and
  rotation, and identical extracted page text.
- All 48 terminal fields retained their names, types, values, flags, widget
  positions and checkbox states. All have descriptions, and the 48 existing
  supported speech prompts were enabled.
- XFA packet order and all non-template packet bytes are unchanged. The template
  has the same elements, text, scripts and embedded image data; its only changes
  are the 48 supported speech-disable settings.
- The original source hash still matches the acceptance manifest and the final
  output hash matches the model/audit report.

The final output retains **11 error findings and 7 warnings**. In particular,
the wide worksheet tables on page 5 still lack complete higher-paying-job row
header relationships. Font/character mappings, two untagged-content checks,
some list/heading semantics and one field's shared eligibility context remain
visible. Signing, dating and other interactive behavior have not been verified
for this W-4. The desktop check was stopped with Escape; no new screen-reader
test or interaction-evidence registry entry was added. A completed repair is
not described as a conformant document.

Local checks passed 2,303 application tests, 477 native tests (one existing
POSIX-only skip on Windows), 111 related research/navigation tests, TypeScript,
changed-code ESLint and formatting. The CI workflow also runs the new extraction
budget regressions and the existing unprivileged Linux worker-image smoke.

Evidence is outside Git under `local-validation/w4-e2e-verified-20261028/`,
`w4-final-independent/` and the corresponding test logs. The full run uses the
same repair/audit function as the application through its authenticated local
worker; it does not establish a new browser upload/download test for this file.
No production database, storage bucket, deployment or document was changed.
The temporary worker stopped, and its random authentication key was never saved.
