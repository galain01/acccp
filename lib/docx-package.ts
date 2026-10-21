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

async function openPackage(
  buffer: Buffer,
  maxBytes = LIMITS.input
): Promise<Package> {
  const parts = await readParts(buffer, maxBytes);
  const xml = new Map<string, Document>();
  const budget = { nodes: 0, deadline: Date.now() + 15_000 };
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
    if (/\.(?:xml|rels|vml|svg)$/i.test(name)) {
      const document = parseXml(bytes, budget);
      checkFieldSafety(document);
      xml.set(name, document);
    }
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
  for (const element of children(types.documentElement)) {
    const type = element.getAttribute("ContentType") ?? "";
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
  }
  for (const name of xml.keys())
    if (name.endsWith(".rels")) {
      const source =
        name === "_rels/.rels"
          ? ""
          : name.replace(/(^|\/)\_rels\/([^/]+)\.rels$/, "$1$2");
      if (source === name || (source && !parts.has(source))) fail();
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
  const mainType = children(types.documentElement)
    .find(
      (element) =>
        element.localName === "Override" &&
        element.getAttribute("PartName") === `/${pkg.main}`
    )
    ?.getAttribute("ContentType");
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
  /^word\/[a-zA-Z0-9_.-]+\.xml:[pti]:[1-9]\d*$/.test(value);
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
  for (const op of plan.operations) {
    const element = pkg.elements.get(op.id);
    if (!element) integrity();
    const paragraph = before.paragraphs.find((p) => p.id === op.id);
    const table = before.tables.find((t) => t.id === op.id);
    const image = before.images.find((i) => i.id === op.id);
    const object = paragraph ?? table ?? image;
    if (!object?.editable) integrity();
    let prior = "";
    let after = "";
    let message = "";
    if (op.type === "setHeading") {
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
  const reopened = await openPackage(output, LIMITS.output);
  if (reopened.parts.size !== pkg.parts.size) integrity();
  for (const [name, bytes] of pkg.parts)
    if (!touched.has(name) && hash(reopened.parts.get(name)!) !== hash(bytes))
      integrity();
  // No operation can alter source text, images, links, relationships, layout, or IDs.
  if (
    JSON.stringify(
      before.paragraphs.map((p) => [
        p.id,
        p.text,
        p.styleId,
        p.formatting,
        p.list,
      ])
    ) !==
      JSON.stringify(
        reopened.inspection.paragraphs.map((p) => [
          p.id,
          p.text,
          p.styleId,
          p.formatting,
          p.list,
        ])
      ) ||
    JSON.stringify(before.tables.map((t) => [t.id, t.cells])) !==
      JSON.stringify(reopened.inspection.tables.map((t) => [t.id, t.cells])) ||
    JSON.stringify(
      before.images.map((i) => [i.id, i.name, i.functional, i.title])
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
      (item) => item.id === change.id
    );
    const i = reopened.inspection.images.find((item) => item.id === change.id);
    const t = reopened.inspection.tables.find((item) => item.id === change.id);
    if (
      (op.type === "setHeading" && p?.headingLevel !== op.level) ||
      (op.type === "setLanguage" && p?.language !== op.tag) ||
      (op.type === "setTableHeader" && !t?.firstRowHeader) ||
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
  };
}
