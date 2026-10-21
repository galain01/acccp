# Native PDF hands-on review

The automated assessment checks the saved PDF, its preservation and its meaning.
This protocol checks whether a person can actually read and navigate it in a PDF
viewer with assistive technology. Start with the exact candidate hash in the
review pack. Keep the source, candidate and existing audit reports unchanged.

## What the test establishes

Record a result for each supported viewer/screen-reader combination. The results
describe that combination and the reviewed file. They do not establish every
PDF/UA requirement or make an untested conversion pipeline ready for deployment.
veraPDF explicitly limits its PDF/UA validation to machine-verifiable checks;
the Matterhorn Protocol also identifies human checkpoints.

- [veraPDF validation scope](https://docs.verapdf.org/validation/)
- [Matterhorn Protocol 1.1](https://pdfa.org/resource/the-matterhorn-protocol/)

## Prepare the session

1. Have someone comfortable using a screen reader perform the navigation tests.
   A second reviewer can compare the spoken content with the visible source.
2. Record the exact file hash, operating system, PDF viewer/version, screen
   reader/version, keyboard layout, voice/language and relevant reading settings.
3. Open the candidate as a local file in the chosen viewer. Check the document
   title and physical page count. Record any inferred-reading-order, OCR or
   automatic-tagging option; avoid letting it silently replace the saved tags.
4. Keep a dated observation log. For a problem, record the physical PDF page,
   nearby words, task, keystrokes, actual announcement and expected behavior.
   A speech log can help diagnose a failure but needs the reviewer to explain
   the task and context. Do not upload documents to an additional service.
5. Test the whole short sample once, then repeat the high-risk tasks below.
   Use a second viewer to investigate differences. An unavailable test stays
   `unable` or `not_run`, rather than being counted as a pass.

Windows Narrator can provide an initial local check. A fuller independent pass
can use NVDA with Acrobat/Reader; NVDA documents browse mode support for Adobe
Reader. Record the actual pairing and any unsupported commands. In NVDA browse
mode, H/T/K/G navigate headings/tables/links/graphics; Shift reverses direction.
Ctrl+Alt+arrow keys navigate table cells. NVDA+F7 opens the elements list, and
NVDA+Down Arrow (desktop layout) reads onward. Consult the current guide if the
installed layout differs. Acrobat's Read Out Loud can supplement listening, but
does not exercise the same heading/table/focus interactions as a screen reader.

- [NVDA user guide](https://download.nvaccess.org/documentation/userGuide.html)
- [Narrator scan mode](https://support.microsoft.com/en-us/accessibility/windows/narrator/chapter-3-using-scan-mode)

## Review tasks and pass criteria

| Task | A useful result | Failure example |
| --- | --- | --- |
| Read continuously through all pages | Columns, paragraphs, notes and descriptions form a comprehensible sequence; nothing meaningful disappears. | Reading alternates between unrelated columns or loses a continuation. |
| Navigate headings | The title, sections and description appendix are discoverable at sensible levels. | A heading is absent from navigation or a caption becomes an unrelated section. |
| Navigate both directions through tables | Each sampled value has the correct row/category and year/statistic context, including spanning and continued headers. | A percentage is announced without enough information to know what it measures. |
| Tab and activate links | Useful names, logical focus sequence, the intended target and a reliable return to the document. | A wrapped URL becomes repeated meaningless links or a report title opens the wrong report. |
| Operate forms and reopen a saved copy | Labels, required states, values and checkbox states are announced correctly; keyboard edits display and persist correctly. | An optional checkbox is required, focused text displays incorrect characters, or saved values disappear. |
| Understand figures | Original alternatives and detailed descriptions convey the figure's purpose and needed information, including limits and missing data. | A chart is called only “image”, or its description invents precise values. |
| Read lists and cross-page paragraphs | List items preserve their relationships; interrupted sentences continue correctly. | A staff member is associated with another person's role. |
| Inspect text and language | Names, symbols, replacement text and language are available accurately. | A minus sign or a meaningful character is lost; a real word acquires a space. |
| Compare excluded content | Only justified repeated/decorative content is omitted. | A table direction or footnote is excluded from reading. |
| Zoom and reflow; inspect color | Content remains usable in the intended viewing conditions; deficiencies and viewer limitations are recorded. | Text clips, overlaps, or an essential distinction relies only on indistinguishable colors. |

For tables, sample at least the first and last data rows, each distinct header
pattern, category boundaries, merged headers and both sides of every page break.
This is a usability sample; a specialist should decide the additional coverage
needed for a conformance evaluation. Inspect the entire logical table when a
sample reveals a problem. For meaningful sequence and focus, keep reading order
and Tab order as separate observations. W3C provides corresponding techniques
and test procedures for [sequence](https://www.w3.org/WAI/WCAG22/Techniques/pdf/PDF3),
[tables](https://www.w3.org/WAI/WCAG22/Techniques/pdf/PDF6) and
[image alternatives](https://www.w3.org/WAI/WCAG22/Techniques/pdf/PDF1).

## Review pack and evidence

Run with the research Python environment, without model calls:

```text
python research/native-pdf/manual_review.py candidate.pdf --sha256 EXACT_SHA256 --output local-review-pack.json
```

The pack contains the native logical sequence and properties reopened from the
exact file, including ordered child references, marked text, links, table
relationships, `Alt`, `ActualText` and excluded-content evidence. This makes a
reported failure traceable to a page and native tag. It is not a spoken transcript
or an inspection of the viewer's accessibility API. In particular, extracted
parent text may contain layout line breaks while child replacement text carries
the intended reading. The human test determines what the viewer exposes.

All checkpoints initially say `not_run`. Complete a separate copy of the pack
with `pass`, `fail`, `unable` or `not_applicable`, and an observation explaining
each result. A reason is required for `not_applicable`; absence of a native tag
alone does not prove that the source lacks that kind of content. An incomplete
or failed checkpoint remains unresolved. The optional record summarizer checks
file identity and checklist completeness; it cannot verify that a human actually
performed the test and never produces a conformance claim.

The document-specific packs and notes belong outside Git because they contain
document text and reviewer observations. No UI automation, OCR, retagging,
screen-reader installation or viewer preference changes are performed by this
helper.
