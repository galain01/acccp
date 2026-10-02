import "server-only";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { and, eq } from "drizzle-orm";
import { artifacts, conversionJobs } from "./db/schema";
import { withRetainedDocument } from "./document-retention";
import {
  MAX_FILE_SIZE_BYTES,
  MAX_PPTX_OUTPUT_SIZE_BYTES,
  PPTX_MIME_TYPE,
} from "./document-input";
import { retentionExpiresAt } from "./retention";
import { createSignedUrl, removeObjects, uploadObject } from "./storage";
import {
  PowerPointRenderingError,
  renderPowerPointToPdf,
} from "./powerpoint-rendering";

function remainingTime(deadline: number): number {
  const remaining = Math.floor(deadline - performance.now());
  if (remaining < 1) throw new PowerPointRenderingError();
  return remaining;
}

/** The authenticated caller supplies the owned document/job, never a storage URL. */
export function createStoredPowerPointRenderer(
  documentId: string,
  sessionId: string,
  jobId: string
) {
  return async (buffer: Buffer, timeoutMs: number): Promise<Buffer> => {
    if (buffer.byteLength <= MAX_FILE_SIZE_BYTES)
      return renderPowerPointToPdf(buffer, timeoutMs);
    if (
      buffer.byteLength > MAX_PPTX_OUTPUT_SIZE_BYTES ||
      !Number.isFinite(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > 60_000
    )
      throw new PowerPointRenderingError();
    const deadline = performance.now() + timeoutMs;
    // Leave a small part of the same budget for best-effort deletion.
    const workDeadline = deadline - Math.min(2000, Math.floor(timeoutMs / 10));
    const signal = AbortSignal.timeout(remainingTime(workDeadline));
    const key = `${sessionId}/${documentId}/${jobId}/render-${randomUUID()}.pptx`;
    // Commit discovery before a fallible upload. Keep the receipt even after
    // cleanup, so ambiguous storage failures remain discoverable by purge.
    await withRetainedDocument(documentId, async (tx, document) => {
      remainingTime(workDeadline);
      if (document.sessionId !== sessionId)
        throw new PowerPointRenderingError();
      const [job] = await tx
        .select({ id: conversionJobs.id })
        .from(conversionJobs)
        .where(
          and(
            eq(conversionJobs.id, jobId),
            eq(conversionJobs.documentId, documentId)
          )
        );
      if (
        !job ||
        Date.parse(retentionExpiresAt(document.createdAt)) - Date.now() <
          timeoutMs + 30_000
      )
        throw new PowerPointRenderingError();
      remainingTime(workDeadline);
      await tx.insert(artifacts).values({
        jobId,
        artifactType: "source_pptx",
        artifactStatus: "expired",
        filename: "temporary-render-input.pptx",
        mimeType: PPTX_MIME_TYPE,
        storageKey: key,
        fileSizeBytes: buffer.byteLength,
        isUserDownloadable: false,
        expiresAt: retentionExpiresAt(document.createdAt),
      });
    });
    try {
      const downloadUrl = await withRetainedDocument(
        documentId,
        async (_tx, document) => {
          remainingTime(workDeadline);
          await uploadObject(key, buffer, PPTX_MIME_TYPE, { signal });
          remainingTime(workDeadline);
          const expiresAt = Date.parse(retentionExpiresAt(document.createdAt));
          const ttl = Math.min(
            60,
            Math.floor((expiresAt - Date.now()) / 1000) - 1
          );
          if (ttl < 1) throw new PowerPointRenderingError();
          const url = await createSignedUrl(key, ttl, "source.pptx", {
            signal,
          });
          remainingTime(workDeadline);
          // Signing latency must not extend access past the original expiry.
          if (Date.now() + ttl * 1000 > expiresAt)
            throw new PowerPointRenderingError();
          return url;
        }
      );
      const remaining = remainingTime(workDeadline);
      if (remaining < 1000) throw new PowerPointRenderingError();
      return await renderPowerPointToPdf(buffer, remaining, { downloadUrl });
    } finally {
      // Only a read capability was shared: deleting this copy cannot be undone
      // by the renderer. Retention still discovers it if immediate deletion fails.
      try {
        const cleanupSignal = AbortSignal.timeout(
          Math.min(10_000, remainingTime(deadline))
        );
        await withRetainedDocument(documentId, () => {
          remainingTime(deadline);
          return removeObjects([key], { signal: cleanupSignal });
        });
      } catch {
        console.error(
          "[powerpoint] temporary render input awaits document cleanup"
        );
      }
    }
  };
}
