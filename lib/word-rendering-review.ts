import type { AccessibilityError, ConversionResult } from "./convert";

export const WORD_RENDERING_REVIEW_MESSAGE =
  "Your Word document was first turned into a PDF. That step can leave out pictures linked from another file or change how content is arranged. The automatic check compares the HTML with that PDF, so it cannot detect anything already lost from the Word original.";

/** A successful render alone cannot establish fidelity to the Word original. */
export function withWordRenderingReview(
  result: ConversionResult
): ConversionResult {
  const finding: AccessibilityError = {
    type: "other",
    severity: "warning",
    title: "Compare the converted page with your Word document",
    category: "source-review",
    message: WORD_RENDERING_REVIEW_MESSAGE,
    suggestion:
      "Open your original Word document and the converted page side by side. Check that the text, pictures, tables, and their order match. If something is missing, add it in Canvas or save a PDF from Word, check that PDF, and upload it to convert again.",
    location: {
      scope: "document",
      sourcePages: null,
      printedPageLabel: null,
      section: null,
      locator: null,
      quote: null,
    },
  };
  return {
    ...result,
    errors: [...result.errors, finding],
    extractionWarnings: [...result.extractionWarnings, finding.message],
  };
}
