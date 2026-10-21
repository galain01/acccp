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
pages and passes UA1 machine validation. At this stage, independent checks found
**13 unresolved local link destinations already present in the original**.

Semantic testing also found another Discussion continuation excluded as Artifact
on page 7, despite identical rendered pages. The source has unambiguous native
references spanning pages 5 and 7. The first paragraph writer rejected this case
because page 5 also contained preserved Figure metadata scopes it could not
reconstruct. The completed six-batch audit of that candidate covered all 2,030
saved tags, eight physical pages and eight excluded-text reviews. Its 27 findings
(including related table issues) prompted the further remediation below.

| Earlier candidate | UA1 machine checks | Independent preservation | Semantic audit / overall automated result |
| --- | --- | --- | --- |
| Authored-image fixture, with authorized fonts | Pass, 0 failures | Pass with verified font substitution | 0 findings; automated checks pass, human review required |
| One-page CDC chart, existing structure retained | Pass, 0 failures | Pass, identical page pixels | 3 findings; blocked |
| Eight-page CDC report, figures and first continuation restored | Pass, 0 failures | Pass, identical page pixels | 27 reported findings plus 13 broken original local destinations; blocked |

These earlier preservation results predate the expanded authored-reading-text
check. Later testing found lost native and inline `ActualText` replacements even
when visible text and page pixels matched. The final gate below checks those
associations independently; the earlier candidates are superseded.

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

The first one-page CDC chart candidate passed UA1 machine and preservation checks
but had three semantic findings on the existing-structure route: heading relationships,
an incomplete original chart description, and a wrapped URL exposed as duplicate
links. Preserving an authored description is distinct from establishing that it
contains an adequate equivalent of a complex chart. Those findings blocked that
candidate and remain explicit in its immutable report.

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

## Latest remediated samples

The final local samples on 2026-10-21 pass the complete automated assessment:

| Sample | Original pages + description pages | Failed UA1 checks | Findings in fresh complete model audit |
| --- | ---: | ---: | ---: |
| CDC report (`composed-v5`) | 8 + 1 | 0 | 0 |
| CDC chart (`chart-v4`) | 1 + 1 | 0 | 0 |

The report's final audit covers all 2,161 saved tags, nine physical pages and
seven pages with excluded text. The chart audit covers all 44 tags and both
physical pages. The final assessments use the strengthened table IDTree check.
Each candidate retains identical original page pixels, painting and resources;
the approved description text appears on one added page.

The report now has explicit column, row and category header relationships for
both tables. All 180 native IDTree entries and 3,000 header references resolve
to the correct saved objects within their own tables. The previously excluded
Discussion continuation is available in reading order. Table directions, front
page navigation, staff lists and authored reading replacements are preserved
and ordered appropriately. The original Figure descriptions remain attached to
their original graphics, supplemented by evidence-based descriptions in the
appendices. These results supersede the earlier candidates above.

Final immutable output identities:

- Report: `74d2b6239029ebea9da1b669af38c90198eb0630a7479d88a36ac6b70c9ee20d`
- Chart: `41ed1d86bae74acfb49b73b6cdb7251dc203e32407f8396cbd03aaad6d0e648b`

These are two repaired research samples, using bounded reviewed plans. Their
assessment status remains `automated_checks_passed_manual_review_required`.
Hands-on screen-reader testing and broader document coverage are still required
before app integration or an established PDF/UA conformance claim.

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

Table-header validation resolves the PDF's actual IDTree, checks its ordering,
limits and exact reachable targets, and requires each header reference to stay
within its own table. Mutation tests found that veraPDF alone accepted a missing
IDTree; the independent checker now rejects that case as well as references to
another table or to the cell itself.

The local inspection also accounts for a pypdf extraction error that treated
positive `TJ` letter-tightening adjustments as spaces inside words. Original
font mappings, unchanged painting operations and independent PDFium extraction
established the correct staff names. This correction affects inspection only;
it does not rewrite PDF text or replace a screen-reader test. Native `ActualText`
and its verified associations remain explicit evidence for the semantic auditor.

Verification completed: 318 Python tests, thirteen audit-contract/batching/page-policy
tests, TypeScript checking and linting of the changed TypeScript files.

Tests:

