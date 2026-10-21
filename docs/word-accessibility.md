# Native Word accessibility repair

The Word destination returns an editable `.docx` based on the uploaded file.
Canvas HTML remains a separate choice. This engine makes targeted accessibility
repairs while preserving the document's existing appearance and content.

## Processing

1. Inspect the original ZIP/XML package with explicit byte, entry, XML, nesting,
   object-count and processing bounds. Reject damaged, protected, signed,
   macro-enabled or externally linked embedded content before rendering.
2. Inventory paragraphs, tables and supported images. Machine checks identify
   missing metadata, heading jumps and structures the writer cannot repair.
3. Render the source with the existing private Word rendering service. Use page
   images and native properties as evidence for the model; source content never
   becomes an instruction. The PDF is a preview, not the downloadable result.
4. Request a complete repair plan for exact source object IDs. The permitted
   operations are heading outline levels, paragraph language, simple first-row
   table headers, missing image descriptions and decorative-image metadata.
   Changes cannot rewrite words, links, table data, styles, media or layouts.
5. Apply validated operations to the original package. Verify unchanged content
   and parts, reopen the result and check that requested properties were written.
6. Render the repaired file and compare page count, extracted text and decoded
   page pixels. If a candidate changes layout, undo the potentially visible
   repairs and verify again. Unverifiable changes are not delivered as repairs;
   the result explains what was left unchanged.
7. Independently audit the actual final file's native inventory and source/output
   page images. Every page and assigned object must be accounted for. Invalid,
   incomplete or failed audits remain visible as review warnings. They cannot
   dismiss machine findings or be treated as a clean result.

Model requests contain at most eight pages per batch (16 images for a
before/after audit), with at most four requests running concurrently. Both
stages use the app's existing LiteLLM configuration and stage-specific model
overrides. All completed calls retain their token and cost receipts, including
calls preceding a failure. The workflow budget is 260 seconds within the
route's 300-second limit.

## Preservation and current scope

- Uploaded DOCX files remain limited to 4 MiB and 60 rendered pages. Trusted
  generated packages allow up to 8 MiB for added metadata.
- Existing image descriptions are preserved. Functional images cannot be
  marked decorative. An image needs reliable source evidence before a new
  description is written.
- Complex/merged tables, manually typed lists, inaccessible linked labels,
  complex figures needing a long explanation, tracked changes, legacy drawings,
  text boxes and embedded objects may require human review. Unsupported content
  is preserved and described at its source location.
- The app does not rebuild the document from HTML, replace images, simplify
  tables, redesign pages, or add an automatic repair loop after the audit.
- Locations use stable paragraph/table/image IDs and nearby words. Preview page
  numbers are shown only when supported by evidence. Word can paginate
  differently with a different font set, printer configuration or application.
- Downloads show **Changes made** and **Items to review**. Word does not yet have
  the PowerPoint per-change keep/restore interface. The original remains intact.
  Run Word's Accessibility Checker and review the result before sharing it.

Schema validation, unchanged rendering and model review test different aspects
of the file. They do not replace Word and assistive-technology testing.

## Storage and release

Migration `0015_native_word_outputs` adds the `docx_output` artifact and enables
the `accessible_docx` target plus bounded Word failure categories. It must be
applied to the intended database before releasing this code. Generation and
local migration tests do not apply it to a hosted project.

The immutable source is `session/document/source.docx`. The updated file and
review are `session/document/job/output.docx` and `review.json`. Rendered PDFs
are transient for this destination; no PDF or HTML artifact is substituted.
Downloads require ownership, an unexpired document and a short-lived signed
URL. Reprocessing uses the immutable source and the saved output target.

All originals, outputs, findings and review text keep the existing 14-day
retention period. Purge includes canonical DOCX output keys even if an artifact
save failed. Anonymous daily/model usage, cost and job metrics survive cleanup.
Downloaded files are unaffected.

## Local evaluation

The CLI uses the same engine and configured renderer, with no database writes:

```powershell
node --conditions=react-server --env-file=.env.local --env-file=.env.word-to-pdf --import tsx scripts/repair-word.ts input.docx output-directory
```

It writes `repaired.docx` and a local `result.json` with changes, findings and
model-call receipts. Keep documents and reports outside version control.
Unit/integration tests cover unsafe packages, source preservation, repair
contracts, missing audit coverage, layout rollback, failed-call accounting,
destination dispatch, downloads, and retention. The separate in-memory
PostgreSQL suite verifies the actual migration and purge without hosted data.
