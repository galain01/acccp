/** Shared browser/server upload rules; leave room for Vercel's multipart overhead. */
export const MAX_FILE_SIZE_BYTES = 4 * 1024 * 1024;
export const PDF_MIME_TYPE = "application/pdf";

export function isPdfFilename(filename: string): boolean {
  return filename.toLowerCase().endsWith(".pdf");
}

/** A quick format check, not a full PDF parser. The model provider parses the file. */
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
