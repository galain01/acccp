import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { artifacts, conversionJobs, sessions } from "./db/schema";
import {
  DocumentUnavailableError,
  withRetainedDocument,
  type DocumentTransaction,
  type RetainedDocument,
} from "./document-retention";
import { retentionExpiresAt } from "./retention";
import { uploadObject } from "./storage";
import type { OutputTarget } from "./output-formats";

interface PublicationContext {
  sessionId: string;
  documentId: string;
  jobId: string;
  userId: string;
  attemptNumber: number;
  outputTarget: OutputTarget;
}

export interface GeneratedArtifact {
  artifactType:
    | "source_pdf"
    | "html_output"
    | "pdf_output"
    | "docx_output"
    | "pptx_output"
    | "review_metadata";
  filename: string;
  mimeType: string;
  body: Buffer | string;
  previewSnippet?: string | null;
  isUserDownloadable?: boolean;
}

export class PublicationUncertainError extends Error {
  constructor() {
    super(
      "Could not confirm the saved result. Refresh this document before trying again."
    );
    this.name = "PublicationUncertainError";
  }
}

/** Ownership and the attempt are rechecked while holding the document lock. */
async function ownedJob(
  tx: DocumentTransaction,
  document: RetainedDocument,
  context: PublicationContext
) {
  if (document.sessionId !== context.sessionId)
    throw new DocumentUnavailableError();
  const [job] = await tx
    .select({
      attemptNumber: conversionJobs.attemptCount,
      status: conversionJobs.status,
    })
    .from(conversionJobs)
    .innerJoin(sessions, eq(sessions.id, document.sessionId))
    .where(
      and(
        eq(conversionJobs.id, context.jobId),
        eq(conversionJobs.documentId, context.documentId),
        eq(conversionJobs.requestedByUserId, context.userId),
        eq(conversionJobs.outputTarget, context.outputTarget),
        eq(sessions.ownerUserId, context.userId),
        sql`${conversionJobs.expiresAt} > clock_timestamp()`
      )
    );
  if (!job) throw new DocumentUnavailableError();
  return job;
}

/**
 * Storage cannot roll back with Postgres. Commit discovery receipts first, then
 * publish immutable bytes and all result metadata in one retained transaction.
 * Failed/ambiguous uploads keep receipts until retention cleanup; never delete
 * bytes here because a rejected COMMIT may actually have succeeded.
 */
