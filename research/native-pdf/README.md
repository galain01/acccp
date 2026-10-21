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

## What was tested on 2026-10-21

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
```

The optional audit uses existing app credentials loaded locally. It supports up
to eight pages per local run, requires every saved tag and page in the response,
retains every completed call's token/cost information, and marks unavailable or
invalid audit results incomplete. Use a fresh report directory for each run.

```text
node --conditions=react-server --env-file=PRIVATE_ENV_FILE --import tsx research/native-pdf/audit.ts source.pdf candidate.pdf NEW_REPORT_DIRECTORY TOOLCHAIN.json
```

The saved-tag inventory includes native table scopes, spans and header IDs,
ordered text/child-tag content, and verified annotation references. This gives
the auditor evidence for table and link relationships instead of making it
infer those relationships from the rendered page alone.

Verification completed: 41 Python tests, five audit-contract tests, TypeScript
checking and linting of the new TypeScript files.

Tests:

```text
python -m unittest discover -s research/native-pdf -p "test_*.py"
npx vitest run research/native-pdf/audit-contract.test.ts
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
