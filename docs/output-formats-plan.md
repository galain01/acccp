# Plan for selectable conversion outputs

Status: proposed architecture, September 23, 2026. Canvas HTML is the only
implemented output. This plan does not add a selector or change live behavior.

## Product goal

An instructor chooses what they want to receive for each document. Input format
and output destination are separate: an uploaded PDF could become Canvas HTML,
a standalone HTML document, or a remediated PDF. Each result needs checks suited
to its destination. A future format must not inherit Canvas restrictions merely
because Canvas was the first supported destination.

## Work to do now

1. Finish the Canvas-specific prompt improvements and verify representative
   results after saving in Canvas. The September 23 manual Page test preserved
   the header element, table IDs and scope attributes, but removed all four td
   headers attributes and li value="7"; the list changed from 3, 7, 8 to 3, 4, 5.
   That establishes behavior for the tested Canvas Page workflow, not every
   possible Canvas context or assistive-technology outcome.
2. Keep the shared Canvas compatibility module specific to Canvas. Both the
   Canvas converter and its audit use it. Treat content preservation, source
   evidence, authored image descriptions, and understandable findings as shared
   requirements; H2 starting levels, fragments, Canvas attributes and closing-tag
   normalization belong to the Canvas output path.
3. When separating prompt modules further, preserve existing behavior and avoid
   adding an extra model call solely for architectural symmetry. Source review
   comments and HTML snippets are current Canvas mechanisms, not universal
   requirements for future outputs.
4. Keep the UI focused on the working Canvas output until another destination is
   tested. Do not add a nonfunctional accessible-PDF option or undertake a database
   migration solely for future flexibility.

## Shared source preparation, separate output paths

Keep original uploads immutable. The existing source preparation supplies PDF
page images, physical page numbers, extracted text and authored image-description
evidence. Reuse that preparation where appropriate; these inputs are evidence,
not a complete editable reconstruction of the source document.

- Canvas HTML: generate a Canvas-compatible fragment, normalize it, and audit
  fidelity/accessibility plus Canvas behavior. Image placeholders continue to
  require insertion under the current workflow.
- Standalone HTML, future: generate a complete document with suitable title,
  language and heading structure, and package actual image assets. Audit the
  standalone output and its resources.
- Accessible PDF, future: use a PDF remediation/writing engine to add or repair
  the structure and associations inside a PDF, using model-assisted interpretation
  where useful. Validate the produced PDF, not just a proposed tagging plan or an
  intermediate HTML document.

Do not require future outputs to start from the Canvas HTML. It already contains
destination-specific compromises and placeholder images. A richer shared document
representation can be introduced when a concrete second output establishes which
information must be represented and how source positions must be retained.

## Scope of accessible PDF work

The intended default is to improve the original PDF's accessibility while
preserving its visual layout where feasible. Rebuilding a newly laid-out PDF
would be a separate, explicit product choice. Scans may need OCR. PDF structure
can require reading order, headings, lists, table relationships, image alternatives,
language, links and form-field handling. Visual barriers can require changes to
the page itself; adding tags alone cannot resolve every accessibility problem.

The current page renderer and metadata reader do not write or repair accessible
PDFs. Select and test that capability before promising PDF remediation. Combine
machine-checkable PDF validation with content/layout comparisons and human checks
of reading order and difficult content. An LLM audit alone is not certification.
Evaluate any new service's document handling against the existing institutional
data-handling requirements before introducing it.

References: [Adobe PDF accessibility overview](https://www.adobe.com/accessibility/pdf/pdf-accessibility-overview.html)
and [W3C PDF heading techniques](https://www.w3.org/WAI/WCAG22/Techniques/pdf/PDF9).

## Data changes when a second output is ready

Today `conversion_jobs` is unique per document, storage uses a fixed output.html
key, the output artifact enum has html_output, and retrieval/results/UI assume
HTML. Before enabling a selector:

- Give each source-to-destination conversion its own result identity, status,
  findings and output files. Creating a PDF result must not replace the source's
  Canvas result. Re-conversion should clearly identify which result is replaced.
- Add typed output artifacts and MIME-aware downloads; keep remediation output
  PDFs separate from source PDFs. Use destination/job-specific storage keys.
- Record destination and profile version alongside model/prompt provenance.
  Report costs, timings and outcomes by destination where useful. Cost still
  includes conversion, audit, retries and recorded billable failures.
- Preserve the existing 14-day expiry measured from the original document's
  creation for every derivative. A new destination must not reset that clock.
  Purge must discover all derivatives. Keep anonymous daily/model/destination
  aggregates after purge, without instructor or document identifiers.
- Label benchmark runs by output destination and prompt/profile version. Share
  source-fidelity cases where useful, but evaluate Canvas and PDF outputs with
  their own format checks. Do not interpret success in one format as success in
  another.

Implement the second output end to end before exposing the user-facing selector.
