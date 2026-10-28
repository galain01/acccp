# ACCCP reliability architecture review

Reviewed on 2026-10-26 against base
`58adb76a30ffed4263b853eb438a95ba8cc4b7b8`. This is a source review and a
fixture plan, not a production certification. Line references below describe
that base; the bounded implementation is specified in
[reliability-refactor.md](reliability-refactor.md).

The subsequent [reliability follow-up](reliability-follow-up.md) addresses the
framework dependency blocker, immutable initial-conversion publication, Canvas
overlap prevention, and full synthetic native PDF CI coverage. The findings
below retain their original source-review context; current publication behavior
and remaining boundaries are documented in [artifact-publication.md](artifact-publication.md).

## Verified architecture

The application already has separate native engines. Preserving and strengthening
them is better supported by the source than replacing them with a generic document
converter.

| Responsibility | Evidence in the current source | Reliability implication |
| --- | --- | --- |
| Request orchestration | `app/api/convert/route.ts`: 988 lines at base; `maxDuration = 300` at line 111; awaited engine calls at lines 614-634 | Work is synchronous and tied to a request. An engine result, artifact publication, and the HTTP response are distinct failure boundaries. |
| Browser batch | `components/ui/document-workspace.tsx:324-348` awaits each document; lines 251-255 learn an uploaded PDF/DOCX document ID from response JSON | Batch execution is serial and depends on the open page. A lost initial response can leave the browser without the already-saved source identity. PPTX has an earlier upload reservation. |
| Saved result identity | `lib/db/schema.ts:575-579` retains both document-only and document/target uniqueness; route rejects a changed saved target | One saved source currently has one result job and destination. Multiple destinations require a compatible schema and UI change. |
| Native Word | `lib/word-convert.ts:803-809` inspects and checks the package before model work; `lib/docx-package.ts` patches bounded OOXML operations | The original editable package is preserved. Output is reopened, source/output identities are checked, and actual renders are compared. Unsupported or ambiguous structures stay visible. |
| Native PowerPoint | `lib/powerpoint-convert.ts`, `lib/pptx-package.ts`, `lib/pptx-revisions.ts` | Repairs retain the original package and editable objects. Intentional visible changes require source/output evidence. Appended description slides and selected replay have their own validation. |
| Native PDF | `services/native-pdf/worker.py:1097-1179`, `lib/native-pdf-convert.ts` | Saved bytes are reopened; source content, behavior, and rendering are checked; veraPDF examines the delivered bytes; an independent semantic audit checks assigned pages and tags. |
| Resource limits | Word, PPTX and PDF workflows define 260-second deadlines; `services/native-pdf/server.py` defines a 90-second processor deadline and bounded request/result sizes | Increasing concurrency or document limits without admission and recovery design could multiply load and failures. |
| Ownership and expiry | `lib/document-retention.ts`, route publication, and `lib/actions/documents.ts` | Existing locks, ownership checks, attempt guards, and original 14-day expiry are shared invariants that refactors must retain. |

The native engines do not establish arbitrary-document conformance. PDF retains
machine defects and incomplete audits; Word may keep the original when a repair
cannot preserve the layout; PowerPoint keeps incomplete-review guidance when
independent coverage fails. These are intentional outcomes, not successful
certification. The relevant contracts are described in
[PDF accessibility](pdf-accessibility.md),
[Word accessibility](word-accessibility.md), and
[PowerPoint accessibility](powerpoint-accessibility.md).

## Findings and next increments

### 1. Publish an immutable output/review pair per attempt

**High priority; identified by source inspection, not a production replay.**
At base, `app/api/convert/route.ts:729-731` uploads an output and then its review
to the same job-scoped keys reused on reconversion. Artifact and finding updates
commit afterward. `lib/actions/documents.ts:213-248` permits download through an
available artifact row with matching ownership, retention, and target; it does
not bind the download to an output hash or attempt.

Consequently, a successful output overwrite followed by a review-upload or
database failure can leave the prior artifact row pointing to new bytes while
the findings or review still describe the previous attempt. A database rollback
cannot undo that object-store overwrite. This should be addressed independently
of catching unexpected engine exceptions.

