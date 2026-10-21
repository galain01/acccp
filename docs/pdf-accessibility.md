# Native PDF accessibility repair

This branch adds `accessible_pdf` (`pdf-v1`) to the app. An instructor can keep a
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
   original page images and the reopened structure. Verified identical pixels
   let the audit use the original page images for visual comparison. Every page
   and tag must be assigned to an audit batch. Incomplete audit or machine
   evidence remains a visible finding.
6. Save the repaired PDF, review metadata, actual change summaries and findings.
   The result offers **Download repaired PDF**, **Changes made**, and **Items to
   review** with page numbers. PDF results never fetch or display generated HTML.

The current general repair operations add a missing title or language, identify
supported text blocks as paragraphs/headings/captions/notes, add missing figure
descriptions, and identify simple table headers. Authored descriptions and
ActualText are preserved. The model cannot replace arbitrary PDF content, change
form behavior or create external references. Complex tables and uncertain
relationships remain findings.

Text-block repairs preserve inline spans and valid links. Custom source roles
correctly mapped to paragraphs or headings are eligible too. The repair changes
only the block's native role, with bounded inline descendants and independently
verified content ownership; it never absorbs a nested block, table or figure.

The local research tools have broader, fixture-specific experiments for OCR,
font substitution, form labels and appended descriptions. Those experiments are
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
limits. Hosted upload/download verification remains a release gate. No further
Acrobat/NVDA testing was run.
