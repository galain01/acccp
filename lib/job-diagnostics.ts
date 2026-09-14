/** Data-only, bounded diagnostics. No provider messages or arbitrary metadata. */
export const DIAGNOSTIC_STAGES = [
  "word_to_pdf",
  "pdf_render",
  "conversion",
  "audit",
  "save_output",
  "unknown",
] as const;
export type DiagnosticStage = (typeof DIAGNOSTIC_STAGES)[number];

export const DIAGNOSTIC_CODES = [
  "unknown_error",
  "provider_configuration",
  "provider_auth",
  "provider_model_not_found",
  "provider_request_rejected",
  "provider_payload_limit",
  "provider_rate_or_quota",
  "provider_rate_limit",
  "provider_quota",
  "provider_budget",
  "provider_unavailable",
  "provider_connection",
  "provider_invalid_json",
  "provider_invalid_response",
  "model_output_limit",
  "model_content_filter",
  "model_invalid_output",
  "pdf_invalid",
  "pdf_password",
  "pdf_page_limit",
  "pdf_image_limit",
  "pdf_complexity_limit",
  "pdf_render_warning",
  "pdf_page_failed",
  "pdf_output_limit",
  "pdf_timeout",
  "pdf_worker_failed",
  "pdf_protocol_error",
  "word_configuration",
  "word_rejected",
  "word_size_limit",
  "word_busy",
  "word_timeout",
  "word_connection",
  "word_invalid_output",
  "output_storage_failed",
] as const;
export type DiagnosticCode = (typeof DIAGNOSTIC_CODES)[number];

export interface JobDiagnostic {
  version: 1;
  stage: DiagnosticStage;
  code: DiagnosticCode;
  pageNumber?: number;
  httpStatus?: number;
  elapsedMs?: number;
  attemptNumber?: number;
  model?: string;
  retryAfterSeconds?: number;
  providerRequestId?: string;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
const isStage = (value: unknown): value is DiagnosticStage =>
  typeof value === "string" &&
  (DIAGNOSTIC_STAGES as readonly string[]).includes(value);
const isCode = (value: unknown): value is DiagnosticCode =>
  typeof value === "string" &&
  (DIAGNOSTIC_CODES as readonly string[]).includes(value);

/** Accepts a partial input at trusted call sites; unknown fields never survive. */
export function createJobDiagnostic(input: unknown): JobDiagnostic {
  const result: JobDiagnostic = {
    version: 1,
    stage: "unknown",
    code: "unknown_error",
  };
  try {
    const value = record(input);
    if (!value) return result;
    if (isStage(value.stage)) result.stage = value.stage;
    if (isCode(value.code)) result.code = value.code;
    const integer = (
      key:
        | "pageNumber"
        | "httpStatus"
        | "elapsedMs"
        | "attemptNumber"
        | "retryAfterSeconds",
      min: number,
      max: number
    ) => {
      const number = value[key];
      if (
        typeof number === "number" &&
        Number.isSafeInteger(number) &&
        number >= min &&
        number <= max
      )
        result[key] = number;
    };
    integer("pageNumber", 1, 100_000);
    integer("httpStatus", 100, 599);
    integer("elapsedMs", 0, 86_400_000);
    integer("attemptNumber", 1, 2_147_483_647);
    integer("retryAfterSeconds", 0, 86_400);
    // This is the configured model identifier, never a provider-body field.
    if (
      typeof value.model === "string" &&
      value.model.length <= 128 &&
      /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(value.model) &&
      !value.model.includes("://") &&
      !/^(?:sk-|Bearer|eyJ)/i.test(value.model)
    )
      result.model = value.model;
    // LiteLLM's call identifier is a UUID. Reject other opaque strings rather
    // than risk retaining echoed document content, credentials or URLs.
    if (
      typeof value.providerRequestId === "string" &&
      value.providerRequestId.length === 36 &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        value.providerRequestId
      )
    )
      result.providerRequestId = value.providerRequestId;
  } catch {
    // Defensive against unexpected objects/getters; normal storage is JSON.
  }
  return result;
}

/** Stored metadata needs the explicit supported version and recognized enums. */
export function readJobDiagnostic(input: unknown): JobDiagnostic | null {
  try {
    const value = record(input);
    if (
      !value ||
      value.version !== 1 ||
      !isStage(value.stage) ||
      !isCode(value.code)
    )
      return null;
    return createJobDiagnostic(value);
  } catch {
    return null;
  }
}

const STAGE_LABELS: Record<DiagnosticStage, string> = {
  word_to_pdf: "Word-to-PDF conversion",
  pdf_render: "PDF page preparation",
  conversion: "HTML conversion",
  audit: "Accessibility check",
  save_output: "Saving results",
  unknown: "Document processing",
};
export function diagnosticStageLabel(stage: DiagnosticStage): string {
  return isStage(stage) ? STAGE_LABELS[stage] : STAGE_LABELS.unknown;
}

