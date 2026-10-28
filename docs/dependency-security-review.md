# Dependency security review — 2026-10-26

**Release verdict: the reviewed source fixes do not establish production readiness.** Next/Sharp and the application Zod 4 dependency are patched, and authentication POST bodies are now bounded before parsing. The remaining 19 audit entries have observed CLI/build/test paths, not 19 demonstrated application-runtime vulnerabilities. Candidate build evidence, hosted Node inventory and the explicit stop conditions below still apply. No deployment or exploit against ACCCP was performed.

## Recovery follow-up: authentication and remaining dependency exposure

Reviewed on **2026-10-26**, starting at
`e2089405a5a7e5f9bf1b4440f604ce177011be6f`. Updated only the transitive
`node_modules/zod` entry from **4.4.3 to 4.6.6**. Better Auth and its core
package require `^4.3.6`, so the update stays inside their declared range.
`package.json`, all other package entries and all optional-platform packages are
unchanged; no override or new direct dependency was added. The application lock
SHA-256 is `8a03ad26700ba18e5bff23357d346b2431b4204dec61b396bc763ec80db9581b`.

The [Zod 4.6.6 release](https://github.com/colinhacks/zod/releases/tag/v4.6.6)
and [maintainer fix](https://github.com/colinhacks/zod/pull/6652) address
`GHSA-mrhx-c7xc-m3w5` by checking constrained collection sizes before walking
their elements. Unbounded collections still need application limits. Reviewed
the published tarball's manifest, entry points and collection-bound source
before importing it in tests. It has no dependencies or installation lifecycle
hooks; its SHA-512 matches registry integrity
`4UmzQUF5fxvfcYHlbjBmejU+w+hbDnWFx4aS8kBx7nPBHcO2SqPbpAG8snbdg+Xse4pRefR98hgjFgIMCI/UhA==`.
The release notes disclose reverted malicious Git commits that were never
published to npm, and explain the rewritten provenance commit. Signature and
attestation verification passed; this is provenance evidence, not a complete
source-security audit. All installation lifecycle scripts remained disabled.

The existing Next adapter passed the request directly to Better Auth;
`better-call/dist/utils.mjs` reads JSON/forms without a byte limit on that path.
The exposed `/sign-in/social` schema includes an unbounded `scopes` array and
selects its configured provider after parsing. OTP-only configuration does not
remove that parser. The auth POST wrapper now allows **32 KiB of actual bytes**
and **10 seconds** to finish reading before delegation. It checks streamed
bytes even with missing or understated Content-Length, cancels rejected input,
and does not await an indefinitely pending cancellation. Safe 400/408/413
responses contain no transport errors. GET and the auth response, including
cookies, remain delegated unchanged. These are parser resource bounds, not a
complete authentication or distributed-denial-of-service assessment.

Synthetic regressions reproduce the former unbounded delegation and verify
byte/timeout/cancellation limits, UTF-8 accounting, exact-limit input and
response preservation. Tests use the real application Better Auth configuration
with an in-memory UUID-generating adapter and mocked email/network to exercise
OTP, the OSU domain gate, session lookup and sign-out. A separate regression
checks that an oversized constrained Zod collection does not visit its elements.
They do not verify hosted email delivery or a production database connection.

Fresh local evidence is saved outside Git in `task/npm-audit-recovery.json`
(SHA-256 `94b7bba641d3df0cfb40f67c7b4236fa8d4c77e9b76d62b8655708ba47a31595`)
and `task/npm-signatures-recovery.log`: **19 entries, 3 critical / 8 high /
8 moderate; 735 verified registry signatures and 200 verified attestations**.
The audit's Zod finding now names **only**
`node_modules/shadcn/node_modules/zod` (3.25.76), not the application Zod 4 copy.
Thus a flat audit count does not show this application's dependency repair.

### Exposure evidence and bounded deferrals

The final local candidate build `kH2rJ76WzkyCwZ-PXBbMP` was also checked after
the recovery implementation: **139 runtime source files, 18 NFT traces, 177 maps
(171 server / 6 build), 69 indexed sections and 3,440 source entries**. The
report has no read/parse errors or skipped symlinks/external map sections and
retains the positive Zod server control. Only the patched application Zod 4
appears among the audited packages in server maps; source-map-js remains in the
build map only. No other named affected package appears in source imports,
traces or mapped modules. Report SHA-256:
`20cbecd20c3606b02f4bde117a7e8938b73454fa1ad70cdb7dafc6057bdd2a56`;
trace/map inventory SHA-256:
`6683e13157f4ea14c8fb5bb98b373b7e9f521f6141797361b4642b7b8824b721`.
This is a local source/build snapshot; the reporter explicitly does not infer
that its recorded Git HEAD identifies all then-uncommitted build inputs.

The initial exposure review used the prior local build
`xSM7kFaBfngrTenPXLvCo`, not a deployed artifact. It scanned **17 NFT traces**,
**168 source maps** (162 server and 6 build), **69 indexed-map sections** and
**3,327 decoded source entries**. It also searched **134 tracked non-test
runtime source files** for imports/requires. Zod was present in three server
chunk maps, providing a positive control. None of the other 18 advisory package
entries appeared in the server traces or server source-module inventory.
`source-map-js` appeared as 11 modules only in the build chunk map
`node_modules_20v-8wlfss9m1._.js.map` (SHA-256
`7b9c773ef6b899276370a305913a37146bbe30fcbb4f28b8b088de4ba39a6c07`).
Better Auth's compiled plugin inventory contained email OTP, not its
`test-utils` entry that imports Vitest. Framework-name/UA strings mentioning
Express, Hono, jsdom or Vite were not treated as imports.

| Remaining audit entries | Observed owner and disposition |
|---|---|
| shadcn 4.11.0; Zod 3.25.76 | Component-generation CLI; no runtime import/trace found. Keep Zod 3 with its consumer until a separately reviewed CLI update. Do not force Zod 4 into its `^3.24.1` dependency. |
| MCP SDK 1.29.0; proxy-addr 2.0.7; body-parser 2.3.0; fast-uri 3.1.7; hono 4.13.7; ip-address 10.7.0 | shadcn's MCP/Express/Ajv/rate-limiter graph. No app server use found. Do not expose this CLI's server/OAuth features; remediate before using them. Compatible candidate floors include MCP 1.32.0, proxy-addr 2.0.8, body-parser 2.4.0, fast-uri 3.1.9 and hono 4.13.11; ip-address must exceed 10.7.3. Candidates still need package/source review. |
| brace-expansion 1.1.18 / 5.0.9 | ESLint and shadcn/ts-morph glob processing. No uploaded-document input to patterns found. Candidate compatible patches 1.1.21 / 5.0.12 remain separate tooling work. |
| source-map-js 1.2.1 | PostCSS build code constructs SourceMapConsumer; no request-path map consumer found. Candidate 1.2.2 is deferred. Do not feed attacker-supplied indexed source maps to this build tool. |
| npm Undici 7.29.1 | jsdom test dispatcher; no app import/trace found. Candidate 7.30.1 is deferred. Updating it would not patch Node's independently bundled fetch implementation. |
| Vitest 3.2.7; tinypool 1.1.1; @vitest/mocker 3.2.7; Vite 7.3.6 | Test runners/workers. Keep test servers off public networks. Vite 7.3.7 is a compatible candidate; Tinypool 2.1.2 exceeds Vitest 3's `^1.1.1` range and the mocker fix needs a coordinated Vitest upgrade. No arbitrary major override is introduced. |
| drizzle-kit 0.31.10; @esbuild-kit/esm-loader 2.6.5; @esbuild-kit/core-utils 3.3.2; nested esbuild 0.18.20 | Database CLI and isolated schema-fixture tests. No esbuild dev server is started. Its fixed esbuild 0.25 line exceeds the loader's `~0.18.20` range; the audit's proposed Drizzle downgrade is not accepted. |

These are explicit scoped deferrals, reviewed **2026-10-26**, not a blanket
declaration that the packages are safe. Installation/dev/optional flags alone
are not exposure evidence. Source maps and traces can omit dynamically loaded
or unrepresented paths; static client bundles have no source maps. Named-package
matching is not a complete inventory of separately vendored framework copies. Refresh the
report against the final candidate build using
`node scripts/report-dependency-exposure.mjs`, and investigate any new server
inclusion before release. The earlier baseline tables below retain their
historical installed versions; this section supersedes their current Zod and
exposure conclusions.

**Release stop conditions:**

- Confirm the final candidate build and actual deployed artifact/runtime match
  reviewed versions and exposures. A local trace is not deployment proof.
- Inventory hosted Node and vendor backports. Local **Node 24.14.1 / bundled
  Undici 7.24.4** is within the advisory range, independently of the npm copy.
  Application global `fetch` calls make this an unresolved runtime question.
- Stop and reassess any newly reachable affected package, public development
  server, adversarial build input or failed auth/native regression. Tooling
  upgrades remain due before exposing the affected tooling features.
- This review does not cover Python/container/native-library advisories,
  hosted configuration, real Office/Acrobat behavior or accessibility
  conformance. Keep those separate release gates and the existing production
  authorization limits.

## Follow-up: targeted framework update

On 2026-10-26, updated `next` and `eslint-config-next` from 16.3.4 to
**16.4.3**, preserving major 16. The [maintainer security notice](https://nextjs.org/blog/nextjs-security-update-october-14-2026)
sets 16.4.1 as the patched floor for the Server Actions denial-of-service
(`GHSA-p3m5-59mp-jv5r`), typed-array cache RCE (`GHSA-673q-mjm6-r5xr`) and
SVG optimization RCE (`GHSA-2464-fhr4-w9xw`) advisories. The current
[16.4.3 patch release](https://github.com/vercel/next.js/releases/tag/v16.4.3)
includes subsequent correctness fixes without a declared configuration migration.
Node 24 and React/DOM 19.2.4 remain within the published peer/runtime ranges.

The application lockfile changes **39 package entries**, all within the Next family (12)
and Sharp/native-image family (27). Sharp advances to **0.35.5** and its
libvips packages to **1.3.4**. No package names were added or removed, no
unrelated versions changed, and none of the updated entries declares an
installation lifecycle script. React, Better Auth, database and document-engine
package versions are unchanged. Reviewed lock SHA-256:
`58336a9ea995da17543e44f34e6807875226661bd916b47b6cf72a9729282ca2`.

Resolved the update with npm **11.11.0** in a clean task-local directory with
scripts disabled, then verified `npm ci --ignore-scripts` both there and in the
isolated checkout. `.npmrc` preserves this dependency-script policy by default;
explicit reviewed `npm run` commands still execute. CI uses the frozen lockfile
with scripts disabled. `npm audit signatures` verified **735 registry signatures
and 200 attestations** in the installed platform graph; this is not an assertion
that every optional binary on every platform was installed or executed.

The fresh audit has no Next or Sharp entry and reports **19 affected package
entries: 3 critical, 8 high, 8 moderate**. Audit snapshot SHA-256:
`339da8a23c38482c78287c1909cc2048c3cf1124f7e65c34d5f47448019c7ac9`.
Remaining entries and reachability caveats below still apply, including
Zod/Better Auth, development tooling, and the deployed Node/Undici inventory.
Those deferrals remain due before release. The tables below preserve the
original baseline review; their Next/Sharp installed-version rows are superseded
by this section. Regression/build evidence is recorded in
[the follow-up report](reliability-follow-up.md).

## Evidence and scope

- Reviewed repository base: `58adb76a30ffed4263b853eb438a95ba8cc4b7b8`.
- Reviewed `package-lock.json` SHA-256: `f28e3349f6966c74e10bca80fa461fc1c1da0a67589bff55fe7d7900b65db043`.
- The 2026-10-26 `npm audit --json` snapshot reports **21 affected package entries: 4 critical, 9 high, 8 moderate**. These are not 21 independent exploits; some entries inherit another package's advisory. Snapshot SHA-256: `346c0f2a45e120a4dd357c43f82ca61f853284499bec7abe5237769d69c4ac8d`.
- Used `npm explain ... --json`, locked versions, installed package source, application import searches, `next.config.ts`, `vitest.config.ts`, and current maintainer/advisory pages. Original audit/explain snapshots remain local task evidence outside Git. No dependency changes, remediation commands, services, exploits, production requests, or paid model calls were run for this review.
- `shadcn` is declared in production dependencies despite its observed CLI role. Better Auth lists Vitest/Drizzle Kit as optional peers, making several test packages `devOptional`. Installation flags alone therefore do not establish runtime reachability or exclusion from a deployed artifact. Production bundle contents were not inspected here.

## Critical and high entries

The fixed versions below address the cited snapshot, not a guarantee against future advisories. **Every deferral below was reviewed on 2026-10-26 and requires re-review before the next production release.** Deferred means separated from this bounded document-engine change, not accepted as safe indefinitely.

| Installed package / severity | Observed path and reachability | Fix / reason for separate work |
|---|---|---|
| **next 16.3.4 — critical aggregate** | Direct production framework. ACCCP uses App Router and seven `"use server"` action modules, including `lib/actions/documents.ts`. This matches the documented prerequisites for [Server Actions DoS](https://github.com/vercel/next.js/security/advisories/GHSA-p3m5-59mp-jv5r); authorization inside an action is not evidence against a framework parser problem. | Upgrade to a supported **16.4.1 or later** release, review its changes, and verify build, auth/actions, native renderer tracing and document flows. The maintainer gives no workaround for this DoS. **Release blocker**, separated to keep framework compatibility validation reviewable. |
| **sharp 0.35.4 — high** | `next -> sharp` optional native dependency. Both `next/image` usages in `components/ui/powerpoint-change-review.tsx` set `unoptimized`; `next.config.ts` has no custom remote-image/SVG policy. This does not prove that a deployed `/_next/image` route cannot be invoked. No attacker-controlled SVG-to-Sharp path was demonstrated. | At least **0.35.5**, coordinated with Next. [Next maintainer advisory](https://github.com/vercel/next.js/security/advisories/GHSA-2464-fhr4-w9xw) describes possible RCE on glibc Linux and the Sharp fix; [Sharp advisory](https://github.com/advisories/GHSA-wq5f-xc86-pv6w). Confirm deployed OS and image route behavior; native-binary upgrade needs platform/build verification. |
| **zod 4.4.3 and 3.25.76 — high** | `better-auth 1.6.23 -> zod 4.4.3` is an application path; `shadcn -> zod 3.25.76` is CLI use. `app/api/auth/[...all]/route.ts` exposes the Better Auth handler. Installed `better-auth/dist/api/routes/sign-in.mjs` defines an unconstrained `scopes: z.array(z.string())` body field for `/sign-in/social`; provider selection happens in its handler. ACCCP configures OTP, but that alone does not establish that this core schema is unreachable. Body-size limits and actual parsing/route exposure remain unverified; no memory-exhaustion test was run. | **4.6.6** is the advisory's fixed version. Update compatible auth transitives and the CLI owner rather than force Zod 4 into a Zod 3 consumer. [Advisory](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5), [upstream fix](https://github.com/colinhacks/zod/pull/6652). Prioritize after Next; complete auth boundary tests before release. |
| **proxy-addr 2.0.7 — critical** | `shadcn -> @modelcontextprotocol/sdk -> express -> proxy-addr`. No Express/MCP application import was found. The [advisory](https://github.com/jshttp/proxy-addr/security/advisories/GHSA-jqcg-44mw-7w3h) additionally requires particular IPv6 trust-subnet configuration; none was demonstrated in ACCCP. | **2.0.8**. Update CLI transitives and verify exclusion from production artifacts. Deferred because the observed path is development CLI use, not a proven request path. |
| **@modelcontextprotocol/sdk 1.29.0 — high** | Only observed owner is `shadcn 4.11.0`. [OAuth trust](https://github.com/advisories/GHSA-6qxp-vccf-f47h), [task isolation](https://github.com/advisories/GHSA-22jm-h49p-29qw), and [validation memory](https://github.com/advisories/GHSA-46jr-4wx8-v453) issues need MCP client/server features not found in application imports. | **1.32.0** clears the snapshot's ranges, including its two moderate SDK advisories. Review/update the CLI dependency graph; do not expose its MCP server meanwhile. No application exploit asserted. |
| **body-parser 2.3.0 — high** | Same `shadcn -> MCP SDK -> express` chain. [Compressed-body DoS](https://github.com/advisories/GHSA-27r3-jxmh-p828) requires a server using the affected parser. ACCCP API handlers are Next routes; no direct Express server was found. | **2.4.0**. Resolve with the CLI graph; verify build/runtime exclusion rather than treating its production install flag as proof of exposure. |
| **shadcn 4.11.0 — high inherited** | Production-listed component-generation CLI; no import found in application source. Its severity here is inherited from Zod, not a separate demonstrated app flaw. | Audit reports an available update without naming its version. Select a maintained CLI release with a clean resolved graph and consider moving it to dev dependencies in that separate change; verify generated-component compatibility. |
| **tinypool 1.1.1 — critical; vitest 3.2.7 — critical inherited** | `vitest -> tinypool`, invoked by `npm test` / `test:watch`. Better Auth's Vitest import was found in its `dist/test-utils/test-instance.mjs`; no non-test application import of that entry was found. [Worker options](https://github.com/advisories/GHSA-5gmw-xhrv-c9v3) and [run options](https://github.com/advisories/GHSA-85c8-ppgw-ccpr) gadgets require additional prototype pollution/controlled options, which was not demonstrated. | Tinypool **2.1.2** addresses both. Audit proposes **Vitest 5.0.5**, a major upgrade, while Better Auth's optional peer currently accepts Vitest 2–4. Select a compatible supported testing graph and verify the full suite. Keep test APIs off public networks. This is a tooling blocker, not proven upload-triggered RCE. |
| **vite 7.3.6 — high** | `vitest -> vite` / `vite-node` / `@vitest/mocker`. Default test environment is Node; no Vitest browser/API server is configured. The [Windows editor-command advisory](https://github.com/vitejs/launch-editor/security/advisories/GHSA-587h-7wmj-h5pm) requires a reachable editor-opening path; none was exercised. | **7.3.7** is patched for the cited issue and outside all Vite ranges in the snapshot. Resolve with the test tooling upgrade; do not expose a dev/test server. |
| **brace-expansion 1.1.18 and 5.0.9 — high** | 1.x: ESLint/minimatch. 5.x: TypeScript-ESLint and `shadcn -> ts-morph -> @ts-morph/common -> minimatch`. [Recursive groups](https://github.com/advisories/GHSA-qhr7-859c-m2p7), [comma recursion](https://github.com/advisories/GHSA-6j4f-fj2g-mc7p), [quadratic expansion](https://github.com/advisories/GHSA-q2hr-2g5m-vwhr). No uploaded-document input into glob patterns found. | **1.1.21 / 5.0.12** clear all snapshot ranges. Update compatible transitives with lint/CLI checks; current classification is build/CLI use. |
| **source-map-js 1.2.1 — high** | Next/PostCSS, Tailwind, shadcn, and jsdom CSS parsing. [Indexed source-map DoS](https://github.com/advisories/GHSA-68fv-2mgg-jv7q) needs adversarial indexed maps. No route accepting uploaded source maps found; package presence through Next is not proof of a request path. | **1.2.2**. Compatible transitive update plus build/source-map checks. Production map-processing reachability remains unverified. |
| **undici 7.29.1 — high** | npm package is reached through `jsdom 29.0.0` test tooling. [Content-encoding DoS](https://github.com/nodejs/undici/security/advisories/GHSA-xjj6-f33q-929c), [EventSource memory](https://github.com/advisories/GHSA-4qv8-2p9j-2685), [integrity parsing](https://github.com/advisories/GHSA-f72v-6w45-q472). No direct application import of npm Undici found. | **7.30.1**, with jsdom tests. Separately inspect the deployed Node runtime: Node's built-in `fetch` uses its bundled Undici and is not fixed by updating this npm package. |

Next's other snapshot advisories concern [`next/og`](https://github.com/advisories/GHSA-vcvr-r3jv-pc5j), [Draft Mode cache fills](https://github.com/advisories/GHSA-3w37-wq28-93x7), [self-hosted SSG/ISR](https://github.com/advisories/GHSA-4jqv-mc3x-m676), [development MCP](https://github.com/advisories/GHSA-39w2-rjm5-chcv), [metadata image routes](https://github.com/advisories/GHSA-f87g-xv8r-7p7x), [SSG/ISR cache poisoning](https://github.com/advisories/GHSA-mcj8-r9mp-w47p), [image SSRF](https://github.com/advisories/GHSA-cjq9-62q9-8jv4), [root-param caching](https://github.com/advisories/GHSA-h694-7cp9-m8p3), and [typed-array `use cache` RCE](https://github.com/vercel/next.js/security/advisories/GHSA-673q-mjm6-r5xr). Source searches found no `next/og`, `ImageResponse`, `use cache`, `draftMode`, `generateStaticParams`, or `dynamicParams` use. This limits demonstrated paths; it does not excuse delaying the framework fix.

**Zod source discrepancy:** the advisory summary describes unbounded array parsing, while the [maintainer's patch](https://github.com/colinhacks/zod/pull/6652) explicitly makes existing size bounds run before element parsing and leaves unbounded containers unchanged. Consequently, upgrading to 4.6.6 alone does not demonstrate that the observed unbounded auth schema is resource-safe. Verify request-size enforcement and bounded schema behavior without exercising production or triggering email delivery.

## Moderate entries and remaining checks

| Installed entries | Classification and follow-up |
|---|---|
| **drizzle-kit 0.31.10**, **@esbuild-kit/esm-loader 2.6.5**, **@esbuild-kit/core-utils 3.3.2**, nested **esbuild 0.18.20** | Four inherited/underlying entries for the [esbuild development-server issue](https://github.com/advisories/GHSA-67mh-4wv8-2f99). Database CLI/tooling path; no development server was started. Audit proposes Drizzle Kit **0.18.1**, a backwards version change, not a safe automatic repair. Defer for a supported migration-tool upgrade and isolated compatibility checks. |
| **@vitest/mocker 3.2.7** | Test tooling: [file read](https://github.com/advisories/GHSA-82fw-gwwq-j7x9), [manual mock injection](https://github.com/advisories/GHSA-qxg6-89mg-rqv8). Fixed ranges require **4.1.12 or later**; resolve with Vitest rather than mismatching its internal packages. |
| **fast-uri 3.1.7**, **hono 4.13.7**, **ip-address 10.7.0** | Via MCP SDK's Ajv, Hono server, and Express rate limiter respectively, all under shadcn. [URI normalization](https://github.com/advisories/GHSA-w74x-v6f9-j3xg): **3.1.9**; [static-path decoding](https://github.com/advisories/GHSA-5r4p-p66f-jhc7): **4.13.11**; [IPv6 parsing](https://github.com/advisories/GHSA-rxp7-6hxx-x8q5): version **greater than 10.7.3** is outside all snapshot ranges, confirm maintained patched release. No use of these affected functions on the app request path demonstrated. Resolve with CLI graph. |

The local test runtime reports **Node 24.14.1 / bundled Undici 7.24.4**, within the published affected Undici range. This is not evidence of the deployed version or an executed exploit. Application calls using global `fetch` make deployed runtime inventory and vendor backport status necessary before release; package-lock auditing does not cover that runtime component.

All moderate entries remain deferred for separate dependency work, with review date **2026-10-26** and re-review due before release. Complete the Next/Sharp and authentication dependency work first, then CLI/test tooling. Use narrow upgrades, inspect changelogs and install scripts, regenerate the lockfile with the repository's package manager, and run focused regressions plus the full verification suite. Re-run the audit on that final lockfile and inspect deployed bundle/runtime inclusion. Do not use `npm audit fix --force`, accept the Drizzle downgrade blindly, or claim this Node audit covers the Python worker/container dependencies, native libraries, production configuration, or document accessibility conformance.
