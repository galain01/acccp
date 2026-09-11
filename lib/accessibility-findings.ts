/** Shared, browser-safe finding contracts and presentation fallbacks. */
export const FINDING_TYPES = [
  "missing-alt",
  "heading-skip",
  "bad-link",
  "no-table-caption",
  "no-table-headers",
  "missing-list-markup",
  "empty-heading",
  "color-only-meaning",
  "h1-present",
  "non-descriptive-link",
  "missing-image",
  "missing-link",
  "other",
] as const;
export type FindingCategory =
  | "accessibility"
  | "canvas"
  | "source-review"
  | "content-fidelity";
export interface FindingLocation {
  scope: "element" | "document";
  sourcePages: number[] | null;
  printedPageLabel: string | null;
  section: string | null;
  locator: string | null;
  quote: string | null;
}
export interface AccessibilityError {
  type: (typeof FINDING_TYPES)[number];
  severity: "error" | "warning";
  title?: string;
  category?: FindingCategory;
  message: string;
  suggestion: string;
  element?: string;
  wcag?: string;
  location?: FindingLocation;
}

export function boundedText(value: unknown, limit: number): string | undefined {
  return typeof value === "string" && value.trim()
    ? value.trim().slice(0, limit)
    : undefined;
}

export function findingCategory(value: unknown): FindingCategory | undefined {
  return typeof value === "string" &&
    ["accessibility", "canvas", "source-review", "content-fidelity"].includes(
      value
    )
    ? (value as FindingCategory)
    : undefined;
}

/** Without a measured count, supplied page numbers cannot be range-checked. */
export function readFindingLocation(
  value: unknown,
  pageCount?: number | null
): FindingLocation | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const input = value as Record<string, unknown>;
  if (
    !["scope", "sourcePages", "section", "locator", "quote"].some(
      (key) => key in input
    )
  )
    return undefined;
  const scope = input.scope === "document" ? "document" : "element";
  const measured =
    typeof pageCount === "number" &&
    Number.isSafeInteger(pageCount) &&
    pageCount > 0;
  const pages = input.sourcePages;
  const validPages =
    scope !== "document" &&
    measured &&
    Array.isArray(pages) &&
    pages.length > 0 &&
    pages.length <= pageCount &&
    pages.every(
      (page) => Number.isSafeInteger(page) && page >= 1 && page <= pageCount
    ) &&
    new Set(pages).size === pages.length;
  return {
    scope,
    sourcePages: validPages ? [...pages].sort((a, b) => a - b) : null,
    printedPageLabel: validPages
      ? (boundedText(input.printedPageLabel, 40) ?? null)
      : null,
    section: boundedText(input.section, 200) ?? null,
    locator: boundedText(input.locator, 200) ?? null,
    quote: boundedText(input.quote, 240) ?? null,
  };
}

const COPY: Record<AccessibilityError["type"], [string, string, string]> = {
  "missing-alt": [
    "Describe this image",
    "This image needs a description so students who cannot see it can understand its purpose.",
    "In your Canvas page, add a short description of the information students need from this image. Check it against the original document.",
  ],
  "heading-skip": [
    "Check this section heading",
    "This heading may not show how the section belongs with the surrounding sections.",
    "Compare this section with the original. Use the heading formatting in your Canvas editor to show whether it is a main section or a subsection, keeping its wording.",
  ],
  "bad-link": [
    "Check this link",
    "This link may not take students to the intended resource.",
    "Find this link in your Canvas page and check its destination. Replace it with the correct address from your original material if needed.",
  ],
  "no-table-caption": [
    "Check the table's description",
    "Students may need a clearer explanation of what this table contains.",
    "Check the table and nearby text in your Canvas page. Add a brief, accurate table title or description if its purpose is unclear.",
  ],
  "no-table-headers": [
    "Identify this table's column or row labels",
    "The table may not tell software that reads aloud which labels belong with its entries.",
    "In your Canvas page, identify the cells that label each column or row using the table formatting controls. If you need help, share the optional technical details with your campus accessibility support team.",
  ],
  "missing-list-markup": [
    "Format these items as a list",
    "These items look like a list, but may be read as ordinary paragraphs.",
    "In your Canvas page, select these items and apply numbered or bulleted list formatting. Keep the original order and wording.",
  ],
  "empty-heading": [
    "Check the blank section heading",
    "A heading with no text can make the page harder to navigate.",
    "In your Canvas page, remove the empty heading or restore its missing wording from the original document.",
  ],
  "color-only-meaning": [
    "Explain what the color means",
    "Some instructions may depend on students being able to distinguish colors.",
    "Check the highlighted material in your Canvas page. Add words or another visible cue to communicate the same instruction without needing to identify its color.",
  ],
  "h1-present": [
    "Check the document title's formatting",
    "The converted content includes another top-level title in addition to the Canvas page title.",
    "Keep the title's wording, but use the next heading level for it in the Canvas editor. If needed, ask your campus accessibility support team to help with the title formatting.",
  ],
  "non-descriptive-link": [
    "Make this link clearer",
    "The link's wording and surrounding text may not explain what it opens.",
    "Check the destination, then change the link's words in your Canvas page to describe that resource. Keep the intended destination.",
  ],
  "missing-image": [
    "Add the missing image",
    "The image from your original document has not been included in the converted page.",
    "Insert the original image at this location in your Canvas page. Check any existing written description against the image, and add an explanation of its essential information if needed.",
  ],
  "missing-link": [
    "Add the missing link address",
    "The converter could not establish where this link should take students.",
    "Find the correct destination in your original material, then add that address to the corresponding text in your Canvas page.",
  ],
  other: [
    "Check this part of the document",
    "The converter could not confirm that this part of the document was represented correctly.",
    "Compare the indicated material with your original document. Correct any missing or changed content in your Canvas page; ask your campus accessibility support team for help if the needed change is unclear.",
  ],
};

