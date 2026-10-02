import type { AccessibilityError } from "@/lib/convert";
import type { OutputTarget } from "@/lib/output-formats";

export type ConversionStatus =
  | "idle"
  | "queued"
  | "processing"
  | "success"
  | "error";

export interface UploadedDocument {
  /** Stable key for the UI. Equals `documentId` once the document is persisted. */
  id: string;
  /** documents.id. Present after the source is saved, before or during conversion. */
  documentId?: string;
  jobId?: string;
  /** Existing saved HTML documents default to canvas_html. Fixed per upload. */
  outputTarget?: OutputTarget;
  name: string;
  size: number;
  uploadedAt: Date;
  status: ConversionStatus;
  /** Temporary browser-only phase; the saved job keeps the existing statuses. */
  processingPhase?: "uploading";
  locked: boolean;
  html?: string;
  errorMessage?: string;
  /** Accessibility/parsing issues from the most recent conversion run. */
  errors?: AccessibilityError[];
  /** Plain-language summary of changes actually applied to a PowerPoint file. */
  changes?: string[];
  /**
   * The picked local file, kept in browser memory for upload retries. Documents
   * loaded from the database have none — their source is re-read from storage.
   */
  file?: File;
}

/** Mirrors the columns of `sessions` that the dashboard UI needs. */
export interface Session {
  id: string;
  title: string;
}
