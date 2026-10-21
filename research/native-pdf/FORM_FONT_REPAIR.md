# Local native PDF form-font repair

Form fonts need checks beyond ordinary page text. A saved field can look correct
because its existing appearance contains one font, while editing that field uses
another font from the form's default resources. Both must preserve character
meaning and spacing.

This experiment follows the registration form's existing label and reading-order
repairs. Its separate `formFontManifest` bundle requires an independent font
verifier; it cannot use the page-only substitution exception. Original files and
the earlier repair ledgers remain unchanged. Every final candidate requires new
machine validation and a fresh audit bound to that file.

## What must remain intact

- Visible page content, field positions, labels and reading order.
- Field types, values, defaults, options, required/read-only flags and actions.
- Editable controls and the relationship between each field, widget and Form tag.
- Character mappings and spacing in existing appearances. Future values must use
  correct character mappings and widths from the embedded font, with explicit
  tests for the supported encoding and any spacing differences.
- All native PDF objects outside the explicit font substitution and any separately
  verified evaluation-only identification entry.

The user authorized similar open-source fonts when layout checks pass. A small
change in letter shape can therefore be acceptable; missing characters,
unexpected movement of existing text, clipping or flattened controls cannot.

The font is the unmodified, pinned Liberation Sans 2.1.5 program, distributed
under the [SIL Open Font License](https://github.com/liberationfonts/liberation-fonts/blob/2.1.5/LICENSE).
Five encoded symbols have different advances from the original Helvetica. The
repair rejects an input that already paints any of those codes with a font being
replaced. Future entries use the embedded font's genuine widths. This avoids
claiming that every possible future value has identical spacing and avoids
writing widths that disagree with the actual font program.

The final semantic audit still checks what the controls mean. In particular, a
font repair cannot decide whether the registration form's “Send workshop
materials” checkbox should be required. That question remains an author-intent
review item unless separately resolved.

## Running the local checks

`form_font_repairs.repair_form_fonts(...)` takes the original PDF, the previously
verified form candidate, a new output path, the pinned font path, the prior
reading-order ledger, explicit source/input hashes, and
`allow_font_substitution=True`. It returns a ledger for the saved output.
`form_font_validation.compare_with_authorized_form_fonts(...)` independently
reopens the files and verifies that ledger. The usual audit and assessment
commands accept a bundle containing only `schemaVersion: 1` and
`formFontManifest: "font-ledger.json"`.

Current support is limited to simple, unembedded Helvetica form fonts with
resolved Standard/WinAnsi encodings and explicit differences, single-line text,
simple choices and single checkboxes. Rotated/scaled or nested appearance forms,
unsupported character maps, existing changed-width characters, signatures, XFA
and encryption are refused. This is not a general replacement for all form fonts.

Run the regression tests from the repository root with the configured local
toolchain and pinned font installation:

```powershell
$pdfTools = Get-Content -Raw ../../work/pdf-native-tools/toolchain.json | ConvertFrom-Json
$env:PYTHONPATH = $pdfTools.pythonModulePaths -join [IO.Path]::PathSeparator
& $pdfTools.python -m unittest discover -s research/native-pdf -p 'test_form_font*.py' -v
```

The final evaluation ledger can add one `evaluationStage` that binds the raw
candidate and raw ledger by their paths and hashes. Its verifier first validates
that raw chain, then permits only the exact PDF/UA-1 XMP identification addition.
Nested stages, altered titles or other metadata, changed native objects and stale
hashes fail. A new complete audit is required for the evaluation file itself.

## Scope of the result

This is local research for PDF/UA-1 (ISO 14289-1:2014). The application has no native
PDF repair integration. A staged PDF/UA identification entry allows the complete
machine profile to run on an evaluation copy; it does not establish conformance.
Keyboard and screen-reader use still require hands-on review of the saved file.
See [veraPDF's validation scope](https://docs.verapdf.org/validation/) for the
distinction between machine-verifiable PDF/UA requirements and human checkpoints.
