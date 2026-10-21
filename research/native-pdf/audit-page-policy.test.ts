import { describe, expect, it } from "vitest";
import { validateAuditPageCounts } from "./audit-page-policy";

describe("native PDF audit page limits", () => {
  it("requires independent authorization for added pages", () => {
    expect(() => validateAuditPageCounts(8, 8, {})).not.toThrow();
    expect(() => validateAuditPageCounts(8, 9, {})).toThrow();
    expect(() =>
      validateAuditPageCounts(8, 10, { appendix_validation: { passed: true } })
    ).not.toThrow();
    expect(() =>
      validateAuditPageCounts(8, 9, { appendix_validation: { passed: false } })
    ).toThrow();
  });
  it("retains strict bounds even with an approved appendix", () => {
    for (const [before, after] of [
      [0, 1],
      [9, 10],
      [8, 7],
      [1, 4],
      [8, 11],
      [1.5, 2],
    ])
      expect(() =>
        validateAuditPageCounts(before, after, {
          appendix_validation: { passed: true },
        })
      ).toThrow();
  });
});
