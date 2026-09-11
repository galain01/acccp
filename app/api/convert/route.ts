/**
 * POST /api/convert
 *
 * Converts a .pdf or .docx into accessible Canvas HTML and persists the document, the
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
import { and, eq, isNull, sql } from "drizzle-orm";

import { verifyRoleOrUnauthorized } from "@/lib/auth";
import {
  convertPdf,
  type AccessibilityError,
  type ModelCallUsage,
} from "@/lib/convert";
import {
  DOCX_MIME_TYPE,
  isDocxFilename,
  isSupportedDocumentFilename,
  MAX_FILE_SIZE_BYTES,
  PDF_MIME_TYPE,
  validateDocumentInput,
} from "@/lib/document-input";
import { renderWordToPdf, WordToPdfError } from "@/lib/word-to-pdf";
import { withWordRenderingReview } from "@/lib/word-rendering-review";
import {
  DocumentUnavailableError,
  purgeDocumentIfEligible,
  retainedDocumentCondition,
  withRetainedDocument,
} from "@/lib/document-retention";
import { retentionExpiresAt } from "@/lib/retention";
import { countPdfPages } from "@/lib/pdf-page-count";
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
  sourceDocxKey,
  sourcePdfKey,
  uploadObject,
} from "@/lib/storage";

export const runtime = "nodejs";
export const maxDuration = 300;

const PROVIDER = "litellm";

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

async function recordJobFailure(
  documentId: string,
  jobId: string,
  code: string,
  message: string,
  calls: ModelCallUsage[] = [],
  detail?: string
) {
  const failedAt = new Date().toISOString();
  await withRetainedDocument(documentId, async (tx) => {
    await tx
      .update(conversionJobs)
      .set({
        status: "failed",
        completedAt: failedAt,
        updatedAt: failedAt,
        errorCode: code,
        errorMessage: message,
        processingDurationMs: null,
      })
      .where(eq(conversionJobs.id, jobId));
    await tx.insert(jobEvents).values({
      jobId,
      eventType: code,
      message,
      metadata: { detail: detail ?? null },
    });
    // Model work remains billable when conversion or output storage fails.
    if (calls.length > 0) {
      await tx.insert(modelCalls).values(
        calls.map((call) => ({
          jobId,
          stage: call.stage,
          model: call.model,
          promptTokens: call.promptTokens,
          completionTokens: call.completionTokens,
          cachedPromptTokens: call.cachedPromptTokens ?? null,
          cacheCreationPromptTokens: call.cacheCreationPromptTokens ?? null,
          costSource: call.costSource ?? null,
          costUsd: call.costUsd !== null ? String(call.costUsd) : null,
        }))
      );
    }
  });
}

async function convertRequest(req: NextRequest) {
  const authCheck = await verifyRoleOrUnauthorized(["instructor", "admin"]);
  if ("response" in authCheck) return authCheck.response;
  const userId = authCheck.session.user.id;

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
            "This document format cannot be converted. Upload a PDF or Word (.docx) file.",
        },
        415
      );
    }
    try {
      sourceBuffer = await withRetainedDocument(documentId, async () =>
        downloadObject(
          isDocxFilename(filename)
            ? sourceDocxKey(sessionId, documentId)
            : sourcePdfKey(sessionId, documentId)
        )
      );
    } catch (error) {
      if (error instanceof DocumentUnavailableError) throw error;
      console.error(`[api/convert] document=${documentId} source fetch failed`);
      return json({ error: "Could not read the stored document." }, 500);
    }
    const inputError = validateDocumentInput(sourceBuffer, filename);
    if (inputError) {
      return json(
        { error: inputError },
        sourceBuffer.byteLength > MAX_FILE_SIZE_BYTES ? 413 : 415
      );
    }
  } else {
    const file = formData.get("file");
    if (!file || !(file instanceof File)) {
      return json(
        {
          error: "No file provided. Include a PDF or Word (.docx) file.",
        },
        400
      );
    }
    if (!isSupportedDocumentFilename(file.name)) {
      return json(
        {
          error:
            "Upload a PDF or Word (.docx) file. Older .doc files must be saved as .docx first.",
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
  const pdfFilename = isWord ? filename.replace(/\.docx$/i, ".pdf") : filename;
  const buffer = isWord
    ? await renderWordToPdf(sourceBuffer, filename)
    : sourceBuffer;
  const sourceMimeType = isWord ? DOCX_MIME_TYPE : PDF_MIME_TYPE;
  const pageCount = await countPdfPages(buffer);

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

    const sourceKey = isWord
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

  // conversion_jobs is unique per document, so a re-convert updates in place.
  const job = await withRetainedDocument(documentId, async (tx, document) => {
    const expiresAt = retentionExpiresAt(document.createdAt);
    const [savedJob] = await tx
      .insert(conversionJobs)
      .values({
        documentId,
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
        target: conversionJobs.documentId,
        set: {
          status: "processing",
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
      .returning({ id: conversionJobs.id });
    return savedJob;
  });
  const jobId = job.id;

  console.log(`[api/convert] job=${jobId} started`);

  // Deliberately outside a transaction: this is a multi-second model call and
  // would pin a pooled connection for its whole duration.
  let result = await convertPdf(buffer, pdfFilename, pageCount);

  if ("error" in result) {
    await recordJobFailure(
      documentId,
      jobId,
      "conversion_failed",
      result.error,
      result.calls,
      result.detail
    );

    console.error(`[api/convert] job=${jobId} failed: ${result.error}`);
    return json(
      { error: result.error, detail: result.detail, jobId, documentId },
      500
    );
  }

  if (isWord) result = withWordRenderingReview(result);

  const htmlKey = htmlOutputKey(sessionId, documentId);
  try {
    await withRetainedDocument(documentId, async (tx, document) => {
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
      await uploadObject(htmlKey, result.html, "text/html; charset=utf-8");

      const artifactsUpdatedAt = new Date().toISOString();

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
        {
          artifactType: "source_pdf" as const,
          filename: pdfFilename,
          mimeType: PDF_MIME_TYPE,
          storageKey: sourcePdfKey(sessionId, documentId),
          fileSizeBytes: buffer.byteLength,
          previewSnippet: null,
        },
        {
          artifactType: "html_output" as const,
          filename: filename.replace(/\.(?:pdf|docx)$/i, ".html"),
          mimeType: "text/html",
          storageKey: htmlKey,
          fileSizeBytes: Buffer.byteLength(result.html),
          previewSnippet: result.html.slice(0, 500),
        },
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
              issue.title ?? FINDING_TITLES[issue.type] ?? FINDING_TITLES.other,
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
        },
      });

      await tx.insert(modelCalls).values(
        result.calls.map((call) => ({
          jobId,
          stage: call.stage,
          model: call.model,
          promptTokens: call.promptTokens,
          completionTokens: call.completionTokens,
          cachedPromptTokens: call.cachedPromptTokens ?? null,
          cacheCreationPromptTokens: call.cacheCreationPromptTokens ?? null,
          costSource: call.costSource ?? null,
          costUsd: call.costUsd !== null ? String(call.costUsd) : null,
        }))
      );

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
          pageCount,
          processingDurationMs: Math.max(
            0,
            Math.round(performance.now() - processingStartedAt)
          ),
        })
        .where(eq(conversionJobs.id, jobId));
    });
  } catch (error) {
    if (error instanceof DocumentUnavailableError) throw error;
    const message = "Could not store the converted document. Please try again.";
    await recordJobFailure(
      documentId,
      jobId,
      "output_storage_failed",
      message,
      result.calls
    );
    console.error(`[api/convert] job=${jobId} output persistence failed`);
    return json({ error: message, jobId, documentId }, 500);
  }

  console.log(
    `[api/convert] job=${jobId} completed. errors=${result.errors.length} tokens=${result.tokensUsed}`
  );

  return NextResponse.json({
    jobId,
    documentId,
    html: result.html,
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
