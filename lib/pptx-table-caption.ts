import { createHash } from "node:crypto";
import type { Document, Element, Node } from "@xmldom/xmldom";
import type { PptxRect, PptxSlideRepairs } from "./pptx-types";

const P = "http://schemas.openxmlformats.org/presentationml/2006/main";
const A = "http://schemas.openxmlformats.org/drawingml/2006/main";
const XMLNS = "http://www.w3.org/2000/xmlns/";
const POINT = 12700;
const PADDING = 3 * POINT;
const children = (node: Node): Element[] =>
  Array.from(node.childNodes).filter(
    (child): child is Element => child.nodeType === 1
  );
const direct = (node: Node, ns: string, name: string) =>
  children(node).find(
    (child) => child.namespaceURI === ns && child.localName === name
  );
const all = (node: Element, ns: string, name: string) =>
  Array.from(node.getElementsByTagNameNS(ns, name));

/** Namespace declaration placement is immaterial; all actual attributes/content count. */
export function pptxElementHash(node: Node): string {
  const canonical = (n: Node): unknown =>
    n.nodeType === 1
      ? [
          n.namespaceURI,
          n.localName,
          Array.from((n as Element).attributes)
            .filter((a) => a.namespaceURI !== XMLNS)
            .map((a) => [a.namespaceURI ?? "", a.localName, a.value])
            .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
          Array.from(n.childNodes).map(canonical),
        ]
      : [n.nodeType, n.nodeName, n.nodeValue];
  return createHash("sha256")
    .update(JSON.stringify(canonical(node)))
    .digest("hex");
}

export interface TableCaptionPatch {
  caption: Element;
  table: Element;
  captionId: string;
  captionText: string;
  tableId: string;
  tableHash: string;
  captionHash: string;
  visualRegion: PptxRect;
}

function numberAttribute(element: Element, name: string): number | null {
  const value = element.getAttribute(name);
  if (value === null || !/^\d+$/.test(value)) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : null;
}

function solidRgb(parent: Element): Element | undefined {
  const fill = direct(parent, A, "solidFill");
  const color = fill && direct(fill, A, "srgbClr");
  return fill &&
    color &&
    children(fill).length === 1 &&
    children(color).length === 0 &&
    /^[0-9a-f]{6}$/i.test(color.getAttribute("val") ?? "")
    ? fill
    : undefined;
}

