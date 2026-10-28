# Native PDF accessibility repair

The app supports `accessible_pdf` (`pdf-v1`). An instructor can keep a
PDF as a PDF or choose the existing Canvas HTML output. The repair edits the
PDF's native accessibility information while preserving the original page
layout. It does not print HTML into a replacement PDF.

Hosted use requires the private service and migration `0016_native_pdf_outputs`.
That migration was applied and verified on the ACCCP production database on
2026-10-21, preserving existing documents and aggregate usage totals. Other
databases require their own reviewed migration before activation.

## Processing and review

1. Authorize the session and output choice, validate the PDF envelope and size,
   and save the immutable original under the document's existing retention lock.
2. Send the PDF to the private open-source repair worker. Existing tags are
   preserved. An untagged document is processed with OpenDataLoader, then reopened
   and inspected. The worker inventories the actual tags, page content, authored
   image descriptions and form fields. It checks preservation before proceeding.
3. Give the repair model the inventory, source PDF excerpts and page images.
   Work is assigned by physical pages and exact tag IDs in bounded batches. The
   model may propose supported changes and explain issues needing review.
4. Apply only validated operations to the saved PDF. Each operation names an
   editable tag and its exact expected source state. Reopen the result, compare
   the pages and content, inspect the structure, and run veraPDF against the
   delivered bytes. A preservation failure prevents publishing a repaired file.
5. Run an independent model audit against the original and repaired PDFs, the
   original page images and the reopened structure. Verified preservation of
   page appearance lets the audit use the original page images. Every page
   and tag must be assigned to an audit batch. Incomplete audit or machine
   evidence remains a visible finding.
6. Save the repaired PDF, review metadata, actual change summaries and findings.
   The result offers **Download repaired PDF**, **Changes made**, and **Items to
   review** with page numbers. PDF results never fetch or display generated HTML.

An opening-page or zoom setting is preserved when it resolves to a page in the
same PDF. This accepts ordinary initial views, including local GoTo actions;
it does not allow scripts, chained actions or external opening actions.

Page verification normally requires identical rendered pixels. Splitting an
unchanged text instruction while adding tags can occasionally alter a few
antialiased pixels at one render size. A bounded additional check can accept
that only when the text, drawing instructions, resources and document behavior
all match, no more than 128 pixels (and 0.01% of the page) differ at 108 dpi,
and independent renders match exactly at both 72 and 144 dpi. At most eight
pages may use this check, and the existing render-size limits still apply.
The saved evidence records the different pixels and additional checks;
`pixelsIdentical` remains false. A changed word, image, layout, or failed
additional comparison still prevents output. This does not establish
accessibility conformance.

The current general repair operations add a missing title or language, identify
supported text blocks as paragraphs/headings/captions/notes, add missing figure
descriptions, and identify simple table headers. Authored descriptions and
ActualText are preserved. The model cannot replace arbitrary PDF content, change
form behavior or create external references. Unsupported tables and uncertain
relationships remain findings.

The worker also offers narrowly verified structure candidates. The model may
separate a heading from the beginning of a paragraph at an existing text-show
boundary, group verified numbered or lettered paragraphs into list items,
join an immediately following continuation to its list item, or
identify a separately painted superscript as a reference to an unambiguous
nearby note. A trailing single or double asterisk may also be separated from a
text-show string when an explicit simple one-byte font makes its exact encoded
boundary verifiable. Only the original bytes are partitioned; text state and
spacing remain unchanged and saved-page preservation is independently checked.
These operations reuse original text and drawing instructions;
they do not rewrite wording or redraw pages. Unsupported boundaries and unclear
relationships remain for review. Saved tag lineage keeps historical and current
inventories aligned when a repair adds structure nodes. If optional candidate
discovery reaches its work limit, other repairs and checks continue with a
visible warning that the structural suggestions need review.

