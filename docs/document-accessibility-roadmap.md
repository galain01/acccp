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

The current branch implements the shared workflow and native Word repair.
Native PDF remains planned. Production is unchanged until a separate release.

| Input | Keep original format | HTML |
| --- | --- | --- |
| `.pptx` | Existing native repair engine | Not implemented |
| `.docx` | Native repair; local testing | Existing Canvas HTML engine |
| `.pdf` | Not implemented | Existing Canvas HTML engine |

For the preparatory UI, requested `original`/`html` intent is distinct from
executable `OutputTarget`. The server accepts `accessible_docx`, `accessible_pptx` and
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

### Word: implemented on this branch

See [native Word repair](word-accessibility.md) for the pipeline, supported
operations, limits, storage and migration. The engine patches original OOXML,
checks content/parts, reopens and renders the actual output, and independently
audits its metadata and pages. Its strict preservation mode rolls back repairs
that change rendered pixels or pagination. Complex structures remain review
items. The result offers a native download, change summary and actionable
findings; per-change keep/restore is future work.

Local evaluation uses controlled and instructor files with independent OpenXML
SDK, package-preservation and visual comparisons. Word Accessibility Checker
and screen-reader verification remain part of the release review.

### PDF: choose and evaluate a remediation engine

The current PDF libraries render and inspect documents; they do not implement a
complete native accessibility writer. A PDF repair engine must connect headings,
paragraphs, tables, figures, forms, and reading order to the actual page content.
Adding a detached structure tree or document metadata would not be sufficient.

Evaluate native tag writing on the original PDF, including existing tags,
reused content objects, multi-column layouts, links/forms, scans/OCR, fonts,
Unicode extraction, images, and incremental saves. Preserve visible page content
and existing alternatives. Include independent PDF/UA validation and semantic
audit; machine checks alone cannot establish meaningful reading order or image
descriptions.

Candidate approaches, based on official documentation checked 2026-10-21:

- [PDFix SDK](https://pdfix.net/products/pdfix-sdk/): licensed tooling that can
  run on our worker and write/repair structure. Evaluate the actual selected
  layout/AI integration's data flow; optional hosted AI can still transmit data.
- [Adobe Accessibility Auto-Tag API](https://developer.adobe.com/document-services/apis/pdf-accessibility-auto-tag/):
  hosted tagging and reports, adding another document processor, credentials,
  cost model, and provider-asset deletion lifecycle.
- A custom writer using low-level libraries: potentially useful for a narrow
  supported subset, but substantial engineering for arbitrary PDFs. Do not
  equate extraction tools with a remediated-PDF writer.

The preference is to evaluate a self-hosted engine first given the existing
privacy requirements. No engine/license/account has been purchased, installed,
or connected, and no document has been sent to a new provider by this work.
[veraPDF](https://docs.verapdf.org/validation/) is a candidate independent
validator for machine-verifiable PDF/UA requirements.

### HTML

Keep current Canvas HTML behavior and its target-specific audit rules. A future
PowerPoint-to-HTML path must explicitly define handling of notes, hidden slides,
animations/media, and slide reading order rather than using the native PPTX
repair branch. A future general web profile can relax Canvas-specific limits
without changing existing saved Canvas outputs.

## Shared persistence and rollout

Explicit dispatch and typed results now separate Canvas HTML, native Word and
native PowerPoint, including artifacts, MIME types, downloads and purge paths.
The future `accessible_pdf` destination must add these together; it cannot
fall through to the HTML branch.

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
