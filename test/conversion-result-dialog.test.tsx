// @vitest-environment jsdom

import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccessibilityError } from "@/lib/accessibility-findings";
import type { UploadedDocument } from "@/lib/types/document";

vi.mock("@/lib/actions/documents", () => ({
  getDocumentHtml: vi.fn().mockResolvedValue("<h2>Saved result</h2>"),
  getDocumentOutputDownload: vi.fn(),
}));

vi.mock("@/lib/actions/powerpoint-review", () => ({
  getPowerPointReview: vi.fn().mockResolvedValue(null),
  getPowerPointReviewPreview: vi.fn().mockResolvedValue(null),
}));

import ConversionResultDialog from "@/components/ui/conversion-result-dialog";
import {
  getDocumentHtml,
  getDocumentOutputDownload,
} from "@/lib/actions/documents";

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
  vi.mocked(getDocumentOutputDownload).mockResolvedValue({
    url: "https://storage.example.test/fresh-word",
    filename: "Course-accessible.docx",
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("native PDF results", () => {
  const interactionTestSummary = {
    evidenceId: "synthetic-form-test",
    testedAt: "2026-10-22",
    environment: "Acrobat and NVDA",
    passedChecks: [
      "The name field announced its label.",
      "Entered sample values survived saving and reopening.",
    ],
    scopeNote:
      "Earlier tests match this form; they were not rerun for this conversion.",
  };

  it("separately shows the earlier test date, environment, completed checks and scope", async () => {
    await mount({ outputTarget: "accessible_pdf", interactionTestSummary });
    const section = resultDialog().querySelector(
      'section[aria-label="Previously tested form behavior"]'
    )!;
    expect(section).not.toBeNull();
    expect(section.querySelector("time")?.dateTime).toBe("2026-10-22");
    expect(section.textContent).toContain("Acrobat and NVDA");
    expect(
      Array.from(section.querySelectorAll("li"), (li) => li.textContent)
    ).toEqual(interactionTestSummary.passedChecks);
    expect(section.textContent).toContain("not rerun for this conversion");
    expect(section.textContent).not.toContain("certified");
    expect(resultDialog().textContent).not.toContain("and any form fields");
    expect(
      resultDialog().querySelectorAll(
        'section[aria-label="Items to review"] li'
      )
    ).toHaveLength(1);
  });

  it.each([
    { outputTarget: "accessible_pdf" as const },
    { outputTarget: "canvas_html" as const, interactionTestSummary },
    {
      outputTarget: "accessible_pdf" as const,
      status: "error" as const,
      interactionTestSummary,
    },
  ])(
    "does not show prior test evidence for an older, non-PDF or failed result (%#)",
    async (patch) => {
      await mount(patch);
      expect(
        resultDialog().querySelector(
          'section[aria-label="Previously tested form behavior"]'
        )
      ).toBeNull();
    }
  );

  it("shows page-specific findings and a PDF download without fetching HTML or implying certification", async () => {
    const clicked: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement
    ) {
      clicked.push(this.href);
    });
    vi.mocked(getDocumentOutputDownload).mockResolvedValue({
      url: "https://storage.example.test/fresh-pdf",
      filename: "Course-repaired.pdf",
    });
    await mount({
      outputTarget: "accessible_pdf",
      html: undefined,
      changes: ["Page 5: connected the table headings to their columns."],
      errors: [
        finding({
          severity: "warning",
          suggestion: "Check the labels in the repaired PDF on page 5.",
        }),
      ],
    });
    const dialog = resultDialog();
    expect(dialog.textContent).toContain("connected the table headings");
    expect(dialog.textContent).toContain(
      "Automatic checks do not certify PDF accessibility"
    );
    expect(facultyText()).toContain("Where: PDF page 5");
    expect(facultyText()).toContain("repaired PDF on page 5");
    expect(dialog.textContent).not.toContain("Canvas");
    const actions = Array.from(dialog.querySelectorAll("button"));
    expect(actions.map((button) => button.textContent)).not.toContain(
      "Review changes"
    );
    expect(actions.map((button) => button.textContent)).not.toContain(
      "Copy HTML"
    );
    const download = actions.find(
      (button) => button.textContent === "Download repaired PDF"
    )!;
    await act(async () => download.click());
    await act(async () => download.click());
    expect(getDocumentOutputDownload).toHaveBeenCalledTimes(2);
    expect(getDocumentOutputDownload).toHaveBeenCalledWith(
      "doc-1",
      "accessible_pdf"
    );
    expect(clicked).toEqual([
      "https://storage.example.test/fresh-pdf",
      "https://storage.example.test/fresh-pdf",
    ]);
    expect(getDocumentHtml).not.toHaveBeenCalled();
    expect(reviewItem()).not.toBeNull();
  });

  it("retains changes and findings when the repaired PDF has expired", async () => {
    vi.mocked(getDocumentOutputDownload).mockResolvedValueOnce(null);
    await mount({
      outputTarget: "accessible_pdf",
      html: undefined,
      changes: ["Added document language."],
      errors: [finding({ suggestion: "Check the repaired PDF." })],
    });
    const download = Array.from(resultDialog().querySelectorAll("button")).find(
      (button) => button.textContent === "Download repaired PDF"
    )!;
    await act(async () => download.click());
    expect(
      resultDialog().querySelector('[role="alert"]')?.textContent
    ).toContain("expire after 14 days");
    expect(resultDialog().textContent).toContain("Added document language.");
    expect(
      resultDialog().querySelector('[role="status"]')?.textContent
    ).toContain("a PDF editor");
    expect(getDocumentHtml).not.toHaveBeenCalled();
  });
});

