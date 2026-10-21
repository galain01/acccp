# Native PDF worker

This private service supplies source-preserving PDF inspection and bounded
repairs for the app's `accessible_pdf` destination. See
[protocol.md](protocol.md) for request bodies and the actual supported edits.

The app supplies the model and independent semantic audit. This worker runs
OpenDataLoader PDF 2.5.14 only for untagged inputs, applies approved native tag
changes, compares saved output with the immutable original, and runs veraPDF
1.30.3 using its PDF/UA-1 profile. It does not call a model, fetch document URLs
or access application storage. Existing tags, figure descriptions, reading
replacements, interactive values and original page layout are protected.

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

## Container

The Docker build context is the repository root. A deny-by-default root
`.dockerignore` and explicit `COPY` paths exclude application secrets, source
documents, local binaries and test outputs. Build-time tool downloads have
pinned versions and SHA256 checks. Runtime document processing downloads
nothing. The image runs as an unprivileged user, and the startup script clears
shared project variables before starting the HTTP supervisor.

```text
docker build -f services/native-pdf/Dockerfile.vercel -t acccp-native-pdf .
```

The Vercel service has no public rewrite. The web binding supplies its private
URL, and the shared worker key provides application authentication. There is
one active PDF job per service process and no durable queue. Saturation
returns a controlled busy response immediately.

Each request uses a fresh temporary directory and child process. Python and
Java receive clean runtime environments, without model/storage credentials or
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

On 2026-10-21 the local HTTP service successfully prepared and repaired the
synthetic workshop PDF with the real pinned Java tools. The output retained
identical page pixels and content. After missing title/language repair, its
remaining PDF/UA-1 failure was the deliberately absent conformance declaration.
This records measured local runtime behavior, not a conformance certificate.
The container build could not be tested in that session because the local
Docker daemon was unavailable; a container build and hosted smoke test remain
release checks.
