import {
  incompleteAuditWarning,
  type AccessibilityError,
  type FindingLocation,
} from "./accessibility-findings";
import {
  headingText,
  type HtmlHeading,
  type HtmlHeadingInventory,
} from "./html-headings";

interface SourceHeading {
  id: string;
  page: number;
  text: string;
  parentId: string | null;
  rank: number | null;
  certainty: "supported" | "uncertain";
  evidence: string;
  htmlHeadingIds: string[];
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(value: unknown, max: number): value is string {
  return (
    typeof value === "string" && value.trim().length > 0 && value.length <= max
  );
}

function sourceHeading(
  value: unknown,
  pageCount: number
): SourceHeading | undefined {
  const row = object(value);
  if (
    !row ||
    !text(row.id, 40) ||
    !text(row.text, 500) ||
    !Number.isSafeInteger(row.page) ||
    (row.page as number) < 1 ||
    (row.page as number) > pageCount ||
    !(row.parentId === null || text(row.parentId, 40)) ||
    !(
      row.rank === null ||
      (Number.isInteger(row.rank) &&
        (row.rank as number) >= 1 &&
        (row.rank as number) <= 6)
    ) ||
    !["supported", "uncertain"].includes(row.certainty as string) ||
    !text(row.evidence, 1000) ||
    !Array.isArray(row.htmlHeadingIds) ||
    row.htmlHeadingIds.length > 1 ||
    !row.htmlHeadingIds.every((id) => text(id, 40))
  )
    return undefined;
  return row as unknown as SourceHeading;
}

function location(
  source: SourceHeading,
  parent?: SourceHeading
): FindingLocation {
  return {
    scope: "element",
    sourcePages: [source.page],
    printedPageLabel: null,
    section: (parent?.text ?? source.text).slice(0, 200),
    locator: `Section heading “${source.text}”`.slice(0, 200),
    quote: source.text.slice(0, 240),
  };
}

function reviewWarning(
  source: SourceHeading,
  parent: SourceHeading | undefined,
  html: HtmlHeading | undefined,
  reason: "uncertain" | "unmapped" | "wording" | "location"
): AccessibilityError {
  const messages = {
    uncertain: `The automatic check could not confirm how “${source.text}” belongs with the surrounding sections.`,
    unmapped: `The source heading “${source.text}” could not be matched to a separate heading in the converted page. It may have been combined with a continued section or left out.`,
    wording: `The source heading “${source.text}” was matched to “${html?.text ?? "a different heading"}” in the converted page, so the section comparison needs verification.`,
    location: `The automatic check could not verify the source location of the heading “${source.text}”.`,
  };
  return {
    type: "other",
    category: "source-review",
    severity: "warning",
    title: `Check the section “${source.text}”`.slice(0, 100),
    message: messages[reason],
    suggestion: `Compare “${source.text}” in the original document with the converted Canvas page. Check its wording and whether it starts a new section or belongs within another section, then use that grouping in Canvas. A repeated heading may be combined only when the content continues the same section.`,
    ...(html?.element ? { element: html.element } : {}),
    location:
      reason === "location"
        ? { ...location(source, parent), sourcePages: null }
        : location(source, parent),
  };
}

function relationshipFinding(
  source: SourceHeading,
  parent: SourceHeading | undefined,
  html: HtmlHeading
): AccessibilityError {
  return {
    type: "other",
    category: "accessibility",
    severity: "error",
    title: (parent
      ? `Place “${source.text}” within “${parent.text}”`
      : `Restore “${source.text}” as a main section`
    ).slice(0, 100),
    message: parent
      ? `The source places “${source.text}” within “${parent.text}”, but the converted heading structure gives it a different section grouping. Students navigating by headings may miss that relationship.`
      : `The converted page places “${source.text}” inside another section even though it starts a main section in the source. Students navigating by headings may misunderstand the grouping.`,
    suggestion: parent
      ? `On the converted Canvas page, format “${source.text}” one heading level below “${parent.text}”. Keep both headings' original wording. If you need help with the formatting, share this finding with your campus accessibility support team.`
      : `On the converted Canvas page, give “${source.text}” the same heading level as the other main sections. Keep its wording unchanged.`,
    ...(html.element ? { element: html.element } : {}),
    wcag: "WCAG 1.3.1",
    location: location(source, parent),
  };
}

function headingMarkupEntries(
  inventory: HtmlHeadingInventory
): Array<{ html: HtmlHeading; finding: AccessibilityError }> {
  const findings: Array<{ html: HtmlHeading; finding: AccessibilityError }> =
    [];
  for (const [index, html] of inventory.headings.entries()) {
    const add = (finding: AccessibilityError) =>
      findings.push({ html, finding });
    const base = {
      ...(html.element ? { element: html.element } : {}),
      location: {
        scope: "element" as const,
        sourcePages: null,
        printedPageLabel: null,
        section: html.text.slice(0, 200) || null,
        locator: "Heading in the converted Canvas page",
        quote: html.text.slice(0, 240) || null,
      },
    };
    if (!html.text)
      add({
        ...base,
        type: "empty-heading",
        category: "accessibility",
        severity: "error",
        title: "Remove or complete the empty heading",
        message:
          "The converted page contains a heading with no text. It can create a blank stop for students navigating by headings.",
        suggestion:
          "In the converted Canvas page, remove the empty heading or restore its missing wording from the original document.",
      });
    if (html.level === 1)
      add({
        ...base,
        type: "h1-present",
        category: "canvas",
        severity: "warning",
        title: "Check the document title's formatting",
        message: `“${html.text || "The empty title"}” uses the top heading level, which Canvas already supplies for the page title.`,
        suggestion:
          "In the converted Canvas page, keep the title's wording and use the next heading level for it. Adjust its subsections accordingly, or ask your campus accessibility support team for help.",
      });
    if (index > 0 && html.level > inventory.headings[index - 1].level + 1)
      add({
        ...base,
        type: "heading-skip",
        category: "source-review",
        severity: "warning",
        title: `Check the heading level for “${html.text}”`.slice(0, 100),
        message: `The heading level jumps before “${html.text}”. Check whether the formatting correctly shows which section it belongs to.`,
        suggestion: `Compare “${html.text}” with the original document. In Canvas, put a subsection one heading level below its containing section, keeping the wording unchanged.`,
      });
  }
  return findings;
}

export function headingMarkupFindings(
  inventory: HtmlHeadingInventory
): AccessibilityError[] {
  return headingMarkupEntries(inventory).map(({ finding }) => finding);
}

/**
 * Validate source evidence and compare parent IDs ourselves. The model does not
 * get to suppress a supported mismatch merely by omitting a free-text finding.
 * Source semantics remain a model judgment; this does not certify accessibility.
 */
export function evaluateHeadingReview(
  value: unknown,
  inventory: HtmlHeadingInventory,
  pageCount: number,
  pageTexts?: ReadonlyMap<number, string | null>
): { findings: AccessibilityError[]; complete: boolean } {
  const findings: AccessibilityError[] = [];
  const review = object(value);
  let complete = inventory.complete;
  if (
    !review ||
    !Number.isSafeInteger(pageCount) ||
    pageCount < 1 ||
    !Array.isArray(review.pagesReviewed) ||
    !Array.isArray(review.sourceHeadings) ||
    review.sourceHeadings.length > 1000 ||
    !Array.isArray(review.unmatchedHtmlHeadingIds) ||
    review.unmatchedHtmlHeadingIds.length > inventory.headings.length
  ) {
    return {
      findings: [...headingMarkupFindings(inventory), incompleteAuditWarning()],
      complete: false,
    };
  }
  const pages = review.pagesReviewed;
  if (
    pages.length !== pageCount ||
    new Set(pages).size !== pageCount ||
    pages.some(
      (page) => !Number.isSafeInteger(page) || page < 1 || page > pageCount
    )
  )
    complete = false;
  const htmlById = new Map(inventory.headings.map((h) => [h.id, h]));
  const sources: SourceHeading[] = [];
  const sourceById = new Map<string, SourceHeading>();
  const invalidSources = new Set<string>();
  const openSources: SourceHeading[] = [];
  const closedSourceIds = new Set<string>();
  const relationshipHeadingIds = new Set<string>();
  const claims = new Map<string, Array<SourceHeading | null>>();
  const claim = (id: unknown, source: SourceHeading | null) => {
    if (typeof id !== "string" || !htmlById.has(id)) {
      complete = false;
      if (source) invalidSources.add(source.id);
      return;
    }
    const entries = claims.get(id) ?? [];
    entries.push(source);
    claims.set(id, entries);
  };

  let previousPage = 0;
  for (const raw of review.sourceHeadings) {
    const source = sourceHeading(raw, pageCount);
    if (!source) {
      complete = false;
      continue;
    }
    if (sourceById.has(source.id)) {
      invalidSources.add(source.id);
      complete = false;
      continue;
    }
    const parent = source.parentId
      ? sourceById.get(source.parentId)
      : undefined;
    // A later peer closes the earlier section. A child cannot point back to
    // that closed occurrence; a continued section needs its own occurrence.
    if (source.rank !== null) {
      while (
        openSources.length &&
        openSources[openSources.length - 1].rank! >= source.rank
      )
        closedSourceIds.add(openSources.pop()!.id);
    }
    if (
      source.page < previousPage ||
      (source.parentId !== null &&
        (!parent ||
          invalidSources.has(parent.id) ||
          closedSourceIds.has(parent.id))) ||
      (source.certainty === "supported" &&
        (source.rank === null ||
          (source.parentId === null && source.rank !== 1) ||
          (parent?.certainty === "supported" &&
            source.rank !== parent.rank! + 1)))
    ) {
      invalidSources.add(source.id);
      complete = false;
    }
    previousPage = source.page;
    sources.push(source);
    sourceById.set(source.id, source);
    if (source.rank !== null) openSources.push(source);
    for (const id of source.htmlHeadingIds) claim(id, source);
  }
  for (const id of review.unmatchedHtmlHeadingIds) claim(id, null);
  for (const html of inventory.headings) {
    const entries = claims.get(html.id) ?? [];
    if (entries.length !== 1) {
      complete = false;
      for (const entry of entries) if (entry) invalidSources.add(entry.id);
    }
  }

  for (const source of sources) {
    if (invalidSources.has(source.id)) continue;
    const html = htmlById.get(source.htmlHeadingIds[0]);
    const parent = source.parentId
      ? sourceById.get(source.parentId)
      : undefined;
    const rawPageText = pageTexts?.get(source.page);
    // PDF text extraction may be unavailable for scanned pages. When text is
    // available, do not attach a claimed source location contradicted by it.
    const compact = (s: string) =>
      headingText(s).replace(/\s/gu, "").toLocaleLowerCase("en");
    if (
      rawPageText?.trim() &&
      !compact(rawPageText).includes(compact(source.text))
    ) {
      invalidSources.add(source.id);
      findings.push(reviewWarning(source, parent, html, "location"));
      continue;
    }
    if (!html) {
      findings.push(reviewWarning(source, parent, undefined, "unmapped"));
      continue;
    }
    if (headingText(html.text) !== headingText(source.text)) {
      invalidSources.add(source.id);
      findings.push(reviewWarning(source, parent, html, "wording"));
      continue;
    }
    if (
      source.certainty === "uncertain" ||
      (parent &&
        (parent.certainty !== "supported" ||
          invalidSources.has(parent.id) ||
          parent.htmlHeadingIds.length !== 1 ||
          claims.get(parent.htmlHeadingIds[0])?.length !== 1))
    ) {
      findings.push(reviewWarning(source, parent, html, "uncertain"));
      continue;
    }
    const expectedParentId = parent?.htmlHeadingIds[0] ?? null;
    if (html.parentId !== expectedParentId) {
      findings.push(relationshipFinding(source, parent, html));
      relationshipHeadingIds.add(html.id);
    }
  }

  for (const id of review.unmatchedHtmlHeadingIds) {
    const html = typeof id === "string" ? htmlById.get(id) : undefined;
    if (!html || claims.get(html.id)?.length !== 1) continue;
    if (!html.text) continue;
    findings.push({
      type: "other",
      category: "source-review",
      severity: "warning",
      title: `Check the heading “${html.text}”`.slice(0, 100),
      message: `The automatic check could not match “${html.text}” to a section heading in the source.`,
      suggestion: `Compare this heading and its surrounding content with the original document. Keep it as a heading only if it introduces a section; ordinary labels and emphasized instructions should keep their original role.`,
      ...(html.element ? { element: html.element } : {}),
      location: {
        scope: "element",
        sourcePages: null,
        printedPageLabel: null,
        section: html.text.slice(0, 200),
        locator: "Heading in the converted Canvas page",
        quote: html.text.slice(0, 240),
      },
    });
  }
  for (const { html, finding: markup } of headingMarkupEntries(inventory)) {
    // A concrete source-parent error already provides the repair for this heading.
    if (markup.type === "heading-skip" && relationshipHeadingIds.has(html.id))
      continue;
    const mapped = claims.get(html.id);
    const source = mapped?.length === 1 ? mapped[0] : undefined;
    if (source && !invalidSources.has(source.id))
      markup.location = location(
        source,
        source.parentId ? sourceById.get(source.parentId) : undefined
      );
    findings.push(markup);
  }
  if (!complete) findings.push(incompleteAuditWarning());
  return { findings, complete };
}
