import { describe, expect, it } from "vitest";
import { pdfReviewFindings, mergeFindings } from "@/lib/pdf-review-findings";
import type {
  AccessibilityError,
  FindingLocation,
} from "@/lib/accessibility-findings";

const location: FindingLocation = {
  scope: "element",
  sourcePages: [5],
  printedPageLabel: null,
  section: "Results",
  locator: "first chart",
  quote: "Enrollment",
};
const image = '<img src="{{PLACEHOLDER:image1.png}}" alt="Enrollment chart">';
const marker =
  "<!-- IMAGE REVIEW REQUIRED: page 5; section Results; first chart; near Enrollment -->";

describe("source review markers", () => {
  it("surfaces link-text review with page, section, quote, and nearby link", () => {
    const link = '<a href="https://example.test/form">here</a>';
    const results = pdfReviewFindings(
      `${link}<!-- LINK TEXT REQUIRED: page 5; section Applications; first link; near Submit here -->`,
      5
    );
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      type: "non-descriptive-link",
      element: link,
      location: {
        sourcePages: [5],
        section: "Applications",
        locator: "first link",
        quote: "Submit here",
      },
    });
    expect(results[0].message).not.toContain("LINK TEXT REQUIRED");
    expect(results[0].suggestion).toContain("Canvas page");
  });

  it("attaches an immediately adjacent image marker without duplicating its warning", () => {
    const results = pdfReviewFindings(`${image}\n  ${marker}`, 5);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      type: "missing-image",
      element: image,
      location,
    });
  });

  it("does not assign a later marker across an intervening image", () => {
    const second = '<img src="{{PLACEHOLDER:image2.png}}" alt="Second chart">';
    const results = pdfReviewFindings(`${image}${second}${marker}`, 5);
    expect(results).toHaveLength(2);
    expect(results[0].location?.sourcePages).toBeNull();
    expect(results[1]).toMatchObject({ element: second, location });
  });

  it("does not assign an image marker across intervening substantive text", () => {
    const results = pdfReviewFindings(
      `${image}<p>Different section</p>${marker}`,
      5
    );
    expect(results).toHaveLength(2);
    expect(results[0].location?.sourcePages).toBeNull();
    expect(results[1].location?.sourcePages).toEqual([5]);
  });

  it("preserves both a missing image and an uncertain image description", () => {
    const results = pdfReviewFindings(
      `${image}${marker}<!-- IMAGE DESCRIPTION REVIEW REQUIRED: page 5; section Results; first chart; near Enrollment -->`,
      5
    );
    expect(results.map((result) => result.type)).toEqual([
      "missing-image",
      "missing-alt",
    ]);
  });

  it("expands a bounded page range for a table continued across pages", () => {
    const results = pdfReviewFindings(
      "<!-- TABLE REVIEW REQUIRED: PDF pages 4–5; section Results; first table; near Due date -->",
      5
    );
    expect(results[0]).toMatchObject({
      type: "other",
      location: {
        sourcePages: [4, 5],
        section: "Results",
        locator: "first table",
        quote: "Due date",
      },
    });
    expect(results[0].suggestion).toContain("correct column or row label");
  });

  it.each(["page 6", "page 0", "pages 5-3", "pages 1-9000"])(
    "keeps source uncertainty but does not display invalid page marker %s",
    (page) => {
      const results = pdfReviewFindings(
        `<!-- SOURCE TEXT REVIEW REQUIRED: ${page}; section Results; final paragraph; near Partial text -->`,
        5
      );
      expect(results[0].location).toMatchObject({
        sourcePages: null,
        section: "Results",
        quote: "Partial text",
      });
      expect(results[0].message).toMatch(/could not.*read/i);
    }
  );

  it("does not invent page locations for legacy markers or when count is unavailable", () => {
    expect(
      pdfReviewFindings("<!-- HEADING REVIEW REQUIRED -->", 5)[0].location
        ?.sourcePages
    ).toBeNull();
    expect(pdfReviewFindings(marker, null)[0].location?.sourcePages).toBeNull();
  });

  it("does not replace an explicitly unknown page with a page reference in a quotation", () => {
    const result = pdfReviewFindings(
      "<!-- SOURCE TEXT REVIEW REQUIRED: PDF page unknown; section Readings; near see page 5; printed reference needs review -->",
      8
    )[0];
    expect(result.location).toMatchObject({
      sourcePages: null,
      section: "Readings",
      quote: "see page 5",
      locator: "printed reference needs review",
    });
  });

  it.each(["PDF page 2.5", "PDF pages 2,5", "page 2 extra text"])(
    "does not accept a partial numeric page field: %s",
    (pageField) => {
      const result = pdfReviewFindings(
        `<!-- TABLE REVIEW REQUIRED: ${pageField}; section Results; near page 3; first table -->`,
        8
      )[0];
      expect(result.location?.sourcePages).toBeNull();
      expect(result.location?.quote).toBe("page 3");
    }
  );

  it.each([
    "section Page 4 examples; near Review page 5; first diagram",
    "near See page 5; section Page 4 examples; first diagram",
    "PDF page unknown; section Page 4 examples; near Review page 5; first diagram",
  ])("does not derive a page from a heading or nearby text: %s", (fields) => {
    const result = pdfReviewFindings(
      `<!-- IMAGE DESCRIPTION REVIEW REQUIRED: ${fields} -->`,
      8
    )[0];
    expect(result.location?.sourcePages).toBeNull();
    expect(result.location?.section).toBe("Page 4 examples");
  });

  it.each(["PDF pages 2-5", "PDF pages 2–5", "pages 2 - 5"])(
    "reads a complete declared range despite different page numbers in nearby text: %s",
    (pageField) => {
      const result = pdfReviewFindings(
        `<!-- TABLE REVIEW REQUIRED: ${pageField}; section Page 7 examples; near See page 8; continued table -->`,
        8
      )[0];
      expect(result.location).toMatchObject({
        sourcePages: [2, 3, 4, 5],
        section: "Page 7 examples",
        quote: "See page 8",
        locator: "continued table",
      });
    }
  );
});

