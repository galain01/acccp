# Form-font repair results

The 2026-10-21 follow-up embeds the registration form's two missing font programs
using unmodified Liberation Sans 2.1.5. It updates three resource locations: the
form defaults and the text/choice appearances. The page, controls, labels, values,
required flags and reading order remain intact. This work is local on
`feature/native-pdf-repair`.

## Saved PDF checks

Independent verification checks all 229 defined character mappings in each
repaired resource and compares declared widths with the actual embedded font.
Existing appearance text has exactly the same character origins and font sizes.
The small glyph-shape differences stay within checked character regions; zero
pixels change outside those regions, including the initialized form controls.
Every other native PDF object is compared after undoing only the recorded font
replacement in memory.

The base candidate has **zero font failures** in veraPDF 1.30.3's PDF/UA-1 profile.
Its sole machine failure is the intentionally absent PDF/UA identification entry.
A separate evaluation copy, with that entry explicitly staged, has **zero failed
rules and zero failed checks**. The staging verifier checks the exact metadata
addition and retains the complete prior font/label/order evidence chain.

Fresh audits of both the base and evaluation candidates report one remaining issue on page 1:
“Send workshop materials” looks optional, but its saved required flag is set.
The font repair preserves that flag. Resolving it requires knowing whether the
author intends the option to be mandatory; a font fix cannot establish that.

## Editing checks

Seven separately saved cases exercise the current value, ordinary replacement
text, accented names, currency/punctuation/ligatures, the five symbols with new
widths, and values near or beyond the field boundary. Tests also select the other
session and change the checkbox state. Reopened values and appearances agree,
and regenerated text uses the embedded font rather than a fallback.

The five symbols `¯ ± µ · ÷` use Liberation's genuine widths when newly entered.
They are absent from all existing appearances in this candidate. The writer
rejects a source that already uses one of these changed advances in an appearance
being repaired. Current text therefore retains its exact spacing; arbitrary
future text is not claimed to have identical spacing in both fonts.

The fixed-size name field fits 19 `W` characters and clips a twentieth in both
source and repaired files. The same final character clips; its outline extends
0.084 pt farther past the boundary with the replacement font. The evidence
records that measured difference instead of claiming identical overflow.
A standalone macron at the left edge also slightly exceeds the test filler's
inner clipping boundary in both fonts. This boundary case stays explicit; a
short prefixed symbol string tests supported characters without that existing
edge condition. The checks do not promise that arbitrary input fits every field.
Pypdf's test filler also regenerates text/choice appearances without their blue
backgrounds and borders in both versions. The untouched repaired PDF retains
the original appearance streams and styling. These tests verify saved editing
behavior with that filler; keyboard and screen-reader behavior in a PDF viewer
still needs hands-on review.

The two CDC PDFs and four scanned-text candidates also passed fresh automated
assessments using their unchanged bytes and matching existing audits.

Final regression checks passed: **465 Python tests**, **21 TypeScript research
tests**, repository TypeScript checking and scoped ESLint. No Python tests were
skipped. The new tests include altered font programs, encodings, widths, Unicode
fallbacks, field values/flags/actions, undeclared page-resource aliases, source
paint changes and unauthorized evaluation metadata, with hashes updated so the
tests exercise the underlying preservation checks.

## Exact local artifacts

Files are outside Git in `outputs/native-pdf-form-fonts-2026-10-21/` relative to
the workspace containing this checkout:

- `registration-fonts.pdf`: review copy, SHA256
  `d57495e2c3a59a379073ec5283e6c1940952fe8c13056623032fd49cb63ad76f`.
- `registration-fonts-evaluation.pdf`: explicitly staged evaluation copy, SHA256
  `2a31e07fa7582c5326de9cfbadabe23ccd86f5bc6e0dbc1be7abe45cb67dd319`.
- `font-ledger.json`, `repair-bundle.json`, `verified-audit/`, and
  `base-assessment/` retain the base file's final exact evidence.
- `evaluation-font-ledger.json`, `evaluation-repair-bundle.json`, and
  `evaluation-stage.json` bind the evaluation copy to the base file and ledger.
  `verified-evaluation-audit/` and `evaluation-assessment/` contain its final audit
  and assessment. Its only remaining blocker is the checkbox's semantic finding.
- `future-fill-independent-v2/` contains the seven saved comparison pairs,
  initialized-form renders, values/appearance checks and filler-style caveat.
- `outputs/native-pdf-font-regressions-2026-10-21/` contains the six regression
  assessments.

Five model audit calls were made in this round. Earlier audit directories remain
as immutable evidence, including two runs that correctly reported incomplete
font verification while the boundary check was being corrected. Final results
use only the `verified-*` audit directories above. Usage/cost records remain in
each private local audit report.

The implementation and support limits are described in
[FORM_FONT_REPAIR.md](FORM_FONT_REPAIR.md). Native PDF repair remains unavailable
in the application. All assessments retain `standardConformanceEstablished=false`
and `readyForApp=false`; machine validation does not resolve the author-intent
finding or complete the manual accessibility checks.
