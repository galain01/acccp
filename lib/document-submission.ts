import "server-only";
import { createHash } from "node:crypto";
import { and, count, eq, isNull, sql } from "drizzle-orm";
import { db } from "./db";
import { conversionJobs, documents, sessions, users } from "./db/schema";
import {
  DocumentUnavailableError,
  retainedDocumentCondition,
  withRetainedDocument,
  type DocumentTransaction,
  type RetainedDocument,
} from "./document-retention";
import {
  DOCX_MIME_TYPE,
  PDF_MIME_TYPE,
  PPTX_MIME_TYPE,
  isDocxFilename,
  isPptxFilename,
  maxFileSizeForFilename,
  validateDocumentInput,
} from "./document-input";
import { OUTPUT_PROFILES } from "./output-formats";
import { retentionExpiresAt } from "./retention";
import {
  downloadObjectBounded,
  sourceDocxKey,
  sourcePdfKey,
  uploadObject,
} from "./storage";
import {
  DocumentSubmissionError,
  issueSubmissionToken,
  isSubmissionMetadata,
  readSubmissionToken,
  type SubmissionClaims,
  type SubmissionMetadata,
} from "./document-submission-token";

async function ownedSession(
  tx: Pick<DocumentTransaction, "select">,
  userId: string,
  sessionId: string
) {
  const [owned] = await tx
    .select({ id: sessions.id })
    .from(sessions)
    .where(
      and(
        eq(sessions.id, sessionId),
        eq(sessions.ownerUserId, userId),
        isNull(sessions.archivedAt)
      )
    );
  if (!owned) throw new DocumentSubmissionError("Session not found.", 404);
}
export async function prepareDocumentSubmission(
  userId: string,
  input: SubmissionMetadata
) {
  if (!isSubmissionMetadata(input))
    throw new DocumentSubmissionError(
      "Choose a supported document and output format."
    );
  await ownedSession(db, userId, input.sessionId);
  // No rows, storage capabilities or model work exist until the browser learns ID.
  return issueSubmissionToken(userId, input);
}

function matches(document: RetainedDocument, claims: SubmissionClaims) {
  return (
    document.id === claims.documentId &&
    document.sessionId === claims.sessionId &&
    document.uploadedByUserId === claims.userId &&
    document.originalFilename === claims.filename &&
    document.fileSizeBytes === claims.fileSizeBytes &&
    document.checksumSha256 === claims.checksumSha256 &&
    document.mimeType ===
      (isPptxFilename(claims.filename)
        ? PPTX_MIME_TYPE
        : isDocxFilename(claims.filename)
          ? DOCX_MIME_TYPE
          : PDF_MIME_TYPE)
  );
}

