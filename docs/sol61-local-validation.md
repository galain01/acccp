# Sol 6.1 configuration and application validation — 2026-10-26

Code candidate: `f8bd62a3af62ae735df97f4b2c155ab05992e26e`, building on
draft PR37's generated-structure-index fix and the unmerged PR34–36 stack.
This follow-up completed the actual signed-in browser upload, native PDF repair,
independent model audit, publication and download flow for seven corpus inputs.
Three inputs remain rejected. Every returned PDF retains accessibility findings.
No merge or production deployment was performed.

## Configuration and isolated services

- The earlier local validation loaded `.env.local`, whose old key selected the
  previous 5.6 default. The explicitly selected `.env.sol61.local` profile now
  supplies the authorized key and `gpt-6.1-sol-2026-09-29` for shared, repair and
  audit model settings. A small real completion and gateway pricing lookup passed.
  The code default and setup documentation now select the same 6.1 model.
- PostgreSQL17.10 ran on loopback in a task-local data directory, using a new
  `acccp_validation` database and synthetic local accounts. Its binary package was
  downloaded with lifecycle scripts disabled and its registry SHA512 verified.
  No production database connection, schema, account or data was used.
- Storage used a new, private `acccp-validation-20261026-*` bucket in the existing
  ACCCP Supabase project. The production `documents` bucket was not used.
  `SUPABASE_DOCUMENTS_BUCKET` selects this bucket in both app and PDF worker;
  the stored-request transport still restricts signed reads to the exact configured
  origin, bucket, UUID path, size and checksum.
- Initializing the empty database exposed a schema declaration error: the unique
  artifact-type index used `uuid_ops` for an enum. Changing that column to
  `enum_ops` allowed real PostgreSQL schema initialization. No hosted migration
  was run.
- Existing approved Java17, OpenDataLoader2.5.14 and veraPDF1.30.3 tools ran in
  the candidate's local worker. The app used Next development mode on loopback;
  sign-in codes were delivered to its local console, without sending email.
- The hosted preview was intentionally left unconfigured. Cloudflare D1 uses
  SQLite and would require changing this PostgreSQL-based application; Hyperdrive
  connects an existing database rather than providing a replacement database.
  No Cloudflare resources or subscriptions were created. The automatic Vercel
  preview remains failed; successful local tests do not establish hosted execution.

## Ten actual browser submissions

The immutable acceptance manifest remains SHA256
`430f3d055df9327dd286e5ea5822ca66809fea02ab36e6b36bfb3de542071c40`:
ten whole PDFs,68 original pages. The seven outputs contain36 pages.
All original local files and uploaded source objects retain their original hashes.

| Case | Input | Repair/audit/download | Calls | Gateway USD | Remaining errors / warnings |
| --- | --- | --- | ---: | ---: | ---: |
| 01 | PLOS citation-advantage paper,7 pages | Completed; audit coverage complete | 4 | 0.8836052 | 12 / 15 |
| 02 | PLOS AI-manuscript paper,16 pages | Refused: unverifiable source navigation | 0 | 0 | — |
| 03 | Attention Is All You Need,11 pages | Refused: missing source link destinations | 0 | 0 | — |
| 04 | NIST Zero Trust slides,10 pages | Completed; audit coverage complete | 6 | 0.5856836 | 3 / 12 |
| 05 | NIST-hosted PQC slides,7 pages | Completed; audit coverage complete | 4 | 0.3958704 | 21 / 8 |
| 06 | Blank IRS W-9,6 pages | Completed; audit coverage complete | 11 | 2.4729660 | 1 / 4 |
| 07 | Blank IRS W-4,5 pages | Refused: unsupported XFA features | 0 | 0 | — |
| 08 | Synthetic image-only scan,1 page | Completed with unresolved scan findings | 2 | 0.0310452 | 3 / 1 |
| 09 | Synthetic mixed text/scan,2 pages | Completed with unresolved scan findings | 2 | 0.0514572 | 3 / 1 |
| 10 | Synthetic mixed orientation,3 pages | Completed with excluded-text findings | 2 | 0.0736800 | 2 / 2 |

All31 recorded application calls identify `gpt-6.1-sol-2026-09-29`, across both
repair and audit. They total2,179,889 tokens and USD4.4943076 as reported by the
gateway; this includes all batches in both stages. The separate connection probe
used29 tokens and USD0.00009. No model call was made for the three refused inputs.

The first browser attempt on case10 failed before any model call because this
checkout borrowed dependencies through a junction; the renderer's filesystem
permissions rejected the resolved paths. A direct frozen install fixed the test
setup without relaxing renderer restrictions. The same saved upload then completed.
Adding the other nine inputs skipped the already completed case10 rather than
repeating its model work.

