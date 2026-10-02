/**
 * POST /api/convert
 *
 * Converts PDF/DOCX to Canvas HTML or remediates PPTX in its native format, preserving the
 * conversion job, its artifacts, and its accessibility findings.
 *
 * Request:  multipart/form-data
 *   sessionId   string  — the session to file the document under (required)
 *   file        File    — the .pdf or .docx (required unless documentId is given)
 *   documentId  string  — re-convert an existing document; its source is read
 *                         back from storage and no new document row is created
 *
 * Response: application/json
 *   {
 *     jobId:               string               — conversion_jobs.id (uuid)
 *     documentId:          string               — documents.id (uuid)
 *     html:                string               — accessible Canvas HTML
 *     errors:              AccessibilityError[] — structured issues for the UI
 *     model:               string
 *     tokensUsed:          number
 *     extractionWarnings:  string[]
 *   }
 *
 * RLS is enabled on every table here but no policies exist, so the database
 * will not filter by owner. Ownership is established once, up front, by
 * confirming the caller owns the target session, and everything else hangs off
 * that session.
 */

import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { NextRequest, NextResponse } from "next/server";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";

import { verifyRoleOrUnauthorized } from "@/lib/auth";
import { convertPowerPoint } from "@/lib/powerpoint-convert";
import { createStoredPowerPointRenderer } from "@/lib/powerpoint-render-storage";
import {
  DEFAULT_OUTPUT_TARGET,
  isOutputTarget,
  isSupportedOutputForFilename,
  OUTPUT_PROFILES,
  outputFilename,
  readOutputChanges,
} from "@/lib/output-formats";
import {
  convertPdf,
  type AccessibilityError,
  type ModelCallUsage,
} from "@/lib/convert";
import {
  DOCX_MIME_TYPE,
  isDocxFilename,
  isPptxFilename,
  isSupportedDocumentFilename,
  MAX_FILE_SIZE_BYTES,
  maxFileSizeForFilename,
  PDF_MIME_TYPE,
  PPTX_MIME_TYPE,
  validateDocumentInput,
} from "@/lib/document-input";
import {
  DocumentUploadError,
  readAndFinalizePowerPointUpload,
} from "@/lib/document-upload";
import { renderWordToPdf, WordToPdfError } from "@/lib/word-to-pdf";
import { withWordRenderingReview } from "@/lib/word-rendering-review";
import {
  DocumentUnavailableError,
  purgeDocumentIfEligible,
  retainedDocumentCondition,
  withRetainedDocument,
  type DocumentTransaction,
} from "@/lib/document-retention";
import { retentionExpiresAt } from "@/lib/retention";
import { countPdfPages } from "@/lib/pdf-page-count";
import { recordFailureCount } from "@/lib/failure-metrics";
import {
  createJobDiagnostic,
  describeJobDiagnostic,
  type JobDiagnostic,
} from "@/lib/job-diagnostics";
import { db } from "@/lib/db";
import {
  artifacts,
  conversionJobs,
  documents,
  jobEvents,
  modelCalls,
  sessions,
  validationFindings,
} from "@/lib/db/schema";
import {
  downloadObject,
  htmlOutputKey,
  pptxOutputKey,
  outputReviewKey,
  sourceDocxKey,
  sourcePdfKey,
  sourcePptxKey,
  uploadObject,
} from "@/lib/storage";

export const runtime = "nodejs";
export const maxDuration = 300;

const PROVIDER = "litellm";

class ConversionInProgressError extends Error {
  constructor(readonly documentId: string) {
    super(
      "This presentation is already being processed. Wait for it to finish before trying again."
    );
  }
}

