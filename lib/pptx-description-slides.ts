import path from "node:path";
import {
  DOMParser,
  XMLSerializer,
  type Document,
  type Element,
} from "@xmldom/xmldom";
import { createCanvas } from "@napi-rs/canvas";
import type {
  PptxChange,
  PptxFinding,
  PptxInspection,
  PptxRepairPlan,
} from "./pptx-types";

const P = "http://schemas.openxmlformats.org/presentationml/2006/main";
const A = "http://schemas.openxmlformats.org/drawingml/2006/main";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const REL = "http://schemas.openxmlformats.org/package/2006/relationships";
const CT = "http://schemas.openxmlformats.org/package/2006/content-types";
const SLIDE_TYPE =
  "application/vnd.openxmlformats-officedocument.presentationml.slide+xml";
const xml = (text: string) =>
  text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
const elements = (document: Document | Element, ns: string, name: string) =>
  Array.from(document.getElementsByTagNameNS(ns, name));
// Match the package reader: a leading UTF-8 BOM is an encoding marker, not XML.
const parse = (bytes: Buffer) =>
  new DOMParser({
    onError: () => {
      throw new Error("Invalid description-slide XML");
    },
  }).parseFromString(
    new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    "application/xml"
  );
const serialize = (document: Document) => {
  const copy = document.cloneNode(true) as Document;
  const declaration = Array.from(copy.childNodes).find(
    (node) => node.nodeType === 7 && node.nodeName === "xml"
  );
  if (declaration) copy.removeChild(declaration);
  return Buffer.from(
    (declaration ? `<?xml ${declaration.nodeValue}?>` : "") +
      new XMLSerializer().serializeToString(copy, { requireWellFormed: true }),
    "utf8"
  );
};
const relsName = (part: string) =>
  path.posix.join(
    path.posix.dirname(part),
    "_rels",
    `${path.posix.basename(part)}.rels`
  );
const resolveTarget = (part: string, target: string) =>
  path.posix.normalize(
    target.startsWith("/")
      ? target.slice(1)
      : path.posix.join(path.posix.dirname(part), target)
  );

interface DescriptionSlideInput {
  parts: Map<string, Buffer>;
  changedParts: Map<string, Buffer>;
  inspection: PptxInspection;
  plan: PptxRepairPlan;
}

