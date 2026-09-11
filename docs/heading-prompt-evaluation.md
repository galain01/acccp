# Heading prompt evaluation — September 11, 2026

Historical prompt-only experiment; see [the subsequent visual-input implementation](pdf-visual-audit.md).
At the end of this experiment, the candidate was not deployed or ready for production. The prompt-only
candidate did not improve the known failures through the current PDF input path.
Supplying rendered page images produced promising conversion results, but the
audit remained inconsistent. Do not merge this candidate as a proven fix.

## Candidate

Based on production commit `2afe97012f45d615c76e7c8e07979a803fac0fe5`.
Branch: `codex/heading-relationship-prompts`.

- Conversion first establishes each source heading occurrence's parent and rank,
  including repeated labels and relationships continuing across pages.
- A paired example distinguishes a subsection from a legitimate peer section.
- The fallback no longer explicitly favors the shallowest hierarchy. Genuine
  ambiguity still requires a located review marker.
- The audit independently compares source relationships with HTML, including
  flattened subsections whose HTML contains no skipped heading levels.

Faculty-facing language, source locations, output contracts, source instruction
boundaries, model selection, API transport, storage, and retention are unchanged.

## Method

Prompt comparisons used `gpt-5.6-sol-2026-07-09` through the app's configured gateway and shared
`callLiteLLM` client, without changing model parameters. Baseline prompts were
copied before editing. The candidate was frozen before evaluations.
Audit comparisons used fixed HTML, not separately generated conversions, so
different conversion output could not explain audit differences.

An independent reviewer graded source relationships and locations against
visually inspected synthetic PDFs. The additional holdout was authored separately
from the candidate prompt. The application database and document storage were
not used for these tests. Raw test artifacts remain outside the Git repository.

The five-page known fixture contains three predefined flattened relationships:

- Physical page 3: “Observation prompt” belongs under “Field notes.”
- Physical page 5: “Equipment notes” belongs under “Resources.”
- Physical page 5: “Code example” belongs under “Resources.”

The three-page holdout includes numbered sections, deeper nesting, repeated
heading labels, legitimate peers, inline bold labels, and a continuation across
a page boundary. It has a correctly nested version and a version with three
deliberate flattening errors. Both HTML versions also contain an H1, which is a
separate legitimate Canvas warning and is not counted as a false relationship
finding.

## Results

Counts below are target relationships across repeated runs, not independent
documents or estimates of general accuracy.

| Test                                                 | Repetitions per prompt |                      Baseline |                     Candidate |
| ---------------------------------------------------- | ---------------------: | ----------------------------: | ----------------------------: |
| Known fixture audit, original PDF only               |                      3 |                  0/9 detected |                  0/9 detected |
| Known fixture conversion, original PDF only          |                      2 |                 0/6 preserved |                 0/6 preserved |
| Holdout audit, three deliberately flattened headings |                      2 |                  6/6 detected |                  6/6 detected |
| Holdout audit, correct heading relationships         |                      2 | 0 false relationship findings | 0 false relationship findings |
| Known fixture audit, PDF plus five page images       |                      2 |                  0/6 detected |                  3/6 detected |
| Known fixture conversion, PDF plus five page images  |                      2 |                 2/6 preserved |                 6/6 preserved |

All detected holdout relationships had the correct source page and parent.
The image-assisted candidate audit caught all three known errors in its first
run and none in its second, despite identical inputs. It detected the known loss
of bold emphasis in both runs; the baseline missed that loss in both image runs.
No false heading-relationship findings were observed in these audit comparisons.

With page images supplied, both candidate conversions preserved all three target
relationships. Baseline conversions preserved zero and two respectively. All
four preserved the emphasized instruction, code newlines, and substantive
wording; all merged the repeated “Field notes” labels into one heading. That
interpretive continuation decision is recorded separately from the three targets.
This small, known-fixture sample is promising but is not a general accuracy claim.

Additional limitations: one candidate PDF-only conversion changed a source
sentence without support. All PDF-only conversions lost the emphasized
water-temperature instruction. Image-assisted audits classified unresolved
source links as errors; their classification warrants separate review because
the actual destinations were unavailable. These observations do not establish
that the prompt edit caused each difference.

## Visual input diagnostic

A three-page synthetic probe contains only colored vector shapes, no text or
descriptive metadata. A matched PDF embeds the exact rendered PNG pixels on
each page. Direct PNG input uses those same images in page order. All use the
same model and gateway; the diagnostic prompt does not disclose expected shapes,
colors, or counts.

| Input representation                                               | Pages described correctly | Reported input tokens |
| ------------------------------------------------------------------ | ------------------------: | --------------------: |
| Original vector PDF via Chat Completions                           |                       0/3 |                   125 |
| Matched raster-image PDF via Chat Completions                      |                       3/3 |                 2,928 |
| Direct PNG image parts via Chat Completions                        |                       3/3 |                 2,331 |
| Original vector PDF via Responses with `input_file.detail: "high"` |                       0/3 |                   135 |

An earlier vector-PDF call with slightly different wording also scored 0/3.
The unsuccessful calls explicitly reported inaccessible page images. The
Responses diagnostic returned HTTP 200 but did not restore visual access.
It used a separate request runner with `store: false` and
`max_output_tokens: 4096`; it was not an application transport change or part of
the fixed-parameter prompt comparisons.

This is evidence of an input-representation problem, not proof of which layer
is responsible. It is consistent with embedded raster images reaching the model
while complete vector page rendering does not. The tests do not reveal the
gateway's internal configuration or establish that every PDF loses visual data.
Model self-reports alone are not treated as proof; the matched visual controls
and reported token differences support the finding.

The diagnostics follow the documented
[Chat Completions image format](https://developers.openai.com/api/docs/guides/images-vision),
[Responses PDF detail parameter](https://developers.openai.com/api/docs/guides/file-inputs#pdf-detail-levels),
and [LiteLLM PDF file-input format](https://docs.litellm.ai/docs/completion/document_understanding).
Documented interface support does not verify this gateway's actual processing.

## Release decision and next work

Keep this candidate off production. Prompt-only tests did not resolve the target
problem, and a single successful image-assisted audit is not sufficient evidence
of reliability.

The next experiment should guarantee complete page visuals reach both stages,
then require an explicit comparison of source parents with HTML parents. Test
that combination against correct hierarchies as well as deliberately flattened
and incorrectly nested headings. Include additional unnumbered documents that
were not used to design these prompts. Page rendering must retain the existing
document privacy, size/time bounds, and deletion behavior; direct image tests
here do not constitute an implemented production rendering pipeline.

Engineering checks for the prompt candidate: 634 tests across 32 files passed;
the production build passed; changed prompt files passed lint and formatting
checks. These verify software compatibility, not model quality. A repository,
history, and built-browser-asset secret scan found no credentials or document
artifacts to publish.

Local evidence is saved in the workspace's `outputs/heading-eval/` directory:
raw results, independent grades, synthetic source documents, and rendered pages.
Frozen baseline prompts and runners are under `work/heading-eval/`. None of the
raw response or document files are part of this branch. The 31 diagnostic and
evaluation calls reported a combined model cost of approximately $1.78; caching
and output length varied, so this is not a production per-document estimate.