/** validation_findings.title is NOT NULL, but the pipeline only emits a type slug. */
const FINDING_TITLES: Record<AccessibilityError["type"], string> = {
  "missing-alt": "Missing alt text",
  "heading-skip": "Heading level skipped",
  "bad-link": "Broken or invalid link",
  "no-table-caption": "Table missing a caption",
  "no-table-headers": "Table missing header cells",
  "missing-list-markup": "List not marked up as a list",
  "empty-heading": "Empty heading",
  "color-only-meaning": "Meaning conveyed by colour alone",
  "h1-present": "H1 used inside page content",
  "non-descriptive-link": "Non-descriptive link text",
  "missing-image": "Image could not be extracted",
  "missing-link": "Link could not be extracted",
  other: "Accessibility issue",
};

function json(body: unknown, status: number) {
  return NextResponse.json(body, { status });
}

function supersededResponse(
  documentId: string,
  jobId: string,
  outputTarget: string
) {
  return json(
    {
      error:
        "A newer conversion has started. Refresh this document to see its current result.",
      documentId,
      jobId,
      outputTarget,
    },
    409
  );
}

/** Caller holds the document lock shared by conversion starts and publication. */
async function isCurrentAttempt(
  tx: DocumentTransaction,
  documentId: string,
  jobId: string,
  attemptNumber: number
): Promise<boolean> {
  const [current] = await tx
    .select({ attemptNumber: conversionJobs.attemptCount })
    .from(conversionJobs)
    .where(
      and(
        eq(conversionJobs.id, jobId),
        eq(conversionJobs.documentId, documentId)
      )
    );
  return current?.attemptNumber === attemptNumber;
}

