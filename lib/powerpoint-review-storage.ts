import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { AccessibilityError } from "./accessibility-findings";
import {
  artifacts,
  conversionJobs,
  documents,
  jobEvents,
  sessions,
  validationFindings,
} from "./db/schema";
import {
  DocumentUnavailableError,
  retainedDocumentCondition,
  withRetainedDocument,
  type DocumentTransaction,
} from "./document-retention";
import { outputFilename } from "./output-formats";
import { retentionExpiresAt } from "./retention";
import {
  createSignedUrl,
  downloadObject,
  sourcePptxKey,
  uploadObject,
  PPTX_MIME_TYPE,
} from "./storage";
import { replayPptxRevisions } from "./pptx-revisions";
import { recheckPowerPointRevision } from "./powerpoint-convert";
import { recordPowerPointReviewCalls } from "./powerpoint-review-costs";
import type { PptxRevisionBundle } from "./pptx-types";
import {
  isPowerPointReviewSelection,
  type PowerPointReviewData,
  type PowerPointReviewExport,
  type PowerPointReviewPreview,
  type PowerPointReviewSelection,
} from "./powerpoint-review-contract";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_REVIEW_BYTES = 16 * 1024 * 1024;
const LEASE_MS = 300_000;
export class PowerPointReviewError extends Error {
  constructor(
    message: string,
    readonly status = 409
  ) {
    super(message);
  }
}

interface StoredReview {
  outputTarget: "accessible_pptx";
  profileVersion: string;
  revisions: PptxRevisionBundle;
  changes: string[];
  findings: AccessibilityError[];
  reviewPreviews?: PowerPointReviewPreview[];
  selection?: Pick<
    PowerPointReviewSelection,
    "includedChangeIds" | "reviewedChangeIds" | "descriptionEdits"
  >;
}
const token = (body: Buffer) => createHash("sha256").update(body).digest("hex");

function parseReview(body: Buffer): StoredReview | null {
  if (body.length > MAX_REVIEW_BYTES)
    throw new PowerPointReviewError("This saved review is too large to open.");
  const value = JSON.parse(body.toString("utf8")) as StoredReview;
  if (!value || value.outputTarget !== "accessible_pptx" || !value.revisions)
    return null;
  if (
    value.revisions.version !== 1 ||
    !Array.isArray(value.revisions.changes) ||
    value.revisions.changes.length > 2000 ||
    !Array.isArray(value.findings)
  )
    throw new PowerPointReviewError(
      "This saved review could not be read. Convert the original presentation again."
    );
  return value;
}

async function ownedJob(
  tx: DocumentTransaction,
  userId: string,
  documentId: string,
  jobId: string
) {
  const [row] = await tx
    .select({
      sessionId: documents.sessionId,
      filename: documents.originalFilename,
      attemptNumber: conversionJobs.attemptCount,
      status: conversionJobs.status,
    })
    .from(conversionJobs)
    .innerJoin(documents, eq(documents.id, conversionJobs.documentId))
    .innerJoin(sessions, eq(sessions.id, documents.sessionId))
    .where(
      and(
        eq(documents.id, documentId),
        eq(conversionJobs.id, jobId),
        eq(sessions.ownerUserId, userId),
        eq(conversionJobs.outputTarget, "accessible_pptx"),
        retainedDocumentCondition()
      )
    );
  if (!row) throw new DocumentUnavailableError();
  if (row.status !== "completed")
    throw new PowerPointReviewError(
      "Wait for this presentation to finish converting, then reopen its review."
    );
  return row;
}

async function storedReview(tx: DocumentTransaction, jobId: string) {
  const [row] = await tx
    .select({ storageKey: artifacts.storageKey })
    .from(artifacts)
    .where(
      and(
        eq(artifacts.jobId, jobId),
        eq(artifacts.artifactType, "review_metadata"),
        eq(artifacts.artifactStatus, "available")
      )
    );
  if (!row) return null;
  const body = await downloadObject(row.storageKey);
  const record = parseReview(body);
  return record
    ? { record, revisionToken: token(body), storageKey: row.storageKey }
    : null;
}

