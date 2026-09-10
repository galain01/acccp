"use server";

import { count, desc, eq, sql } from "drizzle-orm";

import { verifyRoleOrRedirect } from "@/lib/auth";
import { db } from "@/lib/db";
import { retainedDocumentCondition } from "@/lib/document-retention";
import {
  conversionJobs,
  documents,
  modelCalls,
  retainedJobMetrics,
  retainedModelMetrics,
  users,
} from "@/lib/db/schema";
import { isDocumentExpired } from "@/lib/retention";
import {
  effectiveModelCallCostSql,
  estimatedModelCallSql,
} from "@/lib/model-cost-sql";
import {
  type JobStatusSummary,
  summarizeJobStatusCounts,
  totalPages,
} from "@/lib/metrics-math";

const DEFAULT_PAGE_SIZE = 10;
const MAX_WINDOW_DAYS = 365;

async function requireAdmin(): Promise<void> {
  await verifyRoleOrRedirect(["admin"]);
}

/** Clamps an arbitrary caller-supplied window to a sane range. */
function clampDays(days: number): number {
  if (!Number.isFinite(days) || days <= 0) return 30;
  return Math.max(1, Math.min(Math.round(days), MAX_WINDOW_DAYS));
}

export interface UserRoleCounts {
  pending: number;
  instructor: number;
  admin: number;
}

export async function getUserRoleCounts(): Promise<UserRoleCounts> {
  await requireAdmin();

  const rows = await db
    .select({ role: users.role, count: count() })
    .from(users)
    .groupBy(users.role);

  const counts: UserRoleCounts = { pending: 0, instructor: 0, admin: 0 };
  for (const row of rows) {
    if (row.role in counts)
      counts[row.role as keyof UserRoleCounts] = row.count;
  }
  return counts;
}

export async function getJobStatusSummary(): Promise<JobStatusSummary> {
  await requireAdmin();

  const rows = await db
    .select({
      status: sql<string>`metrics.status`,
      count: sql<string>`sum(metrics.count)`,
    })
    // One statement sees either the live job or its retained aggregate. Two
    // separate reads could double-count or miss a job while purge commits.
    .from(
      sql`(
      select ${conversionJobs.status} as status, count(*) as count
      from ${conversionJobs} group by ${conversionJobs.status}
      union all
      select ${retainedJobMetrics.status} as status, sum(${retainedJobMetrics.jobCount}) as count
      from ${retainedJobMetrics} group by ${retainedJobMetrics.status}
    ) metrics`
    )
    .groupBy(sql`metrics.status`);

  const counts: Record<string, number> = {};
  for (const row of rows) counts[row.status] = Number(row.count);

  return summarizeJobStatusCounts(counts);
}

export interface TokenUsage {
  days: number;
  totalTokens: number;
}

/** UTC calendar days including today, matching the retained daily aggregates. */
export async function getTokenUsage(days = 30): Promise<TokenUsage> {
  await requireAdmin();
  const window = clampDays(days);

  const [row] = await db.select({
    totalTokens: sql<string>`coalesce(sum(usage.tokens), 0)`,
  }).from(sql`(
      select ${modelCalls.promptTokens}::bigint + ${modelCalls.completionTokens} as tokens
      from ${modelCalls}
      where (${modelCalls.createdAt} at time zone 'UTC')::date >=
        (now() at time zone 'UTC')::date - (${window}::integer - 1)
      union all
      select ${retainedModelMetrics.promptTokens} + ${retainedModelMetrics.completionTokens} as tokens
      from ${retainedModelMetrics}
      where ${retainedModelMetrics.day} >=
        (now() at time zone 'UTC')::date - (${window}::integer - 1)
    ) usage`);

  return { days: window, totalTokens: Number(row?.totalTokens ?? 0) };
}

export interface CostSummary {
  days: number;
  windowCostUsd: number | null;
  allTimeCostUsd: number | null;
}

export async function getCostSummary(days = 30): Promise<CostSummary> {
  await requireAdmin();
  const window = clampDays(days);

  const [row] = await db.select({
    windowCost: sql<string | null>`sum(usage.cost) filter (where usage.day >=
        (now() at time zone 'UTC')::date - (${window}::integer - 1))`,
    allTimeCost: sql<string | null>`sum(usage.cost)`,
  }).from(sql`(
      select (${modelCalls.createdAt} at time zone 'UTC')::date as day, ${effectiveModelCallCostSql()} as cost
      from ${modelCalls}
      union all
      select ${retainedModelMetrics.day} as day, ${retainedModelMetrics.costUsd} as cost
      from ${retainedModelMetrics}
    ) usage`);

  return {
    days: window,
    windowCostUsd: row?.windowCost != null ? Number(row.windowCost) : null,
    allTimeCostUsd: row?.allTimeCost != null ? Number(row.allTimeCost) : null,
  };
}