/** Stable receipts prevent a failed/ambiguous save from charging the same calls twice. */
async function recordConversionCalls(
  tx: DocumentTransaction,
  jobId: string,
  attemptNumber: number,
  calls: ModelCallUsage[]
) {
  if (!calls.length) return;
  await tx
    .insert(modelCalls)
    .values(
      calls.map((call, index) => {
        const bytes = createHash("sha256")
          .update(`conversion:${jobId}:${attemptNumber}:${index}`)
          .digest()
          .subarray(0, 16);
        bytes[6] = (bytes[6] & 0x0f) | 0x50;
        bytes[8] = (bytes[8] & 0x3f) | 0x80;
        const hex = bytes.toString("hex");
        return {
          id: `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
          jobId,
          stage: call.stage,
          model: call.model,
          promptTokens: call.promptTokens,
          completionTokens: call.completionTokens,
          cachedPromptTokens: call.cachedPromptTokens ?? null,
          cacheCreationPromptTokens: call.cacheCreationPromptTokens ?? null,
          costSource: call.costSource ?? null,
          costUsd: call.costUsd !== null ? String(call.costUsd) : null,
        };
      })
    )
    .onConflictDoNothing({ target: modelCalls.id });
}

async function recordJobFailure(
  documentId: string,
  jobId: string,
  attemptNumber: number,
  code: string,
  diagnostic: JobDiagnostic,
  calls: ModelCallUsage[] = []
) {
  // Rebuild from the strict contract at the persistence boundary. Never save
  // exception messages, arbitrary provider fields or unvalidated diagnostics.
  const safeDiagnostic = createJobDiagnostic(diagnostic);
  const message = describeJobDiagnostic(safeDiagnostic);
  const failedAt = new Date().toISOString();
  return withRetainedDocument(documentId, async (tx) => {
    const current = await isCurrentAttempt(
      tx,
      documentId,
      jobId,
      attemptNumber
    );
    // Superseded work is still billable. Commit only its usage, leaving the
    // newer attempt's status, events, output and findings untouched.
    await recordConversionCalls(tx, jobId, attemptNumber, calls);
    if (!current) return false;
    await tx
      .update(conversionJobs)
      .set({
        status: "failed",
        completedAt: failedAt,
        updatedAt: failedAt,
        errorCode: safeDiagnostic.code,
        errorMessage: message,
        processingDurationMs: null,
      })
      .where(eq(conversionJobs.id, jobId));
    await tx.insert(jobEvents).values({
      jobId,
      eventType: code,
      createdAt: failedAt,
      message,
      metadata: { detail: message, diagnostic: safeDiagnostic },
    });
    await recordFailureCount(tx, safeDiagnostic, failedAt);
    return true;
  });
}

async function convertRequest(req: NextRequest) {
  const authCheck = await verifyRoleOrUnauthorized(["instructor", "admin"]);
  if ("response" in authCheck) return authCheck.response;
  const userId = authCheck.session.user.id;

  // Large PowerPoints arrive through private storage. This route receives
  // only their document ID; keep the legacy multipart upload envelope small.
  const contentLength = Number(req.headers.get("content-length"));
  if (
    Number.isFinite(contentLength) &&
    contentLength > MAX_FILE_SIZE_BYTES + 64 * 1024
  ) {
    return json(
      {
        error:
          "Upload PowerPoint files using the document uploader. PDF and Word files must be 4 MB or smaller.",
      },
      413
    );
  }

  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return json(
      { error: "Invalid request. Expected multipart/form-data." },
      400
    );
  }

  const sessionId = formData.get("sessionId");
  if (typeof sessionId !== "string" || !sessionId) {
    return json({ error: "No sessionId provided." }, 400);
  }
  const outputTarget = formData.get("outputTarget") ?? DEFAULT_OUTPUT_TARGET;
  if (!isOutputTarget(outputTarget)) {
    return json({ error: "Choose a supported output format." }, 400);
  }
  const profileVersion = OUTPUT_PROFILES[outputTarget].version;

  // Establishes ownership for every write below.
  const [session] = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(
      and(
        eq(sessions.id, sessionId),
        eq(sessions.ownerUserId, userId),
        isNull(sessions.archivedAt)
      )
    );
  if (!session) return json({ error: "Session not found." }, 404);

  const existingDocumentId = formData.get("documentId");
  const isReconversion =
    typeof existingDocumentId === "string" && existingDocumentId;

  let documentId: string;
  let filename: string;
  let sourceBuffer: Buffer;

  if (isReconversion) {
    // Scoped to the session we just proved the caller owns.
    const [existing] = await db
      .select({
        id: documents.id,
        originalFilename: documents.originalFilename,
      })
      .from(documents)
      .where(
        and(
          eq(documents.id, existingDocumentId),
          eq(documents.sessionId, sessionId),
          retainedDocumentCondition()
        )
      );
    if (!existing) return json({ error: "Document not found." }, 404);

    documentId = existing.id;
    filename = existing.originalFilename;
    if (!isSupportedDocumentFilename(filename)) {
      return json(
        {
          error:
            "This document format cannot be converted. Upload a PDF, Word (.docx), or PowerPoint (.pptx) file.",
        },
        415
      );
    }
    if (!isSupportedOutputForFilename(filename, outputTarget)) {
      return json(
        {
          error:
            "Choose Accessible PowerPoint for a .pptx file, or Canvas HTML for a PDF or Word file.",
        },
        415
      );
    }
    try {
      sourceBuffer = isPptxFilename(filename)
        ? (
            await readAndFinalizePowerPointUpload({
              userId,
              sessionId,
              documentId,
            })
          ).buffer
        : await withRetainedDocument(documentId, async () =>
            downloadObject(
              isDocxFilename(filename)
                ? sourceDocxKey(sessionId, documentId)
                : sourcePdfKey(sessionId, documentId)
            )
          );
    } catch (error) {
      if (
        error instanceof DocumentUnavailableError ||
        error instanceof DocumentUploadError
      )
        throw error;
      console.error(`[api/convert] document=${documentId} source fetch failed`);
      return json({ error: "Could not read the stored document." }, 500);
    }
    const inputError = validateDocumentInput(sourceBuffer, filename);
    if (inputError) {
      return json(
        { error: inputError },
        sourceBuffer.byteLength > maxFileSizeForFilename(filename) ? 413 : 415
      );
    }
  } else {
    const file = formData.get("file");
    if (!file || !(file instanceof File)) {
      return json(
        {
          error:
            "No file provided. Include a PDF, Word (.docx), or PowerPoint (.pptx) file.",
        },
        400
      );
    }
    if (!isSupportedDocumentFilename(file.name)) {
      return json(
        {
          error:
            "Upload a PDF, Word (.docx), or PowerPoint (.pptx) file. Older .doc or .ppt files must be saved in their current format first.",
        },
        415
      );
    }
    if (!isSupportedOutputForFilename(file.name, outputTarget)) {
      return json(
        {
          error:
            "Choose Accessible PowerPoint for a .pptx file, or Canvas HTML for a PDF or Word file.",
        },
        415
      );
    }
    if (file.size > MAX_FILE_SIZE_BYTES) {
      return json(
        {
          error: `File too large. Maximum size is ${MAX_FILE_SIZE_BYTES / 1024 / 1024} MB.`,
        },
        413
      );
    }

    filename = file.name;
    sourceBuffer = Buffer.from(await file.arrayBuffer());
    const inputError = validateDocumentInput(sourceBuffer, filename);
    if (inputError) return json({ error: inputError }, 415);

    // Render before creating rows: a rejected Word file leaves no empty document.
    // PDFs use the existing path without contacting the Word renderer.
    documentId = "";
  }

  // Measure server processing after source validation, including Word
  // rendering, page counting, model work, storage and success metadata writes.
  const processingStartedAt = performance.now();
  const startedAt = new Date().toISOString();
  const isWord = isDocxFilename(filename);
  const isPowerPoint = isPptxFilename(filename);
  const pdfFilename = isWord ? filename.replace(/\.docx$/i, ".pdf") : filename;
  let buffer: Buffer;
  try {
    buffer = isWord
      ? await renderWordToPdf(sourceBuffer, filename)
      : sourceBuffer;
  } catch (error) {
    if (!(error instanceof WordToPdfError)) throw error;
    // Word rendering precedes document/job creation. Keep that behavior and
    // any earlier saved job, but count the failed attempt without identifiers.
    const diagnostic = createJobDiagnostic({
      ...error.diagnostic,
      stage: "word_to_pdf",
      code: error.diagnostic?.code ?? "word_rejected",
      elapsedMs: Math.max(
        0,
        Math.round(performance.now() - processingStartedAt)
      ),
    });
    try {
      await recordFailureCount(db, diagnostic, new Date().toISOString());
    } catch {
      console.error("[api/convert] Word failure total could not be saved");
    }
    return json({ error: describeJobDiagnostic(diagnostic) }, error.status);
  }
  const sourceMimeType = isPowerPoint
    ? PPTX_MIME_TYPE
    : isWord
      ? DOCX_MIME_TYPE
      : PDF_MIME_TYPE;
  const pageCount = isPowerPoint ? null : await countPdfPages(buffer);

  if (!isReconversion) {
    const [created] = await db
      .insert(documents)
      .values({
        sessionId,
        uploadedByUserId: userId,
        originalFilename: filename,
        mimeType: sourceMimeType,
        fileSizeBytes: sourceBuffer.byteLength,
        checksumSha256: createHash("sha256").update(sourceBuffer).digest("hex"),
      })
      .returning({ id: documents.id });
    documentId = created.id;

    const sourceKey = isPowerPoint
      ? sourcePptxKey(sessionId, documentId)
      : isWord
        ? sourceDocxKey(sessionId, documentId)
        : sourcePdfKey(sessionId, documentId);
    // Every blob write takes the same document lock as the purge. A failed
    // upload keeps a tombstone until storage cleanup actually succeeds.
    try {
      await withRetainedDocument(documentId, async () => {
        await uploadObject(sourceKey, sourceBuffer, sourceMimeType);
        if (isWord) {
          await uploadObject(
            sourcePdfKey(sessionId, documentId),
            buffer,
            PDF_MIME_TYPE
          );
        }
      });
    } catch (error) {
      if (error instanceof DocumentUnavailableError) throw error;
      await db
        .update(documents)
        .set({ deletedAt: new Date().toISOString() })
        .where(eq(documents.id, documentId));
      await purgeDocumentIfEligible(documentId);
      console.error(`[api/convert] document=${documentId} upload failed`);
      return json({ error: "Could not store the uploaded document." }, 500);
    }
  }

  // Each destination has its own job; retries update only that destination.
  const job = await withRetainedDocument(documentId, async (tx, document) => {
    if (isPowerPoint) {
      // The retained-document row lock serializes competing starts for this
      // presentation. A request that lost its response must not bill twice.
      const [active] = await tx
        .select({ status: conversionJobs.status })
        .from(conversionJobs)
        .where(
          and(
            eq(conversionJobs.documentId, documentId),
            eq(conversionJobs.outputTarget, outputTarget),
            eq(conversionJobs.status, "processing"),
            sql`${conversionJobs.startedAt} > clock_timestamp() - interval '330 seconds'`
          )
        );
      if (active?.status === "processing")
        throw new ConversionInProgressError(documentId);
    }
    const expiresAt = retentionExpiresAt(document.createdAt);
    const [savedJob] = await tx
      .insert(conversionJobs)
      .values({
        documentId,
        outputTarget,
        profileVersion,
        requestedByUserId: userId,
        status: "processing",
        startedAt,
        attemptCount: 1,
        provider: PROVIDER,
        expiresAt,
        pageCount,
        processingDurationMs: null,
      })
      .onConflictDoUpdate({
        target: [conversionJobs.documentId, conversionJobs.outputTarget],
        set: {
          status: "processing",
          profileVersion,
          startedAt,
          completedAt: null,
          errorCode: null,
          errorMessage: null,
          attemptCount: sql`${conversionJobs.attemptCount} + 1`,
          updatedAt: startedAt,
          expiresAt,
          pageCount,
          processingDurationMs: null,
        },
      })
      .returning({
        id: conversionJobs.id,
        attemptNumber: conversionJobs.attemptCount,
      });
    return savedJob;
  });
  const jobId = job.id;

  console.log(`[api/convert] job=${jobId} started`);

  // Deliberately outside a transaction: this is a multi-second model call and
  // would pin a pooled connection for its whole duration.
  let result = isPowerPoint
    ? await convertPowerPoint(sourceBuffer, filename, {
        renderPowerPoint: createStoredPowerPointRenderer(
          documentId,
          sessionId,
          jobId
        ),
      })
    : await convertPdf(buffer, pdfFilename);

  if ("error" in result) {
    const diagnostic = createJobDiagnostic({
      ...result.diagnostic,
      attemptNumber: job.attemptNumber,
    });
    const detail = describeJobDiagnostic(diagnostic);
    const recorded = await recordJobFailure(
      documentId,
      jobId,
      job.attemptNumber,
      "conversion_failed",
      diagnostic,
      result.calls
    );
    if (!recorded) return supersededResponse(documentId, jobId, outputTarget);

    console.error(`[api/convert] job=${jobId} failed: ${diagnostic.code}`);
    return json(
      { error: "Conversion failed", detail, jobId, documentId, outputTarget },
      500
    );
  }

  if (isWord && "html" in result) result = withWordRenderingReview(result);

  const outputKey = isPowerPoint
    ? pptxOutputKey(sessionId, documentId, jobId)
    : htmlOutputKey(sessionId, documentId);
  const outputBody = "pptx" in result ? result.pptx : result.html;
  const outputMimeType = isPowerPoint
    ? PPTX_MIME_TYPE
    : "text/html; charset=utf-8";
  const changes = "changes" in result ? readOutputChanges(result.changes) : [];
  const reviewKey = outputReviewKey(sessionId, documentId, jobId);
  const reviewBody = JSON.stringify({
    outputTarget,
    profileVersion,
    changes,
    findings: result.errors,
    ...("revisions" in result ? { revisions: result.revisions } : {}),
    ...("reviewPreviews" in result
      ? { reviewPreviews: result.reviewPreviews }
      : {}),
  });
  const savingStartedAt = performance.now();
  try {
    const published = await withRetainedDocument(
      documentId,
      async (tx, document) => {
        if (
          !(await isCurrentAttempt(tx, documentId, jobId, job.attemptNumber))
        ) {
          await recordConversionCalls(
            tx,
            jobId,
            job.attemptNumber,
            result.calls
          );
          return false;
        }
        const expiresAt = retentionExpiresAt(document.createdAt);
        if (isReconversion && isWord) {
          // A failed model attempt must not replace the PDF paired with the last
          // saved HTML and artifact metadata. Persist this render only on success.
          await uploadObject(
            sourcePdfKey(sessionId, documentId),
            buffer,
            PDF_MIME_TYPE
          );
        }
        await uploadObject(outputKey, outputBody, outputMimeType);
        if (isPowerPoint)
          await uploadObject(reviewKey, reviewBody, "application/json");

        const artifactsUpdatedAt = new Date().toISOString();

        // A chosen PowerPoint export has its own immutable path. Preserve that
        // discovery row on reconversion so purge can still remove the old file.
        if (isPowerPoint) {
          await tx
            .update(artifacts)
            .set({ artifactStatus: "expired" })
            .where(
              and(
                eq(artifacts.jobId, jobId),
                inArray(artifacts.artifactType, [
                  "pptx_output",
                  "review_metadata",
                ]),
                eq(artifacts.artifactStatus, "available")
              )
            );
        }

        // uq_available_artifact_per_job_type allows one available artifact per type,
        // so a re-convert updates the existing row rather than inserting a second.
        for (const artifact of [
          ...(isWord
            ? [
                {
                  artifactType: "source_docx" as const,
                  filename,
                  mimeType: DOCX_MIME_TYPE,
                  storageKey: sourceDocxKey(sessionId, documentId),
                  fileSizeBytes: sourceBuffer.byteLength,
                  previewSnippet: null,
                },
              ]
            : []),
          ...(isPowerPoint
            ? [
                {
                  artifactType: "source_pptx" as const,
                  filename,
                  mimeType: PPTX_MIME_TYPE,
                  storageKey: sourcePptxKey(sessionId, documentId),
                  fileSizeBytes: sourceBuffer.byteLength,
                  previewSnippet: null,
                },
              ]
            : [
                {
                  artifactType: "source_pdf" as const,
                  filename: pdfFilename,
                  mimeType: PDF_MIME_TYPE,
                  storageKey: sourcePdfKey(sessionId, documentId),
                  fileSizeBytes: buffer.byteLength,
                  previewSnippet: null,
                },
              ]),
          {
            artifactType: isPowerPoint
              ? ("pptx_output" as const)
              : ("html_output" as const),
            filename: outputFilename(filename, outputTarget),
            mimeType: isPowerPoint ? PPTX_MIME_TYPE : "text/html",
            storageKey: outputKey,
            fileSizeBytes: Buffer.byteLength(outputBody),
            previewSnippet: "html" in result ? result.html.slice(0, 500) : null,
          },
          ...(isPowerPoint
            ? [
                {
                  artifactType: "review_metadata" as const,
                  filename: "review.json",
                  mimeType: "application/json",
                  storageKey: reviewKey,
                  fileSizeBytes: Buffer.byteLength(reviewBody),
                  previewSnippet: null,
                },
              ]
            : []),
        ]) {
          await tx
            .insert(artifacts)
            .values({
              jobId,
              artifactStatus: "available",
              ...artifact,
              expiresAt,
            })
            .onConflictDoUpdate({
              target: [artifacts.jobId, artifacts.artifactType],
              targetWhere: sql`artifact_status = 'available'`,
              set: {
                filename: artifact.filename,
                mimeType: artifact.mimeType,
                storageKey: artifact.storageKey,
                fileSizeBytes: artifact.fileSizeBytes,
                previewSnippet: artifact.previewSnippet,
                createdAt: artifactsUpdatedAt,
                expiresAt,
              },
            });
        }

        // Findings have no natural key, so replace the previous run's wholesale.
        await tx
          .delete(validationFindings)
          .where(eq(validationFindings.jobId, jobId));
        if (result.errors.length > 0) {
          await tx.insert(validationFindings).values(
            result.errors.map((issue) => ({
              jobId,
              severity: issue.severity,
              ruleCode: issue.type,
              title:
                issue.title ??
                FINDING_TITLES[issue.type] ??
                FINDING_TITLES.other,
              category: issue.category ?? "accessibility",
              message: issue.message,
              suggestion: issue.suggestion,
              wcag: issue.wcag ?? null,
              location:
                issue.location || issue.element
                  ? {
                      ...issue.location,
                      ...(issue.element ? { element: issue.element } : {}),
                    }
                  : null,
            }))
          );
        }

        await tx.insert(jobEvents).values({
          jobId,
          eventType: "conversion_completed",
          message: `Converted ${filename}`,
          metadata: {
            model: result.model,
            tokensUsed: result.tokensUsed,
            findingCount: result.errors.length,
            extractionWarnings: result.extractionWarnings,
            outputTarget,
            profileVersion,
            changes,
          },
        });

        await recordConversionCalls(tx, jobId, job.attemptNumber, result.calls);

        // Complete last so duration includes every successful artifact, finding,
        // event and model-call write. A rollback leaves no successful duration.
        const completedAt = new Date().toISOString();
        await tx
          .update(conversionJobs)
          .set({
            status: "completed",
            completedAt,
            updatedAt: completedAt,
            modelName: result.model,
            expiresAt,
            pageCount: result.pageCount ?? pageCount,
            processingDurationMs: Math.max(
              0,
              Math.round(performance.now() - processingStartedAt)
            ),
          })
          .where(eq(conversionJobs.id, jobId));
        return true;
      }
    );
    if (!published) return supersededResponse(documentId, jobId, outputTarget);
  } catch (error) {
    if (error instanceof DocumentUnavailableError) throw error;
    const diagnostic = createJobDiagnostic({
      stage: "save_output",
      code: "output_storage_failed",
      attemptNumber: job.attemptNumber,
      elapsedMs: Math.max(0, Math.round(performance.now() - savingStartedAt)),
    });
    const message = describeJobDiagnostic(diagnostic);
    const recorded = await recordJobFailure(
      documentId,
      jobId,
      job.attemptNumber,
      "output_storage_failed",
      diagnostic,
      result.calls
    );
    if (!recorded) return supersededResponse(documentId, jobId, outputTarget);
    console.error(`[api/convert] job=${jobId} output persistence failed`);
    return json({ error: message, jobId, documentId, outputTarget }, 500);
  }

  console.log(
    `[api/convert] job=${jobId} completed. errors=${result.errors.length} tokens=${result.tokensUsed}`
  );

  return NextResponse.json({
    jobId,
    documentId,
    outputTarget,
    profileVersion,
    changes,
    ...("html" in result ? { html: result.html } : {}),
    errors: result.errors,
    model: result.model,
    tokensUsed: result.tokensUsed,
    extractionWarnings: result.extractionWarnings,
  });
}

export async function POST(req: NextRequest) {
  try {
    return await convertRequest(req);
  } catch (error) {
    if (error instanceof DocumentUploadError) {
      return json({ error: error.message }, error.status);
    }
    if (error instanceof ConversionInProgressError) {
      return json({ error: error.message, documentId: error.documentId }, 409);
    }
    if (error instanceof DocumentUnavailableError) {
      return json(
        {
          error:
            "This document has expired or was deleted. Upload it again to start a new conversion.",
        },
        410
      );
    }
    if (error instanceof WordToPdfError) {
      return json({ error: error.message }, error.status);
    }
    // Driver/storage exceptions may contain query parameters or credentials.
    // Keep them out of both HTTP responses and the host's exception logs.
    console.error("[api/convert] request failed unexpectedly");
    return json(
      { error: "Could not complete the conversion. Please try again." },
      500
    );
  }
}
