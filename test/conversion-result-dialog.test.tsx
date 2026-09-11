// @vitest-environment jsdom

import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccessibilityError } from "@/lib/accessibility-findings";
import type { UploadedDocument } from "@/lib/types/document";

vi.mock("@/lib/actions/documents", () => ({
  getDocumentHtml: vi.fn().mockResolvedValue("<h2>Saved result</h2>"),
}));

import ConversionResultDialog from "@/components/ui/conversion-result-dialog";
import { getDocumentHtml } from "@/lib/actions/documents";

let host: HTMLDivElement;
let root: Root;

function finding(patch: Partial<AccessibilityError> = {}): AccessibilityError {
  return {
    type: "no-table-headers",
    category: "accessibility",
    title: "Identify the labels at the top of this table",
    severity: "error",
    message:
      "The Week and Due date labels have not been connected to their columns. Students using software that reads the page aloud may not hear the label for each value.",
    suggestion:
      "In the converted Canvas page, identify Week and Due date as column headings. Keep their wording and the other rows unchanged.",
    element: "<tr><td>Week</td><td>Due date</td></tr>",
    wcag: "WCAG 1.3.1",
    location: {
      scope: "element",
      sourcePages: [5],
      printedPageLabel: "3",
      section: "Course schedule",
      locator: "First row of the schedule table",
      quote: "Due date",
    },
    ...patch,
  };
}

async function mount(patch: Partial<UploadedDocument> = {}) {
  const document: UploadedDocument = {
    id: "doc-1",
    documentId: "doc-1",
    name: "Course.pdf",
    size: 100,
    uploadedAt: new Date(),
    status: "success",
    locked: false,
    html: "<h2>Course schedule</h2>",
    errors: [finding()],
    ...patch,
  };
  await act(async () => {
    root.render(
      <ConversionResultDialog
        document={document}
        open
        onOpenChange={() => {}}
      />
    );
  });
}

function resultDialog(): HTMLElement {
  return document.querySelector('[role="dialog"]')!;
}

function reviewItem(): HTMLLIElement {
  return resultDialog().querySelector(
    'section[aria-label="Items to review"] li'
  )!;
}

function facultyText(): string {
  const item = reviewItem().cloneNode(true) as HTMLElement;
  item.querySelectorAll("details").forEach((details) => details.remove());
  return item.textContent ?? "";
}

beforeEach(() => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  vi.mocked(getDocumentHtml).mockResolvedValue("<h2>Saved result</h2>");
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("faculty-facing conversion findings", () => {
  it("shows actionable wording and an exact PDF location without expanding an accordion", async () => {
    await mount();

    expect(reviewItem()).not.toBeNull();
    const text = facultyText();
    expect(text).toContain("Needs a fix");
    expect(text).toContain("Identify the labels at the top of this table");
    expect(text).toContain("Where: PDF page 5 (printed page label: 3)");
    expect(text).toContain("Course schedule · First row of the schedule table");
    expect(text).toContain("Near this text: “Due date”");
    expect(text).toContain("What needs attention:");
    expect(text).toContain("What to do: In the converted Canvas page");
    expect(text).not.toContain("WCAG");
    expect(text).not.toContain("<td>");
    expect(text).not.toContain("No table headers");
    const details = reviewItem().querySelector("details")!;
    expect(details.open).toBe(false);
    expect(details.querySelector("summary")?.textContent).toBe(
      "Technical details"
    );
    expect(details.textContent).toContain("WCAG 1.3.1");
    expect(details.querySelector("code")?.textContent).toContain(
      "<td>Week</td>"
    );
    expect(reviewItem().querySelector("tr")).toBeNull();
  });

  it("labels Word locations as converted PDF pages and distinguishes uncertainty", async () => {
    await mount({
      name: "Course.DOCX",
      errors: [finding({ severity: "warning" })],
    });
    expect(facultyText()).toContain("Please check");
    expect(facultyText()).toContain("Converted PDF page 5");
    expect(resultDialog().textContent).toContain(
      "different page breaks from Word"
    );
  });

  it("shows nearby text without inventing a page when the location is unknown", async () => {
    await mount({
      errors: [
        finding({
          location: {
            scope: "element",
            sourcePages: null,
            printedPageLabel: null,
            section: "Course schedule",
            locator: "First row of the table",
            quote: "Due date",
          },
        }),
      ],
    });
    expect(facultyText()).toContain("We couldn't identify the source page.");
    expect(facultyText()).toContain("First row of the table");
    expect(facultyText()).toContain("Near this text: “Due date”");
    expect(facultyText()).not.toContain("page 5");
  });

  it("uses whole-document wording for a review limitation", async () => {
    await mount({
      errors: [
        finding({
          severity: "warning",
          location: {
            scope: "document",
            sourcePages: null,
            printedPageLabel: null,
            section: null,
            locator: null,
            quote: null,
          },
        }),
      ],
    });
    expect(facultyText()).toContain("Where: Whole document");
    expect(facultyText()).not.toContain("couldn't identify");
  });

  it("keeps restored findings visible when the online HTML copy is unavailable", async () => {
    vi.mocked(getDocumentHtml).mockResolvedValue(null);
    await mount({ html: undefined });
    expect(getDocumentHtml).toHaveBeenCalledWith("doc-1");
    expect(resultDialog().textContent).toContain(
      "Online documents expire after 14 days"
    );
    expect(facultyText()).toContain("PDF page 5");
    expect(
      Array.from(resultDialog().querySelectorAll("button")).some(
        (button) => button.textContent === "Download HTML"
      )
    ).toBe(false);
  });

  it("presents older internal review markers in readable language", async () => {
    await mount({
      errors: [
        {
          type: "missing-link",
          severity: "warning",
          message: "LINK TARGET REQUIRED: PDF page 5; near Resources",
          suggestion: "Manual review required",
          element: "<!-- LINK TARGET REQUIRED: PDF page 5; near Resources -->",
        },
      ],
    });
    expect(facultyText()).not.toContain("LINK TARGET REQUIRED");
    expect(facultyText()).not.toContain("Manual review required");
    expect(
      reviewItem().querySelector("h3")?.textContent?.length
    ).toBeGreaterThan(0);
    expect(facultyText()).toContain("What to do:");
  });

  it("replaces a saved technical title and its jargon with faculty-readable guidance", async () => {
    await mount({
      html: undefined,
      errors: [
        finding({
          title: "Table missing header cells",
          message: "Table lacks th scope associations.",
          suggestion: "Add th scope=col.",
        }),
      ],
    });

    expect(getDocumentHtml).toHaveBeenCalledWith("doc-1");
    const text = facultyText();
    expect(reviewItem().querySelector("h3")?.textContent).toBe(
      "Identify this table's column or row labels"
    );
    expect(text).toContain("The table may not tell software that reads aloud");
    expect(text).toContain(
      "In your Canvas page, identify the cells that label each column or row"
    );
    expect(text).toContain("PDF page 5");
    expect(text).not.toContain("Table missing header cells");
    expect(text).not.toContain("th scope");
    expect(text).not.toContain("scope=col");
    expect(text).not.toContain("WCAG");
    expect(reviewItem().querySelector("details")?.open).toBe(false);
    expect(reviewItem().querySelector("details")?.textContent).toContain(
      "WCAG 1.3.1"
    );
  });
});
