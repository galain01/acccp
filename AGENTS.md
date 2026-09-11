<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

## shadcn / UI structure

- UI primitives live in `components/ui/`. Add new ones via `npx shadcn@latest add <name>`.
- Primitives use `@base-ui/react`, `cn()` from `lib/utils.ts`, semantic design tokens from `app/globals.css`, and Lucide icons.
- App composites (`application-usage`, `dashboard-sidebar`, `document-workspace`, etc.) import sibling UI with `./`; pages and layouts use `@/components/ui/...`.
- Config: `components.json` — style `base-rhea`, CSS variables, Lucide icon library.
- Theme: forced light mode in `app/layout.tsx` (`ThemeProvider forcedTheme="light"`) to match Canvas.

### Installed primitives

accordion, badge, breadcrumb, button, card, dialog, dropdown-menu, field, input, input-otp, label, pagination, separator, sheet, sidebar, skeleton, table, tabs, tooltip

### App composites (hand-written on top of primitives)

`application-usage`, `dashboard-sidebar`, `dashboard-breadcrumb`, `document-table`, `document-workspace`, `conversion-result-dialog`, `file-upload`, `rename-dialog`, `session-button`, `admin-metrics`, `admin-table-pagination`, `pending-users-table`

## Data layer

- **Postgres via Supabase**, accessed with **Drizzle ORM** (`drizzle-orm/postgres-js`). Client setup: `lib/db.ts` (uses `prepare: false`, required by Supabase's transaction-mode pooler; caches the client on `globalThis` in dev to survive HMR). Schema: `lib/db/schema.ts`; relations: `lib/db/relations.ts`.
- `lib/db/connection-options.ts` accepts optional `DATABASE_SSL_CA` (public PEM certificate, actual or escaped newlines). When set, the app uses `ssl: { ca, rejectUnauthorized: true }`, overriding URL SSL options and verifying the certificate/hostname. Without it, URL/driver TLS behavior is preserved; Postgres.js defaults to no TLS. Configure the hosted app with its Supabase CA and `sslmode=verify-full`. Restart/redeploy after changes. Drizzle CLI uses a separate driver and does not read this app-only variable; supply the public CA through Node's `NODE_EXTRA_CA_CERTS` at process startup for CLI migrations.
- Core tables: `users`, `auth_sessions`, `accounts`, `verifications` (better-auth's tables, mapped — see below), `sessions`, `documents`, `conversion_jobs`, `artifacts`, `validation_findings`, `job_events`, `model_calls`. Plus several `pgView`s for admin summaries (`admin_finding_summary`, `admin_retention_summary`, `admin_job_status_summary`, `admin_daily_job_summary`, `user_session_file_overview`).
- All tables have RLS enabled (`.enableRLS()`); app code goes through the Drizzle client with the app's own authorization checks (`verifyRoleOrRedirect` / `verifyRoleOrUnauthorized` in `lib/auth.ts`), not per-user Postgres roles.
- **Sessions and documents are persisted** (no longer in-memory demo state). `contexts/session-context.tsx` (`SessionProvider`) treats the `sessions` prop from the dashboard layout as server state; every mutation (`createSession`, `renameSession`, `archiveSession` in `lib/actions/sessions.ts`) goes through a server action that revalidates the layout. Document actions live in `lib/actions/documents.ts` (`listDocuments`, `getDocumentHtml` — output HTML lives in storage and is fetched on demand; `deleteDocument` — commits an owned tombstone, then attempts retryable file and database deletion).
- **Document retention is 14 elapsed days from original `documents.created_at`**, including reconversions, archived sessions and failed uploads. `lib/document-retention.ts` shares a PostgreSQL document row lock between conversion storage/metadata writes, HTML retrieval and purge; keep native rendering/model calls outside that transaction. Check the DB clock after acquiring the lock and after the callback. Do not write document blobs/metadata outside `withRetainedDocument` or extend expiry on reconversion. Purge removes canonical and all artifact-linked storage keys before cascading document deletion; failures preserve discovery records. See `docs/document-retention.md` for migration `0008`, daily cleanup timing, dry-run and rollout. Application expiry works independently of cron enablement; the separate test app must use isolated data or the same retention-aware code before enabling production cleanup.
- `lib/db/errors.ts` (`isUniqueViolation`) detects Postgres `23505` by walking the error `cause` chain — Drizzle wraps driver errors, so `error.code` is never on the top-level error.
- Migrations: `npm run db:generate` / `db:migrate` / `db:push` / `db:studio` (drizzle-kit).

## Auth

- **better-auth**, configured in `lib/auth.ts`, using the **Drizzle adapter** against the same Postgres schema (`users`/`authSessions`/`accounts`/`verifications` tables above; `generateId: false` since Postgres assigns UUIDs). Client-side helpers: `lib/auth-client.ts`. Route handler: `app/api/auth/[...all]/route.ts`.
- Sign-in is **email OTP only** (`emailAndPassword` disabled), via the `emailOTP` plugin. A `before` hook on `/sign-in/email-otp` and `/email-otp/send-verification-otp` rejects any email that doesn't match `OSU_EMAIL_REGEX` (`@...osu.edu`, including subdomains like `buckeyemail.osu.edu`) — this is what scopes sign-in to OSU accounts without needing Microsoft Entra tenant access.
- OTP delivery: `lib/email.ts` (`sendOtpEmail`). `EMAIL_PROVIDER=console` (default) logs the OTP for local dev only; production and Vercel previews reject console delivery. Set to `resend` (with `RESEND_API_KEY` / `EMAIL_FROM`) for deployed sign-in. Raw provider errors are never returned or logged.
- Users have a `role` field (`pending | instructor | admin`, default `pending`). Gate server components/actions with `verifyRoleOrRedirect(permitted)` and API routes with `verifyRoleOrUnauthorized(permitted)`, both in `lib/auth.ts`.

## Storage (Supabase Storage)

- `lib/storage.ts` is a server-only Supabase Storage client (bucket `documents`), built with the **service role key** — necessary because auth is better-auth, not Supabase Auth, so requests carry no Supabase JWT and an anon-key client would be treated as anonymous. Never import it from a client component. Ownership is enforced in app code before every call, same as the DB.
- Objects are keyed `sourceDocxKey(sessionId, documentId)` → `{sessionId}/{documentId}/source.docx` (Word original), `sourcePdfKey(...)` → `{sessionId}/{documentId}/source.pdf` (uploaded PDF or rendered Word), and `htmlOutputKey(...)` → `{sessionId}/{documentId}/output.html`, grouped by session so a session's blobs can be swept together. Uploads use `upsert: true`; reconversion preserves the original source and replaces generated output. Downloads for end users go through short-lived (`createSignedUrl`, default 5 min) signed URLs since the bucket is private.
- Required env vars: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`.

## Document conversion pipeline (LiteLLM)

- `lib/litellm.ts` is the shared LiteLLM client (see `docs/model-pricing.md`): `callLiteLLM()` posts to `${LITELLM_BASE_URL}/chat/completions`, and `fetchModelPricing()` reads `${LITELLM_BASE_URL}/model/info` (5-min in-memory cache) to price calls via `computeCallCostUsd()`. Required env vars: `LITELLM_BASE_URL`, `LITELLM_API_KEY`. The optional `LITELLM_MODEL` overrides `DEFAULT_LITELLM_MODEL` (`gpt-5.6-sol-2026-07-09`); unset or blank values use the default. The API key must authorize the selected proxy model. `scripts/quality-check.ts` uses this same configuration, with an optional `LITELLM_QUALITY_MODEL` override for its final reviewer.
- `lib/convert.ts` (`convertPdf()`) sends the same PDF bytes to conversion and source-aware audit calls. The audit receives formatted HTML and measured page count; invalid/unavailable source pages stay unknown. Prompts live in `lib/prompts/pdf-accessibility.ts` and `lib/prompts/accessibility-audit.ts`; pure finding contracts/parsing/presentation are in `lib/accessibility-findings.ts`, and source-marker/duplicate handling in `lib/pdf-review-findings.ts`. Faculty see plain-language actions and locations; technical details are optional. Source-authored draft reminders are not audit tasks. Existing title/category/location JSONB columns persist findings, still subject to ownership checks and 14-day deletion. See `docs/source-aware-audit.md`.
- `lib/word-to-pdf.ts` (`renderWordToPdf()`) sends one DOCX to the configured Gotenberg/LibreOffice worker before these PDF stages. It requires HTTPS and Basic authentication for hosted workers, allows HTTP loopback only in local development, refuses redirects, bounds rendering/download to 60 seconds, and validates/caps the returned PDF at 4 MiB. Worker errors return safe summaries. See [docs/word-to-pdf.md](docs/word-to-pdf.md) for the pinned local Compose service, outbound restrictions, and the database-free `npm run convert:document` CLI.
- Native deployment uses `vercel.json` Services (`web` Next.js + private `renderer` container); set the project's framework to Services. Only `web` receives public traffic. Its binding injects `GOTENBERG_URL`; do not manually configure the URL for this topology. Supply both renderer credentials and the existing app variables in each deployment environment. `services/renderer/start-renderer.sh` honors injected `PORT` (default 80), clears inherited app secrets before starting even `tini`, and fixes renderer controls including `LOG_LEVEL=error`. Hosted Gotenberg URL filtering is application-level; Vercel documents no equivalent to the local Compose worker's deny-all network egress. An external HTTPS worker remains possible with a normal Next.js deployment and explicit URL instead of the binding.
- Successful Word conversions include a persistent manual-review finding about omitted linked content and possible font/layout changes. Keep it in both the API and CLI output; renderer success does not prove fidelity to the original Word document.
- The stage-1 output is pretty-printed with **prettier** (`parser: "html"`) before validation/persistence; formatting failures fall back to the raw string rather than failing the conversion. PDF image placeholders and source-review comments produce deterministic warnings in `errors[]` and the compatibility `extractionWarnings[]` field. Images are not extracted/uploaded; users re-add them in Canvas. Incomplete or non-HTML model output fails conversion rather than being saved as success.
- Audit responses are validated at runtime: malformed JSON, non-array JSON, or invalid finding entries produce a manual-review warning. Valid findings and model-call usage are retained; an invalid response is never silently treated as a clean audit.
- `lib/conversion-status.ts` (`toConversionStatus`) maps DB `job_status` values onto the dashboard's simpler `ConversionStatus` (`idle | queued | processing | success | error`; `needs_review` counts as success, `expired`/`cancelled` as error, no job row = `idle`). UI-facing types (`UploadedDocument`, `Session`) live in `lib/types/document.ts`.
- `POST /api/convert` (`app/api/convert/route.ts`) verifies session ownership and, on reconversion, document ownership before accessing sources or rendering. DOCX rendering completes before new document persistence or model calls; rendering failures preserve a saved document's prior job. New document metadata (MIME, size, SHA-256) describes the original upload. Word uploads store both `source.docx` and the exact `source.pdf` passed to `convertPdf()`; direct PDF uploads bypass the renderer. Reconverting stored DOCX downloads and renders its original again without creating another document or overwriting that original. The prior stored PDF is replaced only after model conversion succeeds.
- After source storage succeeds, the route upserts a `conversion_jobs` row (one job per document; reconversion increments `attempt_count`) and calls `convertPdf()` **outside** any DB transaction. On success it uploads HTML, then in one transaction marks the job `completed`, upserts `source_pdf`/`html_output` artifacts plus `source_docx` for Word (one available artifact per type via `uq_available_artifact_per_job_type`), replaces `validation_findings`, logs a `job_events` row, and inserts `model_calls`. A model conversion failure retains any billable usage and records the failed job/event.
- Costs prefer the valid gateway response-cost header, then gateway metadata, then a dated and labeled published Sol estimate. Cache-read/write counts and long-context tiers affect estimates; source metadata survives in `model_calls`. Existing non-null historical costs are immutable.
- Per-call token usage/cost is captured as `ModelCallUsage[]` and persisted to `model_calls` (stage `convert`/`validate`), which backs the admin cost/token tracking metrics tab.
- `GET /api/admin/model-info` returns pricing for the currently configured model with its gateway/list-price source metadata (admin-only) — distinct from the historical per-call cost in `model_calls`, which is snapshotted at call time so past spend doesn't shift if LiteLLM's pricing changes later.

- PDF and DOCX uploads share the existing 4 MiB limit and client/server rules in `lib/document-input.ts`. PDF requires its extension and `%PDF-` header; DOCX requires its extension and ZIP local-header signature, with actual package parsing delegated to the renderer. Legacy `.doc` and macro-enabled `.docm` are unsupported. `app/api/convert/route.ts` retains Node runtime and its 300-second duration. Deletion cleans both Word and PDF source paths.
- The prior `drizzle/0007_source_pdf.sql` migration must be applied; it adds `source_pdf` to `artifact_type` without changing existing artifacts. Word rendering needs no additional migration. If the private Supabase bucket restricts MIME types, allow `application/pdf` and `application/vnd.openxmlformats-officedocument.wordprocessingml.document`. Do not apply migrations to an unintended database.

## Admin surfaces

- Migration `0010_dashboard_job_metrics` adds nullable page counts and monotonic successful-processing durations, per-call pricing provenance/cache counters and unrestricted decimal cost, retained daily/model job token/page totals, exact duration-frequency counts, and nullable pricing coverage. See `docs/dashboard-metrics.md` for definitions and rollout. Job cohorts use original job creation dates; usage uses call dates. Retain these aggregates without instructor/document identifiers.
- `lib/admin-metrics-history.ts` reads selected-date daily/model/summary metrics in one SQL snapshot, including exact weighted medians; `lib/actions/metrics-history.ts` authorizes admins and validates UTC date ranges. The dashboard offers 30/90/365-day, all-time and custom views, charts, daily values and a dedicated current-30-day token total. Do not average daily medians or divide call-date usage by job-date cohorts for average tokens/job.
- `lib/pdf-page-count.ts` counts the actual final PDF inside a time/input/heap-bounded worker. Parse failure is a null metric, not a conversion failure. The parser bundle is explicitly traced by `next.config.ts`; verify its worker path in the production build. Processing time begins before Word rendering and ends in the final success metadata update. Older partial timestamps are not substitutes.

- Migration `0009_retained_metrics` adds `retained_job_metrics` (UTC day/status/job count) and `retained_model_metrics` (UTC day/model/stage/call count/tokens/nullable cost). `archiveDocumentMetrics` runs inside the locked purge transaction after blob removal and before cascading document deletion, so rollback/retry cannot double-count. These aggregates deliberately retain no document/user/instructor identifiers, filenames, snippets or raw errors. Do not expire them with document content. Admin summary cards read a single SQL snapshot combining current records and retained totals; token/cost windows use UTC calendar days including today. Job success retains the latest job-per-document semantics, while usage counts every recorded model call. The detailed recent-job table remains limited to unexpired documents.

- `app/admin/page.tsx` + `components/ui/admin-metrics.tsx` is the admin dashboard: pending-user approval queue, job status summary, token/cost usage over a configurable day window, and a paginated recent-jobs table (filename, requester, status, model, tokens, cost).
- `lib/actions/admin-metrics.ts` (all admin-role-gated via `verifyRoleOrRedirect(["admin"])`): `getUserRoleCounts`, `getJobStatusSummary`, `getTokenUsage(days)`, `getCostSummary(days)`, `listRecentJobs(page, pageSize)`, `listPendingUsersPage(page, pageSize)`. Pure aggregation/pagination helpers live in `lib/metrics-math.ts` (unit-tested).
- `lib/actions/admin-users.ts`: `approveUser` (flips role `pending → instructor`) and `rejectUser` (hard-deletes the user row — no soft delete). New users default to role `pending` and land on `app/pending-approval/page.tsx` until approved; `app/unauthorized/page.tsx` handles role-mismatch redirects from `verifyRoleOrRedirect`.

## Required environment variables

All read via `process.env` (no `.env.example` in the repo — check `.env` against this list). Missing required vars throw at first use, not at boot.

| Variable | Required | Used by | Notes |
|---|---|---|---|
| `DATABASE_URL` | Yes | `lib/db.ts`, `drizzle.config.ts` | Postgres connection string. Must point at Supabase's **transaction-mode pooler** (`prepare: false` is set to match). |
| `DATABASE_SSL_CA` | For verified TLS with a private CA | `lib/db/connection-options.ts` | Public CA PEM text from Supabase SSL settings. Enables certificate and hostname verification for the app; never use a private key. See README for Drizzle CLI TLS setup. |
| `BETTER_AUTH_SECRET` | Yes | better-auth (implicit) | Signs sessions/tokens. |
| `BETTER_AUTH_URL` | Yes | better-auth (implicit) | Base URL better-auth issues callback/redirect links against, e.g. `http://localhost:3000` in dev. |
| `LITELLM_BASE_URL` | Yes | `lib/litellm.ts` | e.g. `https://litellm.cloud.osu.edu`. |
| `LITELLM_API_KEY` | Yes | `lib/litellm.ts` | |
| `LITELLM_MODEL` | No | `lib/litellm.ts` | Defaults to `gpt-5.6-sol-2026-07-09` when unset or blank; explicit proxy model IDs override the default. |
| `LITELLM_CONVERSION_MODEL` / `LITELLM_AUDIT_MODEL` | No | `lib/litellm.ts` | Independent stage models; blank/unset values fall back to LITELLM_MODEL then the existing Sol default. Same gateway/key. |
| `LITELLM_QUALITY_MODEL` | No | `scripts/quality-check.ts` | Optional final-reviewer model; defaults to the shared configured model. |
| `GOTENBERG_URL` | For Word conversion | `lib/word-to-pdf.ts` | Automatically injected by the Vercel service binding; set manually only for local/external workers. HTTPS required when hosted; HTTP loopback allowed only in local development. Direct PDF uploads do not use it. |
| `GOTENBERG_USERNAME` | For hosted Word conversion | `lib/word-to-pdf.ts` | Basic authentication username; the supplied local Compose setup also requires it. |
| `GOTENBERG_PASSWORD` | For hosted Word conversion | `lib/word-to-pdf.ts` | Worker password; server-only, keep in ignored env files or deployment secrets. |
| `SUPABASE_URL` | Yes | `lib/storage.ts` | Project API URL (`https://<ref>.supabase.co`), not the Postgres connection string. |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes | `lib/storage.ts` | Bypasses storage RLS; server-only, never expose to the client. |
| `CRON_SECRET` | For scheduled purge | `/api/cron/purge-documents` | Random server-only secret of at least 32 characters. Vercel sends it as a Bearer header. Configure only on the intended Production project. |
| `DOCUMENT_PURGE_ENABLED` | To activate deletion | `/api/cron/purge-documents` | Must be exactly `true`, with `VERCEL_ENV=production`; unset disables deletion. Authenticated `?dryRun=true` remains read-only. Never enable against shared production data from a test project. |
| `EMAIL_PROVIDER` | Yes for deployments | `lib/email.ts` | `console` (default, local development only) or `resend` (required in production and Vercel previews). |
| `RESEND_API_KEY` | Only if `EMAIL_PROVIDER=resend` | `lib/email.ts` | |
| `EMAIL_FROM` | Only if `EMAIL_PROVIDER=resend` | `lib/email.ts` | Passed straight through to Resend's `from` field — must be a full sender **address** (e.g. `noreply@verify.acccp.teachertools.pro`) on a domain verified in the Resend account, not a bare domain. |
| `NODE_ENV` | No | `lib/db.ts` | Standard Next.js var; gates the dev-only global DB client cache. |

## Route map

- `app/page.tsx` — sign-in (email OTP).
- `app/dashboard/layout.tsx` — redirects signed-out users to `/` and `pending` users to `/pending-approval`, loads sessions via `listSessionsEnsuringDefault()`, provides `SessionProvider`, and shows an **Admin** header button (link to `/admin`) for admins; `app/dashboard/page.tsx` and `app/dashboard/[id]/page.tsx` — session-scoped document workspace.
- `app/admin/page.tsx` — admin metrics/user-approval dashboard (role `admin`); tabbed (users / metrics), links back to `/dashboard`.
- `app/pending-approval/page.tsx` — held here until an admin approves (role `pending`).
- `app/unauthorized/page.tsx` — role-mismatch landing page.
- `app/not-found.tsx` — 404 page with a link back to sign-in.
- `app/api/auth/[...all]/route.ts` — better-auth catch-all handler.
- `app/api/convert/route.ts`, `app/api/admin/model-info/route.ts` — described above.
- `GET /api/cron/purge-documents` — authenticated daily retention sweep; counts-only response, 503 on failed/incomplete cleanup. Query `dryRun=true` never deletes data. Scheduled via top-level `vercel.json.crons` and routed to `web`.

## Tests

- Vitest, `npm run test` (or `test:watch`). Tests live in `test/`, default node environment, `@/` alias mapped to the repo root in `vitest.config.ts`. `document-workspace.test.tsx` uses jsdom with real React components and mocked network calls to cover batch selection, explicit reconversion and duplicate-click prevention.
- Coverage targets the pure/mockable core: `convert.test.ts` (pipeline with prettier/LiteLLM mocked), `litellm.test.ts` (client + cost math), `pdf-route.test.ts` (Word/PDF orchestration, ownership, persistence and failure ordering), `word-input.test.ts` (input boundaries), `word-to-pdf.test.ts` (renderer contract and safeguards), `metrics-math.test.ts` (admin aggregation), `conversion-status.test.ts` (status mapping). `admin-metrics-render.test.tsx` renders the actual dashboard with synthetic actions; isolated PostgreSQL/WASM integration suites verify retention and historical metrics. No browser end-to-end tests yet.

## Gotchas

- Batch Convert selects only unlocked, supported documents with `idle` or `error` status. Successful documents require their explicit per-row Re-convert action, including after reload. Re-convert is disabled while locked or while any conversion is active. Preserve a failed response's saved document ID so retries reuse its source and job.
- The document `locked` flag is client-state only (`documents` has no locked column) — locking excludes a document from conversion, and resets on reload. Successful status still excludes it from batch Convert after the lock resets.
- Uploaded files are held in client memory (`UploadedDocument.file`) until first conversion persists them; a document row + storage upload only happens on convert, not on upload.
