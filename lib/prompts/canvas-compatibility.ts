/**
 * Shared prompt guidance, not a sanitizer or a guarantee of Canvas rendering.
 * Checked against Instructure's HTML Editor Allowlist on 2026-09-23.
 * Keep both model stages on the same documented compatibility rules.
 */
export const CANVAS_COMPATIBILITY_PROMPT = `
## Canvas HTML compatibility

Reference: Canvas HTML Editor Allowlist, checked 2026-09-23:
https://community.instructure.com/en/kb/articles/387066-unknown
The relevant rules are included here; do not browse the reference. Canvas filters HTML when it is saved. HTML that works in a browser can lose markup or formatting in Canvas. Use these rules for the generated fragment and any recommended changes.

### Elements and attributes

- This application uses a conservative subset of Canvas-supported HTML: a, abbr, blockquote, br, caption, code, col, colgroup, dd, div, dl, dt, em, figcaption, figure, h2, h3, h4, h5, h6, hr, img, li, ol, p, pre, section, span, strong, sub, sup, table, tbody, td, tfoot, th, thead, tr, ul. This is the application's output policy, not Canvas's entire allowlist. Canvas also permits h1 and MathML; this app reserves h1 for the Canvas title. Preserve formulas with faithful legible text, sub and sup where sufficient; if this subset cannot express a formula faithfully, retain its legible content and request located source review rather than substituting an approximation.
- Canvas permits these global attributes: style, class, id, title, role, lang, dir, aria-*, data-*. Prefer native semantics; ARIA must not replace visible source content or correct table structure. Use unique, descriptive IDs with a document-specific prefix; avoid browser-reserved IDs such as body and length. Do not depend on external stylesheets, theme-specific classes, scripts, or data attributes to supply visible information or behavior.
- Use element-specific attributes only on the appropriate element: a: href, target, name, rel, download; abbr: title; blockquote: cite; col/colgroup: span, width; img: align, alt, height, src, title, usemap, width, srcset, loading, decoding; ol: start, type, reversed; table: summary, width, border, cellpadding, cellspacing, frame; tr: align, valign, dir; td: abbr, axis, colspan, rowspan, width, align, valign, dir; th: abbr, colspan, rowspan, width, align, valign, dir, scope; ul: type. Prefer modern semantic markup and minimal inline styles over presentational attributes.
- The published list does not include headers on table cells or value on li. Do not rely on them. Use th scope="col", "row", "colgroup", or "rowgroup" only when the actual column/row grouping supports that association. Preserve complex relationships with faithfully structured simpler tables or label-value groups; if that cannot be done without changing meaning, preserve the content and request a located table review. Continue or restart list numbering with ol start (and type/reversed when supported by the source); split into separate ol runs for numbering jumps rather than using li value or dropping numbers.
- Canvas renames data-url, data-method, data-remote, data-remove, data-confirm, and data-disable-with to data-custom-* names. Do not depend on those names for behavior. The application's data-source-image-id and audit-only data-audit-heading-id are permitted data attributes and are not part of that rename list.
- Do not generate html/head/body wrappers, script/style/link elements, event handlers, SVG, canvas, forms, form controls, custom widgets, or embedded media. Canvas Pages remove object and embed even though the general allowlist lists them. Preserve source code examples as escaped text in pre/code; literal example text is not active markup and should not be removed.

### Inline CSS

Use the style attribute only, with these documented property names or the valid CSS longhands of a listed shorthand:
- Layout: clear, display, float, overflow, overflow-x, overflow-y, position, visibility, z-index, zoom.
- Offsets and size: bottom, left, right, top, aspect-ratio, box-sizing, height, max-height, max-width, min-height, min-width, object-fit, object-position, resize, width.
- Spacing: column-gap, gap, margin, padding, row-gap.
- Text: color, direction, font, font-feature-settings, font-kerning, font-optical-sizing, font-variant-caps, font-variant-ligatures, font-variant-numeric, letter-spacing, line-height, text-align, text-align-last, text-decoration, text-indent, text-shadow, text-transform, text-underline-offset, unicode-bidi, vertical-align, word-spacing.
- Text flow: hyphens, line-break, overflow-wrap, tab-size, text-combine-upright, text-orientation, text-overflow, white-space, word-break, word-wrap, writing-mode.
- Borders and background: background, border, border-collapse, border-radius, border-spacing, box-shadow, outline, outline-offset.
- Lists and tables: caption-side, empty-cells, list-style, table-layout.
- Flexbox and grid: align-content, align-items, align-self, flex, grid, justify-content, justify-items, justify-self, order, place-content, place-items, place-self.
- Multi-column: column-count, column-fill, column-rule, column-span, column-width, columns.
- Motion: animation, transform, transition.
- Printing: break-after, break-before, break-inside, page-break-after, page-break-before, page-break-inside.
- Generated content: content, counter-increment, counter-reset, quotes.
- Interaction: accent-color, appearance, caret-color, cursor, opacity, pointer-events, user-select.

For example, font-family/font-size/font-weight, margin-top, padding-left, border-color/border-width/border-top-style, and background-color/background-size are valid longhands. Do not use unlisted vendor properties such as -webkit-overflow-scrolling, CSS custom properties, stylesheet rules, or media queries. position permits static, relative, absolute and the reset keywords initial, inherit, unset, revert, revert-layer; fixed and sticky are removed by Canvas. Prefer ordinary document flow; do not reproduce PDF coordinates with positioned text.

Being allowed does not make a style appropriate or accessible. Keep the single-column layout, minimal styling and reflow requirements; do not hide source content, disable interaction, add animation, or rely on CSS generated content to convey essential wording, numbering or relationships. Existing responsive patterns are compatible: max-width:900px; margin:auto on the wrapper, max-width:100%; height:auto on images, overflow-x:auto on table wrappers, and white-space:pre-wrap; overflow-wrap:anywhere on preformatted content.

### Destinations and application placeholders

- Canvas documents these URL schemes: https:, http:, ftp:, mailto:, tel:. Never output javascript:, vbscript:, data:, blob:, file:, or another unlisted scheme as an active destination. Preserve an unsupported source destination as inert visible text with a located link-review comment rather than silently changing it or inventing a replacement. Preserve supported source targets exactly; do not invent Canvas file IDs or course URLs. A source-supported relative URL or same-document fragment must still point to the intended resource or an ID preserved in the output; flag an unresolved target for review.
- For an existing target="_blank" link use rel="noopener". Canvas adds noopener on save as well.
- The required {{PLACEHOLDER:imageN.png}} image sources are application markers awaiting manual image insertion, not uploaded images or supported permanent URLs. Keep their alt text, data-source-image-id when reliably matched, and the required insertion review. Do not remove these markers or add a duplicate Canvas/unsafe-URL finding solely because they are placeholders. Review comments are parsed by this application before Canvas; essential teaching content must remain visible even if Canvas discards comments.
`;
