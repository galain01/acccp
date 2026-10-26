# Release validation checklist

Baseline: `e2089405a5a7e5f9bf1b4440f604ce177011be6f`. This is an executable
review plan, not a record that the remaining checks passed. Bind every run to
the exact candidate commit and delivered file hashes. Do not reuse an older
Office, W-9, Java-image, or hosted result as evidence for this candidate.

Current PDF evaluation evidence is in [the ten-document corpus review](native-pdf-corpus-validation.md).
Subsequent user authorization covered the task-local Java/tagger/validator setup
and bounded use of the existing model integration with public/synthetic inputs.
That setup completed, but the actual completion endpoint returned401; further
inference stopped. This checklist itself grants no access or spending authority.

Use the [fixture matrix](reliability-review.md#representative-fixture-matrix)
for coverage, the current [publication contract](artifact-publication.md) for
storage behavior, and the [worker protocol](../services/native-pdf/protocol.md)
for PDF limits. Some historical format documents describe older upload limits
and canonical output paths; current `lib/output-formats.ts`,
`lib/document-input.ts`, `lib/document-upload.ts` and the publication contract take
precedence. Never silently substitute HTML for native DOCX, PPTX, or PDF output.

## 1. Record the release and establish prerequisites

- [ ] Record candidate commit, clean checkout status, lockfile hashes, CI run
  links, operator, UTC date, OS build and browser version. Record the exact
  versions of every tool actually used; an installed tool is not a passed test.
- [ ] Keep a manifest outside Git: case ID, public/synthetic source provenance and filename/SHA-256,
  expected source wording/data and permitted changes, output SHA-256, job/attempt
  and artifact IDs where applicable, tool versions, PASS/FAIL/BLOCKED/NOT RUN,
  observations, evidence paths and unresolved issue. Write the expected-content
  oracle before examining the repair plan. Hash downloaded bytes again before
  each independent check; do not overwrite the immutable source.
- [ ] For hosted checks, obtain explicit authorization for an existing isolated
  nonproduction app, database/pooler and private bucket, two approved test-user
  accounts and an authorized observer. Confirm target identity and isolation
  before any write. No production data, new infrastructure, credential changes,
  private uploads, or paid model calls are authorized by this checklist.
  Use synthetic engine results at the publication boundary; actual model runs
  need separate authorization. If a reviewed test harness is unavailable,
  record BLOCKED rather than adding a production bypass.
- [ ] For human checks, use available licensed Word and PowerPoint desktop,
  Acrobat Reader for forms, Acrobat Pro or an equivalent reviewed tag inspector
  for detailed PDF checks, and the audience's screen reader. Record full Office,
  Acrobat, screen-reader and OS builds plus relevant settings. Windows/NVDA
  results cover only that combination; add other supported environments
  separately. Missing tools/accounts are blockers, not presumed passes.
- [ ] Stop at access denial; do not use another endpoint/account/key to bypass
  it. Supported Vercel team consent subsequently restored read-only diagnostics:
  the preview failure is missing build-time `DATABASE_URL`. The current model
  completion401 is a separate unresolved gateway-access blocker. Obtain resolved
  access and applicable authorization before retrying a denied operation. A
  GitHub CI pass is not a hosted preview or authenticated application pass.

## 2. Attach automated evidence already covered by CI

The preceding increment's reported baseline is **329 Python tests, 2,202 app
tests, 22 isolated PostgreSQL tests, the production build/renderer smoke and
nine signed-out runtime checks**. For this release, attach actual successful
Linux runs for the candidate SHA; counts can change. A workflow definition,
Windows skip, or prior commit's green run is insufficient.

| Gate | Exact source/command | Required evidence and limit |
| --- | --- | --- |
| Frozen dependencies and app checks | [CI workflow](../.github/workflows/test.yml): `npm ci --ignore-scripts`, `npm run format:check`, `npm run typecheck`, `npm test` | Successful run and exact lockfile; current dependency review with unresolved findings explicitly adjudicated. No lifecycle scripts. |
| Full synthetic PDF engine | Python 3.12; wheel-only install of [pinned requirements](../services/native-pdf/requirements.txt), then `python -m unittest discover -s services/native-pdf -p "test_*.py"` | Linux run includes the real descendant-process test without skipping. Real local PDFium/structure preservation is covered; Java execution and model calls are not. |
| Installed native tools and Linux worker | The `native-pdf-tools` CI job builds `Dockerfile.native-pdf.vercel`, which executes `build-smoke.py --require-linux` as the unprivileged worker user. | Actual pinned OpenDataLoader/veraPDF tools, authenticated loopback requests, saved-file preservation and strict validator completion. Build only; no image publication, deployment, model calls or application credentials. |
| Recovery and publication transactions | The existing CI job runs `node node_modules/vitest/vitest.mjs run --config` separately for `test/conversion-publication-postgres.config.mjs`, `test/document-submission-postgres.config.mjs` and `test/powerpoint-review-publication-postgres.config.mjs`, after the separately locked test-runtime install, with `PGLITE_RUNTIME_DIR` set to its absolute directory. | Actual PGlite transactions with synthetic blob storage. This does not prove hosted multi-client locks, pooler behavior or network write outcomes. |
| Build and framework runtime | `npm run build`; `node scripts/check-framework-runtime.mjs` with the workflow's synthetic environment | Traced renderer smoke (baseline 21 pages/411 assets), all 12 candidate runtime checks and zero configured-service contacts. These are not authenticated conversion or real Java-worker tests. |

Do not rerun environment-loading conversion CLIs merely to make a gate green;
they can invoke real renderers or billable models. Follow the reviewed workflow
environment and [dependency review](dependency-security-review.md).

## 3. Prepare representative synthetic source/output pairs

Each human/hosted case needs an output produced by the candidate engine and its
saved review, not a hand-edited substitute. Generate with reviewed deterministic
plans/fixtures where possible; if a required real workflow needs unavailable
tools, access or model authorization, leave that case BLOCKED. Include an
already-correct input and a failed/partial-repair outcome for each format.
Exercise the current size/page/slide limits and mismatched or corrupt packages.
Legacy `.doc`/`.ppt` and other unsupported sources must receive a clear supported-
format instruction, not conversion success. Verify explicit DOCX/PDF-to-Canvas
selection separately from the default original-format choice.

| Case | Fixture and independent oracle | Expected scope |
| --- | --- | --- |
| D1: editable Word | Two-page DOCX with headings, a language change, split-run typed list, ordinary table and clear two-row grouped header, authored image description, functional image, link, header/footer. Fix the source sentences, list numbering and every table value in the manifest. Anchor: `test/docx-package.test.ts`, `test/word-convert.test.ts`, `test/word-layout-verification.test.ts`. | Supported semantic/list/header changes only; unmodified parts, source text/data, pagination and unrelated layout preserved. |
| D2: Word review/refusal | Ambiguous merged table, singleton/dosage-like prose, tracked changes/text boxes/embedded content; separate damaged/protected/signed/macro/external-content package negatives. Use the existing package tests to distinguish preserved-with-review from rejected inputs. | No guessed labels, accidental list conversion, unsafe content removal or false successful repair. |
| P1: editable/reversible PowerPoint | Nine-slide deck crossing the eight-slide model boundary: real titles, notes, table, native chart, authored/functional images and links, hidden slide, grouped/overlapping objects, one genuinely empty placeholder, local synthetic media, and an appended-description candidate. Record slide/object IDs, facts and data. Anchors: `test/pptx-package.test.ts`, description-slide, empty-placeholder and revision suites. | Original objects remain editable; only proved empty placeholder removal; appended slides and chosen changes are accurately reflected. The automated matrix also covers 1/8/59 slides. |
| P2: PowerPoint review/refusal | Animated/grouped geometry, unsupported complex table, missing media evidence; separate protected/signed/macro/ActiveX/corrupt package negatives. | Protected content stays intact with precise review guidance, or input is rejected as specified; static previews do not establish playback behavior. |
| F1: real Java path | `synthetic_pdf()`, `synthetic_heading_pdf()` and `synthetic_hybrid_pdf()` in [build-smoke.py](../services/native-pdf/build-smoke.py): untagged page, tagged heading split and fixed-layout hybrid form. | Actual tagging, bounded native repair, saved-file checks and veraPDF; source unchanged. |
| F2: native PDF semantics | Synthetic table/chart/list/note/link/cross-page fixtures from `services/native-pdf/test_bounded_*.py`, `test_native_structure_pipeline.py` and `test_worker.py`; include authored ActualText/alternatives and a valid local opening view. | Source-derived structure, exact content/actions and retained native nodes; exact pixels or the protocol's fully recorded multiscale exception. |
| F3: uncertain or unsupported PDF | Image-only photograph versus text scan; unembedded-font case and ambiguous structure; separate encrypted/signed/dynamic-XFA/unknown-script/external-action/embedded-file and over-limit negatives. | No generic OCR/font repair claim. Accepted partial outputs retain specific findings; unsupported/unsafe inputs fail closed with original retained. |

Export the fixture helpers only after reviewing their source and imports. Do not
run research scripts against arbitrary documents or expand their fixture-specific
repair exceptions into app support.

## 4. Execute the remaining release gates

### J — Full installed Java/PDF image (NOT RUN for this checklist)

Prerequisites: reviewed candidate [Dockerfile](../Dockerfile.native-pdf.vercel),
[installer](../services/native-pdf/install-tools.py) and smoke helper; an approved
local Linux container runtime and approval for their dependency downloads. No
host deployment or app credentials are needed. Current source specifies Python
3.12.12, Java 17, OpenDataLoader 2.5.14 and veraPDF 1.30.3; retain the installer's
checksum verification and record the actual image digest/tool versions.

- [ ] From the clean candidate checkout, after the prerequisites are met:
  `docker build --progress=plain -f Dockerfile.native-pdf.vercel -t acccp-native-pdf:release-check .`
  Capture the full build result and exact image digest. This command is planned,
  not executed by creating this document; it runs the reviewed installation and
  unprivileged synthetic smoke during the build.
- [ ] PASS only when the actual build smoke completes authenticated HTTP,
  untagged tagging, heading repair, hybrid preparation/repair, independent saved
  structure/content/pixel checks and veraPDF completion. Retain toolchain hashes
  and machine-check output. Missing tools, wrong profile, incomplete validation,
  timeout or preservation failure is FAIL/BLOCKED, never a waived warning.
  A missing PDF/UA declaration or other retained finding must remain visible;
  do not insert a declaration to obtain a green validator result.

### H — Hosted publication, ownership and recovery (NOT RUN)

Prerequisites: the authorized isolated target from section 1; two independent
browser sessions and database clients through the actual configured pooler;
reviewed fault injection around storage/transaction acknowledgements. Do not
interrupt shared services. Use small synthetic payloads for every destination,
including the Word-rendered-PDF/Canvas pair, with predetermined hashes.

| Execute | PASS criteria | Capture |
| --- | --- | --- |
| Publish a baseline; then overlap two starts/retries for the same source from separate clients. Repeat with different owned documents. | One authoritative active attempt per source; no duplicate engine work for a rejected overlap; stale completion/failure cannot replace or downgrade a newer result. Independent documents behave within documented capacity. | Sanitized request timing/status, attempt/event counts and committed artifact sets from separate readers. |
| Fail each output/review upload, then the metadata transaction. Repeat with an upload accepted but its acknowledgement lost, and with commit success but acknowledgement lost. | Prior available bytes/review/findings remain paired and downloadable until a complete replacement commits. Exact committed set reconciles as success; unknown state stays uncertain. No eager deletion of possibly committed blobs or repeated model work. | Before/after object hashes and availability, reservation receipts, exact committed pair, findings and usage counts. |
| Lose the preparatory response before submission, then lose upload/conversion responses before and after first persistence. Reload/reconcile; explicitly retry the same submission; test cancellation and a mismatched owner/session/name/size/hash/target or expired token. | Under the [new submission contract](reliability-recovery-increment.md), a lost preparation response stores no document. Once submission starts, the client already has a recoverable identity. Replay never overwrites the original, extends expiry or resurrects a deleted record; reconciliation performs reads only and never automatically repeats model work. | Sanitized network trace, identity/deadline, original hash, persisted attempt/usage counts and displayed status. Confirm this against the final implemented contract before execution. |
| Publish a selected PowerPoint export while another client exports or reconverts; lose each upload/commit acknowledgement, then request download using a stale artifact binding. | One immutable output/review pair matches the exact retained owner, lease and choice set; stale leases cannot publish or overwrite newer work. Reconciliation proves the exact committed result. Stale download bindings request refresh; possibly committed blobs retain cleanup evidence. | Lease/attempt transitions without secrets, selected IDs, review hash, downloaded hash, receipts and recorded usage. |
| As user B, request user A's source/output/review; repeat for expired or deleted synthetic records and an invalid target/artifact ID. | No unauthorized content or signed URL; original expiry never extends on retry. Previously issued URLs are bounded by their existing short TTL, not claimed immediately revoked. | Status/body without tokens, issue/expiry times, and target/source identity checks. |
| In isolated records only, interrupt a stored upload, allow it to settle, and exercise the approved retention cleanup procedure. | All receipts/legacy and immutable keys remain discoverable; user access ends on original expiry/deletion; settlement barrier prevents premature cleanup; later eligible cleanup removes synthetic content and preserves anonymous totals. | Receipt/key inventory before/after, settlement times, cleanup result and anonymous totals. Do not infer that the one-hour allowance bounds every possible provider delay. |

Any uncertain write without retained discovery evidence, cross-user access,
content/review mismatch, duplicate billable work or false recovered-success
status is FAIL. If fault injection or real isolated infrastructure is absent,
record BLOCKED; the passing PGlite suite cannot fill that evidence gap.

### O — Native Office editing and assistive technology (NOT RUN)

- [ ] **Word D1/D2:** open source and downloaded DOCX in the same Word build.
  No repair/recovery prompt; compare page count, wording, list starts, all table
  values, links, images, headers/footers and authored descriptions. Edit a copy's
  body paragraph and table cell, save, close and reopen: content remains editable
  and retained. Supported metadata changes preserve layout; only measured list
  prefixes/header regions may differ. Record every unrelated shift or lost object
  as FAIL. Run Accessibility Checker and retain its results plus remaining app
  findings; a checker pass alone does not pass the following navigation check.
- [ ] **PowerPoint P1/P2:** open source, initial repair and selected export.
  No repair prompt; original slides/IDs/notes/media/chart data and hidden state
  remain. Edit native text, table and chart data in a copy; save/reopen and play
  synthetic media/animations. Select the table under an overlapping placeholder
  in editing view; previews alone cannot pass this test. Check reading order,
  clipping and titles, including appended description slides. Restore all changes
  and verify the promised original-byte replay; restore one change and verify
  only its dependent additions disappear, references update and declined repairs
  are not reapplied. Run the checker on the actual selected download.
- [ ] **Keyboard/screen reader:** in each native output, navigate headings,
  lists, table rows/columns, links, slides, meaningful images and added description
  text using the recorded reader. Read the fixture's complete expected sentences,
  numbers, units and negation; verify order, contextual names and language changes.
  Operate links/media without a mouse. Capture short observation/speech logs keyed
  to source location. Missing/duplicated/misordered meaning, inaccessible controls,
  lost editability or unannounced meaningful content is FAIL; ambiguous semantics
  remain specific review items, not invented automatic repairs.

### A — Acrobat PDF, form behavior and screen reader (NOT RUN)

- [ ] Open F1/F2/F3 source and output in the recorded Acrobat build. Confirm page
  count/appearance, meaningful text, links/destinations and opening view. Inspect
  actual saved tags, table headers, lists, notes, chart alternatives and reading
  order, then navigate them with keyboard and screen reader. Match observed speech
  to source meaning; an extracted-text string alone proves neither correct nor
  incorrect speech. Capture saved-file hash, checker results and observations.
- [ ] For the supported synthetic hybrid form, list **every** field/widget and
  expected label, type, required instruction, value and state before testing.
  Tab/Shift+Tab through all controls; hear each label/state; enter fictional text,
  operate every checkbox and mutually exclusive choice, save, close and reopen.
  Recheck every value/state and announcement after reopening and compare native
  values/XFA data/appearances. Any changed source behavior or inaccessible original
  control is FAIL. Metadata counts or a fingerprint are not interaction tests.
- [ ] If a fixture requires signing, dating or cross-out, test each completion
  method separately using keyboard and reader; reopen the saved result and inspect
  its accessible representation. Mouse-only placement, unavailable tools or an
  unreadable saved mark are unresolved findings, not passed completion methods.
- [ ] Preserve precise machine defects, incomplete audit and interaction limits.
  Prior W-9 evidence applies only through the current exact source/final-form
  fingerprint match in [the evidence contract](pdf-form-interaction-evidence.md);
  it is not a current test of these fixtures or all forms. Keep current-run
  screen-reader claims false unless the exact current file was actually tested.

## 5. Record the decision and stop conditions

- [ ] Classify each case as verified supported repair, preserved partial output
  with specific remaining work, incomplete review, or rejected input with original
  retained. Unsafe output, missing required preservation/audit evidence, hidden
  known defects, wrong native format, or a broken source-content oracle stops
  release of the affected capability. Unsupported input rejection is a passing
  boundary test, not proof of automatic remediation for that class.
- [ ] Link each FAIL/BLOCKED/NOT RUN to its owner and next authorized action.
  An unmet hosted/Java/Office/Acrobat/reader gate prevents claiming that scope
  production-validated. Record any explicitly approved narrowed scope and visible
  limitations; do not relabel an unrun test as pass to finish the release.
- [ ] Review the [remaining dependency findings](dependency-security-review.md),
  current CI and all release evidence together. Parent/user owns any subsequent
  merge, deployment or infrastructure decision. This checklist authorizes none.
  Neither CI, native checkers, veraPDF nor an AI audit alone certifies arbitrary
  documents accessible or establishes PDF/UA conformance. Keep source originals,
  review notes and unresolved/manual cases honest and discoverable.
