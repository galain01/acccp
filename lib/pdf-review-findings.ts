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

function nearbyElement(html: string, position: number): string | undefined {
  // Prefer the nearest complete small element; never evaluate source HTML.
  const before = html.slice(Math.max(0, position - 4000), position);
  const elements = [
    ...before.matchAll(
      /<(a|h[2-6]|p|li|th|td)\b[^>]*>[\s\S]*?<\/\1\s*>|<img\b[^>]*>/gi
    ),
  ];
  const last = elements.at(-1);
  return last ? boundedText(last[0], 240) : undefined;
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
  const comments = [...html.matchAll(MARKERS)];
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
    const element = nearbyElement(html, comment.index);
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

function normalized(html: string): string {
  return html.replace(/>\s+</g, "><").replace(/\s+/g, " ").trim();
}

function sameOccurrence(
  a: AccessibilityError,
  b: AccessibilityError,
  html: string
): boolean {
  if (a.type !== b.type) return false;
  const placeholder = a.element?.match(/\{\{PLACEHOLDER:[^{}]+\}\}/)?.[0];
  if (
    placeholder &&
    b.element?.includes(placeholder) &&
    html.indexOf(placeholder) === html.lastIndexOf(placeholder)
  )
    return true;
  if (a.element && b.element) {
    const left = normalized(a.element),
      right = normalized(b.element),
      full = normalized(html);
    if (
      left === right &&
      full.indexOf(left) >= 0 &&
      full.indexOf(left) === full.lastIndexOf(left)
    )
      return true;
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
  const matched = new Set<number>();
  for (const finding of audited) {
    const candidates = source
      .map((item, index) =>
        !matched.has(index) && sameOccurrence(item, finding, html) ? index : -1
      )
      .filter((index) => index >= 0);
    if (candidates.length === 1) {
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
