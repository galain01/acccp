import { parseFragment, type DefaultTreeAdapterTypes } from "parse5";

export interface HtmlHeading {
  /** Request-local inventory ID; never inserted into the faculty's HTML. */
  id: string;
  text: string;
  level: number;
  parentId: string | null;
  /** An exact excerpt from the original HTML, not reconstructed markup. */
  element: string;
}

export interface HtmlHeadingInventory {
  headings: HtmlHeading[];
  complete: boolean;
}

export const MAX_AUDIT_HEADINGS = 500;
const MAX_AUDIT_HTML_LENGTH = 2 * 1024 * 1024;
const HTML_NAMESPACE = "http://www.w3.org/1999/xhtml";
type Node = DefaultTreeAdapterTypes.Node;

/** Whitespace normalization only: do not erase meaningful case or punctuation. */
export function headingText(text: string): string {
  return text.normalize("NFC").replace(/\s+/gu, " ").trim();
}

function excluded(node: Node): boolean {
  if (!("tagName" in node)) return false;
  if (node.namespaceURI !== HTML_NAMESPACE) return true;
  if (["script", "style", "template", "noscript"].includes(node.tagName))
    return true;
  return node.attrs.some(
    ({ name, value }) =>
      name === "hidden" ||
      (name === "aria-hidden" && value.trim().toLowerCase() === "true") ||
      (name === "style" &&
        /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)\s*(?:!important\s*)?(?:;|$)/i.test(
          value
        ))
  );
}

function textContent(root: Node): string {
  const text: string[] = [];
  const pending = [root];
  while (pending.length) {
    const node = pending.pop()!;
    if (excluded(node)) continue;
    if ("value" in node && node.nodeName === "#text") text.push(node.value);
    else if ("tagName" in node && node.tagName === "br") text.push(" ");
    else if ("childNodes" in node)
      pending.push(...[...node.childNodes].reverse());
  }
  return headingText(text.join(""));
}

/**
 * Use an inert HTML parser so comments, scripts, escaped examples and malformed
 * markup are interpreted as HTML rather than mistaken for heading tags by regex.
 * This is a structural inventory, not a rendered visibility or screen-reader test.
 */
export function extractHtmlHeadings(html: string): HtmlHeadingInventory {
  if (html.length > MAX_AUDIT_HTML_LENGTH)
    return { headings: [], complete: false };
  const headings: HtmlHeading[] = [];
  const parents: HtmlHeading[] = [];
  const fragment = parseFragment(html, { sourceCodeLocationInfo: true });
  const pending: Node[] = [...fragment.childNodes].reverse();
  let complete = true;
  while (pending.length) {
    const node = pending.pop()!;
    if (excluded(node)) continue;
    if ("tagName" in node && /^h[1-6]$/.test(node.tagName)) {
      if (headings.length >= MAX_AUDIT_HEADINGS) {
        complete = false;
        break;
      }
      const level = Number(node.tagName[1]);
      while (parents.length && parents[parents.length - 1].level >= level)
        parents.pop();
      const location = node.sourceCodeLocation;
      const text = textContent(node);
      if (!location || text.length > 500) complete = false;
      const heading: HtmlHeading = {
        id: `h${headings.length + 1}`,
        text: text.slice(0, 500),
        level,
        parentId: parents[parents.length - 1]?.id ?? null,
        element: location
          ? html.slice(location.startOffset, location.endOffset).slice(0, 240)
          : "",
      };
      headings.push(heading);
      parents.push(heading);
    }
    if ("childNodes" in node) pending.push(...[...node.childNodes].reverse());
  }
  return { headings, complete };
}

/**
 * Hide output heading ranks from the source-outline model to prevent anchoring.
 * Keep the original HTML for the comparison, download, and exact evidence.
 * This also withholds converter comments, which are not independent source evidence.
 */
export function prepareHeadingAuditHtml(html: string): string {
  return prepareHeadingAuditDocument(html).html;
}

export interface HeadingAuditDocument {
  html: string;
  /** Recover evidence only through a unique exact match in the supplied HTML. */
  restoreExcerpt(excerpt: unknown): string | undefined;
}

