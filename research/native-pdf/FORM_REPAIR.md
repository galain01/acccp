# Local native PDF form repairs

These research helpers repair accessible descriptions and a limited reading-order problem while keeping the PDF editable. They are not connected to the application. A saved result still needs independent validation, a fresh semantic audit, and manual keyboard and screen-reader review.

## Authored labels

`form_label_repairs.repair_form_labels(original, candidate, output, ...)` copies a clear authored label into a missing, empty, or generated `Annotation` description on a native Form tag or its widget. It never uses the internal field name as a user-facing fallback.

Supported evidence is the owning terminal field's `/TU` tooltip, an existing meaningful widget description or Form alternative, or the caption of an actual pushbutton. A widget can use its terminal owner's tooltip; a separate child field cannot inherit a nonterminal parent's `/TU`. That distinction follows the PDF field specification and [W3C PDF12](https://www.w3.org/WAI/WCAG22/Techniques/pdf/PDF12).

The supported controls are text fields, choice fields, single checkboxes, and single pushbuttons. Several text/choice widgets belonging to the same terminal field can share its authored tooltip. Radio groups and multi-widget buttons remain review items because a group name does not identify each option. Missing labels, mixed-label Form groups, ambiguous ownership, XFA, signed or encrypted files are not silently repaired.

The helper checks exact field paths, widget occurrences, Form object references, and ParentTree ownership. It retains values, defaults, required/read-only flags, choices, actions, appearances, rectangles and existing meaningful descriptions. Input and output hashes are recorded. Originals and prior candidates are never overwritten.

`form_label_validation.compare_with_authorized_form_labels` separately reopens the original, immutable intermediate, and final PDF. It resolves label evidence again and compares the entire native graph after undoing only the declared label changes in memory. Its rendering check initializes PDFium's form environment so widget appearances are included. Ordinary annotation rendering alone does not display these interactive fields.

## Reading order

`form_order_repairs.repair_form_reading_order(...)` can repair a completed audit's finding that all labels are read before all controls. It moves existing direct Document children into label/control pairs; it changes no page content or field behavior.

This first version accepts a single page of distinct, nonoverlapping rows: a text/choice control with a label to its left, or a single checkbox with a label to its right. Each selected label must be unique exact visible source text, match its native paragraph, and overlap its control vertically. All controls on that page must be paired, and the selected native siblings must form a consecutive block. Each pair must be named by the completed, matching reading-order audit. More complicated layouts require review.

The order ledger retains the original label ledger's file and hash; it does not rewrite an old audit or rebind its output hash. The separate `form_order_validation` checks the saved permutation and the entire prior label-repair chain. Every newly ordered candidate requires a fresh audit.

## Reproducing the checks

From the repository root, with the existing local Python runtime:

```powershell
$pdfTools = Get-Content -Raw ../../work/pdf-native-tools/toolchain.json | ConvertFrom-Json
$env:PYTHONPATH = $pdfTools.pythonModulePaths -join [IO.Path]::PathSeparator
& $pdfTools.python -m unittest discover -s research/native-pdf -p 'test_form_label*.py' -v
& $pdfTools.python -m unittest discover -s research/native-pdf -p 'test_form_order*.py' -v
```

Tests generate their PDFs in temporary directories. They cover saved label evidence, terminal ownership versus false tooltip inheritance, repeated widgets, missing/ambiguous labels, radio-option review, button-caption distinctions, preserved field values, initialized form rendering, bad ownership, stale evidence and refused overwrites. Order tests check native pairing, unchanged source/input bytes and field values, wrong-row pairings, omitted/duplicate controls and stale audit/label chains. Independent tests try undeclared field, appearance, label, ownership and order changes.

From the repository root, the private registration experiment is under `../../outputs/native-pdf-form-labels-2026-10-21/`. It contains the exact ledgers, saved candidates, initialized-form screenshots, filling evidence, audit, and validator report. These PDFs stay outside Git.

## Initial result and subsequent font work

The separate [form-font repair](FORM_FONT_REPAIR.md) now supports this bounded
appearance/default-resource case. [Its saved-file results](FORM_FONT_RESULTS.md)
supersede the font failures below; the required-checkbox ambiguity remains.

The registration experiment restores six generated descriptions from three existing tooltips. Programmatic filling still updates the participant name, session choice and checkbox; the filled source and repaired PDF render identically with form appearances enabled. The order repair pairs each visible label and control while retaining the original page.

The label-stage file still fails the PDF/UA-1 validator for two pre-existing, unembedded Helvetica font programs in widget appearances and the deliberately absent PDF/UA identification declaration. These fonts also use custom encoding differences and appear in the AcroForm default resources. Existing page-font substitution does not support this form-appearance case. Resolving it needs a separate encoding-aware appearance/default-resource repair plus renewed filling and rendering checks; this work must not be reported as a PDF/UA pass.

The fresh audit of `registration-ordered.pdf` confirms the label/reading-order
repairs and identifies one remaining author-intent issue: the materials checkbox
looks optional but its original required flag is set. That flag is preserved.
The final assessment stays blocked by this finding and the existing fonts; see
[the complete scan/form results](SCAN_FORM_RESULTS.md).

The form helpers run locally. The separate model audit uses the configured institutional model gateway, as in the other native-PDF experiments. No production integration or compliance certification follows from these tests.
