# Native PowerPoint accessibility remediation

Status: repair and revision review implemented on the PowerPoint development branch, October 1, 2026. No hosted database migration or production deployment has been performed as part of this implementation. Deployment requires the rollout and validation steps below.

## Purpose and output choice

An instructor can choose Canvas HTML for a PDF or Word (.docx) document, or PowerPoint (.pptx) for an existing .pptx presentation. The selection applies to newly added files; rows already added retain their destination. Only those two working input/output combinations are exposed. An accessible-PDF option and PowerPoint-to-Canvas conversion are outside this release.

The PowerPoint path returns a repaired, editable PPTX together with changes and remaining review items. It does not recreate the deck from generated HTML or flatten its slides into images. The result is not a certification of accessibility: an instructor must review the remaining slide-specific findings and the final PowerPoint check.

## Processing flow

1. The API verifies the instructor/admin role, active session ownership and, for retries, ownership and retention of the existing document. It rejects unsupported source/destination combinations before reading stored content or contacting a model. PPTX uploads share the 4 MiB upload limit. The original bytes, original filename, MIME type, size and SHA-256 are retained.
2. `lib/pptx-package.ts` opens the actual Office ZIP package. It validates part names, ZIP/XML limits, content types, relationships and presentation order, then inventories slides and objects with stable IDs. Hidden slides remain in slide numbering. It refuses corrupt, encrypted, signed, macro-enabled/ActiveX or unsupported packages instead of silently stripping their features. It does not follow external relationships.
3. `lib/powerpoint-rendering.ts` sends the PPTX to the existing configured Gotenberg/LibreOffice worker to make a temporary visual-reference PDF. Hidden slides are included; speaker-note pages are excluded. `lib/pdf-rendering.ts` makes page images from that preview. The preview is evidence for interpretation and comparison; it is not the editable output.
4. `checkPptxAccessibility` identifies source structure defects, including missing title placeholders, descriptions and table headers. A dedicated PowerPoint conversion prompt sends these checks, the source object inventory, temporary PDF and explicit slide images to the institution's existing LiteLLM gateway. It prioritizes supported, unambiguous repairs over instructor tasks. Canvas instructions are not included. The model proposes bounded repairs by slide number/object ID and explains unresolved issues in ordinary language.
5. Application code validates complete slide coverage and the repair schema, applies declared edits to a copy of the original package, and reopens the output. Unchanged package parts retain exact uncompressed bytes. The revision mode permits explicit changes to descriptions, passage language, hyperlink labels, text styling and object bounds, alongside title/table/order repairs. Exact source evidence bounds affected text and geometry. Source facts, table data, slide/object identities, notes, media and relationships remain protected.
6. Every output slide is rendered again. Pixel comparison identifies visible changes for the auditor rather than rejecting intentional improvements. The audit sees actual output images and inventories plus original images for visibly changed slides. It checks preserved content, layout, clipping, header meanings, language and descriptions. Native PowerPoint can render differently from the temporary LibreOffice preview.
7. Machine checks run on the reopened output. The independent audit explicitly resolves eligible semantic concerns and can propose one focused corrective pass. Corrections are merged into a plan against the immutable original, rendered, machine checked and audited again. If final corrective verification is incomplete, the previous audited candidate remains, with a warning. Every completed model call is counted. Machine defects and missing evidence remain visible.
8. The API saves the editable PPTX, a revision bundle derived from actual output differences, small before/after previews, remaining findings and all model-call usage. The result dialog offers **Review changes** beside download. Assumptions appear first; routine repairs remain included and inspectable. Faculty can keep or restore changes and edit descriptions. A dependent repair is one atomic review item.
9. **Check and download chosen version** rebuilds the selection from the original, runs machine checks, rendering and an independent audit, and saves that selected version. The export audit cannot reapply changes the instructor declined. New findings replace the previous findings in the interface; restoring an original defect makes it visible again. Unchanged proposed before/after previews are clearly labeled, while the current chosen wording is shown as text. General PowerPoint-check guidance remains outside issue counts.

### Repair first, verify the result, report remaining work

The output inspection is authoritative for structural checks. A proposed repair does not clear a defect until code re-reads the resulting package and verifies it. The auditor adds semantic judgment: for example, whether a saved chart description explains the visible comparison and whether the new table headings label the correct data.

