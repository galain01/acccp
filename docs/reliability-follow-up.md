# Reliability follow-up: dependency and artifact boundaries

## Scope and acceptance criteria

This increment starts at `8fd29ecc592b27228dd9ad8dd58988b80efba720`
(draft PR #34). The existing native format engines and original sources remain
authoritative. Work is confined to code, synthetic tests and the existing CI
jobs; no production migration, deployment, credentials or paid model calls.

| Capability | Acceptance criteria | Verification |
| --- | --- | --- |
| Supported framework | Upgrade Next.js and its matching lint configuration within major 16 to a maintained release outside the confirmed advisory range. Review the precise lockfile delta and lifecycle scripts; retain React and unrelated major versions. | Current maintainer advisories, lockfile audit, clean install with scripts disabled, full application suite, typecheck, formatting and production build with synthetic renderer smoke. |
| Immutable publication | A failed or superseded attempt cannot overwrite the bytes described by an available output/review pair. Reserve discoverable attempt-specific objects before upload; publish the pair and findings together under the existing ownership, retention and attempt guard. | Reproduce partial output/review upload and database failures, uncertain completion, retries, overlap, expiry and legacy result retrieval with synthetic bytes and independent persisted-state assertions. |
| Native engine CI | Exercise the full safe synthetic Python suite on Linux using the existing pinned worker requirements and existing CI job. | Review test dependencies/side effects, run local Python suite, verify actual Linux run; retain real descendant cleanup test. |

Build order: framework update first; artifact publication and native CI can be
developed independently, then reviewed and verified together. No new schema is
planned. Durable recovery after a lost initial response or hard termination
remains separate unless the publication boundary can resolve a bounded case
without silently repeating model work.

## Engineering and verification

Use the installed source-driven, test-driven, security, debugging, simplification
and code-review guidance. Follow the repository's TypeScript/Prettier style and
existing retention transaction helpers. Keep deterministic helpers in `lib/`,
request handling in `app/api/`, and regressions in `test/`; Python tests stay in
`services/native-pdf/`.

Commands: `npm ci --ignore-scripts`, `npm run typecheck`, `npm run format:check`,
`npm test`, and `npm run build`. The build uses nonsecret loopback placeholders,
never production service credentials. The renderer smoke is part of the build
and operates only on synthetic PDFs. Python verification uses
`python -m unittest discover -s services/native-pdf -p "test_*.py"` with the
reviewed pinned requirements installed in an isolated environment.

Dependency/advisory audit results do not establish accessibility conformance or
deployed-runtime safety. Real Office/Acrobat/assistive-technology checks and the
Java-tool end-to-end worker remain separate evidence. The automatic Vercel
preview is already failed and its diagnostics were denied with HTTP 403 for the
connected account's team scope; no retry or access bypass is authorized.

## Results

### Dependency-only verification

Next and its lint configuration now resolve to 16.4.3, with Sharp 0.35.5 and
libvips 1.3.4. The independent lockfile review found only 39 changed entries
within those families, with platform optional packages retained. See
[the dependency review](dependency-security-review.md) for advisory sources,
exact audit hashes, remaining findings and registry-signature evidence.

A separate clean snapshot of the preceding commit with only the updated
dependencies passed **2,172 tests across 84 files**, type checking and repository
formatting. `npm run build` passed with the traced PDF renderer smoke: **21
synthetic pages including 18 high-resolution scans, 411 traced runtime assets**.
No dependency lifecycle scripts were executed.

`node scripts/check-framework-runtime.mjs` starts the production Next build on
loopback using an allowlist of synthetic environment values and refuses local
`.env` files. It passed **nine checks**: login HTML, signed-out dashboard/admin
redirects, the auth session endpoint, four protected APIs and the compiled
read-only `listSessions` Server Action. A loopback service trap recorded **zero
configured-service connections**. Startup, response size, requests and shutdown
are bounded. These checks verify signed-out framework integration, not an
authenticated production session, email delivery or a real conversion.

The existing Windows command sandbox denied Next's native compiler filesystem
access in the first runtime attempt; the authorized local execution outside that
sandbox passed without weakening any test guards. Build/test output is retained
as local task evidence; no production environment values were used.

### Artifact publication and automated coverage

Generated outputs, their private reviews and Word-to-Canvas rendered PDFs now
use unique object keys, committed cleanup receipts and overwrite-disabled
uploads. Database publication changes the available pointers, findings and
completion state together. A lost commit acknowledgement is reconciled against
the exact artifact set before reporting success or failure. The original source
and original expiry remain unchanged. Canvas now shares the native engines'
overlap guard, and deterministic usage receipts prevent double recording after
an uncertain save. See [the publication protocol](artifact-publication.md).

The isolated PostgreSQL suite passes **22 tests** using real transactions and a
synthetic blob store. Independent mutation checks demonstrated failures when
immutable keys, commit reconciliation or the completed-attempt failure guard
were removed. The two-package test runtime has its own pinned lockfile,
**zero known audit findings**, and **two verified registry signatures and
attestations**. It is separate from the application dependency graph.

The existing Linux CI jobs now enforce frozen installs with scripts disabled,
the full Python engine suite, publication transactions, the production build,
synthetic PDF renderer tracing and signed-out runtime checks. No job or hosted
service was added. Local Python verification ran **329 tests: 328 passed and
one Linux-only process test skipped**; the final Linux run must establish that
test on its actual platform. Java validator execution and model calls remain
mocked in the synthetic engine suite.

### Saved-result recovery

Failed retries retain access to the saved output while displaying the latest
failure. The browser performs one bounded read-only reconciliation when it knows
the saved document ID; if the response was lost after a successful commit, it
recovers the committed result without repeating conversion or model work. If
that read fails, cached findings and interaction-test evidence are cleared and
the availability hint is explicitly uncertain.

Listing reads status, available artifact identity and findings in a read-only
repeatable-read transaction. Listed/reconciled downloads and HTML reads are
bound to that artifact ID in addition to ownership, target and retention. A
changed pointer refuses the download with refresh guidance instead of pairing
different bytes with the displayed findings. The focused UI/read suites pass
**121 tests**, including 23 added regressions. Both initial availability failures
and stale-artifact binding failures were demonstrated before their fixes.

An initial PDF/DOCX response lost before the browser learns its document ID is
still outside this recovery path. Initial successful conversion responses also
retain their existing optional artifact-ID contract. Selected PowerPoint exports
return their own exact download URL; the general download may require a reload
after such an export because the listed artifact binding deliberately stays
strict. Editing a previous PowerPoint review after a failed retry remains
disabled. None of these paths automatically reissues paid model work.

### Final local validation

The combined patch passes **2,202 application tests across 84 files**, plus
the **22 PostgreSQL publication tests**. Type checking, repository formatting,
changed-code ESLint and diff whitespace checks pass. The final production build
again passed the 21-page/411-asset renderer smoke, followed by all nine runtime
authorization checks with zero configured-service contacts. A targeted added-line
scan found no credential/private-key patterns; this is not a comprehensive
secret audit.

Independent reviews covered the dependency delta, publication failure ordering,
saved-result snapshot/binding, and CI/runtime isolation; no blocking finding
remained. Tests exposed and corrected the prior-output overwrite, Canvas overlap,
same-attempt failure downgrade, missing retry IDs after accounting failure,
stale browser review evidence, stale artifact reads and coerced artifact IDs.

Read the associated draft PR's actual Linux CI checks for remote execution
evidence; workflow configuration alone is not proof. The existing automatic
Vercel preview may run when the branch is published. Its earlier diagnostic
request was denied with HTTP 403, and no endpoint retry or access bypass was
performed. No production merge, deployment, migration or new spending commitment
is part of this increment. The remaining dependency findings, full Java-tool
worker checks, hosted concurrency, initial-submission recovery and real
assistive-technology validation still prevent a broad production-readiness claim.
