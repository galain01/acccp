# Accessible Canvas Content Conversion Platform

## Overview

The Accessible Canvas Content Conversion Platform (dubbed "ACCCP" by the development team)
is a centralized platform for OSU instructors to convert their PDF course content into accessible
Canvas-ready HTML by leveraging state-of-the-art LLM AI models.

This project was developed as part of a summer 2026 CSE 5911 capstone session
at the Ohio State University by group members Adithya Balachandar, Braedon Salisbury,
Rudy Hartwig, and Theo Turner. It has been released as an MVP with the goal of improving
course content accessibility while also helping to meet a university-wide effort to be
compliant with ADA Title II and section 504 of the Rehabilitation Act by 2027.

## Contents

- [How the App Works](#how-the-app-works)
- [Repository Layout](#repository-layout)
- [Technology Stack](#technology-stack)
- [Setting up a Development Environment](#setting-up-a-development-environment)
- [Development Workflow](#development-workflow)

For deeper architecture notes (database schema, auth internals, the conversion
pipeline's persistence model, environment variable reference), see
[AGENTS.md](AGENTS.md) — it's written for AI coding agents but doubles as the
project's technical reference for humans.

## How the App Works

### Signing in and roles

- Users sign in at `/` with their **OSU email address** (`@osu.edu`, including
  subdomains like `buckeyemail.osu.edu` — non-OSU addresses are rejected). There
  are no passwords: a one-time password (OTP) is emailed to them, which they
  enter to complete sign-in. In local development the OTP is printed to the dev
  server terminal instead of emailed (see `EMAIL_PROVIDER` below).
- Every user has a role: `pending`, `instructor`, or `admin`. New sign-ups start
  as `pending` and are held at `/pending-approval` until an admin approves them
  from the admin dashboard. Rejecting a pending user deletes their account.

### Converting documents (instructor workflow)

1. After approval, instructors land on `/dashboard`. Work is organized into
   **sessions** (think folders/course contexts), listed in the sidebar. Sessions
   can be created, renamed, and archived; a default session is created
   automatically on first visit.
2. Inside a session, upload one or more `.pdf` files (up to 4 MB each). Export Word
   documents to PDF first; the app does not render Word documents on Vercel.
3. Click **Convert**. Each unlocked document is sent through a two-stage AI
   pipeline:
   - **Stage 1 — conversion**: the original PDF is sent to the configured
     vision-capable model as a file, including text and page images. The model
     infers headings and reading order from content and appearance, preserves
     substantive text, and produces accessible Canvas HTML. Images remain
     placeholders for manual reinsertion, with proposed alternative text and
     explicit review findings. No image files are uploaded to Canvas.
   - **Stage 2 — audit**: a second, independent LLM call reviews the generated
     HTML and returns a structured list of accessibility findings (missing alt
     text, heading skips, non-descriptive links, table issues, etc.), each
     tagged with the WCAG criterion it violates.
4. Click a converted document to open the **result dialog**: the pretty-printed
   HTML output, the accessibility findings, and buttons to copy the HTML or
   download it as an `.html` file — ready to paste into the Canvas RCE.
5. Locking a document (padlock icon in the table) excludes it from the next
   Convert run. Re-converting a document overwrites its previous output.
   Deleting a document removes it and its stored files.

### Admin dashboard

Admins get an **Admin** button in the dashboard header linking to `/admin`,
which provides:

- A **pending-user approval queue** (approve → `instructor`, or reject).
- **Job status** and **daily job** summaries.
- **Token usage and cost tracking** over a configurable day window, priced from
  LiteLLM's live model pricing at call time.
- A paginated **recent jobs** table (filename, requester, status, model,
  tokens, cost).

## Repository Layout

```
acccp/
├── app/                      # Next.js App Router — every route lives here
│   ├── page.tsx              #   "/" sign-in page (email OTP)
│   ├── dashboard/            #   Instructor workspace
│   │   ├── layout.tsx        #     Loads sessions, sidebar + admin nav button
│   │   ├── page.tsx          #     Default session view
│   │   └── [id]/page.tsx     #     Session-scoped document workspace
│   ├── admin/page.tsx        #   Admin metrics & user-approval dashboard
│   ├── pending-approval/     #   Holding page for unapproved users
│   ├── unauthorized/         #   Role-mismatch landing page
│   ├── not-found.tsx         #   404 page
│   └── api/
│       ├── auth/[...all]/    #   better-auth catch-all handler
│       ├── convert/          #   POST /api/convert — conversion orchestration
│       └── admin/model-info/ #   GET — live LiteLLM pricing (admin-only)
├── components/
│   └── ui/                   # shadcn primitives + hand-written app composites
│                             #   (document-workspace, document-table,
│                             #    conversion-result-dialog, file-upload,
│                             #    dashboard-sidebar, admin-metrics, ...)
├── contexts/
│   └── session-context.tsx   # SessionProvider — client state for sessions
├── hooks/                    # Shared React hooks (use-mobile)
├── lib/
│   ├── convert.ts            # ★ The PDF → HTML conversion pipeline
│   ├── prompts/pdf-accessibility.ts  # Stage-1 system prompt (BUX/WCAG rules)
│   ├── litellm.ts            # LiteLLM API client + pricing/cost helpers
│   ├── auth.ts               # better-auth config + role-gate helpers
│   ├── auth-client.ts        # Client-side auth helpers
│   ├── email.ts              # OTP email delivery (console or Resend)
│   ├── db.ts                 # Drizzle/Postgres client
│   ├── db/schema.ts          # ★ Database schema (all tables & views)
│   ├── db/relations.ts       # Drizzle relations
│   ├── db/errors.ts          # Postgres error helpers (unique violations)
│   ├── storage.ts            # Supabase Storage client + object key helpers
│   ├── actions/              # Server actions
│   │   ├── sessions.ts       #   create/rename/archive sessions
│   │   ├── documents.ts      #   list/fetch-HTML/delete documents
│   │   ├── admin-metrics.ts  #   admin dashboard queries
│   │   └── admin-users.ts    #   approve/reject pending users
│   ├── conversion-status.ts  # job_status → UI status mapping
│   ├── metrics-math.ts       # Pure aggregation helpers (unit-tested)
│   ├── format.ts             # Byte/date display formatting
│   ├── types/document.ts     # Shared UI types (UploadedDocument, Session)
│   └── utils.ts              # cn() class-name helper
├── drizzle/                  # Generated SQL migrations (committed)
├── test/                     # Vitest unit tests
├── drizzle.config.ts         # drizzle-kit config
├── vitest.config.ts          # Test runner config ("@/" alias → repo root)
└── components.json           # shadcn/ui config
```

Good starting points for new contributors: [lib/convert.ts](lib/convert.ts)
(the core pipeline, heavily commented), [app/api/convert/route.ts](app/api/convert/route.ts)
(how a conversion is persisted), and [lib/db/schema.ts](lib/db/schema.ts)
(the data model).

## Technology Stack

At its core, ACCCP is a Next.JS 16 application hosted on Vercel.
Below is a breakdown of the technologies the team used
to build out the app's functionality.

The following were used on the frontend to build the website:

- `React`: The component-based frontend framework used by Next.
- `Shadcn/UI`: Used for the majority of the frontend component designs.
  Allows for quick iteration and customization of the site's pages.
- `TailwindCSS`: Used in combination with `Shadcn/UI` to style page content.

The following were used on the backend to build the API and database:

- `Supabase`: The application's database (PostgreSQL) and file-storage
  provider. Uploaded `.pdf` sources and generated HTML outputs live in a
  private Supabase Storage bucket.
- `Drizzle ORM`: Type-safe database access and migration tooling
  (`drizzle-kit`).
- `Better Auth`: The application's authentication provider. Instructors
  sign in with their email, and enter a one-time-password to verify their identity.
- `Resend`: The application's provider for sending verification OTP emails.
- `LiteLLM`: The application's AI model provider (OSU-hosted proxy).
- `Vitest`: Unit test runner.

## Setting up a Development Environment

### Prerequisites

- **Node.js 24 (current LTS)** and **npm 11+** (bundled with Node 24).
- **Git**.
- Access to the team's shared **Supabase** project. Ask a team member to invite
  you as a collaborator on the project dashboard.
- An OSU **LiteLLM** API key authorized for the configured model
  (`gpt-5.6-sol-2026-07-09` by default) on the OSU LiteLLM instance.

### 1. Clone and install dependencies

```bash
git clone <repo-url>
cd acccp
npm install
```

### 2. Configure environment variables

Create a `.env` file in the project root (it's git-ignored) with the
following variables:

```bash
# Database (Supabase Postgres connection string)
DATABASE_URL=

# Supabase (used for file storage)
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=

# Better Auth
BETTER_AUTH_SECRET=
BETTER_AUTH_URL=http://localhost:3000

# LiteLLM (AI model provider)
LITELLM_BASE_URL=
LITELLM_API_KEY=
LITELLM_MODEL=gpt-5.6-sol-2026-07-09

# Email (OTP sign-in codes)
EMAIL_PROVIDER=console
```

Where to find each value:

- `DATABASE_URL` / `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` — from the
  shared Supabase project dashboard, under **Project Settings → Data API**
  (`SUPABASE_URL`, service role key) and **Project Settings → Database**
  (connection string for `DATABASE_URL`; use the pooled connection string).
- `BETTER_AUTH_SECRET` — any random secret string, e.g. generate one with
  `openssl rand -base64 32`. `BETTER_AUTH_URL` should match the URL the app
  is running on (`http://localhost:3000` for local dev).
- `LITELLM_BASE_URL` / `LITELLM_API_KEY` — from whoever administers the OSU
  LiteLLM instance for this project; `LITELLM_MODEL` defaults to
  `gpt-5.6-sol-2026-07-09` if unset or blank. Set it explicitly in deployed
  environments so the selected model is visible in configuration. The model
  ID must match a model exposed by your LiteLLM proxy and allowed by your key.
- `EMAIL_PROVIDER` — leave as `console` for local development; sign-in OTP
  codes are logged to the terminal instead of emailed, so no Resend setup is
  needed. Production and Vercel preview deployments require `resend`; console
  delivery is blocked there so sign-in codes cannot appear in server logs.
  To send real email, set it to `resend` and add
  `RESEND_API_KEY` (from the [Resend dashboard](https://resend.com)) and
  `EMAIL_FROM` (a verified sending address/domain).

The full environment variable reference (which module reads each variable, and
gotchas like the pooled-connection requirement) is in
[AGENTS.md](AGENTS.md#required-environment-variables).

### Changing the model on Vercel

The API key and model selection are separate settings. Updating
`LITELLM_API_KEY` grants access through the proxy but does not change the
`model` sent with each request.

For the GPT-5.6 Sol migration, keep the authorized `LITELLM_API_KEY` in
Vercel and deploy this code. `gpt-5.6-sol-2026-07-09` is the default, so
`LITELLM_MODEL` is optional. If you set it explicitly, use that exact model ID;
an existing override (including an old Nano value) takes precedence over the
code default. Redeploy after changing environment variables.

The conversion, accessibility audit, and admin model-info endpoint all read
the shared configuration in `lib/litellm.ts`. The standalone quality-check
script uses the same configuration; its optional `LITELLM_QUALITY_MODEL`
override selects only the final quality reviewer and must also be allowed
by the key. Keep secrets in Vercel or a local git-ignored `.env` file.

After deployment, convert a small PDF and check the returned model and the
admin dashboard's recorded model calls. Unit tests mock the proxy, so passing
tests do not establish live access to a model. Pricing continues to come from
LiteLLM's `/model/info`; historical model-call records keep their saved costs.

### Deploying the PDF input change

Before deploying this branch, apply `drizzle/0007_source_pdf.sql` through your
database migration workflow. It adds the `source_pdf` artifact type; the original
`source_docx` type remains for existing documents. The application code cannot
persist PDF artifacts until this migration has run.

For a local environment configured in `.env.local`, the migration command is:

```powershell
node --env-file=.env.local node_modules/drizzle-kit/bin.cjs migrate
```

This applies pending migrations to the database named by `DATABASE_URL`.
Use the intended development or deployment database. The migration is included
in the branch; it is not automatically applied by a Vercel build.

If the Supabase `documents` bucket restricts allowed MIME types, include
`application/pdf` in its allowlist. Keep the bucket private.

The upload limit is 4 MB per file to leave room below Vercel's 4.5 MB multipart
request limit. Larger uploads would require a separate direct-upload workflow.
The conversion route uses the Node runtime and a 300-second function duration.

Previously converted Word documents keep their saved HTML and can be deleted.
To convert one again, export the original from Word as a PDF and upload it as a
new document. Changing a filename extension from .docx to .pdf does not convert
the file. Exported PDF text and page images are sent directly to the configured
LiteLLM proxy; no local Word/LibreOffice service is required.

### Recovery point and preview deployment

The local tag `pre-pdf-2026-09-09` and the GitHub branch
`backup/pre-pdf-2026-09-09` preserve the original `main` commit
`630088808268f78c53d2f35ef141301e86490b86`. Deploy the PDF branch to a Vercel
Preview and test it before merging into the production branch. Preview needs
the app's database, storage, model, and email environment variables, with
`BETTER_AUTH_URL` set to the preview's origin. Deployed email delivery must use
`EMAIL_PROVIDER=resend`; console OTP delivery is available only in development.

If a code rollback is needed, redeploy the previous Vercel deployment or deploy
the GitHub backup branch. This does not roll back database state. The additive
`source_pdf` enum value can remain when running the original Word-based code;
PDF uploads created by the new code require the PDF-capable version to reconvert.
The recovery tag also predates the security fixes in this branch.

Secrets belong in ignored `.env` files or Vercel environment settings. Source
documents and generated test outputs must not be committed. Conversion sends
the source PDF to the configured LiteLLM provider, and production errors omit
provider response bodies and sign-in codes. The app displays generated HTML as
text; review downloaded HTML before opening it as a standalone page or
publishing it in Canvas.

### 3. Set up the database

Apply the committed migrations to your database:

```bash
npm run db:migrate
```

If you change `lib/db/schema.ts`, generate a new migration with
`npm run db:generate` before running `db:migrate` again. `npm run db:studio`
opens Drizzle Studio for browsing the database.

### 4. Run the app

```bash
npm run dev
```

The app will be available at [http://localhost:3000](http://localhost:3000).
Sign-in is restricted to `@osu.edu` email addresses. Note that a freshly
signed-up user has the `pending` role — to reach the dashboard, promote your
user to `instructor` or `admin` directly in the database (`users.role`, e.g.
via `npm run db:studio`), or have an existing admin approve you at `/admin`.

## Development Workflow

### Everyday commands

```bash
npm run dev        # Start the dev server
npm run build      # Production build
npm run lint       # ESLint
npm run typecheck  # TypeScript checks
npm run test       # Run the test suite (Vitest)
npm run test:watch # Vitest in watch mode
npm run format     # Format with Prettier
```

### Testing

Unit tests live in [test/](test/) and run with Vitest (`npm run test`).
Current coverage focuses on the pure/mockable core: the conversion pipeline
(`convert.test.ts`, with LiteLLM mocked), the LiteLLM client and cost
math (`litellm.test.ts`), admin metrics aggregation (`metrics-math.test.ts`),
and job-status mapping (`conversion-status.test.ts`). Tests use the same `@/`
path alias as the app (configured in `vitest.config.ts`).

### Testing the conversion pipeline from the CLI

On Windows, create a git-ignored `.env.local` file in the repository root with
`LITELLM_BASE_URL` and `LITELLM_API_KEY` copied from your own configuration.
`LITELLM_MODEL` is optional; the shared default is used when it is absent.
These commands load `.env.local` automatically:

```powershell
npm run check:model
npm run convert:local -- "C:\path\to\sample.pdf"
```

`check:model` sends one small real request through the same LiteLLM client
used by the app and reports the requested model, returned model, and token
usage. It requires no Supabase settings or sign-in. A successful check
confirms connection/model access; use `convert:local` with a sample document
to inspect conversion quality. That command prints HTML and findings in the
terminal and also runs without a database. Both commands incur model usage.
Neither writes to the application's database or storage.

To use the full browser app, also configure `DATABASE_URL`, `SUPABASE_URL`,
`SUPABASE_SERVICE_ROLE_KEY`, and `BETTER_AUTH_SECRET` in `.env.local`, set
`BETTER_AUTH_URL=http://localhost:3000`, and use `EMAIL_PROVIDER=console` to
print sign-in codes in the terminal. Then run `npm run dev` and open
`http://localhost:3000`. Use a development Supabase project for isolated
testing; pointing at production credentials uses production data and storage.

You can run the PDF → HTML pipeline standalone, without the web app, against
any local `.pdf` file (requires the LiteLLM env vars in `.env`):

```bash
# bash / Git Bash
set -a && source .env && set +a
npx tsx lib/convert.ts path/to/file.pdf
```

This prints the generated HTML and any accessibility findings to the terminal —
handy for iterating on the prompts in `lib/prompts/pdf-accessibility.ts`.

### Conventions

- Branch off `dev`; `main` is the release branch.
- UI primitives come from shadcn (`npx shadcn@latest add <name>` into
  `components/ui/`); app-specific composite components are hand-written in the
  same directory.
- Server-side authorization is centralized: gate pages/server actions with
  `verifyRoleOrRedirect(...)` and API routes with
  `verifyRoleOrUnauthorized(...)` from `lib/auth.ts` — never query on behalf of
  a user without one of these plus an ownership check.