The existing selected-PPTX export workflow in `lib/powerpoint-review-storage.ts`
provides a useful local pattern: reserve discoverable immutable artifacts,
upload the pair, then switch available pointers. Generalizing that publication
contract needs tests for each upload failure, ambiguous database completion,
retry, supersession, and retention cleanup. It does not require a new document
processor or an engine rewrite.

### 2. Make native PDF regression checks a Linux merge gate

**High priority; baseline gap partially addressed in this increment.** At the
reviewed base, the repository's only workflow, `.github/workflows/test.yml`, ran
TypeScript formatting, typecheck, and Vitest.
`vitest.config.ts` includes `*.test.ts` and `*.test.tsx`; it does not execute the
Python suites in `services/native-pdf` or `research/native-pdf`.

This increment adds a Python 3.12 step to the existing Linux test job for
`test_server*.py`. It uses only the standard library and covers the supervisor,
including the real Linux orphan-process regression. Its remote execution remains
to be verified; adding a workflow is not evidence that it has passed.

The PDF engine already has substantial synthetic tests for native structure,
forms, saved-output verification, transport, and resource bounds. Those tests
are existing coverage, but the full engine suite is still not an enforced merge
gate. A next increment should extend the reviewed Linux job using the pinned worker requirements and a
documented test command. Include real process-group lifecycle checks on Linux;
a Windows skip or a mocked process test does not verify that behavior. Separate
the fast synthetic suite from tests that require pinned OpenDataLoader/veraPDF
artifacts and a full hosted image. Any CI change should be reviewed with the
repository's build and spending constraints.

### 3. Recover request and attempt identity across interruptions

**Medium priority; confirmed architectural exposure.** The browser learns the
saved ID for an initial PDF/DOCX conversion only after receiving parseable JSON.
Closing the page, losing a response, or terminating the process can interrupt
the visible workflow after persistence or model work. Catching an ordinary
engine rejection improves one boundary but does not resolve a hard process
termination or an absent response.

Before adding a queue, specify a durable submission/attempt identity, controlled
reconciliation of stale processing jobs, and retrieval of the current result
using the existing database. Use explicit retry policy and preserve measured
costs. Do not automatically reissue billable model calls after an uncertain
outcome.

The native duplicate-start guard at `app/api/convert/route.ts:542-558` is inside
`if (isNative)`. Canvas overlapping requests can still perform duplicate model
work even though stale output publication is guarded. A follow-up should test
the same concurrency contract across destinations before enabling browser
parallelism.

### 4. Track capabilities and evidence across fixture classes

**Medium priority.** Existing format-specific tests are extensive. What is
missing is a concise, maintained mapping from a document class to supported
operations, mandatory preservation evidence, and the expected unsupported or
manual-review outcome. Shared result reporting must distinguish:

- a safely repaired output with complete required evidence;
- a preserved output with remaining machine or semantic findings;
- an incomplete independent audit;
- a rejected input or repair with the original retained.

These states should never collapse into an accessibility certification. A
cross-engine evidence contract can improve consistency while leaving the
different native operation models intact.

## Representative fixture matrix

The rows below describe both existing coverage and regression targets. They do
not claim every fixture has been newly created or run in this increment. Use
synthetic generated files or explicitly authorized local samples; keep private
document text and evaluation outputs out of Git.

