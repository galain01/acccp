"use server";

import { and, desc, eq, inArray } from "drizzle-orm";

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
import { isDocumentExpired } from "@/lib/retention";
import { downloadObject } from "@/lib/storage";
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

export async function deleteDocument(documentId: string): Promise<void> {
  const userId = await requireUserId();

  await deleteOwnedDocument(documentId, userId);
}
