# Dashboard metrics

The admin Metrics tab supports 30 days, 90 days, one year, all time, and custom inclusive date ranges. All boundaries use UTC calendar days. Every historical metric card, including average cost per job, follows the selected range. Charts show daily totals for short ranges, monthly totals for longer ranges, and yearly totals beyond ten years; the expandable daily table keeps the exact values. Model totals use the same selected range.

## What the numbers mean

- **Jobs and success:** One mutable conversion job per document, grouped by its original job creation date. Reconverting updates that job and its latest status; it does not create another job. Completed and needs-review count as successful. Failed, expired and cancelled count as errors. Queued/processing remain in the total. Failures before a job can be saved are outside these metrics.
- **Tokens and model cost:** Every recorded model call, including the audit, retries, and billable calls preceding failures. These are grouped by the call's creation date. Cost excludes hosting, storage and other services. See [model pricing](model-pricing.md) for gateway charges versus estimates.
- **Average tokens per job:** All recorded calls across all attempts for jobs first created in the selected period, divided by jobs with this cohort history. This deliberately differs from dividing call-date token usage by job-date counts. Older purged jobs without cohort statistics are excluded and the dashboard shows coverage.
- **Average cost per job:** All recorded model charges across conversion, audit and every attempt for jobs first created in the selected period. This includes recorded charges from failed attempts. A job contributes only when it has at least one recorded call and every recorded call can be priced, including labeled estimates; a recorded zero charge is valid. Divide the sum of those complete recorded job costs by the number of contributing jobs, never by the number of calls or by call-date job totals. The card shows how many jobs contribute, flags estimates and displays Unknown when none have complete recorded pricing. Jobs with missing prices or no recorded calls are excluded from this average, rather than treated as free.
- **Pages:** Counted from the exact PDF sent to conversion, including PDFs rendered from Word. The latest attempt's count is stored on the job. Unknown counts stay null, never zero. Totals and average pages include only measured jobs; coverage is shown. A failed model call can still have a valid page count.
- **Successful processing time:** A monotonic server measurement begins before Word rendering and PDF page counting. It includes source storage, conversion, accessibility review, output storage and metadata statements through the final completion update. It excludes browser upload, time before that measurement, final transaction commit/response transit, and client rendering. Only completed/needs-review jobs with a recorded duration contribute. Reconversion replaces the latest measurement. Old started/completed timestamps are not substituted because they omitted rendering and source storage.
- **Median, minimum and maximum:** Computed over measured successful jobs in the selected creation-date cohort. Exact duration frequencies preserve odd/even weighted medians across days and models; daily medians are never averaged.
- **Recent jobs:** Unexpired documents only, independent of the historical range selector. Shows page count, latest successful processing time, attempts, all-attempt tokens, all-attempt model cost, model, filename and requester. Pagination preserves the selected history filter.

Activity and job cohorts can occur on different days. A reconversion can change an earlier day's job token average or latest status while adding call usage on today's date. Model usage follows each call's model; job measurements are attributed to the job's last saved conversion model. A failed retry can leave that saved model unchanged; its recorded charges still count against the models that handled its calls. The dashboard states these distinctions.

## Cost handling

The conversion pipeline prefers a valid gateway response cost, including zero. Otherwise it estimates from gateway model metadata, then the dated published Sol price fallback for explicitly supported model IDs. It persists the amount, its source, and valid optional cache counters. Inconsistent cache metadata is discarded so ancillary metrics cannot fail a successful conversion; an estimate then assumes uncached input.

Existing non-null costs never change. Previously unpriced live Sol calls receive a labeled read-time list-price estimate, using per-call cache counts and the long-context threshold; these estimates are frozen into retained cost totals on purge. Unknown models stay unpriced. SQL pricing and conversion pricing share the published rate data. Costs retain decimal precision in PostgreSQL. The UI labels estimates and excludes unpriced calls from known subtotals; zero is never used to conceal unknown cost.

The same all-call rule applies to the selected-period cost card, daily/monthly/yearly cost chart, model breakdown, recent-job cost and retained totals: conversion, audit, retries and recorded billable failures all count. Activity totals use each call's date and model; per-job costs and their average use the job's original creation date and include all its recorded attempts, even calls made later or with a different model. No cost metric includes hosting or storage. Missing provider usage or unpriced calls cannot be invented; completeness notes qualify the displayed amount.

Preexisting retained model groups did not record pricing coverage. Migration leaves their coverage unknown, including when newer groups merge into them. No unsupported completeness claim or retrospective per-call estimate is made for those old groups.

## Retention and privacy

Migration `0010_dashboard_job_metrics.sql` adds nullable measurements on jobs/calls and two aggregate tables:

- `retained_job_stats`: UTC job-creation day, model, job count, all-attempt token sum, page sum, measured-page job count.
- `retained_job_duration_metrics`: UTC job-creation day, model, numeric duration in milliseconds, frequency count. Durations are elapsed intervals, not event timestamps.

It adds nullable priced/estimated/unpriced call coverage to `retained_model_metrics` and widens per-call cost to unrestricted decimal. All new tables have RLS enabled and aggregate constraints. They contain no instructor, user, document or job identifiers, filenames, document text, snippets, or raw errors.

Purge still deletes blobs first, then archives aggregates and cascades document deletion in one locked transaction. Retries cannot double-count. Dashboard history reads combine live and archived rows in one SQL snapshot. Aggregates are not subject to the 14-day document expiry. Browser copies and downloaded files are unaffected.

Already-purged page counts, timing and per-job cohort history cannot be reconstructed. No backfill is included. Current legacy jobs contribute their recorded token usage, but show unknown pages and processing duration until a new attempt records them.

Migration `0011_average_job_cost.sql` adds only aggregate job cost and measured/estimated job counts to `retained_job_stats`. Existing retained jobs have no reconstructable cohort cost and remain outside the cost average. New measured subsets accumulate independently, including when they share a day/model with older unmeasured jobs. These totals survive document deletion without retaining identifiers. The existing purge transaction preserves them exactly once, together with the other aggregates.

## Release

The average-cost card requires migration `0011` after the existing `0010` migration and before deploying the new code. The new migration is additive and does not delete data or reconstruct old costs. Apply it only to the intended database using the repository's verified-TLS migration process. The previous application remains compatible with the added aggregate fields. Publishing the branch is not activation: production migrations and deployment are separate release steps.

Local verification uses synthetic PDF fixtures, mocked conversion/provider calls, and an isolated PostgreSQL-compatible WASM database. It does not submit instructor documents or invoke the production purge. A production build must also verify the PDF parser file is traced and its worker receives a filesystem path, not a bundler module identifier.