Additional source-bound candidates support aligned two-column tables whose text
was tagged as paragraphs, vector charts with missing figure descriptions, and
short linked callouts that interrupt a body sentence. Table repair separates
existing text instructions into cells and supplies column, row and group header
associations; notes remain outside the table. Chart repair groups verified plot
graphics and labels into a native Figure and attaches a detailed source-grounded
description proposed by the model. Reading-order repair joins the body fragments
and moves the callout after them in the tag tree. All three preserve visible
positions, wording, graphics and links. They require verified geometry and
content boundaries, followed by independent inspection of the saved structure.
Ambiguous cells, plots or reading relationships remain findings rather than
being guessed. The model audit then checks the repaired relationships and
chart descriptions against the original pages.

Table repair can also mark an untagged, uniform light background as decorative
when native instructions prove it is a constant fill tightly surrounding only
the table. Gradients, transparent fills, authored markings and uncertain
graphics remain untouched. Reopening verifies the exact background instructions
and resources as well as the table's text and header relationships.

When verified charts precede the continuation of an unfinished sentence from
the previous page, a separate candidate can move that unchanged paragraph
directly after its preceding paragraph in reading order. It requires an exact
source-bound anchor and compatible prior-repair proof if the anchor's heading
was split. Chart titles become native captions inside their figures. Pages
containing only fully tagged links can also gain a missing keyboard navigation
setting so Tab follows the structure order. Existing authored settings, form
pages and ambiguous annotation ownership are preserved.

Missing Note identifiers are added automatically when the existing identifier
tree is unambiguous. Decorative marked content and literally empty markers do
not require content tags, but meaningful unowned text or graphics still fail
the structure check. The independent auditor remains responsible for checking
whether content marked decorative actually carries meaning.

An excluded-text review reminder is retired only when its page has a complete
exclusion inventory, every audit batch touching that page finishes, the assigned
page reviewer confirms the excluded text is decorative or redundant, and no
conflicting content-loss finding remains. Saved review evidence records the
decision, explanation and exact output hash. Actual machine failures and
uncertain or incomplete reviews remain visible.

The audit treats extracted text as evidence rather than a recording of screen
reader speech. Some PDFs express spaces through character positions; extraction
engines can join words that are visibly separated. A joined inventory string
alone does not establish a delivered accessibility defect. The review still
checks missing words, numbers, negation and authored text alternatives, and
does not invent replacement text to compensate for extraction uncertainty.

Model batches keep a page's tags together where possible and split by serialized
evidence size as well as page and tag counts. Dense pages have one
owner for page-wide reviews, while every tag still receives review. A retained
heading concern can be cleared only by a complete independent review with
matching saved-tag evidence of the relevant repair. Machine findings and
unsupported form concerns cannot be cleared this way.

During preparation, the worker can also fill an absent link-annotation
description from the original link's verified text. This is a bounded automatic
repair for up to 200 simple text links in an already-tagged original PDF, each
with a unique, verified annotation owner. Additional links remain unchanged for
normal validation and review. It preserves existing descriptions, link
destinations, page appearance and
reading order. Ambiguous links, generic labels and unsupported structures remain
for review. The saved output is checked again to prove that only the intended
description was added and that it matches the original text.

Text-block repairs preserve inline spans and valid links. Custom source roles
correctly mapped to paragraphs or headings are eligible too. The repair changes
only the block's native role, with bounded inline descendants and independently
verified content ownership; it never absorbs a nested block, table or figure.

### Fillable forms

Some older forms, such as the W-9 test document, store the same controls in two
ways: standard PDF fields and an Adobe XFA form layer. The worker supports a
limited fixed-layout subset when it can map every field between those layers
and recognize the form's existing scripts. It preserves the original pages,
fillable text fields, checkbox controls, values, appearances, XFA data and
bindings. Accepted scripts are kept exactly; the repair service does not run
them. Forms that change layout, reference external resources, contain unknown
scripts or use unsupported controls remain unsupported.

