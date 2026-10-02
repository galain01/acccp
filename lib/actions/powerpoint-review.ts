"use server";

import { verifyRoleOrRedirect } from "@/lib/auth";
import { DocumentUnavailableError } from "@/lib/document-retention";
import {
  readOwnedPowerPointReview,
  readOwnedPowerPointPreview,
  PowerPointReviewError,
} from "@/lib/powerpoint-review-storage";
import type {
  PowerPointReviewData,
  PowerPointReviewPreview,
} from "@/lib/powerpoint-review-contract";

export async function getPowerPointReview(
  documentId: string,
  jobId: string
): Promise<PowerPointReviewData | null> {
  const session = await verifyRoleOrRedirect(["instructor", "admin"]);
  try {
    return await readOwnedPowerPointReview(session.user.id, documentId, jobId);
  } catch (error) {
    if (error instanceof DocumentUnavailableError) return null;
    if (error instanceof PowerPointReviewError) throw new Error(error.message);
    throw new Error("Could not open the saved changes. Please try again.");
  }
}

export async function getPowerPointReviewPreview(
  documentId: string,
  jobId: string,
  revisionToken: string,
  slideNumber: number
): Promise<PowerPointReviewPreview | null> {
  const session = await verifyRoleOrRedirect(["instructor", "admin"]);
  try {
    return await readOwnedPowerPointPreview(
      session.user.id,
      documentId,
      jobId,
      revisionToken,
      slideNumber
    );
  } catch {
    return null;
  }
}
