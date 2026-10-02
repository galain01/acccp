"use server";

import { and, desc, eq, inArray, sql } from "drizzle-orm";

import {
  readFindingLocation,
  type AccessibilityError,
} from "@/lib/accessibility-findings";
import { verifyRoleOrRedirect } from "@/lib/auth";
import { toConversionStatus } from "@/lib/conversion-status";
import { db } from "@/lib/db";
import {
  deleteOwnedDocument,
  DocumentUnavailableError,
  retainedDocumentCondition,
  withRetainedDocument,
} from "@/lib/document-retention";
import {
  artifacts,
  conversionJobs,
  documents,
  sessions,
  validationFindings,
} from "@/lib/db/schema";
import { isDocumentExpired, retentionExpiresAt } from "@/lib/retention";
import { createSignedUrl, downloadObject } from "@/lib/storage";
import {
  getOutputTargetForFilename,
  isOutputTarget,
  outputFilename,
  readOutputChanges,
  type OutputTarget,
} from "@/lib/output-formats";
import type { UploadedDocument } from "@/lib/types/document";

// RLS is enabled but has no policies, so ownership is enforced here: every
// query joins `sessions` and constrains owner_user_id.
async function requireUserId(): Promise<string> {
  const session = await verifyRoleOrRedirect(["instructor", "admin"]);
  return session.user.id;
}

export async function listDocuments(
  sessionId: string
): Promise<UploadedDocument[]> {
  const userId = await requireUserId();

  const rows = await db
    .select({
      id: documents.id,
      name: documents.originalFilename,
      size: documents.fileSizeBytes,
      uploadedAt: documents.createdAt,
      jobId: conversionJobs.id,
      status: conversionJobs.status,
      errorMessage: conversionJobs.errorMessage,
      outputTarget: conversionJobs.outputTarget,
      changes: sql<unknown>`(select metadata -> 'changes' from job_events where job_events.job_id = ${conversionJobs.id} and event_type in ('conversion_completed', 'powerpoint_review_finished') and metadata ? 'changes' order by created_at desc, id desc limit 1)`,
    })
    .from(documents)
    .innerJoin(sessions, eq(sessions.id, documents.sessionId))
    .leftJoin(conversionJobs, eq(conversionJobs.documentId, documents.id))
    .where(
      and(
        eq(documents.sessionId, sessionId),
        eq(sessions.ownerUserId, userId),
        retainedDocumentCondition()
      )
    )
    .orderBy(desc(documents.createdAt));

  const jobIds = rows
    .map((row) => row.jobId)
    .filter((id): id is string => id !== null);
  const findingsByJobId = new Map<string, AccessibilityError[]>();
  if (jobIds.length > 0) {
    const findingRows = await db
      .select({
        jobId: validationFindings.jobId,
        severity: validationFindings.severity,
        ruleCode: validationFindings.ruleCode,
        title: validationFindings.title,
        category: validationFindings.category,
        message: validationFindings.message,
        suggestion: validationFindings.suggestion,
        wcag: validationFindings.wcag,
        location: validationFindings.location,
        pageCount: conversionJobs.pageCount,
      })
      .from(validationFindings)
      .innerJoin(
        conversionJobs,
        eq(conversionJobs.id, validationFindings.jobId)
      )
      .innerJoin(documents, eq(documents.id, conversionJobs.documentId))
      .innerJoin(sessions, eq(sessions.id, documents.sessionId))
      .where(
        and(
          inArray(validationFindings.jobId, jobIds),
          eq(documents.sessionId, sessionId),
          eq(sessions.ownerUserId, userId),
          retainedDocumentCondition()
        )
      );

    for (const finding of findingRows) {
      const errors = findingsByJobId.get(finding.jobId) ?? [];
      const storedLocation =
        finding.location && typeof finding.location === "object"
          ? (finding.location as Record<string, unknown>)
          : null;
      const category = [
        "accessibility",
        "canvas",
        "source-review",
        "content-fidelity",
      ].includes(finding.category)
        ? (finding.category as AccessibilityError["category"])
        : undefined;
      errors.push({
        type: (finding.ruleCode as AccessibilityError["type"]) ?? "other",
        severity: finding.severity === "info" ? "warning" : finding.severity,
        title: finding.title ?? undefined,
        category,
        message: finding.message,
        suggestion: finding.suggestion ?? "",
        wcag: finding.wcag ?? undefined,
        element:
          typeof storedLocation?.element === "string"
            ? storedLocation.element.slice(0, 240)
            : undefined,
        location: readFindingLocation(
          storedLocation,
          finding.pageCount ?? undefined
        ),
      });
      findingsByJobId.set(finding.jobId, errors);
    }
  }

  // A second query can cross the expiry boundary after the list was read.
  const now = new Date();
  return rows
    .filter((row) => !isDocumentExpired(row.uploadedAt, now))
    .map((row) => ({
      id: row.id,
      documentId: row.id,
      jobId: row.jobId ?? undefined,
      outputTarget: row.outputTarget ?? getOutputTargetForFilename(row.name),
      changes: readOutputChanges(row.changes),
      name: row.name,
      size: row.size,
      uploadedAt: new Date(row.uploadedAt),
      status: toConversionStatus(row.status),
      // `documents` has no locked column, so the lock resets on reload.
      locked: false,
      errorMessage: row.errorMessage ?? undefined,
      errors: row.jobId ? findingsByJobId.get(row.jobId) : undefined,
    }));
}