Preparation can copy an existing authored XFA field description into a missing
standard PDF field label. For a supported segmented entry, it can add the
source-proven group name to an incomplete segment description in both layers,
so a label such as "Middle 2 digits" identifies which number it belongs to.
It can enable an existing direct XFA field speech prompt when that prompt and
its settings are supported. Other authored labels, including unsupported or
ambiguous cases, remain unchanged. These are deterministic preparation repairs;
the model cannot supply arbitrary form-label text or change form behavior.
It also removes verified legacy Adobe Reader usage rights from the repaired
copy because rewriting the PDF invalidates those rights. These rights are
distinct from a person's digital signature; digitally signed documents remain
unsupported. The original upload stays unchanged. A separate comparison checks
each permitted change against the source before ordinary preservation checks.

The saved inventory records the current labels and XFA speech settings, along
with each verified metadata change. The audit uses that evidence so completed
repairs are not reported again as original defects. The service preserves
scripts, data, bindings, values, validation flags, widget positions and page
appearance. Field announcements, checkbox choices and save/reopen behavior
still require interaction checks in Acrobat; enabled speech metadata does not
establish those results or PDF/UA conformance.

Required information and required-field validation are separate. The service
keeps explicit source instructions in the accessible description and does not
change validation flags or add new mandatory rules. A false native required
flag alone does not establish an accessibility failure when the requirement is
already clearly communicated. Conditional choices must retain their source
conditions. See [W3C PDF5](https://www.w3.org/WAI/WCAG22/Techniques/pdf/PDF5).
The absence of a signature, date or cross-out widget likewise does not establish
that a viewer lacks an accessible completion method. The audit reports a
specific demonstrated barrier or accurately describes an unverified method;
it does not create signing controls or substitute a typed name for a signature.

The local research tools have broader, fixture-specific experiments for OCR,
font substitution, broader form repairs and appended descriptions. Those experiments are
not automatically applied to arbitrary uploaded files by this first app engine.
Scanned text, complex forms, font defects and excluded content must remain
visible issues when they cannot be safely repaired.

## Accessibility claims

The technical target is **PDF/UA-1 (ISO 14289-1:2014)**. The service runs the
validator on the actual output, without adding a PDF/UA declaration merely to
make the check pass. Machine failures and incomplete checks remain independent
of the model's findings. An AI audit cannot dismiss a machine defect.

The app does not certify conformance or claim that a screen-reader test was
performed for an uploaded file. The final interactive research review was
stopped at the user's request and remains incomplete. Faculty see the remaining
issues and are asked to review the repaired PDF before sharing it.

## Limits and data flow

- Uploaded and generated PDFs: at most 4 MiB and 60 pages. Existing PDF rendering
  image, memory and page-preparation limits remain in effect.
- Worker: at most 5,000 tags, 500,000 inventory text characters and 500 distinct
  repair targets; 90 seconds per request and one active job per process. Busy
  requests fail with a controlled retry message. No durable queue is introduced.
- Model requests: bounded page/tag batches and at most four simultaneous calls,
  within the existing 260-second workflow deadline. Every completed conversion
  and audit call contributes to token and cost metrics, including failed attempts.
- The private worker accepts only authenticated app requests. Large repair
  requests use one short-lived signed object in the existing private storage
  bucket. The worker can fetch only that configured project's narrowly defined
  transfer path, verifies its exact size and SHA256, and refuses redirects.
  It receives no storage service-role or model credentials. Its document
  processors receive only the verified request bytes, and temporary files are
  deleted on completion or failure. The institutional LiteLLM
  endpoint receives the source/output excerpts, images and metadata needed by
  the repair model and auditor, as in other document workflows.

See [the worker protocol](../services/native-pdf/protocol.md) for its bounded
request/response contract. `NATIVE_PDF_URL` is server-only and supplied by the
private service binding in a hosted deployment. Set a shared strong
`NATIVE_PDF_API_KEY` on the web app and worker. A missing configuration fails the
PDF job clearly; it does not substitute Canvas HTML. Keep secrets out of Git.

## Storage and rollout

Migration `0016_native_pdf_outputs` adds `pdf_output`, allows `accessible_pdf`
jobs, and extends safe failure categories. Existing Canvas, Word and PowerPoint
jobs keep their destinations. The legacy one-job-per-document constraint remains;
upload another source copy to request a second destination.

The immutable source is `{session}/{document}/source.pdf`. The repaired file is
`{session}/{document}/{job}/output.pdf`, with `review.json` alongside it. Downloads
are named `*-repaired.pdf`. Only the owned, unexpired `pdf_output` artifact can
receive an attachment URL, valid for at most 60 seconds and bounded by the
original upload expiry. The app never returns the source as a repaired result.

Everything containing document content retains the original **14 elapsed days**,
including source, repaired PDF, review metadata, findings and event summaries.
Purge includes canonical job PDF/review paths even if artifact persistence failed,
plus every recorded legacy artifact path. Blob deletion precedes record deletion;
failed cleanup keeps its discovery records. Downloaded local files are unaffected.
Anonymous daily/model usage, cost and outcome totals survive content deletion.

When a repair request exceeds 4 MiB, `native-pdf-transport-storage.ts` first
commits a non-downloadable cleanup receipt, then uploads its bounded JSON under
`{session}/{document}/{job}/native-pdf-request-{UUID}.json` while holding the
retained-document lock. The worker gets a 60-second signed reference. The app
removes the object after the request and removes its receipt only after a
confirmed upload and deletion. Failed cleanup remains discoverable by purge.
A recent unsettled receipt delays physical deletion for one hour to allow an
ambiguous upload to settle; user access still expires after the original 14 days.
This transfer changes no page content or image resolution.

Before hosted activation, review and apply the migration to the intended
database, build and configure the private service, and verify the deployed
authenticated upload/repair/download/expiry flow. This change does not apply a
hosted migration, publish credentials or activate production by itself.

## Local integration verification, 2026-10-21

The web production build, TypeScript checks, 1,993 app tests, 32 Python worker
tests and 30 isolated PostgreSQL retention tests passed. Lint found no errors;
the existing unused schema callback parameter remains a warning.

Real worker/model runs covered a one-page text PDF, a one-page interactive form,
and a two-page classroom guide. The browser flow used an isolated local database
and storage service. It verified original-format selection, processing, persisted
PDF/review artifacts, both model-call costs, unchanged original expiry and the
signed PDF download. The classroom guide's downloaded result contains one H1,
seven H2 headings, image-description and table-header repairs; independent
comparison confirmed identical pixels on both original pages. Remaining link
and standards findings are visible in the result.

These results establish the implemented app path, not universal PDF coverage or
PDF/UA conformance. Sixty-page orchestration was tested with mocks. The root
`Dockerfile.native-pdf.vercel` runs an additional nonroot Linux HTTP test during
every image build, exercising the installed tagger, validator and actual worker
limits. No further Acrobat/NVDA testing was run.

## Hosted release verification, 2026-10-21

The private worker and native PDF workflow are deployed in production. The
Linux image build exercises the actual installed tagger, validator and worker.
Signed-in browser tests repaired and downloaded the classroom guide and a
synthetic PDF just below the 4 MiB limit. Independent checks confirmed preserved
page pixels, content and authored descriptions. Both jobs' completed model calls,
including the large file's initial failed attempt, were included in usage and
cost totals; their original expiration times were unchanged.

The large-file test exposed the hosted request-size limit. The signed transfer
path above lets repair proceed without reducing image detail. Scoped checks
confirmed that its temporary transfer objects and cleanup receipts were removed.
Public requests cannot reach the worker endpoints or bypass app authentication.

Saved-file findings distinguish pre-repair evidence from current machine checks.
The repair prompt explains automatic document-property repairs, and the audit
uses the reopened output's checks rather than inferring missing metadata from a
rebuilt page excerpt. Remaining real defects stay visible. These release checks
do not establish universal PDF coverage or PDF/UA conformance.

## Link-description repair verification, 2026-10-21

The follow-up link repair passed 62 Python worker/service tests, 52 focused app
tests, TypeScript and lint checks. The real local HTTP worker smoke test also
passed. Tests cover authored-description preservation, ambiguous ownership,
hidden/clipped text, ordinary underlines, changed destinations, saved-output
tampering, repeat processing and the 200-link/operation-scan bounds.

Against the exact classroom-guide production download, preparation added one
missing annotation description on page two using the existing W3C link text.
Both link-related veraPDF failures disappeared; the missing PDF/UA declaration
remained. Independent comparison confirmed identical pixels on both pages,
unchanged destinations and annotation properties, and preserved footnote
descriptions. Repeated preparation and a normal repair round-trip preserved
the addition without duplicating the change. This follow-up used no model calls
or new desktop screen-reader tests and made no font changes or conformance claim.

## W-9 form metadata verification, 2026-10-22

Local verification passed 187 Python worker tests, 60 focused app tests,
TypeScript, ESLint and the authenticated worker HTTP smoke test. A complete
worker/model run on the six-page W-9 enabled 23 existing field speech prompts
and added authored SSN/EIN group context to three segmented-field descriptions.
Independent checks confirmed unchanged original page pixels, fonts, form
scripts, values and control behavior. The earlier heading, list and footnote
repairs also passed their 15 semantic assertions.

Acrobat with portable NVDA 2026.2 announced the name field's required-entry
instruction, classification checkbox labels/states and all three revised
segment labels. Keyboard selection of a second classification cleared the
first. A separate copy containing fictional test values was saved, closed and
reopened; the values, checkbox state and descriptions persisted. Fifteen
independent saved-copy checks matched native values, XFA datasets and visible
appearances. The blank output and original file remained unchanged.

Acrobat displayed a Font Capture application error during opening. The test
continued after dismissing it; no font or Acrobat configuration changes were
made. Keyboard signing, dating and certification strikeout were not established
by these checks, so their specific interaction-review concerns remain. These
local results do not claim PDF/UA conformance or activate a hosted release.

## Automatic structure repair verification, 2026-10-23

Local verification passed 311 Python worker tests, 170 native-PDF app tests,
TypeScript and scoped ESLint checks. The rebuilt nonroot Linux worker passed
its installed-toolchain HTTP smoke test. Replaying the real model plan through
the production supervisor completed in 48.91 seconds, within the unchanged
90-second request limit and existing CPU, memory and file bounds.

A full repair and independent model audit of the four-page Einstadter journal
PDF completed in 113 seconds. It rebuilt the 19-row table with column, group,
subgroup and row-header associations; attached detailed descriptions to both
native chart Figures; separated three run-in section headings; repaired three
interrupting callouts and the cross-page Methods continuation; and supplied
structure-order keyboard navigation for the four link-only pages. The audit
reported no remaining table, chart-description or reading-order defect. Four
excluded-text reminders were retired with complete, hash-bound review evidence.

Independent comparison preserved original drawing instructions, text, resources,
fonts, images, annotations and fields. Pages 2–4 were pixel-identical. Page 1's
57-pixel rasterization difference at the primary scale passed the existing
strict multiscale proof, with exact pixels at scales 1 and 2. No page was redrawn.

The final report retains six findings about existing long URL descriptions on
links, plus the source font-embedding failure and missing PDF/UA declaration.
Extractor-dependent word-spacing concerns were investigated against the original
and repaired files and are no longer asserted as proven screen-reader failures.
No new desktop screen-reader test or PDF/UA conformance claim was made. This
verification is local; it does not activate a hosted release.

## Static W-4 support verification, 2026-10-28

The five-page 2026 W-4 now completes native repair and a complete independent
model audit while preserving its original appearance and 48 form controls.
The follow-up adds bounded form variants, reduces repeated native/model evidence
work, and preserves numeric precision during structural content rewrites. See
[the W-4 verification report](w4-native-support.md) for exact scope, costs,
remaining worksheet-table and other findings, and the interrupted desktop check.
These changes remain on the review branch; they are not a conformance claim.
