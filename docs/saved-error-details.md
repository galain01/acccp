# Saved failure reasons

This release records controlled diagnostic fields instead of saving only a broad conversion error. It does not retry failed jobs or recover provider details discarded by older releases.

## What people see

Faculty receive a plain-language reason in the document result dialog, both immediately and after reloading saved documents. The reason names the failed step and, when the renderer can identify it, the physical PDF page. Page numbers refer to the uploaded PDF or the PDF rendered from Word, not necessarily Word's original page labels.

Administrators can expand **Error details** beside a currently failed recent job. The detail includes only validated fields: failed step, diagnostic category, configured model, HTTP status, page, time spent in that step, attempt number, a provider wait hint where appropriate, and a validated provider request ID when supplied. Older failures without this contract display an unavailable-detail explanation. Successful jobs and new attempts cannot accidentally show an earlier attempt's failure.

The **Failure reasons** table follows the selected UTC date range. It counts failed attempts recorded after this release, including retries and Word-rendering rejections before a job is saved. It is not the same measure as the latest-status job summary. It has no historical backfill; earlier failures remain in existing overall job statistics.

## Diagnostic boundaries

- `lib/job-diagnostics.ts` defines the versioned allowlist, bounded field validation, and faculty wording. Unknown fields are discarded. Explanations are generated from internal categories, never provider or document text.
- The PDF child emits only `{ok:false,code,pageNumber?}`. The parent checks the allowed categories, page range, and a 512-byte failure envelope. Existing rendering limits and the 30-second deadline remain. Parser failures, encrypted PDFs, page/image/complexity/output limits, incomplete rendering, worker failures, and timeout have distinct categories. Whole-document preflight failures may have no identifiable page. Native stderr and raw exceptions remain discarded.
- LiteLLM error JSON is limited to 16 KiB and 1.5 seconds of reading. Only exact recognized `error.code` and `error.type` values influence the category. Error messages, other body fields, response headers as a group, and source content are never persisted. A conflicting or unknown code falls back to the HTTP status's broad category. HTTP 429 alone remains “rate or quota unknown”; HTTP 400 does not establish that the PDF is unreadable. Numeric `Retry-After` is bounded to one day. Only a UUID in `x-litellm-call-id` is accepted as the provider request ID.
- `convertPdf` tracks the actual failing step and its elapsed time, preserves usage from completed model calls, and drops arbitrary exception messages. The route sanitizes diagnostics again before storing them. Provider support fields remain in the admin-only event details, not the instructor conversion response.
- New Word files still render before document/job creation. A rejected Word file receives a controlled explanation and contributes an anonymous failure count, but creates no empty document or recent-job row. A failed Word rendering during reconversion leaves the prior saved job and files intact. Other failures before a job exists (such as an invalid upload or inability to read its stored source) retain their existing safe response behavior and are not new detailed job records.

## Storage and deletion

For an existing job, one retained-document transaction updates the failed status and faculty message, inserts `job_events.metadata.diagnostic`, increments `daily_failure_metrics`, and records available billable usage. The event timestamp is explicitly the same timestamp used to select the aggregate's UTC day. A transaction rollback removes both event and count.

Document-linked details follow the existing 14-day access cutoff and cascading purge, including model identifiers and provider request IDs. Admin queries exclude expired/tombstoned documents and recheck expiry after fetching. Locally downloaded files are unaffected.

`daily_failure_metrics` contains exactly `day`, `stage`, `code`, and `failure_count`. It has no person, document, job, request ID, filename, snippet, model string, or exact timestamp. Categories have database check constraints and RLS is enabled. These totals survive document deletion. Purge does not archive or increment them again.

## Rollout

Provider field recognition is based on [LiteLLM response headers](https://docs.litellm.ai/docs/proxy/response_headers), [LiteLLM's defined proxy error types](https://github.com/BerriAI/litellm/blob/main/litellm/proxy/_types.py), and [OpenAI's troubleshooting code definitions](https://github.com/openai/openai-developers-for-cursor/blob/main/skills/openai-api-troubleshooting/SKILL.md). Unknown gateway versions/codes retain the broad status classification.

Apply migration **`0012_saved_error_details.sql`** to the intended database before deploying this branch; the new admin query and failure writes require its table. No secrets or new environment variables are required. Do not enable application code against an unmigrated database.

The migration creates only the aggregate table and its checks/RLS. It does not alter existing documents, jobs, costs, tokens, retention dates, or historical totals. Application rollback can leave the new table in place. Do not drop it when rolling back if its history should be kept.

## Verification

Unit tests cover provider code/status ambiguity, malicious error bodies and headers, body size/deadline limits, renderer failure classification, stage attribution, preservation of billable calls, faculty wording, admin authorization/expiry, and current-attempt matching. Isolated PostgreSQL/WASM tests exercise the migration, aggregate/date queries, event/count rollback, and deletion without losing or double-counting anonymous totals. Test fixtures are synthetic; no actual instructor documents or model calls are required.
