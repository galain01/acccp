# Local OCR experiment for native PDF repair

This experiment repairs missing or incorrect reading text in **reviewed,
text-only scans**. It preserves each original page image and adds real, tagged
Unicode text in an invisible text layer. It does not turn the page into an image
description or rebuild its visible layout. It is local research, with no app
integration or automatic accessibility claim.

## Supported source and review

The initial subset is deliberately small: unencrypted, unsigned PDFs under
4 MiB, with one to eight pages. Each page must contain one ordinary, unrotated
raster image covering the whole page. The parser accepts absent text or text
proved invisible by rendering mode 3. It rejects visible text, clipping text,
vector drawings, multiple images, forms, annotations, existing tag trees, special
graphics state, nondefault page crop/rotation, and unsupported operators. It does
not force-rasterize a document to make it fit this subset.

A full-page image could still contain a chart or photograph. Syntax cannot prove
that it contains only text. A separately saved review must therefore inspect
every source image and confirm text-only content, complete reading order, and
the exact words. Uncertain text, omitted OCR lines, diagrams, and tables block
this route. The final auditor must independently repeat those checks against
the saved output and original images.

The local OCR engine supplies candidate words, positions and confidence. A high
confidence score does not establish correctness. The reviewed plan may correct
a word only from the visible page. It cannot create an extra line with invented
coordinates, omit a recognized line, or approve unresolved content.

## Components

- `scan_ocr.py`: source preflight, local recognition, exact-source review binding,
  and the bounded tagged-text writer.
- `scan_ocr_worker.cjs`: Tesseract.js recognition with explicitly local worker,
  WebAssembly and language-data paths. It writes recognition evidence only.
- `scan_ocr_validation.py`: a separate saved-file parser and preservation wrapper.
- `ocr_evidence_preflight.py`: verifies source/render identity before a model call
  and produces fresh RGB PNGs containing only the rendered source pixels.
- `ocr-review.ts` and `ocr-review-contract.ts`: bounded source-image model review,
  exact line coverage, and local usage/cost evidence.
- `test_scan_ocr.py`: fictional source and tampering regressions, runnable with
  the standard-library `unittest` runner.

The writer removes only complete text objects whose text-show operations are
proved invisible. It retains the original raster payload, image matrix, other
page painting operations and resources. Reviewed text uses the existing pinned
Liberation Sans font with embedded glyphs and a Unicode map. H1–H6/P elements have
real marked-content IDs and ParentTree ownership. The original image is marked
as redundant only for a fully reviewed text-only page.

The independent checker verifies the saved candidate's original raster bytes,
page pixels, geometry, drawing operations and behavior. It checks the added font,
exact approved text, native tag ownership, and complete review coverage. It
decodes the saved review PNG and compares its RGB pixels with a fresh source PDF
render, so a hash of an unrelated image cannot authorize a repair. Generic
preservation checks remain unchanged; temporary projections remove only the
verified invisible-layer difference and new font resource for that comparison.

## Reproducible toolchain

The 2026-10-21 run found PDFium/Poppler available but no local Tesseract,
OCRmyPDF or Ghostscript executable. It installed these pinned packages in the
external directory `work/pdf-native-tools/ocr-node/`:

```text
npm install --prefix EXTERNAL_OCR_DIRECTORY --ignore-scripts --no-audit --no-fund --save-exact tesseract.js@7.0.0 @tesseract.js-data/eng@1.0.0
```

Tesseract.js-core resolved to 7.0.0. The package lock retains registry integrity
values. The local toolchain JSON pins the Node executable and the complete
installed module tree by SHA256; the recognition evidence also records the
worker script's hash. Language data uses the package's `4.0.0_best_int` English
model. Recognition runs with one worker, a 768 MB Node heap, a 120-second page
timeout, and 300 dpi source renders, limited to 20 million pixels per page.
Credential environment variables are not forwarded to the worker. Documents
are not sent to an OCR service. The separate model reviews use the existing
institutional LiteLLM configuration.