function textWidthBound(text: string, fontPoints: number): number {
  // Conservative for a plain, single-line label; wide/non-Latin characters use
  // a full em. Never shrink text to make this operation pass.
  return (
    Array.from(text).reduce(
      (sum, char) =>
        sum +
        (/[\s.,:;!|'ilItfj]/.test(char)
          ? 0.4
          : /[\x20-\x7e]/.test(char) && !/[MW@%]/.test(char)
            ? 0.8
            : 1.15),
      0
    ) *
    fontPoints *
    POINT
  );
}

/** Builds a replacement only for one plain, full-width caption above two columns. */
export function buildTableCaptionPatch(
  document: Document,
  original: Element,
  rect: PptxRect,
  repair: NonNullable<PptxSlideRepairs["splitTableCaption"]>[number],
  captionId: string
): TableCaptionPatch | null {
  const table = all(original, A, "tbl")[0];
  if (!table || all(original, A, "tbl").length !== 1) return null;
  const rows = children(table).filter(
    (e) => e.namespaceURI === A && e.localName === "tr"
  );
  const grid = direct(table, A, "tblGrid");
  const columns = grid && children(grid);
  if (
    !columns ||
    columns.length !== 2 ||
    rows.length < 2 ||
    rows.length > 30 ||
    repair.headerTexts.length !== 2
  )
    return null;
  const widths = columns.map((c) => numberAttribute(c, "w"));
  const heights = rows.map((r) => numberAttribute(r, "h"));
  if (
    widths.some((w) => w === null || w <= 0) ||
    heights.some((h) => h === null || h <= 0) ||
    widths.reduce<number>((sum, w) => sum + (w ?? 0), 0) !== rect.width ||
    heights.reduce<number>((sum, h) => sum + (h ?? 0), 0) !== rect.height
  )
    return null;
  const cells = rows.map((row) =>
    children(row).filter((e) => e.namespaceURI === A && e.localName === "tc")
  );
  if (cells.some((row) => row.length !== 2)) return null;
  const captionCell = cells[0][0],
    continuation = cells[0][1];
  const merged = (cell: Element) =>
    ["gridSpan", "rowSpan", "hMerge", "vMerge"].some((a) =>
      cell.hasAttribute(a)
    );
  if (
    captionCell.getAttribute("gridSpan") !== "2" ||
    ["rowSpan", "hMerge", "vMerge"].some((a) => captionCell.hasAttribute(a)) ||
    !["1", "true"].includes(continuation.getAttribute("hMerge") ?? "") ||
    ["gridSpan", "rowSpan", "vMerge"].some((a) =>
      continuation.hasAttribute(a)
    ) ||
    cells.slice(1).flat().some(merged)
  )
    return null;
  const cellText = (cell: Element) =>
    all(cell, A, "p")
      .map((p) =>
        all(p, A, "t")
          .map((t) => t.textContent ?? "")
          .join("")
      )
      .join("\n");
  if (
    JSON.stringify(cells.map((row) => row.map(cellText))) !==
      JSON.stringify(repair.sourceCells) ||
    cellText(captionCell) !== repair.captionText ||
    cellText(continuation).trim() ||
    /[\r\n\t]/.test(repair.captionText) ||
    repair.headerTexts.some((s) => /[\r\n\t]/.test(s))
  )
    return null;
  const txBody = direct(captionCell, A, "txBody");
  const paragraphs =
    txBody &&
    children(txBody).filter((e) => e.namespaceURI === A && e.localName === "p");
  if (!txBody || paragraphs?.length !== 1) return null;
  const captionParagraphProperties = direct(paragraphs[0], A, "pPr");
  const captionAlignment =
    captionParagraphProperties?.getAttribute("algn") ?? "l";
  if (
    !["l", "ctr", "r"].includes(captionAlignment) ||
    (captionParagraphProperties &&
      (children(captionParagraphProperties).length ||
        Array.from(captionParagraphProperties.attributes).some(
          (attribute) =>
            attribute.namespaceURI !== XMLNS && attribute.name !== "algn"
        )))
  )
    return null;
  const allowedCaptionElements = new Set([
    "tr",
    "tc",
    "txBody",
    "bodyPr",
    "lstStyle",
    "p",
    "pPr",
    "r",
    "rPr",
    "t",
    "tcPr",
    "solidFill",
    "srgbClr",
    "latin",
    "ea",
    "cs",
  ]);
  if (
    Array.from(rows[0].getElementsByTagName("*")).some(
      (element) =>
        element.namespaceURI !== A ||
        !allowedCaptionElements.has(element.localName ?? "") ||
        Array.from(element.attributes).some(
          (attribute) =>
            attribute.namespaceURI && attribute.namespaceURI !== XMLNS
        )
    )
  )
    return null;
  const runs = children(paragraphs[0]).filter(
    (e) => e.namespaceURI === A && e.localName === "r"
  );
  const rPr = runs.length === 1 && direct(runs[0], A, "rPr");
  if (
    !rPr ||
    all(paragraphs[0], A, "t").length !== 1 ||
    all(txBody, A, "br").length ||
    all(txBody, A, "fld").length ||
    children(rPr).some(
      (e) =>
        e.namespaceURI !== A ||
        !["solidFill", "latin", "ea", "cs"].includes(e.localName ?? "")
    )
  )
    return null;
  const size = numberAttribute(rPr, "sz");
  const latin = direct(rPr, A, "latin")?.getAttribute("typeface");
  const color = solidRgb(rPr);
  const tcPr = direct(captionCell, A, "tcPr");
  const fill = tcPr && solidRgb(tcPr);
  if (
    !size ||
    !latin ||
    latin.startsWith("+") ||
    !color ||
    !tcPr ||
    !fill ||
    children(tcPr).some(
      (e) => e.namespaceURI !== A || e.localName !== "solidFill"
    ) ||
    ["spc", "baseline", "cap", "vert"].some((a) => rPr.hasAttribute(a))
  )
    return null;
  const margins = ["marL", "marR"].map(
    (a) => numberAttribute(tcPr, a) ?? 91440
  );
  const firstHeight = heights[0]!;
  // 360 EMUs is 0.01 mm, the layout precision used by LibreOffice. Translating
  // the frame and shortening its first row by the same whole unit preserves
  // the renderer's original rounding of every body-row position and border.
  const captionHeight = Math.floor(firstHeight / 2 / 360) * 360;
  const headerHeight = firstHeight - captionHeight;
  const fontPoints = size / 100;
  if (
    fontPoints * POINT * 1.25 + 2 * PADDING >
      Math.min(captionHeight, headerHeight) ||
    textWidthBound(repair.captionText, fontPoints) >
      rect.width - margins[0] - margins[1] ||
    repair.headerTexts.some(
      (text, i) =>
        textWidthBound(text, fontPoints) > widths[i]! - margins[0] - margins[1]
    )
  )
    return null;
  const make = (
    ns: string,
    name: string,
    attrs: Record<string, string> = {}
  ) => {
    const node = document.createElementNS(ns, name);
    for (const [key, value] of Object.entries(attrs))
      node.setAttribute(key, value);
    return node;
  };
  const paragraph = (text: string, isCaption: boolean) => {
    const p = make(A, "a:p"),
      pPr = make(A, "a:pPr", { algn: isCaption ? captionAlignment : "l" });
    const line = make(A, "a:lnSpc"),
      pct = make(A, "a:spcPct", { val: "100000" });
    line.appendChild(pct);
    pPr.appendChild(line);
    p.appendChild(pPr);
    const r = make(A, "a:r"),
      t = make(A, "a:t");
    r.appendChild(document.importNode(rPr, true));
    t.appendChild(document.createTextNode(text));
    r.appendChild(t);
    p.appendChild(r);
    return p;
  };
  const body = (isCaption: boolean, text: string) => {
    const b = make(isCaption ? P : A, isCaption ? "p:txBody" : "a:txBody");
    const props = make(
      A,
      "a:bodyPr",
      isCaption
        ? {
            lIns: String(margins[0]),
            rIns: String(margins[1]),
            tIns: String(PADDING),
            bIns: String(PADDING),
            wrap: "none",
            anchor: "ctr",
          }
        : { wrap: "none", anchor: "ctr" }
    );
    props.appendChild(make(A, "a:noAutofit"));
    b.appendChild(props);
    b.appendChild(make(A, "a:lstStyle"));
    b.appendChild(paragraph(text, isCaption));
    return b;
  };
  const caption = make(P, "p:sp");
  const nv = make(P, "p:nvSpPr");
  nv.appendChild(make(P, "p:cNvPr", { id: captionId, name: "Table caption" }));
  nv.appendChild(make(P, "p:cNvSpPr", { txBox: "1" }));
  nv.appendChild(make(P, "p:nvPr"));
  caption.appendChild(nv);
  const spPr = make(P, "p:spPr"),
    transform = make(A, "a:xfrm");
  transform.appendChild(
    make(A, "a:off", { x: String(rect.x), y: String(rect.y) })
  );
  transform.appendChild(
    make(A, "a:ext", { cx: String(rect.width), cy: String(captionHeight) })
  );
  spPr.appendChild(transform);
  const geometry = make(A, "a:prstGeom", { prst: "rect" });
  geometry.appendChild(make(A, "a:avLst"));
  spPr.appendChild(geometry);
  spPr.appendChild(document.importNode(fill, true));
  const line = make(A, "a:ln");
  line.appendChild(make(A, "a:noFill"));
  spPr.appendChild(line);
  caption.appendChild(spPr);
  caption.appendChild(body(true, repair.captionText));
  const replacement = original.cloneNode(true) as Element;
  const replacementTable = all(replacement, A, "tbl")[0];
  const replacementRows = children(replacementTable).filter(
    (e) => e.namespaceURI === A && e.localName === "tr"
  );
  const header = make(A, "a:tr", { h: String(headerHeight) });
  for (const label of repair.headerTexts) {
    const cell = make(A, "a:tc");
    cell.appendChild(body(false, label));
    const props = document.importNode(tcPr, true) as Element;
    props.setAttribute("marT", String(PADDING));
    props.setAttribute("marB", String(PADDING));
    props.setAttribute("anchor", "ctr");
    cell.appendChild(props);
    header.appendChild(cell);
  }
  replacementTable.replaceChild(header, replacementRows[0]);
  let tableProps = direct(replacementTable, A, "tblPr");
  if (!tableProps) {
    tableProps = make(A, "a:tblPr");
    replacementTable.insertBefore(tableProps, replacementTable.firstChild);
  }
  tableProps.setAttribute("firstRow", "1");
  const xfrm = direct(replacement, P, "xfrm");
  if (!xfrm) return null;
  direct(xfrm, A, "off")!.setAttribute("y", String(rect.y + captionHeight));
  direct(xfrm, A, "ext")!.setAttribute(
    "cy",
    String(rect.height - captionHeight)
  );
  // Body rows are copied whole, including all text, formats, cell settings and links.
  if (
    rows
      .slice(1)
      .some(
        (row, i) =>
          pptxElementHash(row) !== pptxElementHash(replacementRows[i + 1])
      )
  )
    return null;
  return {
    caption,
    table: replacement,
    captionId,
    captionText: repair.captionText,
    tableId: repair.objectId,
    captionHash: pptxElementHash(caption),
    tableHash: pptxElementHash(replacement),
    visualRegion: { ...rect, height: firstHeight },
  };
}
