import { describe, expect, it } from "vitest";
import {
  extractHtmlHeadings,
  MAX_AUDIT_HEADINGS,
  prepareHeadingAuditHtml,
  prepareHeadingAuditDocument,
} from "@/lib/html-headings";

describe("HTML heading inventory", () => {
  it("computes parents for children, peers, level skips, and returns to a shallower level", () => {
    const html =
      "<h2>Title</h2><h3>Section</h3><h4>Child</h4><h4>Peer child</h4><h6>Deep</h6><h3>Next</h3>";
    expect(extractHtmlHeadings(html)).toEqual({
      complete: true,
      headings: [
        {
          id: "h1",
          text: "Title",
          level: 2,
          parentId: null,
          element: "<h2>Title</h2>",
        },
        {
          id: "h2",
          text: "Section",
          level: 3,
          parentId: "h1",
          element: "<h3>Section</h3>",
        },
        {
          id: "h3",
          text: "Child",
          level: 4,
          parentId: "h2",
          element: "<h4>Child</h4>",
        },
        {
          id: "h4",
          text: "Peer child",
          level: 4,
          parentId: "h2",
          element: "<h4>Peer child</h4>",
        },
        {
          id: "h5",
          text: "Deep",
          level: 6,
          parentId: "h4",
          element: "<h6>Deep</h6>",
        },
        {
          id: "h6",
          text: "Next",
          level: 3,
          parentId: "h1",
          element: "<h3>Next</h3>",
        },
      ],
    });
  });

  it("retains repeated occurrences, decodes entities and keeps original HTML excerpts", () => {
    const html =
      '<H2 class="title">Arts &amp; <em>Crafts</em></H2><h3>Notes<br> continued</h3><h3>Notes&nbsp;continued</h3>';
    const { headings } = extractHtmlHeadings(html);
    expect(headings.map((h) => [h.id, h.text, h.parentId])).toEqual([
      ["h1", "Arts & Crafts", null],
      ["h2", "Notes continued", "h1"],
      ["h3", "Notes continued", "h1"],
    ]);
    expect(headings[0].element).toBe(
      '<H2 class="title">Arts &amp; <em>Crafts</em></H2>'
    );
  });

  it("does not treat comments, scripts, escaped code or inactive/hidden content as headings", () => {
    const html = `<h2>Visible</h2><!-- <h3>Comment</h3> --><script>"<h3>Script</h3>"</script><pre>&lt;h3&gt;Example&lt;/h3&gt;</pre><template><h3>Template</h3></template><div hidden><h3>Hidden</h3></div><div aria-hidden="true"><h3>Ignored</h3></div><h3 style="display: none !important">Invisible</h3><h3>Shown</h3>`;
    expect(extractHtmlHeadings(html).headings.map((h) => h.text)).toEqual([
      "Visible",
      "Shown",
    ]);
  });

  it("uses HTML parsing rules for implicitly closed headings", () => {
    const { headings } = extractHtmlHeadings("<h2>Title<h3>Section<h4>Child");
    expect(headings.map((h) => [h.text, h.parentId])).toEqual([
      ["Title", null],
      ["Section", "h1"],
      ["Child", "h2"],
    ]);
  });

  it("reports bounded inventories as incomplete, rather than claiming complete coverage", () => {
    const result = extractHtmlHeadings(
      "<h3>Heading</h3>".repeat(MAX_AUDIT_HEADINGS + 1)
    );
    expect(result.complete).toBe(false);
    expect(result.headings).toHaveLength(MAX_AUDIT_HEADINGS);
    expect(extractHtmlHeadings("x".repeat(2 * 1024 * 1024 + 1))).toEqual({
      headings: [],
      complete: false,
    });
  });

  it("hides actual heading ranks and attributes while preserving non-heading evidence", () => {
    const html =
      '<h2 style="font-size:30px">Title</h2><!-- HEADING REVIEW REQUIRED: use h4 --><p class=note>Keep &amp; preserve</p><h3 aria-level="3">Notes</h3><pre>&lt;h4&gt;example&lt;/h4&gt;</pre>';
    expect(prepareHeadingAuditHtml(html)).toBe(
      '<div data-audit-heading-id="h1">Title</div><p class=note>Keep &amp; preserve</p><div data-audit-heading-id="h2">Notes</div><pre>&lt;h4&gt;example&lt;/h4&gt;</pre>'
    );
    expect(extractHtmlHeadings(html).headings.map((h) => h.level)).toEqual([
      2, 3,
    ]);
  });

  it("masks implicitly closed headings without losing the following content", () => {
    expect(prepareHeadingAuditHtml("<h2>Title<h3>Section<h4>Child")).toBe(
      '<div data-audit-heading-id="h1">Title</div><div data-audit-heading-id="h2">Section</div><div data-audit-heading-id="h3">Child</div>'
    );
  });

  it("withholds heading ranks and comments inside excluded subtrees without dropping other evidence", () => {
    const prepared = prepareHeadingAuditHtml(
      '<h2>Title</h2><div aria-hidden="true"><h4>Hidden heading</h4><!-- use h4 --><p>Visible to sighted readers.</p></div><template><h6>Template heading</h6><!-- private note --></template><svg><title>Diagram</title><path d="M0 0L1 1"/><!-- private svg note --></svg><h3 hidden>Hidden title</h3><h3>Shown</h3>'
    );
    expect(prepared).not.toMatch(/<\/?h[1-6]\b|<!--|private note|use h4/);
    expect(prepared).toContain(
      '<div aria-hidden="true"><div>Hidden heading</div>'
    );
    expect(prepared).toContain("<p>Visible to sighted readers.</p>");
    expect(prepared).toContain(
      '<svg><title>Diagram</title><path d="M0 0L1 1"/></svg>'
    );
    expect(prepared).toContain("<div hidden>Hidden title</div>");
    expect(prepared).toContain('<div data-audit-heading-id="h2">Shown</div>');
    expect(prepared).not.toContain('data-audit-heading-id="h3"');
  });

  it("restores exact original excerpts across removed comments and neutral heading tags", () => {
    const html =
      '<h4 class="rank-four">Resources</h4><p>Read the guide.<!-- LINK TARGET REQUIRED --></p>';
    const prepared = prepareHeadingAuditDocument(html);
    expect(prepared.restoreExcerpt("<p>Read the guide.</p>")).toBe(
      "<p>Read the guide.<!-- LINK TARGET REQUIRED --></p>"
    );
    expect(
      prepared.restoreExcerpt('<div data-audit-heading-id="h1">Resources</div>')
    ).toBe('<h4 class="rank-four">Resources</h4>');
    expect(prepared.restoreExcerpt("Read the guide.")).toBe("Read the guide.");
    expect(prepared.restoreExcerpt("Invented excerpt")).toBeUndefined();
  });

  it("does not guess an occurrence when comment removal makes excerpts identical", () => {
    const prepared = prepareHeadingAuditDocument(
      "<p>Click here<!-- first destination --></p><p>Click here<!-- second destination --></p>"
    );
    expect(prepared.restoreExcerpt("<p>Click here</p>")).toBeUndefined();
    expect(prepared.restoreExcerpt("Click here")).toBeUndefined();
  });

  it("restores evidence around implicit heading closes and bounds long original comments", () => {
    const prepared = prepareHeadingAuditDocument(
      "<h2>Title<h3>Section<p>Read the guide.<!-- " +
        "long note ".repeat(40) +
        "--></p>"
    );
    expect(
      prepared.restoreExcerpt('<div data-audit-heading-id="h1">Title</div>')
    ).toBe("<h2>Title");
    const restored = prepared.restoreExcerpt("<p>Read the guide.</p>");
    expect(restored).toHaveLength(240);
    expect(restored).toMatch(/^<p>Read the guide\./);
  });
});
