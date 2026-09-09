"use server";

import { and, desc, eq, inArray, isNull } from "drizzle-orm";

import type { AccessibilityError } from "@/lib/convert";
import { verifyRoleOrRedirect } from "@/lib/auth";
import { toConversionStatus } from "@/lib/conversion-status";
import { db } from "@/lib/db";
import {
  artifacts,
  conversionJobs,
  documents,
  sessions,
  validationFindings,
} from "@/lib/db/schema";
import {
  downloadObject,
  htmlOutputKey,
  removeObjects,
  sourceDocxKey,
  sourcePdfKey,
} from "@/lib/storage";
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
    })
    .from(documents)
    .innerJoin(sessions, eq(sessions.id, documents.sessionId))
    .leftJoin(conversionJobs, eq(conversionJobs.documentId, documents.id))
    .where(
      and(
        eq(documents.sessionId, sessionId),
        eq(sessions.ownerUserId, userId),
        isNull(documents.deletedAt)
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
        message: validationFindings.message,
        suggestion: validationFindings.suggestion,
        wcag: validationFindings.wcag,
        location: validationFindings.location,
      })
      .from(validationFindings)
      .where(inArray(validationFindings.jobId, jobIds));

    for (const finding of findingRows) {
      const errors = findingsByJobId.get(finding.jobId) ?? [];
      const location = finding.location as { element?: string } | null;
      errors.push({
        type: (finding.ruleCode as AccessibilityError["type"]) ?? "other",
        severity: finding.severity === "info" ? "warning" : finding.severity,
        message: finding.message,
        suggestion: finding.suggestion ?? "",
        wcag: finding.wcag ?? undefined,
        element: location?.element,
      });
      findingsByJobId.set(finding.jobId, errors);
    }
  }

  return rows.map((row) => ({
    id: row.id,
    documentId: row.id,
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

  const [row] = await db
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
        eq(artifacts.artifactStatus, "available"),
        isNull(documents.deletedAt)
      )
    );

  if (!row) return null;
  return (await downloadObject(row.storageKey)).toString("utf8");
}

export async function deleteDocument(documentId: string): Promise<void> {
  const userId = await requireUserId();

  const [doc] = await db
    .select({ id: documents.id, sessionId: documents.sessionId })
    .from(documents)
    .innerJoin(sessions, eq(sessions.id, documents.sessionId))
    .where(
      and(
        eq(documents.id, documentId),
        eq(sessions.ownerUserId, userId),
        isNull(documents.deletedAt)
      )
    );
  if (!doc) return;

  await db
    .update(documents)
    .set({ deletedAt: new Date().toISOString() })
    .where(eq(documents.id, documentId));

  // Best-effort: the row is already tombstoned, so a storage hiccup here should
  // not surface as a failed delete.
  try {
    await removeObjects([
      sourcePdfKey(doc.sessionId, documentId),
      sourceDocxKey(doc.sessionId, documentId),
      htmlOutputKey(doc.sessionId, documentId),
    ]);
  } catch {
    // A storage provider error can include request details; keep those out of
    // deployment logs while retaining the event needed to retry cleanup.
    console.error(`[documents] blob cleanup failed for ${documentId}`);
  }
}
