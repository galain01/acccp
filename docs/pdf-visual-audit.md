# PDF visual input and heading review

The gateway's original PDF-only input did not reliably expose vector page graphics
to the configured model in testing. The application now renders all physical PDF
pages itself and attaches each as a high-detail PNG, with an explicit page label,
alongside the original PDF. Both model stages receive the same complete set of
images. Rendering happens once per conversion. A rendering failure stops before
either model call; there is no silent text-only fallback.

## Information flow

1. Word uploads still pass through the configured private Gotenberg/LibreOffice
   service. Direct PDF uploads enter at the next step.
2. The Node web service passes PDF bytes over stdin to a fixed local child process.
   PDF.js and a native canvas library render pages in memory. No new external
   rendering service is contacted, and no temporary document files are written.
3. Original PDF bytes and page PNGs go to the existing configured LiteLLM gateway
   for conversion, then again for audit. This does not add a new model provider.
4. The audit receives heading occurrence IDs and text. Original heading levels and
   converter comments are withheld to reduce copying of the converter's choices.
   It returns a source outline plus other findings. The application validates
   coverage and compares source parents with measured HTML parents. Exact source
   offsets recover original HTML excerpts where masking changed the audit input.
5. Page PNGs, extracted page text, and the source outline are request-local. They
   are not added to storage, database records, or permanent metrics. Original
   documents, converted PDF/HTML, and resulting findings retain the existing
   ownership checks and 14-day deletion policy. Downloaded local copies remain
   under the user's control. Provider-side retention is unchanged by this code.

The renderer child receives no application credentials. Node permission flags
restrict filesystem access to fixed runtime assets; uploaded bytes never become
command arguments or executable code. These controls and process isolation are
not an operating-system sandbox or a hard native-memory limit.

## Bounds and deployment

Uploads remain limited to 4 MiB. The renderer permits up to 60 pages, 30 seconds,
2 million pixels per page (120 million total), 4096 pixels per page dimension,
8 MiB PNG per page and 24 MiB total PNG data. Before image decoding, a preflight
inspects up to 100,000 PDF objects, including unreferenced image streams and nested
soft/explicit masks. Declared images and masks are limited to 8 million pixels and
8192 pixels per dimension; combined base/mask dimensions must also fit. The sum
of those declared image areas is limited to 32 million pixels across the document.
Inline images retain PDF.js's per-image check; these guards are not a total native
memory cap. Repeated indirect-object definitions are rejected to prevent the
preflight and renderer from choosing different versions of an image or mask.
This excludes some valid incrementally saved PDFs; the error asks for a freshly
exported PDF. Output is bounded and stderr is capped at 16 KiB; failures discard
partial output and use a safe
faculty-facing message. Optional page text is capped at 100,000 characters per
page and 500,000 total; unavailable text remains unknown rather than truncated
evidence. Rendering warnings fail the operation to avoid silently omitted images.

Node 24 is required. `next.config.ts` explicitly traces the child script, PDF.js
worker, CMaps, fonts, WASM assets, and the platform's native canvas library into
`/api/convert`. Every production build runs `scripts/check-pdf-renderer.mjs`, which
copies only traced rendering assets into a fresh temporary directory, renders
three synthetic PDF pages there, and verifies text, order and vector pixels. This
exercises the build platform's native library and permission configuration. A
Windows pass does not establish Linux compatibility: require the Vercel Linux
build check, then verify an authenticated conversion in the deployed function.
No new environment variables or database migration are required.

## What the audit can establish

The validated contract requires all physical pages and HTML heading occurrences
to be accounted for. Invalid or incomplete evidence retains useful findings and
adds a review warning. H1, empty-heading, and level-skip checks use the real HTML.
Page text, when available, checks that claimed heading wording exists on that page.
It cannot distinguish identical repeated text by itself, or prove a semantic parent.

Parent comparisons are deterministic once a valid source outline is available.
The outline remains a model judgment: complete coverage is not proof of correct
interpretation or full accessibility. Ambiguous/missing mappings receive plain
language review warnings with supported locations. The audit reports problems;
it does not automatically repair the generated HTML.

## Evaluation record

The earlier [prompt-only experiment](heading-prompt-evaluation.md) is historical.
It did not fix the missing visual input. The new input path passed a three-page
vector-only shape/color/count probe. Before the final root-convention clarification,
three repeated production audits found all three predefined flattened children in
the five-page synthetic fixture (9 of 9), with correct physical pages.

A subsequent conversion exposed a fourth, subtler error: a smaller “Field notes”
heading on page 2 was flattened, while a separate main section with the same name
on page 3 was correct. After clarifying title/root conventions, the audit found
this error in two of three repeated runs, with no false heading errors in those
runs. This remaining miss is a reason to retain human review, not to label the
audit infallible. In two later runs on the original flawed HTML, both Resources
children were reported as relationship errors, while Observation prompt received
a located uncertainty warning because the repeated Field notes parent could not
be mapped reliably. Both runs also identified the lost emphasized instruction.

A separately authored three-page holdout contains 15 unnumbered headings, repeated
labels, nested children, genuine peers, inline bold text, and a page-break
continuation. Two runs on its defective HTML identified all three seeded problems
with the correct parents and pages (6 of 6), with no extra findings. Two repeats
on its correct HTML under the final heading instructions produced no findings,
with complete page/heading coverage. These are small synthetic evaluations, not
an estimated production accuracy rate.

The final local conversion-plus-audit run completed in about 60 seconds using
23,140 tokens. It preserved distinct link occurrences while combining each
matching source/audit notice, and classified unavailable addresses as review
warnings. Repeated-heading uncertainty remained visible to the instructor.

Raw test documents, model responses, page images, and costs remain outside Git.
