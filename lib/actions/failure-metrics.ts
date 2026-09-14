"use server";

import { and, desc, gte, lte, sql } from "drizzle-orm";
import { verifyRoleOrRedirect } from "@/lib/auth";
import { db } from "@/lib/db";
import { dailyFailureMetrics } from "@/lib/db/schema";
import {
  validateMetricsHistoryRange,
  type MetricsHistoryRange,
} from "@/lib/admin-metrics-history";
import {
  readJobDiagnostic,
  type DiagnosticStage,
  type DiagnosticCode,
} from "@/lib/job-diagnostics";

export interface FailureSummaryRow {
  stage: DiagnosticStage;
  code: DiagnosticCode;
  count: number;
}

export async function getFailureSummary(
  input: MetricsHistoryRange
): Promise<FailureSummaryRow[]> {
  await verifyRoleOrRedirect(["admin"]);
  const range = validateMetricsHistoryRange(input);
  const count = sql<string>`sum(${dailyFailureMetrics.failureCount})`;
  const rows = await db
    .select({
      stage: dailyFailureMetrics.stage,
      code: dailyFailureMetrics.code,
      count,
    })
    .from(dailyFailureMetrics)
    .where(
      and(
        range.from ? gte(dailyFailureMetrics.day, range.from) : undefined,
        lte(dailyFailureMetrics.day, range.to)
      )
    )
    .groupBy(dailyFailureMetrics.stage, dailyFailureMetrics.code)
    .orderBy(desc(count), dailyFailureMetrics.stage, dailyFailureMetrics.code);
  return rows.flatMap((row) => {
    const diagnostic = readJobDiagnostic({
      version: 1,
      stage: row.stage,
      code: row.code,
    });
    const amount = Number(row.count);
    return diagnostic && Number.isSafeInteger(amount) && amount > 0
      ? [{ stage: diagnostic.stage, code: diagnostic.code, count: amount }]
      : [];
  });
}
