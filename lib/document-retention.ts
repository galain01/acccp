import "server-only";

import {
  and,
  asc,
  count,
  eq,
  gt,
  isNotNull,
  isNull,
  lte,
  notInArray,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { db } from "./db";
import { artifacts, conversionJobs, documents, sessions } from "./db/schema";
import { archiveDocumentMetrics } from "./retained-metrics";
import {
  htmlOutputKey,
  removeObjects,
  sourceDocxKey,
  sourcePdfKey,
} from "./storage";

export type DocumentTransaction = Parameters<
  Parameters<typeof db.transaction>[0]
>[0];
export type RetainedDocument = typeof documents.$inferSelect;

export class DocumentUnavailableError extends Error {
  constructor() {
    super("This document is no longer available.");
    this.name = "DocumentUnavailableError";
  }
}

// Hours, not calendar days: this remains exactly 14×24h across DST changes.
const databaseCutoff = () => sql`clock_timestamp() - interval '336 hours'`;

export function retainedDocumentCondition(): SQL {
  return and(
    isNull(documents.deletedAt),
    gt(documents.createdAt, databaseCutoff())
  )!;
}

function eligibleDocumentCondition(): SQL {
  return or(
    isNotNull(documents.deletedAt),
    lte(documents.createdAt, databaseCutoff())
  )!;
}

async function boundQueries(tx: DocumentTransaction, remainingMs = 15_000) {
  if (remainingMs <= 0) throw new Error("Purge time budget reached.");
  const statementMs = Math.max(1, Math.min(15_000, Math.floor(remainingMs)));
  const lockMs = Math.min(5_000, statementMs);
  // Transaction-local settings also reset when the transaction rolls back.
  await tx.execute(
    sql`select set_config('statement_timeout', ${`${statementMs}ms`}, true), set_config('lock_timeout', ${`${lockMs}ms`}, true)`
  );
}

/**
 * Callers must authorize ownership. Keep reads/writes of document blobs and
 * metadata inside action; keep model/rendering calls outside this transaction.
 * Purging uses the same document lock so late writes cannot recreate blobs.
 */
export async function withRetainedDocument<T>(
  documentId: string,
  action: (tx: DocumentTransaction, document: RetainedDocument) => Promise<T>
): Promise<T> {
  return db.transaction(async (tx) => {
    await boundQueries(tx);
    const [document] = await tx
      .select()
      .from(documents)
      .where(eq(documents.id, documentId))
      .for("update");
    if (!document) throw new DocumentUnavailableError();
    // Separate statement AFTER lock acquisition: transaction-start now() or a
    // pre-lock predicate could admit a document that expired while waiting.
    const [retained] = await tx
      .select({ id: documents.id })
      .from(documents)
      .where(and(eq(documents.id, documentId), retainedDocumentCondition()));
    if (!retained) throw new DocumentUnavailableError();
    const result = await action(tx, document);
    const [stillRetained] = await tx
      .select({ id: documents.id })
      .from(documents)
      .where(and(eq(documents.id, documentId), retainedDocumentCondition()));
    if (!stillRetained) throw new DocumentUnavailableError();
    return result;
  });
}

const STORAGE_TIMEOUT_MS = 10_000;
const STORAGE_DELETE_BATCH_SIZE = 100;
export const DEFAULT_PURGE_LIMIT = 200;
export const MAX_PURGE_LIMIT = 500;
export const DEFAULT_PURGE_DURATION_MS = 240_000;
export const MAX_PURGE_DURATION_MS = 250_000;

export interface PurgeOptions {
  dryRun?: boolean;
  limit?: number;
  maxDurationMs?: number;
}

export interface PurgeResult {
  dryRun: boolean;
  /** Eligible document count at the start; no private identifiers returned. */
  eligible: number;
  examined: number;
  purged: number;
  failed: number;
  hasMore: boolean;
  timeLimitReached: boolean;
  limitReached: boolean;
}

function boundedOption(
  value: number | undefined,
  fallback: number,
  maximum: number
) {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < 1)
    throw new RangeError("Invalid purge limit.");
  return Math.min(maximum, Math.floor(value));
}

