# Preserve authored PDF image descriptions

The PDF renderer now explicitly extracts authored Figure alternatives and sends the same source records to both the conversion and audit calls. This avoids relying on undocumented model-provider handling of accessibility tags in PDF attachments. It works on uploaded PDFs and on the PDF produced by the existing Word renderer, provided the descriptions survived the Word-to-PDF export.

## Source extraction and matching

- Extraction runs in the existing bounded child process using PDF.js `getStructTree()`. PDF.js resolves custom role maps and exposes Figure `/Alt` strings, with `/ActualText` as its own fallback. The API does not distinguish the fallback's provenance. Empty alternatives remain distinct from absent alternatives.
- Records have generated physical-page occurrence IDs, exact authored text, and a measured region when a reliable association exists. Structure order is never used as visual image order, and reused image objects remain separate occurrences.
- PDF.js rendering records marked-content bounds for tagged pages within the operator budget. Bounds account for page transforms and are approximate, quantized page-relative locations rather than crop instructions. Vector and grouped figures can have alternatives too.
- Missing, shared, repeated, unsupported, form-scoped or otherwise ambiguous content references retain their original text with null bounds. They require instructor review; the model must not assign them by list order.
- Raw structure/ParentTree checks detect missing inverse associations that PDF.js can otherwise silently omit. Per-page authored Figure counts are cross-checked against PDF.js's extracted inventory. Malformed structure makes metadata unavailable conservatively for the document. If a stream-scoped reference is present, measured page-only bounds are disabled for the document because PDF.js drops that stream provenance from its exported structure IDs.
- Metadata parsing failures or limits produce `unavailable`, not a claim that no descriptions exist. Rendered page PNGs still proceed when rendering itself succeeds. Visual rendering failures retain the existing fail-before-model-call behavior.

## Conversion and audit

Supplemental source JSON follows the relevant page image in both requests. It is explicitly identified as untrusted document content, including any instructions inside a description. No metadata is executed, fetched as a URL, or promoted to a system instruction.

For a clearly matched figure, the conversion prompt preserves its non-empty authored description verbatim in an escaped HTML `alt` attribute and adds its generated `data-source-image-id`. It flags a specifically unsuitable source description instead of silently replacing it. An empty source alternative does not prove an image is decorative; meaningful images still need descriptions. Figure image files remain manual Canvas insertion placeholders.

The auditor receives the independently extracted source records and verifies both the visual match and the wording. HTML image IDs are proposed matches, not proof. It should catch swapped descriptions, incorrect grouping and source descriptions lost during conversion. Deterministic checks also retain faculty-facing warnings if an authored description is dropped, changed, reused, assigned an unknown ID, or has an uncertain source location. Those checks do not rewrite the HTML or establish visual identity from an ID alone.

## Bounds and storage

The existing 4 MiB input, 60-page limit and child deadline still apply. Additional caps are 100 described figures per page and 500 per document; 8,000 characters per alternative, 32,000 per page and 128,000 per document; 10,000 traversed tree nodes per page and traversal depth 64. The raw structure/number-tree preflight also bounds its combined visited nodes/entries to 10,000 per document. PDF.js materializes the tree before traversal, under the existing child/input/deadline constraints. Optional rendering-bound tracking caps are 50,000 operators per page and 200,000 per document. Exceeding the metadata cap never passes truncated descriptions off as complete.

Extracted records and bounds are request-local server memory. They are sent to the existing model provider as source input. Preserved descriptions become part of saved HTML; relevant quotations may appear in review findings. Both are subject to existing document retention. No new database tables, storage bucket, provider, model call, or persistent extraction artifact is introduced. Provider-side retention and Word-renderer temporary files remain outside the application's purge.

## Validation

Real-renderer tests create tagged PDF fixtures in memory and verify exact text, Unicode, physical pages, repeated images, out-of-order tags, vector bounds, empty/missing alternatives and unavailable metadata. Pipeline tests verify that both model stages receive identical extracted records and that preservation warnings remain even if the AI audit is clean. The production-build smoke check exercises extraction and bounds using only traced runtime files.

The synthetic provider exposure test is retained outside the repository under `outputs/pdf-alt-exposure`. Follow-up live tests should use the normal conversion prompt and audit with the newly extracted source records; the earlier diagnostic extraction prompt alone does not establish production-prompt preservation.
