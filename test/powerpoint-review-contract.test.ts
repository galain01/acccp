import { describe, expect, it } from "vitest";
import { isPowerPointReviewSelection } from "@/lib/powerpoint-review-contract";
const valid = {
  documentId: "00000000-0000-0000-0000-000000000001",
  jobId: "00000000-0000-0000-0000-000000000002",
  revisionToken: "a".repeat(64),
  includedChangeIds: ["change-1"],
  reviewedChangeIds: [],
  descriptionEdits: {},
};
describe("review request boundaries", () => {
  it("accepts restoring everything and safe description edits", () => {
    expect(
      isPowerPointReviewSelection({ ...valid, includedChangeIds: [] })
    ).toBe(true);
    expect(
      isPowerPointReviewSelection({
        ...valid,
        descriptionEdits: { "change-1": "Description" },
      })
    ).toBe(true);
  });
  it.each([
    null,
    [],
    {},
    { ...valid, documentId: "../../secret" },
    { ...valid, includedChangeIds: ["x", "x"] },
    { ...valid, reviewedChangeIds: [5] },
    { ...valid, descriptionEdits: { x: "" } },
    { ...valid, descriptionEdits: { x: "x".repeat(2001) } },
    { ...valid, descriptionEdits: { x: "a\u0000b" } },
    { ...valid, plan: { slides: [] } },
    { ...valid, revisionToken: "bad" },
  ])("rejects malformed or injected input %#", (value) =>
    expect(isPowerPointReviewSelection(value)).toBe(false)
  );
});
