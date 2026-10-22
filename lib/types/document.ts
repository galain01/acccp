import type { AccessibilityError } from "@/lib/convert";
import type { OutputTarget } from "@/lib/output-formats";
import type { OutputIntent } from "@/lib/output-intent";
import type { PdfInteractionTestSummary } from "@/lib/pdf-interaction-summary";

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
  /** Implemented destination; fixed once processing starts. Legacy rows default to HTML. */
  outputTarget?: OutputTarget;
  /** New local files retain the requested format even when it is unavailable. */
  outputIntent?: OutputIntent;
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
  /** Plain-language summary of changes actually applied to a native output. */
  changes?: string[];
  /** Earlier interaction tests matched to this successful repaired PDF. */
  interactionTestSummary?: PdfInteractionTestSummary;
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
