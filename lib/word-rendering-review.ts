import type { AccessibilityError, ConversionResult } from "./convert";

export const WORD_RENDERING_REVIEW_MESSAGE =
  "Compare this result with the Word original. Rendering may omit externally linked images and resources or change fonts or layout; the PDF accessibility audit cannot detect content already omitted during rendering.";

/** A successful render alone cannot establish fidelity to the Word original. */
export function withWordRenderingReview(
  result: ConversionResult
): ConversionResult {
  const finding: AccessibilityError = {
    type: "other",
    severity: "warning",
    message: WORD_RENDERING_REVIEW_MESSAGE,
    suggestion:
      "Check that all content, images, tables, and reading order match the original. Embed linked images/resources in Word before retrying, or upload a PDF exported from Word.",
  };
  return {
    ...result,
    errors: [...result.errors, finding],
    extractionWarnings: [...result.extractionWarnings, finding.message],
  };
}
