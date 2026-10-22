import { describe, expect, it } from "vitest";
import { readPdfInteractionTestSummary } from "@/lib/pdf-interaction-summary";

const summary = {
  evidenceId: "synthetic-form-interactions-1",
  testedAt: "2026-10-22",
  environment: "Acrobat and NVDA",
  passedChecks: ["The name field announced its label and requirement."],
  scopeNote:
    "Earlier tests match this form; they were not rerun for this conversion.",
};

describe("readPdfInteractionTestSummary", () => {
  it("returns only a copied, bounded public summary", () => {
    const result = readPdfInteractionTestSummary(summary);
    expect(result).toEqual(summary);
    expect(result).not.toBe(summary);
    expect(result?.passedChecks).not.toBe(summary.passedChecks);
  });

  it.each([
    undefined,
    null,
    [],
    {},
    { ...summary, privateTranscript: "must not be published" },
    { ...summary, evidenceId: "../private.json" },
    { ...summary, testedAt: "2026-02-30" },
    { ...summary, testedAt: "2026-10-22T00:00:00Z" },
    { ...summary, environment: "x".repeat(241) },
    { ...summary, environment: "Acrobat\nNVDA" },
    { ...summary, passedChecks: [] },
    { ...summary, passedChecks: ["Repeated", "Repeated"] },
    {
      ...summary,
      passedChecks: Array.from({ length: 13 }, (_, i) => `Check ${i}`),
    },
    { ...summary, passedChecks: ["x".repeat(601)] },
    { ...summary, passedChecks: [42] },
    { ...summary, scopeNote: " " },
    { ...summary, scopeNote: "x".repeat(801) },
  ])("omits absent or malformed summaries (%#)", (value) => {
    expect(readPdfInteractionTestSummary(value)).toBeUndefined();
  });
});
