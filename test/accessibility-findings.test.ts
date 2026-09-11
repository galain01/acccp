import { describe, expect, it } from "vitest";
import {
  boundedText,
  incompleteAuditWarning,
  parseFinding,
  presentFinding,
  readFindingLocation,
  type AccessibilityError,
} from "@/lib/accessibility-findings";

const finding: AccessibilityError = {
  type: "missing-alt",
  severity: "warning",
  title: "Describe the process diagram",
  category: "accessibility",
  message: "The process diagram needs a written description.",
  suggestion: "In your Canvas page, describe the steps shown in the diagram.",
};

describe("validated source locations", () => {
  it("sorts physical pages and retains a separate printed label and nearby text", () => {
    expect(
      readFindingLocation(
        {
          scope: "element",
          sourcePages: [5, 4],
          printedPageLabel: " iii–iv ",
          section: " Results ",
          locator: " table header row ",
          quote: " Due date ",
        },
        5
      )
    ).toEqual({
      scope: "element",
      sourcePages: [4, 5],
      printedPageLabel: "iii–iv",
      section: "Results",
      locator: "table header row",
      quote: "Due date",
    });
  });

  it.each([[], [0], [-1], [6], [1.5], [1, 1], [1, "2"], "5", null])(
    "withholds invalid pages %j and any corresponding printed page label",
    (sourcePages) => {
      expect(
        readFindingLocation(
          { sourcePages, printedPageLabel: "3", quote: "Due date" },
          5
        )
      ).toMatchObject({
        sourcePages: null,
        printedPageLabel: null,
        quote: "Due date",
      });
    }
  );

  it.each([undefined, null, 0, -1, 2.5, Infinity])(
    "withholds pages without a valid measured page count: %s",
    (pageCount) => {
      expect(
        readFindingLocation(
          { sourcePages: [1], printedPageLabel: "i", section: "Introduction" },
          pageCount
        )
      ).toMatchObject({
        sourcePages: null,
        printedPageLabel: null,
        section: "Introduction",
      });
    }
  );

  it("never puts a whole-document warning on a single page", () => {
    expect(
      readFindingLocation(
        { scope: "document", sourcePages: [3], printedPageLabel: "1" },
        5
      )
    ).toMatchObject({
      scope: "document",
      sourcePages: null,
      printedPageLabel: null,
    });
  });

  it.each([null, [], "page 3", 3, {}, { element: "<p>legacy</p>" }])(
    "does not fabricate a location from %j",
    (value) => expect(readFindingLocation(value, 5)).toBeUndefined()
  );

  it("bounds location text and strips unrelated metadata", () => {
    const result = readFindingLocation(
      {
        sourcePages: [1],
        printedPageLabel: "x".repeat(80),
        section: "s".repeat(400),
        locator: "l".repeat(400),
        quote: "q".repeat(500),
        documentId: "private-id",
      },
      5
    );
    expect(result?.printedPageLabel).toHaveLength(40);
    expect(result?.section).toHaveLength(200);
    expect(result?.locator).toHaveLength(200);
    expect(result?.quote).toHaveLength(240);
    expect(result).not.toHaveProperty("documentId");
  });
});

describe("finding parsing and faculty presentation", () => {
  it("keeps matching snippets and valid WCAG references as optional technical details", () => {
    const element = '<img src="chart.png">';
    expect(
      parseFinding(
        { ...finding, element, wcag: "WCAG 1.1.1" },
        `<p>Results</p>${element}`,
        5
      )
    ).toEqual({ ...finding, element, wcag: "WCAG 1.1.1" });
  });

  it("omits invented snippets and invalid optional fields without discarding the actionable finding", () => {
    expect(
      parseFinding(
        {
          ...finding,
          element: "<h2>Invented</h2>",
          title: [],
          category: "unsafe",
          wcag: "certified accessible",
          location: "page 8",
        },
        "<p>Actual content</p>",
        5
      )
    ).toEqual({
      type: finding.type,
      severity: finding.severity,
      message: finding.message,
      suggestion: finding.suggestion,
    });
  });

  it.each([
    { type: "made-up" },
    { severity: "info" },
    { message: "  " },
    { suggestion: null },
  ])("rejects invalid core data %j", (invalid) =>
    expect(
      parseFinding({ ...finding, ...invalid }, "<p>content</p>", 5)
    ).toBeUndefined()
  );

  it("bounds model-written explanations and only preserves recognized fields", () => {
    const parsed = parseFinding(
      {
        ...finding,
        title: "t".repeat(110),
        message: "m".repeat(2100),
        suggestion: "s".repeat(3100),
        extra: "arbitrary",
      },
      "<p>content</p>",
      5
    );
    expect(parsed?.title).toHaveLength(100);
    expect(parsed?.message).toHaveLength(2000);
    expect(parsed?.suggestion).toHaveLength(3000);
    expect(parsed).not.toHaveProperty("extra");
  });

  it("preserves already-written faculty instructions and evidence", () => {
    expect(presentFinding(finding)).toEqual(finding);
  });

  it("turns old technical findings into a Canvas action without discarding their optional details", () => {
    const legacy: AccessibilityError = {
      type: "no-table-headers",
      severity: "error",
      message: "Missing th scope",
      suggestion: "Set scope=col",
      element: "<td>Due date</td>",
      wcag: "WCAG 1.3.1",
    };
    const presented = presentFinding(legacy);
    expect(presented.title).toContain("column or row labels");
    expect(presented.suggestion).toContain("In your Canvas page");
    expect(presented.message).not.toContain("th scope");
    expect(presented.element).toBe(legacy.element);
    expect(presented.wcag).toBe(legacy.wcag);
  });

  it("replaces machine-marker wording even when a model supplied a title", () => {
    const presented = presentFinding({
      ...finding,
      type: "missing-link",
      message: "LINK TARGET REQUIRED: page 5",
    });
    expect(presented.message).not.toContain("REQUIRED");
    expect(presented.suggestion).toContain("original material");
  });

  it("makes incomplete audits a document-wide request for further checking", () => {
    const warning = incompleteAuditWarning();
    expect(warning).toMatchObject({
      severity: "warning",
      category: "source-review",
      title: "The document check is incomplete",
      location: { scope: "document", sourcePages: null },
    });
    expect(warning.message).toContain("problems that have not been reported");
    expect(warning.suggestion).toContain("before sharing it with students");
  });

  it("treats non-text and blank values as unavailable", () => {
    expect(boundedText({}, 40)).toBeUndefined();
    expect(boundedText("  ", 40)).toBeUndefined();
  });
});
