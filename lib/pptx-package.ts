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
  buildTableCaptionPatch,
  pptxElementHash,
  type TableCaptionPatch,
} from "./pptx-table-caption";
import type {
  PptxChange,
  PptxFinding,
  PptxInspection,
  PptxObject,
  PptxRect,
  PptxRepairPlan,
  PptxRepairResult,
  PptxSlide,
  PptxSlideRepairs,
} from "./pptx-types";

export type * from "./pptx-types";

const P = "http://schemas.openxmlformats.org/presentationml/2006/main";
const A = "http://schemas.openxmlformats.org/drawingml/2006/main";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const REL = "http://schemas.openxmlformats.org/package/2006/relationships";
const CT = "http://schemas.openxmlformats.org/package/2006/content-types";
const DECORATIVE =
  "http://schemas.microsoft.com/office/drawing/2017/decorative";
const MAIN_TYPE =
  "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml";
const SLIDE_TYPE =
  "application/vnd.openxmlformats-officedocument.presentationml.slide+xml";
const LIMITS = {
  input: 4 * 1024 * 1024,
  output: 4 * 1024 * 1024,
  entries: 2000,
  inflated: 64 * 1024 * 1024,
  part: 16 * 1024 * 1024,
  xml: 2 * 1024 * 1024,
  totalXml: 20 * 1024 * 1024,
  nodes: 50_000,
  totalNodes: 250_000,
  depth: 100,
  slides: 60,
  objects: 1500,
  text: 8000,
};

export class PptxPackageError extends Error {
  constructor(
    public readonly code:
      | "pptx_invalid"
      | "pptx_size_limit"
      | "pptx_complexity_limit"
      | "pptx_unsupported"
      | "pptx_signed"
      | "pptx_integrity",
    message: string
  ) {
    super(message);
    this.name = "PptxPackageError";
  }
}

function fail(
  message = "This PowerPoint package is damaged or has an unsupported structure."
): never {
  throw new PptxPackageError("pptx_invalid", message);
}
function complex(): never {
  throw new PptxPackageError(
    "pptx_complexity_limit",
    "This presentation exceeds the safe package-processing limits. Split it into smaller presentations and try again."
  );
}
const hash = (buffer: Buffer) =>
  createHash("sha256").update(buffer).digest("hex");
const flag = (value: string | null) => value === "1" || value === "true";
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
const same = (a: string[], b: string[]) =>
  a.length === b.length && a.every((value, index) => value === b[index]);

// Do not expose untrusted parser/ZIP exception text: it can contain document content.
function parseXml(
  bytes: Buffer,
  budget = { nodes: 0, deadline: Date.now() + 15_000 }
): Document {
  if (bytes.length > LIMITS.xml) complex();
  let xml: string;
  try {
    xml = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return fail(
      "This presentation uses an unsupported XML encoding. Save it as a new .pptx in PowerPoint and try again."
    );
  }
  if (/<!DOCTYPE|<!ENTITY/i.test(xml))
    return fail(
      "This presentation contains XML declarations that cannot be processed safely."
    );
  const declaredEncoding = xml.match(
    /^\s*<\?xml[^?]*encoding\s*=\s*["']([^"']+)["']/i
  )?.[1];
  if (declaredEncoding && !/^utf-?8$/i.test(declaredEncoding))
    return fail(
      "This presentation uses an unsupported XML encoding. Save it as a new .pptx in PowerPoint and try again."
    );
  let depth = 0;
  let count = 0;
  try {
    const sax = new SaxesParser({ xmlns: true });
    sax.on("doctype", () => fail());
    sax.on("opentag", (tag) => {
      if (
        ++depth > LIMITS.depth ||
        ++count > LIMITS.nodes ||
        ++budget.nodes > LIMITS.totalNodes ||
        Date.now() > budget.deadline ||
        Object.keys(tag.attributes).length > 128
      )
        complex();
      if (
        Object.values(tag.attributes).some(
          (attribute) => attribute.value.length > 32_000
        )
      )
        complex();
    });
    sax.on("closetag", () => {
      depth--;
    });
    sax.on("error", () => fail());
    sax.write(xml).close();
    return new DOMParser({ onError: () => fail() }).parseFromString(
      xml,
      "application/xml"
    );
  } catch (error) {
    if (error instanceof PptxPackageError) throw error;
    return fail();
  }
}

function serializeXml(document: Document, original: Buffer): Buffer {
  // xmldom represents the declaration as an "xml" processing instruction, but
  // its strict serializer correctly disallows that reserved PI target. Keep
  // the declaration already validated by saxes outside the DOM serialization.
  const declaration = original
    .toString("utf8")
    .match(/^\uFEFF?(<\?xml\s[\s\S]*?\?>)/)?.[1];
  const serializable = document.cloneNode(true) as Document;
  const declarationNode = Array.from(serializable.childNodes).find(
    (node) => node.nodeType === 7 && node.nodeName === "xml"
  );
  if (Boolean(declarationNode) !== Boolean(declaration)) fail();
  if (declarationNode) serializable.removeChild(declarationNode);
  return Buffer.from(
    (declaration ?? "") +
      new XMLSerializer().serializeToString(serializable, {
        requireWellFormed: true,
      }),
    "utf8"
  );
}

interface Part {
  bytes: Buffer;
  originalHash: string;
}
interface Relationship {
  id: string;
  type: string;
  target: string;
  external: boolean;
}
interface Package {
  parts: Map<string, Part>;
  xml: Map<string, Document>;
  slides: InternalSlide[];
  inspection: PptxInspection;
}
interface InternalObject {
  element: Element;
  properties: Element;
  info: PptxObject;
}
interface InternalSlide {
  document: Document;
  tree: Element;
  objects: InternalObject[];
  info: PptxSlide;
  placeholderIndices: Set<string>;
  sourceTextStyles: Element[];
  captionPatches: TableCaptionPatch[];
}

function validPartName(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= 300 &&
    !name.startsWith("/") &&
    !/[\\\u0000-\u001f\u007f%:#?]/.test(name) &&
    !name
      .split("/")
      .some((segment) => segment === ".." || segment === "." || segment === "")
  );
}

