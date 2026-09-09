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

## Deploy alongside Vercel

Provision the same pinned image on a Linux container host. Put an HTTPS gateway
in front of its private port, retain authentication and outbound restrictions,
and permit only the required conversion route and health checks. The local
Compose file is not a public hosting deployment. In Vercel, set:

| Variable             | Purpose                                            |
| -------------------- | -------------------------------------------------- |
| `GOTENBERG_URL`      | The worker's HTTPS origin; no embedded credentials |
| `GOTENBERG_USERNAME` | Worker Basic authentication username               |
| `GOTENBERG_PASSWORD` | Worker password, stored as a Vercel Secret         |

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
Vercel now offers 5 GB large functions in beta; a separate worker is an
operational choice that avoids bundling and supervising LibreOffice inside the
Next.js function, rather than a claim that every Vercel function has a 250 MB
limit. [Vercel limits](https://vercel.com/docs/functions/limitations).

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
