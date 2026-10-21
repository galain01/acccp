import { describe, expect, it } from "vitest";
import { combineAuditBatches, planAuditBatches } from "./audit-batches";
import type { SavedTag } from "./audit-contract";

const tags: SavedTag[] = Array.from({ length: 803 }, (_, index) => ({
  id: `tag-${index}`,
  role: index === 0 ? "Document" : "P",
  parentId: index === 0 ? null : "tag-0",
  pageNumber: 1,
  text: `Paragraph ${index}`,
}));
const inspection = { structure: { tags }, source_structure: { tags: [] } };
describe("complete native PDF audit batches", () => {
  it("assigns each tag exactly once and retains the complete hierarchy as context", () => {
    const batches = planAuditBatches(inspection, [1]);
    expect(batches.map((batch) => batch.tags.length)).toEqual([400, 400, 3]);
    expect(batches.flatMap((batch) => batch.tags)).toEqual(tags);
    expect(batches.map((batch) => batch.artifactPages)).toEqual([[1], [], []]);
    for (const batch of batches) {
      const evidence = JSON.parse(batch.evidence);
      expect(evidence.structure.contextOutline).toHaveLength(803);
      expect(evidence.assignedOutputTags).toEqual(batch.tags);
    }
  });
  it("cannot turn a partial run, repeated batch, or omitted tag into completion", () => {
    const batches = planAuditBatches(inspection, []);
    const results = batches.map((batch) => ({
      reviewedPages: [1],
      reviewedTagIds: batch.tags.map((tag) => tag.id),
      artifactReviews: [],
      findings: [],
    }));
    expect(
      combineAuditBatches(batches, results, tags, 1, []).reviewedTagIds
    ).toHaveLength(803);
    expect(() =>
      combineAuditBatches(batches, results.slice(0, 2), tags, 1, [])
    ).toThrow();
    expect(() =>
      combineAuditBatches(
        batches,
        [results[0], results[0], results[2]],
        tags,
        1,
        []
      )
    ).toThrow();
    expect(() =>
      combineAuditBatches(
        batches,
        [
          { ...results[0], reviewedTagIds: results[0].reviewedTagIds.slice(1) },
          ...results.slice(1),
        ],
        tags,
        1,
        []
      )
    ).toThrow();
  });
  it("rejects duplicate tags and evidence too large to review safely", () => {
    expect(() =>
      planAuditBatches({ structure: { tags: [tags[0], tags[0]] } }, [])
    ).toThrow();
    expect(() =>
      planAuditBatches(
        { structure: { tags: [{ ...tags[0], text: "x".repeat(400_001) }] } },
        []
      )
    ).toThrow();
  });
});
