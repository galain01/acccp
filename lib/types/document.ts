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
  /** Stable key for the UI; saved rows use `documentId`, local rows keep their key. */
  id: string;
  /** Server-assigned identity, available before persistence for prepared submissions. */
  documentId?: string;
  /** The original source has been verified; false reservations cannot be converted by ID yet. */
  sourceReady?: boolean;
  jobId?: string;
  /** Implemented destination; fixed once processing starts. Legacy rows default to HTML. */
  outputTarget?: OutputTarget;
  /** New local files retain the requested format even when it is unavailable. */
  outputIntent?: OutputIntent;
  name: string;
  size: number;
  uploadedAt: Date;
  status: ConversionStatus;
  /** An owned, retained output exists independently of the latest attempt's status. */
  hasAvailableOutput?: boolean;
  /** Immutable artifact identity for the listed output and its review snapshot. */
  savedOutputArtifactId?: string;
  /** Browser-only: a failed request could not be reconciled with the saved result. */
  savedResultUnverified?: boolean;
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
