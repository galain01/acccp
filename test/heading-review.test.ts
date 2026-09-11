import { describe, expect, it } from "vitest";
import { evaluateHeadingReview } from "@/lib/heading-review";
import { extractHtmlHeadings } from "@/lib/html-headings";

function source(
  id: string,
  name: string,
  parent: string | null,
  rank: number,
  htmlId: string,
  page = 1
) {
  return {
    id,
    text: name,
    parentId: parent,
    rank,
    page,
    certainty: "supported",
    evidence: "The source groups this heading with its surrounding content.",
    htmlHeadingIds: [htmlId],
  };
}
const base = [
  source("s1", "Title", null, 1, "h1"),
  source("s2", "Section", "s1", 2, "h2"),
  source("s3", "Child", "s2", 3, "h3"),
];
function review(sourceHeadings = base) {
  return {
    pagesReviewed: [1],
    sourceHeadings,
    unmatchedHtmlHeadingIds: [] as string[],
  };
}
const flat = extractHtmlHeadings(
  "<h2>Title</h2><h3>Section</h3><h3>Child</h3>"
);
const correct = extractHtmlHeadings(
  "<h2>Title</h2><h3>Section</h3><h4>Child</h4>"
);

describe("source heading comparison", () => {
  it("generates a located, faculty-readable mismatch even without any model finding", () => {
    const result = evaluateHeadingReview(review(), flat, 1);
    expect(result.complete).toBe(true);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({
      severity: "error",
      type: "other",
      element: "<h3>Child</h3>",
      location: { sourcePages: [1], section: "Section", quote: "Child" },
    });
    expect(result.findings[0].suggestion).toContain(
      "one heading level below “Section”"
    );
    expect(result.findings[0].message).not.toMatch(/WCAG|h[1-6]|parentId/);
  });

  it("accepts correct children and detects a peer that was incorrectly nested", () => {
    expect(evaluateHeadingReview(review(), correct, 1).findings).toEqual([]);
    const peer = review([
      ...base.slice(0, 2),
      source("s3", "Child", "s1", 2, "h3"),
    ]);
    const result = evaluateHeadingReview(peer, correct, 1);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].suggestion).toContain(
      "one heading level below “Title”"
    );
  });

  it("tracks repeated labels by occurrence and keeps parents across a page boundary", () => {
    const html = extractHtmlHeadings(
      "<h2>Title</h2><h3>A</h3><h4>Notes</h4><h3>B</h3><h4>Notes</h4>"
    );
    const input = {
      pagesReviewed: [1, 2],
      unmatchedHtmlHeadingIds: [],
      sourceHeadings: [
        source("s1", "Title", null, 1, "h1"),
        source("s2", "A", "s1", 2, "h2"),
        source("s3", "Notes", "s2", 3, "h3"),
        source("s4", "B", "s1", 2, "h4"),
        source("s5", "Notes", "s4", 3, "h5", 2),
      ],
    };
    expect(evaluateHeadingReview(input, html, 2)).toEqual({
      complete: true,
      findings: [],
    });
  });

  it("locates identical title markup by occurrence rather than by its first excerpt", () => {
    const result = evaluateHeadingReview(
      {
        pagesReviewed: [1, 2],
        unmatchedHtmlHeadingIds: [],
        sourceHeadings: [
          source("s1", "Guide", null, 1, "h1"),
          source("s2", "Guide", null, 1, "h2", 2),
        ],
      },
      extractHtmlHeadings("<h1>Guide</h1><h1>Guide</h1>"),
      2
    );
    expect(
      result.findings.map((finding) => [
        finding.type,
        finding.location?.sourcePages,
      ])
    ).toEqual([
      ["h1-present", [1]],
      ["h1-present", [2]],
    ]);
  });

  it("does not suppress another occurrence's level-skip warning when identical markup has a parent error", () => {
    const result = evaluateHeadingReview(
      {
        pagesReviewed: [1, 2],
        unmatchedHtmlHeadingIds: [],
        sourceHeadings: [
          source("s1", "Title", null, 1, "h1"),
          source("s2", "Notes", null, 1, "h2"),
          source("s3", "Next", null, 1, "h3", 2),
          source("s4", "Notes", "s3", 2, "h4", 2),
        ],
      },
      extractHtmlHeadings(
        "<h2>Title</h2><h4>Notes</h4><h2>Next</h2><h4>Notes</h4>"
      ),
      2
    );
    expect(
      result.findings.map((finding) => [
        finding.type,
        finding.severity,
        finding.location?.sourcePages,
      ])
    ).toEqual([
      ["other", "error", [1]],
      ["heading-skip", "warning", [2]],
    ]);
  });

  it.each([
    null,
    {},
    { pagesReviewed: [1], sourceHeadings: null, unmatchedHtmlHeadingIds: [] },
  ])(
    "retains deterministic markup findings when the heading review is unusable (%#)",
    (value) => {
      const result = evaluateHeadingReview(
        value,
        extractHtmlHeadings("<h1>Title</h1><h4></h4>"),
        1
      );
      expect(result.complete).toBe(false);
      expect(result.findings.map((finding) => finding.type)).toEqual([
        "h1-present",
        "empty-heading",
        "heading-skip",
        "other",
      ]);
      expect(result.findings.at(-1)?.title).toBe(
        "The document check is incomplete"
      );
    }
  );

  it("rejects a child that points back to a source section closed by a later peer", () => {
    const result = evaluateHeadingReview(
      review([
        source("s1", "Title", null, 1, "h1"),
        source("s2", "Section A", "s1", 2, "h2"),
        source("s3", "Section B", "s1", 2, "h3"),
        source("s4", "Detail", "s2", 3, "h4"),
      ]),
      extractHtmlHeadings(
        "<h2>Title</h2><h3>Section A</h3><h3>Section B</h3><h4>Detail</h4>"
      ),
      1
    );
    expect(result.complete).toBe(false);
    expect(result.findings).toEqual([
      expect.objectContaining({
        severity: "warning",
        title: "The document check is incomplete",
      }),
    ]);
  });

  it("accepts a new repeated source occurrence that reopens a section", () => {
    const result = evaluateHeadingReview(
      review([
        source("s1", "Title", null, 1, "h1"),
        source("s2", "Section A", "s1", 2, "h2"),
        source("s3", "Section B", "s1", 2, "h3"),
        source("s4", "Section A", "s1", 2, "h4"),
        source("s5", "Detail", "s4", 3, "h5"),
      ]),
      extractHtmlHeadings(
        "<h2>Title</h2><h3>Section A</h3><h3>Section B</h3><h3>Section A</h3><h4>Detail</h4>"
      ),
      1
    );
    expect(result).toEqual({ complete: true, findings: [] });
  });

  it.each([
    { ...review(), pagesReviewed: [] },
    { ...review(), pagesReviewed: [1, 1] },
    { ...review(), pagesReviewed: [2] },
    { ...review(), unmatchedHtmlHeadingIds: ["invented"] },
    { ...review(), sourceHeadings: base.slice(0, 2) },
    { ...review(), sourceHeadings: [...base, base[2]] },
    {
      ...review(),
      sourceHeadings: [base[0], { ...base[1], parentId: "s3" }, base[2]],
    },
    {
      ...review(),
      sourceHeadings: [base[0], base[1], { ...base[2], rank: 2 }],
    },
    {
      ...review(),
      sourceHeadings: [
        base[0],
        base[1],
        { ...base[2], htmlHeadingIds: ["h2"] },
      ],
    },
  ])(
    "does not call invalid or incomplete evidence a complete audit (%#)",
    (input) => {
      const result = evaluateHeadingReview(input, flat, 1);
      expect(result.complete).toBe(false);
      expect(
        result.findings.some(
          (f) => f.title === "The document check is incomplete"
        )
      ).toBe(true);
    }
  );

  it("retains usable mismatches when a different source entry is malformed", () => {
    const result = evaluateHeadingReview(
      { ...review(), sourceHeadings: [...base, { text: 99 }] },
      flat,
      1
    );
    expect(result.complete).toBe(false);
    expect(result.findings.filter((f) => f.severity === "error")).toHaveLength(
      1
    );
  });

  it("reports uncertain or merged source occurrences for review, not as proven defects", () => {
    const uncertain = {
      ...review(),
      sourceHeadings: [
        base[0],
        base[1],
        { ...base[2], certainty: "uncertain" },
      ],
    };
    const result = evaluateHeadingReview(uncertain, flat, 1);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].severity).toBe("warning");
    const merged = {
      ...review(),
      sourceHeadings: [...base, { ...base[2], id: "s4", htmlHeadingIds: [] }],
    };
    const mergedResult = evaluateHeadingReview(merged, correct, 1);
    expect(mergedResult.complete).toBe(true);
    expect(mergedResult.findings).toHaveLength(1);
    expect(mergedResult.findings[0].message).toContain(
      "combined with a continued section"
    );
  });

  it("withholds source locations contradicted by extracted text and does not trust that parent for a child error", () => {
    const result = evaluateHeadingReview(
      review(),
      flat,
      1,
      new Map([[1, "Title Child"]])
    );
    expect(result.findings.filter((f) => f.severity === "error")).toHaveLength(
      0
    );
    expect(result.findings[0].location?.sourcePages).toBeNull();
  });

  it("allows image-only pages while checking source text when it is available", () => {
    expect(
      evaluateHeadingReview(review(), correct, 1, new Map([[1, ""]])).findings
    ).toEqual([]);
    expect(
      evaluateHeadingReview(
        review(),
        correct,
        1,
        new Map([[1, "TITLE\nSection\tChild"]])
      ).findings
    ).toEqual([]);
  });

  it("reports unmatched output headings as uncertainty without inventing a source page", () => {
    const result = evaluateHeadingReview(
      { ...review(base.slice(0, 2)), unmatchedHtmlHeadingIds: ["h3"] },
      flat,
      1
    );
    expect(result.complete).toBe(true);
    expect(result.findings[0]).toMatchObject({
      severity: "warning",
      location: { sourcePages: null, quote: "Child" },
    });
  });
});