export async function publishConversionArtifacts(
  context: PublicationContext,
  generated: GeneratedArtifact[],
  persist: (
    tx: DocumentTransaction,
    document: RetainedDocument
  ) => Promise<void>,
  recordUsage: (tx: DocumentTransaction) => Promise<void>
): Promise<boolean> {
  const expectedOutput = {
    canvas_html: "html_output",
    accessible_pdf: "pdf_output",
    accessible_docx: "docx_output",
    accessible_pptx: "pptx_output",
  }[context.outputTarget];
  const types = generated.map((item) => item.artifactType);
  if (
    new Set(types).size !== types.length ||
    !types.includes("review_metadata") ||
    !types.includes(expectedOutput as GeneratedArtifact["artifactType"])
  ) {
    throw new Error("A publication requires its output and review.");
  }
  const publicationId = randomUUID();
  const receipts = generated.map((item) => ({
    ...item,
    id: randomUUID(),
    storageKey: `${context.sessionId}/${context.documentId}/${context.jobId}/publication-${publicationId}/${item.artifactType}`,
    checksumSha256: createHash("sha256").update(item.body).digest("hex"),
  }));
  // No uploads occur until this commit is acknowledged. An ambiguous reservation
  // is harmless: purge can discover it, and the failure path can record usage.
  const reserved = await withRetainedDocument(
    context.documentId,
    async (tx, document) => {
      const job = await ownedJob(tx, document, context);
      await recordUsage(tx);
      if (
        job.attemptNumber !== context.attemptNumber ||
        job.status !== "processing"
      )
        return false;
      for (const item of receipts) {
        await tx.insert(artifacts).values({
          id: item.id,
          jobId: context.jobId,
          artifactType: item.artifactType,
          artifactStatus: "expired",
          isUserDownloadable: false,
          filename:
            item.artifactType === "review_metadata"
              ? "conversion-publication.json"
              : item.filename,
          mimeType: item.mimeType,
          storageKey: item.storageKey,
          checksumSha256: item.checksumSha256,
          fileSizeBytes: Buffer.byteLength(item.body),
          expiresAt: retentionExpiresAt(document.createdAt),
        });
      }
      return true;
    }
  );
  if (!reserved) return false;

  try {
    return await withRetainedDocument(
      context.documentId,
      async (tx, document) => {
        const job = await ownedJob(tx, document, context);
        if (
          job.attemptNumber !== context.attemptNumber ||
          job.status !== "processing"
        )
          return false;
        const signal = AbortSignal.timeout(30_000);
        for (const item of receipts) {
          await uploadObject(item.storageKey, item.body, item.mimeType, {
            signal,
            upsert: false,
          });
        }
        await tx
          .update(artifacts)
          .set({ artifactStatus: "expired" })
          .where(
            and(
              eq(artifacts.jobId, context.jobId),
              inArray(artifacts.artifactType, types),
              eq(artifacts.artifactStatus, "available")
            )
          );
        for (const item of receipts) {
          const promoted = await tx
            .update(artifacts)
            .set({
              artifactStatus: "available",
              filename: item.filename,
              isUserDownloadable:
                item.isUserDownloadable ??
                item.artifactType !== "review_metadata",
              previewSnippet: item.previewSnippet ?? null,
            })
            .where(
              and(
                eq(artifacts.id, item.id),
                eq(artifacts.jobId, context.jobId),
                eq(artifacts.storageKey, item.storageKey),
                eq(artifacts.checksumSha256, item.checksumSha256),
                eq(artifacts.artifactStatus, "expired")
              )
            )
            .returning({ id: artifacts.id });
          if (promoted.length !== 1)
            throw new Error("Publication receipt unavailable.");
        }
        await persist(tx, document);
        return true;
      }
    );
  } catch (error) {
    if (error instanceof DocumentUnavailableError) throw error;
    // A transaction can commit on the server before its response is lost. Only
    // the full exact artifact set AND completed current attempt prove success.
    let recovered: "published" | "superseded" | "not-published";
    try {
      recovered = await withRetainedDocument(
        context.documentId,
        async (tx, document) => {
          const job = await ownedJob(tx, document, context);
          if (job.attemptNumber !== context.attemptNumber) return "superseded";
          const available = await tx
            .select()
            .from(artifacts)
            .where(
              and(
                eq(artifacts.jobId, context.jobId),
                inArray(
                  artifacts.id,
                  receipts.map((item) => item.id)
                ),
                eq(artifacts.artifactStatus, "available")
              )
            );
          const exact = receipts.every((item) =>
            available.some(
              (row) =>
                row.id === item.id &&
                row.storageKey === item.storageKey &&
                row.checksumSha256 === item.checksumSha256 &&
                row.artifactType === item.artifactType &&
                row.filename === item.filename &&
                row.mimeType === item.mimeType &&
                row.fileSizeBytes === Buffer.byteLength(item.body) &&
                row.isUserDownloadable ===
                  (item.isUserDownloadable ??
                    item.artifactType !== "review_metadata") &&
                Date.parse(row.expiresAt) ===
                  Date.parse(retentionExpiresAt(document.createdAt))
            )
          );
          if (
            job.status === "completed" &&
            exact &&
            available.length === receipts.length
          )
            return "published";
          if (job.status !== "processing") return "superseded";
          if (available.length) throw new PublicationUncertainError();
          return "not-published";
        }
      );
    } catch (recoveryError) {
      if (recoveryError instanceof DocumentUnavailableError)
        throw recoveryError;
      throw new PublicationUncertainError();
    }
    if (recovered === "published") return true;
    if (recovered === "superseded") return false;
    throw error;
  }
}