## Independent checks on the actual downloads

Every successful file was downloaded with the app's authenticated download control.
All seven download hashes match the corresponding published artifact bytes and
matching saved reviews. Both pypdf and PDFium independently reopened all36 pages;
all page geometry/rotation and pypdf-extracted text match. Canonical form names,
types and values match, including all23 blank W-9 fields.

The first paper retains two previously documented exceptions: PDFium removes two
generated word-boundary spaces on page2; page6 differs at25 primary-scale pixels,
with exact renders at scales1 and2. The source also has mathematical text-mapping
defects. These results do not establish correct speech or mathematical semantics.
Other downloaded pages have identical compared pixels and PDFium text. All pages
were rendered and compared automatically; first-page contact sheets were visually
reviewed. No new Acrobat, native Office or assistive-technology interaction test
was performed.

All seven saved outputs received completed veraPDF validation and still fail
PDF/UA-1 checks. The independent model audits also retained unresolved issues,
including table structure, image descriptions, excluded reading-order content,
fonts and form interactions. A completed job/audit is not an accessibility pass.
No declaration or conformance claim was added to turn these results into passes.

## Automated verification and evidence

[Linux CI40391723559](https://github.com/galain01/acccp/actions/runs/40391723559)
passed for code head `f8bd62a`:2,291 application tests in91 files,342 native tests
without Linux skips,64 PostgreSQL/WASM transaction tests (22+30+12), formatting,
type checking, production build,21-page renderer smoke and15 signed-out runtime
checks. The actual unprivileged Linux Java/tagger/validator image smoke also passed.
The image was built for verification; no production image was published.

Local Windows checks passed the same application/transaction suites and342 native
tests with one expected POSIX-only skip. Changed-code lint had no errors and retained
one existing unused-parameter warning in the schema. Configured secret values were
absent from the committed diff; no environment files are tracked.

Detailed local evidence is under the task's `local-validation/sol61-e2e/` directory:
`flow-results.json`, `browser-downloads.json`, downloaded source/output/review pairs,
`independent-final-repairs/comparison.json`, renders, browser proof and test logs.
These public/synthetic PDF bytes and all private runtime settings remain outside Git.

The remaining hosted recovery/concurrency, security reachability and human
accessibility gates in `release-validation-checklist.md` remain separate. The local
flow now has real model and download evidence; universal PDF support and fully
automatic accessibility remediation remain unfinished.


## Automatic repairs and preserved broken links — 2026-10-26

Native PDF repair now repairs supported table, image-description and reading-order problems automatically while preserving the original pages. Existing broken internal links no longer block repairs to the rest of a document. The implementation tested in the signed-in browser is committed as `564326bdc06a09f6c6daeb77c96fc623c3bde50c`; subsequent documentation changes do not change runtime behavior.

The source-bound writers now support captioned three-to-eight-column grids, wrapped column headers, grouped row headers and table rows mistakenly tagged as lists. Existing text excluded as page decoration can be restored when its complete native scope is verified. Meaningful excluded graphics can receive descriptions, including a bounded Caption/P subtree. A fixed three-fragment operation rejoins interrupted text around a separate styled line. A separate operation restores decimal-percentage paragraphs incorrectly tagged as numbered lists. Every operation preserves original native nodes and identifiers and is checked again after saving.

Missing image alternatives are repaired from the visible source. A short scanned text page receives its full visible wording, including numbers and negation, rather than a generic image summary. This provides a text alternative; it does not create selectable OCR text. Useful authored descriptions and ActualText remain protected. An exact generic authored Figure placeholder can be replaced only through a private source-and-paint-bound approval checked independently on the saved file.

Broken navigation is inspected separately from preservation. Unique named destinations continue to resolve when another name is duplicated. Missing or ambiguous original targets produce page/link warnings while their original actions and destination dictionaries stay intact. Changing, dropping or redirecting a link—including changing one broken destination name to another—fails preservation. Unknown/chained unsafe actions still fail inspection. The model cannot invent replacement destinations. A correct future link repair would identify a unique intended anchor, rebuild its destination mapping or explicit page target, and verify that both click and keyboard activation reach that location; ambiguous anchors need review. See [Adobe's actions and destinations documentation](https://developer.adobe.com/acrobat-pdfl-sdk/guides/pdfmark/pdfmark-actions).

Preparation also removes a narrowly verified nonexistent reference generated for the Crossmark link in case 02, while retaining the actual link, annotation, identifier and painted badge. This never removes missing references from authored tagged input. Missing generated ID indexes are verified through symmetric private catalog normalization, accommodating hierarchical page trees without relaxing actual saved ID/owner checks. Generated “Annotation” Link alternatives can be removed and annotation labels restored from exact verified visible wording; authored annotation descriptions and useful generated alternatives stay protected.

### Full application results

All ten original acceptance files were uploaded through the signed-in local application. Nine completed actual model repair, mandatory independent audit, storage publication and authenticated browser download. The model for every recorded repair and audit call was `gpt-6.1-sol-2026-09-29`. The W-4 remains unsupported because of its form features; no repaired file was published for it.

| Case | Original file | Processing result | Remaining errors | Remaining warnings |
| --- | --- | --- | ---: | ---: |
| 01 | 01_plos_citation_advantage_2006.pdf | Completed; audit and download verified | 8 | 12 |
| 02 | 02_plos_ai_manuscript_2024.pdf | Completed; audit and download verified | 9 | 47 |
| 03 | 03_neurips_attention_2017.pdf | Completed; audit and download verified | 10 | 91 |
| 04 | 04_nist_zero_trust_101_slides.pdf | Completed; audit and download verified | 3 | 11 |
| 05 | 05_nist_hosted_pqc_transition_slides.pdf | Completed; audit and download verified | 4 | 10 |
| 06 | 06_irs_w9_blank_march_2024.pdf | Completed; audit and download verified | 1 | 3 |
| 07 | 07_irs_w4_blank_2026.pdf | Unsupported form; original retained | — | — |
| 08 | 08_image_only_scan.pdf | Completed; audit and download verified | 0 | 1 |
| 09 | 09_mixed_text_and_scan.pdf | Completed; audit and download verified | 0 | 1 |
| 10 | 10_mixed_orientation.pdf | Completed; audit and download verified | 0 | 1 |

These are remaining findings, not a claim that a completed file meets accessibility standards. In particular, the Attention paper still has complex tables and mathematical expressions that the bounded writers cannot reliably reconstruct, along with continuation and heading issues. Original font/character mappings and some source annotation/structure defects remain. They remain visible in the app. No PDF/UA declaration, universal accessibility claim or new screen-reader testing claim was added.

All four tables in case 01 are now native tables with header relationships; the false 19.4%/20.0% list was repaired. The timeline's interrupted title and equivalent chronology no longer produce semantic errors in case 05. Cases 08–10 retain only the PDF/UA declaration notice. Case 02 preserves 30 broken-link warnings; case 03 preserves 77, and its 77 generated generic Link alternatives have been removed.

Independent reopening and rendering checked all **63 pages** of the exact **9 browser downloads**. Every downloaded hash matches its published artifact, every original upload retains its corpus hash, and page geometry, pypdf text, and canonical form names/types/values match their originals. The known case-01 exceptions remain: PDFium extracts two fewer spaces on page 2, and page 6 differs by 25 pixels at 1.5× while the worker's 1× and 2× renders and drawing programs match. These exceptions are recorded rather than described as exact equality at every rendering scale.

This session recorded **81 model calls, 6,879,983 tokens and USD 13.957398**. These totals include failed integration attempts and repeated comparisons, not just the final nine outputs. Integration regression tests now cover cross-process candidate stability, unrelated heading changes beside nested table rows, and preserved link descriptions after tag preorder changes.

### Verification and operational scope

Local checks passed: 2,298 application tests; 439 native-engine tests with one POSIX-only skip on Windows; 105 related research/navigation checks; 64 isolated PostgreSQL transaction tests; formatting, type checking and targeted lint; a production build; a 21-page traced renderer smoke; and 15 signed-out runtime checks with zero service contacts. CI also runs the research/navigation regressions and the unprivileged Linux worker image smoke. The pinned local Python packages match the production requirements: pypdf 6.10.0, pypdfium2 5.14.0 and Pillow 12.3.0.

The actual flow used a new local PostgreSQL database and a dedicated private bucket in the existing Supabase project. No production database connection, production document-bucket access, schema migration, paid database subscription, Cloudflare database, merge or deployment was used. The dedicated bucket was emptied and removed, local app/worker/PostgreSQL services stopped, and temporary runtime secrets deleted. Downloaded PDFs and local evidence remain available.

Local evidence is under `C:/Users/alai04/Documents/Codex/2026-10-26/task/local-validation/automatic-pdf-e2e/`: `flow-results.json`, `browser-downloads.json`, `independent-final-repairs/comparison.json`, the nine per-case PDFs/reviews, `broken-link-warning-final.png` and `cleanup-evidence.json`. Hosted preview remains intentionally unconfigured. Existing release gates for hosted recovery/concurrency and human accessibility checks remain separate from these completed local tests.