/** All input XML has already passed the package reader's bounds and validation. */
export function appendPptxDescriptionSlides(input: DescriptionSlideInput): {
  addedParts: Map<string, Buffer>;
  changedParts: Map<string, Buffer>;
  changes: PptxChange[];
  findings: PptxFinding[];
  descriptions: { slideNumber: number; objectId: string; text: string }[];
} {
  const { parts, inspection, plan } = input;
  const changedParts = new Map(input.changedParts);
  const addedParts = new Map<string, Buffer>();
  const changes: PptxChange[] = [];
  const findings: PptxFinding[] = [];
  const descriptions: {
    slideNumber: number;
    objectId: string;
    text: string;
  }[] = [];
  const result = { addedParts, changedParts, changes, findings, descriptions };
  if (!plan.slides.some((slide) => slide.longDescriptions?.length))
    return result;
  const read = (name: string) => changedParts.get(name) ?? parts.get(name);
  const roots = parse(parts.get("_rels/.rels")!);
  const rootRel = elements(roots, REL, "Relationship").find((node) =>
    node.getAttribute("Type")?.endsWith("/officeDocument")
  );
  const presentationName = resolveTarget("", rootRel!.getAttribute("Target")!);
  const presentation = parse(read(presentationName)!);
  const presentationRelsName = relsName(presentationName);
  const presentationRels = parse(read(presentationRelsName)!);
  const contentTypes = parse(read("[Content_Types].xml")!);
  const slideIds = elements(presentation, P, "sldIdLst")[0];
  const existingIds = elements(slideIds, P, "sldId").map((node) =>
    Number(node.getAttribute("id"))
  );
  let nextSlideId = Math.max(255, ...existingIds) + 1;
  const usedRelationships = new Set(
    elements(presentationRels, REL, "Relationship").map((node) =>
      node.getAttribute("Id")
    )
  );
  let nextRelationship = 1;
  let nextPart = 1;
  let addedCount = 0;
  let requested = 0;
  const widthPt = inspection.width / 12700;
  const heightPt = inspection.height / 12700;
  const margin = Math.round(
    Math.min(inspection.width, inspection.height) * 0.055
  );
  const textWidth = inspection.width - 2 * margin;
  const titleHeight = Math.round(inspection.height * 0.21);
  const bodyY = margin + titleHeight;
  const bodyHeight = inspection.height - bodyY - margin;
  const fontSize = 22;
  const lineHeight = fontSize * 1.3;
  const linesPerSlide = Math.floor(bodyHeight / 12700 / lineHeight);
  const measure = createCanvas(1, 1).getContext("2d");
  measure.font = `${fontSize}px Arial`;
  // Reserve width for font substitution in PowerPoint/LibreOffice; explicit lines
  // and a fixed font size avoid silent shrinking of the generated explanation.
  const lineWidth = (textWidth / 12700) * 0.82;
  const wrap = (paragraph: string, size = fontSize): string[] => {
    measure.font = `${size}px Arial`;
    const words = paragraph.trim().split(/\s+/u);
    const lines: string[] = [];
    let line = "";
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (measure.measureText(candidate).width <= lineWidth) {
        line = candidate;
        continue;
      }
      if (line) lines.push(line);
      line = "";
      if (measure.measureText(word).width > lineWidth) {
        // A long unbreakable value remains intact; it needs a faculty decision.
        throw new Error("Unbreakable description text");
      }
      line = word;
    }
    if (line) lines.push(line);
    return lines;
  };
  const unavailable = (slideNumber: number, objectId: string) =>
    findings.push({
      code: "long-description-review",
      severity: "warning",
      slideNumber,
      objectId,
      message:
        "A separate explanation for this image could not be added within the presentation's supported layout or size limits.",
      suggestion:
        "Add an accessible text explanation or data table on a separate slide, and refer to that slide in the image's Alt Text.",
    });

  for (const repair of [...plan.slides].sort(
    (left, right) => left.slideNumber - right.slideNumber
  )) {
    const sourceSlide = inspection.slides.find(
      (slide) => slide.slideNumber === repair.slideNumber
    );
    for (const item of repair.longDescriptions ?? []) {
      requested++;
      const object = sourceSlide?.objects.find(
        (object) => object.id === item.objectId
      );
      if (
        !sourceSlide ||
        sourceSlide.hidden ||
        !object ||
        !["image", "chart", "smartart"].includes(object.kind) ||
        object.grouped ||
        object.hidden ||
        object.decorative ||
        object.actions?.length ||
        !object.rect ||
        requested > 20 ||
        widthPt < 400 ||
        heightPt < 280 ||
        linesPerSlide < 4
      ) {
        unavailable(repair.slideNumber, item.objectId);
        continue;
      }
      const sourceRels = read(relsName(sourceSlide.partName));
      const layoutRel =
        sourceRels &&
        elements(parse(sourceRels), REL, "Relationship").find(
          (node) =>
            node.getAttribute("Type")?.endsWith("/slideLayout") &&
            node.getAttribute("TargetMode") !== "External"
        );
      const layoutPart =
        layoutRel &&
        resolveTarget(sourceSlide.partName, layoutRel.getAttribute("Target")!);
      if (!layoutPart || !parts.has(layoutPart)) {
        unavailable(repair.slideNumber, item.objectId);
        continue;
      }
      let lines: string[];
      try {
        lines = item.paragraphs.flatMap((paragraph, index) => [
          ...(index ? [""] : []),
          ...wrap(paragraph),
        ]);
      } catch {
        unavailable(repair.slideNumber, item.objectId);
        continue;
      }
      const pages: string[][] = [];
      while (lines.length) {
        while (lines[0] === "") lines.shift();
        if (!lines.length) break;
        pages.push(lines.splice(0, linesPerSlide));
      }
      if (
        !pages.length ||
        pages.length > 8 ||
        inspection.slideCount + addedCount + pages.length > 60 ||
        nextSlideId + pages.length >= 2147483648
      ) {
        unavailable(repair.slideNumber, item.objectId);
        continue;
      }
      const sourceDocument = parse(read(sourceSlide.partName)!);
      const properties = elements(sourceDocument, P, "cNvPr").filter(
        (node) => node.getAttribute("id") === item.objectId
      );
      if (properties.length !== 1) {
        unavailable(repair.slideNumber, item.objectId);
        continue;
      }
      const firstSlide = inspection.slideCount + addedCount + 1;
      const generatedSlideNumbers = pages.map((_, index) => firstSlide + index);
      const reference =
        pages.length === 1
          ? `Detailed description on slide ${firstSlide}.`
          : `Detailed description on slides ${firstSlide}–${firstSlide + pages.length - 1}.`;
      const description = `${item.summary.trim()} ${reference}`;
      properties[0].setAttribute("descr", description);
      changedParts.set(sourceSlide.partName, serialize(sourceDocument));
      descriptions.push({
        slideNumber: repair.slideNumber,
        objectId: item.objectId,
        text: description,
      });
      const language = item.languageTag ?? "en-US";
      const titleBase = `Description of slide ${repair.slideNumber}: ${item.title.trim()}`;

      for (const [index, bodyLines] of pages.entries()) {
        let slideName: string;
        do {
          slideName = `ppt/slides/accessibility-description-${nextPart++}.xml`;
        } while (
          parts.has(slideName) ||
          addedParts.has(slideName) ||
          parts.has(relsName(slideName))
        );
        let relationshipId: string;
        do {
          relationshipId = `rIdAccessibility${nextRelationship++}`;
        } while (usedRelationships.has(relationshipId));
        usedRelationships.add(relationshipId);
        const pageLabel =
          pages.length > 1 ? ` (${index + 1} of ${pages.length})` : "";
        const title = `${titleBase}${pageLabel}`;
        let titleLabel = titleBase;
        let titleLines: string[] = [];
        // The title is a generated label; shorten only that label if needed.
        // Keep the page identifier so continuation slides remain distinguishable.
        // The complete explanation below is never truncated or shrunk.
        while (titleLabel) {
          try {
            titleLines = wrap(
              `${titleLabel === titleBase ? titleLabel : `${titleLabel}…`}${pageLabel}`,
              24
            );
          } catch {
            titleLines = [];
          }
          if (
            titleLines.length &&
            titleLines.length * 24 * 1.3 <= titleHeight / 12700
          )
            break;
          titleLabel = Array.from(titleLabel).slice(0, -1).join("").trimEnd();
        }
        const body = bodyLines
          .map((line) => paragraphXml(line, fontSize, language, false))
          .join("");
        const slideXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sld xmlns:p="${P}" xmlns:a="${A}" xmlns:r="${R}" showMasterSp="0"><p:cSld name="${xml(title)}"><p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill><a:effectLst/></p:bgPr></p:bg><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>${textShape(2, "Description slide title", true, margin, margin, textWidth, titleHeight, titleLines.map((line) => paragraphXml(line, 24, language, true)).join(""))}${textShape(3, "Detailed image description", false, margin, bodyY, textWidth, bodyHeight, body)}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;
        addedParts.set(slideName, Buffer.from(slideXml, "utf8"));
        addedParts.set(
          relsName(slideName),
          Buffer.from(
            `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${REL}"><Relationship Id="rId1" Type="${R}/slideLayout" Target="${xml(path.posix.relative(path.posix.dirname(slideName), layoutPart))}"/></Relationships>`,
            "utf8"
          )
        );
        const slideId = presentation.createElementNS(P, "p:sldId");
        slideId.setAttribute("id", String(nextSlideId++));
        slideId.setAttributeNS(R, "r:id", relationshipId);
        slideIds.appendChild(slideId);
        const relationship = presentationRels.createElementNS(
          REL,
          "Relationship"
        );
        relationship.setAttribute("Id", relationshipId);
        relationship.setAttribute("Type", `${R}/slide`);
        relationship.setAttribute(
          "Target",
          path.posix.relative(path.posix.dirname(presentationName), slideName)
        );
        presentationRels.documentElement!.appendChild(relationship);
        const override = contentTypes.createElementNS(CT, "Override");
        override.setAttribute("PartName", `/${slideName}`);
        override.setAttribute("ContentType", SLIDE_TYPE);
        contentTypes.documentElement!.appendChild(override);
        const relationshipsOverride = contentTypes.createElementNS(
          CT,
          "Override"
        );
        relationshipsOverride.setAttribute(
          "PartName",
          `/${relsName(slideName)}`
        );
        relationshipsOverride.setAttribute(
          "ContentType",
          "application/vnd.openxmlformats-package.relationships+xml"
        );
        contentTypes.documentElement!.appendChild(relationshipsOverride);
        addedCount++;
      }
      changes.push({
        type: "long-description",
        slideNumber: repair.slideNumber,
        objectId: item.objectId,
        operationId: `${repair.slideNumber}:long-description:${item.objectId}`,
        generatedSlideNumbers,
        message: `Added ${pages.length === 1 ? "an editable description slide" : `${pages.length} editable description slides`} and referred to ${pages.length === 1 ? "it" : "them"} in the image's short Alt Text.`,
      });
    }
  }
  if (addedCount) {
    changedParts.set(presentationName, serialize(presentation));
    changedParts.set(presentationRelsName, serialize(presentationRels));
    changedParts.set("[Content_Types].xml", serialize(contentTypes));
  }
  return result;
}

