# Saved form editing regression

`pdfbox_form_fill.py` compiles `java/FormFillProbe.java` with the pinned local
PDFBox 3.0.8 JAR and uses its real field-editing API. It writes new copies,
reopens them, and compares canonical field values with text decoded from each
actual appearance stream. It does not use PDFBox's automatic AcroForm fixup
or request a viewer to regenerate missing appearances.

The report binds the source, candidate, JAR and runner hashes. For each text
glyph it records the Unicode mapping, GID, embedded font-program hash, font
size, origin, ink bounds and active clipping bounds. It also checks the native
document graph after excluding only changed field values, choice indices,
checkbox states and appearance streams. Pixels outside the widget rectangles
must remain identical. It reports clipping separately from text accuracy.

The bounded registration fixture exercises all 229 original encoding entries,
accented names, punctuation, the five symbols whose replacement-font advances
differ, near-capacity text, and explicit unsupported-character refusals.
Nineteen `W` characters fit; twenty clip the final letter and are recorded as a
capacity test. A successful run does not promise arbitrary text will fit.

From the repository root, with the external FontTools path on `PYTHONPATH`:

```powershell
& $python research/native-pdf/pdfbox_form_fill.py `
  ../native-pdf-matrix-2026-10-21/fixtures/interactive-registration.pdf `
  ../native-pdf-form-usability-2026-10-21/default-font-v2/registration-compatible-evaluation.pdf `
  --toolchain ../../work/pdf-native-tools/toolchain.json `
  --output ../native-pdf-form-usability-2026-10-21/pdfbox-future-fill-new
```

Use a new output folder on every run. `test_pdfbox_form_fill.py` builds a
temporary synthetic repair chain; it checks saved accents, a deliberately
wrong ToUnicode mapping despite a correct `/V`, unrelated catalog changes,
unsupported input, output immutability and overflow detection.

The first Unicode-point-CID experiment failed this test: PDFBox encoded glyph
IDs, resulting in correct field values but wrong appearance characters. The
revised font uses GID-based CIDs, `/CIDToGIDMap /Identity`, genuine widths and
GID-to-Unicode mappings; its saved edits passed the 23 cases. This demonstrates
why static font checks and successful field-value writes are insufficient.

PDFBox editing and PDFium rendering are distinct evidence from Acrobat typing,
save/reopen behavior and assistive-technology use. Those interactions still
require their own recorded tests. No result here establishes PDF/UA conformance.
