import { createHash } from "node:crypto";
import path from "node:path";
import type { Readable } from "node:stream";
import {
  DOMParser,
  XMLSerializer,
  type Document,
  type Element,
  type Node,
} from "@xmldom/xmldom";
import { SaxesParser } from "saxes";
import { fromBufferPromise } from "yauzl";
import { ZipFile } from "yazl";
import {
  MAX_DOCX_OUTPUT_SIZE_BYTES,
  MAX_FILE_SIZE_BYTES,
} from "./document-input";
import type {
  DocxChange,
  DocxFinding,
  DocxImage,
  DocxInspection,
  DocxListCandidate,
  DocxParagraph,
  DocxRepairPlan,
  DocxRepairResult,
  DocxTable,
} from "./docx-types";
export type * from "./docx-types";

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const WP =
  "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing";
const A = "http://schemas.openxmlformats.org/drawingml/2006/main";
const REL = "http://schemas.openxmlformats.org/package/2006/relationships";
const CT = "http://schemas.openxmlformats.org/package/2006/content-types";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const MC = "http://schemas.openxmlformats.org/markup-compatibility/2006";
const DECORATIVE =
  "http://schemas.microsoft.com/office/drawing/2017/decorative";
const DECORATIVE_EXTENSION = "{C183D7F6-B498-43B3-948B-1728B52AA6E4}";
const MAIN_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml";
const LIMITS = {
  input: MAX_FILE_SIZE_BYTES,
  output: MAX_DOCX_OUTPUT_SIZE_BYTES,
  entries: 2000,
  inflated: 64 * 1024 * 1024,
  part: 16 * 1024 * 1024,
  xml: 4 * 1024 * 1024,
  totalXml: 20 * 1024 * 1024,
  nodes: 80_000,
  totalNodes: 250_000,
  depth: 100,
  objects: 4000,
  text: 32_000,
};

export class DocxPackageError extends Error {
  constructor(
    public readonly code:
      | "docx_invalid"
      | "docx_size_limit"
      | "docx_complexity_limit"
      | "docx_unsupported"
      | "docx_signed"
      | "docx_integrity",
    message: string
  ) {
    super(message);
    this.name = "DocxPackageError";
  }
}
function fail(): never {
  throw new DocxPackageError(
    "docx_invalid",
    "This Word file is damaged or contains a package structure that cannot be read safely."
  );
}
function complex(): never {
  throw new DocxPackageError(
    "docx_complexity_limit",
    "This Word file exceeds the safe package-processing limits. Split it into smaller documents and try again."
  );
}
function integrity(): never {
  throw new DocxPackageError(
    "docx_integrity",
    "The proposed Word changes could not be safely matched to the original document."
  );
}
const hash = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
const children = (node: Node): Element[] =>
  Array.from(node.childNodes).filter(
    (child): child is Element => child.nodeType === 1
  );
const direct = (node: Node, ns: string, name: string): Element | undefined =>
  children(node).find(
    (child) => child.namespaceURI === ns && child.localName === name
  );
const descendants = (
  node: Element | Document,
  ns: string,
  name: string
): Element[] => Array.from(node.getElementsByTagNameNS(ns, name));
const value = (node: Element | undefined) =>
  node?.getAttributeNS(W, "val") ?? null;
const flag = (node: Element | undefined) =>
  !!node && !["0", "false", "off"].includes(value(node) ?? "1");
function ancestor(node: Node, ns: string, name: string): Element | undefined {
  let parent = node.parentNode;
  while (parent) {
    if (
      parent.nodeType === 1 &&
      (parent as Element).namespaceURI === ns &&
      (parent as Element).localName === name
    )
      return parent as Element;
    parent = parent.parentNode;
  }
  return undefined;
}
function validPartName(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= 300 &&
    !name.startsWith("/") &&
    !/[\\\u0000-\u001f\u007f%:#?]/.test(name) &&
    !name.split("/").some((segment) => ["", ".", ".."].includes(segment))
  );
}
const crcTable = Array.from({ length: 256 }, (_, start) => {
  let v = start;
  for (let n = 0; n < 8; n++) v = v & 1 ? 0xedb88320 ^ (v >>> 1) : v >>> 1;
  return v >>> 0;
});
function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

async function readParts(
  buffer: Buffer,
  maxBytes = LIMITS.input
): Promise<Map<string, Buffer>> {
  if (!buffer.length || buffer.length > maxBytes)
    throw new DocxPackageError(
      "docx_size_limit",
      `Word files must be nonempty and no larger than ${maxBytes / 1024 / 1024} MB.`
    );
  if (buffer.length < 4 || buffer.readUInt32LE(0) !== 0x04034b50) fail();
  const parts = new Map<string, Buffer>();
  const names = new Set<string>();
  let total = 0;
  let xmlTotal = 0;
  const deadline = Date.now() + 15_000;
  try {
    const zip = await fromBufferPromise(buffer, {
      validateEntrySizes: true,
      strictFileNames: true,
    });
    try {
      if (zip.entryCount > LIMITS.entries) complex();
      for await (const entry of zip.eachEntry()) {
        if (Date.now() > deadline) complex();
        const directory = entry.fileName.endsWith("/");
        const name = directory ? entry.fileName.slice(0, -1) : entry.fileName;
        if (!validPartName(name) || names.has(name.toLowerCase())) fail();
        names.add(name.toLowerCase());
        if (
          entry.isEncrypted() ||
          !entry.canDecodeFileData() ||
          ![0, 8].includes(entry.compressionMethod) ||
          ((entry.externalFileAttributes >>> 16) & 0xf000) === 0xa000
        )
          fail();
        if (
          entry.uncompressedSize > LIMITS.part ||
          (total += entry.uncompressedSize) > LIMITS.inflated
        )
          complex();
        if (
          /\.(?:xml|rels|vml|svg)$/i.test(name) &&
          (xmlTotal += entry.uncompressedSize) > LIMITS.totalXml
        )
          complex();
        const header = await zip.readLocalFileHeaderPromise(entry);
        if (
          header.fileName.toString("utf8") !== entry.fileName ||
          header.compressionMethod !== entry.compressionMethod ||
          header.generalPurposeBitFlag !== entry.generalPurposeBitFlag
        )
          fail();
        const stream = await zip.openReadStreamPromise(entry);
        const chunks: Buffer[] = [];
        let length = 0;
        for await (const chunk of stream) {
          length += chunk.length;
          if (
            Date.now() > deadline ||
            length > entry.uncompressedSize ||
            length > LIMITS.part
          ) {
            stream.destroy();
            complex();
          }
          chunks.push(Buffer.from(chunk));
        }
        const bytes = Buffer.concat(chunks);
        if (length !== entry.uncompressedSize || crc32(bytes) !== entry.crc32)
          fail();
        if (directory) {
          if (bytes.length) fail();
          continue;
        }
        parts.set(name, bytes);
      }
    } finally {
      zip.close();
    }
  } catch (error) {
    if (error instanceof DocxPackageError) throw error;
    fail();
  }
  return parts;
}

function parseXml(
  bytes: Buffer,
  budget: { nodes: number; deadline: number }
): Document {
  if (bytes.length > LIMITS.xml) complex();
  try {
    const xml = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (/<!DOCTYPE|<!ENTITY/i.test(xml)) fail();
    const encoding = xml.match(
      /^\s*<\?xml[^?]*encoding\s*=\s*["']([^"']+)["']/i
    )?.[1];
    if (encoding && !/^utf-?8$/i.test(encoding)) fail();
    let depth = 0;
    let count = 0;
    const sax = new SaxesParser({ xmlns: true });
    sax.on("doctype", () => fail());
    sax.on("error", () => fail());
    sax.on("opentag", (tag) => {
      if (
        ++depth > LIMITS.depth ||
        ++count > LIMITS.nodes ||
        ++budget.nodes > LIMITS.totalNodes ||
        Date.now() > budget.deadline ||
        Object.keys(tag.attributes).length > 128 ||
        Object.values(tag.attributes).some(
          (attribute) => attribute.value.length > LIMITS.text
        )
      )
        complex();
    });
    sax.on("closetag", () => {
      depth--;
    });
    sax.write(xml).close();
    return new DOMParser({ onError: () => fail() }).parseFromString(
      xml,
      "application/xml"
    );
  } catch (error) {
    if (error instanceof DocxPackageError) throw error;
    fail();
  }
}
function serialize(document: Document, original: Buffer): Buffer {
  const declaration = original
    .toString("utf8")
    .match(/^\uFEFF?(<\?xml\s[\s\S]*?\?>)/)?.[1];
  const clone = document.cloneNode(true) as Document;
  const node = Array.from(clone.childNodes).find(
    (item) => item.nodeType === 7 && item.nodeName === "xml"
  );
  if (Boolean(node) !== Boolean(declaration)) fail();
  if (node) clone.removeChild(node);
  return Buffer.from(
    (declaration ?? "") +
      new XMLSerializer().serializeToString(clone, { requireWellFormed: true }),
    "utf8"
  );
}
interface Relationship {
  id: string;
  type: string;
  target: string;
  external: boolean;
}
interface Package {
  parts: Map<string, Buffer>;
  xml: Map<string, Document>;
  inspection: DocxInspection;
  elements: Map<string, Element>;
  main: string;
}
/** Fields can reference files without using OPC relationships. Never allow the
 * renderer to evaluate external-file or DDE instructions from an uploaded file. */
