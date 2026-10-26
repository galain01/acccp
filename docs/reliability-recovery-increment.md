# Third reliability increment: submission and selected-result recovery

This increment starts at `e2089405a5a7e5f9bf1b4440f604ce177011be6f`, the
unchanged head of draft PR #35. It uses a separate worktree and branch. It does
not merge, deploy, migrate production data, change credentials, upload private
documents or make paid model calls. The denied Vercel diagnostic is not retried.

## Capability map and acceptance criteria

| Capability | Contract | Evidence required |
| --- | --- | --- |
| Initial submission recovery | Establish a server-generated document identity before any mutating upload or conversion request. A lost preparatory response creates no stored data. Bound the identity to the authenticated owner, session, original name, size/hash, output target and a fixed deadline. Replayed submissions never overwrite the original, extend retention, resurrect deleted records or silently repeat model work. | Synthetic response loss, duplicate requests, ownership/metadata mismatch, expired tokens, partial uploads, cancellation before/after first persistence, uncertain commits and explicit retry. |
| Selected PowerPoint publication | Preserve selected changes and original bytes while publishing a private, immutable file/review pair. Discover every candidate before upload, retain cleanup evidence, and reconcile uncertain commits against the exact owned result and lease. | Failure at each upload/metadata/commit boundary, stale token/lease, newer conversion, expiry/deletion, late writes, usage deduplication and matching returned artifact identity. |
| Remaining security findings | Assess actual runtime reachability; apply only supported compatible fixes relevant to production. Keep unresolved runtime and tooling findings explicit. | Current primary advisories, installed package source, server bundle/trace evidence, reviewed lockfile changes, script-disabled clean install, audit/signatures and auth boundary regressions. |
| Release evidence | Define the exact hosted and human validation still needed beyond synthetic CI. | Candidate-commit checklist with prerequisites, fixtures, expected results, evidence capture and stop conditions. Do not reuse historical results as current certification. |

Submission and selected-publication work can proceed independently after their
protocols are reviewed. The shared UI must preserve file/lock state and current
status, distinguish unconfirmed outcomes, and never automatically reissue a
billable conversion. The existing database schema and original-format engines
remain in place. All local fixtures are synthetic.

## Verification plan

Use the installed spec/source/test-driven, debugging, review, simplification and
security guidance. Review relevant implementation and regression fixtures before
changes; prove failures first where feasible, then verify persisted state and
independent preservation evidence rather than only returned success flags.

Run the full application suite, focused in-memory PostgreSQL fault tests,
typecheck, changed-code lint, formatting and the existing production-build,
renderer and signed-out runtime smoke. Continue the full pinned native-PDF
synthetic suite in the existing Linux CI job. No new hosted service or CI job is
planned. Record actual results and platform limits after verification.

Any remaining need for hosted access, real Java tools or human Office/Acrobat/
assistive-technology evaluation is a release stop condition, not a reason to
declare arbitrary documents accessible.

## Implemented boundaries

The [submission protocol](document-submission-recovery.md) establishes identity
before source persistence and preserves it through uncertain upload responses.
It checks signed owner/source/target metadata, serializes first persistence and
cancellation, and gates the initial conversion attempt under the document lock.
An early cancellation reserves a tombstone; it cannot be undone by a late upload.
Only tombstones created before any upload capability existed are marked settled
for unfinished-upload capacity. Existing capabilities retain their cleanup limits.

The [selected PowerPoint protocol](artifact-publication.md) now reserves private
cleanup receipts, commits expected checksums, uploads without overwriting, and
publishes the exact file/review pair atomically. A lost commit acknowledgement
is reconciled against the saved pair and finished lease. Download signing happens
after publication; a signing failure accurately reports that the selection was
saved. The returned artifact identity binds later downloads to that selection.

The [security review](dependency-security-review.md) records the sole dependency
change, application Zod 4.4.3 to compatible 4.6.6, and the authentication parser's
32 KiB / 10-second request boundary. The 19 remaining audit entries include the
separate CLI Zod 3 copy and observed build/test/CLI paths. A flat audit count is
neither proof of a remaining application exploit nor proof of safety; candidate
build evidence and deployed Node/Undici inventory remain required.

The [release checklist](release-validation-checklist.md) specifies synthetic
fixtures, prerequisites, expected results and evidence for the hosted, Java,
Office, Acrobat and assistive-technology checks that local tests cannot supply.
It explicitly separates prior evidence from current NOT RUN/BLOCKED gates.

## Verification evidence

The selected-PowerPoint baseline reproduced three failures before the fix:
nonprivate receipts, a lost final-commit acknowledgement, and premature purge
before an uncertain write settled. The repaired path passes 12 isolated
PostgreSQL cases; the existing publication suite also passes its 22 cases.
Submission tests exercise real schema transactions and synthetic blob outcomes,
not a hosted pooler or storage service. The incomplete-source browser retry also
failed before its guard was fixed: it dropped the preparation token and could
enter the legacy new-document path. The regression now preserves the original
file/token and proves no second preparation is sent.

Final local verification on 2026-10-26:

| Check | Result |
| --- | --- |
| Full application suite | 2,285 passed across 91 files. |
| Isolated PostgreSQL | 64 passed: 22 original publication, 30 submission and 12 selected-PowerPoint cases. |
| Types, formatting and changed-code lint | Passed; no whitespace errors. |
| Production build and traced renderer | Passed; 21 synthetic pages, including 18 high-resolution scans, and 411 Windows runtime assets. |
| Built framework runtime | All 12 checks passed, zero configured-service contacts. Synthetic loopback configuration only. |
| Dependency inventory | Final local build: 139 runtime source files, 18 traces, 177 maps, no scan errors; patched Zod remains the positive server control. See the security review for hashes and limitations. |

The existing Linux CI job now runs all three PostgreSQL suites, the new runtime
checks, the application suite and the full 329-test synthetic native-PDF suite.
Use the draft PR's exact-commit CI result for Linux evidence; a checked-in workflow
or an earlier increment's success is not a current pass.

## Remaining release stops

- Verify hosted Node/Undici and actual deployed bundle inclusion. The remaining
  19 advisory entries are explicitly deferred build/test/CLI findings; they have
  not been erased by the runtime fix. Do not expose affected development servers
  or feed adversarial build input into them.
- Run the candidate-bound hosted concurrency, real Java image, native Office,
  Acrobat and assistive-technology checks in the release checklist. They were
  not executed for this increment.
- Legacy tokenless callers retain their previous recovery limits. Tokens and
  source files remain browser-memory-only; an incomplete source after reload
  requires reselecting the original. Hard process termination/durable job
  execution, comprehensive rate limits and authenticated tombstone-abuse limits
  remain separate work. Successful initial conversion responses still have
  optional artifact binding; selected exports now supply their exact artifact.
- Retired and failed objects remain discoverable until retention cleanup, with
  conservative settlement barriers that do not establish a bound on arbitrary
  provider delays. User access still expires 14 days after original persistence.

The prior Vercel action `GET /v13/deployments/dpl_7YzLKNUTzBj9c4T9vTGVD5ejN2Z2`
was **denied HTTP 403** for scope `gabrielnalain-7544s-projects`. Its underlying
preview failure cause remains unknown. This increment did not retry that action,
use alternate access, or manually deploy/retry a preview. Publishing the draft
can trigger the repository's already configured preview integration; the reviewed
build commands contain no migration or paid-model invocation. No production
readiness or arbitrary-document accessibility certification is claimed.