describe("merging duplicate source and audit findings", () => {
  const source: AccessibilityError = {
    type: "missing-image",
    severity: "warning",
    message: "Image missing",
    suggestion: "Add it",
    title: "Add the missing image",
    element: image,
    location,
  };

  it("merges the same unique HTML occurrence and keeps the auditor's useful explanation", () => {
    const audit = {
      ...source,
      title: "Add the enrollment chart",
      message: "The chart below Results is missing.",
    };
    expect(mergeFindings([source], [audit], image)).toEqual([audit]);
  });

  it("uses the source-aware auditor's corrected page for the same unique image placeholder", () => {
    const mistakenSource = {
      ...source,
      location: { ...location, sourcePages: [2] },
    };
    const audit = {
      ...source,
      element: "{{PLACEHOLDER:image1.png}}",
      location: { ...location, sourcePages: [4] },
      title: "Add the chart from page 4",
    };
    expect(mergeFindings([mistakenSource], [audit], image)).toEqual([audit]);
  });

  it("clears a converter-supplied page when the auditor explicitly cannot locate the same image", () => {
    const audit = {
      ...source,
      element: "{{PLACEHOLDER:image1.png}}",
      location: { ...location, sourcePages: null, printedPageLabel: null },
    };
    const results = mergeFindings([source], [audit], image);
    expect(results).toHaveLength(1);
    expect(results[0].location?.sourcePages).toBeNull();
    expect(results[0].location?.printedPageLabel).toBeNull();
  });

  it("merges using a full matching page/section/locator/quote when snippets are unavailable", () => {
    const withoutSnippet = { ...source, element: undefined };
    expect(
      mergeFindings(
        [withoutSnippet],
        [{ ...withoutSnippet, title: "Chart missing" }],
        "<p>Results</p>"
      )
    ).toHaveLength(1);
  });

  it("keeps different occurrences with equal snippets and messages", () => {
    const first = {
      ...source,
      location: { ...location, locator: "first chart" },
    };
    const second = {
      ...source,
      location: { ...location, locator: "second chart" },
    };
    expect(mergeFindings([first], [second], image + image)).toEqual([
      first,
      second,
    ]);
  });

  it("keeps ambiguous duplicates instead of collapsing multiple source occurrences", () => {
    expect(
      mergeFindings([source, { ...source }], [{ ...source }], image + image)
    ).toHaveLength(3);
  });

  it("keeps different kinds of problem at the same occurrence", () => {
    expect(
      mergeFindings([source], [{ ...source, type: "missing-alt" }], image)
    ).toHaveLength(2);
  });

  it("does not match the same source occurrence to multiple audit findings", () => {
    const audit = { ...source, title: "Chart missing" };
    expect(mergeFindings([source], [audit, { ...audit }], image)).toHaveLength(
      2
    );
  });
});
