# Document accessibility workflow

## Product decision

Instructors need to return teaching materials to their existing learning system,
which may simply host downloadable files. The default destination is therefore
the original format: Word to Word, PDF to PDF, and PowerPoint to PowerPoint.
HTML remains an optional destination. The first HTML profile remains explicitly
Canvas-compatible; a general web profile can be added separately.

Preserve the original layout as closely as possible and make targeted
accessibility fixes. Preserve source wording, facts, links, images, tables,
notes, and editable content. Do not rebuild a Word document or presentation from
generated HTML. Do not silently use HTML-to-PDF printing for native PDF repair.
Manual selection of slides to exclude from visual processing is deferred.

## Shared instructor experience

1. Add a mixed batch of supported Word, PDF, and PowerPoint files.
2. Choose the default for new files: **Keep original format** or **HTML (Canvas)**.
3. Override **Download as** for any pending file when needed. The default means
   an instructor keeping all original formats does not make a choice per file.
4. Use **Improve accessibility** to process the eligible files. Completed files
   are skipped unless explicitly rerun. Show any unavailable destinations rather
   than silently substituting HTML or skipping them without explanation.
5. Present **Download**, **Changes made**, and **Items to review**. Locations use
   ordinary language and exact source anchors where possible. Fix issues that
   can be resolved with sufficient evidence; surface ambiguity and unassessed
   content clearly.

The interface describes supported repairs, not guaranteed universal compliance.
Only enable a destination after its repair and validation pipeline works.

## Implementation status

The shared workflow and native Word repair were released on 2026-10-21.
This branch adds native PDF repair; hosted activation has not occurred.

| Input | Keep original format | HTML |
| --- | --- | --- |
| `.pptx` | Existing native repair engine | Not implemented |
| `.docx` | Native repair engine | Existing Canvas HTML engine |
| `.pdf` | Native repair engine on this branch; not deployed | Existing Canvas HTML engine |

In the UI, requested `original`/`html` intent is distinct from
executable `OutputTarget`. The server accepts `accessible_pdf`, `accessible_docx`, `accessible_pptx` and
`canvas_html`, with its existing input/target checks. An unavailable choice must
never be submitted using the legacy Canvas default. Destination changes are
limited to local pending files; an attempted/saved file keeps its fixed target.

Existing limits remain: DOCX/PDF 4 MiB and 60 rendered pages; PPTX 25 MiB and 60
slides. Handling presentations over 100 slides is a separate capacity project.
The new wording and mixed uploader do not increase rendering, request, storage,
or deadline limits.

## Separate format engines

Use a common orchestration pattern, with format-specific inspectors and writers:

`immutable source -> inspect -> evidence-backed fixes -> patch source -> reopen
and validate -> independent audit -> downloadable result and review`

Machine inspection identifies structural defects; a model can interpret
ambiguous semantics and propose bounded changes to exact source objects. The
writer validates each operation. Independent checks inspect the actual written
file, including content and visual preservation, rather than trusting the
model's claim that it fixed something. PDF previews are evidence for native
Office repairs; they are not the editable output.

### Word: available

See [native Word repair](word-accessibility.md) for the pipeline, supported
operations, limits, storage and migration. The engine patches original OOXML,
checks content/parts, reopens and renders the actual output, and independently
audits its metadata and pages. Metadata repairs preserve rendered appearance;
typed-list and clear table-header repairs permit changes inside their measured
regions while preserving surrounding layout and pagination. Unsupported or
ambiguous structures remain review items. The result offers a native download,
change summary and actionable findings; per-change keep/restore is future work.

Local evaluation uses controlled and instructor files with independent OpenXML
SDK, package-preservation and visual comparisons. Word Accessibility Checker
and screen-reader verification remain part of the release review.

### PDF: native repair integration

See [native PDF repair](pdf-accessibility.md) for the app pipeline, supported
operations, bounds, storage and migration. The first general engine uses the
private open-source worker to preserve existing tags, tag untagged files and
apply bounded metadata, leaf text-role, missing-description and simple
table-header changes. It preserves original pages, reopens the written output,
and runs machine checks and an independent audit. Scans, font defects, complex
forms and uncertain semantics remain visible when they need additional work.