`lib/pptx-review.ts` separates retained findings from concerns the audit can resolve. Eligible concerns include the converter's original review findings and generic group/static chart/SmartArt checks when the actual object is available for review. The existence of a chart or group alone is not an accessibility defect. Missing descriptions, known machine errors, complex tables, hidden or opaque content, unavailable playback/external-content evidence and reverted repairs cannot be dismissed through this mechanism.

The audit response has `reviewedSlides`, `findingReviews`, `findings`, and an optional `correctivePlan` when a repair pass is allowed. Each concern gets one server-generated ID and exactly one decision: `resolved` with substantive output evidence, `needs_review` with the remaining uncertainty and action, or `needs_fix` with an evidenced defect and action. Unknown/duplicate/missing IDs, malformed decisions, incomplete slide coverage or a failed audit retain concerns and add an incomplete-audit warning. Machine checks precede model work, but a missing description or header alone does not identify its correct meaning: those repairs require model interpretation. There is no invented mechanical fix merely to make that stage nonempty. Animated groups remain protected because static previews do not establish their playback order.

Applied repairs appear under changes. Resolved concerns do not remain in warning counts. Faculty receive concrete remaining questions and defects, including a clear explanation when an obvious problem is outside the current engine's supported repairs. Null language values in the object inventory alone do not trigger a warning because effective language can be inherited or mixed. This reconciliation is specific to PPTX and does not enable HTML audit auto-repair.

## First-release repair scope

| Area | Automatic operation | Work that remains a review item |
|---|---|---|
| Slide titles | Identify a supported existing text object as the actual title placeholder, preserving wording, explicit visual properties and resolved original line spacing | Inventing a missing title, changing duplicate/vague wording, or unsafe placeholder inheritance |
| Visual alternatives | Add or explicitly replace a description, with before/after wording and optional instructor editing; inventory native SmartArt text to ground its meaning | Automatically classifying an object as decorative; uncertain values or image identity |
| Simple tables | Mark an existing first row as headers when exact cell text matches the proposed evidence; separate a single full-width merged caption from clearly grounded labels in a two-column table when remaining rows are simple and all content fits within the original caption-row area | Other column counts for caption repair, other merges/complex tables, ambiguous column meanings, insufficient space, screenshots of tables, or reconstructing data relationships |
| Reading order | Apply a complete permutation for supported top-level objects, then audit rendered overlap/stacking effects | Animation, groups, unsupported or hidden objects |
| Language | Set a uniquely matched passage's language, splitting runs while preserving surrounding text and formatting | Ambiguous or unsupported text locations; language inherited outside the matched passage |
| Links | Replace exact hyperlink display text and preserve its destination | Changing URLs, ambiguous run structure or invented destinations |
| Visual adjustments | Change exact passages' font size/foreground color or move/resize supported objects using exact original geometry; show previews and record the changes | Theme/master edits, arbitrary slide reconstruction, grouped/animated/hidden geometry, OCR reconstruction or media captioning |

The patcher preserves the input's editable package. It is not a general presentation redesign engine. A partial but valid repair can therefore have both applied changes and important remaining findings. Findings should describe the exact slide/object, what students may miss, and the next action in PowerPoint without requiring knowledge of accessibility standards.

For example, a merged “Group discussion” caption above “Pair A / Compare leaf shapes” and “Pair B / Compare soil texture” becomes a separate caption followed by an unmerged “Pair / Discussion task” header row. Marking the merged caption itself as a header is insufficient. The caption and new headers share the old caption-row space; their vertical padding may be reduced to 3pt, while source font sizes and original body-cell content and positions remain unchanged. Repairs with unsupported structure or insufficient fit remain explicit review items. Completed PPTX rows read **Needs a fix** when errors remain, otherwise **Ready to review**; completing processing never certifies accessibility.

## Guide interpretation

The four instructor-supplied PDFs were read in full. References below use PDF page positions rather than printed footer page numbers; the Section508 document's printed numbering is one less after its first page.

