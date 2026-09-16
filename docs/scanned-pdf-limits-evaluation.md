# Scanned PDF image-limit evaluation

Evaluated September 16, 2026. The previous renderer rejected small compressed
PDFs containing 3600 x 5600 full-page scans before making any model call. Each
scan has 20.16 million source pixels, above the former 8-million-image limit.
An 18-page example also exceeded the former 32-million-document limit even
though its pages render sequentially.

## Change

The candidate permits 24 million pixels per source image, 32 million declared
image pixels per page's resource graph, and 480 million declared image pixels
per document. The axis, output-resolution, PNG-size, upload-size, page-count,
JavaScript heap and worker-time limits remain unchanged. Per-page inspection
includes masks, inherited resources, forms, patterns, Type3 fonts, graphics-state
resources and annotation appearances. The original PDF is not resampled.

One renderer runs per Node process, with four FIFO waiting slots and a separate
30-second admission deadline. The worker retains its 30-second deadline after
admission. Queue failures use a safe busy message; the slot is not released
until the child closes. These controls bound admission and concurrent workers;
they are not an operating-system native-memory limit. Inline-image aggregates
are not dictionary resources and retain the per-image check and process deadline.

## Local checks

- The supplied two-page and eighteen-page scanned PDFs both pass the real
  application parent/child path.
- All 931 tests passed, including 55 real-renderer/protocol tests. TypeScript and
  the production build passed. ESLint passes on changed code. Repository-wide lint
  still reports existing errors in unrelated UI/hooks and test files.
- Fifteen synthetic cases cover bilevel, grayscale and color scans, mixed
  vector/text/images, transparency masks and resource-budget boundaries.
  Six rendered successfully and six deliberately oversized cases were rejected.
  Three longer color/grayscale cases hit the unchanged 30-second deadline.
- Local successful cases peaked at approximately 346 MiB worker working set
  and 393 MiB observed private memory. These are child-only Windows measurements.
- Visual checks against Poppler covered tables, colored graphics, transparency,
  footnotes and dense page text. All eighteen supplied article page PNGs are
  byte-for-byte unchanged from the earlier experimental render.

## Vercel Linux runtime

The ordinary application preview fails at build time because the project has
no preview environment variables (`DATABASE_URL` is the first missing variable).
Production configuration was not copied into the preview.

A separate, temporary preview uses the exact candidate renderer and queue code
from `3b47fbe`, the same Next.js/native dependencies and traced runtime files,
with no database, storage, email or model connection. Its private measurement
endpoint requires a random bearer credential and expires after 24 hours. The
credential is not committed; only its hash and expiry are in the separate
benchmark branch. This benchmark branch must not be merged into the application.
After testing, the temporary deployment and its remote benchmark branch were
deleted. The local benchmark source and measurements remain available.

The Linux build passed its traced-assets check: three tagged vector pages and
eighteen distinct 20.16-million-pixel scanned pages, including actual decoded
pixels, text, page order and authored image-description locations.

| Deployed function case | Result | Elapsed time | Peak observed parent + renderer RSS |
|---|---|---:|---:|
| Supplied 18-page scan, one call | All 18 pages | 10.5 s | 430 MiB |
| Three simultaneous calls with that scan | All three completed, one child at a time | 10.2 / 20.2 / 30.5 s including queue time | 505 MiB |
| Six-page high-resolution JPEG color scan | All 6 pages | 23.4 s | 391 MiB |
| Two-page 20.16 MP grayscale scan | Both pages | 24.4 s | 510 MiB |
| Three-page transparency-mask document | All 3 pages | 2.4 s | 456 MiB |
| Two 18 MP images on one page | Correct `pdf_image_limit` rejection | 0.2 s | 232 MiB |
| Eighteen-page high-resolution JPEG color scan | Correct `pdf_timeout` stop | 30.0 s | 423 MiB |

All eighteen PNGs from the supplied scan are byte-for-byte identical across
Windows and deployed Linux. The simultaneous-call test observed at most one
renderer child. A request without the benchmark credential returns 401.
Three separate simultaneous HTTP requests also completed successfully in
10.1-10.8 seconds each, with at most one observed renderer per Node instance
and 431-509 MiB peak sampled parent-plus-child RSS. This run spread the work
across concurrent invocations. The single-invocation test above establishes
queue serialization; the HTTP test checks simultaneous incoming requests.

Runtime measurements sample Linux process RSS, including the Next.js parent
and renderer, and read child high-water marks. They exclude platform overhead
and model-request memory. Three rendering calls were launched concurrently in
one function invocation to exercise the shared process queue, followed by the
separate HTTP-request check above. They do not estimate whole-site capacity or
end-to-end conversion/audit latency. No model
calls, database records or stored documents were created by the hosted tests.

## Release scope

This fixes image-admission failures for the tested high-resolution scans without
changing their model input or rendering resolution. Computationally demanding
documents can still reach the existing time/output limits. No migration or new
production environment variable is required. The feature remains on its branch;
production has not been updated. Raw PDFs, page images, credentials and numeric
benchmark records remain outside Git.
