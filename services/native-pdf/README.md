# Native PDF worker

This private service supplies source-preserving PDF inspection and bounded
repairs for the app's `accessible_pdf` destination. See
[protocol.md](protocol.md) for request bodies and the actual supported edits.

The app supplies the model and independent semantic audit. This worker runs
OpenDataLoader PDF 2.5.14 only for untagged inputs, applies approved native tag
changes, compares saved output with the immutable original, and runs veraPDF
1.30.3 using its PDF/UA-1 profile. It does not call a model or hold application
storage credentials. For large repair requests, a separate bounded downloader
can read one short-lived signed object from the configured private Supabase
bucket. Existing tags, figure descriptions, reading replacements, interactive
values and original page layout are protected.

The reusable independent checker is copied explicitly from
`research/native-pdf/verify_pdf.py`. Its research-only source-hash exceptions
are disabled in the worker process. Fixture-specific repair plans, fonts,
OCR overlays and form rewrites are not imported into this service.

## Running locally

Use a trusted toolchain JSON with absolute paths for `openDataLoader` and
`veraPdf`; it is administrator configuration, never accepted in a request.
The repository's local research toolchain format supports these fields.
Install the pinned Python dependencies from `requirements.txt`. Set a random
`NATIVE_PDF_API_KEY` of at least 32 characters in the private local environment,
then run:

```text
python services/native-pdf/server.py --toolchain /absolute/toolchain.json --port 8891
```

The default bind address is loopback. Set the app's private `NATIVE_PDF_URL` to
`http://127.0.0.1:8891` and use the same key. Keep both in ignored environment
files. Local Windows uses process-group termination through the system
`taskkill` program on timeout; Linux also sets address-space, CPU, open-file,
output-file and core-dump limits. Neither mode claims to be an OS sandbox.

The production supervisor also receives the public `SUPABASE_URL` origin.
Only `/repair-stored` needs this setting. It accepts a small signed reference
when the complete repair JSON would exceed Vercel's request limit. The app
tracks the temporary object for cleanup and purge, then removes it after the
request. The worker permits only the configured HTTPS origin, the private
`documents` bucket and a UUID-scoped native repair filename; it rejects
redirects, encoded paths, extra query options and arbitrary URLs. Its separate
download process uses verified TLS, ignores proxies, checks actual byte count
and SHA256, and is terminated after 15 seconds. The download and PDF processing
share the overall 90-second deadline. The signed URL never reaches PDF tools.

## Container

The Dockerfile lives at the repository root because Vercel uses its containing
directory as the build context. A deny-by-default root
`.dockerignore` and explicit `COPY` paths exclude application secrets, source
documents, local binaries and test outputs. Build-time tool downloads have
pinned versions and SHA256 checks. Tools are never downloaded during document
processing. The image runs as an unprivileged user, and the startup script clears
shared project variables before starting the HTTP supervisor.

```text
docker build -f Dockerfile.native-pdf.vercel -t acccp-native-pdf .
```

Every image build runs `build-smoke.py` as the unprivileged application user.
It creates an untagged synthetic page, rejects unauthenticated requests, then
uses the real HTTP supervisor to tag and repair the page with the installed
tools and production child-process limits. The build fails if veraPDF cannot
finish, the native edit is missing, or the original text, content or page pixels
change. Its temporary document and randomly generated test key are discarded.

The Vercel service has no public rewrite. The web binding supplies its private
URL, and the shared worker key provides application authentication. There is
one active PDF job per service process and no durable queue. Saturation
returns a controlled busy response immediately.

Each request uses a fresh temporary directory and child process. Python and
Java receive clean runtime environments, without model/service-role credentials or
inherited runtime injection options. JVM scratch paths and working directories
are pinned to the request directory. Cleanup follows successful, failed and
timed-out jobs. Responses never contain native stderr or filesystem paths.

## Verification

```text
python -m unittest discover -s services/native-pdf -p "test_*.py"
```

The worker tests cover saved-file changes and pixel/content preservation,
authored alternatives, simple native table headers with paragraph children,
stale or arbitrary plans, source-bound snapshots, signed/active/XFA/embedded
files, precise form-control findings, complete validator evidence, and honest
evidence for pages without selectable text. HTTP tests exercise authentication,
ambiguous headers, input limits, capacity, subprocess credential isolation,
actual timeout cleanup and controlled failures.
Stored-transport tests also cover URL scope, verified TLS, redirects, bounded
reads, exact hashes, child credential isolation and download timeout cleanup.

On 2026-10-21 the local HTTP service successfully prepared and repaired the
synthetic workshop PDF with the real pinned Java tools. The output retained
identical page pixels and content. After missing title/language repair, its
remaining PDF/UA-1 failure was the deliberately absent conformance declaration.
This records measured local runtime behavior, not a conformance certificate.
The Vercel Linux container build also passed the authenticated prepare/repair
smoke test on 2026-10-21, including both installed Java tools, the unprivileged
application user and production process limits. The hosted app flow remains a
separate release check.