function checkFieldSafety(document: Document): void {
  const external = (instruction: string) => {
    if (
      /^\s*(?:INCLUDEPICTURE|INCLUDETEXT|DDE|DDEAUTO|LINK|DATABASE|RD|IMPORT|PRINT)\b/i.test(
        instruction
      )
    )
      throw new DocxPackageError(
        "docx_unsupported",
        "This Word file contains an automatic field that can load an external file or program. Replace it with embedded content in Word before uploading."
      );
  };
  const stack: { instruction: string; result: boolean }[] = [];
  for (const node of Array.from(document.getElementsByTagNameNS(W, "*"))) {
    if (node.localName === "fldSimple")
      external(node.getAttributeNS(W, "instr") ?? "");
    if (node.localName === "fldChar") {
      const type = node.getAttributeNS(W, "fldCharType");
      if (type === "begin") stack.push({ instruction: "", result: false });
      else if (type === "separate" || type === "end") {
        const field = stack.at(-1);
        if (!field) fail();
        external(field.instruction);
        if (type === "end") stack.pop();
        else field.result = true;
      } else fail();
    }
    if (node.localName === "instrText") {
      const field = stack.at(-1);
      if (!field || field.result) fail();
      field.instruction += node.textContent ?? "";
      if (field.instruction.length > LIMITS.text) complex();
    }
  }
  for (const field of stack) external(field.instruction);
  if (stack.length) fail();
}
function relationships(
  pkg: Pick<Package, "parts" | "xml">,
  source: string
): Relationship[] {
  const name = source
    ? `${path.posix.dirname(source) === "." ? "" : path.posix.dirname(source) + "/"}_rels/${path.posix.basename(source)}.rels`
    : "_rels/.rels";
  const document = pkg.xml.get(name);
  if (!document) return [];
  if (
    document.documentElement?.namespaceURI !== REL ||
    document.documentElement.localName !== "Relationships"
  )
    fail();
  const ids = new Set<string>();
  return children(document.documentElement).map((element) => {
    const id = element.getAttribute("Id") ?? "";
    const type = element.getAttribute("Type") ?? "";
    let target = element.getAttribute("Target") ?? "";
    const mode = element.getAttribute("TargetMode");
    const external = mode === "External";
    if (
      element.namespaceURI !== REL ||
      element.localName !== "Relationship" ||
      !id ||
      ids.has(id) ||
      !type ||
      !target ||
      (mode && !["Internal", "External"].includes(mode))
    )
      fail();
    ids.add(id);
    if (!external) {
      if (/[\\\u0000-\u001f\u007f:#?%]/.test(target)) fail();
      target = target.startsWith("/")
        ? target.slice(1)
        : path.posix.normalize(
            path.posix.join(path.posix.dirname(source), target)
          );
      if (!validPartName(target) || !pkg.parts.has(target)) fail();
    }
    return { id, type, target, external };
  });
}
function textOf(paragraph: Element): string {
  const text = Array.from(paragraph.getElementsByTagNameNS(W, "*"))
    .filter((node) => ancestor(node, W, "p") === paragraph)
    .map((node) => {
      if (node.localName === "t") return node.textContent ?? "";
      if (node.localName === "tab") return "\t";
      if (node.localName === "br" || node.localName === "cr") return "\n";
      if (node.localName === "noBreakHyphen") return "\u2011";
      if (node.localName === "softHyphen") return "\u00ad";
      return "";
    })
    .join("");
  if (text.length > LIMITS.text) complex();
  return text;
}
function location(part: string, index: number, kind: string): string {
  return `${part === "word/document.xml" ? "Document" : path.posix.basename(part, ".xml")}, ${kind} ${index}`;
}
function issue(
  code: string,
  at: string,
  message: string,
  suggestion: string,
  objectId?: string
): DocxFinding {
  return {
    code,
    severity: "warning",
    location: at,
    message,
    suggestion,
    ...(objectId ? { objectId } : {}),
  };
}
const unsafeContext = (node: Element) =>
  !!ancestor(node, MC, "AlternateContent") ||
  descendants(node, MC, "AlternateContent").length > 0 ||
  ["ins", "del", "moveFrom", "moveTo", "sdt", "txbxContent"].some((name) =>
    ancestor(node, W, name)
  ) ||
  [
    "ins",
    "del",
    "fldSimple",
    "fldChar",
    "instrText",
    "sdt",
    "txbxContent",
    "pPrChange",
    "rPrChange",
  ].some((name) => descendants(node, W, name).length > 0);

const elementXml = (node: Element) =>
  new XMLSerializer().serializeToString(node);
function typedPrefix(text: string) {
  const bullet = text.match(/^([•●▪◦‣▫○■□–-])([ \t]{1,8})(\S[\s\S]*)$/);
  if (bullet)
    return {
      kind: "bullet" as const,
      marker: bullet[1],
      separator: bullet[2],
      prefix: bullet[1] + bullet[2],
      number: null,
    };
  const decimal = text.match(/^([1-9]\d{0,2})([.)])([ \t]{1,8})(\S[\s\S]*)$/);
  if (decimal)
    return {
      kind: "decimal" as const,
      marker: decimal[2],
      separator: decimal[3],
      prefix: decimal[1] + decimal[2] + decimal[3],
      number: Number(decimal[1]),
    };
  return null;
}
function prefixNodes(paragraph: Element, prefix: string): Element[] | null {
  let remaining = prefix;
  const nodes: Element[] = [];
  for (const node of Array.from(paragraph.getElementsByTagNameNS(W, "*"))) {
    if (
      ancestor(node, W, "p") !== paragraph ||
      !["t", "tab", "br", "cr", "sym"].includes(node.localName ?? "")
    )
      continue;
    if (!remaining) break;
    const run = node.parentNode as Element | null;
    if (
      ancestor(node, W, "hyperlink") ||
      run?.namespaceURI !== W ||
      run.localName !== "r" ||
      run.parentNode !== paragraph
    )
      return null;
    const text =
      node.localName === "t"
        ? (node.textContent ?? "")
        : node.localName === "tab"
          ? "\t"
          : "\n";
    if (!text || !remaining.startsWith(text.slice(0, remaining.length)))
      return null;
    nodes.push(node);
    remaining = remaining.slice(Math.min(text.length, remaining.length));
  }
  return remaining ? null : nodes;
}
function collectListCandidates(pkg: Package): DocxListCandidate[] {
  const paragraphs = pkg.inspection.paragraphs.filter(
    (p) => p.partName === pkg.main && !p.inTable
  );
  const candidates: DocxListCandidate[] = [];
  let index = 0;
  const eligible = (p: DocxParagraph) =>
    p.editable &&
    !p.list &&
    !p.headingLevel &&
    !!typedPrefix(p.text) &&
    !descendants(pkg.elements.get(p.id)!, W, "drawing").length;
  while (index < paragraphs.length) {
    if (!eligible(paragraphs[index])) {
      index++;
      continue;
    }
    const group = [paragraphs[index++]];
    const groupPrefix = typedPrefix(group[0].text)!;
    while (index < paragraphs.length && eligible(paragraphs[index])) {
      const prev = pkg.elements.get(group.at(-1)!.id)!;
      const next = pkg.elements.get(paragraphs[index].id)!;
      const nextPrefix = typedPrefix(paragraphs[index].text)!;
      if (
        nextPrefix.kind !== groupPrefix.kind ||
        nextPrefix.marker !== groupPrefix.marker ||
        nextPrefix.separator !== groupPrefix.separator ||
        paragraphs[index].styleId !== group[0].styleId ||
        prev.parentNode !== next.parentNode ||
        children(prev.parentNode!).indexOf(next) !==
          children(prev.parentNode!).indexOf(prev) + 1
      )
        break;
      group.push(paragraphs[index++]);
    }
    if (group.length < 2 || group.length > 100) continue;
    const prefixes = group.map((p) => typedPrefix(p.text)!);
    const first = prefixes[0];
    if (
      prefixes.some(
        (prefix, i) =>
          prefix.kind !== first.kind ||
          prefix.marker !== first.marker ||
          prefix.separator !== first.separator ||
          (first.kind === "decimal" && prefix.number !== first.number! + i)
      )
    )
      continue;
    const nodes = group.map((p, i) =>
      prefixNodes(pkg.elements.get(p.id)!, prefixes[i].prefix)
    );
    if (nodes.some((items) => !items)) continue;
    const markerFormatting = nodes.map((items) => {
      const props = direct(items![0].parentNode!, W, "rPr");
      return props ? elementXml(props) : "";
    });
    if (
      markerFormatting.some((format) => format !== markerFormatting[0]) ||
      group.some((p) => p.styleId !== group[0].styleId)
    )
      continue;
    candidates.push({
      id: group[0].id,
      paragraphIds: group.map((p) => p.id),
      sourceTexts: group.map((p) => p.text),
      prefixes: prefixes.map((prefix) => prefix.prefix),
      kind: first.kind,
      marker: first.marker,
      start: first.number,
    });
  }
  return candidates;
}
interface HeaderLayout {
  rows: Element[];
  labels: string[];
  selectedCells: Element[];
  parentCells: Element[];
  childLabels: string[];
  headerParagraphs: Element[];
  gridWidthsTwips: number[];
  headerHeightsTwips: (number | null)[];
  indentTwips: number | null;
  alignment: string | null;
  bottomPaddingTwips: number[];
}
function tableStyleChain(pkg: Package, table: Element): Element[] {
  const props = direct(table, W, "tblPr");
  let id = props && value(direct(props, W, "tblStyle"));
  const name = relationships(pkg, pkg.main).find(
    (r) => r.type === `${R}/styles`
  )?.target;
  const styles = name && pkg.xml.get(name);
  const result: Element[] = [];
  const seen = new Set<string>();
  while (id && styles) {
    if (seen.has(id) || result.length > 32) integrity();
    seen.add(id);
    const style = descendants(styles, W, "style").find(
      (el) => el.getAttributeNS(W, "styleId") === id
    );
    if (!style) break;
    result.push(style);
    id = value(direct(style, W, "basedOn"));
  }
  return result;
}
function headerLayout(table: Element, pkg: Package): HeaderLayout | null {
  if (
    unsafeContext(table) ||
    ancestor(table, W, "tbl") ||
    descendants(table, W, "tbl").length ||
    [
      "drawing",
      "pict",
      "object",
      "hyperlink",
      "bookmarkStart",
      "bookmarkEnd",
      "commentRangeStart",
      "commentRangeEnd",
      "commentReference",
      "footnoteReference",
      "endnoteReference",
      "sym",
      "numPr",
      "hMerge",
      "gridBefore",
      "gridAfter",
    ].some((name) => descendants(table, W, name).length)
  )
    return null;
  const grid = direct(table, W, "tblGrid");
  const width = grid
    ? children(grid).filter(
        (n) => n.namespaceURI === W && n.localName === "gridCol"
      ).length
    : 0;
  const rows = children(table).filter(
    (node) => node.namespaceURI === W && node.localName === "tr"
  );
  if (width < 2 || width > 20 || rows.length < 3 || rows.length > 100)
    return null;
  const cells = rows.map((row) =>
    children(row).filter(
      (node) => node.namespaceURI === W && node.localName === "tc"
    )
  );
  if (
    cells[1].length !== width ||
    cells
      .slice(2)
      .some(
        (row) =>
          row.length !== width ||
          row.some((cell) =>
            ["gridSpan", "vMerge"].some(
              (name) => descendants(cell, W, name).length
            )
          )
      )
  )
    return null;
  if (cells[0].length >= width || cells[0].length < 2) return null;
  const simpleText = (cell: Element) => {
    const ps = children(cell).filter(
      (node) => node.namespaceURI === W && node.localName === "p"
    );
    return ps.length === 1 &&
      descendants(ps[0], W, "t").length > 0 &&
      !/[\r\n\t]/.test(textOf(ps[0]))
      ? textOf(ps[0])
      : null;
  };
  const labels: string[] = [],
    childLabels: string[] = [];
  const selectedCells: Element[] = [],
    parentCells: Element[] = [];
  let column = 0;
  for (const parent of cells[0]) {
    const text = simpleText(parent);
    if (!text?.trim() || text !== text.trim() || text.length > 120) return null;
    const props = direct(parent, W, "tcPr");
    const spanText = props && value(direct(props, W, "gridSpan"));
    const span = spanText ? Number(spanText) : 1;
    const merge = props && direct(props, W, "vMerge");
    if (
      !Number.isInteger(span) ||
      span < 1 ||
      span > width ||
      column + span > width
    )
      return null;
    // Parent labels are repeated in each child column. Only uniform plain runs
    // can be combined without losing emphasis, superscripts or character styles.
    const labelRuns = descendants(parent, W, "r").filter((run) =>
      descendants(run, W, "t").some((node) => !!node.textContent)
    );
    const labelFormats = labelRuns.map((run) => {
      const properties = direct(run, W, "rPr");
      return properties ? elementXml(properties) : "";
    });
    if (
      labelFormats.some((format) => format !== labelFormats[0]) ||
      labelRuns.some((run) =>
        children(run).some(
          (node) =>
            node.namespaceURI !== W ||
            !["rPr", "t", "noBreakHyphen", "softHyphen"].includes(
              node.localName ?? ""
            )
        )
      )
    )
      return null;
    if (span === 1) {
      const continuation = cells[1][column];
      const childProps = direct(continuation, W, "tcPr");
      const childMerge = childProps && direct(childProps, W, "vMerge");
      if (
        !merge ||
        value(merge) !== "restart" ||
        !childMerge ||
        ![null, "continue"].includes(value(childMerge)) ||
        descendants(continuation, W, "p").map(textOf).join("") !== "" ||
        descendants(continuation, W, "gridSpan").length
      )
        return null;
      labels.push(text);
      childLabels.push("");
      selectedCells.push(parent);
      parentCells.push(parent);
    } else {
      if (merge) return null;
      for (let j = 0; j < span; j++) {
        const child = cells[1][column + j];
        const sub = simpleText(child);
        if (
          !sub?.trim() ||
          sub !== sub.trim() ||
          sub.length > 80 ||
          descendants(child, W, "gridSpan").length ||
          descendants(child, W, "vMerge").length
        )
          return null;
        labels.push(`${text} ${sub}`);
        childLabels.push(sub);
        selectedCells.push(child);
        parentCells.push(parent);
      }
    }
    column += span;
  }
  if (column !== width || new Set(labels).size !== labels.length) return null;
  const gridWidthsTwips = children(grid!).map((column) =>
    Number(column.getAttributeNS(W, "w"))
  );
  if (
    gridWidthsTwips.length !== width ||
    gridWidthsTwips.some((n) => !Number.isInteger(n) || n <= 0 || n > 31680)
  )
    return null;
  const tableProps = direct(table, W, "tblPr");
  const styleChain = tableStyleChain(pkg, table);
  const tableProperties = [
    tableProps,
    ...styleChain.map((style) => direct(style, W, "tblPr")),
  ].filter((p): p is Element => !!p);
  const border = tableProperties
    .map((props) => {
      const borders = direct(props, W, "tblBorders");
      return borders && direct(borders, W, "insideH");
    })
    .find(Boolean);
  const borderWidth = (el: Element | undefined): number | null => {
    if (!el || ["nil", "none"].includes(value(el) ?? "")) return 0;
    const size = Number(el.getAttributeNS(W, "sz"));
    return Number.isInteger(size) && size >= 0 && size <= 96
      ? Math.round(size * 2.5)
      : null;
  };
  const margin = (cell: Element, edge: string): number | null => {
    const props = direct(cell, W, "tcPr");
    const margins = [
      props && direct(props, W, "tcMar"),
      ...tableProperties.map((p) => direct(p, W, "tblCellMar")),
      ...styleChain.map((s) => {
        const p = direct(s, W, "tcPr");
        return p && direct(p, W, "tcMar");
      }),
    ];
    const element = margins.map((m) => m && direct(m, W, edge)).find(Boolean);
    if (!element || element.getAttributeNS(W, "type") === "nil") return 0;
    const raw = element.getAttributeNS(W, "w");
    return (!element.getAttributeNS(W, "type") ||
      element.getAttributeNS(W, "type") === "dxa") &&
      /^\d+$/.test(raw ?? "") &&
      Number(raw) <= 31680
      ? Number(raw)
      : null;
  };
  const bottomPaddingTwips: number[] = [];
  for (const [index, cell] of selectedCells.entries()) {
    const parent = parentCells[index];
    const parentProps = direct(parent, W, "tcPr"),
      childProps = direct(cell, W, "tcPr");
    const parentBorders = parentProps && direct(parentProps, W, "tcBorders"),
      childBorders = childProps && direct(childProps, W, "tcBorders");
    const widths = [
      borderWidth(border),
      borderWidth(parentBorders && direct(parentBorders, W, "bottom")),
      borderWidth(childBorders && direct(childBorders, W, "top")),
    ];
    const bottom = margin(cell, "bottom"),
      removedTop = margin(parent, "top"),
      removedBottom = margin(parent, "bottom");
    if (
      widths.some((n) => n === null) ||
      bottom === null ||
      removedTop === null ||
      removedBottom === null
    )
      return null;
    // The line break replaces two text lines. Retain the removed row's cell
    // padding and shared border as padding so following content does not shift.
    bottomPaddingTwips.push(
      cell === parent
        ? bottom
        : bottom +
            removedTop +
            removedBottom +
            Math.max(...(widths as number[]))
    );
  }
  const indent = tableProps && direct(tableProps, W, "tblInd");
  const indentValue = indent?.getAttributeNS(W, "w");
  const indentTwips =
    indent?.getAttributeNS(W, "type") === "dxa" &&
    /^-?\d+$/.test(indentValue ?? "")
      ? Number(indentValue)
      : null;
  return {
    rows,
    labels,
    selectedCells,
    parentCells,
    childLabels,
    headerParagraphs: rows
      .slice(0, 2)
      .flatMap((row) => descendants(row, W, "p")),
    gridWidthsTwips,
    headerHeightsTwips: rows.slice(0, 2).map((row) => {
      const props = direct(row, W, "trPr");
      const raw = props && value(direct(props, W, "trHeight"));
      return raw && /^\d+$/.test(raw) ? Number(raw) : null;
    }),
    indentTwips,
    alignment: tableProps ? value(direct(tableProps, W, "jc")) : null,
    bottomPaddingTwips,
  };
}

async function openPackage(
  buffer: Buffer,
  maxBytes = LIMITS.input
): Promise<Package> {
  const parts = await readParts(buffer, maxBytes);
  const xml = new Map<string, Document>();
  const budget = { nodes: 0, deadline: Date.now() + 15_000 };
  let xmlBytes = 0;
  const inspectXml = (name: string, bytes: Buffer) => {
    if ((xmlBytes += bytes.length) > LIMITS.totalXml) complex();
    const document = parseXml(bytes, budget);
    checkFieldSafety(document);
    xml.set(name, document);
  };
  for (const [name, bytes] of parts) {
    if (/(?:^|\/)vba(?:project|data)\.|\.bin$/i.test(name) && /vba/i.test(name))
      throw new DocxPackageError(
        "docx_unsupported",
        "Macro-enabled Word files are not supported. Save an unprotected .docx copy."
      );
    if (/^_xmlsignatures\//i.test(name))
      throw new DocxPackageError(
        "docx_signed",
        "Digitally signed Word files cannot be changed without invalidating their signature."
      );
    if (/\.(?:xml|rels|vml|svg)$/i.test(name)) inspectXml(name, bytes);
  }
  const pkg: Package = {
    parts,
    xml,
    inspection: { paragraphs: [], tables: [], images: [], findings: [] },
    elements: new Map(),
    main: "",
  };
  const types = xml.get("[Content_Types].xml");
  if (
    types?.documentElement?.namespaceURI !== CT ||
    types.documentElement.localName !== "Types"
  )
    fail();
  const contentOverrides = new Map<string, string>();
  const contentDefaults = new Map<string, string>();
  for (const element of children(types.documentElement)) {
    if (
      element.namespaceURI !== CT ||
      !["Default", "Override"].includes(element.localName ?? "")
    )
      fail();
    const type = element.getAttribute("ContentType") ?? "";
    // Accept a bare media type; ambiguous suffixes must not bypass XML inspection.
    if (!/^[a-z0-9!#$%&'*+.^_`|~-]+\/[a-z0-9!#$%&'*+.^_`|~-]+$/i.test(type))
      fail();
    if (/macroEnabled|vbaProject/i.test(type))
      throw new DocxPackageError(
        "docx_unsupported",
        "Macro-enabled Word files are not supported."
      );
    if (/digital-signature/i.test(type))
      throw new DocxPackageError(
        "docx_signed",
        "Digitally signed Word files cannot be changed without invalidating their signature."
      );
    if (element.localName === "Override") {
      const partName = element.getAttribute("PartName") ?? "";
      const name = partName.slice(1);
      if (
        !partName.startsWith("/") ||
        !parts.has(name) ||
        contentOverrides.has(name)
      )
        fail();
      contentOverrides.set(name, type);
    } else {
      const extension = element.getAttribute("Extension")?.toLowerCase() ?? "";
      if (!extension || contentDefaults.has(extension)) fail();
      contentDefaults.set(extension, type);
    }
  }
  // OPC content types, not filename extensions, determine which parts contain XML.
  // https://learn.microsoft.com/en-us/office/open-xml/about-the-open-xml-sdk
  // Use the same safety checks and budgets before reading settings or story parts.
  for (const [name, bytes] of parts) {
    const type =
      contentOverrides.get(name) ??
      contentDefaults.get(path.posix.extname(name).slice(1).toLowerCase()) ??
      "";
    if (/(?:\/xml|\+xml)$/i.test(type) && !xml.has(name))
      inspectXml(name, bytes);
  }
  for (const name of xml.keys())
    if (name.endsWith(".rels")) {
      const source =
        name === "_rels/.rels"
          ? ""
          : name.replace(/(^|\/)\_rels\/([^/]+)\.rels$/, "$1$2");
      if (source === name || (source && !parts.has(source))) fail();
      const externalContentReferences = new Set<string>();
      const sourceXml = xml.get(source);
      for (const element of sourceXml ? descendants(sourceXml, "*", "*") : [])
        for (const attribute of Array.from(element.attributes))
          if (
            attribute.namespaceURI === R &&
            !(
              attribute.localName === "id" &&
              ((element.namespaceURI === W &&
                element.localName === "hyperlink") ||
                (element.namespaceURI === A &&
                  ["hlinkClick", "hlinkHover"].includes(
                    element.localName ?? ""
                  )))
            )
          )
            externalContentReferences.add(attribute.value);
      for (const relationship of relationships(pkg, source)) {
        if (/digital-signature/i.test(relationship.type))
          throw new DocxPackageError(
            "docx_signed",
            "Digitally signed Word files cannot be changed without invalidating their signature."
          );
        if (/vbaProject|vbaData/i.test(relationship.type))
          throw new DocxPackageError(
            "docx_unsupported",
            "Macro-enabled Word files are not supported."
          );
        if (relationship.external && relationship.type !== `${R}/hyperlink`)
          throw new DocxPackageError(
            "docx_unsupported",
            "This Word file links to an external image, template, or embedded file. Embed that content in Word and upload the saved copy."
          );
        if (relationship.external) {
          // A hyperlink relationship must not be reused as a linked image or
          // embedded object; renderers may follow the target despite its type.
          if (externalContentReferences.has(relationship.id))
            throw new DocxPackageError(
              "docx_unsupported",
              "This Word file uses an external link as embedded content. Embed that content in Word before uploading."
            );
        }
      }
    }
  const mains = relationships(pkg, "").filter(
    (rel) => rel.type === `${R}/officeDocument` && !rel.external
  );
  if (mains.length !== 1) fail();
  pkg.main = mains[0].target;
  if (pkg.main !== "word/document.xml")
    throw new DocxPackageError(
      "docx_unsupported",
      "This Word package uses a nonstandard document location. Save a new .docx copy in Word."
    );
  const mainType = contentOverrides.get(pkg.main);
  if (mainType !== MAIN_TYPE) fail();
  const main = xml.get(pkg.main);
  if (
    main?.documentElement?.namespaceURI !== W ||
    main.documentElement.localName !== "document" ||
    !direct(main.documentElement, W, "body")
  )
    fail();
  const mainRels = relationships(pkg, pkg.main);
  const settingsName = mainRels.find(
    (rel) => rel.type === `${R}/settings` && !rel.external
  )?.target;
  const settings = settingsName ? xml.get(settingsName) : undefined;
  if (
    settings &&
    descendants(settings, W, "documentProtection").some((item) =>
      flagAttr(item, "enforcement")
    )
  )
    throw new DocxPackageError(
      "docx_unsupported",
      "This Word file is protected. Save an unprotected .docx copy before making accessibility changes."
    );
  const stylesName = mainRels.find(
    (rel) => rel.type === `${R}/styles` && !rel.external
  )?.target;
  const stylesDoc = stylesName ? xml.get(stylesName) : undefined;
  const styles = new Map<string, Element>();
  if (stylesDoc)
    for (const style of descendants(stylesDoc, W, "style")) {
      const id = style.getAttributeNS(W, "styleId");
      if (!id || styles.has(id)) fail();
      styles.set(id, style);
    }
  const defaultParagraph = Array.from(styles.values()).find(
    (style) =>
      style.getAttributeNS(W, "type") === "paragraph" &&
      flagAttr(style, "default")
  );
  const styleChain = (id: string | null): Element[] => {
    const result: Element[] = [];
    const seen = new Set<string>();
    let style = id ? styles.get(id) : defaultParagraph;
    while (style) {
      const key = style.getAttributeNS(W, "styleId")!;
      if (seen.has(key) || result.length > 32) fail();
      seen.add(key);
      result.push(style);
      const based = value(direct(style, W, "basedOn"));
      style = based ? styles.get(based) : undefined;
    }
    return result;
  };
  // Validate every inheritance chain, including styles not used by the body.
  for (const id of styles.keys()) styleChain(id);
  const defaults = stylesDoc && descendants(stylesDoc, W, "docDefaults")[0];
  const defaultLang =
    defaults && descendants(defaults, W, "lang")[0]?.getAttributeNS(W, "val");
  const numberingName = mainRels.find(
    (rel) => rel.type === `${R}/numbering` && !rel.external
  )?.target;
  const numbering = numberingName ? xml.get(numberingName) : undefined;
  const numberingInstances = new Map<string, Element>();
  const abstractNumbering = new Map<string, Element>();
  if (numbering) {
    if (
      numbering.documentElement?.namespaceURI !== W ||
      numbering.documentElement.localName !== "numbering"
    )
      fail();
    for (const num of descendants(numbering, W, "num")) {
      const id = num.getAttributeNS(W, "numId");
      if (!id || !/^\d+$/.test(id) || numberingInstances.has(id)) fail();
      numberingInstances.set(id, num);
    }
    for (const num of descendants(numbering, W, "abstractNum")) {
      const id = num.getAttributeNS(W, "abstractNumId");
      if (!id || !/^\d+$/.test(id) || abstractNumbering.has(id)) fail();
      abstractNumbering.set(id, num);
    }
  }
  const listInfo = (properties: Element[]): DocxParagraph["list"] => {
    const nums = properties
      .map((props) => direct(props, W, "numPr"))
      .filter((num): num is Element => !!num);
    const numId = nums
      .map((num) => value(direct(num, W, "numId")))
      .find((id) => id !== null);
    if (numId === undefined || numId === "0") return null;
    if (!/^\d+$/.test(numId)) fail();
    const rawLevel =
      nums
        .map((num) => value(direct(num, W, "ilvl")))
        .find((level) => level !== null) ?? "0";
    if (!/^[0-8]$/.test(rawLevel)) fail();
    const level = Number(rawLevel);
    const instance = numberingInstances.get(numId);
    const abstractId = instance && value(direct(instance, W, "abstractNumId"));
    const definition = abstractId
      ? abstractNumbering.get(abstractId)
      : undefined;
    const override =
      instance &&
      children(instance).find(
        (node) =>
          node.namespaceURI === W &&
          node.localName === "lvlOverride" &&
          node.getAttributeNS(W, "ilvl") === rawLevel
      );
    const baseLevel =
      definition &&
      children(definition).find(
        (node) =>
          node.namespaceURI === W &&
          node.localName === "lvl" &&
          node.getAttributeNS(W, "ilvl") === rawLevel
      );
    const nativeLevel = (override && direct(override, W, "lvl")) || baseLevel;
    return {
      numId,
      level,
      format: nativeLevel ? value(direct(nativeLevel, W, "numFmt")) : null,
      markerText: nativeLevel ? value(direct(nativeLevel, W, "lvlText")) : null,
    };
  };
  const supportedStories = new Map<string, string>([[pkg.main, "document"]]);
  for (const rel of mainRels)
    if (
      !rel.external &&
      /\/(?:header|footer|footnotes|endnotes)$/.test(rel.type)
    )
      supportedStories.set(
        rel.target,
        rel.type.slice(rel.type.lastIndexOf("/") + 1)
      );
  for (const [partName, story] of supportedStories) {
    const document = xml.get(partName);
    if (!document?.documentElement) fail();
    if (document.documentElement.namespaceURI !== W) fail();
    const allParagraphs = descendants(document, W, "p");
    const paragraphIds = new Map<Element, string>();
    for (const [offset, paragraph] of allParagraphs.entries()) {
      const index = offset + 1;
      const id = `${partName}:p:${index}`;
      const pPr = direct(paragraph, W, "pPr");
      const styleId = pPr ? value(direct(pPr, W, "pStyle")) : null;
      const chain = styleChain(styleId);
      const pProps = [
        pPr,
        ...chain.map((style) => direct(style, W, "pPr")),
      ].filter((node): node is Element => !!node);
      const outline = pProps
        .map((props) => value(direct(props, W, "outlineLvl")))
        .find((item) => item !== null);
      const headingLevel =
        outline && /^[0-8]$/.test(outline) ? Number(outline) + 1 : null;
      const runs = descendants(paragraph, W, "r").filter(
        (run) =>
          ancestor(run, W, "p") === paragraph &&
          descendants(run, W, "t").length > 0
      );
      const inheritedLang =
        chain
          .map((style) => direct(style, W, "rPr"))
          .map(
            (props) =>
              props && direct(props, W, "lang")?.getAttributeNS(W, "val")
          )
          .find(Boolean) ??
        defaultLang ??
        null;
      const langs = runs.map((run) => {
        const props = direct(run, W, "rPr");
        const rStyle = props && value(direct(props, W, "rStyle"));
        const runLang =
          props && direct(props, W, "lang")?.getAttributeNS(W, "val");
        return (
          runLang ??
          (rStyle
            ? styleChain(rStyle)
                .map((style) => direct(style, W, "rPr"))
                .map(
                  (rp) => rp && direct(rp, W, "lang")?.getAttributeNS(W, "val")
                )
                .find(Boolean)
            : null) ??
          inheritedLang
        );
      });
      const firstProps = runs[0] && direct(runs[0], W, "rPr");
      const size = firstProps && value(direct(firstProps, W, "sz"));
      const info: DocxParagraph = {
        id,
        partName,
        index,
        location: location(partName, index, "paragraph"),
        text: textOf(paragraph),
        styleId,
        styleName: chain[0] ? value(direct(chain[0], W, "name")) : null,
        headingLevel,
        list: listInfo(pProps),
        language:
          langs.length && langs.every((lang) => lang === langs[0])
            ? langs[0]
            : null,
        inTable: !!ancestor(paragraph, W, "tbl"),
        editable: story === "document" && !unsafeContext(paragraph),
        formatting: {
          bold:
            firstProps && direct(firstProps, W, "b")
              ? flag(direct(firstProps, W, "b"))
              : null,
          fontSizePt: size && /^\d+$/.test(size) ? Number(size) / 2 : null,
        },
      };
      pkg.inspection.paragraphs.push(info);
      pkg.elements.set(id, paragraph);
      paragraphIds.set(paragraph, id);
    }
    for (const [offset, table] of descendants(document, W, "tbl").entries()) {
      const index = offset + 1;
      const id = `${partName}:t:${index}`;
      const rows = children(table).filter(
        (item) => item.namespaceURI === W && item.localName === "tr"
      );
      const cells = rows.map((row) =>
        children(row)
          .filter((item) => item.namespaceURI === W && item.localName === "tc")
          .map((cell) =>
            descendants(cell, W, "p")
              .filter((p) => ancestor(p, W, "tbl") === table)
              .map(textOf)
              .join("\n")
          )
      );
      const complex =
        !!ancestor(table, W, "tbl") ||
        descendants(table, W, "tbl").length > 0 ||
        ["gridSpan", "vMerge", "hMerge", "gridBefore", "gridAfter"].some(
          (name) => descendants(table, W, name).length > 0
        ) ||
        cells.length < 2 ||
        !cells[0]?.length ||
        cells.some((row) => row.length !== cells[0].length) ||
        children(table).filter(
          (item) => item.namespaceURI === W && item.localName === "sdt"
        ).length > 0;
      const rowProps = rows[0] && direct(rows[0], W, "trPr");
      const info: DocxTable = {
        id,
        partName,
        index,
        location: location(partName, index, "table"),
        cells,
        firstRowHeader: !!rowProps && flag(direct(rowProps, W, "tblHeader")),
        complex,
        editable: story === "document" && !complex && !unsafeContext(table),
      };
      const candidate = story === "document" ? headerLayout(table, pkg) : null;
      if (candidate)
        info.headerCandidate = {
          headerRows: 2,
          labels: candidate.labels,
          sourceCells: cells.map((row) => [...row]),
          headerParagraphIds: candidate.headerParagraphs
            .map((paragraph) => paragraphIds.get(paragraph)!)
            .filter(Boolean),
          gridWidthsTwips: candidate.gridWidthsTwips,
          headerHeightsTwips: candidate.headerHeightsTwips,
          indentTwips: candidate.indentTwips,
          alignment: candidate.alignment,
        };
      pkg.inspection.tables.push(info);
      pkg.elements.set(id, table);
    }
    for (const [offset, properties] of descendants(
      document,
      WP,
      "docPr"
    ).entries()) {
      const index = offset + 1;
      const id = `${partName}:i:${index}`;
      const drawing = ancestor(properties, W, "drawing");
      const p = ancestor(properties, W, "p");
      const decorative = descendants(properties, DECORATIVE, "decorative").some(
        (item) => ["1", "true"].includes(item.getAttribute("val") ?? "")
      );
      const functional =
        !!ancestor(properties, W, "hyperlink") ||
        (!!drawing && descendants(drawing, A, "hlinkClick").length > 0) ||
        (!!drawing && descendants(drawing, A, "hlinkHover").length > 0);
      const isPicture =
        !!drawing &&
        descendants(
          drawing,
          "http://schemas.openxmlformats.org/drawingml/2006/picture",
          "pic"
        ).length === 1;
      const info: DocxImage = {
        id,
        partName,
        index,
        location: location(partName, index, "image"),
        ...(p && paragraphIds.get(p)
          ? { paragraphId: paragraphIds.get(p)! }
          : {}),
        name: properties.getAttribute("name") ?? "",
        title: properties.getAttribute("title") ?? "",
        description: properties.getAttribute("descr") ?? "",
        decorative,
        functional,
        inline: !!ancestor(properties, WP, "inline"),
        editable:
          story === "document" &&
          !!drawing &&
          isPicture &&
          !unsafeContext(drawing),
        nearbyText: p ? textOf(p) : "",
      };
      pkg.inspection.images.push(info);
      pkg.elements.set(id, properties);
    }
    // Ordinary headers, footers and notes are inventoried and audited. Their
    // read-only status does not imply an accessibility defect.
    const coverage = new Set<string>();
    const addCoverage = (node: Element, label: string) => {
      const paragraph = ancestor(node, W, "p") ?? descendants(node, W, "p")[0];
      const id = paragraph ? paragraphIds.get(paragraph) : undefined;
      const info = id && pkg.inspection.paragraphs.find((p) => p.id === id);
      const at = info
        ? info.location
        : story === "document"
          ? "Document"
          : path.posix.basename(partName);
      const key = `${at}:${label}`;
      if (coverage.has(key)) return;
      coverage.add(key);
      const codes: Record<string, string> = {
        "text box": "docx_unsupported_text_box",
        "automatic field": "docx_unsupported_field",
        "tracked insertion": "docx_unsupported_tracked_change",
        "tracked deletion": "docx_unsupported_tracked_change",
        "tracked move": "docx_unsupported_tracked_change",
        "content control": "docx_unsupported_control",
        "embedded object": "docx_unsupported_embedded_content",
        "imported content": "docx_unsupported_embedded_content",
        "legacy drawing": "docx_unsupported_legacy_drawing",
        "drawing with alternative representations":
          "docx_unsupported_alternate_content",
      };
      pkg.inspection.findings.push(
        issue(
          codes[label] ?? "docx_unsupported_content",
          at,
          `This ${label} was preserved, but its internal content or reading order could not be fully checked.`,
          `Review the ${label} in Word, including any text, image descriptions, and reading order.`,
          id
        )
      );
    };
    for (const [name, label] of [
      ["altChunk", "imported content"],
      ["object", "embedded object"],
      ["pict", "legacy drawing"],
      ["txbxContent", "text box"],
      ["sdt", "content control"],
      ["ins", "tracked insertion"],
      ["del", "tracked deletion"],
      ["moveFrom", "tracked move"],
      ["moveTo", "tracked move"],
    ])
      for (const node of descendants(document, W, name))
        addCoverage(node, label);
    for (const node of descendants(document, MC, "AlternateContent"))
      addCoverage(node, "drawing with alternative representations");
    const knownPageField = (instruction: string) =>
      /^\s*(?:PAGE|NUMPAGES|SECTIONPAGES)(?:\s+\\\*\s+(?:MERGEFORMAT|Arabic|ROMAN|roman|ALPHABETIC|alphabetic))*\s*$/i.test(
        instruction
      );
    for (const node of descendants(document, W, "fldSimple"))
      if (!knownPageField(node.getAttributeNS(W, "instr") ?? ""))
        addCoverage(node, "automatic field");
    for (const paragraph of allParagraphs) {
      const fieldChars = descendants(paragraph, W, "fldChar").filter(
        (node) => ancestor(node, W, "p") === paragraph
      );
      if (!fieldChars.length) continue;
      const instruction = descendants(paragraph, W, "instrText")
        .filter((node) => ancestor(node, W, "p") === paragraph)
        .map((node) => node.textContent ?? "")
        .join("");
      const begins = fieldChars.filter(
        (node) => node.getAttributeNS(W, "fldCharType") === "begin"
      ).length;
      const ends = fieldChars.filter(
        (node) => node.getAttributeNS(W, "fldCharType") === "end"
      ).length;
      if (begins !== 1 || ends !== 1 || !knownPageField(instruction))
        addCoverage(fieldChars[0], "automatic field");
    }
  }
  if (pkg.elements.size > LIMITS.objects) complex();
  pkg.inspection.listCandidates = collectListCandidates(pkg);
  return pkg;
}
function flagAttr(node: Element, name: string): boolean {
  return ["1", "true", "on"].includes(node.getAttributeNS(W, name) ?? "");
}

export async function inspectDocx(
  buffer: Buffer,
  options: { generated?: boolean } = {}
): Promise<DocxInspection> {
  return (
    await openPackage(buffer, options.generated ? LIMITS.output : LIMITS.input)
  ).inspection;
}
export function checkDocxAccessibility(
  inspection: DocxInspection
): DocxFinding[] {
  const findings = [...inspection.findings];
  for (const image of inspection.images) {
    if (!image.description.trim() && !image.title.trim() && !image.decorative)
      findings.push(
        issue(
          "docx_image_description_missing",
          image.location,
          "This image has no description for someone using reading software.",
          "Describe the image's purpose, or mark it decorative only when it adds no information or function.",
          image.id
        )
      );
    if (image.decorative && image.functional)
      findings.push(
        issue(
          "docx_functional_image_decorative",
          image.location,
          "An image used as a link is marked decorative.",
          "Give the image a description that explains where its link goes.",
          image.id
        )
      );
    if (!image.editable)
      findings.push(
        issue(
          "docx_image_review",
          image.location,
          "This image or drawing uses a structure that is preserved without automatic repair.",
          "Check its description, purpose, and reading order in Word.",
          image.id
        )
      );
  }
  for (const table of inspection.tables) {
    if (table.complex)
      findings.push(
        issue(
          "docx_complex_table",
          table.location,
          "This table has merged, nested, or otherwise complex cells that need a manual check.",
          "Check that each data cell has clear column and row labels. Simplify the table if needed.",
          table.id
        )
      );
    else if (!table.firstRowHeader)
      findings.push(
        issue(
          "docx_table_header_missing",
          table.location,
          "The first row is not identified as table headings.",
          "If the first row labels the data columns, mark it as a repeating header row in Word. A layout table may not need headers.",
          table.id
        )
      );
  }
  let previous = 0;
  for (const paragraph of inspection.paragraphs.filter(
    (p) => p.partName === "word/document.xml" && !p.inTable && p.headingLevel
  )) {
    if (paragraph.headingLevel! > previous + 1)
      findings.push(
        issue(
          "docx_heading_jump",
          paragraph.location,
          `The heading moves from level ${previous || "document start"} to level ${paragraph.headingLevel}.`,
          "Check the document outline. Subheadings should sit one level below their parent section.",
          paragraph.id
        )
      );
    previous = paragraph.headingLevel!;
  }
  if (
    inspection.paragraphs.some((p) => p.text.trim()) &&
    !inspection.paragraphs.some((p) => p.headingLevel)
  )
    findings.push(
      issue(
        "docx_headings_review",
        "Document",
        "No heading levels were found in the document.",
        "If the document has sections, identify their titles as headings. A short document may not need headings."
      )
    );
  for (const paragraph of inspection.paragraphs)
    if (paragraph.text.trim() && !paragraph.language)
      findings.push(
        issue(
          "docx_language_review",
          paragraph.location,
          "The text has no single identifiable reading language, or contains mixed languages.",
          "Check the language of this passage in Word so reading software pronounces it correctly.",
          paragraph.id
        )
      );
  return findings;
}

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
function keys(obj: Record<string, unknown>, allowed: string[]) {
  if (
    Object.keys(obj).some((key) => !allowed.includes(key)) ||
    allowed.some((key) => !(key in obj))
  )
    integrity();
}
function boundedText(
  value: unknown,
  min = 1,
  max = LIMITS.text
): value is string {
  return (
    typeof value === "string" &&
    value.length >= min &&
    value.length <= max &&
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
  );
}
const validId = (value: unknown) =>
  boundedText(value, 1, 360) &&
  /^word\/[a-zA-Z0-9_.-]+:[pti]:[1-9]\d*$/.test(value);
export function validateDocxRepairPlan(value: unknown): DocxRepairPlan {
  if (!record(value)) integrity();
  keys(value, [
    "reviewedParagraphIds",
    "reviewedTableIds",
    "reviewedImageIds",
    "operations",
  ]);
  for (const key of [
    "reviewedParagraphIds",
    "reviewedTableIds",
    "reviewedImageIds",
  ]) {
    const ids = value[key];
    if (
      !Array.isArray(ids) ||
      ids.length > LIMITS.objects ||
      ids.some((id) => !validId(id)) ||
      new Set(ids).size !== ids.length
    )
      integrity();
  }
  if (
    !Array.isArray(value.operations) ||
    value.operations.length > LIMITS.objects * 2
  )
    integrity();
  const targets = new Set<string>();
  for (const op of value.operations) {
    if (!record(op) || !validId(op.id) || typeof op.type !== "string")
      integrity();
    const target = `${op.type}:${op.id}`;
    if (targets.has(target)) integrity();
    targets.add(target);
    switch (op.type) {
      case "setHeading":
        keys(op, ["type", "id", "level", "sourceText"]);
        if (
          !Number.isInteger(op.level) ||
          Number(op.level) < 1 ||
          Number(op.level) > 6 ||
          !boundedText(op.sourceText)
        )
          integrity();
        break;
      case "setImageDescription":
        keys(op, ["type", "id", "text"]);
        if (!boundedText(op.text, 1, 4000) || !op.text.trim()) integrity();
        break;
      case "setDecorative":
        keys(op, ["type", "id", "decorative"]);
        if (op.decorative !== true) integrity();
        break;
      case "setTableHeader":
        keys(op, ["type", "id", "headerTexts"]);
        if (
          !Array.isArray(op.headerTexts) ||
          !op.headerTexts.length ||
          op.headerTexts.length > 100 ||
          op.headerTexts.some((text) => !boundedText(text) || !text.trim())
        )
          integrity();
        break;
      case "setLanguage":
        keys(op, ["type", "id", "tag", "sourceText"]);
        if (
          !boundedText(op.tag, 2, 35) ||
          !/^[a-zA-Z]{2,8}(?:-[a-zA-Z0-9]{1,8})*$/.test(op.tag) ||
          !boundedText(op.sourceText)
        )
          integrity();
        break;
      case "convertTypedList":
        keys(op, ["type", "id", "items"]);
        if (
          !Array.isArray(op.items) ||
          op.items.length < 2 ||
          op.items.length > 100
        )
          integrity();
        for (const item of op.items) {
          if (!record(item)) integrity();
          keys(item, ["paragraphId", "sourceText"]);
          if (!validId(item.paragraphId) || !boundedText(item.sourceText))
            integrity();
        }
        if (
          new Set(op.items.map((item) => item.paragraphId)).size !==
            op.items.length ||
          op.items[0].paragraphId !== op.id
        )
          integrity();
        break;
      case "simplifyTableHeaders":
        keys(op, ["type", "id", "sourceCells"]);
        if (
          !Array.isArray(op.sourceCells) ||
          op.sourceCells.length < 3 ||
          op.sourceCells.length > 100 ||
          op.sourceCells.some(
            (row) =>
              !Array.isArray(row) ||
              !row.length ||
              row.length > 20 ||
              row.some((text) => !boundedText(text, 0))
          )
        )
          integrity();
        break;
      default:
        integrity();
    }
  }
  for (const op of value.operations)
    if (
      op.type === "setDecorative" &&
      targets.has(`setImageDescription:${op.id}`)
    )
      integrity();
  return structuredClone(value) as unknown as DocxRepairPlan;
}

/** No missing semantic property has a reliable, document-independent default. */
export function buildDocxMechanicalPlan(
  inspection: DocxInspection
): DocxRepairPlan {
  return {
    reviewedParagraphIds: inspection.paragraphs.map((p) => p.id),
    reviewedTableIds: inspection.tables.map((t) => t.id),
    reviewedImageIds: inspection.images.map((i) => i.id),
    operations: [],
  };
}
function ensureProperty(parent: Element, name: string, first = false): Element {
  const found = direct(parent, W, name);
  if (found) return found;
  const created = parent.ownerDocument!.createElementNS(W, `w:${name}`);
  const orders: Record<string, string[]> = {
    pPr: [
      "pStyle",
      "keepNext",
      "keepLines",
      "pageBreakBefore",
      "framePr",
      "widowControl",
      "numPr",
      "suppressLineNumbers",
      "pBdr",
      "shd",
      "tabs",
      "suppressAutoHyphens",
      "kinsoku",
      "wordWrap",
      "overflowPunct",
      "topLinePunct",
      "autoSpaceDE",
      "autoSpaceDN",
      "bidi",
      "adjustRightInd",
      "snapToGrid",
      "spacing",
      "ind",
      "contextualSpacing",
      "mirrorIndents",
      "suppressOverlap",
      "jc",
      "textDirection",
      "textAlignment",
      "textboxTightWrap",
      "outlineLvl",
      "divId",
      "cnfStyle",
      "rPr",
      "sectPr",
      "pPrChange",
    ],
    rPr: [
      "rStyle",
      "rFonts",
      "b",
      "bCs",
      "i",
      "iCs",
      "caps",
      "smallCaps",
      "strike",
      "dstrike",
      "outline",
      "shadow",
      "emboss",
      "imprint",
      "noProof",
      "snapToGrid",
      "vanish",
      "webHidden",
      "color",
      "spacing",
      "w",
      "kern",
      "position",
      "sz",
      "szCs",
      "highlight",
      "u",
      "effect",
      "bdr",
      "shd",
      "fitText",
      "vertAlign",
      "rtl",
      "cs",
      "em",
      "lang",
      "eastAsianLayout",
      "specVanish",
      "oMath",
      "rPrChange",
    ],
    trPr: [
      "cnfStyle",
      "divId",
      "gridBefore",
      "gridAfter",
      "wBefore",
      "wAfter",
      "cantSplit",
      "trHeight",
      "tblHeader",
      "tblCellSpacing",
      "jc",
      "hidden",
      "ins",
      "del",
      "trPrChange",
    ],
    tcPr: [
      "cnfStyle",
      "tcW",
      "gridSpan",
      "hMerge",
      "vMerge",
      "tcBorders",
      "shd",
      "noWrap",
      "tcMar",
      "textDirection",
      "tcFitText",
      "vAlign",
      "hideMark",
      "headers",
      "cellIns",
      "cellDel",
      "cellMerge",
      "tcPrChange",
    ],
    tcMar: ["top", "left", "start", "bottom", "right", "end"],
    numPr: ["ilvl", "numId", "numberingChange", "ins"],
  };
  const order = orders[parent.localName ?? ""];
  const rank = order?.indexOf(name) ?? -1;
  const next =
    rank >= 0
      ? children(parent).find(
          (child) =>
            child.namespaceURI === W &&
            order.indexOf(child.localName ?? "") > rank
        )
      : undefined;
  if (first && parent.namespaceURI === W && parent.localName === "tr") {
    const beforeCells = children(parent).find(
      (child) => child.namespaceURI !== W || child.localName !== "tblPrEx"
    );
    parent.insertBefore(created, beforeCells ?? null);
  } else if (first) parent.insertBefore(created, parent.firstChild);
  else if (next) parent.insertBefore(created, next);
  else parent.appendChild(created);
  return created;
}
function setWordValue(element: Element, value: string) {
  element.setAttributeNS(W, "w:val", value);
}

function stripTypedPrefix(paragraph: Element, prefix: string): void {
  const nodes = prefixNodes(paragraph, prefix);
  if (!nodes) integrity();
  const original = textOf(paragraph);
  let remaining = prefix.length;
  for (const node of nodes) {
    const text = node.localName === "t" ? (node.textContent ?? "") : "\t";
    const remove = Math.min(remaining, text.length);
    if (node.localName === "t") {
      node.textContent = text.slice(remove);
      // Existing xml:space is retained; a remaining leading space also needs it.
      if (/^\s|\s$/.test(text.slice(remove)))
        node.setAttributeNS(
          "http://www.w3.org/XML/1998/namespace",
          "xml:space",
          "preserve"
        );
    } else node.parentNode!.removeChild(node);
    remaining -= remove;
  }
  if (remaining || textOf(paragraph) !== original.slice(prefix.length))
    integrity();
}

/** Append one independent native numbering definition. Existing lists retain
 * every definition and relationship. No model-supplied XML or numbering is used. */
function addListNumbering(
  pkg: Package,
  candidate: DocxListCandidate,
  touched: Set<string>
): string {
  const rels = relationships(pkg, pkg.main).filter(
    (rel) => rel.type === `${R}/numbering`
  );
  if (rels.length > 1) integrity();
  let name = rels[0]?.target;
  if (!name) {
    name = "word/numbering.xml";
    if (pkg.parts.has(name)) integrity();
    const document = new DOMParser().parseFromString(
      `<w:numbering xmlns:w="${W}"/>`,
      "application/xml"
    );
    pkg.xml.set(name, document);
    pkg.parts.set(name, Buffer.alloc(0));
    const relName = "word/_rels/document.xml.rels";
    let relDoc = pkg.xml.get(relName);
    if (!relDoc) {
      relDoc = new DOMParser().parseFromString(
        `<Relationships xmlns="${REL}"/>`,
        "application/xml"
      );
      pkg.xml.set(relName, relDoc);
      pkg.parts.set(relName, Buffer.alloc(0));
    }
    const ids = new Set(
      children(relDoc.documentElement!).map((el) => el.getAttribute("Id"))
    );
    let suffix = 1;
    while (ids.has(`rDocxList${suffix}`)) suffix++;
    const relationship = relDoc.createElementNS(REL, "Relationship");
    relationship.setAttribute("Id", `rDocxList${suffix}`);
    relationship.setAttribute("Type", `${R}/numbering`);
    relationship.setAttribute("Target", "numbering.xml");
    relDoc.documentElement!.appendChild(relationship);
    touched.add(relName);
    const types = pkg.xml.get("[Content_Types].xml")!;
    if (
      children(types.documentElement!).some(
        (el) => el.getAttribute("PartName") === `/${name}`
      )
    )
      integrity();
    const override = types.createElementNS(CT, "Override");
    override.setAttribute("PartName", `/${name}`);
    override.setAttribute(
      "ContentType",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"
    );
    types.documentElement!.appendChild(override);
    touched.add("[Content_Types].xml");
  }
  const document = pkg.xml.get(name)!;
  const root = document.documentElement!;
  const nextId = (tag: string, attr: string) => {
    const ids = descendants(root, W, tag).map((el) =>
      Number(el.getAttributeNS(W, attr))
    );
    if (
      ids.some(
        (id) => !Number.isSafeInteger(id) || id < 0 || id >= 2_000_000_000
      )
    )
      integrity();
    return String(Math.max(0, ...ids) + 1);
  };
  const abstractId = nextId("abstractNum", "abstractNumId"),
    numId = nextId("num", "numId");
  const make = (tag: string, val?: string) => {
    const el = document.createElementNS(W, `w:${tag}`);
    if (val !== undefined) setWordValue(el, val);
    return el;
  };
  const abstract = make("abstractNum");
  abstract.setAttributeNS(W, "w:abstractNumId", abstractId);
  abstract.appendChild(make("multiLevelType", "singleLevel"));
  const level = make("lvl");
  level.setAttributeNS(W, "w:ilvl", "0");
  const prefix = typedPrefix(candidate.sourceTexts[0])!;
  level.appendChild(make("start", String(candidate.start ?? 1)));
  level.appendChild(make("numFmt", candidate.kind));
  const suffix =
    prefix.separator === " "
      ? "space"
      : prefix.separator === "\t"
        ? "tab"
        : "nothing";
  level.appendChild(make("suff", suffix));
  level.appendChild(
    make(
      "lvlText",
      (candidate.kind === "bullet"
        ? candidate.marker
        : `%1${candidate.marker}`) +
        (suffix === "nothing" ? prefix.separator : "")
    )
  );
  level.appendChild(make("lvlJc", "left"));
  const markerNode = prefixNodes(
    pkg.elements.get(candidate.id)!,
    candidate.prefixes[0]
  )![0];
  const markerProperties = direct(markerNode.parentNode!, W, "rPr");
  if (markerProperties)
    level.appendChild(document.importNode(markerProperties, true));
  abstract.appendChild(level);
  const firstNum = children(root).find(
    (node) =>
      node.namespaceURI === W &&
      ["num", "numIdMacAtCleanup"].includes(node.localName ?? "")
  );
  root.insertBefore(abstract, firstNum ?? null);
  const num = make("num");
  num.setAttributeNS(W, "w:numId", numId);
  num.appendChild(make("abstractNumId", abstractId));
  root.insertBefore(num, direct(root, W, "numIdMacAtCleanup") ?? null);
  touched.add(name);
  return numId;
}

function simplifyHeaders(element: Element, layout: HeaderLayout): void {
  const beforeRows = layout.rows.slice(2).map(elementXml);
  const gridBefore = elementXml(direct(element, W, "tblGrid")!);
  for (const [index, cell] of layout.selectedCells.entries()) {
    const props = ensureProperty(cell, "tcPr", true);
    for (const name of ["vMerge", "gridSpan"]) {
      const merge = direct(props, W, name);
      if (merge) props.removeChild(merge);
    }
    const parent = layout.parentCells[index];
    if (cell !== parent) {
      const paragraph = direct(cell, W, "p")!;
      const parentParagraph = direct(parent, W, "p")!;
      const parentLabel = textOf(parentParagraph);
      const run = element.ownerDocument!.createElementNS(W, "w:r");
      const parentRun = descendants(parentParagraph, W, "r").find((r) =>
        descendants(r, W, "t").some((node) => !!node.textContent)
      );
      const parentProperties = parentRun && direct(parentRun, W, "rPr");
      if (parentProperties) run.appendChild(parentProperties.cloneNode(true));
      const text = element.ownerDocument!.createElementNS(W, "w:t");
      text.textContent = parentLabel;
      run.appendChild(text);
      run.appendChild(element.ownerDocument!.createElementNS(W, "w:br"));
      paragraph.insertBefore(
        run,
        children(paragraph).find(
          (n) => n.namespaceURI !== W || n.localName !== "pPr"
        ) ?? null
      );
      const parentProps = direct(parent, W, "tcPr");
      const shading = parentProps && direct(parentProps, W, "shd");
      if (shading) {
        const destination = ensureProperty(props, "shd");
        props.replaceChild(shading.cloneNode(true), destination);
      }
      // A copied dark header background needs the original header text color.
      const color = parentProperties && direct(parentProperties, W, "color");
      if (color)
        for (const childRun of descendants(paragraph, W, "r")) {
          const rp = ensureProperty(childRun, "rPr", true);
          const dest = ensureProperty(rp, "color");
          rp.replaceChild(color.cloneNode(true), dest);
        }
      const margin = ensureProperty(ensureProperty(props, "tcMar"), "bottom");
      margin.setAttributeNS(W, "w:w", String(layout.bottomPaddingTwips[index]));
      margin.setAttributeNS(W, "w:type", "dxa");
      if (textOf(paragraph) !== `${parentLabel}\n${layout.childLabels[index]}`)
        integrity();
    }
  }
  const row = layout.rows[0];
  for (const cell of children(row).filter(
    (n) => n.namespaceURI === W && n.localName === "tc"
  ))
    row.removeChild(cell);
  for (const cell of layout.selectedCells) row.appendChild(cell);
  element.removeChild(layout.rows[1]);
  ensureProperty(
    ensureProperty(row, "trPr", true),
    "tblHeader"
  ).removeAttributeNS(W, "val");
  if (
    beforeRows.some((xml, i) => elementXml(layout.rows[i + 2]) !== xml) ||
    elementXml(direct(element, W, "tblGrid")!) !== gridBefore
  )
    integrity();
}

function outputIdentityMap(pkg: Package): Record<string, string | null> {
  const current = new Map<Element, string>();
  const stories = new Set(pkg.inspection.paragraphs.map((p) => p.partName));
  for (const part of stories) {
    const document = pkg.xml.get(part)!;
    for (const [ns, tag, kind] of [
      [W, "p", "p"],
      [W, "tbl", "t"],
      [WP, "docPr", "i"],
    ])
      descendants(document, ns, tag).forEach((el, i) =>
        current.set(el, `${part}:${kind}:${i + 1}`)
      );
  }
  return Object.fromEntries(
    Array.from(pkg.elements, ([id, el]) => [id, current.get(el) ?? null])
  );
}
async function writeParts(parts: Map<string, Buffer>): Promise<Buffer> {
  const zip = new ZipFile();
  const chunks: Buffer[] = [];
  let length = 0;
  const result = new Promise<Buffer>((resolve, reject) => {
    zip.outputStream.on("data", (chunk: Buffer) => {
      length += chunk.length;
      if (length > LIMITS.output) {
        (zip.outputStream as Readable).destroy(
          new DocxPackageError(
            "docx_size_limit",
            "The repaired Word file exceeds the output size limit."
          )
        );
        return;
      }
      chunks.push(chunk);
    });
    zip.outputStream.on("error", reject);
    zip.outputStream.on("end", () => resolve(Buffer.concat(chunks)));
  });
  for (const [name, bytes] of parts)
    zip.addBuffer(bytes, name, { mtime: new Date("2000-01-01T00:00:00Z") });
  zip.end();
  return result;
}

export async function applyDocxRepairs(
  buffer: Buffer,
  rawPlan: DocxRepairPlan
): Promise<DocxRepairResult> {
  const plan = validateDocxRepairPlan(rawPlan);
  const pkg = await openPackage(buffer);
  const before = pkg.inspection;
  const originalParts = new Map(pkg.parts);
  for (const [reviewed, actual] of [
    [plan.reviewedParagraphIds, before.paragraphs.map((p) => p.id)],
    [plan.reviewedTableIds, before.tables.map((t) => t.id)],
    [plan.reviewedImageIds, before.images.map((i) => i.id)],
  ])
    if (
      reviewed.length !== actual.length ||
      actual.some((id) => !reviewed.includes(id))
    )
      integrity();
  const changes: DocxChange[] = [];
  const touched = new Set<string>();
  const expectedTexts = new Map(before.paragraphs.map((p) => [p.id, p.text]));
  const removedParagraphs = new Set<string>();
  const listParagraphs = new Set<string>();
  const headerParagraphs = new Set<string>();
  const expectedTables = new Map(before.tables.map((t) => [t.id, t.cells]));
  // Structural operations own their entire exact source region. A simultaneous
  // paragraph edit would otherwise depend on which operation happened first.
  for (const op of plan.operations) {
    let ids: string[] = [];
    if (op.type === "convertTypedList") {
      const candidate = before.listCandidates?.find((c) => c.id === op.id);
      if (
        !candidate ||
        op.items.length !== candidate.paragraphIds.length ||
        op.items.some(
          (item, index) =>
            item.paragraphId !== candidate.paragraphIds[index] ||
            item.sourceText !== candidate.sourceTexts[index]
        )
      )
        integrity();
      ids = candidate.paragraphIds;
    } else if (op.type === "simplifyTableHeaders") {
      const candidate = before.tables.find(
        (t) => t.id === op.id
      )?.headerCandidate;
      if (
        !candidate ||
        JSON.stringify(op.sourceCells) !== JSON.stringify(candidate.sourceCells)
      )
        integrity();
      ids = candidate.headerParagraphIds;
      if (plan.operations.some((other) => other !== op && other.id === op.id))
        integrity();
    }
    for (const id of ids) {
      if (
        listParagraphs.has(id) ||
        headerParagraphs.has(id) ||
        plan.operations.some((other) => other !== op && other.id === id)
      )
        integrity();
      (op.type === "convertTypedList" ? listParagraphs : headerParagraphs).add(
        id
      );
    }
  }
  for (const op of plan.operations) {
    const element = pkg.elements.get(op.id);
    if (!element) integrity();
    const paragraph = before.paragraphs.find((p) => p.id === op.id);
    const table = before.tables.find((t) => t.id === op.id);
    const image = before.images.find((i) => i.id === op.id);
    const object = paragraph ?? table ?? image;
    if (
      !object ||
      (!object.editable &&
        !(op.type === "simplifyTableHeaders" && table?.headerCandidate))
    )
      integrity();
    let prior = "";
    let after = "";
    let message = "";
    if (op.type === "convertTypedList") {
      const candidate = before.listCandidates!.find((c) => c.id === op.id)!;
      const numId = addListNumbering(pkg, candidate, touched);
      for (const [index, id] of candidate.paragraphIds.entries()) {
        const target = pkg.elements.get(id)!;
        // Only the verified prefix is removed. Every remaining run, hyperlink,
        // and paragraph formatting node keeps its original representation.
        stripTypedPrefix(target, candidate.prefixes[index]);
        const bodyBeforeNumbering = children(target)
          .filter((n) => n.namespaceURI !== W || n.localName !== "pPr")
          .map(elementXml);
        const pPr = ensureProperty(target, "pPr", true);
        const numPr = ensureProperty(pPr, "numPr");
        setWordValue(ensureProperty(numPr, "ilvl"), "0");
        setWordValue(ensureProperty(numPr, "numId"), numId);
        if (
          JSON.stringify(bodyBeforeNumbering) !==
          JSON.stringify(
            children(target)
              .filter((n) => n.namespaceURI !== W || n.localName !== "pPr")
              .map(elementXml)
          )
        )
          integrity();
        expectedTexts.set(
          id,
          candidate.sourceTexts[index].slice(candidate.prefixes[index].length)
        );
      }
      prior = candidate.sourceTexts.join("\n");
      after = "Native Word list with the original markers and item wording";
      message =
        "Converted the existing typed list into a native Word list, preserving its item wording and numbering.";
    } else if (op.type === "simplifyTableHeaders") {
      const layout = headerLayout(element, pkg);
      if (!layout || !table?.headerCandidate) integrity();
      const selected = new Set(
        layout.selectedCells.flatMap((cell) => descendants(cell, W, "p"))
      );
      for (const id of table.headerCandidate.headerParagraphIds) {
        if (!selected.has(pkg.elements.get(id)!)) removedParagraphs.add(id);
      }
      simplifyHeaders(element, layout);
      for (const id of table.headerCandidate.headerParagraphIds)
        if (!removedParagraphs.has(id))
          expectedTexts.set(id, textOf(pkg.elements.get(id)!));
      expectedTables.set(table.id, [
        layout.selectedCells.map((cell) => textOf(direct(cell, W, "p")!)),
        ...table.cells.slice(2),
      ]);
      prior = table.cells
        .slice(0, 2)
        .map((row) => row.join(" | "))
        .join("\n");
      after = layout.labels.join(" | ");
      message =
        "Combined the existing grouped column labels into one explicit, unmerged header row, preserving all table data.";
    } else if (op.type === "setHeading") {
      if (
        !paragraph ||
        paragraph.inTable ||
        !paragraph.text.trim() ||
        paragraph.text !== op.sourceText ||
        descendants(element, W, "drawing").length
      )
        integrity();
      prior = paragraph.headingLevel
        ? String(paragraph.headingLevel)
        : "No heading level";
      after = String(op.level);
      if (paragraph.headingLevel === op.level) continue;
      const pPr = ensureProperty(element, "pPr", true);
      const outline = ensureProperty(pPr, "outlineLvl");
      setWordValue(outline, String(op.level - 1));
      message = `Identified this existing paragraph as heading level ${op.level}, preserving its formatting.`;
    } else if (op.type === "setLanguage") {
      if (
        !paragraph ||
        paragraph.text !== op.sourceText ||
        !paragraph.text.trim()
      )
        integrity();
      prior = paragraph.language ?? "Unspecified or mixed";
      after = op.tag;
      if (paragraph.language === op.tag) continue;
      const pPr = ensureProperty(element, "pPr", true);
      setWordValue(ensureProperty(ensureProperty(pPr, "rPr"), "lang"), op.tag);
      for (const run of descendants(element, W, "r").filter(
        (r) => ancestor(r, W, "p") === element && descendants(r, W, "t").length
      ))
        setWordValue(
          ensureProperty(ensureProperty(run, "rPr", true), "lang"),
          op.tag
        );
      message = `Set the reading language for this exact paragraph to ${op.tag}.`;
    } else if (op.type === "setTableHeader") {
      if (
        !table ||
        table.complex ||
        JSON.stringify(table.cells[0]) !== JSON.stringify(op.headerTexts)
      )
        integrity();
      if (table.firstRowHeader) continue;
      const row = children(element).find(
        (item) => item.namespaceURI === W && item.localName === "tr"
      );
      if (!row) integrity();
      const trPr = ensureProperty(row, "trPr", true);
      // CT_OnOffOnly defaults to on; unlike CT_OnOff, it does not accept 1/true.
      ensureProperty(trPr, "tblHeader").removeAttributeNS(W, "val");
      prior = "No first-row heading flag";
      after = op.headerTexts.join(" | ");
      message = "Identified the existing first row as column headings.";
    } else if (op.type === "setImageDescription") {
      if (
        !image ||
        image.decorative ||
        (image.description.trim() && image.description !== op.text) ||
        image.title.trim()
      )
        integrity();
      if (image.description === op.text) continue;
      element.setAttribute("descr", op.text);
      prior = image.description;
      after = op.text;
      message = "Added an image description without changing the image.";
    } else {
      if (
        !image ||
        image.functional ||
        image.description.trim() ||
        image.title.trim()
      )
        integrity();
      if (image.decorative) continue;
      let extLst = direct(element, A, "extLst");
      if (!extLst) {
        extLst = element.ownerDocument!.createElementNS(A, "a:extLst");
        element.appendChild(extLst);
      }
      const ext = element.ownerDocument!.createElementNS(A, "a:ext");
      ext.setAttribute("uri", DECORATIVE_EXTENSION);
      const decorative = element.ownerDocument!.createElementNS(
        DECORATIVE,
        "adec:decorative"
      );
      decorative.setAttribute("val", "1");
      ext.appendChild(decorative);
      extLst.appendChild(ext);
      prior = "Not decorative";
      after = "Decorative";
      message = "Marked this nonfunctional image decorative.";
    }
    touched.add(object.partName);
    changes.push({
      type: op.type,
      id: op.id,
      location: object.location,
      message,
      before: prior,
      after,
      ...(op.type === "convertTypedList"
        ? { paragraphIds: op.items.map((item) => item.paragraphId) }
        : op.type === "simplifyTableHeaders"
          ? { paragraphIds: table!.headerCandidate!.headerParagraphIds }
          : {}),
    });
  }
  if (!changes.length)
    return {
      buffer,
      inspection: before,
      findings: checkDocxAccessibility(before),
      changes,
    };
  const changedParts = new Map(pkg.parts);
  for (const name of touched)
    changedParts.set(name, serialize(pkg.xml.get(name)!, pkg.parts.get(name)!));
  const output = await writeParts(changedParts);
  const identityMap = outputIdentityMap(pkg);
  const reopened = await openPackage(output, LIMITS.output);
  if (reopened.parts.size !== pkg.parts.size) integrity();
  for (const [name, bytes] of originalParts)
    if (!touched.has(name) && hash(reopened.parts.get(name)!) !== hash(bytes))
      integrity();
  // Every paragraph keeps its source identity, except explicitly removed header
  // paragraphs. Only declared marker removal and derived header labels may alter
  // text; structural edits cannot authorize changes elsewhere in the document.
  if (
    reopened.inspection.paragraphs.length !==
    before.paragraphs.length - removedParagraphs.size
  )
    integrity();
  for (const original of before.paragraphs) {
    const id = identityMap[original.id];
    if (removedParagraphs.has(original.id)) {
      if (id !== null) integrity();
      continue;
    }
    const current = reopened.inspection.paragraphs.find((p) => p.id === id);
    if (
      !current ||
      current.text !== expectedTexts.get(original.id) ||
      current.styleId !== original.styleId ||
      (!listParagraphs.has(original.id) &&
        JSON.stringify(current.list) !== JSON.stringify(original.list)) ||
      (!listParagraphs.has(original.id) &&
        !headerParagraphs.has(original.id) &&
        JSON.stringify(current.formatting) !==
          JSON.stringify(original.formatting))
    )
      integrity();
    if (
      listParagraphs.has(original.id) &&
      (!current.list ||
        current.list.level !== 0 ||
        current.list.format !== typedPrefix(original.text)?.kind)
    )
      integrity();
  }
  if (
    JSON.stringify(
      before.tables.map((t) => [identityMap[t.id], expectedTables.get(t.id)])
    ) !==
      JSON.stringify(reopened.inspection.tables.map((t) => [t.id, t.cells])) ||
    JSON.stringify(
      before.images.map((i) => [
        identityMap[i.id],
        i.name,
        i.functional,
        i.title,
      ])
    ) !==
      JSON.stringify(
        reopened.inspection.images.map((i) => [
          i.id,
          i.name,
          i.functional,
          i.title,
        ])
      )
  )
    integrity();
  for (const change of changes) {
    const op = plan.operations.find(
      (item) => item.type === change.type && item.id === change.id
    )!;
    const p = reopened.inspection.paragraphs.find(
      (item) => item.id === identityMap[change.id]
    );
    const i = reopened.inspection.images.find(
      (item) => item.id === identityMap[change.id]
    );
    const t = reopened.inspection.tables.find(
      (item) => item.id === identityMap[change.id]
    );
    if (
      (op.type === "setHeading" && p?.headingLevel !== op.level) ||
      (op.type === "setLanguage" && p?.language !== op.tag) ||
      (op.type === "setTableHeader" && !t?.firstRowHeader) ||
      (op.type === "simplifyTableHeaders" &&
        (!t?.firstRowHeader || t.complex)) ||
      (op.type === "setImageDescription" && i?.description !== op.text) ||
      (op.type === "setDecorative" && !i?.decorative)
    )
      integrity();
  }
  return {
    buffer: output,
    inspection: reopened.inspection,
    findings: checkDocxAccessibility(reopened.inspection),
    changes,
    identityMap,
  };
}