| Format/class | Required examples and outcome | Independent evidence and existing test anchors |
| --- | --- | --- |
| DOCX semantics | Plain paragraphs/headings, inherited language, authored descriptions, functional images and hyperlinks | Reopen actual output; preserve unchanged XML, media, relationships and text; `test/docx-package.test.ts`, `test/word-convert.test.ts` |
| DOCX structural repair | Typed bullets/numbering across a page boundary; dosage prose and singleton negatives; simple versus ambiguous/merged table headers | Exact source-derived labels and body text, actual source/output lineage, measured layout regions; `test/word-layout-verification.test.ts` and native Word tests |
| DOCX package boundaries | Headers/footers/notes, tracked changes/content controls; XML declared under unusual extensions; DTDs, unsafe fields, external assets, duplicate/escaping entries, CRC and size limits | Reject unsafe or ambiguous packages before rendering; apply existing parse/node/byte budgets to all declared XML. Alternate-extension cases are the new regression family in this increment. |
| PPTX object preservation | Notes, media, hidden slides, authored descriptions, links, grouped/animated/overlapping objects | Original identities/order/facts/relationships preserved; render every actual output slide; `test/pptx-package.test.ts`, `test/powerpoint-convert.test.ts` |
| PPTX bounded changes | Two-column caption/header repair versus ambiguous tables; empty versus functional placeholders; appended description slides; selected replay | Verify intended deltas, preserve data rows and interactions, never reapply declined changes; `test/pptx-empty-placeholders.test.ts`, `test/pptx-description-slides.test.ts`, revision/review suites |
| PPTX batching | 1, 8, 9 and 59 slides; appended slide crossing a batch boundary; failed or incomplete audit/corrective response | Exact global slide coverage and bounded model concurrency, complete final-slide audit or explicit warning; `test/powerpoint-model-batches.test.ts`, `test/powerpoint-convert.test.ts` |
| PDF native structure | Tagged and untagged originals; custom/inherited roles; tables, vector charts, lists, notes, links and cross-page reading order | Source-bound candidates, reopened graph and content, retained original nodes/wording/actions; `services/native-pdf/test_bounded_*`, `test_native_structure_*`, `test_worker.py` |
| PDF rendering and text | Saved revisions, ActualText, embedded/unembedded fonts, sparse rasterization differences, image-only photograph versus text scan | Original hash unchanged; exact PDFium pixels or the bounded multiscale proof; veraPDF on final bytes. Do not infer OCR correctness from image presence or a model assertion. |
| PDF forms and actions | Supported static hybrid form; dynamic XFA, signatures, unknown scripts and external resources; local opening view versus chained/external actions | Exact labels/values/widgets/behavior preservation; unsupported cases rejected; `test_hybrid_*`, `test_initial_view.py`, `test_link_tab_order.py`. Metadata does not prove interactive screen-reader behavior. |
| PDF protocol and resource limits | Wrong source/output hash, stale snapshot, unknown operations, dense/cross-page tags, oversized input/output, page/tag/text/deadline bounds | Fail closed without dropping evidence or pretending full coverage; TypeScript worker/convert tests and Python worker/server/transport tests |
| All formats: failure lifecycle | Engine rejection, processor exit/timeout, malformed model output, preservation refusal, partial audit, lost response, concurrent starts, partial save, database rollback, expiry/deletion during work | Safe diagnostics and retry identity; no private exception text; retain measured usage and original expiry; no stale attempt publication. Engine rejection and PDF worker lifecycle are new regression families in this increment; immutable publication and hard-interruption recovery remain follow-ups. |

For every accepted repair, retain an expected-content oracle separate from the
repair plan: source text/data and native identities, permitted changes, remaining
findings, and the exact bytes inspected by each validator. Tests that only accept
the repairer's own success flag do not establish preservation. Real Word,
PowerPoint, Acrobat and assistive-technology checks remain release evidence for
representative classes; unit tests and a semantic model audit do not replace them.

## Scope and verification limits

This review did not run production conversions, access private user documents,
make paid model calls, change data, or propose a deployment. It does not attest
to arbitrary-document accessibility or current interactive application behavior.
The implementation report records the commands actually run and distinguishes
passing tests from skipped or unavailable platform checks.

## Independent review of this increment

The independent diff review found no blocking issue in the conversion exception
boundary, DOCX/PPTX content-type inspection and budgets, or PDF supervisor
deadline/process cleanup changes. It checked failure ordering, existing retention
and attempt guards, private diagnostic suppression, and preservation of native
engine dispatch. This is a verdict on the bounded changes, not release approval
for the entire application; see the separate dependency security review.

Mutation checks ran in a separate task-local source snapshot, leaving the working
branch untouched. Inverting the new unexpected-exception boundary caused all six
selected route regressions to fail on missing identities or wrong terminal
responses. Disabling declared-XML inspection caused five selected DOCX regressions
to fail on unsafe acceptance, missing header inventory, or the XML budget. Both
snapshot files were restored byte-for-byte. The same selected tests then passed
11/11; 81 other tests were excluded by the explicit test-name filter. The main
implementation report records the complete suite results separately.
