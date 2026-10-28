# Native document reliability: bounded first increment

## Objective and authorization

Improve reliable remediation across classes of native PDF, DOCX and PPTX inputs
while preserving source content and original-format output. This increment fixes
verified boundaries in the existing engines; it does not replace them or promise
automatic accessibility certification for arbitrary documents.

The user authorized source review, installation of the named Addy Osmani guidance,
isolated development, synthetic/local fixtures, local tests and a draft PR. That
authorization governs this bounded implementation; generic skill approval gates do
not require repeated permission for those activities. Deployment, migrations,
credentials, production data, private document uploads, paid model calls and new
infrastructure are outside scope.

## Baseline and architecture

Reviewed base: `58adb76a30ffed4263b853eb438a95ba8cc4b7b8` in
`galain01/acccp`. The pre-existing checkout was clean on `main`; development uses
an independent clone and `codex/reliability-boundaries-20261026`. The remote had no
open pull requests at inspection. Existing branches and the separate preview
worktree were left intact.

| Boundary | Current source and contract | Direction |
| --- | --- | --- |
| Submission and job lifecycle | `app/api/convert/route.ts`: synchronous POST, ownership/retention checks, job attempt, engine dispatch, artifact and finding publication | Preserve current persistence contract; contain unexpected engine failures |
| Browser batches | `components/ui/document-workspace.tsx`: awaits each selected document serially | Keep current concurrency until admission, retries and costs have explicit design |
| Results | `lib/db/schema.ts`: unique job per document plus document/target uniqueness; saved target cannot change | Keep schema unchanged; multiple outputs need separate design/migration |
| Word | `lib/word-convert.ts`, `lib/docx-package.ts`: bounded original OOXML patching, reopen/lineage checks, rendering and independent audit | Validate every declared XML part before interpreting package features |
| PowerPoint | `lib/powerpoint-convert.ts`, `lib/pptx-package.ts`: bounded original package changes, rendering, audit, selected revision replay | Characterize and regress existing checks; no engine rewrite |
| PDF | `lib/native-pdf-convert.ts`, `lib/native-pdf-worker.ts`, `services/native-pdf/`: bounded source-bound operations, reopened structure/content/pixel preservation, veraPDF and independent audit | Contain abnormal processor exits without weakening document checks |

## Acceptance criteria and implementation order

1. **Package trust boundary:** DOCX XML parts declared by OPC content type receive
   the same XML parse, complexity and unsafe-field checks irrespective of extension.
   Protected or malformed alternate-extension parts are rejected. Valid parts and
   unrelated bytes survive a supported repair. DOCX and PPTX both account for all
   declared XML in the aggregate byte budget and reject ambiguous media types.
2. **Worker lifecycle:** after an abnormal PDF processor exit, no worker-owned
   process group is intentionally left running. Cleanup stays scoped to the
   process group created for that job; existing timeout/diagnostic behavior holds.
   The same 90-second work budget covers body intake, stored-object fetch and
   processing. Cleanup/response time is separately bounded, not part of an exact
   response-time guarantee. The existing Linux CI job runs supervisor regressions.
3. **Conversion lifecycle:** an unexpected engine rejection after job creation
   follows the same safe failure publication as ordinary conversion errors. The
   response carries document/job/target identities for retry; no exception text or
   arbitrary attached data is exposed or persisted. Expiry/deletion and newer
   attempt checks remain authoritative. No automatic billable retry is added.
4. Every defect has a synthetic failing reproduction before its implementation,
   a passing focused regression afterwards, and an independent diff review.

These three changes are independently testable and share no schema changes. Work
can proceed in parallel after source characterization; integration verifies the
unchanged native format and preservation contracts.

## Commands, style and verification