const crcTable = Array.from({ length: 256 }, (_, start) => {
  let value = start;
  for (let n = 0; n < 8; n++)
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

async function readParts(
  buffer: Buffer,
  maxBytes = LIMITS.input
): Promise<Map<string, Part>> {
  if (buffer.length === 0 || buffer.length > maxBytes)
    throw new PptxPackageError(
      "pptx_size_limit",
      "PowerPoint files must be nonempty and no larger than 4 MB."
    );
  if (buffer.length < 4 || buffer.readUInt32LE(0) !== 0x04034b50)
    return fail(
      "Upload an unencrypted .pptx file. Older .ppt files and password-protected presentations are not supported."
    );
  const parts = new Map<string, Part>();
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
          ![0, 8].includes(entry.compressionMethod)
        )
          return fail(
            "This presentation contains an encrypted or unsupported package entry."
          );
        if (((entry.externalFileAttributes >>> 16) & 0xf000) === 0xa000) fail();
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
          if (Date.now() > deadline) {
            stream.destroy();
            complex();
          }
          length += chunk.length;
          if (length > entry.uncompressedSize || length > LIMITS.part) {
            stream.destroy();
            complex();
          }
          chunks.push(Buffer.from(chunk));
        }
        const bytes = Buffer.concat(chunks);
        if (length !== entry.uncompressedSize || crc32(bytes) !== entry.crc32)
          fail();
        if (directory) {
          if (bytes.length > 0) fail();
          continue;
        }
        parts.set(name, { bytes, originalHash: hash(bytes) });
      }
    } finally {
      zip.close();
    }
  } catch (error) {
    if (error instanceof PptxPackageError) throw error;
    fail();
  }
  return parts;
}

function xmlPart(pkg: Pick<Package, "parts" | "xml">, name: string): Document {
  const cached = pkg.xml.get(name);
  if (cached) return cached;
  const part = pkg.parts.get(name);
  if (!part) return fail();
  const document = parseXml(part.bytes);
  pkg.xml.set(name, document);
  return document;
}

function relationshipPart(source: string): string {
  return source
    ? `${path.posix.dirname(source) === "." ? "" : path.posix.dirname(source) + "/"}_rels/${path.posix.basename(source)}.rels`
    : "_rels/.rels";
}

