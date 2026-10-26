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

Artifact-publication and final Linux CI results will be recorded after their
independent verification.