```text
python -m unittest discover -s research/native-pdf -p "test_*.py"
npx vitest run research/native-pdf/audit-contract.test.ts research/native-pdf/audit-batches.test.ts research/native-pdf/audit-page-policy.test.ts
npm run typecheck
```

## Implementation route

### Further local remediation

The local repair layer addresses the actual native structure after the first audit:

- `cross_page_repairs.py` can restore a missing paragraph continuation while
  leaving a verified, already-correct anchor page byte-for-byte unchanged. This
  preserves unrelated Figure metadata on that page.
- `structure_repairs.py` applies exact audited snapshots for heading roles,
  reading-order permutations, section grouping and numbered reference lists.
  List labels must already have separate, verified content references; the
  writer does not guess where to split a text operation.
- `table_repairs.py` binds every cell to its source painting, text and spans.
  Explicit plans establish column, row and category headers with native IDs,
  `Headers` associations and an IDTree. Explanatory table footnotes become Note
  siblings, with their original content retained.
- `pagination_artifacts.py` handles only exact repeated continuation captions.
  Unique instructions such as "See table footnotes on the next page" remain
  native paragraphs. `table_direction_order.py` places each reviewed direction
  after its table title and before its intact two-page table, so "next page"
  retains its meaning in continuous reading. The first caption, complete table
  and actual footnotes remain reachable. The final auditor reviews all excluded
  text.
- `link_grouping_repairs.py` restores source-proven complete Link groups and
  their content/annotation ownership. `navigation_repairs.py` separately repairs
  four verified CDC report destinations in the research fixture. That destination
  policy is pinned to this source; it is not a general URL-guessing feature.
- `description_appendix.py` adds approved, evidence-bound image explanations on
  at most two new pages, using embedded open-source fonts. Existing pages and
  authored image descriptions remain intact. The new native section follows its
  Figure in reading order; its heading level is explicit in the approved plan.
- `opening_order_repairs.py` moves reviewed front-page navigation blocks using
  exact audited native snapshots. `roster_repairs.py` groups existing staff
  names and roles into lists without splitting text operations or changing the
  original Form streams. Both verify saved ownership and unchanged page content.
- `actual_text_repairs.py` restores authored reading text, including soft
  hyphens and whitespace, on the same original painted content. An independent
  association check protects these replacements as well as Figure alternatives.
  A matching replacement string elsewhere does not count as preservation.
  The CDC report has five reviewed tab-only scopes that become Artifact content:
  four blank paragraphs and indentation before a retained footnote. This narrow
  exception binds the exact original file and painted occurrences; other changes
  to the availability of replacement text remain failures.

These are bounded repair operations and reviewed local plans, not yet a general
automatic native PDF service. No live route imports them. New document-bearing
plans, source evidence, intermediate candidates and reports stay outside Git.

`repair_validation.py` composes independent navigation and appendix verification.
A bundle JSON uses `schemaVersion: 1` and the paths `navigationManifest` and/or
`appendixManifest`, resolved relative to the bundle. An appendix ledger binds its
immutable baseline, exact approved text, evidence files and final output. The
checker separately verifies the original pages and all new text, tags and fonts.
It never authorizes arbitrary page changes. A navigation ledger can continue
through an appendix only when the two exact file hashes form a valid chain.
Verified text/JSON evidence is also supplied to the auditor, with bounded reads
and exact hashes. Evidence and proposed descriptions are treated as untrusted
source material. A file hash establishes identity, not factual correctness or
publisher provenance; source values are checked separately.

```text
node --conditions=react-server --env-file=PRIVATE_ENV_FILE --import tsx research/native-pdf/audit.ts source.pdf candidate.pdf NEW_REPORT_DIRECTORY TOOLCHAIN.json --repairs BUNDLE.json
python research/native-pdf/assess_candidate.py source.pdf candidate.pdf --toolchain TOOLCHAIN.json --output NEW_ASSESSMENT_DIRECTORY --audit AUDIT.json --repairs BUNDLE.json
```

The local audit covers at most eight original pages plus two independently
verified description pages. Every output page and native tag, including the
appendix, still requires complete audit coverage. Font replacement manifests and
these additional repair bundles cannot be combined in this experimental runner.

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
