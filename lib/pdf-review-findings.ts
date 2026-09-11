import {
  boundedText,
  presentFinding,
  readFindingLocation,
  type AccessibilityError,
  type FindingLocation,
} from "./accessibility-findings";

const MARKERS =
  /<!--\s*((?:SOURCE TEXT|HEADING|LINK TARGET|LINK TEXT|IMAGE DESCRIPTION|IMAGE|TABLE)(?: REVIEW)? REQUIRED)\b([\s\S]*?)-->/gi;

function markerLocation(
  text: string,
  pageCount: number | null
): FindingLocation {
  // Only the declared first field is a page claim. A quote such as "see page
  // 5" must never turn an unknown source location into page 5.
  const pageField = text.replace(/^:\s*/, "").split(";")[0].trim();
  const match = pageField.match(
    /^(?:PDF\s+)?pages?\s+(\d+)(?:\s*[-–]\s*(\d+))?$/i
  );
  let pages: number[] | null = null;
  if (match && pageCount) {
    const start = Number(match[1]);
    const end = Number(match[2] ?? match[1]);
    if (start > 0 && end >= start && end <= pageCount && end - start < 1000) {
      pages = Array.from({ length: end - start + 1 }, (_, i) => start + i);
    }
  }
  const parts = text
    .replace(/^:\s*/, "")
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean);
  const section = parts
    .find((part) => /^section\s+/i.test(part))
    ?.replace(/^section\s+/i, "");
  const quote = parts
    .find((part) => /^near\s+/i.test(part))
    ?.replace(/^near\s+/i, "");
  const locator = parts.find(
    (part) => !/^(?:(?:PDF\s+)?pages?\s+|section\s+|near\s+)/i.test(part)
  );
  return readFindingLocation(
    { scope: "element", sourcePages: pages, section, quote, locator },
    pageCount
  )!;
}

interface HtmlSpan {
  start: number;
  end: number;
}
interface ElementSpan extends HtmlSpan {
  tag: string;
  contentEnd: number;
}
interface HtmlIndex {
  elements: ElementSpan[];
  comments: HtmlSpan[];
  text: HtmlSpan[];
}