function paragraphXml(
  text: string,
  size: number,
  language: string,
  bold: boolean
) {
  return `<a:p><a:pPr marL="0" marR="0" algn="l"><a:lnSpc><a:spcPts val="${Math.round(size * 130)}"/></a:lnSpc><a:spcBef><a:spcPts val="0"/></a:spcBef><a:spcAft><a:spcPts val="0"/></a:spcAft><a:buNone/></a:pPr><a:r><a:rPr lang="${xml(language)}" sz="${size * 100}" b="${bold ? "1" : "0"}"><a:solidFill><a:srgbClr val="000000"/></a:solidFill><a:latin typeface="Arial"/><a:ea typeface="Arial"/><a:cs typeface="Arial"/></a:rPr><a:t xml:space="preserve">${xml(text)}</a:t></a:r><a:endParaRPr lang="${xml(language)}" sz="${size * 100}"/></a:p>`;
}

function textShape(
  id: number,
  name: string,
  title: boolean,
  x: number,
  y: number,
  width: number,
  height: number,
  paragraphs: string
) {
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${xml(name)}"/><p:cNvSpPr txBox="1"/><p:nvPr>${title ? '<p:ph type="title"/>' : ""}</p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${width}" cy="${height}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln><a:noFill/></a:ln></p:spPr><p:txBody><a:bodyPr wrap="square" lIns="0" tIns="0" rIns="0" bIns="0" anchor="t"><a:noAutofit/></a:bodyPr><a:lstStyle/>${paragraphs}</p:txBody></p:sp>`;
}
