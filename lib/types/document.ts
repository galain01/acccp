import type { AccessibilityError } from "@/lib/convert";

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
  name: string;
  size: number;
  uploadedAt: Date;
  status: ConversionStatus;
  locked: boolean;
  html?: string;
  errorMessage?: string;
  /** Accessibility/parsing issues from the most recent conversion run. */
  errors?: AccessibilityError[];
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
