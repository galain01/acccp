import "server-only";
import { createStoredPowerPointRenderer } from "./powerpoint-render-storage";
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
  if (value.reviewPreviews !== undefined) {
    const generated = new Set(
      value.revisions.changes.flatMap((change) =>
        change.type === "long-description"
          ? (change.generatedSlideNumbers ?? [])
          : []
      )
    );
    const sourceCount = value.revisions.plan.slides.length;
    const image = (data: unknown) =>
      typeof data === "string" &&
      data.length <= 3 * 1024 * 1024 &&
      /^data:image\/(?:jpeg|png);base64,[A-Za-z0-9+/=]+$/.test(data);
    if (
      !Array.isArray(value.reviewPreviews) ||
      value.reviewPreviews.length > 60 ||
      new Set(value.reviewPreviews.map((preview) => preview?.slideNumber))
        .size !== value.reviewPreviews.length ||
      value.reviewPreviews.some(
        (preview) =>
          !preview ||
          !Number.isInteger(preview.slideNumber) ||
          preview.slideNumber < 1 ||
          preview.slideNumber > 60 ||
          !image(preview.after) ||
          (preview.before === undefined
            ? !generated.has(preview.slideNumber) ||
              preview.slideNumber <= sourceCount
            : !image(preview.before))
      )
    )
      throw new PowerPointReviewError(
        "This saved slide preview could not be read. Convert the original presentation again."
      );
  }
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
        isUserDownloadable: false,
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
        // Reuse the existing pending-publication settlement barrier. The
        // receipt remains private after a failed or uncertain upload.
        filename: "conversion-publication.json",
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

async function assertExportCurrent(
  tx: DocumentTransaction,
  userId: string,
  input: PowerPointReviewSelection,
  prepared: Awaited<ReturnType<typeof prepareExport>>
) {
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
}

