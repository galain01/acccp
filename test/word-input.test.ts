import { describe, expect, it } from "vitest";
import {
  DOCX_MIME_TYPE,
  isDocxFilename,
  isSupportedDocumentFilename,
  MAX_FILE_SIZE_BYTES,
  validateDocumentInput,
} from "@/lib/document-input";

const zipEnvelope = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0]);
const pdf = new TextEncoder().encode("%PDF-1.7\n%%EOF");

describe("Word upload envelope validation", () => {
  it("accepts DOCX case-insensitively and retains direct PDF support", () => {
    expect(isDocxFilename("course.DOCX")).toBe(true);
    expect(isSupportedDocumentFilename("course.DOCX")).toBe(true);
    expect(isSupportedDocumentFilename("course.PDF")).toBe(true);
    expect(validateDocumentInput(zipEnvelope, "course.DOCX")).toBeNull();
    expect(validateDocumentInput(pdf, "course.PDF")).toBeNull();
    expect(DOCX_MIME_TYPE).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    );
  });

  it.each(["course.doc", "course.docm", "course", "course.docx.exe"])(
    "rejects unsupported filename %s even with a ZIP signature",
    (filename) => {
      expect(isSupportedDocumentFilename(filename)).toBe(false);
      expect(validateDocumentInput(zipEnvelope, filename)).not.toBeNull();
    }
  );

  it.each([
    new Uint8Array(),
    new Uint8Array([0x50, 0x4b, 0x03]),
    new Uint8Array([0x50, 0x4b, 0x05, 0x06]),
    new TextEncoder().encode("not a Word document"),
    pdf,
  ])(
    "rejects an empty, incomplete, or wrong format Word envelope",
    (buffer) => {
      expect(validateDocumentInput(buffer, "course.docx")).not.toBeNull();
    }
  );

  it("rejects a ZIP renamed as PDF", () => {
    expect(validateDocumentInput(zipEnvelope, "course.pdf")).toMatch(
      /PDF header/
    );
  });

  it("enforces the size boundary before rendering", () => {
    const allowed = new Uint8Array(MAX_FILE_SIZE_BYTES);
    allowed.set(zipEnvelope);
    const oversized = new Uint8Array(MAX_FILE_SIZE_BYTES + 1);
    oversized.set(zipEnvelope);
    expect(validateDocumentInput(allowed, "course.docx")).toBeNull();
    expect(validateDocumentInput(oversized, "course.docx")).toMatch(
      /too large/i
    );
  });
});