/** The owner lock serializes first persistence and cancellation, even without a document row. */
async function reserveOrCancel(
  userId: string,
  token: string,
  cancel: boolean
): Promise<SubmissionClaims> {
  const claims = readSubmissionToken(token, userId, { allowExpired: true });
  await db.transaction(async (tx) => {
    await tx.execute(
      sql`select set_config('statement_timeout', '15000ms', true), set_config('lock_timeout', '5000ms', true)`
    );
    const [owner] = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, userId))
      .for("update");
    if (!owner) throw new DocumentSubmissionError("Account not found.", 404);
    await ownedSession(tx, userId, claims.sessionId);
    let [document] = await tx
      .select()
      .from(documents)
      .where(eq(documents.id, claims.documentId))
      .for("update");
    if (document) {
      if (!matches(document, claims))
        throw new DocumentSubmissionError(
          "The upload identity does not match this file.",
          409
        );
      if (cancel) {
        await tx
          .update(documents)
          .set({
            deletedAt: sql`coalesce(${documents.deletedAt}, clock_timestamp())`,
          })
          .where(eq(documents.id, claims.documentId));
        return;
      }
      const [retained] = await tx
        .select({ id: documents.id })
        .from(documents)
        .where(
          and(eq(documents.id, claims.documentId), retainedDocumentCondition())
        );
      if (!retained)
        throw new DocumentSubmissionError(
          "This upload is no longer available.",
          410
        );
      const [job] = await tx
        .select({
          target: conversionJobs.outputTarget,
          userId: conversionJobs.requestedByUserId,
        })
        .from(conversionJobs)
        .where(eq(conversionJobs.documentId, claims.documentId));
      if (!job || job.target !== claims.outputTarget || job.userId !== userId)
        throw new DocumentSubmissionError(
          "The upload identity does not match this output format.",
          409
        );
      return;
    }
    // Expired preparations may inspect existing state, but can never create or
    // recreate an ID. Cancellation after expiry is safe when the row is absent.
    const [clock] = await tx
      .select({ now: sql<string>`clock_timestamp()::text` })
      .from(users)
      .where(eq(users.id, userId));
    if (!clock || claims.expiresAt <= Date.parse(clock.now)) {
      if (cancel) return;
      throw new DocumentSubmissionError(
        "This upload preparation has expired. Select the file again.",
        410
      );
    }
    if (!cancel) {
      const [pending] = await tx
        .select({ total: count() })
        .from(documents)
        .where(
          and(
            eq(documents.uploadedByUserId, userId),
            isNull(documents.uploadCompletedAt),
            sql`${documents.uploadExpiresAt} > clock_timestamp() - interval '1 hour'`
          )
        );
      if (Number(pending?.total ?? 0) >= 3)
        throw new DocumentSubmissionError(
          "Finish an existing upload before starting another.",
          429
        );
    }
    // PPTX URLs last two hours. The fixed token deadline plus 125 minutes covers
    // every re-sign allowed during preparation, without extending content expiry.
    const uploadExpiresAt = new Date(
      claims.expiresAt + (isPptxFilename(claims.filename) ? 125 * 60_000 : 0)
    ).toISOString();
    const inserted = await tx
      .insert(documents)
      .values({
        id: claims.documentId,
        sessionId: claims.sessionId,
        uploadedByUserId: userId,
        originalFilename: claims.filename,
        fileSizeBytes: claims.fileSizeBytes,
        checksumSha256: claims.checksumSha256,
        mimeType: isPptxFilename(claims.filename)
          ? PPTX_MIME_TYPE
          : isDocxFilename(claims.filename)
            ? DOCX_MIME_TYPE
            : PDF_MIME_TYPE,
        uploadExpiresAt,
        // A missing-ID cancellation wins the same owner lock before any source
        // or bearer can be issued. Mark only this tombstone settled; cancelled
        // existing reservations can still have live writes and keep their cap.
        ...(cancel
          ? {
              deletedAt: sql`clock_timestamp()`,
              uploadCompletedAt: sql`clock_timestamp()`,
            }
          : {}),
      })
      .onConflictDoNothing({ target: documents.id })
      .returning();
    document = inserted[0];
    // A cross-owner UUID collision must never adopt or alter another document.
    if (!document)
      throw new DocumentSubmissionError(
        "The upload identity is already in use. Select the file again.",
        409
      );
    if (!cancel)
      await tx.insert(conversionJobs).values({
        documentId: document.id,
        requestedByUserId: userId,
        outputTarget: claims.outputTarget,
        profileVersion: OUTPUT_PROFILES[claims.outputTarget].version,
        status: "queued",
        attemptCount: 0,
        expiresAt: retentionExpiresAt(document.createdAt),
      });
  });
  return claims;
}
export const reserveDocumentSubmission = (userId: string, token: string) =>
  reserveOrCancel(userId, token, false);
export async function cancelDocumentSubmission(
  userId: string,
  token: string
): Promise<void> {
  await reserveOrCancel(userId, token, true);
}