/** Caller supplies authenticated identity; no client-provided paths or plans are used. */
export async function readOwnedPowerPointReview(
  userId: string,
  documentId: string,
  jobId: string
): Promise<PowerPointReviewData | null> {
  if (!UUID.test(documentId) || !UUID.test(jobId)) return null;
  return withRetainedDocument(documentId, async (tx) => {
    await ownedJob(tx, userId, documentId, jobId);
    const saved = await storedReview(tx, jobId);
    if (!saved) return null;
    const { record } = saved;
    const result: PowerPointReviewData = {
      revisionToken: saved.revisionToken,
      changes: record.revisions.changes,
      findings: record.findings,
      includedChangeIds:
        record.selection?.includedChangeIds ??
        record.revisions.changes.map((change) => change.id),
      reviewedChangeIds: record.selection?.reviewedChangeIds ?? [],
      descriptionEdits: record.selection?.descriptionEdits ?? {},
      previewSlideNumbers: record.reviewPreviews?.map(
        (preview) => preview.slideNumber
      ),
    };
    // Leave room for framework serialization within the hosted response limit.
    if (Buffer.byteLength(JSON.stringify(result)) > 3 * 1024 * 1024)
      throw new PowerPointReviewError(
        "This presentation has too much change history to display at once. Split it into smaller presentations to review individual changes."
      );
    return result;
  });
}

/** Load one original/proposed image pair when the instructor opens its comparison. */
export async function readOwnedPowerPointPreview(
  userId: string,
  documentId: string,
  jobId: string,
  revisionToken: string,
  slideNumber: number
): Promise<PowerPointReviewPreview | null> {
  if (
    !UUID.test(documentId) ||
    !UUID.test(jobId) ||
    !/^[a-f0-9]{64}$/.test(revisionToken) ||
    !Number.isInteger(slideNumber) ||
    slideNumber < 1 ||
    slideNumber > 60
  )
    return null;
  return withRetainedDocument(documentId, async (tx) => {
    await ownedJob(tx, userId, documentId, jobId);
    const saved = await storedReview(tx, jobId);
    if (!saved || saved.revisionToken !== revisionToken) return null;
    const preview = saved.record.reviewPreviews?.find(
      (item) => item.slideNumber === slideNumber
    );
    if (
      !preview ||
      Buffer.byteLength(JSON.stringify(preview)) > 3 * 1024 * 1024
    )
      return null;
    return preview;
  });
}

function validateChoices(
  record: StoredReview,
  input: PowerPointReviewSelection
) {
  const changes = new Map(
    record.revisions.changes.map((change) => [change.id, change])
  );
  if (
    [...input.includedChangeIds, ...input.reviewedChangeIds].some(
      (id) => !changes.has(id)
    ) ||
    Object.keys(input.descriptionEdits).some(
      (id) =>
        !changes.get(id)?.editableDescription ||
        !input.includedChangeIds.includes(id)
    )
  ) {
    throw new PowerPointReviewError(
      "The selected changes no longer match this review. Reopen it and try again.",
      400
    );
  }
}

