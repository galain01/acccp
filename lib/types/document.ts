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
  /** documents.id. Absent until the first conversion stores the document. */
  documentId?: string;
  jobId?: string;
  /** Existing saved HTML documents default to canvas_html. Fixed per upload. */
  outputTarget?: OutputTarget;
  name: string;
  size: number;
  uploadedAt: Date;
  status: ConversionStatus;
  locked: boolean;
  html?: string;
  errorMessage?: string;
  /** Accessibility/parsing issues from the most recent conversion run. */
  errors?: AccessibilityError[];
  /** Plain-language summary of changes actually applied to a PowerPoint file. */
  changes?: string[];
  /**
   * The picked file, held only until the server has stored it. Documents loaded
   * from the database have none — their source PDF is re-read from storage instead.
   */
  file?: File;
}

/** Mirrors the columns of `sessions` that the dashboard UI needs. */
export interface Session {
  id: string;
  title: string;
}