/** A replay of the initial submission must never become a new billable attempt. */
export async function assertSubmissionCanStart(
  tx: DocumentTransaction,
  claims: SubmissionClaims
) {
  const [job] = await tx
    .select({
      attemptNumber: conversionJobs.attemptCount,
      status: conversionJobs.status,
      unexpired: sql<boolean>`${new Date(claims.expiresAt).toISOString()}::timestamptz > clock_timestamp()`,
    })
    .from(conversionJobs)
    .where(
      and(
        eq(conversionJobs.documentId, claims.documentId),
        eq(conversionJobs.outputTarget, claims.outputTarget),
        eq(conversionJobs.requestedByUserId, claims.userId)
      )
    );
  if (!job || job.attemptNumber !== 0 || job.status !== "queued")
    throw new DocumentSubmissionError(
      "This upload has already been submitted. Refresh its saved result before starting another conversion.",
      409
    );
  if (!job.unexpired)
    throw new DocumentSubmissionError(
      "This upload preparation has expired. Refresh the saved document before trying again.",
      410
    );
}

export async function assertSubmissionWindowOpen(
  tx: DocumentTransaction,
  claims: SubmissionClaims
) {
  const [window] = await tx
    .select({
      open: sql<boolean>`clock_timestamp() < ${new Date(claims.expiresAt).toISOString()}::timestamptz`,
    })
    .from(documents)
    .where(eq(documents.id, claims.documentId));
  if (!window?.open)
    throw new DocumentSubmissionError(
      "This upload preparation has expired. Refresh the saved document before trying again.",
      410
    );
}

function sourceMatches(bytes: Buffer, claims: SubmissionClaims) {
  return (
    bytes.length === claims.fileSizeBytes &&
    createHash("sha256").update(bytes).digest("hex") === claims.checksumSha256
  );
}
export async function persistSubmissionSource(
  userId: string,
  token: string,
  buffer: Buffer
): Promise<SubmissionClaims> {
  const claims = readSubmissionToken(token, userId, { allowExpired: true });
  if (isPptxFilename(claims.filename))
    throw new DocumentSubmissionError("Use the presentation uploader.");
  if (
    !sourceMatches(buffer, claims) ||
    validateDocumentInput(buffer, claims.filename)
  )
    throw new DocumentSubmissionError(
      "The uploaded source does not match its preparation.",
      415
    );
  await reserveDocumentSubmission(userId, token);
  await withRetainedDocument(claims.documentId, async (tx, document) => {
    await ownedSession(tx, userId, claims.sessionId);
    if (!matches(document, claims))
      throw new DocumentSubmissionError(
        "The upload identity does not match this file.",
        409
      );
    const key = isDocxFilename(claims.filename)
      ? sourceDocxKey(claims.sessionId, claims.documentId)
      : sourcePdfKey(claims.sessionId, claims.documentId);
    if (!document.uploadCompletedAt) {
      readSubmissionToken(token, userId); // An expired preparation cannot write bytes.
      await assertSubmissionWindowOpen(tx, claims);
      try {
        await uploadObject(key, buffer, document.mimeType, {
          upsert: false,
          signal: AbortSignal.timeout(30_000),
        });
      } catch {
        // The object may exist despite a rejected response. Read exact bytes;
        // never overwrite or delete an uncertain original.
        let stored: Buffer;
        try {
          stored = await downloadObjectBounded(
            key,
            maxFileSizeForFilename(claims.filename)
          );
        } catch {
          throw new DocumentSubmissionError(
            "Could not confirm the source upload. Refresh before trying again.",
            503
          );
        }
        if (!sourceMatches(stored, claims))
          throw new DocumentSubmissionError(
            "The stored source does not match this file. Select the file again.",
            409
          );
      }
      await tx
        .update(documents)
        .set({ uploadCompletedAt: sql`clock_timestamp()` })
        .where(eq(documents.id, claims.documentId));
    }
  }).catch((error) => {
    if (error instanceof DocumentUnavailableError)
      throw new DocumentSubmissionError(
        "This upload is no longer available.",
        410
      );
    throw error;
  });
  return claims;
}
