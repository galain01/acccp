import { parseFragment, serialize } from "parse5";
import { format } from "prettier";
import { describe, expect, it } from "vitest";
import { normalizeCanvasClosingTags } from "@/lib/canvas-html";

function checkPreserved(input: string, expected?: string) {
  const output = normalizeCanvasClosingTags(input);
  if (expected !== undefined) expect(output).toBe(expected);
  // Compare the complete parsed tree, including whitespace text, attributes,
  // entities, and template contents; the production helper must not reserialize.
  expect(serialize(parseFragment(output))).toBe(
    serialize(parseFragment(input))
  );
  expect(normalizeCanvasClosingTags(output)).toBe(output);
  return output;
}

describe("Canvas closing-tag compatibility", () => {
  it("compacts real default-Prettier long link and emphasis closings without changing their DOM", async () => {
    const href = `https://example.test/resources/${"synthetic-reference-".repeat(6)}?view=full&amp;lang=en`;
    const input = `<section><p><a href="${href}" style="color: #123456; text-decoration: underline;">${href}</a>, <em>${"Synthetic emphasized instructional text ".repeat(7).trim()}</em>; then <strong>continue</strong>.</p></section>`;
    const formatted = await format(input, { parser: "html" });
    expect(formatted).toMatch(/<\/a\s+>/);
    expect(formatted).toMatch(/<\/em\s+>/);

    const output = checkPreserved(formatted);
    expect(output).not.toMatch(/<\/(?:a|em)\s+>/);
    expect(output).toContain(`href="${href}"`);
    expect(output).toContain(`>${href}</a>,`);
    expect(output).toContain(
      'style="color: #123456; text-decoration: underline"'
    );
    expect(output).toContain("</em>; then <strong>continue</strong>.");
  });

  it("preserves punctuation and every character of spacing outside the closing tags", () => {
    checkPreserved(
      '<p>Before <a href="https://example.test/">one</a\n  >,<em>two</em\t >; \n  <strong>three</strong\r\n>!\t After</p\n>\r\n',
      '<p>Before <a href="https://example.test/">one</a>,<em>two</em>; \n  <strong>three</strong>!\t After</p>\r\n'
    );
  });

  it("handles block, inline, and custom element names and preserves source tag casing", () => {
    checkPreserved(
      "<SECTION><H2>Title</H2\t><div><span>Text</span\f ><custom-note>Note</custom-note\r\n ></div  ></SECTION\n>",
      "<SECTION><H2>Title</H2><div><span>Text</span><custom-note>Note</custom-note></div></SECTION>"
    );
  });

  it("leaves already compact HTML, empty input, and plain text byte-for-byte unchanged", () => {
    for (const input of [
      "",
      "Plain text &amp; punctuation.\n",
      "<p class='sample'>An <em>example</em>.</p>\n",
    ]) {
      checkPreserved(input, input);
    }
  });

  it("preserves escaped code examples, entity spelling, and preformatted whitespace", () => {
    const content = "  &lt;/a\n  &gt;\t&amp; &#x1F680;\n    &lt;/em &gt;  ";
    checkPreserved(
      `<pre><code>${content}</code\n  ></pre\n><p>A&nbsp;&amp;&#32;B</p\t>`,
      `<pre><code>${content}</code></pre><p>A&nbsp;&amp;&#32;B</p>`
    );
  });

  it("does not touch closing-tag lookalikes in comments or quoted attributes", () => {
    const prefix =
      "<!-- literal </a\n > and </em\t> -->\n<p data-example=\"</a\n >\" title='</em\t >'>";
    checkPreserved(
      `${prefix}<em>Actual text</em\n ></p\n >`,
      `${prefix}<em>Actual text</em></p>`
    );
  });

  it("preserves raw text and textarea/title lookalikes while fixing their actual closing tags", () => {
    const script = 'const sample = "</a\n >"; const emphasis = "</em\t >";';
    const style = '.sample::before { content: "</a\n >"; }';
    const textarea = "literal </a\n > and &lt;/em &gt;";
    checkPreserved(
      `<script>${script}</script\n ><style>${style}</style\t><textarea>${textarea}</textarea\n><title>literal </em\n ></title\n>`,
      `<script>${script}</script><style>${style}</style><textarea>${textarea}</textarea><title>literal </em\n ></title>`
    );
  });

  it("normalizes nested template children at correct UTF-16 offsets after emoji", () => {
    checkPreserved(
      '🚀<template><p>🧭<a href="https://example.test/?x=1&amp;y=2">Go</a\n ></p\n><template><em>🌱</em\t></template\n></template\n>✨',
      '🚀<template><p>🧭<a href="https://example.test/?x=1&amp;y=2">Go</a></p><template><em>🌱</em></template></template>✨'
    );
  });

  it("does not invent implicit table or list tags or repair unrelated incomplete markup", () => {
    checkPreserved(
      "<table><tr><td>First</td\n></tr\n></table\n><ul><li>One<li>Two</ul\n><p>Unclosed",
      "<table><tr><td>First</td></tr></table><ul><li>One<li>Two</ul><p>Unclosed"
    );
  });
});
