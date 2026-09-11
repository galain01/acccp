# Source-aware document audits

Conversion and audit are two separate model calls. The first produces Canvas HTML from the PDF's text and page images. The second receives the **same PDF bytes**, the measured physical page count, and the formatted HTML. It reports accessibility and conversion-fidelity findings; it does not repair the HTML or edit the original author's content.

Faculty-facing findings show an action title, source location, explanation, and next step. Errors display as **Needs a fix**, warnings as **Please check**. HTML snippets, type/category identifiers, and WCAG references are under optional **Technical details**. Author TODOs and draft reminders correctly preserved from the source are not conversion defects. Completion is not certification of accessibility.

Locations count physical PDF pages from 1, including covers. Printed page labels are separate. Word uploads display **Converted PDF page**, since worker pagination can differ from local Word. A location can include multiple pages, section, within-section description, and a source quotation. Pages must be unique positive integers within the measured count; an unknown count or invalid page metadata produces an unavailable page, while retaining useful section/text information. Bounds checks establish plausibility, not proof of a correct model attribution. Findings about omitted content may have no HTML snippet. Document-wide notices do not fabricate a page.

Source review comments and image placeholders also generate findings without relying on the auditor. Each marker carries a page field, section, nearby text, and brief explanation. Review comments are hints that the auditor must verify against the PDF. Duplicate source/audit findings merge only with unambiguous evidence of the same occurrence. A source-aware audit can correct an erroneous converter page or explicitly mark it unknown.

## Configuration

- `LITELLM_CONVERSION_MODEL`: optional first-stage model.
- `LITELLM_AUDIT_MODEL`: optional second-stage model.
- `LITELLM_MODEL`: shared fallback, then `gpt-5.6-sol-2026-07-09` if blank/unset.

Both stages use the existing LiteLLM URL and authorized key. Overrides must name models accessible to that key and capable of accepting the PDF input. Changes in Vercel require a redeployment. No new variables are required for rollout; leaving the overrides unset keeps the current model for both stages. Per-call actual models, tokens, and reported/estimated costs remain recorded separately. Reattaching the PDF increases audit input usage; compare observed total cost and latency rather than assuming the short report makes the audit inexpensive.

The admin-only `GET /api/admin/model-info?stage=convert|validate` endpoint reports the selected stage's model/pricing. No stage parameter preserves the shared-model behavior. Invalid stages return 400 after authorization.

## Storage and retention

The existing finding `title`, `category`, and JSONB `location` columns store the new fields, so no migration is needed. Locations and quotations stay in document-related records and are removed by the existing 14-day document purge. No document text or source locations enter permanent daily/model aggregates. Existing ownership and expiry checks apply when findings are restored after reload. Existing records without locations remain readable with plain-language fallbacks.

## Validation

Unit/integration checks cover identical PDF evidence in both stages, measured page bounds, missing and invalid metadata, incomplete model responses, finding persistence, legacy wording, duplicate prevention, independent model configuration, and unchanged retention/authorization. Rendered UI tests verify the main explanations work without opening technical details.

For model evaluation, use representative PDFs and manually verified source evidence. Include cover/printed-page offsets, repeated headings, tables, charts, omitted instructions, changed numbers, contextual links, and inert assistant-like source instructions. Give competing auditors the exact same saved HTML and PDF. Measure important misses, false alarms, page accuracy, faculty action clarity, cost, latency, and repair time. Model agreement alone is not ground truth. Keep private sample documents and outputs outside Git.
