/**
 * POST /api/convert
 *
 * Converts a .pdf into accessible Canvas HTML and persists the document, the
 * conversion job, its artifacts, and its accessibility findings.
 *
 * Request:  multipart/form-data
 *   sessionId   string  — the session to file the document under (required)
 *   file        File    — the .pdf (required unless documentId is given)
 *   documentId  string  — re-convert an existing PDF; its source is read
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
import { NextRequest, NextResponse } from "next/server";
import { and, eq, isNull, sql } from "drizzle-orm";

import { verifyRoleOrUnauthorized } from "@/lib/auth";
import { convertPdf, type AccessibilityError } from "@/lib/convert";
import {
  isPdfFilename,
  MAX_FILE_SIZE_BYTES,
  PDF_MIME_TYPE,
  validatePdfInput,
} from "@/lib/document-input";
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
  let buffer: Buffer;

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
          isNull(documents.deletedAt)
        )
      );
    if (!existing) return json({ error: "Document not found." }, 404);

    documentId = existing.id;
    filename = existing.originalFilename;
    if (!isPdfFilename(filename)) {
      return json(
        {
          error:
            "This document was uploaded as a Word file. Export it from Word as a PDF and upload the PDF to convert it again. Its existing HTML remains available.",
        },
        415
      );
    }
    try {
      buffer = await downloadObject(sourcePdfKey(sessionId, documentId));
    } catch {
      console.error(`[api/convert] document=${documentId} source fetch failed`);
      return json({ error: "Could not read the stored document." }, 500);
    }
    const inputError = validatePdfInput(buffer, filename);
    if (inputError) {
      return json(
        { error: inputError },
        buffer.byteLength > MAX_FILE_SIZE_BYTES ? 413 : 415
      );
    }
  } else {
    const file = formData.get("file");
    if (!file || !(file instanceof File)) {
      return json(
        {
          error: "No file provided. Include a .pdf file as the 'file' field.",
        },
        400
      );
    }
    if (!isPdfFilename(file.name)) {
      return json(
        {
          error:
            "Export your Word document as a PDF, then upload the .pdf file.",
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
    buffer = Buffer.from(await file.arrayBuffer());
    const inputError = validatePdfInput(buffer, filename);
    if (inputError) return json({ error: inputError }, 415);

    const [created] = await db
      .insert(documents)
      .values({
        sessionId,
        uploadedByUserId: userId,
        originalFilename: filename,
        mimeType: PDF_MIME_TYPE,
        fileSizeBytes: buffer.byteLength,
        checksumSha256: createHash("sha256").update(buffer).digest("hex"),
      })
      .returning({ id: documents.id });
    documentId = created.id;

    // The row is useless without its blob, so don't leave one behind.
    try {
      await uploadObject(
        sourcePdfKey(sessionId, documentId),
        buffer,
        PDF_MIME_TYPE
      );
    } catch {
      await db.delete(documents).where(eq(documents.id, documentId));
      console.error(`[api/convert] document=${documentId} upload failed`);
      return json({ error: "Could not store the uploaded document." }, 500);
    }
  }

  // conversion_jobs is unique per document, so a re-convert updates in place.
  const startedAt = new Date().toISOString();
  const [job] = await db
    .insert(conversionJobs)
    .values({
      documentId,
      requestedByUserId: userId,
      status: "processing",
      startedAt,
      attemptCount: 1,
      provider: PROVIDER,
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
      },
    })
    .returning({ id: conversionJobs.id });
  const jobId = job.id;

  console.log(`[api/convert] job=${jobId} started`);

  // Deliberately outside a transaction: this is a multi-second model call and
  // would pin a pooled connection for its whole duration.
  const result = await convertPdf(buffer, filename);

  if ("error" in result) {
    const failedAt = new Date().toISOString();
    await db.transaction(async (tx) => {
      await tx
        .update(conversionJobs)
        .set({
          status: "failed",
          completedAt: failedAt,
          updatedAt: failedAt,
          errorCode: "conversion_failed",
          errorMessage: result.error,
        })
        .where(eq(conversionJobs.id, jobId));
      await tx.insert(jobEvents).values({
        jobId,
        eventType: "conversion_failed",
        message: result.error,
        metadata: { detail: result.detail ?? null },
      });
      // Usage incurred before the failure (e.g. stage 1 succeeded, stage 2
      // threw) is still billable, so it's still recorded.
      if (result.calls && result.calls.length > 0) {
        await tx.insert(modelCalls).values(
          result.calls.map((call) => ({
            jobId,
            stage: call.stage,
            model: call.model,
            promptTokens: call.promptTokens,
            completionTokens: call.completionTokens,
            costUsd: call.costUsd !== null ? String(call.costUsd) : null,
          }))
        );
      }
    });

    console.error(`[api/convert] job=${jobId} failed: ${result.error}`);
    return json(
      { error: result.error, detail: result.detail, jobId, documentId },
      500
    );
  }

  const htmlKey = htmlOutputKey(sessionId, documentId);
  try {
    await uploadObject(htmlKey, result.html, "text/html; charset=utf-8");
  } catch {
    console.error(`[api/convert] job=${jobId} html upload failed`);
    return json({ error: "Could not store the converted document." }, 500);
  }

  const completedAt = new Date().toISOString();
  await db.transaction(async (tx) => {
    await tx
      .update(conversionJobs)
      .set({
        status: "completed",
        completedAt,
        updatedAt: completedAt,
        modelName: result.model,
      })
      .where(eq(conversionJobs.id, jobId));

    // uq_available_artifact_per_job_type allows one available artifact per type,
    // so a re-convert updates the existing row rather than inserting a second.
    for (const artifact of [
      {
        artifactType: "source_pdf" as const,
        filename,
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
        .values({ jobId, artifactStatus: "available", ...artifact })
        .onConflictDoUpdate({
          target: [artifacts.jobId, artifacts.artifactType],
          targetWhere: sql`artifact_status = 'available'`,
          set: {
            filename: artifact.filename,
            mimeType: artifact.mimeType,
            storageKey: artifact.storageKey,
            fileSizeBytes: artifact.fileSizeBytes,
            previewSnippet: artifact.previewSnippet,
            createdAt: completedAt,
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
          title: FINDING_TITLES[issue.type] ?? FINDING_TITLES.other,
          message: issue.message,
          suggestion: issue.suggestion,
          wcag: issue.wcag ?? null,
          location: issue.element ? { element: issue.element } : null,
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
        costUsd: call.costUsd !== null ? String(call.costUsd) : null,
      }))
    );
  });

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
  } catch {
    // Driver/storage exceptions may contain query parameters or credentials.
    // Keep them out of both HTTP responses and the host's exception logs.
    console.error("[api/convert] request failed unexpectedly");
    return json(
      { error: "Could not complete the conversion. Please try again." },
      500
    );
  }
}