/** Reserve discovery rows before uploading, so transaction failure cannot orphan a document blob. */
async function prepareExport(userId: string, input: PowerPointReviewSelection) {
  return withRetainedDocument(input.documentId, async (tx, document) => {
    const job = await ownedJob(tx, userId, input.documentId, input.jobId);
    if (
      Date.parse(retentionExpiresAt(document.createdAt)) - Date.now() <
      LEASE_MS + 30_000
    )
      throw new PowerPointReviewError(
        "This presentation expires shortly. Download the currently saved version before it is deleted."
      );
    const saved = await storedReview(tx, input.jobId);
    if (!saved || saved.revisionToken !== input.revisionToken)
      throw new PowerPointReviewError(
        "This presentation has changed. Reopen the review before exporting."
      );
    validateChoices(saved.record, input);
    const [latest] = await tx
      .select({
        eventType: jobEvents.eventType,
        createdAt: jobEvents.createdAt,
      })
      .from(jobEvents)
      .where(
        and(
          eq(jobEvents.jobId, input.jobId),
          inArray(jobEvents.eventType, [
            "powerpoint_review_started",
            "powerpoint_review_finished",
          ])
        )
      )
      .orderBy(desc(jobEvents.createdAt), desc(jobEvents.id))
      .limit(1);
    if (
      latest?.eventType === "powerpoint_review_started" &&
      Date.now() - Date.parse(latest.createdAt) < LEASE_MS
    )
      throw new PowerPointReviewError(
        "This presentation is already being checked for download. Please wait for that check to finish."
      );
    const original = await downloadObject(
      sourcePptxKey(job.sessionId, input.documentId)
    );
    const exportId = randomUUID();
    const outputId = randomUUID(),
      reviewId = randomUUID();
    const prefix = `${job.sessionId}/${input.documentId}/${input.jobId}/review-${exportId}`;
    const outputKey = `${prefix}.pptx`,
      reviewKey = `${prefix}.json`;
    await tx.insert(jobEvents).values({
      id: exportId,
      jobId: input.jobId,
      eventType: "powerpoint_review_started",
      message: "Checking the selected PowerPoint changes.",
    });
    await tx.insert(artifacts).values([
      {
        id: outputId,
        jobId: input.jobId,
        artifactType: "pptx_output",
        artifactStatus: "expired",
        filename: outputFilename(job.filename, "accessible_pptx"),
        mimeType: PPTX_MIME_TYPE,
        storageKey: outputKey,
        expiresAt: retentionExpiresAt(document.createdAt),
      },
      {
        id: reviewId,
        jobId: input.jobId,
        artifactType: "review_metadata",
        artifactStatus: "expired",
        filename: "review.json",
        mimeType: "application/json",
        storageKey: reviewKey,
        isUserDownloadable: false,
        expiresAt: retentionExpiresAt(document.createdAt),
      },
    ]);
    return {
      ...job,
      ...saved,
      original,
      exportId,
      outputId,
      reviewId,
      outputKey,
      reviewKey,
    };
  });
}