The lockfile and worker requirements define dependencies. At baseline the app uses
Node 24, Next 16.3.4, React 19.2.4 and Vitest 3.2.7; the worker pins pypdf 6.10.0,
pypdfium2 5.14.0 and Pillow 12.3.0. Dependencies are installed in the isolated clone
with `npm ci --ignore-scripts --no-audit --no-fund`; no project helper runs at install.
Use existing TypeScript formatting and controlled `createJobDiagnostic` values,
for example `createJobDiagnostic({ stage: "conversion", code: "unknown_error" })`.

- `npm test -- test/pdf-route.test.ts test/native-pdf-route.test.ts`
- `npm test -- test/docx-package.test.ts test/pptx-package.test.ts`
- `npm test`
- `npm run typecheck`
- `npm run format:check`
- Worker tests: use the isolated Python environment with
  `python -m unittest discover -s services/native-pdf -p "test_*.py"`.
- Review the build helper before `npm run build`; do not use env files or live
  services to make a local check pass.

Tests use generated fixtures or mocked external model/render boundaries. Local
model mocks establish lifecycle and contract behavior, not semantic model quality.
Where Linux-only process behavior or full renderer/validator dependencies cannot
run locally, record that limitation rather than treating a skip as evidence.

## Evidence sources

- Repository instructions: `AGENTS.md`; native docs and worker protocol.
- Engineering guidance: `addyosmani/agent-skills` at
  `aeac41d4d005999432bb7312f7ff06383a91d59d`, installed with shared references in
  `.agents/`; provenance and hashes accompany the instruction files.
- Next route behavior: version-matched
  `node_modules/next/dist/docs/01-app/01-getting-started/15-route-handlers.md`
  and [official route handler documentation](https://nextjs.org/docs/app/getting-started/route-handlers).

## Remaining system work

This increment does not create durable background jobs, change browser concurrency,
introduce multiple saved results per source, expand accepted document classes, or
establish screen-reader/PDF/UA conformance. Existing unsupported/encrypted/signed or
complex form cases must remain explicit. Semantic ambiguities, incomplete audit
coverage and unresolved machine findings still require visible manual review.

## Implementation evidence (2026-10-26)

| Check | Result |
| --- | --- |
| Full application regression suite | 84 files, 2,172 tests passed |
| Native DOCX/PPTX package and conversion suites | 247 tests passed; 13 new regression cases failed before their fixes |
| Conversion route suites | 95 tests passed; six new failure-lifecycle cases failed before the fix |
| Native PDF worker Python suite | 329 tests run: 328 passed, one Linux-only process integration test skipped on Windows |
| PDF lifecycle reproductions | Nine assertions failed before the fix; expanded boundary and cleanup-order tests pass |
| Typecheck | Passed |
| Repository format check | Passed; two baseline native-PDF evidence files received formatting-only cleanup |
| Changed TypeScript lint and whitespace check | Passed |
| Independent review | No blocking findings; isolated mutations of the route catch and declared-XML check produced six and five intended failures, then the restored selected cases passed 11/11 |
| Production build and traced renderer smoke | Passed using nonsecret build placeholders and unreachable loopback service URLs; 21 synthetic pages, including 18 high-resolution scans, preserved expected text, vector/raster pixels and image alternatives |
| Dependency audit | 21 existing findings: four critical, nine high, eight moderate; see `dependency-security-review.md` for reachability and release blockers |

Tests ran in an isolated clone without source documents, production credentials,
model calls, migrations or deployment. Node dependencies were installed with
lifecycle scripts disabled; Python used a separate task-local environment with
the worker's pinned requirements. Local Python is 3.14; production and the new
Linux supervisor CI step use 3.12. Java-backed end-to-end worker execution,
interactive Office/Acrobat and assistive technology were not exercised.

The review identified an existing non-atomic reconversion publication risk and
hard-interruption recovery gaps; see `reliability-review.md`. The supervisor CI
step addresses Linux process cleanup coverage, but the full native PDF suite is
not yet a CI gate. Dependency findings also prevent treating this branch as a
production-readiness sign-off. This is a reviewable first increment, with no
claim that all arbitrary documents can be automatically certified accessible.
