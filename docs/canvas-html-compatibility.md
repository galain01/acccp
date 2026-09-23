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
passed. These checks verify integration and existing behavior with mocked model
responses. A live-model conversion and Canvas save have not been tested with
these revised prompts.
