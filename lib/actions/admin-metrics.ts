"use server";

import { count, desc, eq, sql } from "drizzle-orm";

import { verifyRoleOrRedirect } from "@/lib/auth";
import { db } from "@/lib/db";
import { retainedDocumentCondition } from "@/lib/document-retention";
import { conversionJobs, documents, modelCalls, users } from "@/lib/db/schema";
import { isDocumentExpired } from "@/lib/retention";
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
  return Math.min(Math.round(days), MAX_WINDOW_DAYS);
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
    .select({ status: conversionJobs.status, count: count() })
    .from(conversionJobs)
    .groupBy(conversionJobs.status);

  const counts: Record<string, number> = {};
  for (const row of rows) counts[row.status] = row.count;

  return summarizeJobStatusCounts(counts);
}

export interface TokenUsage {
  days: number;
  totalTokens: number;
}

/** `days` is a parameter (not hardcoded) so callers can query other windows. */
export async function getTokenUsage(days = 30): Promise<TokenUsage> {
  await requireAdmin();
  const window = clampDays(days);

  const [row] = await db
    .select({
      totalTokens: sql<number>`coalesce(sum(${modelCalls.promptTokens} + ${modelCalls.completionTokens}), 0)`,
    })
    .from(modelCalls)
    .where(
      sql`${modelCalls.createdAt} >= now() - (${window} * interval '1 day')`
    );

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

  const [windowRow] = await db
    .select({ cost: sql<string | null>`sum(${modelCalls.costUsd})` })
    .from(modelCalls)
    .where(
      sql`${modelCalls.createdAt} >= now() - (${window} * interval '1 day')`
    );

  const [allTimeRow] = await db
    .select({ cost: sql<string | null>`sum(${modelCalls.costUsd})` })
    .from(modelCalls);

  return {
    days: window,
    windowCostUsd: windowRow?.cost != null ? Number(windowRow.cost) : null,
    allTimeCostUsd: allTimeRow?.cost != null ? Number(allTimeRow.cost) : null,
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
}

export async function listRecentJobs(
  page = 1,
  pageSize = DEFAULT_PAGE_SIZE
): Promise<PagedResult<RecentJobRow>> {
  await requireAdmin();
  const safePage = Math.max(1, Math.floor(page));

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
      costUsd: sql<string | null>`sum(${modelCalls.costUsd})`,
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
        totalTokens: row.totalTokens,
        costUsd: row.costUsd != null ? Number(row.costUsd) : null,
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
