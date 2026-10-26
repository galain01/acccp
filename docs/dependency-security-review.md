# Dependency security review — 2026-10-26

**Release verdict: do not claim production readiness from this reliability patch.** The follow-up below fixes the confirmed Next.js/Sharp dependency blocker in source. Other application dependencies and development tools still require upgrades or verified exclusions, and no deployment was performed. This review makes no claim that an exploit succeeded against ACCCP.

## Follow-up: targeted framework update

On 2026-10-26, updated `next` and `eslint-config-next` from 16.3.4 to
**16.4.3**, preserving major 16. The [maintainer security notice](https://nextjs.org/blog/nextjs-security-update-october-14-2026)
sets 16.4.1 as the patched floor for the Server Actions denial-of-service
(`GHSA-p3m5-59mp-jv5r`), typed-array cache RCE (`GHSA-673q-mjm6-r5xr`) and
SVG optimization RCE (`GHSA-2464-fhr4-w9xw`) advisories. The current
[16.4.3 patch release](https://github.com/vercel/next.js/releases/tag/v16.4.3)
includes subsequent correctness fixes without a declared configuration migration.
Node 24 and React/DOM 19.2.4 remain within the published peer/runtime ranges.

The lockfile changes **39 package entries**, all within the Next family (12)
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
