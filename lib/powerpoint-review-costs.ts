import "server-only";
import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { db } from "./db";
import {
  conversionJobs,
  documents,
  modelCalls,
  retainedModelMetrics,
} from "./db/schema";
import type { ModelCallUsage } from "./convert";

function callId(exportId: string, index: number): string {
  const bytes = createHash("sha256")
    .update(`pptx-review:${exportId}:${index}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Record completed review calls once, including a user deletion during the audit.
 * The document lock serializes with purge, but does not authorize any content
 * read/write or extend document availability. If purge already committed, only
 * anonymous usage survives; the deleted job's cost cohort cannot be revised.
 *
 * Call once per export. Existing call rows use deterministic IDs, but anonymous
 * totals intentionally retain no export/document receipt. Do not retry an
 * ambiguous commit: after purge there is no private identifier to deduplicate.
 */
export async function recordPowerPointReviewCalls(input: {
  documentId: string;
  jobId: string;
  exportId: string;
  calls: readonly ModelCallUsage[];
}): Promise<void> {
  if (!input.calls.length) return;
  const recordedAt = new Date().toISOString();
  await db.transaction(async (tx) => {
    await tx.execute(
      sql`select set_config('statement_timeout', '15000ms', true), set_config('lock_timeout', '5000ms', true)`
    );
    const [document] = await tx
      .select({ id: documents.id })
      .from(documents)
      .where(eq(documents.id, input.documentId))
      .for("update");
    if (document) {
      const [job] = await tx
        .select({ id: conversionJobs.id })
        .from(conversionJobs)
        .where(
          and(
            eq(conversionJobs.id, input.jobId),
            eq(conversionJobs.documentId, input.documentId)
          )
        );
      if (!job)
        throw new Error(
          "The review usage could not be associated with its job."
        );
      await tx
        .insert(modelCalls)
        .values(
          input.calls.map((call, index) => ({
            id: callId(input.exportId, index),
            jobId: input.jobId,
            stage: call.stage,
            model: call.model,
            promptTokens: call.promptTokens,
            completionTokens: call.completionTokens,
            cachedPromptTokens: call.cachedPromptTokens ?? null,
            cacheCreationPromptTokens: call.cacheCreationPromptTokens ?? null,
            costSource: call.costSource ?? null,
            costUsd: call.costUsd === null ? null : String(call.costUsd),
            createdAt: recordedAt,
          }))
        )
        .onConflictDoNothing({ target: modelCalls.id });
      return;
    }

    // One row per call keeps decimal addition inside PostgreSQL. Stable group
    // order prevents opposite-order locks when separate late audits overlap.
    const ordered = input.calls
      .map((call, index) => ({ call, index }))
      .sort(
        (a, b) =>
          a.call.model.localeCompare(b.call.model) ||
          a.call.stage.localeCompare(b.call.stage) ||
          a.index - b.index
      );
    for (const { call } of ordered) {
      const cost = call.costUsd === null ? null : String(call.costUsd);
      const priced = cost === null ? 0 : 1;
      const estimated = priced && call.costSource !== "gateway" ? 1 : 0;
      const unpriced = 1 - priced;
      await tx
        .insert(retainedModelMetrics)
        .values({
          day: recordedAt.slice(0, 10),
          model: call.model,
          stage: call.stage,
          callCount: 1,
          promptTokens: call.promptTokens,
          completionTokens: call.completionTokens,
          costUsd: cost,
          pricedCallCount: priced,
          estimatedCallCount: estimated,
          unpricedCallCount: unpriced,
        })
        .onConflictDoUpdate({
          target: [
            retainedModelMetrics.day,
            retainedModelMetrics.model,
            retainedModelMetrics.stage,
          ],
          set: {
            callCount: sql`${retainedModelMetrics.callCount} + 1`,
            promptTokens: sql`${retainedModelMetrics.promptTokens} + ${call.promptTokens}`,
            completionTokens: sql`${retainedModelMetrics.completionTokens} + ${call.completionTokens}`,
            costUsd: sql`case when ${retainedModelMetrics.costUsd} is null and ${cost}::numeric is null then null else coalesce(${retainedModelMetrics.costUsd}, 0) + coalesce(${cost}::numeric, 0) end`,
            pricedCallCount: sql`${retainedModelMetrics.pricedCallCount} + ${priced}`,
            estimatedCallCount: sql`${retainedModelMetrics.estimatedCallCount} + ${estimated}`,
            unpricedCallCount: sql`${retainedModelMetrics.unpricedCallCount} + ${unpriced}`,
          },
        });
    }
  });
}
