# Broader native PDF tests

The local matrix on 2026-10-21 evaluated nine PDFs totaling 15 pages. It tested
the current OpenDataLoader tagging path, independent preservation checks and
veraPDF UA1 validation. It did not run model audits, keyboard or screen-reader
tests, deploy changes, or establish PDF/UA conformance.

The toolchain used OpenDataLoader 2.5.14 with `--hybrid off --threads 1
--image-output off`, a 768 MB Java heap, and veraPDF 1.30.3. OCR was not enabled.
New fixtures contain fictional content and remain outside Git.

## Preservation results

All nine candidates retained identical original page pixels, normalized drawing
operations, extracted text and resources. Source file hashes remained unchanged.
Preserving existing extracted text includes preserving any errors already in an
OCR layer; this measurement does not establish that the reading text is correct.

| Input | Pages | Raw output: failed UA1 checks | Additional observation |
| --- | ---: | ---: | --- |
| Field methods | 5 | 79 | Existing synthetic benchmark; excluded text still needs semantic review |
| Workshop | 3 | 64 | Existing synthetic benchmark; excluded text still needs semantic review |
| Selectable-text scan reference | 1 | 6 | Embedded font and ordinary selectable text |
| Image-only scan | 1 | 3 | No readable native text was created |
| Scan with correct hidden OCR | 1 | 7 | Existing OCR text retained |
| Scan with deliberately incorrect hidden OCR | 1 | 7 | Incorrect reading text retained |
| Interactive registration form | 1 | 18 | All three fields, flags, values and authored tooltips retained |
| Registration form with an unsigned XFA packet | 1 | 18 | XFA payload and AcroForm fallback retained |
| Blank page | 1 | 2 | Output has a Document-only tag tree |

Failed check counts are diagnostic instances, not quality scores. The evaluator's
`evaluated` status means the checks completed, not that the candidate passed.

The registration form was filled in separate copies of both the original and
tagged PDFs. The text field, choice field and checkbox retained the requested
canonical values, matching widget values and nonempty appearances. Neither copy
lost a field or became flattened. Their filled renderings were identical and
visually checked. This establishes saved form data and programmatic editability;
interactive keyboard and screen-reader usability remain untested.

## Accessibility findings

- **Image-only scans need OCR.** The output is one Figure with the placeholder
  alternative `image 1`. There is no readable native page text. The independent
  placeholder check correctly rejects this result.
- **OCR correctness needs a separate check.** The visible fixture says
  "Submit one page. Deadline October 30." Its deliberately incorrect hidden
  layer says "Submit ten pages. Deadline December 30." The engine retains that
  incorrect text. Both correct and incorrect OCR cases receive the same machine
  findings, including the page-image placeholder. A future OCR workflow must
  compare reading text with the visible document.
- **Form descriptions are still placeholders.** Although authored field tooltips
  survive, all three generated Form alternatives and annotation descriptions say
  `Annotation`. Those placeholders remain blockers. Form label relationships,
  logical order and keyboard operation require dedicated validation.
- **Unsigned XFA is not excluded.** The fixture's packet is retained and its
  AcroForm fallback remains available. This does not demonstrate support for
  dynamic XFA layout, scripting or behavior in an XFA-capable viewer.
- **Blank documents lack a distinct no-content outcome.** A blank input is
  processed normally. Its general structure inspection can pass after language
  metadata is supplied, while the absent authored title remains unresolved.
  A product workflow should explain that there is no content to repair.

Seven additional candidates used the existing metadata and technical helpers,
with explicitly supplied English language. No PDF/UA declaration was added.
Scans still failed the independent placeholder check after metadata repair;
forms still had placeholder labels and two unembedded fonts. The selectable-text
reference passed independent inspection but still lacked a conformance
declaration and a complete semantic audit. Metadata changes alone did not produce
an approved accessible result.

## Input boundaries and batch behavior

The current local evaluator rejects encrypted files, signature fields, the signed
W-9 fixture, malformed PDFs, files over 4 MiB and files over 60 pages. All six
rejection tests stopped before creating an output directory and left their
sources unchanged. Each returned exit code 2 and the same generic message about
input paths, the output folder and toolchain configuration; the actual rejection
reason is not exposed.

Preflight applies to the whole batch before any document runs. A batch containing
a valid workshop and the signed W-9 rejected both as a batch: the workshop was not
evaluated and no per-document summary was written. The runner also requires a
new output directory outside the repository, accepts at most 20 distinct input
paths, and limits each tagging or validation subprocess to 120 seconds.

## Evidence and reproduction

Evidence is stored outside Git under the workspace-relative directory
`outputs/native-pdf-matrix-2026-10-21/`:

- `matrix-report.json`: consolidated results, source hashes and unresolved gaps.
- `fixture-manifest.json`: fictional fixture identities and expected visible text.
- `default/summary.json` and `default/document-*/`: raw tagging candidates,
  independent checks and complete UA1 reports.
- `metadata-only/summary.json` and its document folders: metadata/technical
  candidates and fresh validation reports.
- `form-usability-results.json`, `form-fill-checks/` and `scan-preview.png`:
  form-value, widget and visual evidence.
- `preflight-results.json` and `mixed-batch-rejection.json`: rejection behavior.
- `toolchain.json`: local executable paths and bounded Java configuration.

Local fixture/run scripts remain under `work/pdf-native-tools/`:
`build_matrix_fixtures.py`, `run_matrix_preflight.py`, `check_matrix_forms.py` and
`check_matrix_metadata.py`. Their local destination settings must be changed to
a fresh directory before repeating the experiment. Generated PDFs and reports are not
repository fixtures.

From the repository, repeat tagging with the existing immutable input files and
a new output directory:

```text
python research/native-pdf/evaluate.py --toolchain TOOLCHAIN.json --output NEW_OUTPUT_DIRECTORY INPUT_1.pdf INPUT_2.pdf
python research/native-pdf/verify_pdf.py ORIGINAL.pdf CANDIDATE.pdf --report NEW_REPORT.json
python research/native-pdf/repair_metadata.py TAGGED.pdf NEW_METADATA.pdf --language en-US
python research/native-pdf/conformance_repairs.py NEW_METADATA.pdf NEW_TECHNICAL.pdf
```

Use the external manifest and summary to select the exact matrix inputs. Rerun
independent and UA1 checks on every changed candidate. No test authorizes
reusing a semantic audit for a different file hash.

## Follow-up priorities

1. Define explicit routes for image-only scans, existing OCR, unsigned XFA and
   empty inputs. Keep unsupported cases clearly identified before app integration.
2. Add OCR accuracy evaluation and repair of verified form labels, followed by
   hands-on keyboard and screen-reader checks.
3. Report specific preflight reasons and isolate failures per document in batch
   runs, while retaining the current source-preservation boundaries.
4. Continue broader semantic audits only after these candidate-specific blockers
   are addressed. Preserve the existing conformance and exact-file evidence gates.