export async function exportOwnedPowerPointReview(
  userId: string,
  input: PowerPointReviewSelection
): Promise<PowerPointReviewExport> {
  if (!isPowerPointReviewSelection(input))
    throw new PowerPointReviewError("The review choices were not valid.", 400);
  const prepared = await prepareExport(userId, input);
  try {
    // CPU work, native rendering and model calls deliberately run outside the row lock.
    const selected = await replayPptxRevisions(
      prepared.original,
      prepared.record.revisions,
      input.includedChangeIds,
      input.descriptionEdits
    );
    const checked = await recheckPowerPointRevision(
      prepared.original,
      selected.buffer,
      selected.changes
    );
    // Do not retry an ambiguous commit after deletion removed the job receipt.
    await recordPowerPointReviewCalls({
      documentId: input.documentId,
      jobId: input.jobId,
      exportId: prepared.exportId,
      calls: checked.calls ?? [],
    });
    if ("error" in checked)
      throw new PowerPointReviewError(
        "The selected presentation could not be checked. Your previous download is still available. Please try again.",
        422
      );
    const record: StoredReview = {
      ...prepared.record,
      findings: checked.errors,
      changes: checked.changes,
      selection: {
        includedChangeIds: input.includedChangeIds,
        reviewedChangeIds: input.reviewedChangeIds,
        descriptionEdits: input.descriptionEdits,
      },
    };
    // Keep the proposed previews paired with the immutable proposal, not the user's selection.
    const reviewBody = JSON.stringify(record);
    if (Buffer.byteLength(reviewBody) > MAX_REVIEW_BYTES)
      throw new PowerPointReviewError(
        "The review could not be saved because it is too large."
      );
    return await withRetainedDocument(
      input.documentId,
      async (tx, document) => {
        const job = await ownedJob(tx, userId, input.documentId, input.jobId);
        const current = await storedReview(tx, input.jobId);
        if (
          job.attemptNumber !== prepared.attemptNumber ||
          current?.revisionToken !== input.revisionToken
        )
          throw new PowerPointReviewError(
            "A newer conversion or review was saved while this check ran. Reopen the review to use that version."
          );
        const [lease] = await tx
          .select({ id: jobEvents.id, eventType: jobEvents.eventType })
          .from(jobEvents)
          .where(
            and(
              eq(jobEvents.jobId, input.jobId),
              inArray(jobEvents.eventType, [
                "powerpoint_review_started",
                "powerpoint_review_finished",
              ])
            )
          )
          .orderBy(desc(jobEvents.createdAt), desc(jobEvents.id))
          .limit(1);
        if (
          lease?.id !== prepared.exportId ||
          lease.eventType !== "powerpoint_review_started"
        )
          throw new PowerPointReviewError(
            "This review request is no longer current. Reopen the review before downloading."
          );
        await uploadObject(prepared.outputKey, checked.pptx, PPTX_MIME_TYPE);
        await uploadObject(prepared.reviewKey, reviewBody, "application/json");
        await tx
          .update(artifacts)
          .set({ artifactStatus: "expired" })
          .where(
            and(
              eq(artifacts.jobId, input.jobId),
              inArray(artifacts.artifactType, [
                "pptx_output",
                "review_metadata",
              ]),
              eq(artifacts.artifactStatus, "available")
            )
          );
        await tx
          .update(artifacts)
          .set({
            artifactStatus: "available",
            fileSizeBytes: checked.pptx.length,
          })
          .where(eq(artifacts.id, prepared.outputId));
        await tx
          .update(artifacts)
          .set({
            artifactStatus: "available",
            fileSizeBytes: Buffer.byteLength(reviewBody),
          })
          .where(eq(artifacts.id, prepared.reviewId));
        await tx
          .delete(validationFindings)
          .where(eq(validationFindings.jobId, input.jobId));
        if (checked.errors.length)
          await tx.insert(validationFindings).values(
            checked.errors.map((issue) => ({
              jobId: input.jobId,
              severity: issue.severity,
              ruleCode: issue.type,
              title: issue.title || "Review the PowerPoint presentation",
              category: issue.category ?? "source-review",
              message: issue.message,
              suggestion: issue.suggestion,
              wcag: issue.wcag ?? null,
              location: issue.location ?? null,
            }))
          );
        await tx
          .update(jobEvents)
          .set({
            eventType: "powerpoint_review_finished",
            message: "Saved and checked the selected PowerPoint changes.",
            metadata: {
              changes: checked.changes,
              includedChangeIds: input.includedChangeIds,
              reviewedChangeIds: input.reviewedChangeIds,
              findingCount: checked.errors.length,
            },
          })
          .where(eq(jobEvents.id, prepared.exportId));
        const filename = outputFilename(job.filename, "accessible_pptx");
        const expiresAt = Date.parse(retentionExpiresAt(document.createdAt));
        const ttl = Math.min(
          60,
          Math.floor((expiresAt - Date.now()) / 1000) - 1
        );
        if (ttl < 1) throw new DocumentUnavailableError();
        const url = await createSignedUrl(prepared.outputKey, ttl, filename);
        if (Date.now() + ttl * 1000 > expiresAt)
          throw new DocumentUnavailableError();
        return {
          url,
          filename,
          findings: checked.errors,
          changes: checked.changes,
          revisionToken: token(Buffer.from(reviewBody)),
        };
      }
    );
  } catch (error) {
    try {
      await withRetainedDocument(input.documentId, async (tx) => {
        await tx
          .update(jobEvents)
          .set({
            eventType: "powerpoint_review_finished",
            message:
              "The selected presentation was not saved. The previous output is unchanged.",
          })
          .where(
            and(
              eq(jobEvents.id, prepared.exportId),
              eq(jobEvents.eventType, "powerpoint_review_started")
            )
          );
      });
    } catch {
      /* Expiry or deletion owns cleanup; never recreate an expired document. */
    }
    throw error;
  }
}
