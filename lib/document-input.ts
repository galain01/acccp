/** Shared browser/server upload rules; leave room for Vercel's multipart overhead. */
export const MAX_FILE_SIZE_BYTES = 4 * 1024 * 1024;
export const PDF_MIME_TYPE = "application/pdf";
export const DOCX_MIME_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

export function isDocxFilename(filename: string): boolean {
  return filename.toLowerCase().endsWith(".docx");
}

export function isSupportedDocumentFilename(filename: string): boolean {
  return isPdfFilename(filename) || isDocxFilename(filename);
}

export function isPdfFilename(filename: string): boolean {
  return filename.toLowerCase().endsWith(".pdf");
}

/** A quick format check; bounded server-side parsing/rendering happens afterward. */
export function isPdfBuffer(buffer: Uint8Array): boolean {
  return (
    buffer.length >= 5 &&
    buffer[0] === 0x25 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x44 &&
    buffer[3] === 0x46 &&
    buffer[4] === 0x2d
  );
}

export function validatePdfInput(
  buffer: Uint8Array,
  filename: string
): string | null {
  if (!isPdfFilename(filename)) {
    return "Only PDF files are supported. Export your Word document as a PDF, then upload it.";
  }
  if (buffer.byteLength === 0) return "The PDF file is empty.";
  if (buffer.byteLength > MAX_FILE_SIZE_BYTES) {
    return "File too large. Maximum PDF size is 4 MB.";
  }
  if (!isPdfBuffer(buffer)) {
    return "This file does not have a PDF header. Export it as a PDF rather than renaming its extension.";
  }
  return null;
}

/** The renderer parses the DOCX package; this only checks the upload envelope. */
export function validateDocumentInput(
  buffer: Uint8Array,
  filename: string
): string | null {
  if (isPdfFilename(filename)) return validatePdfInput(buffer, filename);
  if (!isDocxFilename(filename)) {
    return "Upload a PDF or Word (.docx) file. Older .doc files must be saved as .docx first.";
  }
  if (buffer.byteLength === 0) return "The Word file is empty.";
  if (buffer.byteLength > MAX_FILE_SIZE_BYTES) {
    return "File too large. Maximum Word file size is 4 MB.";
  }
  if (
    buffer.length < 4 ||
    buffer[0] !== 0x50 ||
    buffer[1] !== 0x4b ||
    buffer[2] !== 0x03 ||
    buffer[3] !== 0x04
  ) {
    return "This file does not look like a Word document. Save it as .docx and upload it again.";
  }
  return null;
}
