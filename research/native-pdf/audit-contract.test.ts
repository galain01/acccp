import { describe, expect, it } from "vitest";
import { validateAudit, type SavedTag } from "./audit-contract";

const tags: SavedTag[] = [
  { id: "tag-1", role: "Document", parentId: null, pageNumber: null, text: "" },
  { id: "tag-2", role: "H1", parentId: "tag-1", pageNumber: 1, text: "Title" },
  { id: "tag-3", role: "P", parentId: "tag-1", pageNumber: 2, text: "Body" },
];
const complete = () => ({
  reviewedPages: [1, 2],
  reviewedTagIds: tags.map((t) => t.id),
  findings: [],
});
describe("native PDF experimental audit evidence", () => {
  it("requires every saved tag and physical page", () => {
    expect(validateAudit(complete(), tags, 2)).toEqual(complete());
    expect(() =>
      validateAudit({ ...complete(), reviewedPages: [1] }, tags, 2)
    ).toThrow();
    expect(() =>
      validateAudit(
        { ...complete(), reviewedTagIds: ["tag-1", "tag-2", "tag-2"] },
        tags,
        2
      )
    ).toThrow();
  });
  it("rejects invented tag references and contradictory page locations", () => {
    const finding = {
      code: "heading-relationships",
      severity: "error",
      pageNumber: 1,
      tagIds: ["tag-3"],
      location: "Body",
      message: "The section is missing a heading.",
      suggestion: "Mark the section heading.",
    };
    expect(() =>
      validateAudit({ ...complete(), findings: [finding] }, tags, 2)
    ).toThrow();
    expect(() =>
      validateAudit(
        { ...complete(), findings: [{ ...finding, tagIds: ["invented"] }] },
        tags,
        2
      )
    ).toThrow();
    expect(
      validateAudit(
        { ...complete(), findings: [{ ...finding, pageNumber: 2 }] },
        tags,
        2
      ).findings
    ).toHaveLength(1);
  });
  it("allows missing-content findings without pretending the omitted text has a tag", () => {
    expect(
      validateAudit(
        {
          ...complete(),
          findings: [
            {
              code: "missing-content",
              severity: "error",
              pageNumber: 2,
              tagIds: [],
              location: "Last paragraph",
              message: "The paragraph is absent from the reading structure.",
              suggestion: "Include the paragraph in the reading order.",
            },
          ],
        },
        tags,
        2
      ).findings
    ).toHaveLength(1);
  });
  it("allows a heading on an earlier page to support a relationship finding at a later-page heading", () => {
    const finding = {
      code: "heading-relationships",
      severity: "error",
      pageNumber: 2,
      tagIds: ["tag-2", "tag-3"],
      location: "Body section",
      message:
        "This section's heading level does not follow its parent on page 1.",
      suggestion: "Use the appropriate child heading level.",
    };
    expect(
      validateAudit({ ...complete(), findings: [finding] }, tags, 2).findings
    ).toHaveLength(1);
  });
  it("does not accept repairs or a model declaration of conformance", () => {
    expect(() =>
      validateAudit({ ...complete(), certified: true }, tags, 2)
    ).toThrow();
    expect(() =>
      validateAudit({ ...complete(), operations: [] }, tags, 2)
    ).toThrow();
  });
});