export function prepareHeadingAuditDocument(
  html: string
): HeadingAuditDocument {
  if (html.length > MAX_AUDIT_HTML_LENGTH)
    return { html: "", restoreExcerpt: () => undefined };
  const fragment = parseFragment(html, { sourceCodeLocationInfo: true });
  const edits: Array<{
    start: number;
    end: number;
    value: string;
    close?: boolean;
  }> = [];
  const pending: Array<{ node: Node; outsideInventory: boolean }> = [
    ...fragment.childNodes,
  ]
    .reverse()
    .map((node) => ({ node, outsideInventory: false }));
  let headingNumber = 0;
  while (pending.length) {
    const { node, outsideInventory } = pending.pop()!;
    const location = node.sourceCodeLocation;
    if (node.nodeName === "#comment" && location)
      edits.push({
        start: location.startOffset,
        end: location.endOffset,
        value: "",
      });
    const excludedHeading = outsideInventory || excluded(node);
    if (
      "tagName" in node &&
      /^h[1-6]$/.test(node.tagName) &&
      location &&
      "startTag" in location &&
      location.startTag
    ) {
      if (!excludedHeading) headingNumber++;
      // Keep non-heading content in hidden/SVG/template subtrees available for
      // other audit checks, but never expose their heading ranks or notes.
      const visibility = node.attrs.some(
        ({ name, value }) =>
          name === "hidden" ||
          (name === "style" &&
            /(?:display\s*:\s*none|visibility\s*:\s*hidden)/i.test(value))
      )
        ? " hidden"
        : node.attrs.some(
              ({ name, value }) =>
                name === "aria-hidden" && value.trim().toLowerCase() === "true"
            )
          ? ' aria-hidden="true"'
          : "";
      edits.push({
        start: location.startTag.startOffset,
        end: location.startTag.endOffset,
        value: excludedHeading
          ? `<div${visibility}>`
          : `<div data-audit-heading-id="h${headingNumber}">`,
      });
      edits.push({
        start: location.endTag?.startOffset ?? location.endOffset,
        end: location.endTag?.endOffset ?? location.endOffset,
        value: "</div>",
        close: true,
      });
    }
    const children =
      "content" in node
        ? node.content.childNodes
        : "childNodes" in node
          ? node.childNodes
          : [];
    pending.push(
      ...[...children]
        .reverse()
        .map((child) => ({ node: child, outsideInventory: excludedHeading }))
    );
  }
  // Build a source map while applying edits. At a shared boundary an inserted
  // close precedes the next opening tag, including implicitly closed headings.
  edits.sort(
    (a, b) =>
      a.start - b.start || Number(b.close ?? false) - Number(a.close ?? false)
  );
  const segments: Array<{
    start: number;
    end: number;
    originalStart: number;
    originalEnd: number;
    unchanged: boolean;
  }> = [];
  const parts: string[] = [];
  let originalOffset = 0;
  let maskedOffset = 0;
  const append = (
    value: string,
    start: number,
    end: number,
    unchanged: boolean
  ) => {
    if (!value) return;
    parts.push(value);
    segments.push({
      start: maskedOffset,
      end: maskedOffset + value.length,
      originalStart: start,
      originalEnd: end,
      unchanged,
    });
    maskedOffset += value.length;
  };
  for (const edit of edits) {
    append(
      html.slice(originalOffset, edit.start),
      originalOffset,
      edit.start,
      true
    );
    append(edit.value, edit.start, edit.end, false);
    originalOffset = edit.end;
  }
  append(html.slice(originalOffset), originalOffset, html.length, true);
  const masked = parts.join("");
  return {
    html: masked,
    restoreExcerpt(excerpt) {
      if (typeof excerpt !== "string" || !excerpt.trim()) return undefined;
      const exact = excerpt.trim().slice(0, 240);
      const start = masked.indexOf(exact);
      // Repeated text is not an occurrence identifier. Never choose its first
      // occurrence or merge separate source references on the basis of wording.
      if (start < 0 || start !== masked.lastIndexOf(exact)) return undefined;
      const end = start + exact.length;
      const first = segments.find((segment) => segment.end > start);
      const last = segments.findLast((segment) => segment.start < end);
      if (!first || !last) return undefined;
      const originalStart = first.unchanged
        ? first.originalStart + start - first.start
        : first.originalStart;
      const originalEnd = last.unchanged
        ? last.originalStart + end - last.start
        : last.originalEnd;
      return (
        html.slice(originalStart, originalEnd).trim().slice(0, 240) || undefined
      );
    },
  };
}
