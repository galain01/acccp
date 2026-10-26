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