const LEGACY_TITLES = new Set([
  "Missing alt text",
  "Heading level skipped",
  "Broken or invalid link",
  "Table missing a caption",
  "Table missing header cells",
  "List not marked up as a list",
  "Empty heading",
  "Meaning conveyed by colour alone",
  "H1 used inside page content",
  "Non-descriptive link text",
  "Image could not be extracted",
  "Link could not be extracted",
  "Accessibility issue",
]);

/** Legacy findings and machine markers must not become faculty instructions. */
export function presentFinding(issue: AccessibilityError): AccessibilityError {
  const fallback = COPY[issue.type] ?? COPY.other;
  const title = boundedText(issue.title, 100);
  const marker =
    /\b(?:SOURCE TEXT|HEADING|LINK TARGET|LINK TEXT|IMAGE DESCRIPTION|IMAGE|TABLE)(?: REVIEW)? REQUIRED\b/i.test(
      issue.message
    );
  const legacy =
    !title ||
    marker ||
    LEGACY_TITLES.has(title) ||
    (FINDING_TYPES as readonly string[]).includes(title);
  return {
    ...issue,
    title: legacy ? fallback[0] : title,
    message: legacy ? fallback[1] : issue.message,
    suggestion: legacy ? fallback[2] : issue.suggestion,
  };
}

/** Preserve usable core findings even when optional location metadata is invalid. */
export function parseFinding(
  value: unknown,
  html: string,
  pageCount?: number | null
): AccessibilityError | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const input = value as Record<string, unknown>;
  if (
    !(FINDING_TYPES as readonly unknown[]).includes(input.type) ||
    (input.severity !== "error" && input.severity !== "warning") ||
    !boundedText(input.message, 2000) ||
    !boundedText(input.suggestion, 3000)
  )
    return undefined;
  const element = boundedText(input.element, 240);
  const title = boundedText(input.title, 100);
  const category = findingCategory(input.category);
  const wcag = boundedText(input.wcag, 80);
  const location = readFindingLocation(input.location, pageCount);
  return {
    type: input.type as AccessibilityError["type"],
    severity: input.severity,
    message: boundedText(input.message, 2000)!,
    suggestion: boundedText(input.suggestion, 3000)!,
    ...(title ? { title } : {}),
    ...(category ? { category } : {}),
    ...(element && html.includes(element) ? { element } : {}),
    ...(wcag && /^WCAG (?:2\.1 )?[1-4]\.\d{1,2}\.\d{1,2}$/.test(wcag)
      ? { wcag }
      : {}),
    ...(location ? { location } : {}),
  };
}

export function incompleteAuditWarning(): AccessibilityError {
  return {
    type: "other",
    severity: "warning",
    category: "source-review",
    title: "The document check is incomplete",
    message:
      "The document was converted, but the automatic check did not finish reliably. There may be problems that have not been reported.",
    suggestion:
      "Try converting the document again. If this continues, ask your campus accessibility support team to help check the converted page before sharing it with students.",
    location: {
      scope: "document",
      sourcePages: null,
      printedPageLabel: null,
      section: null,
      locator: null,
      quote: null,
    },
  };
}
