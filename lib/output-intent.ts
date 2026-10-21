import {
  isDocxFilename,
  isPdfFilename,
  isPptxFilename,
} from "./document-input";
import {
  DEFAULT_OUTPUT_TARGET,
  isSupportedOutputForFilename,
  type OutputTarget,
} from "./output-formats";

/** A browser-only preference, separate from implemented API destinations. */
export type OutputIntent = "original" | "html";

export interface OutputChoice {
  label: string;
  target?: OutputTarget;
  unavailableReason?: string;
}

export function isOutputIntent(value: unknown): value is OutputIntent {
  return value === "original" || value === "html";
}

export function getOutputChoice(
  filename: string,
  intent: OutputIntent
): OutputChoice {
  if (intent === "html") {
    return isSupportedOutputForFilename(filename, "canvas_html")
      ? { label: "HTML (Canvas)", target: "canvas_html" }
      : {
          label: "HTML (Canvas)",
          unavailableReason: isPptxFilename(filename)
            ? "PowerPoint to HTML is not available yet. Choose original format to improve this presentation."
            : "This file type is not supported. Upload a .docx, .pdf, or .pptx file.",
        };
  }
  if (isPptxFilename(filename))
    return { label: "PowerPoint (.pptx)", target: "accessible_pptx" };
  if (isDocxFilename(filename))
    return {
      label: "Word (.docx)",
      unavailableReason:
        "Word output is not available yet. You can choose HTML (Canvas), or keep your original file for a future release.",
    };
  if (isPdfFilename(filename))
    return {
      label: "PDF (.pdf)",
      unavailableReason:
        "PDF output is not available yet. You can choose HTML (Canvas), or keep your original file for a future release.",
    };
  return {
    label: "Original format",
    unavailableReason:
      "This file type is not supported. Upload a .docx, .pdf, or .pptx file.",
  };
}

/** Saved and legacy rows keep their actual destination; new rows retain intent. */
export function getDocumentOutputChoice(document: {
  name: string;
  outputTarget?: OutputTarget;
  outputIntent?: OutputIntent;
}): OutputChoice {
  if (document.outputIntent)
    return getOutputChoice(document.name, document.outputIntent);
  const target = document.outputTarget ?? DEFAULT_OUTPUT_TARGET;
  const choice = getOutputChoice(
    document.name,
    target === "canvas_html" ? "html" : "original"
  );
  return isSupportedOutputForFilename(document.name, target)
    ? { label: choice.label, target }
    : {
        label: choice.label,
        unavailableReason:
          "This saved file cannot be processed with its output format. Previous results remain available until they expire.",
      };
}

/** Once an attempt starts its destination stays fixed, even if upload fails. */
export function canChooseDocumentOutput(document: {
  status: string;
  documentId?: string;
  jobId?: string;
  file?: File;
  locked: boolean;
}): boolean {
  return (
    document.status === "idle" &&
    !document.documentId &&
    !document.jobId &&
    Boolean(document.file) &&
    !document.locked
  );
}
