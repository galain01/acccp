import {
  isDocxFilename,
  isPdfFilename,
  isPptxFilename,
} from "./document-input";

/** Input files and their output destinations are separate, versioned contracts. */
export type OutputTarget =
  | "canvas_html"
  | "accessible_pptx"
  | "accessible_docx"
  | "accessible_pdf";

export const DEFAULT_OUTPUT_TARGET: OutputTarget = "canvas_html";
export const OUTPUT_PROFILES = {
  canvas_html: { label: "Canvas HTML", version: "canvas-html-v1" },
  accessible_pptx: { label: "Accessible PowerPoint", version: "powerpoint-v1" },
  accessible_docx: { label: "Accessible Word", version: "word-v1" },
  accessible_pdf: { label: "PDF accessibility repair", version: "pdf-v1" },
} as const;

export function isOutputTarget(value: unknown): value is OutputTarget {
  return (
    value === "canvas_html" ||
    value === "accessible_pptx" ||
    value === "accessible_docx" ||
    value === "accessible_pdf"
  );
}

export function getOutputTargetForFilename(filename: string): OutputTarget {
  return isPptxFilename(filename) ? "accessible_pptx" : "canvas_html";
}

export function isSupportedOutputForFilename(
  filename: string,
  outputTarget: OutputTarget
): boolean {
  return outputTarget === "accessible_pptx"
    ? isPptxFilename(filename)
    : outputTarget === "accessible_docx"
      ? isDocxFilename(filename)
      : outputTarget === "accessible_pdf"
        ? isPdfFilename(filename)
        : isPdfFilename(filename) || isDocxFilename(filename);
}

export const supportsOutputTarget = isSupportedOutputForFilename;

export function outputFilename(
  filename: string,
  outputTarget: OutputTarget
): string {
  const stem = filename
    .replace(/\.(?:pdf|docx|pptx)$/i, "")
    .replace(/[\x00-\x1f\x7f/\\]/g, "_");
  return outputTarget === "accessible_pptx"
    ? `${stem}-accessible.pptx`
    : outputTarget === "accessible_docx"
      ? `${stem}-accessible.docx`
      : outputTarget === "accessible_pdf"
        ? `${stem}-repaired.pdf`
        : `${stem}.html`;
}

/** Change summaries contain document content and follow the same retention. */
export function readOutputChanges(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === "string")
        .slice(0, 256)
        .map((item) => item.slice(0, 500))
    : [];
}
