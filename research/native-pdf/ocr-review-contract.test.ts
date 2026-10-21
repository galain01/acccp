import { describe, expect, it } from "vitest";
import {
  ocrReviewReady,
  ocrLinesForReview,
  validateOcrReview,
  type OcrEvidence,
} from "./ocr-review-contract";
const evidence: OcrEvidence = {
  schemaVersion: 1,
  sourceSha256: "hash",
  pages: [
    {
      pageNumber: 1,
      imagePath: "image",
      imageSha256: "imagehash",
      ocrLines: [
        {
          id: "p1-l1",
          text: "Submit ten pages.",
          bbox: [1, 2, 20, 30],
          confidence: 99,
        },
      ],
    },
  ],
};
const review = () => ({
  language: "en-US",
  title: "Instructions",
  pages: [
    {
      pageNumber: 1,
      textOnly: true,
      readingOrderConfirmed: true,
      textAccuracyConfirmed: true,
      unresolved: [],
      blocks: [
        { role: "P", lines: [{ id: "p1-l1", text: "Submit one page." }] },
      ],
    },
  ],
});
describe("bounded original-image OCR review", () => {
  it("uploads only bounded OCR text, geometry, confidence and stable line identity", () => {
    const page = structuredClone(evidence.pages[0]);
    Object.assign(page.ocrLines[0], { unrelatedMetadata: "private extra" });
    expect(ocrLinesForReview(page, 100, 100)).toEqual(
      evidence.pages[0].ocrLines
    );
    for (const patch of [
      { id: "arbitrary" },
      { confidence: 101 },
      { bbox: [1, 2, 500, 500] },
      { text: "x".repeat(1001) },
    ]) {
      const malformed = structuredClone(evidence.pages[0]);
      Object.assign(malformed.ocrLines[0], patch);
      expect(() => ocrLinesForReview(malformed, 100, 100)).toThrow();
    }
  });
  it("accepts a visible-text correction while retaining its exact line identity", () => {
    expect(ocrReviewReady(validateOcrReview(review(), evidence))).toBe(true);
  });
  it("retains explicit uncertainty without authorizing repair", () => {
    const result = review();
    result.pages[0].textOnly = false;
    expect(() => validateOcrReview(result, evidence)).toThrow();
    const uncertain = {
      ...result,
      pages: [
        {
          ...result.pages[0],
          unresolved: ["A meaningful chart appears below the text."],
        },
      ],
    };
    expect(ocrReviewReady(validateOcrReview(uncertain, evidence))).toBe(false);
  });
  it("rejects omitted, repeated, invented or relocated lines", () => {
    for (const lines of [
      [],
      [{ id: "invented", text: "New line" }],
      [
        ...review().pages[0].blocks[0].lines,
        ...review().pages[0].blocks[0].lines,
      ],
    ]) {
      const bad = review();
      bad.pages[0].blocks[0].lines = lines;
      expect(() => validateOcrReview(bad, evidence)).toThrow();
    }
    const bad = review();
    bad.pages[0].pageNumber = 2;
    expect(() => validateOcrReview(bad, evidence)).toThrow();
  });
  it("rejects unsupported semantic roles, skipped headings and added fields", () => {
    for (const role of ["Table", "L", "H2", "Artifact"]) {
      const bad = review();
      bad.pages[0].blocks[0].role = role;
      expect(() => validateOcrReview(bad, evidence)).toThrow();
    }
    expect(() =>
      validateOcrReview({ ...review(), certification: true }, evidence)
    ).toThrow();
  });
  it("rejects controls, blank, non-BMP and oversized text", () => {
    for (const text of ["", " x ", "\nwrong", "🦉", "a".repeat(1001)]) {
      const bad = review();
      bad.pages[0].blocks[0].lines[0].text = text;
      expect(() => validateOcrReview(bad, evidence)).toThrow();
    }
  });
});
