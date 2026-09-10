import "server-only";

import { sql } from "drizzle-orm";
import type { DocumentTransaction } from "./document-retention";
import {
  conversionJobs,
  modelCalls,
  retainedJobMetrics,
  retainedModelMetrics,
} from "./db/schema";

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
      (day, model, stage, call_count, prompt_tokens, completion_tokens, cost_usd)
    select (${modelCalls.createdAt} at time zone 'UTC')::date,
      ${modelCalls.model}, ${modelCalls.stage}, count(*),
      sum(${modelCalls.promptTokens}), sum(${modelCalls.completionTokens}),
      sum(${modelCalls.costUsd})
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
      end
  `);
}
