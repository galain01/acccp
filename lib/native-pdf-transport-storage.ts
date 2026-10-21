import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { and, eq, gt, sql } from "drizzle-orm";
import { db } from "./db";
import { artifacts, conversionJobs, sessions } from "./db/schema";
import {
  withRetainedDocument,
  type DocumentTransaction,
  type RetainedDocument,
} from "./document-retention";
import { retentionExpiresAt } from "./retention";
import { createSignedUrl, removeObjects, uploadObject } from "./storage";
import type { NativePdfTransport } from "./native-pdf-worker";

const MAX_REQUEST_BYTES = 12 * 1024 * 1024;
const CLEANUP_TIMEOUT_MS = 10_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface TransportContext {
  documentId: string;
  jobId: string;
  sessionId: string;
  userId: string;
  attemptNumber: number;
}

function unavailable(): Error {
  // Provider exceptions can contain object keys or signed bearer URLs.
  return new Error("Could not prepare the private PDF repair request.");
}

async function authorize(
  tx: DocumentTransaction,
  document: RetainedDocument,
  context: TransportContext,
  signal: AbortSignal
): Promise<number> {
  if (signal.aborted || document.sessionId !== context.sessionId)
    throw unavailable();
  const [job] = await tx
    .select({ expiresAt: conversionJobs.expiresAt })
    .from(conversionJobs)
    .innerJoin(sessions, eq(sessions.id, document.sessionId))
    .where(
      and(
        eq(conversionJobs.id, context.jobId),
        eq(conversionJobs.documentId, context.documentId),
        eq(conversionJobs.requestedByUserId, context.userId),
        eq(conversionJobs.outputTarget, "accessible_pdf"),
        eq(conversionJobs.profileVersion, "pdf-v1"),
        eq(conversionJobs.status, "processing"),
        eq(conversionJobs.attemptCount, context.attemptNumber),
        gt(conversionJobs.expiresAt, sql`clock_timestamp()`),
        eq(sessions.ownerUserId, context.userId)
      )
    )
    .for("update", { of: conversionJobs });
  if (!job || signal.aborted) throw unavailable();
  const expiresAt = Math.min(
    Date.parse(job.expiresAt),
    Date.parse(retentionExpiresAt(document.createdAt))
  );
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now())
    throw unavailable();
  return expiresAt;
}

async function cleanup(
  key: string,
  receiptId: string,
  jobId: string,
  uploadSettled: boolean
) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // Cleanup has its own budget, even when the worker request was cancelled.
    await Promise.race([
      removeObjects([key], { signal: controller.signal }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(unavailable());
        }, CLEANUP_TIMEOUT_MS);
      }),
    ]);
    if (!uploadSettled) {
      // A failed upload response can hide a late server-side write. Keep its
      // receipt discoverable by purge even after an immediate delete succeeds.
      return;
    }
    await db.transaction(async (tx) => {
      await tx.execute(
        sql`select set_config('statement_timeout', '5000ms', true), set_config('lock_timeout', '2000ms', true)`
      );
      await tx
        .delete(artifacts)
        .where(
          and(
            eq(artifacts.id, receiptId),
            eq(artifacts.jobId, jobId),
            eq(artifacts.storageKey, key),
            eq(artifacts.artifactType, "review_metadata"),
            eq(artifacts.artifactStatus, "expired"),
            eq(artifacts.isUserDownloadable, false)
          )
        );
    });
  } catch {
    // Preserve the action's result/error and the committed cleanup receipt.
    console.error(
      "[native-pdf] temporary repair request awaits document cleanup"
    );
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Only the authenticated server route can choose the owned document/job context. */
export function createNativePdfTransport(
  context: TransportContext
): NativePdfTransport {
  if (
    ![
      context.documentId,
      context.jobId,
      context.sessionId,
      context.userId,
    ].every((value) => UUID.test(value)) ||
    !Number.isSafeInteger(context.attemptNumber) ||
    context.attemptNumber < 1
  )
    throw unavailable();

  return async (payload, signal, action) => {
    if (
      !Buffer.isBuffer(payload) ||
      payload.byteLength < 1 ||
      payload.byteLength > MAX_REQUEST_BYTES ||
      signal.aborted
    )
      throw unavailable();
    // The committed checksum and uploaded bytes must describe the same snapshot.
    const bytes = Buffer.from(payload);
    const requestSha256 = createHash("sha256").update(bytes).digest("hex");
    const receiptId = randomUUID();
    const key = `${context.sessionId}/${context.documentId}/${context.jobId}/native-pdf-request-${randomUUID()}.json`;
    try {
      // Commit discovery before the fallible upload. Rollback after a partial
      // upload must never erase the only path purge can use to find the bytes.
      await withRetainedDocument(context.documentId, async (tx, document) => {
        await authorize(tx, document, context, signal);
        await tx.insert(artifacts).values({
          id: receiptId,
          jobId: context.jobId,
          artifactType: "review_metadata",
          artifactStatus: "expired",
          filename: "native-pdf-request.json",
          mimeType: "application/json",
          storageKey: key,
          fileSizeBytes: bytes.byteLength,
          checksumSha256: requestSha256,
          isUserDownloadable: false,
          expiresAt: retentionExpiresAt(document.createdAt),
        });
      });
    } catch {
      throw unavailable();
    }

    let uploadStarted = false;
    let uploadCompleted = false;
    try {
      let requestUrl: string;
      try {
        requestUrl = await withRetainedDocument(
          context.documentId,
          async (tx, document) => {
            const expiresAt = await authorize(tx, document, context, signal);
            uploadStarted = true;
            await uploadObject(key, bytes, "application/json", { signal });
            uploadCompleted = true;
            if (signal.aborted) throw unavailable();
            const ttl = Math.min(
              60,
              Math.floor((expiresAt - Date.now()) / 1000) - 1
            );
            if (ttl < 1) throw unavailable();
            const url = await createSignedUrl(key, ttl, undefined, { signal });
            if (signal.aborted || Date.now() + ttl * 1000 > expiresAt)
              throw unavailable();
            return url;
          }
        );
      } catch {
        throw unavailable();
      }
      if (signal.aborted) throw unavailable();
      // Release the retention/job locks before the service reads and repairs.
      return await action({
        requestUrl,
        requestSha256,
        requestBytes: bytes.byteLength,
      });
    } finally {
      await cleanup(
        key,
        receiptId,
        context.jobId,
        !uploadStarted || uploadCompleted
      );
    }
  };
}