- **Power-Points-Guidelines-1.2025.pdf (Helen Keller)**: titles and readable typography, p.2; meaningful image alternatives, pp.2-3; alternative formats and checking, pp.4-5. Its audience-specific large fonts, light-on-dark template, transition sounds and staged bullet reveals are not universal automatic transformations.
- **ms-powerpoint-365-basic-authoring-and-testing-guide.pdf (Section508)**: reading order and actual title placeholders, pp.2-4; lists/columns/languages/links, pp.4-7; meaningful background content and tables, pp.8-10; visual alternatives, pp.11-12; contrast/media/flashing, pp.13-15. Complex tables need an alternative or deeper remediation; a header flag alone is insufficient.
- **PowerPoint Accessibility Checklist.pdf (SERC)**: structure/language/readability, p.1; contrast, images and tables, p.2; lists and limitations of automatic checkers, p.3. Its repeat-table-header instructions appear to describe Word and are not implemented as PowerPoint operations.
- **WebAIM_ PowerPoint Accessibility.pdf**: layout/title semantics, pp.2-4; reading order and stacking, pp.5-6; alternatives and table support, pp.6-9; links/checking, pp.9-12. Its PDF distribution recommendation differs from the SERC checklist; the user's requested destination here remains PPTX.

Current primary guidance checked while designing this implementation:

