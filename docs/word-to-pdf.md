# Automatic Word-to-PDF conversion

The Word upload path renders a DOCX to PDF with a separate Gotenberg worker,
then sends that PDF through the existing model conversion and accessibility
audit. Direct PDF uploads continue to use the existing path. The renderer
needs no model, database, storage, or email credentials.

## Run the renderer locally

Install Docker Desktop with Linux containers and start it. The supplied
[Compose file](../compose.word-to-pdf.yml) pins
`gotenberg/gotenberg:8.36.0-libreoffice`. This variant contains LibreOffice
without Chromium. It runs as the image's non-root user, attached only to an
internal Docker network with no default route to the internet. A separate
Nginx proxy (pinned to version 1.30.4 and its image digest) binds only to
`127.0.0.1:3001`. It forwards health checks and the conversion route to the
worker, without receiving service credentials in its configuration. The proxy
runs as user 101 with a read-only filesystem and IP forwarding disabled.
Both containers drop Linux capabilities and limit CPU, memory, and temporary
file storage. This requires Docker Compose 2.33.1 or newer for `gw_priority`.
[Gotenberg installation](https://gotenberg.dev/docs/getting-started/installation),
[Docker network isolation](https://docs.docker.com/reference/compose-file/networks/#internal).

Create `.env.word-to-pdf` in the repository root with these three entries:

```dotenv
GOTENBERG_URL=http://127.0.0.1:3001
GOTENBERG_USERNAME=acccp
GOTENBERG_PASSWORD=
```

Fill the password with a new random value from your password manager. The
file is ignored by Git. The same username and password configure both the
app client and worker; they are separate from all existing API keys.

From the repository root, start the worker:

```powershell
docker compose --env-file .env.word-to-pdf -f compose.word-to-pdf.yml up -d
```

Then start the local app with the renderer settings loaded. Next.js also
loads the existing `.env.local` for the app's other services:

```powershell
node --env-file=.env.word-to-pdf node_modules/next/dist/bin/next dev
```

Open the local app, sign in, and use a new test session. Upload a small DOCX
and convert it. Open its result and compare the content, headings, tables,
links, and images with the source. A first test should use a synthetic document;
using production database settings makes the test session and results part of
that database. Existing records should not be used as test fixtures.

Stop this worker when finished:

```powershell
docker compose --env-file .env.word-to-pdf -f compose.word-to-pdf.yml down
```

The worker's settings are described in
[Gotenberg configuration](https://gotenberg.dev/docs/configuration). Its
60-second request timeout and two-request waiting queue bound work per
instance. LibreOffice handles one conversion at a time. More users may require
additional worker instances; increasing the queue alone increases waiting.

## Test without the app database

With the worker running, use the CLI to inspect a document without signing in
or writing app database/storage records. It loads `.env.local` first, then
`.env.word-to-pdf`. Both files must exist; `.env.local` can be empty for a
render-only test. Choose an output directory outside the Git repository.

```powershell
npm run convert:document -- "C:\path\to\sample.docx" "C:\path\to\word-test" --render-only
npm run convert:document -- "C:\path\to\sample.docx" "C:\path\to\word-test"
```

`--render-only` saves `rendered.pdf` without calling the model. Open that PDF
and compare its pages with Word first. The full command requires
`LITELLM_BASE_URL` and `LITELLM_API_KEY` in `.env.local`; it sends the rendered
PDF to the configured model and incurs normal model usage. On success it saves
`rendered.pdf`, `converted.html`, and `result.json` (model usage, accessibility
findings, and timing). Reusing an output directory overwrites these files.
PDF input is also accepted and bypasses the worker. These files may contain
document content and should remain outside source control.

## Deploy with Vercel Services

The included [vercel.json](../vercel.json) defines the Next.js `web` service
and a private `renderer` container service. Select **Services** as the Vercel
project's framework before deploying this configuration. Only `web` has a
public rewrite. Its binding injects `GOTENBERG_URL` at runtime for the renderer
in the same deployment; do not manually set that URL when using the binding.
Vercel handles the internal HTTPS connection and certificate trust.
[Services setup](https://vercel.com/docs/services),
[Binding transport](https://vercel.com/changelog/secure-internal-communication-between-services).

Set `GOTENBERG_USERNAME` and `GOTENBERG_PASSWORD` in each deployment environment
alongside the existing app environment variables. The app and renderer use
these credentials for Basic authentication. Keep the password in Vercel's
secret settings. Preview deployments need their own complete configuration,
including the correct `BETTER_AUTH_URL`.

The [renderer image](../services/renderer/Dockerfile.vercel) pins Gotenberg by
version and digest, runs as its non-root user, and serves Vercel's default
port 80. Startup honors an injected `PORT`; no project-wide port override is
needed for the documented default. Vercel builds the image and stores it in
its Container Registry. Container Images and Services are beta features
available on all plans. Compute, service requests, transfer, and image storage
have their own usage accounting; this configuration does not promise free
hosting. [Container deployment](https://vercel.com/docs/functions/container-images),
[Services pricing](https://vercel.com/docs/services/pricing),
[Registry pricing](https://vercel.com/docs/container-registry/limits-and-pricing).

The startup script clears inherited environment variables before launching
`tini`, Gotenberg, and LibreOffice. Only worker authentication, the selected
port, and fixed nonsecret renderer settings remain. This prevents the document
processor from inheriting the app's database, model, or email credentials.
It fixes `LOG_LEVEL=error` to suppress denied-source-URL warnings, disables
telemetry exports, downloads, and webhooks, and denies LibreOffice outbound
URLs through Gotenberg's filter.

That application filter is different from the local Compose worker's network
isolation. Vercel does not document an equivalent deny-all egress setting for
container services; Secure Compute and Static IPs are currently unsupported
for custom containers. Do not describe the hosted worker as having no network
egress. The local Compose worker retains its stronger isolated-network setup.
[Container limitations](https://vercel.com/docs/functions/container-images#limits-and-pricing).

### Alternative external worker

A separately hosted Linux worker remains an option. Keep its port private
behind an HTTPS gateway, require Basic authentication, and retain outbound
restrictions. For that topology, use a normal Next.js deployment without the
renderer service binding and set `GOTENBERG_URL` manually to the worker's HTTPS
origin, together with the same two credential variables. The local Compose
file alone is not a public hosting deployment.

The app sends one DOCX as the `files` multipart field to
`POST /forms/libreoffice/convert`, with Basic authentication in the HTTP header.
It receives PDF bytes, not a document URL. Multiple files in one worker request
would return a ZIP, so the app uses one document per request. Do not forward
user-supplied worker URLs or arbitrary form fields.
[Conversion API](https://gotenberg.dev/docs/convert-with-libreoffice/convert-to-pdf).

Keep DOCX uploads and generated PDFs within the app's 4 MiB limit. A small DOCX
can render into a larger PDF; such output must be rejected before the model
request. The worker's 5 MB body limit allows multipart overhead. Vercel's
request payload limit remains 4.5 MB, and the existing app allows 300 seconds
for the complete request. The renderer timeout uses part of that budget.
Vercel offers large functions up to 5 GB in beta; the historical 250 MB limit
is not a universal deployment barrier. New projects are eligible by default;
existing eligible projects can set `VERCEL_SUPPORT_LARGE_FUNCTIONS=1`.
[Vercel limits](https://vercel.com/docs/functions/limitations).

## Document handling and fidelity

Macros are disabled during rendering. Since Gotenberg 8.34, externally linked
images and `file://` resources are omitted even when conversion succeeds;
embedded images are retained. The Compose configuration also blocks remaining
LibreOffice outbound requests and disables remote downloads and webhooks.
Keep document assets embedded and review missing-content findings. Network
isolation is an additional boundary, not a replacement for the renderer's
document protections.
[Outbound controls](https://gotenberg.dev/docs/outbound-url-filtering).

LibreOffice can paginate or lay out complex Word documents differently,
especially when their fonts are unavailable. Compare the actual output before
relying on it. Use ordinary PDF output for this intermediate step; PDF/UA
post-processing does not repair the Word document's semantics, and LibreOffice
can rasterize colored table cells during PDF/A or PDF/UA reprocessing.
[Rendering limitations](https://gotenberg.dev/docs/troubleshooting#libreoffice).

The model still produces HTML and identifies accessibility issues. A successful
render does not mean all content survived unchanged or that the final HTML has
no accessibility findings. Successful Word conversions retain a manual-review
finding in the app and CLI results about missing linked content and possible
font/layout changes. Compare the result with the original Word document.
Conversion failures should report a safe summary;
raw worker responses and authorization headers should not be logged or shown.