Evaluate native tag writing on the original PDF, including existing tags,
reused content objects, multi-column layouts, links/forms, scans/OCR, fonts,
Unicode extraction, images, and incremental saves. Preserve visible page content
and existing alternatives. Include independent PDF/UA validation and semantic
audit; machine checks alone cannot establish meaningful reading order or image
descriptions.

The user selected **open-source components only** on 2026-10-21. The local
prototype now evaluates **OpenDataLoader PDF 2.5.14** as the native tag writer,
with our own repair layer, independent veraPDF checks, preservation checks and
model audit. The free Apache-2.0 core writes actual tagged PDFs; its enterprise
PDF/UA export and editor are not used. See
[`research/native-pdf/README.md`](../research/native-pdf/README.md) for measured
results, reproducible tools and release gates. The repair layer now restores
authored descriptions on the same raster and vector figures, preserves existing
table structures, and checks the saved output independently. The explicit target
is **PDF/UA-1 (ISO 14289-1:2014)**. A veraPDF pass is one gate; unresolved semantic
findings, missing content associations and human checkpoints still prevent an
overall conformance claim.

When an original standard font is unavailable, the user permits a similar
open-source font if independent layout checks pass. The experiment limits this
to verified Liberation font programs, exact text/advance widths and preserved
text positions. Changes outside the authorized glyphs remain failures. Every
candidate edit invalidates earlier validation and audit evidence.

Other approaches researched, but not selected:

- [PDFix SDK](https://pdfix.net/products/pdfix-sdk/): licensed tooling that can
  run on our worker and write/repair structure. Evaluate the actual selected
  layout/AI integration's data flow; optional hosted AI can still transmit data.
- [Adobe Accessibility Auto-Tag API](https://developer.adobe.com/document-services/apis/pdf-accessibility-auto-tag/):
  hosted tagging and reports, adding another document processor, credentials,
  cost model, and provider-asset deletion lifecycle.
- A custom writer using low-level libraries: potentially useful for a narrow
  supported subset, but substantial engineering for arbitrary PDFs. Do not
  equate extraction tools with a remediated-PDF writer.

OpenDataLoader and veraPDF run locally in the research setup. No paid license or
new provider account has been purchased. Semantic experiments use the existing
institutional LiteLLM configuration. The branch now integrates a bounded
general repair path; the broader fixture-specific OCR, font, form and appendix
experiments remain research tools. The production PDF repair destination has
not been activated. The final manual interactive review was stopped at the
user's request, so the app makes no claim that such testing has been completed
for arbitrary uploaded documents.

### HTML

Keep current Canvas HTML behavior and its target-specific audit rules. A future
PowerPoint-to-HTML path must explicitly define handling of notes, hidden slides,
animations/media, and slide reading order rather than using the native PPTX
repair branch. A future general web profile can relax Canvas-specific limits
without changing existing saved Canvas outputs.

## Shared persistence and rollout

Explicit dispatch and typed results separate Canvas HTML, native Word, native
PowerPoint and native PDF, including artifacts, MIME types, downloads and purge
paths. The PDF target requires migration `0016_native_pdf_outputs` and its
configured private worker before hosted activation; it cannot fall through to
the HTML branch.

One source should eventually own several independent result jobs. The current
database still enforces legacy `UNIQUE(document_id)` alongside
`UNIQUE(document_id, output_target)`. Remove the legacy constraint only in a
deliberate compatible rollout, with stable source/result UI identities and
explicit behavior when a user requests another output. The foundation UI does
not enable this multi-output persistence yet.

All destinations retain the original 14-day expiry, immutable source, ownership
checks, retryable deletion, and private storage. Record every conversion,
audit, retry, and billable failed call. Anonymous daily/model totals continue
to survive document deletion. Any additional engine processing cost must be
represented separately and included in reported total job cost when available;
unknown costs must not appear as zero.

## Delivery sequence

1. Shared mixed uploads, per-file intent, truthful capability status and neutral
   framing on a separate branch. Keep existing working engines intact.
2. Native Word repair and review, proven on representative instructor files.
3. Native PDF engine evaluation and integration, subject to its licensing,
   deployment, privacy, and fidelity results.
4. Multi-output results for the same source and PowerPoint-to-HTML, then larger
   documents/background processing as separately tested capacity improvements.

Each native engine has its own release gate. A common interface is not evidence
that all three native engines are ready.
