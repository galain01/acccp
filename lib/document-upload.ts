import "server-only";
import { createHash } from "node:crypto";
import { and, count, eq, isNull, sql } from "drizzle-orm";
import { db } from "./db";
import { documents, sessions, users } from "./db/schema";
import { withRetainedDocument } from "./document-retention";
import {
  MAX_PPTX_FILE_SIZE_BYTES,
  PPTX_MIME_TYPE,
  validateDocumentInput,
} from "./document-input";
import {
  createSignedUploadUrl,
  downloadObjectBounded,
  sourcePptxKey,
  StorageObjectSizeError,
} from "./storage";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export class DocumentUploadError extends Error {
  constructor(
    message: string,
    readonly status = 400
  ) {
    super(message);
  }
}
export interface PowerPointUploadRequest {
  sessionId: string;
  filename: string;
  fileSizeBytes: number;
  checksumSha256: string;
}

export function isPowerPointUploadRequest(
  value: unknown
): value is PowerPointUploadRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return (
    Object.keys(v).length === 4 &&
    typeof v.sessionId === "string" &&
    UUID.test(v.sessionId) &&
    typeof v.filename === "string" &&
    v.filename.length <= 240 &&
    v.filename.trim() === v.filename &&
    /^[^\x00-\x1f\x7f/\\]+\.pptx$/i.test(v.filename) &&
    Number.isSafeInteger(v.fileSizeBytes) &&
    Number(v.fileSizeBytes) > 0 &&
    Number(v.fileSizeBytes) <= MAX_PPTX_FILE_SIZE_BYTES &&
    typeof v.checksumSha256 === "string" &&
    /^[a-f0-9]{64}$/.test(v.checksumSha256)
  );
}

async function ownedSession(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  userId: string,
  sessionId: string
) {
  const [session] = await tx
    .select({ id: sessions.id })
    .from(sessions)
    .where(
      and(
        eq(sessions.id, sessionId),
        eq(sessions.ownerUserId, userId),
        isNull(sessions.archivedAt)
      )
    );
  if (!session) throw new DocumentUploadError("Session not found.", 404);
}

export async function reservePowerPointUpload(
  userId: string,
  input: PowerPointUploadRequest
) {
  if (!isPowerPointUploadRequest(input))
    throw new DocumentUploadError(
      "Choose a PowerPoint presentation no larger than 25 MB."
    );
  const document = await db.transaction(async (tx) => {
    await tx.execute(
      sql`select set_config('statement_timeout', '15000ms', true), set_config('lock_timeout', '5000ms', true)`
    );
    // Lock the owner, so simultaneous requests in different sessions share the cap.
    const [owner] = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, userId))
      .for("update");
    if (!owner) throw new DocumentUploadError("Account not found.", 404);
    await ownedSession(tx, userId, input.sessionId);
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
      throw new DocumentUploadError(
        "Finish an existing presentation upload before starting another. Abandoned uploads clear after their upload window ends.",
        429
      );
    // Commit a conservative 2h + 5m capability deadline before contacting Storage.
    // A failed or interrupted signing request must leave a cleanup receipt.
    const [saved] = await tx
      .insert(documents)
      .values({
        sessionId: input.sessionId,
        uploadedByUserId: userId,
        originalFilename: input.filename,
        mimeType: PPTX_MIME_TYPE,
        fileSizeBytes: input.fileSizeBytes,
        checksumSha256: input.checksumSha256,
        uploadExpiresAt: sql`clock_timestamp() + interval '125 minutes'`,
      })
      .returning({ id: documents.id });
    return saved;
  });
  return withRetainedDocument(document.id, async (tx, reserved) => {
    await ownedSession(tx, userId, input.sessionId);
    if (
      reserved.uploadedByUserId !== userId ||
      reserved.sessionId !== input.sessionId
    )
      throw new DocumentUploadError("Presentation not found.", 404);
    const signed = await createSignedUploadUrl(
      sourcePptxKey(input.sessionId, document.id)
    );
    if (
      !reserved.uploadExpiresAt ||
      Date.parse(signed.expiresAt) > Date.parse(reserved.uploadExpiresAt)
    )
      throw new DocumentUploadError(
        "Could not prepare the presentation upload. Try again.",
        503
      );
    // Record the actual provider deadline before the bearer URL reaches the client.
    await tx
      .update(documents)
      .set({ uploadExpiresAt: signed.expiresAt })
      .where(eq(documents.id, document.id));
    return { documentId: document.id, uploadUrl: signed.uploadUrl };
  });
}

export async function readAndFinalizePowerPointUpload(input: {
  userId: string;
  sessionId: string;
  documentId: string;
}): Promise<{ buffer: Buffer; filename: string }> {
  if (!UUID.test(input.sessionId) || !UUID.test(input.documentId))
    throw new DocumentUploadError("Presentation not found.", 404);
  return withRetainedDocument(input.documentId, async (tx, document) => {
    await ownedSession(tx, input.userId, input.sessionId);
    if (
      document.sessionId !== input.sessionId ||
      document.uploadedByUserId !== input.userId ||
      document.mimeType !== PPTX_MIME_TYPE
    )
      throw new DocumentUploadError("Presentation not found.", 404);
    let buffer: Buffer;
    try {
      buffer = await downloadObjectBounded(
        sourcePptxKey(input.sessionId, input.documentId),
        MAX_PPTX_FILE_SIZE_BYTES
      );
    } catch (error) {
      if (error instanceof StorageObjectSizeError)
        throw new DocumentUploadError(
          "The uploaded presentation exceeds 25 MB.",
          413
        );
      throw new DocumentUploadError(
        "The presentation upload is not ready. Finish uploading and try again.",
        409
      );
    }
    if (
      buffer.length !== document.fileSizeBytes ||
      (document.checksumSha256 &&
        createHash("sha256").update(buffer).digest("hex") !==
          document.checksumSha256)
    )
      throw new DocumentUploadError(
        "The uploaded presentation does not match the selected file. Upload it again.",
        415
      );
    const invalid = validateDocumentInput(buffer, document.originalFilename);
    if (invalid) throw new DocumentUploadError(invalid, 415);
    if (document.uploadExpiresAt && !document.uploadCompletedAt)
      await tx
        .update(documents)
        .set({ uploadCompletedAt: sql`clock_timestamp()` })
        .where(eq(documents.id, document.id));
    return { buffer, filename: document.originalFilename };
  });
}