async function removeWithinBudget(
  keys: string[],
  deadline: number
): Promise<void> {
  const timeoutMs = Math.min(STORAGE_TIMEOUT_MS, deadline - Date.now());
  if (timeoutMs <= 0) throw new Error("Purge time budget reached.");
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("Document storage cleanup timed out."));
    }, timeoutMs);
  });
  try {
    await Promise.race([
      (async () => {
        for (
          let offset = 0;
          offset < keys.length;
          offset += STORAGE_DELETE_BATCH_SIZE
        ) {
          if (controller.signal.aborted)
            throw new Error("Document storage cleanup timed out.");
          await removeObjects(
            keys.slice(offset, offset + STORAGE_DELETE_BATCH_SIZE),
            {
              signal: controller.signal,
            }
          );
        }
      })(),
      timeout,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

type PurgeAttempt =
  | { kind: "purged" | "failed"; id: string }
  | { kind: "none" };

async function purgeNextDocument(
  deadline: number,
  excludedIds: string[] = [],
  documentId?: string
): Promise<PurgeAttempt> {
  let selectedId: string | undefined;
  try {
    return await db.transaction(async (tx): Promise<PurgeAttempt> => {
      await boundQueries(tx, deadline - Date.now());
      const [document] = await tx
        .select({
          id: documents.id,
          sessionId: documents.sessionId,
        })
        .from(documents)
        .where(
          and(
            eligibleDocumentCondition(),
            documentId ? eq(documents.id, documentId) : undefined,
            excludedIds.length
              ? notInArray(documents.id, excludedIds)
              : undefined
          )
        )
        .orderBy(asc(documents.createdAt), asc(documents.id))
        .limit(1)
        .for("update", { skipLocked: true });
      if (!document) return { kind: "none" };
      selectedId = document.id;
      // Confirm eligibility under the acquired lock using the current DB clock.
      await boundQueries(tx, deadline - Date.now());
      const [eligible] = await tx
        .select({ id: documents.id })
        .from(documents)
        .where(and(eq(documents.id, document.id), eligibleDocumentCondition()));
      if (!eligible) return { kind: "none" };
      await boundQueries(tx, deadline - Date.now());
      const storedArtifacts = await tx
        .select({ storageKey: artifacts.storageKey })
        .from(artifacts)
        .innerJoin(conversionJobs, eq(artifacts.jobId, conversionJobs.id))
        .where(eq(conversionJobs.documentId, document.id));
      const keys = [
        ...new Set([
          sourceDocxKey(document.sessionId, document.id),
          sourcePdfKey(document.sessionId, document.id),
          htmlOutputKey(document.sessionId, document.id),
          ...storedArtifacts.map((artifact) => artifact.storageKey),
        ]),
      ];
      // Do not remove discovery metadata until every canonical and legacy blob
      // deletion succeeds. A partial failure leaves this row for the next run.
      await removeWithinBudget(keys, deadline);
      // Preserve only anonymous daily totals. This and the cascade commit
      // together, so failed deletion or retries cannot count a job/call twice.
      await archiveDocumentMetrics(tx, document.id, () =>
        boundQueries(tx, deadline - Date.now())
      );
      await boundQueries(tx, deadline - Date.now());
      // Existing FKs cascade to jobs, artifacts, findings, events and model calls.
      await tx.delete(documents).where(eq(documents.id, document.id));
      return { kind: "purged", id: document.id };
    });
  } catch {
    // Never log provider/SQL errors or artifact keys: they can contain content.
    console.error(
      "[retention] document purge failed",
      selectedId ?? "before-selection"
    );
    if (!selectedId)
      throw new Error("Could not select documents for retention cleanup.");
    return { kind: "failed", id: selectedId };
  }
}

/** For a committed tombstone or expired document; concurrent owners are skipped. */
export async function purgeDocumentIfEligible(
  documentId: string
): Promise<"purged" | "retained" | "failed"> {
  try {
    const result = await purgeNextDocument(Date.now() + 30_000, [], documentId);
    return result.kind === "none" ? "retained" : result.kind;
  } catch {
    return "failed";
  }
}

/** Commit the owner-authorized tombstone before any fallible network cleanup. */
export async function deleteOwnedDocument(
  documentId: string,
  userId: string
): Promise<void> {
  const marked = await db.transaction(async (tx) => {
    await boundQueries(tx);
    const [document] = await tx
      .select({ id: documents.id })
      .from(documents)
      .innerJoin(sessions, eq(documents.sessionId, sessions.id))
      .where(
        and(eq(documents.id, documentId), eq(sessions.ownerUserId, userId))
      )
      .for("update", { of: documents });
    if (!document) return false;
    await tx
      .update(documents)
      .set({ deletedAt: sql`clock_timestamp()` })
      .where(and(eq(documents.id, documentId), isNull(documents.deletedAt)));
    return true;
  });
  if (marked) await purgeDocumentIfEligible(documentId);
}

export async function purgeExpiredDocuments(
  options: PurgeOptions = {}
): Promise<PurgeResult> {
  const limit = boundedOption(
    options.limit,
    DEFAULT_PURGE_LIMIT,
    MAX_PURGE_LIMIT
  );
  const duration = boundedOption(
    options.maxDurationMs,
    DEFAULT_PURGE_DURATION_MS,
    MAX_PURGE_DURATION_MS
  );
  const deadline = Date.now() + duration;
  const eligible = await db.transaction(
    async (tx) => {
      await boundQueries(tx, deadline - Date.now());
      const [row] = await tx
        .select({ total: count() })
        .from(documents)
        .where(eligibleDocumentCondition());
      return Number(row?.total ?? 0);
    },
    { accessMode: "read only" }
  );
  const result: PurgeResult = {
    dryRun: options.dryRun ?? false,
    eligible,
    examined: 0,
    purged: 0,
    failed: 0,
    hasMore: eligible > 0,
    timeLimitReached: false,
    limitReached: false,
  };
  if (result.dryRun) return result;
  const attemptedIds: string[] = [];
  while (attemptedIds.length < limit && Date.now() < deadline) {
    const attempt = await purgeNextDocument(deadline, attemptedIds);
    if (attempt.kind === "none") break;
    attemptedIds.push(attempt.id);
    result.examined += 1;
    if (attempt.kind === "purged") result.purged += 1;
    else result.failed += 1;
  }
  result.timeLimitReached = Date.now() >= deadline;
  result.limitReached = attemptedIds.length >= limit;
  if (result.timeLimitReached || result.limitReached) {
    result.hasMore = true; // Conservative when there is no budget for another check.
  } else {
    // A skipped lock can leave an eligible document behind even if no candidate
    // was claimable. A normal MVCC read detects that without waiting on its lock.
    result.hasMore = await db.transaction(
      async (tx) => {
        await boundQueries(tx, deadline - Date.now());
        const [row] = await tx
          .select({ id: documents.id })
          .from(documents)
          .where(eligibleDocumentCondition())
          .limit(1);
        return Boolean(row);
      },
      { accessMode: "read only" }
    );
  }
  return result;
}