- [Microsoft PowerPoint accessibility guidance](https://support.microsoft.com/en-us/accessibility/powerpoint/make-your-powerpoint-presentations-accessible-to-people-with-disabilities)
- [Microsoft Reading Order pane](https://support.microsoft.com/en-us/powerpoint/make-slides-easier-to-read-by-using-the-reading-order-pane): reordering can change overlapping objects; grouping can discard animations; text boxes and shapes containing text do not need redundant alt text.
- [Section508 accessible presentations](https://www.section508.gov/create/presentations/)
- [W3C contrast minimum](https://www.w3.org/WAI/WCAG21/Understanding/contrast-minimum.html): normal text 4.5:1; large text 3:1, with large defined as at least 18pt regular or 14pt bold. These thresholds do not mean every slide must be resized to one fixed font size.
- [WebAIM PowerPoint accessibility](https://webaim.org/techniques/powerpoint/)

## Information flow and retention

This adds no new third-party document service. Hosted processing uses the existing application server, its Gotenberg/LibreOffice worker, the private Supabase bucket/database and the institution's LiteLLM gateway/model provider.

The original PPTX reaches the worker for preview rendering. The model receives the slide preview PDF, slide images and object inventory. Speaker notes remain in the original/output package; the inspector does not add speaker-note text to the model inventory and the renderer excludes note pages. Hidden slides are intentionally included in the model review. Notes could still contain private information in the original file seen by the worker, even though note pages are omitted from model previews.

Full-resolution PDFs, PNGs and inventories are request-local. Small JPEG before/after previews are saved inside private review JSON to support faculty review. Worker temporary-file handling belongs to the existing renderer lifecycle; the app's purge does not delete an institution/provider's independent logs or backups.

Online originals, repaired presentations, review JSON, snippets/findings and job events expire exactly 14 elapsed days after the original `documents.created_at`. A retry does not reset that clock. Storage/metadata access takes the same document lock as purge and rechecks eligibility. Model and rendering calls stay outside that transaction. A model call may finish after a document expires, but its result cannot recreate or expose an expired artifact.

PPTX keys:

- `{sessionId}/{documentId}/source.pptx`: immutable original.
- `{sessionId}/{documentId}/{jobId}/output.pptx`: repaired output of that job.
- `{sessionId}/{documentId}/{jobId}/review.json`: initial target/profile, revisions, previews and findings.
- `{sessionId}/{documentId}/{jobId}/review-{exportId}.pptx` and `.json`: immutable selected-output/review pairs. Nonavailable artifact rows reserve both paths before work starts; they remain discoverable after failure. Available pointers switch transactionally after upload. Prior saved files stay private and are purged with the original document.

Review requests use authenticated ownership checks, a content hash of the saved review, the conversion attempt count and a short export lease. Concurrent/stale exports cannot replace a newer output. Description edits and selection IDs are validated before model work; clients cannot provide package plans or storage paths. An export cannot start within 330 seconds of original expiry. The app stores no document review content in browser localStorage. Model calls execute outside database locks; their usage is persisted before output switching, including failed checks.

The initial review response contains change records and slide numbers. Before/after image pairs load individually when the instructor opens a slide comparison, with an in-memory browser cache. A failed preview does not block choices or export. Preview images show the original and initial proposal; text records describe the selected changes. Metadata and individual image responses are bounded below the hosted response limit.

Purge removes every canonical source path, every artifact-linked path and each job's canonical PPTX/review paths before cascading database deletion. Deriving job paths also cleans output blobs whose metadata transaction failed. A storage failure preserves discovery records for retry. User-requested deletion uses the existing owned tombstone flow. Files downloaded to the user's computer are unaffected.

`getDocumentOutputDownload(documentId, outputTarget)` authorizes ownership and artifact type, then requests a download attachment with the correct extension/MIME. Signed URLs last at most 60 seconds, are shortened near original expiry and are withheld if signing latency would let their conservative expiry bound extend beyond retention. The UI requests a fresh URL on each click. `getDocumentHtml` explicitly remains scoped to Canvas HTML.

## Jobs, costs and long-term metrics

Each job records `output_target` and `profile_version`; this release uses `canvas_html` / `canvas-html-v1` or `accessible_pptx` / `powerpoint-v1`. Existing records receive the Canvas defaults. Target-aware upserts and PPTX job-specific paths establish the future output boundary.

The original document-only unique constraint remains **alongside** the new `(document_id, output_target)` unique constraint in this release. This keeps old `ON CONFLICT(document_id)` callers compatible during rollout. Current supported input/output pairs are one-to-one. Before supporting two destinations for the same source, remove the legacy constraint in a later migration after compatible code is deployed and update row identity/UI/download semantics accordingly.

Costs and tokens include conversion, audit, retries and recorded billable failures through the existing `model_calls` and anonymous aggregate machinery. Shared `page_count` contains PDF pages for Canvas work and slide count (including hidden slides) for PowerPoint work. Admin labels therefore say pages/slides. Processing time includes the PowerPoint preparation, repair, comparisons, audit, saving and metadata work of the latest successful attempt.

Selected-output checks record their usage before saving the new output. If the original document has already been deleted during a check, its late usage is saved only in anonymous daily/model/stage totals. That fallback preserves the cost without recreating private document records; it cannot revise the deleted job's previously archived cost distribution.

Purge retains anonymous daily/model job, token, cost, success and timing totals; it does not retain instructor/document IDs, filenames, content, descriptions or individual errors. The current historical metrics combine output destinations. Target-specific long-term aggregates are a separate future enhancement; this release does not imply a retained destination breakdown that does not exist.

## Limits and test expectations

- Input: standard `.pptx`, at most 4 MiB and 60 slides including hidden slides. Legacy `.ppt` and macro-enabled `.pptm` are unsupported. ZIP/XML expansion, part counts, depth and object/text counts are bounded by `lib/pptx-package.ts`.
- Rendered reference PDFs retain the existing 4 MiB and PDF renderer limits. A small compressed deck with many large images can exceed rendering limits. The current worker request/body limits must also accommodate the final candidate; an oversized candidate is an error, not permission to omit slides.
- Gotenberg requests require configured authentication for hosted workers, refuse redirects and have a bounded timeout. Local HTTP is restricted to development loopback. The existing renderer configuration denies linked-resource fetches; linked media remains a review item.
- The model can propose only a supported plan. The package writer accepts no arbitrary XML, replacement slide, shell command or external URL from a plan. ZIP paths and relationships are validated; signed or executable package variants are rejected.
- Tests must verify authored-description/notes/media/relationship preservation, valid slide/object identity, unsafe-repair rejection, actual candidate rendering, incomplete audit handling and model usage when work fails. A package-only fixture is not evidence of rendering fidelity in PowerPoint.

## Local testing and rollout

The local CLI uses the same engine without database or Supabase persistence:

```powershell
node --conditions=react-server --env-file=.env.local --env-file=.env.word-to-pdf --import tsx scripts/convert-powerpoint.ts "C:\path\lecture.pptx" "C:\path\local-results"
```

Keep server credentials in ignored local env files. This command can send document evidence to the configured institution gateway and the original to the configured renderer. It writes `repaired.pptx` and a local `result.json`; local files are not covered by hosted purge.

Before deployment:

1. Run the package/engine, route, upload/result, ownership/download and retention tests. Run the isolated PostgreSQL/WASM suite with migration `0013_powerpoint_outputs`; it must show both old and new upserts remain valid and PPTX content disappears while anonymous costs/counts remain.
2. Run typecheck, relevant lint and the production build/native PDF smoke check. Test a synthetic deck and representative instructor decks end to end. Open returned files in PowerPoint, inspect edits and unresolved findings, run Check Accessibility and check navigation/media with appropriate assistive technology.
3. Apply `drizzle/0013_powerpoint_outputs.sql` to the intended database only as part of the authorized rollout. It adds `source_pptx`/`pptx_output`, job target/profile fields, the composite unique constraint and permitted PowerPoint diagnostic categories; it leaves old uniqueness available. No hosted migration has been run while preparing this branch.
4. If the private `documents` bucket restricts MIME types, add `application/vnd.openxmlformats-officedocument.presentationml.presentation` and `application/json` while retaining PDF/DOCX/HTML support. Keep the bucket private. The current file-size limit must allow repaired outputs and review JSON.
5. Use the existing `GOTENBERG_*` and LiteLLM settings; do not add an external rendering vendor or copy keys into the repository. Verify the deployed app uses the intended private worker and schema before enabling actual PPTX traffic.
6. Test a live owned download, a new PPTX, its retry, and existing Canvas conversion. Confirm page/slide and all-call cost metrics. If rolling back after PPTX records exist, retain PPTX-aware cleanup/download support or explicitly account for those records; old code does not know orphaned PPTX key conventions.

This document describes branch implementation and release requirements. Only measured checks recorded with a release establish which environments and presentation examples have actually passed.

## Measured development verification — September 24, 2026

- The complete Vitest suite passed: 1,107 tests in 51 files. Isolated PostgreSQL/WASM retention and migration tests passed separately (22 tests). TypeScript and the production build passed, including the existing 21-page native PDF renderer smoke check. Changed-file lint had no errors; the existing unused `table` parameter in the schema remains a warning.
- A four-slide synthetic PPTX completed both real Sol model stages through the institution gateway in 54.6 seconds. Returned gateway costs totaled $0.094984 for 19,374 tokens, including conversion and audit. This is one synthetic example, not a performance or pricing guarantee for instructor decks.
- That run retained four repairs: a real title placeholder and corrected reading order on slide 1, a chart description on slide 2, and table headers on slide 3. Before/after slide images passed the bounded comparison. A first exact-pixel comparison caught inherited title line spacing and harmless font-edge rasterization; the implementation now preserves resolved source spacing and tests the bounded visual tolerance.
- Official Open XML SDK 3.5.1 validation against Microsoft365 reported zero schema errors for source and output. Of 34 package parts, 31 remained byte-identical; only three repaired slide XML parts changed. Notes, relationships, master/layout/theme, native chart, text, object IDs, authored alternatives and visibility were preserved. This fixture contains no media or embedded workbook parts; package-level tests cover preservation of arbitrary untouched parts, but those features still need representative application testing.
- Local rendering used extracted LibreOffice 26.2.6 through a loopback-only test adapter because Docker Desktop failed to start. The hosted Gotenberg service, hosted database migration, signed production download and native PowerPoint/screen-reader behavior have not been tested for this branch. UI behavior has component tests; this is not a browser end-to-end verification.
- That initial sample retained a complex-table defect and other review items. Its valid package and passing implementation tests did not establish that it was accessible. The user's subsequent PowerPoint Accessibility Checker run confirmed the missing table headers on slide 4. Final prompt wording also asks for visible text descriptions rather than internal object numbers in faculty-facing messages.

Synthetic source, repaired sample and detailed validation reports are stored outside the repository in the local `outputs/powerpoint-eval` folder. No instructor documents, local environment files or model keys are included in the branch.

### Follow-up: missing headers in the Group discussion table

The caption-table repair and deterministic missing-header check address the user's native-checker finding. The full conversion/audit workflow reprocessed the earlier repaired deck in 45 seconds and applied the new table repair automatically. Both stages returned usable responses; the resulting findings contained no errors and no remaining table issue, with only the standing chart/final-PowerPoint review reminders. Source data cells and all other slide content were preserved. The intentional visual change is limited to the original caption row; its split uses whole 0.01mm units to preserve LibreOffice's rounding of existing body positions. All 1,122 tests and the production build/native-renderer smoke check passed. These remain implementation and artifact checks; the newly corrected copy still needs the user's native PowerPoint check before calling that particular check passed.

The correction remains on the development branch. No production migration or deployment was performed for this follow-up.

### Follow-up: repair-first checks and explicit audit resolution

The original four-slide synthetic source completed the updated workflow in 36.9 seconds, applying all five intended repairs: title identification, reading order, chart description, simple table headers and the Group discussion caption/header repair. Machine checks and the complete independent audit returned zero remaining findings. The generic chart concern required an explicit output-based decision; no unconditional PowerPoint-check warning was added. Total gateway cost was $0.098272 for 20,732 tokens across both calls. This example does not establish performance on other decks.

All 1,235 tests in 52 files, TypeScript and changed-file lint passed. The production build and native PDF renderer smoke check passed. Open XML SDK validation reported zero schema errors for the original and repaired files. The result differs from the previously corrected package only in the generated chart description on slide 2; the slide 4 repair is byte-identical and its rendered output was visually inspected again. PowerPoint's native checker has not been rerun on this latest sample by the agent. Results are in local `outputs/powerpoint-eval/repair-first-live`, outside the repository. The changes remain on the development branch with no hosted migration or deployment.

### Instructor-deck test and recoverable preview warning

A five-slide instructor deck initially stopped before model calls because the preview emitted `TT: undefined function: 21`. Inspection of the pinned renderer confirmed this concerns discarded TrueType hint bytecode, not missing glyph outlines. Both independent renderers showed all content. The shared PDF renderer now permits only that exact warning class; all other warnings remain fatal. See `docs/pdf-visual-audit.md` for the scoped exception and tracing requirements.

The repeated end-to-end run completed in 70.4 seconds, adding four image descriptions and preserving all five rendered slides. Both model calls totaled 29,259 tokens and $0.17638. Source and output each had zero Open XML SDK schema errors. This was a partial repair: reading-order changes were skipped for uncertain geometry, and the audit identified remaining language, existing-description and link issues. It produced seven messages including a repeated SmartArt concern. That duplication and the unsupported repair categories remain product gaps; this test does not establish a fully accessible output. The instructor file, output and detailed findings remain outside the repository.

All 1,310 tests in 53 files, TypeScript, relevant lint, the production build and the native renderer smoke test passed after the preview correction. No hosted migration or deployment was performed.

## Reversible change review verification — October 1, 2026

The same five-slide instructor presentation completed the expanded repair and independent audit in 59.0 seconds. It produced 11 measured changes: four image descriptions, three reading-order corrections, a clearer hyperlink label, the French passage's language, a table description and a grading description. Reopened-package checks and the completed audit reported zero remaining findings. The two Sol calls used 33,057 tokens and cost $0.165684 through the configured gateway. These measurements describe one presentation.

The original and repaired presentations each had zero schema errors in Open XML SDK 3.5.1 validation for Microsoft365. Only the five slide XML parts changed; the other 60 package parts remained byte-identical. All five final slide previews were visually inspected. Restoring every change reproduced the original file byte for byte.

A separate chosen-output test restored only the French language setting. Package comparison confirmed that the other ten changes remained intact. The independent audit then identified the restored English pronunciation setting on slide 3, without reapplying the declined repair. That extra audit used 17,925 tokens and cost $0.081332. The local CLI for replaying and checking a selection is:

```powershell
node --conditions=react-server --env-file=.env.local --env-file=.env.word-to-pdf --import tsx scripts/review-powerpoint.ts "C:\path\lecture.pptx" "C:\path\local-results\result.json" "C:\path\selected-results" --exclude change-id
```

All 1,388 tests in 57 files and the production build passed, including the traced 21-page PDF renderer smoke check for both conversion and chosen-output routes. The separate PostgreSQL/WASM suite passed all 26 tests, including selected-export accounting, deletion races and discovery of prior review files for purge. Component tests cover review, restored changes, description edits, repeated exports and lazy previews. A local browser fixture verified desktop and narrow-screen review layouts, before/after images and editing controls.

The final repaired file and detailed reports are in local `outputs/powerpoint-eval/revision-workflow-final-2026-10-01`; the intentional undo test is in `revision-undo-test-2026-10-01`. The user opened the final repaired file in PowerPoint and reported that its built-in Accessibility Checker returned no issues. This records the user's native-checker result for this presentation; screen-reader verification remains unperformed. No hosted migration, merge or deployment was performed.