const EXPLANATIONS: Record<DiagnosticCode, string> = {
  unknown_error:
    "The app could not finish this step. Try again; if the problem continues, contact the app administrator.",
  provider_configuration:
    "The app's AI connection is not configured. Contact the app administrator.",
  provider_auth:
    "The AI service did not accept the app's access credentials or permissions. Contact the app administrator.",
  provider_model_not_found:
    "The AI service could not find the requested model or endpoint. Contact the app administrator.",
  provider_request_rejected:
    "The AI service rejected the request. This response does not establish that your document is damaged. Contact the app administrator if it continues.",
  provider_payload_limit:
    "The request is larger than the AI service accepts. Try a shorter document or ask the app administrator to check the service limits.",
  provider_rate_or_quota:
    "The AI service reported a usage limit, but did not identify whether it is temporary or relates to the account's allowance. If retrying later does not help, contact the app administrator.",
  provider_rate_limit:
    "The AI service reported too many requests or too much processing at once. Try again later.",
  provider_quota:
    "The AI service reported that its usage allowance is exhausted. Contact the app administrator before trying again.",
  provider_budget:
    "The AI service reported that a spending limit was reached. Contact the app administrator before trying again.",
  provider_unavailable:
    "The AI service is temporarily unavailable. Try again later.",
  provider_connection:
    "The app could not complete its connection to the AI service. Try again; if it continues, contact the app administrator.",
  provider_invalid_json:
    "The AI service returned a response the app could not read. Try again; if it continues, contact the app administrator.",
  provider_invalid_response:
    "The AI service returned an incomplete or unexpected response. Try again; if it continues, contact the app administrator.",
  model_output_limit:
    "The AI service stopped before finishing its answer because it reached an output limit. Try a shorter document.",
  model_content_filter:
    "The AI service stopped the answer because of its content rules. Contact the app administrator if this appears incorrect.",
  model_invalid_output:
    "The AI service did not return a usable HTML conversion. Try again or contact the app administrator.",
  pdf_invalid:
    "The app could not read this PDF. Export a fresh PDF from the original document and try again.",
  pdf_password:
    "The PDF is encrypted or password-protected. Upload an unprotected copy.",
  pdf_page_limit:
    "The PDF has more pages than the app can process in one job. Split it into shorter documents and try again.",
  pdf_image_limit:
    "An image in the PDF exceeds the app's processing limits. Reduce large images or export a smaller PDF and try again.",
  pdf_complexity_limit:
    "The PDF exceeds the app's processing limits. Export a fresh or simpler PDF, or split it into shorter documents.",
  pdf_render_warning:
    "The app could not confirm that the PDF page was reproduced completely. Export a fresh PDF and try again.",
  pdf_page_failed:
    "The app could not prepare this PDF page for the AI service. Check the page and try a fresh PDF export.",
  pdf_output_limit:
    "The prepared page images exceed the app's size limits. Try a shorter document or reduce large images.",
  pdf_timeout:
    "Preparing the PDF pages took longer than the app allows. Try a shorter or simpler document.",
  pdf_worker_failed:
    "The PDF preparation service stopped unexpectedly. Try again; if it continues, contact the app administrator.",
  pdf_protocol_error:
    "The app could not read the result from its PDF preparation service. Contact the app administrator if retrying does not help.",
  word_configuration:
    "The app's Word conversion service is not configured. Contact the app administrator.",
  word_rejected:
    "The Word conversion service rejected the document. Try saving a fresh Word file or exporting a PDF yourself.",
  word_size_limit:
    "The Word file or its resulting PDF exceeds the app's size limit. Reduce large images or split the document.",
  word_busy:
    "The Word conversion service is busy or unavailable. Try again later.",
  word_timeout:
    "Converting the Word file to PDF took too long. Try a shorter document or export a PDF yourself.",
  word_connection:
    "The app could not connect to the Word conversion service. Try again later or contact the app administrator.",
  word_invalid_output:
    "The Word conversion service did not return a usable PDF. Save a fresh Word file or export a PDF yourself.",
  output_storage_failed:
    "The conversion finished, but the app could not save the results. Try again; if it continues, contact the app administrator.",
};

/** Faculty text is generated solely from enums and validated numeric values. */
export function describeJobDiagnostic(input: JobDiagnostic): string {
  const diagnostic = createJobDiagnostic(input);
  const location =
    diagnostic.pageNumber !== undefined
      ? ` on PDF page ${diagnostic.pageNumber}`
      : "";
  let explanation = EXPLANATIONS[diagnostic.code];
  if (
    diagnostic.retryAfterSeconds !== undefined &&
    [
      "provider_rate_limit",
      "provider_rate_or_quota",
      "provider_unavailable",
    ].includes(diagnostic.code)
  )
    explanation += ` The service suggests waiting ${diagnostic.retryAfterSeconds} seconds before retrying.`;
  return `${diagnosticStageLabel(diagnostic.stage)} stopped${location}. ${explanation}`;
}