export async function exportOwnedPowerPointReview(
  userId: string,
  input: PowerPointReviewSelection
): Promise<PowerPointReviewExport> {
  if (!isPowerPointReviewSelection(input))
    throw new PowerPointReviewError("The review choices were not valid.", 400);
  const prepared = await prepareExport(userId, input);
  let outcomeUncertain = false;
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
      selected.changes,
      {
        renderPowerPoint: createStoredPowerPointRenderer(
          input.documentId,
          prepared.sessionId,
          input.jobId
        ),
      }
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
    const revisionToken = token(Buffer.from(reviewBody));
    const pair = [
      {
        id: prepared.outputId,
        type: "pptx_output" as const,
        key: prepared.outputKey,
        body: checked.pptx,
        mime: PPTX_MIME_TYPE,
        checksum: token(checked.pptx),
        size: checked.pptx.length,
        filename: outputFilename(prepared.filename, "accessible_pptx"),
        downloadable: true,
      },
      {
        id: prepared.reviewId,
        type: "review_metadata" as const,
        key: prepared.reviewKey,
        body: reviewBody,
        mime: "application/json",
        checksum: revisionToken,
        size: Buffer.byteLength(reviewBody),
        filename: "review.json",
        downloadable: false,
      },
    ];
    // Commit exact expected bytes before upload. An ambiguous acknowledgement
    // stops here: no storage write starts until this transaction returns.
    await withRetainedDocument(input.documentId, async (tx) => {
      await assertExportCurrent(tx, userId, input, prepared);
      for (const item of pair) {
        const rows = await tx
          .update(artifacts)
          .set({
            checksumSha256: item.checksum,
            fileSizeBytes: item.size,
          })
          .where(
            and(
              eq(artifacts.id, item.id),
              eq(artifacts.jobId, input.jobId),
              eq(artifacts.artifactType, item.type),
              eq(artifacts.storageKey, item.key),
              eq(artifacts.artifactStatus, "expired"),
              eq(artifacts.isUserDownloadable, false)
            )
          )
          .returning({ id: artifacts.id });
        if (rows.length !== 1)
          throw new PowerPointReviewError(
            "This export's cleanup receipt is unavailable. Reopen the review."
          );
      }
    });

    let publicationError: unknown;
    let publicationFailed = false;
    try {
      await withRetainedDocument(input.documentId, async (tx) => {
        await assertExportCurrent(tx, userId, input, prepared);
        const signal = AbortSignal.timeout(30_000);
        for (const item of pair)
          await uploadObject(item.key, item.body, item.mime, {
            signal,
            upsert: false,
          });
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
        for (const item of pair) {
          const rows = await tx
            .update(artifacts)
            .set({
              artifactStatus: "available",
              filename: item.filename,
              isUserDownloadable: item.downloadable,
            })
            .where(
              and(
                eq(artifacts.id, item.id),
                eq(artifacts.jobId, input.jobId),
                eq(artifacts.artifactType, item.type),
                eq(artifacts.storageKey, item.key),
                eq(artifacts.checksumSha256, item.checksum),
                eq(artifacts.fileSizeBytes, item.size),
                eq(artifacts.artifactStatus, "expired"),
                eq(artifacts.isUserDownloadable, false)
              )
            )
            .returning({ id: artifacts.id });
          if (rows.length !== 1)
            throw new PowerPointReviewError(
              "This export's cleanup receipt is unavailable. Reopen the review."
            );
        }
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
              savedOutputArtifactId: prepared.outputId,
              reviewArtifactId: prepared.reviewId,
              revisionToken,
            },
          })
          .where(eq(jobEvents.id, prepared.exportId));
      });
    } catch (error) {
      publicationFailed = true;
      publicationError = error;
    }

    // A committed pair may outlive a lost acknowledgement. Re-read exact
    // available identities, hashes and the finished lease before signing. This
    // also prevents a later conversion/export from supplying different bytes.
    let result: PowerPointReviewExport | null;
    try {
      result = await withRetainedDocument(
        input.documentId,
        async (tx, document) => {
          const job = await ownedJob(tx, userId, input.documentId, input.jobId);
          if (job.attemptNumber !== prepared.attemptNumber) return null;
          const rows = await tx
            .select()
            .from(artifacts)
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
          if (
            rows.length !== pair.length ||
            !pair.every((item) =>
              rows.some(
                (row) =>
                  row.id === item.id &&
                  row.artifactType === item.type &&
                  row.storageKey === item.key &&
                  row.checksumSha256 === item.checksum &&
                  row.fileSizeBytes === item.size &&
                  row.isUserDownloadable === item.downloadable
              )
            )
          )
            return null;
          const [event] = await tx
            .select({
              eventType: jobEvents.eventType,
              metadata: jobEvents.metadata,
            })
            .from(jobEvents)
            .where(
              and(
                eq(jobEvents.id, prepared.exportId),
                eq(jobEvents.jobId, input.jobId)
              )
            );
          const metadata =
            event?.metadata &&
            typeof event.metadata === "object" &&
            !Array.isArray(event.metadata)
              ? (event.metadata as Record<string, unknown>)
              : null;
          if (
            event?.eventType !== "powerpoint_review_finished" ||
            metadata?.savedOutputArtifactId !== prepared.outputId ||
            metadata?.reviewArtifactId !== prepared.reviewId ||
            metadata?.revisionToken !== revisionToken
          )
            return null;
          const filename = pair[0].filename;
          const expiresAt = Date.parse(retentionExpiresAt(document.createdAt));
          const ttl = Math.min(
            60,
            Math.floor((expiresAt - Date.now()) / 1000) - 1
          );
          if (ttl < 1) throw new DocumentUnavailableError();
          let url: string;
          try {
            url = await createSignedUrl(prepared.outputKey, ttl, filename);
          } catch {
            throw new PowerPointReviewError(
              "The selected presentation is saved, but its download could not be prepared. Reopen the review to download it.",
              503
            );
          }
          if (Date.now() + ttl * 1000 > expiresAt)
            throw new DocumentUnavailableError();
          return {
            savedOutputArtifactId: prepared.outputId,
            url,
            filename,
            findings: checked.errors,
            changes: checked.changes,
            revisionToken,
          };
        }
      );
    } catch (error) {
      if (
        error instanceof DocumentUnavailableError ||
        error instanceof PowerPointReviewError
      )
        throw error;
      outcomeUncertain = true;
      throw new PowerPointReviewError(
        "The selected export's saved status could not be confirmed. Refresh the page before trying again.",
        503
      );
    }
    if (result) return result;
    if (publicationFailed) throw publicationError;
    throw new PowerPointReviewError(
      "A newer saved result replaced this selection. Reopen the review before downloading."
    );
  } catch (error) {
    if (outcomeUncertain) throw error;
    try {
      await withRetainedDocument(input.documentId, async (tx) => {
        await tx
          .update(jobEvents)
          .set({
            eventType: "powerpoint_review_finished",
            message:
              "The selected export did not become the current saved result. Reopen the review before trying again.",
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