export interface PagedResult<T> {
  rows: T[];
  page: number;
  pageSize: number;
  totalCount: number;
  totalPages: number;
}

export interface RecentJobRow {
  jobId: string;
  filename: string;
  requestedByEmail: string;
  status: string;
  model: string | null;
  totalTokens: number;
  costUsd: number | null;
  createdAt: string;
  pageCount: number | null;
  processingDurationMs: number | null;
  attemptCount: number;
  estimatedCallCount: number;
  unpricedCallCount: number;
}

export async function listRecentJobs(
  page = 1,
  pageSize = DEFAULT_PAGE_SIZE
): Promise<PagedResult<RecentJobRow>> {
  await requireAdmin();
  const safePage = Number.isFinite(page) ? Math.max(1, Math.floor(page)) : 1;
  pageSize = Number.isFinite(pageSize)
    ? Math.max(1, Math.min(100, Math.floor(pageSize)))
    : DEFAULT_PAGE_SIZE;

  const [{ value: totalCount }] = await db
    .select({ value: count() })
    .from(conversionJobs)
    .innerJoin(documents, eq(documents.id, conversionJobs.documentId))
    .where(retainedDocumentCondition());

  const rows = await db
    .select({
      jobId: conversionJobs.id,
      filename: documents.originalFilename,
      requestedByEmail: users.email,
      status: conversionJobs.status,
      model: conversionJobs.modelName,
      totalTokens: sql<number>`coalesce(sum(${modelCalls.promptTokens} + ${modelCalls.completionTokens}), 0)`,
      costUsd: sql<string | null>`sum(${effectiveModelCallCostSql()})`,
      estimatedCallCount: sql<string>`count(${modelCalls.id}) filter (where ${estimatedModelCallSql()})`,
      unpricedCallCount: sql<string>`count(${modelCalls.id}) filter (where ${effectiveModelCallCostSql()} is null)`,
      pageCount: conversionJobs.pageCount,
      processingDurationMs: conversionJobs.processingDurationMs,
      attemptCount: conversionJobs.attemptCount,
      createdAt: conversionJobs.createdAt,
      documentCreatedAt: documents.createdAt,
    })
    .from(conversionJobs)
    .innerJoin(documents, eq(documents.id, conversionJobs.documentId))
    .innerJoin(users, eq(users.id, conversionJobs.requestedByUserId))
    .leftJoin(modelCalls, eq(modelCalls.jobId, conversionJobs.id))
    .where(retainedDocumentCondition())
    .groupBy(
      conversionJobs.id,
      documents.originalFilename,
      documents.createdAt,
      users.email,
      conversionJobs.status,
      conversionJobs.modelName,
      conversionJobs.createdAt
    )
    .orderBy(desc(conversionJobs.createdAt))
    .limit(pageSize)
    .offset((safePage - 1) * pageSize);

  const now = new Date();
  return {
    rows: rows
      .filter((row) => !isDocumentExpired(row.documentCreatedAt, now))
      .map((row) => ({
        jobId: row.jobId,
        filename: row.filename,
        requestedByEmail: row.requestedByEmail,
        status: row.status,
        model: row.model,
        totalTokens: Number(row.totalTokens),
        costUsd: row.costUsd != null ? Number(row.costUsd) : null,
        pageCount: row.pageCount ?? null,
        processingDurationMs:
          row.processingDurationMs != null
            ? Number(row.processingDurationMs)
            : null,
        attemptCount: Number(row.attemptCount ?? 1),
        estimatedCallCount: Number(row.estimatedCallCount ?? 0),
        unpricedCallCount: Number(row.unpricedCallCount ?? 0),
        createdAt: row.createdAt,
      })),
    page: safePage,
    pageSize,
    totalCount,
    totalPages: totalPages({ page: safePage, pageSize, totalCount }),
  };
}

export interface PendingUserRow {
  id: string;
  email: string;
  displayName: string;
  createdAt: Date;
}

export async function listPendingUsersPage(
  page = 1,
  pageSize = DEFAULT_PAGE_SIZE
): Promise<PagedResult<PendingUserRow>> {
  await requireAdmin();
  const safePage = Math.max(1, Math.floor(page));

  const [{ value: totalCount }] = await db
    .select({ value: count() })
    .from(users)
    .where(eq(users.role, "pending"));

  const rows = await db
    .select({
      id: users.id,
      email: users.email,
      displayName: users.displayName,
      createdAt: users.createdAt,
    })
    .from(users)
    .where(eq(users.role, "pending"))
    .orderBy(users.createdAt)
    .limit(pageSize)
    .offset((safePage - 1) * pageSize);

  return {
    rows,
    page: safePage,
    pageSize,
    totalCount,
    totalPages: totalPages({ page: safePage, pageSize, totalCount }),
  };
}