/** Index original offsets without executing HTML or reconstructing its markup. */
function indexHtml(html: string): HtmlIndex {
  const result: HtmlIndex = { elements: [], comments: [], text: [] };
  const stack: { tag: string; start: number }[] = [];
  const eligible = /^(?:a|h[2-6]|p|li|th|td|table|img)$/;
  const voidTag =
    /^(?:area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)$/;
  let cursor = 0;
  for (const token of html.matchAll(
    /<!--[\s\S]*?(?:-->|$)|<![^>]*>|<\/?([a-z][\w:-]*)\b(?:[^<>"']|"[^"]*"|'[^']*')*>/gi
  )) {
    if (token.index > cursor)
      result.text.push({ start: cursor, end: token.index });
    const end = token.index + token[0].length;
    if (token[0].startsWith("<!--")) {
      result.comments.push({ start: token.index, end });
    } else if (token[1]) {
      const tag = token[1].toLowerCase();
      if (token[0].startsWith("</")) {
        const open = stack.findLastIndex((item) => item.tag === tag);
        if (open >= 0) {
          const start = stack[open].start;
          stack.length = open;
          if (eligible.test(tag))
            result.elements.push({ tag, start, end, contentEnd: token.index });
        }
      } else if (voidTag.test(tag) || /\/\s*>$/.test(token[0])) {
        if (eligible.test(tag))
          result.elements.push({
            tag,
            start: token.index,
            end,
            contentEnd: end,
          });
      } else {
        stack.push({ tag, start: token.index });
      }
    }
    cursor = end;
  }
  if (cursor < html.length)
    result.text.push({ start: cursor, end: html.length });
  return result;
}

function nearbyElement(
  html: string,
  position: number,
  index: HtmlIndex
): string | undefined {
  // A completed adjacent link/heading is more specific than its parent. Never
  // jump across substantive text to a previous paragraph or section heading.
  const adjacent = index.elements
    .filter(
      (element) =>
        element.end <= position &&
        html.slice(element.end, position).trim() === ""
    )
    .sort((a, b) => b.end - a.end || b.start - a.start)[0];
  if (adjacent && !/^(?:p|li|th|td|table)$/.test(adjacent.tag))
    return boundedText(html.slice(adjacent.start, adjacent.end), 240);

  const containing =
    adjacent ??
    index.elements
      .filter(
        (element) => element.start < position && position < element.contentEnd
      )
      .sort((a, b) => b.start - a.start)[0];
  if (!containing) return undefined;
  if (adjacent) position = adjacent.contentEnd;
  // Separate markers within one paragraph must retain separate evidence. Keep
  // the exact text immediately before this marker, after any previous comment.
  const previousComment = index.comments
    .filter(
      (comment) => comment.end <= position && comment.end > containing.start
    )
    .at(-1);
  const previousLink = index.elements
    .filter(
      (element) =>
        element.tag === "a" &&
        element.start > containing.start &&
        element.end <= position
    )
    .sort((a, b) => b.end - a.end)[0];
  // An earlier link in the same paragraph is a different potential finding.
  // Exclude it when substantive text follows; punctuation alone still belongs
  // with the preceding link and must not erase the useful evidence.
  const afterLink =
    previousLink &&
    lastContentPosition(
      { start: previousLink.end, end: position },
      html,
      index
    ) !== undefined
      ? previousLink.end
      : 0;
  const start = Math.max(
    containing.start,
    previousComment?.end ?? 0,
    afterLink,
    position - 240
  );
  const hasText = index.text.some(
    (text) =>
      Math.max(start, text.start) < Math.min(position, text.end) &&
      html
        .slice(Math.max(start, text.start), Math.min(position, text.end))
        .trim()
  );
  return hasText ? boundedText(html.slice(start, position), 240) : undefined;
}

function plainFinding(
  type: AccessibilityError["type"],
  location: FindingLocation,
  element?: string
): AccessibilityError {
  const base = presentFinding({
    type,
    severity: "warning",
    category: "source-review",
    message: "",
    suggestion: "",
    location,
    ...(element ? { element } : {}),
  });
  if (location.quote) base.message += ` Look near “${location.quote}”.`;
  return base;
}

/** Source uncertainty remains visible even when the model overlooks a marker. */
export function pdfReviewFindings(
  html: string,
  pageCount: number | null
): AccessibilityError[] {
  const findings: AccessibilityError[] = [];
  const index = indexHtml(html);
  const comments = [...html.matchAll(MARKERS)].filter((comment) =>
    index.comments.some((span) => span.start === comment.index)
  );
  const usedImageComments = new Set<number>();
  for (const image of html.matchAll(/<img\b[^>]*>/gi)) {
    if (!image[0].includes("{{PLACEHOLDER:")) continue;
    const end = image.index + image[0].length;
    const comment = comments.find(
      (comment) =>
        /^IMAGE REVIEW REQUIRED$/i.test(comment[1]) &&
        !usedImageComments.has(comment.index) &&
        ((comment.index >= end &&
          html.slice(end, comment.index).trim() === "") ||
          (comment.index + comment[0].length <= image.index &&
            html
              .slice(comment.index + comment[0].length, image.index)
              .trim() === ""))
    );
    if (comment) usedImageComments.add(comment.index);
    const location = markerLocation(comment?.[2] ?? "", pageCount);
    if (!location.locator)
      location.locator = "Image to insert in the converted page";
    findings.push(
      plainFinding("missing-image", location, image[0].slice(0, 240))
    );
  }
  for (const comment of comments) {
    if (usedImageComments.has(comment.index)) continue;
    const marker = comment[1].toUpperCase();
    const location = markerLocation(comment[2], pageCount);
    const element = nearbyElement(html, comment.index, index);
    const type: AccessibilityError["type"] = marker.startsWith("LINK TEXT")
      ? "non-descriptive-link"
      : marker.startsWith("LINK TARGET REVIEW")
        ? "bad-link"
        : marker.startsWith("LINK TARGET")
          ? "missing-link"
          : marker.startsWith("IMAGE DESCRIPTION")
            ? "missing-alt"
            : marker.startsWith("IMAGE")
              ? "missing-image"
              : marker.startsWith("HEADING")
                ? "heading-skip"
                : "other";
    const finding = plainFinding(type, location, element);
    if (marker.startsWith("SOURCE TEXT")) {
      finding.title = "Check this material against the original";
      finding.message =
        "The converter could not reliably read or preserve the meaning of this material.";
      finding.suggestion =
        "Compare the indicated material with your original document. Check any unclear words, formulas, choices, or page references, and correct the corresponding content in your Canvas page. If the source is difficult to read, upload a clearer PDF and convert it again.";
    } else if (marker.startsWith("TABLE")) {
      finding.title = "Check how this table's information belongs together";
      finding.message =
        "The converter was unsure which labels belong with some of this table's entries.";
      finding.suggestion =
        "Compare this table with the original. Check that each entry appears with the correct column or row label in your Canvas page; ask your campus accessibility support team for help if the arrangement is unclear.";
    }
    findings.push(finding);
  }
  return findings;
}

function uniqueSpan(snippet: string, html: string): HtmlSpan | undefined {
  const start = html.indexOf(snippet);
  return start >= 0 && start === html.lastIndexOf(snippet)
    ? { start, end: start + snippet.length }
    : undefined;
}

function lastContentPosition(
  span: HtmlSpan,
  html: string,
  index: HtmlIndex
): number | undefined {
  let last: number | undefined;
  for (const text of index.text) {
    const start = Math.max(span.start, text.start),
      end = Math.min(span.end, text.end);
    if (start >= end) continue;
    for (const match of html.slice(start, end).matchAll(/[\p{L}\p{N}\p{S}]/gu))
      last = start + match.index;
  }
  return last;
}

function sameOccurrence(
  a: AccessibilityError,
  b: AccessibilityError,
  html: string,
  index: HtmlIndex
): boolean {
  if (a.type !== b.type) return false;
  const placeholder = a.element?.match(/\{\{PLACEHOLDER:[^{}]+\}\}/)?.[0];
  if (
    placeholder &&
    b.element?.includes(placeholder) &&
    uniqueSpan(placeholder, html)
  )
    return true;
  if (a.element && b.element) {
    const left = uniqueSpan(a.element, html),
      right = uniqueSpan(b.element, html);
    if (left && right) {
      // Matching a quotation inside a comment or an attribute is not evidence
      // that both findings concern the same visible content. Nor is an earlier
      // reference in the same paragraph: the audit must reach the material
      // immediately before this source marker, ignoring trailing punctuation.
      const target = lastContentPosition(left, html, index);
      if (target !== undefined && right.start <= target && target < right.end)
        return true;
    }
  }
  const left = a.location,
    right = b.location;
  return !!(
    left?.sourcePages?.length &&
    right?.sourcePages?.length &&
    left.section &&
    left.locator &&
    left.quote &&
    JSON.stringify(left.sourcePages) === JSON.stringify(right.sourcePages) &&
    left.section === right.section &&
    left.locator === right.locator &&
    left.quote === right.quote
  );
}

/** Merge only unambiguous cross-stage duplicates, never merely equal messages. */
export function mergeFindings(
  source: AccessibilityError[],
  audited: AccessibilityError[],
  html: string
): AccessibilityError[] {
  const merged = [...source];
  const htmlIndex = indexHtml(html);
  const matched = new Set<number>();
  for (const finding of audited) {
    const candidates = source
      .map((item, index) =>
        sameOccurrence(item, finding, html, htmlIndex) ? index : -1
      )
      .filter((index) => index >= 0);
    if (candidates.length === 1 && !matched.has(candidates[0])) {
      const index = candidates[0];
      matched.add(index);
      merged[index] = {
        ...source[index],
        ...finding,
        title: finding.title ?? source[index].title,
        location: finding.location ?? source[index].location,
      };
    } else {
      merged.push(finding);
    }
  }
  return merged;
}
