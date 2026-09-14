import "server-only";

import { sql } from "drizzle-orm";
import type { DocumentTransaction } from "./document-retention";
import { dailyFailureMetrics } from "./db/schema";
import { createJobDiagnostic, type JobDiagnostic } from "./job-diagnostics";

/** Called once in the same transaction as each failed-attempt event. */
export async function recordFailureCount(
  tx: Pick<DocumentTransaction, "insert">,
  input: JobDiagnostic,
  failedAt: string
): Promise<void> {
  const diagnostic = createJobDiagnostic(input);
  // Use the event's UTC day, so crossing midnight cannot put its aggregate in
  // a different day. No identifiers, request IDs, model strings or text survive.
  await tx
    .insert(dailyFailureMetrics)
    .values({
      day: failedAt.slice(0, 10),
      stage: diagnostic.stage,
      code: diagnostic.code,
      failureCount: 1,
    })
    .onConflictDoUpdate({
      target: [
        dailyFailureMetrics.day,
        dailyFailureMetrics.stage,
        dailyFailureMetrics.code,
      ],
      set: { failureCount: sql`${dailyFailureMetrics.failureCount} + 1` },
    });
}
