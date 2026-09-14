import { parseFragment, type DefaultTreeAdapterTypes } from "parse5";

/**
 * Prettier can split inline closing tags across lines. Compact those tags for
 * Canvas without reserializing the document or changing meaningful whitespace.
 * Parser offsets distinguish actual tags from comments, attributes and examples.
 * This only normalizes tag syntax; it does not repair or sanitize HTML.
 */
export function normalizeCanvasClosingTags(html: string): string {
  const fragment = parseFragment(html, { sourceCodeLocationInfo: true });
  const pending: DefaultTreeAdapterTypes.Node[] = [fragment];
  const edits = new Map<number, { end: number; value: string }>();

  while (pending.length) {
    const node = pending.pop()!;
    if ("tagName" in node) {
      const endTag = node.sourceCodeLocation?.endTag;
      if (endTag) {
        const raw = html.slice(endTag.startOffset, endTag.endOffset);
        const match = /^(<\/[a-zA-Z][a-zA-Z0-9:-]*)[\t\n\f\r ]+>$/.exec(raw);
        if (match) {
          edits.set(endTag.startOffset, {
            end: endTag.endOffset,
            value: `${match[1]}>`,
          });
        }
      }
      if ("content" in node) pending.push(node.content);
    }
    if ("childNodes" in node) {
      for (const child of node.childNodes) pending.push(child);
    }
  }

  if (!edits.size) return html;
  const parts: string[] = [];
  let cursor = 0;
  for (const [start, edit] of [...edits].sort(([a], [b]) => a - b)) {
    parts.push(html.slice(cursor, start), edit.value);
    cursor = edit.end;
  }
  parts.push(html.slice(cursor));
  return parts.join("");
}