function relationships(
  pkg: Pick<Package, "parts" | "xml">,
  source: string
): Relationship[] {
  const part = relationshipPart(source);
  if (!pkg.parts.has(part)) return [];
  const document = xmlPart(pkg, part);
  if (
    document.documentElement?.namespaceURI !== REL ||
    document.documentElement.localName !== "Relationships"
  )
    return fail();
  const ids = new Set<string>();
  return children(document.documentElement).map((element) => {
    if (element.namespaceURI !== REL || element.localName !== "Relationship")
      return fail();
    const id = element.getAttribute("Id") ?? "";
    const type = element.getAttribute("Type") ?? "";
    const target = element.getAttribute("Target") ?? "";
    if (!id || ids.has(id) || !type || !target) return fail();
    ids.add(id);
    const external = element.getAttribute("TargetMode") === "External";
    if (
      element.hasAttribute("TargetMode") &&
      !external &&
      element.getAttribute("TargetMode") !== "Internal"
    )
      return fail();
    if (external) return { id, type, target, external };
    if (/[\\\u0000-\u001f\u007f:#?%]/.test(target)) return fail();
    const resolved = target.startsWith("/")
      ? target.slice(1)
      : path.posix.normalize(
          path.posix.join(path.posix.dirname(source), target)
        );
    if (!validPartName(resolved) || !pkg.parts.has(resolved)) return fail();
    return { id, type, target: resolved, external };
  });
}

function finding(
  code: string,
  message: string,
  suggestion: string,
  slideNumber?: number,
  objectId?: string,
  severity: "warning" | "error" = "warning"
): PptxFinding {
  return {
    code,
    severity,
    ...(slideNumber !== undefined ? { slideNumber } : {}),
    ...(objectId ? { objectId } : {}),
    message,
    suggestion,
  };
}

function textOf(element: Element): string {
  const paragraphs = descendants(element, A, "p");
  const text = paragraphs
    .map((paragraph) =>
      descendants(paragraph, A, "t")
        .map((run) => run.textContent ?? "")
        .join("")
    )
    .join("\n");
  if (text.length > LIMITS.text) complex();
  return text;
}

function rectangle(element: Element): PptxRect | null {
  const properties =
    direct(element, P, "spPr") ?? direct(element, P, "grpSpPr");
  const transform =
    direct(element, P, "xfrm") ?? (properties && direct(properties, A, "xfrm"));
  if (
    !transform ||
    (transform.hasAttribute("rot") &&
      Number(transform.getAttribute("rot")) % 21600000 !== 0)
  )
    return null;
  const offset = direct(transform, A, "off");
  const extent = direct(transform, A, "ext");
  if (!offset || !extent) return null;
  const values = [
    offset.getAttribute("x"),
    offset.getAttribute("y"),
    extent.getAttribute("cx"),
    extent.getAttribute("cy"),
  ];
  if (values.some((value) => value === null || !/^-?\d+$/.test(value)))
    return null;
  const [x, y, width, height] = values.map(Number);
  if (
    [x, y, width, height].some(
      (value) => !Number.isSafeInteger(value) || Math.abs(value) > 1_000_000_000
    ) ||
    width <= 0 ||
    height <= 0
  )
    return null;
  return { x, y, width, height };
}

function objectProperties(element: Element): Element | undefined {
  const container = children(element).find(
    (child) =>
      child.namespaceURI === P &&
      [
        "nvSpPr",
        "nvPicPr",
        "nvGraphicFramePr",
        "nvGrpSpPr",
        "nvCxnSpPr",
      ].includes(child.localName ?? "")
  );
  return container && direct(container, P, "cNvPr");
}

function placeholder(element: Element): Element | undefined {
  const container = children(element).find(
    (child) =>
      child.namespaceURI === P &&
      ["nvSpPr", "nvPicPr", "nvGraphicFramePr"].includes(child.localName ?? "")
  );
  const properties = container && direct(container, P, "nvPr");
  return properties && direct(properties, P, "ph");
}

function tableInfo(table: Element): NonNullable<PptxObject["table"]> {
  const rows = children(table).filter(
    (child) => child.namespaceURI === A && child.localName === "tr"
  );
  const grid = direct(table, A, "tblGrid");
  const columns = grid
    ? children(grid).filter(
        (child) => child.namespaceURI === A && child.localName === "gridCol"
      ).length
    : 0;
  if (rows.length > 100 || columns > 30) complex();
  const rowCells = rows.map((row) =>
    children(row).filter(
      (child) => child.namespaceURI === A && child.localName === "tc"
    )
  );
  const properties = direct(table, A, "tblPr");
  return {
    rows: rows.length,
    columns,
    firstRow: flag(properties?.getAttribute("firstRow") ?? null),
    firstColumn: flag(properties?.getAttribute("firstCol") ?? null),
    complex:
      columns === 0 ||
      rowCells.some(
        (cells) =>
          cells.length !== columns ||
          cells.some(
            (cell) =>
              ["gridSpan", "rowSpan"].some(
                (attribute) =>
                  cell.hasAttribute(attribute) &&
                  cell.getAttribute(attribute) !== "1"
              ) ||
              ["hMerge", "vMerge"].some((attribute) =>
                flag(cell.getAttribute(attribute))
              )
          )
      ),
    cells: rowCells.map((cells) => cells.map(textOf)),
  };
}

function inspectObjects(
  tree: Element,
  slideNumber: number,
  findings: PptxFinding[],
  layout?: Document
): InternalObject[] {
  const result: InternalObject[] = [];
  const ids = new Set<string>();
  const layoutShapes = layout ? descendants(layout, P, "sp") : [];
  function visit(element: Element, parentId: string | null): void {
    if (
      element.namespaceURI !== P ||
      !["sp", "pic", "graphicFrame", "grpSp", "cxnSp"].includes(
        element.localName ?? ""
      )
    ) {
      if (!["nvGrpSpPr", "grpSpPr", "extLst"].includes(element.localName ?? ""))
        findings.push(
          finding(
            "unsupported-object",
            "This slide contains an object this version cannot edit safely.",
            "Review the slide in PowerPoint's Accessibility Checker and Reading Order pane.",
            slideNumber
          )
        );
      return;
    }
    const properties = objectProperties(element);
    const id = properties?.getAttribute("id") ?? "";
    if (
      !properties ||
      !/^\d{1,10}$/.test(id) ||
      Number(id) < 1 ||
      Number(id) > 0xffffffff ||
      ids.has(id)
    )
      fail();
    ids.add(id);
    const text = element.localName === "grpSp" ? "" : textOf(element);
    const table = descendants(element, A, "tbl")[0];
    const data = descendants(element, A, "graphicData")[0];
    const media =
      descendants(element, A, "videoFile").length > 0 ||
      descendants(element, A, "audioFile").length > 0 ||
      descendants(element, P, "oleObj").length > 0;
    const kind: PptxObject["kind"] =
      element.localName === "grpSp"
        ? "group"
        : media
          ? "media"
          : table
            ? "table"
            : data?.getAttribute("uri")?.includes("/chart")
              ? "chart"
              : data?.getAttribute("uri")?.includes("/diagram")
                ? "smartart"
                : element.localName === "pic"
                  ? "image"
                  : element.localName === "graphicFrame"
                    ? "unsupported"
                    : text.trim()
                      ? "text"
                      : "shape";
    const ph = placeholder(element);
    const inherited =
      ph &&
      layoutShapes.find((shape) => {
        const other = placeholder(shape);
        return (
          other &&
          (other.getAttribute("idx") ?? "0") === (ph.getAttribute("idx") ?? "0")
        );
      });
    const phType =
      ph?.getAttribute("type") ||
      (inherited && placeholder(inherited)?.getAttribute("type"));
    const description = properties.getAttribute("descr") ?? "";
    const title = properties.getAttribute("title") ?? "";
    if (description.length > 8000 || title.length > 1000) complex();
    const languages = [
      ...new Set(
        descendants(element, A, "rPr")
          .map((run) => run.getAttribute("lang"))
          .filter((value): value is string => !!value)
      ),
    ];
    const info: PptxObject = {
      id,
      name: (properties.getAttribute("name") ?? "").slice(0, 240),
      kind,
      text,
      description,
      title,
      decorative: descendants(properties, DECORATIVE, "decorative").some(
        (node) => flag(node.getAttribute("val"))
      ),
      isTitle: ["title", "ctrTitle"].includes(phType ?? ""),
      hidden: flag(properties.getAttribute("hidden")),
      rect: rectangle(element) ?? (inherited ? rectangle(inherited) : null),
      grouped: parentId !== null,
      parentId,
      language: languages.length === 1 ? languages[0] : null,
      ...(table && kind === "table" ? { table: tableInfo(table) } : {}),
    };
    result.push({ element, properties, info });
    if (result.length > LIMITS.objects) complex();
    if (kind === "group") {
      findings.push(
        finding(
          "group-review",
          "This group keeps its existing structure and reading order.",
          "On this slide, check that the grouped objects are read in a meaningful order in PowerPoint.",
          slideNumber,
          id
        )
      );
      for (const child of children(element)) visit(child, id);
    }
    if (["chart", "smartart", "media", "unsupported"].includes(kind))
      findings.push(
        finding(
          "complex-object-review",
          `This ${kind === "media" ? "media or embedded" : kind} object needs a check in PowerPoint.`,
          "Check the object's description and reading order. For audio or video, provide accurate captions or a transcript; for charts or diagrams, explain the essential data and relationships.",
          slideNumber,
          id
        )
      );
    if (info.table?.complex)
      findings.push(
        finding(
          "complex-table-review",
          "This table has merged cells or an irregular structure.",
          "Check the table's reading order and labels in PowerPoint. A simpler table may be needed so each value has an unambiguous label.",
          slideNumber,
          id
        )
      );
  }
  for (const child of children(tree)) visit(child, null);
  return result;
}

async function loadPackage(
  buffer: Buffer,
  maxBytes = LIMITS.input
): Promise<Package> {
  const parts = await readParts(buffer, maxBytes);
  const pkg: Package = {
    parts,
    xml: new Map(),
    slides: [],
    inspection: {
      slideCount: 0,
      width: 0,
      height: 0,
      slides: [],
      findings: [],
    },
  };
  const xmlBudget = { nodes: 0, deadline: Date.now() + 15_000 };
  // Parse every XML/relationship part, including unused parts, before returning any output.
  for (const [name, part] of parts) {
    if (/^_xmlsignatures\//i.test(name))
      throw new PptxPackageError(
        "pptx_signed",
        "This presentation is digitally signed. Editing it would invalidate the signature; use an unsigned working copy."
      );
    if (
      /(?:^|\/)vbaProject\.bin$/i.test(name) ||
      /(?:^|\/)activeX\//i.test(name)
    )
      throw new PptxPackageError(
        "pptx_unsupported",
        "Presentations with macros or ActiveX controls are not supported. Use a standard .pptx working copy."
      );
    if (/\.(?:xml|rels|vml|svg)$/i.test(name))
      pkg.xml.set(name, parseXml(part.bytes, xmlBudget));
  }
  const contentTypes = xmlPart(pkg, "[Content_Types].xml");
  if (
    contentTypes.documentElement?.namespaceURI !== CT ||
    contentTypes.documentElement.localName !== "Types"
  )
    fail();
  const overrides = new Map<string, string>();
  const defaults = new Map<string, string>();
  for (const element of children(contentTypes.documentElement)) {
    if (
      element.namespaceURI !== CT ||
      !["Default", "Override"].includes(element.localName ?? "")
    )
      fail();
    const contentType = element.getAttribute("ContentType") ?? "";
    if (/macroEnabled|vbaProject|activeX/i.test(contentType))
      throw new PptxPackageError(
        "pptx_unsupported",
        "Macro-enabled presentations are not supported. Save a standard .pptx working copy."
      );
    if (/digital-signature/i.test(contentType))
      throw new PptxPackageError(
        "pptx_signed",
        "This presentation is digitally signed. Use an unsigned working copy."
      );
    if (element.localName === "Override") {
      const name = element.getAttribute("PartName")?.replace(/^\//, "") ?? "";
      if (!parts.has(name) || overrides.has(name)) fail();
      overrides.set(name, contentType);
    } else {
      const extension = element.getAttribute("Extension")?.toLowerCase() ?? "";
      if (!extension || defaults.has(extension)) fail();
      defaults.set(extension, contentType);
    }
  }
  // Package content types can declare XML using an unusual filename extension.
  // Inspect these as XML too, rather than trusting the extension alone.
  for (const [name, part] of parts) {
    const contentType =
      overrides.get(name) ??
      defaults.get(path.posix.extname(name).slice(1).toLowerCase()) ??
      "";
    if (/(?:\/xml|\+xml)$/i.test(contentType) && !pkg.xml.has(name))
      pkg.xml.set(name, parseXml(part.bytes, xmlBudget));
  }
  const roots = relationships(pkg, "").filter((rel) =>
    rel.type.endsWith("/officeDocument")
  );
  if (
    roots.length !== 1 ||
    roots[0].external ||
    overrides.get(roots[0].target) !== MAIN_TYPE
  )
    fail(
      "This file is not a supported standard PowerPoint presentation. Save it as .pptx in PowerPoint."
    );
  const presentationName = roots[0].target;
  const presentation = xmlPart(pkg, presentationName);
  if (presentation.documentElement?.namespaceURI !== P)
    throw new PptxPackageError(
      "pptx_unsupported",
      "Strict Open XML presentations are not supported in this version. Save a standard PowerPoint Presentation (.pptx) copy."
    );
  if (presentation.documentElement.localName !== "presentation") fail();
  const slideIds = direct(presentation.documentElement, P, "sldIdLst");
  const slideList = slideIds ? children(slideIds) : [];
  if (slideList.length === 0 || slideList.length > LIMITS.slides) complex();
  const size = direct(presentation.documentElement, P, "sldSz");
  const width = Number(size?.getAttribute("cx"));
  const height = Number(size?.getAttribute("cy"));
  if (
    ![width, height].every(
      (number) =>
        Number.isSafeInteger(number) && number > 0 && number < 1_000_000_000
    )
  )
    fail();
  const rels = relationships(pkg, presentationName);
  const usedSlides = new Set<string>();
  const usedSlideIds = new Set<string>();
  const findings: PptxFinding[] = [];
  // Resolve every internal relationship without following any external target.
  for (const name of parts.keys()) {
    if (name.endsWith(".rels")) {
      const source =
        name === "_rels/.rels"
          ? ""
          : name.replace(/(^|\/)_rels\//, "$1").replace(/\.rels$/, "");
      for (const rel of relationships(pkg, source)) {
        if (rel.external && !rel.type.endsWith("/hyperlink"))
          findings.push(
            finding(
              "external-content",
              "The presentation contains linked content stored outside the file.",
              "Check linked images, audio, video, or objects in PowerPoint. This converter does not download them, and they may be unavailable to students."
            )
          );
      }
    }
  }
  slideList.forEach((slideId, index) => {
    const number = index + 1;
    const id = slideId.getAttribute("id") ?? "";
    if (
      slideId.namespaceURI !== P ||
      slideId.localName !== "sldId" ||
      !id ||
      usedSlideIds.has(id)
    )
      fail();
    usedSlideIds.add(id);
    const target = rels.find(
      (rel) =>
        rel.id === slideId.getAttributeNS(R, "id") &&
        rel.type === `${R}/slide` &&
        !rel.external
    )?.target;
    if (
      !target ||
      usedSlides.has(target) ||
      overrides.get(target) !== SLIDE_TYPE
    )
      fail();
    usedSlides.add(target);
    const document = xmlPart(pkg, target);
    const root = document.documentElement;
    if (!root || root.namespaceURI !== P || root.localName !== "sld") fail();
    const common = direct(root, P, "cSld");
    const tree = common && direct(common, P, "spTree");
    if (!tree) fail();
    const slideRels = relationships(pkg, target);
    const layoutRel = slideRels.find(
      (rel) => rel.type === `${R}/slideLayout` && !rel.external
    );
    const layout = layoutRel ? xmlPart(pkg, layoutRel.target) : undefined;
    const masterRel = layoutRel
      ? relationships(pkg, layoutRel.target).find(
          (rel) => rel.type === `${R}/slideMaster` && !rel.external
        )
      : undefined;
    const master = masterRel ? xmlPart(pkg, masterRel.target) : undefined;
    const masterStyles = master?.documentElement
      ? direct(master.documentElement, P, "txStyles")
      : undefined;
    const otherStyle = masterStyles && direct(masterStyles, P, "otherStyle");
    const defaultStyle = direct(
      presentation.documentElement!,
      P,
      "defaultTextStyle"
    );
    const objects = inspectObjects(tree, number, findings, layout);
    const hidden =
      root.getAttribute("show") === "0" ||
      root.getAttribute("show") === "false";
    if (hidden)
      findings.push(
        finding(
          "hidden-slide",
          "This slide is hidden in the presentation. It remains hidden in the returned file.",
          "Check whether students should receive this slide and review its content along with the visible slides.",
          number
        )
      );
    if (objects.some((object) => object.info.hidden))
      findings.push(
        finding(
          "hidden-object",
          "This slide contains hidden objects, which are preserved.",
          "Check whether these objects are intended to be available to students.",
          number
        )
      );
    const info: PptxSlide = {
      slideNumber: number,
      partName: target,
      hidden,
      hasTiming: descendants(document, P, "timing").length > 0,
      hasExternalContent: slideRels.some(
        (rel) => rel.external && !rel.type.endsWith("/hyperlink")
      ),
      objects: objects.map((object) => object.info),
    };
    pkg.slides.push({
      document,
      tree,
      objects,
      info,
      sourceTextStyles: [otherStyle, defaultStyle].filter(
        (style): style is Element => Boolean(style)
      ),
      captionPatches: [],
      placeholderIndices: new Set(
        [
          ...descendants(document, P, "ph"),
          ...(layout ? descendants(layout, P, "ph") : []),
        ].map((ph) => ph.getAttribute("idx") ?? "0")
      ),
    });
  });
  if (
    pkg.slides.reduce((total, slide) => total + slide.objects.length, 0) >
    LIMITS.objects
  )
    complex();
  if ([...parts.keys()].some((name) => /(?:^|\/)embeddings\//.test(name)))
    findings.push(
      finding(
        "embedded-object",
        "This presentation contains embedded files. They remain embedded and have not been opened or remediated.",
        "Review the embedded files separately and provide accessible alternatives if students need their content."
      )
    );
  pkg.inspection = {
    slideCount: pkg.slides.length,
    width,
    height,
    slides: pkg.slides.map((slide) => slide.info),
    findings,
  };
  return pkg;
}

export async function inspectPptx(buffer: Buffer): Promise<PptxInspection> {
  return (await loadPackage(buffer)).inspection;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function onlyKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}
function id(value: unknown): value is string {
  return typeof value === "string" && /^\d{1,10}$/.test(value);
}
function validText(value: unknown, length: number): value is string {
  return (
    typeof value === "string" &&
    value.isWellFormed() &&
    value.trim().length > 0 &&
    value.length <= length &&
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
  );
}

/** Strict plan validation happens before any edit; unrecognized operations are never executed. */
export function validatePptxRepairPlan(
  value: unknown
): value is PptxRepairPlan {
  if (
    !isRecord(value) ||
    !onlyKeys(value, ["slides"]) ||
    !Array.isArray(value.slides) ||
    value.slides.length > LIMITS.slides
  )
    return false;
  const slides = new Set<number>();
  return value.slides.every((slide) => {
    if (
      !isRecord(slide) ||
      !onlyKeys(slide, [
        "slideNumber",
        "titleObjectId",
        "descriptions",
        "tableHeaders",
        "splitTableCaption",
        "readingOrder",
        "language",
      ]) ||
      !Number.isSafeInteger(slide.slideNumber) ||
      (slide.slideNumber as number) < 1 ||
      (slide.slideNumber as number) > LIMITS.slides ||
      slides.has(slide.slideNumber as number)
    )
      return false;
    slides.add(slide.slideNumber as number);
    if (slide.titleObjectId !== undefined && !id(slide.titleObjectId))
      return false;
    if (
      slide.descriptions !== undefined &&
      (!Array.isArray(slide.descriptions) ||
        slide.descriptions.length > 300 ||
        !slide.descriptions.every(
          (description) =>
            isRecord(description) &&
            onlyKeys(description, ["objectId", "text"]) &&
            id(description.objectId) &&
            validText(description.text, 2000)
        ) ||
        new Set(slide.descriptions.map((description) => description.objectId))
          .size !== slide.descriptions.length)
    )
      return false;
    if (
      slide.tableHeaders !== undefined &&
      (!Array.isArray(slide.tableHeaders) ||
        slide.tableHeaders.length > 100 ||
        !slide.tableHeaders.every(
          (table) =>
            isRecord(table) &&
            onlyKeys(table, ["objectId", "firstRow", "headerTexts"]) &&
            id(table.objectId) &&
            table.firstRow === true &&
            Array.isArray(table.headerTexts) &&
            table.headerTexts.length <= 30 &&
            table.headerTexts.every((text: unknown) =>
              validText(text, LIMITS.text)
            )
        ) ||
        new Set(slide.tableHeaders.map((table) => table.objectId)).size !==
          slide.tableHeaders.length)
    )
      return false;
    if (
      slide.splitTableCaption !== undefined &&
      (!Array.isArray(slide.splitTableCaption) ||
        slide.splitTableCaption.length > 10 ||
        !slide.splitTableCaption.every(
          (table) =>
            isRecord(table) &&
            onlyKeys(table, [
              "objectId",
              "captionText",
              "headerTexts",
              "sourceCells",
            ]) &&
            id(table.objectId) &&
            validText(table.captionText, 200) &&
            Array.isArray(table.headerTexts) &&
            table.headerTexts.length === 2 &&
            table.headerTexts.every((text: unknown) => validText(text, 60)) &&
            Array.isArray(table.sourceCells) &&
            table.sourceCells.length >= 2 &&
            table.sourceCells.length <= 30 &&
            table.sourceCells.every(
              (row: unknown) =>
                Array.isArray(row) &&
                row.length === 2 &&
                row.every(
                  (text: unknown) =>
                    typeof text === "string" &&
                    text.length <= LIMITS.text &&
                    text.isWellFormed() &&
                    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)
                )
            )
        ) ||
        new Set(slide.splitTableCaption.map((table) => table.objectId)).size !==
          slide.splitTableCaption.length)
    )
      return false;
    if (
      slide.readingOrder !== undefined &&
      (!Array.isArray(slide.readingOrder) ||
        slide.readingOrder.length > 300 ||
        !slide.readingOrder.every(id) ||
        new Set(slide.readingOrder).size !== slide.readingOrder.length)
    )
      return false;
    if (
      slide.language !== undefined &&
      (!isRecord(slide.language) ||
        !onlyKeys(slide.language, ["tag", "evidenceText"]) ||
        typeof slide.language.tag !== "string" ||
        !/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$/.test(slide.language.tag) ||
        !validText(slide.language.evidenceText, 1000))
    )
      return false;
    return true;
  });
}

function overlapping(first: PptxRect, second: PptxRect): boolean {
  return (
    first.x < second.x + second.width &&
    first.x + first.width > second.x &&
    first.y < second.y + second.height &&
    first.y + first.height > second.y
  );
}

/** Keep the ordinary text box's spacing when titleStyle begins to apply. */
function preserveTitleLineSpacing(
  slide: InternalSlide,
  object: InternalObject
) {
  const body = direct(object.element, P, "txBody");
  if (!body) return;
  const localStyle = direct(body, A, "lstStyle");
  const styles = [localStyle, ...slide.sourceTextStyles].filter(
    (style): style is Element => Boolean(style)
  );
  for (const paragraph of children(body).filter(
    (child) => child.namespaceURI === A && child.localName === "p"
  )) {
    let properties = direct(paragraph, A, "pPr");
    if (properties && direct(properties, A, "lnSpc")) continue;
    const level = Number(properties?.getAttribute("lvl") || "0");
    if (!Number.isInteger(level) || level < 0 || level > 8) fail();
    let inherited: Element | undefined;
    for (const style of styles) {
      const levelStyle = direct(style, A, `lvl${level + 1}pPr`);
      const defaultStyle = direct(style, A, "defPPr");
      inherited =
        (levelStyle && direct(levelStyle, A, "lnSpc")) ||
        (defaultStyle && direct(defaultStyle, A, "lnSpc"));
      if (inherited) break;
    }
    if (!properties) {
      properties = slide.document.createElementNS(A, "a:pPr");
      paragraph.insertBefore(properties, paragraph.firstChild);
    }
    const spacing = inherited
      ? slide.document.importNode(inherited, true)
      : slide.document.createElementNS(A, "a:lnSpc");
    if (!inherited) {
      // DrawingML's omitted spacing is a single line based on the largest run.
      const percent = slide.document.createElementNS(A, "a:spcPct");
      percent.setAttribute("val", "100000");
      spacing.appendChild(percent);
    }
    properties.insertBefore(spacing, properties.firstChild);
  }
}

function applySlide(
  slide: InternalSlide,
  repair: PptxSlideRepairs,
  changes: PptxChange[],
  findings: PptxFinding[]
): boolean {
  const slideNumber = slide.info.slideNumber;
  const before = changes.length;
  const getObject = (id: string) =>
    slide.objects.find((object) => object.info.id === id);
  const review = (
    code: string,
    message: string,
    suggestion: string,
    objectId?: string
  ) => findings.push(finding(code, message, suggestion, slideNumber, objectId));
  if (repair.titleObjectId !== undefined) {
    const object = getObject(repair.titleObjectId);
    const existing = slide.objects.filter((item) => item.info.isTitle);
    if (object?.info.isTitle) {
      /* already has the requested semantics */
    } else if (
      !object ||
      object.info.kind !== "text" ||
      object.info.grouped ||
      object.info.hidden ||
      object.info.decorative ||
      placeholder(object.element) !== undefined ||
      rectangle(object.element) === null ||
      slide.info.hasTiming ||
      !object.info.text.trim() ||
      existing.length > 0
    )
      review(
        "title-review",
        "The proposed slide title could not be applied without changing existing slide structure.",
        "In PowerPoint, use Accessibility > Slide Title to identify a unique, meaningful title for this slide.",
        repair.titleObjectId
      );
    else {
      const nonvisual = direct(object.element, P, "nvSpPr");
      const properties = nonvisual && direct(nonvisual, P, "nvPr");
      if (!properties)
        review(
          "title-review",
          "This text object cannot safely be turned into a slide title.",
          "Set the slide title in PowerPoint's Accessibility tools.",
          object.info.id
        );
      else {
        preserveTitleLineSpacing(slide, object);
        // Do not repurpose a body/content placeholder or accidentally match its
        // layout index. Ordinary text boxes get a new, unused placeholder index.
        let index = 0;
        while (slide.placeholderIndices.has(String(index))) index++;
        const ph = slide.document.createElementNS(P, "p:ph");
        properties.insertBefore(ph, properties.firstChild);
        ph.setAttribute("type", "title");
        ph.setAttribute("idx", String(index));
        slide.placeholderIndices.add(String(index));
        changes.push({
          type: "title",
          slideNumber,
          objectId: object.info.id,
          message:
            "Identified the existing text object as the slide title; kept its wording.",
        });
      }
    }
  }
  for (const description of repair.descriptions ?? []) {
    const object = getObject(description.objectId);
    if (
      !object ||
      !["image", "chart", "smartart", "shape", "media"].includes(
        object.info.kind
      ) ||
      object.info.hidden
    )
      review(
        "description-review",
        "The proposed image description could not be matched to a supported visible object.",
        "Select this object in PowerPoint and check its Alt Text pane.",
        description.objectId
      );
    else if (
      object.info.description.trim() ||
      object.info.title.trim() ||
      object.info.decorative
    ) {
      if (object.info.description !== description.text)
        review(
          "authored-description-preserved",
          "The existing image description or decorative setting was kept.",
          "Check the existing Alt Text in PowerPoint. It was not replaced by a generated description.",
          object.info.id
        );
    } else if (object.info.grouped || object.info.rect === null) {
      review(
        "description-identity-review",
        "A new description was not added because this object's position could not be matched reliably to the slide preview.",
        "Select this object in PowerPoint and use its Alt Text pane to describe its essential information. Grouped and rotated objects may need a closer check.",
        object.info.id
      );
    } else {
      object.properties.setAttribute("descr", description.text);
      changes.push({
        type: "description",
        slideNumber,
        objectId: object.info.id,
        message:
          "Added an image description in the object's Alt Text metadata.",
      });
    }
  }
  for (const header of repair.tableHeaders ?? []) {
    const object = getObject(header.objectId);
    const table = object?.info.table;
    if (
      !object ||
      !table ||
      table.complex ||
      table.rows < 2 ||
      !same(table.cells[0], header.headerTexts) ||
      table.cells[0].some((text) => !text.trim())
    )
      review(
        "table-header-review",
        "The proposed table labels could not be confirmed against a simple first row.",
        "In PowerPoint, check which row contains the column labels and select Table Design > Header Row if appropriate.",
        header.objectId
      );
    else if (!table.firstRow) {
      const node = descendants(object.element, A, "tbl")[0];
      let properties = direct(node, A, "tblPr");
      if (!properties) {
        properties = slide.document.createElementNS(A, "a:tblPr");
        node.insertBefore(properties, node.firstChild);
      }
      properties.setAttribute("firstRow", "1");
      changes.push({
        type: "table-header",
        slideNumber,
        objectId: object.info.id,
        message: "Marked the existing first table row as the header row.",
      });
    }
  }
  for (const repairTable of repair.splitTableCaption ?? []) {
    const object = getObject(repairTable.objectId);
    const rect = object?.info.rect;
    const sourceIds = descendants(slide.document, P, "cNvPr").map((element) =>
      Number(element.getAttribute("id"))
    );
    const newId = Math.max(0, ...sourceIds) + 1;
    const safe =
      object &&
      rect &&
      object.info.kind === "table" &&
      !object.info.grouped &&
      !object.info.hidden &&
      !object.info.decorative &&
      !object.info.description.trim() &&
      !object.info.title.trim() &&
      !slide.info.hasTiming &&
      Number.isSafeInteger(newId) &&
      newId < 4294967295 &&
      !slide.objects.some(
        (other) =>
          other !== object &&
          !other.info.hidden &&
          (!other.info.rect || overlapping(rect, other.info.rect))
      ) &&
      !descendants(slide.document, A, "effectLst").some(
        (effect) => children(effect).length
      ) &&
      !descendants(slide.document, A, "effectDag").length;
    const patch = safe
      ? buildTableCaptionPatch(
          slide.document,
          object.element,
          rect,
          repairTable,
          String(newId)
        )
      : null;
    if (!patch || !object) {
      review(
        "table-caption-review",
        "This table still needs separate column labels. Its merged caption could not be safely separated within the existing space.",
        "In PowerPoint, move the table caption into a text box, add clear labels above both columns, remove merged cells, and select Table Design > Header Row.",
        repairTable.objectId
      );
      continue;
    }
    slide.tree.insertBefore(patch.caption, object.element);
    slide.tree.replaceChild(patch.table, object.element);
    object.element = patch.table;
    slide.captionPatches.push(patch);
    changes.push({
      type: "table-caption",
      slideNumber,
      objectId: repairTable.objectId,
      message: `Moved the existing table caption above separate column labels (${repairTable.headerTexts.join("; ")}); kept the data rows, font size, and table area.`,
      visualRegion: patch.visualRegion,
    });
  }
  if (repair.readingOrder !== undefined) {
    const directObjects = slide.objects.filter(
      (object) => !object.info.grouped
    );
    const original = directObjects.map((object) => object.info.id);
    const complete =
      repair.readingOrder.length === original.length &&
      original.every((id) => repair.readingOrder!.includes(id));
    const unknownChildren = children(slide.tree).some(
      (child) =>
        !["nvGrpSpPr", "grpSpPr", "extLst"].includes(child.localName ?? "") &&
        !directObjects.some((object) => object.element === child)
    );
    const unsafe =
      !complete ||
      unknownChildren ||
      slide.info.hasTiming ||
      directObjects.some(
        (object) =>
          object.info.kind === "group" ||
          object.info.hidden ||
          !object.info.rect ||
          descendants(object.element, A, "effectLst").length > 0 ||
          descendants(object.element, A, "effectDag").length > 0
      ) ||
      directObjects.some(
        (object, index) =>
          object.info.rect &&
          directObjects
            .slice(index + 1)
            .some(
              (other) =>
                other.info.rect &&
                overlapping(object.info.rect!, other.info.rect)
            )
      );
    if (same(original, repair.readingOrder)) {
      /* no edit required */
    } else if (unsafe)
      review(
        "reading-order-review",
        "Reading order was left unchanged because reordering could alter overlapping, grouped, animated, or unmeasured content.",
        "Open PowerPoint's Reading Order pane on this slide. Put the objects in the order students should hear, and check that the slide still looks correct."
      );
    else {
      // spTree child order is both stacking and reading order. Only non-overlapping,
      // ungrouped, unanimated measured shapes pass this conservative gate.
      const marker = direct(slide.tree, P, "extLst") ?? null;
      for (const objectId of repair.readingOrder)
        slide.tree.insertBefore(getObject(objectId)!.element, marker);
      changes.push({
        type: "reading-order",
        slideNumber,
        message:
          "Reordered the slide's separate objects for a logical reading sequence.",
      });
    }
  }
  if (repair.language) {
    // A missing run-level language may intentionally inherit from paragraph,
    // layout or master styles. Do not replace that effective language in v1.
    review(
      "language-review",
      "The slide's text-language settings were preserved. This version cannot safely resolve all inherited language settings.",
      "Select the slide text and check Review > Language in PowerPoint. Preserve different languages where they are intentional."
    );
  }
  return changes.length !== before;
}

async function writeParts(
  parts: Map<string, Part>,
  changed: Map<string, Buffer>
): Promise<Buffer> {
  const archive = new ZipFile();
  const chunks: Buffer[] = [];
  let size = 0;
  const output = new Promise<Buffer>((resolve, reject) => {
    archive.outputStream.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > LIMITS.output) {
        (archive.outputStream as Readable).destroy();
        reject(
          new PptxPackageError(
            "pptx_size_limit",
            "The repaired presentation exceeds the output size limit."
          )
        );
        return;
      }
      chunks.push(chunk);
    });
    archive.outputStream.on("error", () =>
      reject(
        new PptxPackageError(
          "pptx_integrity",
          "The repaired presentation could not be packaged safely."
        )
      )
    );
    archive.outputStream.on("end", () => resolve(Buffer.concat(chunks)));
    archive.on("error", () =>
      reject(
        new PptxPackageError(
          "pptx_integrity",
          "The repaired presentation could not be packaged safely."
        )
      )
    );
  });
  for (const [name, part] of parts)
    archive.addBuffer(changed.get(name) ?? part.bytes, name, {
      compress: true,
      compressionLevel: 9,
    });
  archive.end();
  return output;
}

function unresolved(inspection: PptxInspection): PptxFinding[] {
  const findings: PptxFinding[] = [];
  const titles = new Map<string, number[]>();
  for (const slide of inspection.slides) {
    const visibleTitles = slide.objects.filter(
      (object) => object.isTitle && !object.hidden && object.text.trim()
    );
    if (visibleTitles.length !== 1)
      findings.push(
        finding(
          "slide-title",
          visibleTitles.length
            ? "This slide has more than one title object."
            : "This slide still needs a title identified for students who use a screen reader.",
          "In PowerPoint, use Accessibility > Slide Title to give the slide one meaningful title.",
          slide.slideNumber
        )
      );
    for (const object of visibleTitles) {
      const normalized = object.text.trim().toLowerCase();
      titles.set(normalized, [
        ...(titles.get(normalized) ?? []),
        slide.slideNumber,
      ]);
    }
    for (const object of slide.objects) {
      if (
        object.table &&
        (!object.table.firstRow ||
          object.table.cells[0]?.some((cell) => !cell.trim()))
      )
        findings.push(
          finding(
            "missing-table-headers",
            "This table needs a header row that clearly labels every column.",
            "In PowerPoint, add clear labels above the table's data and select Table Design > Header Row. A merged caption is a table title, not a set of column labels.",
            slide.slideNumber,
            object.id,
            "error"
          )
        );
      if (
        ["image", "chart", "smartart"].includes(object.kind) &&
        !object.decorative &&
        !object.description.trim() &&
        !object.title.trim()
      )
        findings.push(
          finding(
            "missing-description",
            "This object still needs a description of its essential information.",
            "Select this object in PowerPoint and add Alt Text that explains what students need to understand.",
            slide.slideNumber,
            object.id
          )
        );
    }
  }
  for (const numbers of titles.values())
    if (numbers.length > 1)
      for (const slideNumber of numbers)
        findings.push(
          finding(
            "duplicate-title",
            "Another slide uses the same title.",
            "Make this slide's title distinguishable, for example by adding its specific topic or a meaningful continuation label.",
            slideNumber
          )
        );
  return findings;
}

export async function applyPptxRepairs(
  buffer: Buffer,
  plan: PptxRepairPlan
): Promise<PptxRepairResult> {
  if (!validatePptxRepairPlan(plan))
    throw new PptxPackageError(
      "pptx_invalid",
      "The proposed PowerPoint repairs did not match the supported repair contract."
    );
  const pkg = await loadPackage(buffer);
  if (plan.slides.some((slide) => slide.slideNumber > pkg.slides.length))
    fail("The repair plan referenced a slide that does not exist.");
  const changes: PptxChange[] = [];
  const findings: PptxFinding[] = [];
  const changed = new Map<string, Buffer>();
  for (const repair of plan.slides) {
    const slide = pkg.slides[repair.slideNumber - 1];
    if (applySlide(slide, repair, changes, findings)) {
      const bytes = serializeXml(
        slide.document,
        pkg.parts.get(slide.info.partName)!.bytes
      );
      parseXml(bytes);
      changed.set(slide.info.partName, bytes);
    }
  }
  const output = changed.size
    ? await writeParts(pkg.parts, changed)
    : Buffer.from(buffer);
  const verified = await loadPackage(output, LIMITS.output);
  if (
    verified.parts.size !== pkg.parts.size ||
    verified.inspection.slideCount !== pkg.inspection.slideCount
  )
    throw new PptxPackageError(
      "pptx_integrity",
      "The repaired presentation failed its content-preservation check."
    );
  for (const [name, part] of pkg.parts) {
    const current = verified.parts.get(name);
    if (
      !current ||
      (!changed.has(name) && current.originalHash !== part.originalHash)
    )
      throw new PptxPackageError(
        "pptx_integrity",
        "An unrelated presentation part changed during repair."
      );
  }
  // Text, grouping and visibility survive every permitted metadata/order repair.
  pkg.inspection.slides.forEach((slide, index) => {
    const after = verified.inspection.slides[index];
    if (
      slide.partName !== after.partName ||
      slide.hidden !== after.hidden ||
      slide.objects.length + pkg.slides[index].captionPatches.length !==
        after.objects.length
    )
      throw new PptxPackageError(
        "pptx_integrity",
        "The repaired presentation changed its slide structure."
      );
    for (const object of slide.objects) {
      const current = after.objects.find((item) => item.id === object.id);
      const patch = pkg.slides[index].captionPatches.find(
        (item) => item.tableId === object.id
      );
      if (patch) {
        const verifiedSlide = verified.slides[index];
        const table = verifiedSlide.objects.find(
          (item) => item.info.id === patch.tableId
        );
        const caption = verifiedSlide.objects.find(
          (item) => item.info.id === patch.captionId
        );
        if (
          !table ||
          !caption ||
          pptxElementHash(table.element) !== patch.tableHash ||
          pptxElementHash(caption.element) !== patch.captionHash ||
          caption.info.text !== patch.captionText ||
          !table.info.table?.firstRow ||
          table.info.table.complex
        )
          throw new PptxPackageError(
            "pptx_integrity",
            "The table repair failed its source-content preservation check."
          );
        continue;
      }
      if (
        !current ||
        object.text !== current.text ||
        object.parentId !== current.parentId ||
        object.kind !== current.kind ||
        object.hidden !== current.hidden ||
        object.decorative !== current.decorative ||
        object.title !== current.title ||
        (object.description.trim() &&
          object.description !== current.description)
      )
        throw new PptxPackageError(
          "pptx_integrity",
          "The repaired presentation changed existing content or descriptions."
        );
    }
  });
  return {
    buffer: output,
    changes,
    findings: [
      ...verified.inspection.findings,
      ...findings,
      ...unresolved(verified.inspection),
    ],
    inspection: verified.inspection,
  };
}
