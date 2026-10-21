# Native PDF repair research

This is a local experiment on `feature/native-pdf-repair`. It does not add a
selectable PDF output to the app, change the database, or deploy a service.
The user chose open-source components only and preservation of the original
page layout. Documents, model responses, generated PDFs, binaries and credentials
stay outside Git.

## Engine decision

Use **OpenDataLoader PDF 2.5.14** as the native tagging foundation, rather than
building another tag writer from scratch. Its Apache-2.0 implementation writes
real marked-content IDs, structure elements and parent-tree associations into
the source PDF. It does not rebuild the document from HTML.

- Pinned upstream tag: [v2.5.14](https://github.com/opendataloader-project/opendataloader-pdf/tree/v2.5.14)
- Source commit: `215e80f11b23ac55feb8a91a754244ad78dc3069`
- Bundled CLI SHA256: `e08c0921fea8a141be96c31096e31251539f23ab4d9eeb88a8cce8f128cb2143`
- Upstream's free output is **Tagged PDF**. Its PDF/UA export and visual editor
  are separate enterprise offerings. This experiment uses neither paid feature.
- Independent validator: veraPDF 1.30.3, explicitly selecting `ua1`.
- Independent visual/content comparison: pypdf and PDFium, alongside the app's
  existing PDF.js page renderer for model input.

The initial runs use `--hybrid off --threads 1 --image-output off`, no sanitizer,
and upstream default content filters. Core tagging is local. The optional
semantic audit sends document evidence to the already-configured institutional
LiteLLM endpoint; it does not introduce another model provider.

## Initial evaluation on 2026-10-21

Six synthetic/public benchmark PDFs, totaling **24 pages**, retained identical
PDFium pixels, extracted text, normalized drawing operations, fonts and image
payloads after default tagging. For the form sample, measured field values,
types, flags and actions also remained unchanged. These are preservation
measurements, not an overall accessibility result.

| Fixture | Pages | Failed veraPDF UA1 checks: source -> default output |
| --- | ---: | ---: |
| Authored alternatives | 1 | 4 -> 4 |
| Field methods | 5 | 176 -> 79 |
| W-9 form | 6 | 26 -> 2 |
| Eight-page CDC report | 8 | 169 -> 1 |
| One-page CDC figure | 1 | 16 -> 1 |
| Workshop | 3 | 126 -> 64 |

These are failed check instances, not weighted quality scores. Missing language
can create many repeated failures. The CDC outputs' sole reported UA failure was
a missing conformance declaration, even though meaningful image alternatives
were lost. Adding a declaration would not repair that loss.

Concrete gaps found by independent inspection and upstream source review:

1. Default retagging lost or replaced existing Figure descriptions in all three
   fixtures that contained them. Generic `image 1` alternatives are not useful
   descriptions and must never count as repaired.
2. `--use-struct-tree` preserved both descriptions on the same raster image
   occurrences in the synthetic fixture. It still removed all four vector
   Figure tags/descriptions across the two CDC documents. Count alternatives
   on the same figures, not total `/Alt` strings: added link descriptions can
   increase that total while figures lose their descriptions.
3. The writer can mark text/graphics as Artifact, excluding them from ordinary
   reading. Page appearance alone cannot establish whether this is appropriate.
4. Language/title metadata, font embedding and some form-font Unicode mapping
   remain separate repair concerns. W-9 also contains XFA and a usage-rights
   signature; the repeatable runner now excludes signed PDFs from rewriting.
5. The semantic auditor found a caption/instruction incorrectly tagged as H3.
   It must inspect the actual saved tags, since the writer normalizes headings.

The local `repair_metadata.py` experiment adds missing language from an explicit
caller-supplied value, displays an existing title, and creates absent XMP
title/language metadata. It retains existing language/XMP, never fabricates a
title, and never adds a PDF/UA claim. On the workshop sample this reduced UA1
failures from 64 to 3, with identical pages and zero findings in the subsequent
model audit. Two unembedded fonts and the absent conformance declaration remain;
the candidate is still not declared conformant.

## Preservation and conformance follow-up

The explicit target is **PDF/UA-1, ISO 14289-1:2014**. The fresh assessment gate
runs veraPDF's `ua1` profile against the actual candidate, independent content
and layout checks, and a semantic audit bound to the original/candidate hashes.
Edits invalidate earlier evidence. Missing inspections, wrong validation
profiles, stale audits, partial batch coverage and unresolved findings all block
success. Even a complete automated pass records the remaining human checkpoints
and does not declare the engine ready for app integration.

The preservation repair restored all **six authored Figure alternatives** in the
three relevant PDFs, totaling **10 pages**: two raster figures and four vector
figures. Matching uses unchanged native painting occurrences, including repeated
objects, rather than similar-looking pictures or a total count of alternatives.
Existing visible text, graphics, image payloads, links and form behavior remain
protected by independent checks. The exact authored alternative stays attached
to the same figure; uncertain associations and unsupported scopes are rejected.

The already-tagged CDC report needs its original structure retained: fresh
tagging flattened its tables into paragraphs. The existing-structure route
retains both tables, 156 rows, 32 header cells and 828 data cells, with all three
vector Figures restored. It also exposed a real upstream cross-page paragraph
mapping error, which the independent checks detected despite a veraPDF pass.
The bounded `cross_page_repairs.py` helper restores all seven original paragraph
lines to pages 2 and 3 with explicit page references and ParentTree ownership.
It retains native language/layout attributes and rejects ambiguous ordering or
unsupported scopes. The saved candidate retains identical pixels on all eight
pages and passes UA1 machine validation. Independent checks still report **13
unresolved local link destinations already present in the original**; these are
real remaining defects, not repaired guesses.

Semantic testing also found another Discussion continuation excluded as Artifact
on page 7, despite identical rendered pages. The source has unambiguous native
references spanning pages 5 and 7, but the current paragraph writer safely
rejects this case because page 5 also contains preserved Figure metadata scopes
it cannot reconstruct. No incomplete repair is substituted for that finding.
This remaining omission, heading/reading-order defects and missing table row
header relationships block full accessibility approval and app integration.
The completed six-batch audit covers all 2,030 saved tags, eight physical pages
and eight excluded-text reviews. It reports 27 findings across the batches
(including related table issues), rather than a passing overall result.

| Final candidate | UA1 machine checks | Independent preservation | Semantic audit / overall automated result |
| --- | --- | --- | --- |
| Authored-image fixture, with authorized fonts | Pass, 0 failures | Pass with verified font substitution | 0 findings; automated checks pass, human review required |
| One-page CDC chart, existing structure retained | Pass, 0 failures | Pass, identical page pixels | 3 findings; blocked |
| Eight-page CDC report, figures and first continuation restored | Pass, 0 failures | Pass, identical page pixels | 27 reported findings plus 13 broken original local destinations; blocked |

The authored-image fixture now passes veraPDF UA1 with **zero failed checks**,
independent preservation/layout checks, and the model audit with **zero remaining
findings**. Its source contained unavailable Helvetica fonts. With explicit
user authorization, the candidate embeds pinned OFL-licensed Liberation Sans
regular and bold fonts. Text, character origins, font sizes and advances remain
unchanged; glyph shapes can differ. Independent checks found no new word
collisions, page-edge clipping or pixel changes outside the authorized glyph
regions. Font substitution/layout checks also passed on the workshop and field
methods fixtures, for **nine tested pages** overall. These additional font runs
alone do not establish their complete PDF accessibility.

The one-page CDC chart passes UA1 machine and preservation checks but still has
three semantic findings on the existing-structure route: heading relationships,
an incomplete original chart description, and a wrapped URL exposed as duplicate
links. Preserving an authored description is distinct from establishing that it
contains an adequate equivalent of a complex chart. Those findings block an
overall automated pass and remain explicit in the report.

`conformance_repairs.py` handles bounded technical fixes and inventories missing
fonts. `semantic_repairs.py` applies an exact-file, audit-supported role change
to a native leaf tag; it does not change text or page appearance. `link_repairs.py`
replaces generated annotation placeholders only where unchanged native link text
and annotation targets are proven. Broken original named destinations remain
reported instead of being invented. Font replacement uses `font_repairs.py` and
a separate `font_validation.py` implementation with independently pinned programs.

The internal validation candidates may carry a staged PDF/UA-1 identification
entry so the complete validator profile runs. That entry is evaluation evidence,
not a certificate or a production deliverable. Human checks still include
screen-reader navigation and judgment about appropriate meaning, language and
alternatives. See [veraPDF validation scope](https://docs.verapdf.org/validation/)
and the [Matterhorn Protocol](https://pdfa.org/resource/the-matterhorn-protocol/).

## Reproduce locally

Use a separate toolchain JSON containing absolute executable paths. Download
versions from official distributions and verify their published signatures or
checksums. Binaries and machine-specific paths do not belong in this repository.
The evaluated installation's full provenance is stored beside its local
toolchain. No package is added to the web app.

Use Python 3.12 with the versions in `requirements.txt`, preferably in an
isolated environment. The Node audit runner uses the application's installed
Node 24 dependencies. The toolchain configuration is local and must be trusted;
it specifies the programs the evaluator may execute.

```json
{
  "python": "/absolute/path/to/python",
  "openDataLoader": {
    "command": "/absolute/path/to/java",
    "args": ["-Xmx768m", "-jar", "/absolute/path/to/opendataloader-pdf-cli.jar"],
    "version": "2.5.14"
  },
  "veraPdf": {
    "command": "/absolute/path/to/java",
    "args": ["-classpath", "/absolute/path/to/verapdf/etc:/absolute/path/to/verapdf/bin/*", "org.verapdf.apps.GreenfieldCliWrapper"]
  }
}
```

Use the platform's classpath separator (`;` on Windows). Keep all output folders
outside the repository. The evaluator requires a new output folder and never
overwrites the source. `evaluated` means checks ran; see their results for actual
defects. The general inspection is incomplete for some Form/OBJR relationships;
it reports those limits explicitly. The local prototype is for trusted test
fixtures, not an exposed upload service or an OS security sandbox.

```text
python research/native-pdf/evaluate.py --toolchain TOOLCHAIN.json --output NEW_OUTPUT_DIRECTORY source.pdf
python research/native-pdf/verify_pdf.py source.pdf candidate.pdf --report REPORT.json
python research/native-pdf/repair_metadata.py tagged.pdf new-candidate.pdf --language en-US
python research/native-pdf/preserve_figures.py source.pdf tagged.pdf figures-restored.pdf
python research/native-pdf/assess_candidate.py source.pdf candidate.pdf --toolchain TOOLCHAIN.json --output NEW_ASSESSMENT_DIRECTORY --audit AUDIT.json
```

The optional audit uses existing app credentials loaded locally. It supports up
to eight pages and 5,000 native tags per local run. Larger tag inventories are
split into batches of at most 400 detailed tags, with the complete hierarchy and
all page images provided as context. Every saved tag must be reviewed exactly
once, every page must be reviewed, and all excluded-text pages need explicit
review. Missing, repeated or invalid batches prevent completion. Every completed
call's token/cost information is retained, including calls in partial runs. Use
a fresh report directory for each run.
Raw model responses are saved locally before response validation, bounded to
100,000 characters. A finding may cite up to 50 known native tag IDs; the prompt
states this and the other response limits explicitly. The full tag/page coverage
requirements are independent of that per-finding limit. A valid table finding
with 23 references is no longer rejected by an undocumented 20-reference cap.

```text
node --conditions=react-server --env-file=PRIVATE_ENV_FILE --import tsx research/native-pdf/audit.ts source.pdf candidate.pdf NEW_REPORT_DIRECTORY TOOLCHAIN.json
```

For an explicitly authorized font replacement, pass its exact-file manifest as
the audit runner's optional fifth argument, and use `--font-manifest MANIFEST.json`
with `assess_candidate.py`. Ordinary comparisons remain strict. The manifest
must bind the immutable original and final candidate hashes, each font resource,
the original and replacement font dictionaries, and embedded font program.
The independent checker rechecks actual glyph coverage, advance widths, content,
character positions, graphics, links and forms, and confines pixel differences
to authorized glyph regions. It does not accept a writer's success assertion.

An isolated fontTools installation can be supplied through a trusted toolchain
`pythonModulePaths` array of absolute directories. The audit subprocess receives
only those explicit module paths and basic runtime environment variables;
model credentials are not passed to Python.

The saved-tag inventory includes native table scopes, spans and header IDs,
ordered text/child-tag content, and verified annotation references. This gives
the auditor evidence for table and link relationships instead of making it
infer those relationships from the rendered page alone.

Verification completed: 160 Python tests, eleven audit-contract/batching tests, TypeScript
checking and linting of the new TypeScript files.

Tests:

```text
python -m unittest discover -s research/native-pdf -p "test_*.py"
npx vitest run research/native-pdf/audit-contract.test.ts research/native-pdf/audit-batches.test.ts
npm run typecheck
```

## Implementation route

The useful upstream seam is `DocumentProcessor.extractContents(input, config)`
followed by `AutoTagger.tag(extraction, null)`. Extraction returns mutable native
semantic objects with stream provenance. A small adapter can expose stable IDs
and source fingerprints to the model, validate bounded changes, and give the
same native objects to the writer. Exported extraction JSON is not a supported
editable import format by itself.

Build our own targeted repair layer and review UI around that engine:

1. Inventory existing tags, alternatives, forms, signatures and text before
   choosing whether to add tags or repair existing structure.
2. Preserve authored alternatives and vector figures with verified content
   associations. Do not globally retag existing documents until this works.
3. Apply obvious machine fixes and source-grounded model changes to exact native
   objects. Reject placeholders and unsupported edits.
4. Reopen the saved file, compare pages/content, run independent structure and
   PDF/UA checks, then audit meaning and reading order using saved native tags.
5. Return a native PDF plus only actionable unresolved findings. A review
   interface is useful for ambiguities; instructors should not need to manually
   repair obvious metadata or approve every tag.

Before app integration, add adversarial fixtures for reused Forms, vector charts,
scans/OCR, complex tables, multilingual passages and interactive forms, plus
screen-reader navigation testing. Bound worker resources and cover source/output
storage, ownership, downloads, all model-call costs and the original 14-day
retention. Until these gates pass, the live app's native PDF choice stays
unavailable.