/**
 * The HTML lives in storage rather than a column, so it is fetched on demand
 * instead of being loaded for every row of the documents table.
 */
export async function getDocumentHtml(
  documentId: string
): Promise<string | null> {
  const userId = await requireUserId();

  try {
    return await withRetainedDocument(documentId, async (tx, document) => {
      const [row] = await tx
        .select({ storageKey: artifacts.storageKey })
        .from(artifacts)
        .innerJoin(conversionJobs, eq(conversionJobs.id, artifacts.jobId))
        .innerJoin(documents, eq(documents.id, conversionJobs.documentId))
        .innerJoin(sessions, eq(sessions.id, documents.sessionId))
        .where(
          and(
            eq(documents.id, documentId),
            eq(sessions.ownerUserId, userId),
            eq(artifacts.artifactType, "html_output"),
            eq(conversionJobs.outputTarget, "canvas_html"),
            eq(artifacts.artifactStatus, "available"),
            retainedDocumentCondition()
          )
        );

      if (!row) return null;
      const html = await downloadObject(row.storageKey);
      // Keep the row locked through storage access; expiry can still pass
      // while the network request is in flight.
      if (isDocumentExpired(document.createdAt)) return null;
      return html.toString("utf8");
    });
  } catch (error) {
    if (error instanceof DocumentUnavailableError) return null;
    throw error;
  }
}

/** Return a short-lived, attachment download for the owned, unexpired output. */
export async function getDocumentOutputDownload(
  documentId: string,
  outputTarget: OutputTarget
): Promise<{ url: string; filename: string } | null> {
  const userId = await requireUserId();
  if (!isOutputTarget(outputTarget)) return null;
  try {
    return await withRetainedDocument(documentId, async (tx, document) => {
      const [row] = await tx
        .select({
          storageKey: artifacts.storageKey,
          filename: documents.originalFilename,
        })
        .from(artifacts)
        .innerJoin(conversionJobs, eq(conversionJobs.id, artifacts.jobId))
        .innerJoin(documents, eq(documents.id, conversionJobs.documentId))
        .innerJoin(sessions, eq(sessions.id, documents.sessionId))
        .where(
          and(
            eq(documents.id, documentId),
            eq(sessions.ownerUserId, userId),
            eq(conversionJobs.outputTarget, outputTarget),
            eq(
              artifacts.artifactType,
              outputTarget === "accessible_pptx" ? "pptx_output" : "html_output"
            ),
            eq(artifacts.artifactStatus, "available"),
            retainedDocumentCondition()
          )
        );
      if (!row) return null;
      // Do not grant a signed URL beyond the document's original expiry.
      // Reserve a second for signing/clock rounding and recheck afterward.
      const expiresAt = Date.parse(retentionExpiresAt(document.createdAt));
      const ttl = Math.min(60, Math.floor((expiresAt - Date.now()) / 1000) - 1);
      if (ttl < 1) return null;
      const filename = outputFilename(row.filename, outputTarget);
      const url = await createSignedUrl(row.storageKey, ttl, filename);
      // Withhold a late response if response-time + TTL would pass expiry.
      if (Date.now() + ttl * 1000 > expiresAt) return null;
      return { url, filename };
    });
  } catch (error) {
    if (error instanceof DocumentUnavailableError) return null;
    throw new Error(
      "Could not prepare the document download. Please try again."
    );
  }
}

export async function deleteDocument(documentId: string): Promise<void> {
  const userId = await requireUserId();

  await deleteOwnedDocument(documentId, userId);
}
