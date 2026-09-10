import "server-only";

import { sql } from "drizzle-orm";
import type { DocumentTransaction } from "./document-retention";
import {
  conversionJobs,
  modelCalls,
  retainedJobMetrics,
  retainedJobStats,
  retainedJobDurationMetrics,
  retainedModelMetrics,
} from "./db/schema";
import {
  effectiveModelCallCostSql,
  estimatedModelCallSql,
} from "./model-cost-sql";

/**
 * The caller MUST hold the document row lock and hard-delete that document in
 * this same transaction. The deletion is the exactly-once marker: rollback
 * restores both source rows and totals, and a retry after commit finds no row.
 * No per-document receipt survives. Run only after all blob deletion succeeds.
 */
export async function archiveDocumentMetrics(
  tx: DocumentTransaction,
  documentId: string,
  beforeQuery?: () => Promise<void>
): Promise<void> {
  await beforeQuery?.();
  // There is one mutable job per document, so preserve its latest status once,
  // grouped by the UTC creation day, rather than counting reconversions as jobs.
  await tx.execute(sql`
    insert into ${retainedJobMetrics} (day, status, job_count)
    select (${conversionJobs.createdAt} at time zone 'UTC')::date,
      ${conversionJobs.status}, count(*)
    from ${conversionJobs}
    where ${conversionJobs.documentId} = ${documentId}
    group by 1, 2
    order by 1, 2
    on conflict (day, status) do update
    set job_count = ${retainedJobMetrics.jobCount} + excluded.job_count
  `);

  await beforeQuery?.();
  // Every recorded call counts, including earlier reconversions and failures.
  // Group in SQL so only daily totals (not raw records) leave these statements.
  // Consistent group ordering avoids opposite-order aggregate row locks when
  // concurrent purges contain overlapping day/model/stage groups.
  await tx.execute(sql`
    insert into ${retainedModelMetrics}
      (day, model, stage, call_count, prompt_tokens, completion_tokens, cost_usd,
        priced_call_count, estimated_call_count, unpriced_call_count)
    select (${modelCalls.createdAt} at time zone 'UTC')::date,
      ${modelCalls.model}, ${modelCalls.stage}, count(*),
      sum(${modelCalls.promptTokens}), sum(${modelCalls.completionTokens}),
      sum(${effectiveModelCallCostSql()}),
      count(*) filter (where ${effectiveModelCallCostSql()} is not null),
      count(*) filter (where ${estimatedModelCallSql()}),
      count(*) filter (where ${effectiveModelCallCostSql()} is null)
    from ${modelCalls}
    inner join ${conversionJobs} on ${modelCalls.jobId} = ${conversionJobs.id}
    where ${conversionJobs.documentId} = ${documentId}
    group by 1, 2, 3
    order by 1, 2, 3
    on conflict (day, model, stage) do update set
      call_count = ${retainedModelMetrics.callCount} + excluded.call_count,
      prompt_tokens = ${retainedModelMetrics.promptTokens} + excluded.prompt_tokens,
      completion_tokens = ${retainedModelMetrics.completionTokens} + excluded.completion_tokens,
      cost_usd = case
        when ${retainedModelMetrics.costUsd} is null and excluded.cost_usd is null then null
        else coalesce(${retainedModelMetrics.costUsd}, 0) + coalesce(excluded.cost_usd, 0)
      end,
      priced_call_count = ${retainedModelMetrics.pricedCallCount} + excluded.priced_call_count,
      estimated_call_count = ${retainedModelMetrics.estimatedCallCount} + excluded.estimated_call_count,
      unpriced_call_count = ${retainedModelMetrics.unpricedCallCount} + excluded.unpriced_call_count
  `);

  await beforeQuery?.();
  await tx.execute(sql`
    insert into ${retainedJobStats}
      (day, model, job_count, total_tokens, page_count_sum, page_measured_job_count)
    select (${conversionJobs.createdAt} at time zone 'UTC')::date,
      coalesce(nullif(btrim(${conversionJobs.modelName}), ''), 'unknown'), count(*),
      sum((select coalesce(sum(${modelCalls.promptTokens}::bigint + ${modelCalls.completionTokens}), 0)
        from ${modelCalls} where ${modelCalls.jobId} = ${conversionJobs.id})),
      sum(coalesce(${conversionJobs.pageCount}, 0)), count(${conversionJobs.pageCount})
    from ${conversionJobs}
    where ${conversionJobs.documentId} = ${documentId}
    group by 1, 2
    order by 1, 2
    on conflict (day, model) do update set
      job_count = ${retainedJobStats.jobCount} + excluded.job_count,
      total_tokens = ${retainedJobStats.totalTokens} + excluded.total_tokens,
      page_count_sum = ${retainedJobStats.pageCountSum} + excluded.page_count_sum,
      page_measured_job_count = ${retainedJobStats.pageMeasuredJobCount} + excluded.page_measured_job_count
  `);

  await beforeQuery?.();
  await tx.execute(sql`
    insert into ${retainedJobDurationMetrics} (day, model, duration_ms, job_count)
    select (${conversionJobs.createdAt} at time zone 'UTC')::date,
      coalesce(nullif(btrim(${conversionJobs.modelName}), ''), 'unknown'),
      ${conversionJobs.processingDurationMs}, count(*)
    from ${conversionJobs}
    where ${conversionJobs.documentId} = ${documentId}
      and ${conversionJobs.status} in ('completed', 'needs_review')
      and ${conversionJobs.processingDurationMs} is not null
      and ${conversionJobs.processingDurationMs} >= 0
    group by 1, 2, 3
    order by 1, 2, 3
    on conflict (day, model, duration_ms) do update
      set job_count = ${retainedJobDurationMetrics.jobCount} + excluded.job_count
  `);
}
