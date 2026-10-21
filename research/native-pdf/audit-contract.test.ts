import { describe, expect, it } from "vitest";
import {
  compactAuditEvidence,
  validateAudit,
  type SavedTag,
} from "./audit-contract";

const tags: SavedTag[] = [
  { id: "tag-1", role: "Document", parentId: null, pageNumber: null, text: "" },
  { id: "tag-2", role: "H1", parentId: "tag-1", pageNumber: 1, text: "Title" },
  { id: "tag-3", role: "P", parentId: "tag-1", pageNumber: 2, text: "Body" },
];
const complete = () => ({
  reviewedPages: [1, 2],
  reviewedTagIds: tags.map((t) => t.id),
  artifactReviews: [],
  findings: [],
});
describe("native PDF experimental audit evidence", () => {
  it("keeps authored alternatives and content identities exact when compacting extraction whitespace", () => {
    const evidence = {
      tags: [
        {
          id: "tag-1",
          alt: "A  > B & C\nD",
          actualText: "\u00ad\n\t\u00a0",
          effectiveLanguage: "en-GB",
          text: "Value\n \n\n >= 12",
          contentSequence: [
            { kind: "markedContent", mcid: 4, text: "Value\n \n\n >= 12" },
          ],
        },
      ],
      page_content: [{ artifactText: "Page   1", artifactTextComplete: true }],
    };
    const actual = JSON.parse(compactAuditEvidence(evidence));
    expect(actual.tags[0].alt).toBe(evidence.tags[0].alt);
    expect(actual.tags[0].actualText).toBe(evidence.tags[0].actualText);
    expect(actual.tags[0].effectiveLanguage).toBe("en-GB");
    expect(actual.tags[0].id).toBe("tag-1");
    expect(actual.tags[0].contentSequence[0]).toEqual({
      kind: "markedContent",
      mcid: 4,
      text: "Value >= 12",
    });
    expect(actual.page_content).toEqual([
      { artifactText: "Page 1", artifactTextComplete: true },
    ]);
    expect(evidence.tags[0].text).toBe("Value\n \n\n >= 12");
  });
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
  it("accepts 23 valid finding references but rejects more than 50 or invalid references", () => {
    const tableTags: SavedTag[] = Array.from({ length: 51 }, (_, index) => ({
      id: `cell-${index + 1}`,
      role: "TD",
      parentId: null,
      pageNumber: 1,
      text: "Value",
    }));
    const finding = {
      code: "table-headers",
      severity: "error",
      pageNumber: 1,
      tagIds: tableTags.slice(0, 23).map((tag) => tag.id),
      location: "Table 1 continuation",
      message: "Several row labels lack header relationships.",
      suggestion: "Mark the state names as row headers.",
    };
    const audit = {
      reviewedPages: [1, 2],
      reviewedTagIds: tableTags.map((tag) => tag.id),
      artifactReviews: [],
      findings: [finding],
    };
    expect(validateAudit(audit, tableTags, 2).findings[0].tagIds).toHaveLength(
      23
    );
    expect(() =>
      validateAudit(
        {
          ...audit,
          findings: [{ ...finding, tagIds: tableTags.map((tag) => tag.id) }],
        },
        tableTags,
        2
      )
    ).toThrow();
    expect(() =>
      validateAudit(
        {
          ...audit,
          findings: [
            { ...finding, tagIds: [...finding.tagIds.slice(0, 22), "unknown"] },
          ],
        },
        tableTags,
        2
      )
    ).toThrow();
    expect(() =>
      validateAudit(
        { ...audit, findings: [{ ...finding, pageNumber: 2 }] },
        tableTags,
        2
      )
    ).toThrow();
    expect(() =>
      validateAudit(
        {
          ...audit,
          reviewedTagIds: tableTags.slice(0, 50).map((tag) => tag.id),
        },
        tableTags,
        2
      )
    ).toThrow();
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
  it("requires explicit assessment of all excluded-text pages", () => {
    expect(() => validateAudit(complete(), tags, 2, [1])).toThrow();
    const review = {
      pageNumber: 1,
      decision: "decorative-or-redundant",
      explanation: "Only the repeated page number is excluded.",
    };
    expect(
      validateAudit({ ...complete(), artifactReviews: [review] }, tags, 2, [1])
        .artifactReviews
    ).toHaveLength(1);
    expect(() =>
      validateAudit(
        {
          ...complete(),
          artifactReviews: [{ ...review, decision: "uncertain" }],
        },
        tags,
        2,
        [1]
      )
    ).toThrow();
    expect(() =>
      validateAudit(
        { ...complete(), artifactReviews: [{ ...review, explanation: "" }] },
        tags,
        2,
        [1]
      )
    ).toThrow();
  });
});
