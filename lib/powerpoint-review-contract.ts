import type { AccessibilityError } from "./accessibility-findings";
import type { PptxRevisionChange } from "./pptx-types";

export interface PowerPointReviewPreview {
  slideNumber: number;
  before: string;
  after: string;
}

export interface PowerPointReviewData {
  revisionToken: string;
  changes: PptxRevisionChange[];
  findings: AccessibilityError[];
  includedChangeIds: string[];
  reviewedChangeIds: string[];
  descriptionEdits: Record<string, string>;
  previewSlideNumbers?: number[];
  previews?: PowerPointReviewPreview[];
}

export interface PowerPointReviewSelection {
  documentId: string;
  jobId: string;
  revisionToken: string;
  includedChangeIds: string[];
  reviewedChangeIds: string[];
  descriptionEdits: Record<string, string>;
}

export interface PowerPointReviewExport {
  revisionToken: string;
  url: string;
  filename: string;
  findings: AccessibilityError[];
  changes: string[];
}

/** Bound the public request before any source download, render, or model call. */
export function isPowerPointReviewSelection(
  value: unknown
): value is PowerPointReviewSelection {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  const uuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (
    Object.keys(item).some(
      (key) =>
        ![
          "documentId",
          "jobId",
          "revisionToken",
          "includedChangeIds",
          "reviewedChangeIds",
          "descriptionEdits",
        ].includes(key)
    )
  )
    return false;
  if (
    typeof item.documentId !== "string" ||
    !uuid.test(item.documentId) ||
    typeof item.jobId !== "string" ||
    !uuid.test(item.jobId) ||
    typeof item.revisionToken !== "string" ||
    !/^[a-f0-9]{64}$/.test(item.revisionToken)
  )
    return false;
  for (const ids of [item.includedChangeIds, item.reviewedChangeIds]) {
    if (
      !Array.isArray(ids) ||
      ids.length > 2000 ||
      ids.some((id) => typeof id !== "string" || !id || id.length > 160) ||
      new Set(ids).size !== ids.length
    )
      return false;
  }
  const edits = item.descriptionEdits;
  return (
    !!edits &&
    typeof edits === "object" &&
    !Array.isArray(edits) &&
    Object.keys(edits).length <= 2000 &&
    Object.entries(edits).every(
      ([key, text]) =>
        key.length > 0 &&
        key.length <= 160 &&
        typeof text === "string" &&
        text.trim().length > 0 &&
        text.length <= 2000 &&
        !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text)
    )
  );
}