describe("native Word results", () => {
  it("shows actual changes and review locations without fetching HTML or offering HTML actions", async () => {
    await mount({
      name: "Course.DOCX",
      outputTarget: "accessible_docx",
      html: undefined,
      changes: ["Course schedule: identified its first row as column labels."],
      errors: [
        finding({
          severity: "warning",
          suggestion: "In Word, check the labels in the course schedule table.",
        }),
      ],
    });
    const dialog = resultDialog();
    expect(
      dialog.querySelector('section[aria-label="Changes made"]')?.textContent
    ).toContain("identified its first row as column labels");
    expect(dialog.textContent).toContain("Word’s Accessibility Checker");
    expect(facultyText()).toContain("Course schedule");
    expect(facultyText()).toContain("page 5");
    expect(facultyText()).toContain("In Word, check the labels");
    const actions = Array.from(dialog.querySelectorAll("button")).map(
      (button) => button.textContent
    );
    expect(actions).toContain("Download Word document");
    expect(actions).not.toContain("Copy HTML");
    expect(actions).not.toContain("Download HTML");
    expect(actions).not.toContain("Review changes");
    expect(getDocumentHtml).not.toHaveBeenCalled();
  });

  it("gets a fresh signed Word URL on each download click and preserves warnings", async () => {
    const clicked: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement
    ) {
      clicked.push(this.href);
    });
    vi.mocked(getDocumentOutputDownload)
      .mockResolvedValueOnce({
        url: "https://storage.example.test/word-first",
        filename: "Course-accessible.docx",
      })
      .mockResolvedValueOnce({
        url: "https://storage.example.test/word-second",
        filename: "Course-accessible.docx",
      });
    await mount({
      name: "Course.docx",
      outputTarget: "accessible_docx",
      html: undefined,
    });
    const download = () =>
      Array.from(resultDialog().querySelectorAll("button")).find(
        (button) => button.textContent === "Download Word document"
      )!;
    await act(async () => download().click());
    await act(async () => download().click());
    expect(getDocumentOutputDownload).toHaveBeenCalledTimes(2);
    expect(getDocumentOutputDownload).toHaveBeenNthCalledWith(
      1,
      "doc-1",
      "accessible_docx"
    );
    expect(getDocumentOutputDownload).toHaveBeenNthCalledWith(
      2,
      "doc-1",
      "accessible_docx"
    );
    expect(clicked).toEqual([
      "https://storage.example.test/word-first",
      "https://storage.example.test/word-second",
    ]);
    expect(reviewItem()).not.toBeNull();
    expect(
      resultDialog().querySelector('[role="status"]')?.textContent
    ).toContain("need a fix");
    expect(getDocumentHtml).not.toHaveBeenCalled();
  });

  it("explains an expired Word result while retaining the changes and review list", async () => {
    vi.mocked(getDocumentOutputDownload).mockResolvedValueOnce(null);
    await mount({
      name: "Course.docx",
      outputTarget: "accessible_docx",
      html: undefined,
      changes: ["Identified section headings."],
    });
    const download = Array.from(resultDialog().querySelectorAll("button")).find(
      (button) => button.textContent === "Download Word document"
    )!;
    await act(async () => download.click());
    expect(
      resultDialog().querySelector('[role="alert"]')?.textContent
    ).toContain("expire after 14 days");
    expect(resultDialog().textContent).toContain(
      "files on your computer are unaffected"
    );
    expect(resultDialog().textContent).toContain(
      "Identified section headings."
    );
    expect(reviewItem()).not.toBeNull();
    expect(getDocumentHtml).not.toHaveBeenCalled();
  });
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