The choice follows the projects' primary documentation:
[Tesseract.js local paths](https://github.com/naptha/tesseract.js/blob/master/docs/local-installation.md),
[Tesseract.js API](https://github.com/naptha/tesseract.js/blob/master/docs/api.md),
and [OCRmyPDF's processing options](https://ocrmypdf.readthedocs.io/en/stable/cookbook.html).
OCRmyPDF distinguishes redoing invisible OCR from forcing page rasterization.
The bounded writer here avoids a forced rasterization step and retains explicit
control over the native tags and authorized text replacement.

## API and evidence

```python
inspection = inspect_scan(source)
evidence = recognize_scan(source, new_external_folder, toolchain)
ledger = repair_scan(source, new_candidate, reviewed_plan,
                     ocr_evidence_path, review_evidence_path,
                     font_directory=pinned_font_directory)
checks = compare_with_authorized_ocr(source, new_candidate, ledger)
```

After recognition, run the source-image review with the existing institutional
environment configuration and the local Python toolchain:

```text
node --conditions=react-server --env-file=.env.local --env-file=.env.sol61.local --import tsx research/native-pdf/ocr-review.ts SOURCE.pdf OCR_EVIDENCE.json NEW_EXTERNAL_REVIEW_DIRECTORY TOOLCHAIN.json
```

Use `source-review/reviewed-plan.json` and `source-review/review-evidence.json`
from that new directory in `repair_scan`; decode JSON explicitly as UTF-8.
Before sending anything, the runner checks every evidence image against a fresh
PDFium render of the supplied source. It uploads fresh RGB render files, so PNG
metadata, trailing bytes or transparency cannot change what is sent. Uploaded
OCR evidence is restricted to bounded line IDs, text, boxes and confidence.
Private model responses and call usage/cost records stay outside the repository.

The review plan binds the source hash, OCR-evidence hash, language, title, and
all pages. Each page contains explicit `textOnly`, `readingOrderConfirmed`, and
`textAccuracyConfirmed` approvals, an empty `unresolved` list, and ordered text
blocks. Every OCR line ID appears exactly once, with its reviewed text. Blocks
use H1–H6/P roles without skipped downward heading levels.

The saved review JSON contains `complete: true` and `reviewedPlan` equal to the
plan without its `reviewer` field. The plan's `reviewer.evidenceSha256` then binds
that saved review. File hashes are rechecked after independent validation.

`finalize_ocr_evaluation(..., evaluation_only=True)` is a separate, explicit
internal step. It verifies the initial candidate, runs the existing technical
repairs, stages the PDF/UA-1 identifier, and issues a final-file ledger only after
another independent check. A fresh veraPDF UA1 run and a complete source/output
semantic audit are still required. Ordinary `repair_scan` does not add a PDF/UA
declaration.

Run focused tests from the repository:

```text
python -m unittest discover -s research/native-pdf -p test_scan_ocr.py -v
```

## Current evidence and limits

Evidence remains outside Git in `outputs/native-pdf-ocr-2026-10-21/`. The three
initial cases are `scan-image-only`, `scan-ocr-correct`, and `scan-ocr-wrong`.
Their files include `ocr-evidence.json`, source-review evidence, immutable
`evaluation-candidate.pdf`, `evaluation-ledger.json`, `evaluation-checks.json`,
`verapdf-ua1.json`, and final audit reports supplied by the research runner.

All three preserve their original pixels and raster payloads and now expose the
correct four lines through H1/P tags. The deliberately incorrect hidden text
"Submit ten pages. Deadline December 30." becomes the visible text "Submit one
page. Deadline October 30." The saved candidates pass native inspection and
veraPDF UA1, and their fresh model audits report no remaining findings. These
three inputs share one visible page, so they mainly test missing/correct/incorrect
layer handling rather than broad OCR accuracy.

The external `dense-two-page-fixture/` adds two pages of fictional prose rendered
at 200 dpi, with dates, decimals, money, negation and accented words. Its reference
PDF and UTF-8 `ground-truth-utf8.json` provide known expected text;
`dense-two-page/` holds recognition and subsequent review evidence. All 50 saved
lines match that ground truth after whitespace normalization. Source-image review
corrected Tesseract's `naive` to the visible `naïve`. Both original pages and
raster payloads are unchanged, and native inspection plus veraPDF UA1 pass.
The fresh final-file audit also reports zero findings on both pages, and the
assessment records an automated pass with manual review still required.
The first `ground-truth.json` snapshot remains unchanged in its original Windows
CP1252 encoding; read the UTF-8 copy for reproduction.

`meaningful-chart/` is a negative classification test. Its real model review
identified the meaningful chart, and the writer refused the text-only plan
without creating a candidate. The focused suite currently contains 22 passing
saved-file, source-boundary, incomplete-review, stale-evidence, and output-tampering
tests. The separate validation agent also exercises independent adversarial cases.

Handwriting, complex page order, mathematical notation, multilingual scans,
mixed graphics and low-quality scans need additional handling and evidence.
Keyboard, selection and screen-reader behavior also need hands-on testing.
None of these local results makes the general native PDF feature ready for app
integration.
