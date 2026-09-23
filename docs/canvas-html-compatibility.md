# Canvas compatibility in conversion and audit

Both model stages include `lib/prompts/canvas-compatibility.ts`. The rules are
embedded in the system prompts; the models are not asked to browse a link.
The reference is Instructure's [Canvas HTML Editor Allowlist](https://community.instructure.com/en/kb/articles/387066-unknown#allowed-style-properties),
checked September 23, 2026. Recheck that document when updating the shared rules.

The instructions cover permitted elements, global and element-specific
attributes, inline CSS names and valid longhands, the restricted `position`
values, and URL schemes. Conversion checks its output against these rules.
Audit uses the same rules for findings and recommended fixes, with ordinary
language, source locations, and the existing finding schema.

The app keeps a conservative subset of Canvas's full HTML support. In particular,
Canvas allows H1 and MathML; reserving H1 for the Canvas title and limiting the
fragment to the app's documented elements are application choices. A formula
that cannot be represented faithfully receives the existing source-review
marker. No new interactive content or embedded-media workflow is introduced.

Two previous instructions conflicted with the published attributes:

- Table-cell `headers` is not listed. The prompt now uses appropriate `th scope`
  associations and structural groups, or faithful simpler tables/label-value
  groups. Relationships that remain unresolved receive a located table review.
- `li value` is not listed. Numbering jumps use separate `ol` runs with `start`;
  source-supported `type` and `reversed` remain available.

Expected image placeholders still require manual insertion. Their association
attributes and neutral audit heading markers must not trigger duplicate Canvas
findings. Escaped HTML examples remain document text. Auditors distinguish a
Canvas compatibility warning from a demonstrated accessibility or fidelity
defect, and must not claim to have tested saving the HTML in Canvas.

This change guides model generation and audit; it does not add a sanitizer,
automatic repair, or an upload-rejection rule. Existing closing-tag normalization
continues to run. Model instructions cannot guarantee Canvas's eventual output;
verify representative results after saving in the actual Canvas editor.

No environment variable, database migration, or model change is required.
Existing saved HTML is unchanged. New prompts take effect for conversions after
deployment.

Validation for this change: 162 existing conversion, heading-review,
image-review, source-finding and closing-tag tests passed; TypeScript and ESLint
passed. The production build and its traced native PDF-renderer smoke test passed
locally on Windows/Node 24. These automated tests use mocked model responses.

A live end-to-end conversion of the five-page synthetic Field Methods PDF on
September 23 used gpt-5.6-sol-2026-07-09 for both stages. It completed in 77 seconds
using 29,184 tokens and $0.216304 in gateway-reported cost. The generated tables
used three column scopes and two row scopes, with no headers attributes or
malformed closing tags. The inspected elements, attributes and inline styles
were within the Canvas profile. Schedule dates, the sampling instruction, chart
counts and equipment values were retained. The audit returned six warnings:
image insertion, two unavailable link destinations, one unclear link label,
and two heading-grouping reviews. The converter combined two Field notes
headings; this run is not a zero-defect conversion result. This fixture has no
numbering jump, so it does not test the separate ol/start generation rule. The
generated output has not been saved in Canvas as part of this live-model check.

A separate manual Canvas Page save test on September 23, 2026 preserved the
header element and table IDs/scope, but removed td headers attributes and li
value="7". The saved list displayed 3, 4, 5 instead of 3, 7, 8. This confirms
those two compatibility concerns in the tested Page workflow; it does not
replace a live-model evaluation of the revised prompts. See the
[selectable output plan](output-formats-plan.md) for keeping Canvas rules
specific to Canvas as other output formats are added.
