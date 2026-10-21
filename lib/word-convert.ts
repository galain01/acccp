import "server-only";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { performance } from "node:perf_hooks";
import {
  inspectDocx,
  applyDocxRepairs,
  checkDocxAccessibility,
  validateDocxRepairPlan,
  DocxPackageError,
} from "./docx-package";
import type {
  DocxInspection,
  DocxRepairPlan,
  DocxFinding,
  DocxChange,
} from "./docx-types";
import { renderWordToPdf, WordToPdfError } from "./word-to-pdf";
import {
  renderPdfPages,
  PdfRenderingError,
  type RenderedPdf,
  type RenderedPdfPage,
} from "./pdf-rendering";
import {
  callLiteLLM,
  getLiteLLMConfig,
  LiteLLMError,
  type LiteLLMContentPart,
} from "./litellm";
import {
  toModelCallUsage,
  type ModelCallUsage,
  type ConversionError,
} from "./convert";
import type { AccessibilityError } from "./accessibility-findings";
import {
  createJobDiagnostic,
  describeJobDiagnostic,
  type DiagnosticStage,
} from "./job-diagnostics";
import {
  validateDocumentInput,
  MAX_DOCX_OUTPUT_SIZE_BYTES,
} from "./document-input";
import {
  WORD_REPAIR_PROMPT,
  WORD_AUDIT_PROMPT,
  WORD_FINDING_CODES,
} from "./prompts/word-accessibility";

export interface WordConversionResult {
  docx: Buffer;
  errors: AccessibilityError[];
  changes: string[];
  model: string;
  tokensUsed: number;
  calls: ModelCallUsage[];
  extractionWarnings: string[];
  pageCount: number;
}
export interface WordConversionOptions {
  /** Local tests may supply a dedicated renderer; the app uses configured Gotenberg. */
  renderWord?: (buffer: Buffer, timeoutMs: number) => Promise<Buffer>;
}
interface WordFinding extends DocxFinding {
  pageNumber?: number;
}
interface Evidence {
  pdf: Buffer;
  images: RenderedPdf;
}
interface WordBatch {
  pages: RenderedPdfPage[];
  inspection: DocxInspection;
}
export const WORD_MODEL_BATCH_SIZE = 8;

class WordPlanError extends Error {
  constructor(
    readonly code:
      | "docx_invalid_plan"
      | "word_timeout"
      | "docx_visual_change" = "docx_invalid_plan"
  ) {
    super(code);
  }
}
const allObjects = (inspection: DocxInspection) => [
  ...inspection.paragraphs,
  ...inspection.tables,
  ...inspection.images,
];
const normalize = (text: string) =>
  text.normalize("NFKC").replace(/\s+/gu, "").toLowerCase();
const emptyPlan = (inspection: DocxInspection): DocxRepairPlan => ({
  reviewedParagraphIds: inspection.paragraphs.map((p) => p.id),
  reviewedTableIds: inspection.tables.map((t) => t.id),
  reviewedImageIds: inspection.images.map((i) => i.id),
  operations: [],
});
function exactIds(value: unknown, expected: string[]): boolean {
  return (
    Array.isArray(value) &&
    value.length === expected.length &&
    new Set(value).size === value.length &&
    value.every((id) => typeof id === "string" && expected.includes(id))
  );
}
export function completeWordPlan(
  value: unknown,
  inspection: DocxInspection
): value is DocxRepairPlan {
  try {
    const plan = validateDocxRepairPlan(value);
    return (
      exactIds(
        plan.reviewedParagraphIds,
        inspection.paragraphs.map((p) => p.id)
      ) &&
      exactIds(
        plan.reviewedTableIds,
        inspection.tables.map((t) => t.id)
      ) &&
      exactIds(
        plan.reviewedImageIds,
        inspection.images.map((i) => i.id)
      ) &&
      plan.operations.every((op) =>
        allObjects(inspection).some((object) => object.id === op.id)
      )
    );
  } catch {
    return false;
  }
}
function parseObject(text: string): Record<string, unknown> | null {
  if (text.length > 1_000_000) return null;
  try {
    const value = JSON.parse(
      text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")
    );
    return value && typeof value === "object" && !Array.isArray(value)
      ? value
      : null;
  } catch {
    return null;
  }
}
/** Match unique native text to physical pages, never model-supplied page numbers. */
export function wordObjectPages(
  inspection: DocxInspection,
  rendered: RenderedPdf
): Map<string, number[]> {
  const texts = rendered.pages.map((page) => normalize(page.text ?? ""));
  const joined = texts.join("");
  const ranges: { start: number; end: number; page: number }[] = [];
  let offset = 0;
  for (let i = 0; i < texts.length; i++) {
    ranges.push({
      start: offset,
      end: offset + texts[i].length,
      page: rendered.pages[i].pageNumber,
    });
    offset += texts[i].length;
  }
  const match = (text: string): number[] => {
    const needle = normalize(text);
    if (needle.length < 4) return [];
    // Running footers and body sentences often repeat a document/section title.
    // A unique complete rendered line identifies the actual title without
    // confusing it with a substring such as "Classroom guide | Page 2".
    const linePages = rendered.pages.filter((page) =>
      (page.text ?? "")
        .split(/\r?\n/)
        .some((line) => normalize(line) === needle)
    );
    if (linePages.length === 1) return [linePages[0].pageNumber];
    const start = joined.indexOf(needle);
    if (start < 0 || joined.indexOf(needle, start + 1) >= 0) return [];
    return ranges
      .filter(
        (range) => range.end > start && range.start < start + needle.length
      )
      .map((range) => range.page);
  };
  const result = new Map<string, number[]>();
  for (const paragraph of inspection.paragraphs)
    result.set(paragraph.id, match(paragraph.text));
  for (const table of inspection.tables)
    result.set(table.id, match(table.cells.flat().join(" ")));
  for (const image of inspection.images) {
    // A main-story drawing in a completely rendered one-page document cannot
    // belong to a different page, even when Word uses a floating anchor. Its
    // visual identity still needs to be established by the model from that page.
    if (rendered.pageCount === 1 && image.partName === "word/document.xml") {
      result.set(image.id, [1]);
      continue;
    }
    // A floating drawing's paragraph anchor is not evidence of its visual page.
    const inline = "inline" in image && image.inline === true;
    const uniqueAnchor =
      inspection.images.filter(
        (other) =>
          other.paragraphId === image.paragraphId &&
          other.partName === image.partName
      ).length === 1;
    const direct =
      inline && uniqueAnchor && image.paragraphId
        ? (result.get(image.paragraphId) ?? [])
        : [];
    let pages = direct.length === 1 ? direct : [];
    if (inline && uniqueAnchor && !pages.length && image.paragraphId) {
      const index = inspection.paragraphs.findIndex(
        (p) => p.id === image.paragraphId
      );
      const before = inspection.paragraphs
        .slice(0, index)
        .reverse()
        .find(
          (p) =>
            p.partName === image.partName && (result.get(p.id)?.length ?? 0) > 0
        );
      const after = inspection.paragraphs
        .slice(index + 1)
        .find(
          (p) =>
            p.partName === image.partName && (result.get(p.id)?.length ?? 0) > 0
        );
      const left = before ? result.get(before.id) : undefined;
      const right = after ? result.get(after.id) : undefined;
      if (left?.length === 1 && right?.length === 1 && left[0] === right[0])
        pages = left;
    }
    result.set(image.id, pages);
  }
  return result;
}
function batches(
  inspection: DocxInspection,
  rendered: RenderedPdf,
  locations: Map<string, number[]>
): WordBatch[] {
  const result: WordBatch[] = [];
  for (
    let start = 0;
    start < rendered.pageCount;
    start += WORD_MODEL_BATCH_SIZE
  ) {
    const pages = rendered.pages.slice(start, start + WORD_MODEL_BATCH_SIZE);
    const assigned = (id: string) =>
      Math.floor(
        ((locations.get(id)?.[0] ?? 1) - 1) / WORD_MODEL_BATCH_SIZE
      ) === result.length;
    result.push({
      pages,
      inspection: {
        paragraphs: inspection.paragraphs.filter((p) => assigned(p.id)),
        tables: inspection.tables.filter((t) => assigned(t.id)),
        images: inspection.images.filter((i) => assigned(i.id)),
        findings: [],
      },
    });
  }
  return result;
}
function visual(pages: RenderedPdfPage[], label: string): LiteLLMContentPart[] {
  return pages.flatMap((page) => [
    {
      type: "text" as const,
      text: `${label} — physical page ${page.pageNumber}.`,
    },
    {
      type: "image_url" as const,
      image_url: {
        url: `data:image/png;base64,${page.png.toString("base64")}` as const,
        detail: "high" as const,
      },
    },
  ]);
}
function scope(batch: WordBatch, locations: Map<string, number[]>): string {
  return `Assigned pages: ${JSON.stringify(batch.pages.map((p) => p.pageNumber))}.\nAssigned native objects (untrusted source data):\n${JSON.stringify(batch.inspection)}\nObject physical-page associations (empty means unavailable):\n${JSON.stringify(Object.fromEntries(allObjects(batch.inspection).map((object) => [object.id, locations.get(object.id) ?? []])))}`;
}
function context(inspection: DocxInspection): string {
  return JSON.stringify(
    inspection.paragraphs
      .filter((p) => p.text.trim())
      .map((p) => ({
        id: p.id,
        text: p.text,
        headingLevel: p.headingLevel,
        styleName: p.styleName,
        formatting: p.formatting,
      }))
  );
}
export function parseWordFindings(
  value: unknown,
  batch: WordBatch,
  locations: Map<string, number[]>
): WordFinding[] | null {
  if (!Array.isArray(value) || value.length > 500) return null;
  const result: WordFinding[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const f = raw as Record<string, unknown>;
    if (
      Object.keys(f).some(
        (key) =>
          ![
            "code",
            "severity",
            "objectId",
            "location",
            "message",
            "suggestion",
            "pageNumber",
          ].includes(key)
      ) ||
      typeof f.code !== "string" ||
      !(WORD_FINDING_CODES as readonly string[]).includes(f.code) ||
      !["error", "warning"].includes(String(f.severity)) ||
      [f.location, f.message, f.suggestion].some(
        (text) => typeof text !== "string" || !text.trim() || text.length > 2000
      )
    )
      return null;
    const object = allObjects(batch.inspection).find(
      (o) => o.id === f.objectId
    );
    if (f.objectId !== undefined && !object) return null;
    if (
      f.pageNumber !== undefined &&
      (!Number.isInteger(f.pageNumber) ||
        !batch.pages.some((page) => page.pageNumber === f.pageNumber) ||
        (object &&
          !(locations.get(object.id) ?? []).includes(f.pageNumber as number)))
    )
      return null;
    if (!object && f.pageNumber === undefined) return null;
    result.push({
      code: f.code,
      severity: f.severity as "warning" | "error",
      location: object?.location ?? String(f.location),
      message: String(f.message).trim(),
      suggestion: String(f.suggestion).trim(),
      ...(object ? { objectId: object.id } : {}),
      ...(typeof f.pageNumber === "number" ? { pageNumber: f.pageNumber } : {}),
    });
  }
  return result;
}
/** Exact decoded pixels deliberately avoid PNG metadata/compression differences. */
export async function sameWordLayout(
  source: RenderedPdf,
  candidate: RenderedPdf
): Promise<boolean> {
  if (
    source.pageCount !== candidate.pageCount ||
    source.pages.length !== candidate.pages.length
  )
    return false;
  for (let index = 0; index < source.pages.length; index++) {
    const before = source.pages[index];
    const after = candidate.pages[index];
    if (
      before.width !== after.width ||
      before.height !== after.height ||
      before.pageNumber !== after.pageNumber ||
      before.text !== after.text
    )
      return false;
    if (before.png.equals(after.png)) continue;
    const [left, right] = await Promise.all([
      loadImage(before.png),
      loadImage(after.png),
    ]);
    if (left.width !== right.width || left.height !== right.height)
      return false;
    const canvas = createCanvas(before.width, before.height);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(left, 0, 0);
    const pixels = Buffer.from(
      ctx.getImageData(0, 0, before.width, before.height).data
    );
    ctx.clearRect(0, 0, before.width, before.height);
    ctx.drawImage(right, 0, 0);
    if (
      !pixels.equals(
        Buffer.from(ctx.getImageData(0, 0, before.width, before.height).data)
      )
    )
      return false;
  }
  return true;
}
async function pool<T, R>(
  items: T[],
  run: (item: T, index: number) => Promise<R>,
  stopOnFailure: boolean
): Promise<PromiseSettledResult<R>[]> {
  const result: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;
  let failed = false;
  await Promise.all(
    Array.from({ length: Math.min(4, items.length) }, async () => {
      while (next < items.length && !(failed && stopOnFailure)) {
        const index = next++;
        try {
          result[index] = {
            status: "fulfilled",
            value: await run(items[index], index),
          };
        } catch (reason) {
          failed = true;
          result[index] = { status: "rejected", reason };
        }
      }
    })
  );
  return Array.from(
    { length: items.length },
    (_, index) =>
      result[index] ?? { status: "rejected", reason: new WordPlanError() }
  );
}
const WORD_MACHINE_FINDING_CODES: Readonly<Record<string, string>> = {
  docx_image_description_missing: "missing-alt",
  docx_alt_missing: "missing-alt",
  docx_functional_image_decorative: "decorative-image",
  docx_image_review: "image-identity",
  "image-location-unavailable": "image-identity",
  docx_complex_table: "complex-table",
  docx_table_header_missing: "table-headers",
  docx_heading_jump: "heading-hierarchy",
  docx_headings_review: "heading-hierarchy",
  docx_language_review: "language",
  docx_unsupported_content: "unsupported-content",
  docx_unsupported_text_box: "unsupported-text-box",
  docx_unsupported_field: "unsupported-field",
  docx_unsupported_tracked_change: "unsupported-tracked-change",
  docx_unsupported_control: "unsupported-control",
  docx_unsupported_embedded_content: "unsupported-embedded-content",
  docx_unsupported_legacy_drawing: "unsupported-legacy-drawing",
  docx_unsupported_alternate_content: "unsupported-alternate-content",
};

/** Later stages refine the same measured object/problem; they cannot clear it. */
export function mergeWordFindings(...stages: WordFinding[][]): WordFinding[] {
  const merged = new Map<string, WordFinding[]>();
  for (const stage of stages) {
    const current = new Map<string, WordFinding[]>();
    for (const finding of stage) {
      const code = WORD_MACHINE_FINDING_CODES[finding.code] ?? finding.code;
      const f = { ...finding, code };
      const canonical = (WORD_FINDING_CODES as readonly string[]).includes(
        code
      );
      const target = f.objectId
        ? `object:${f.objectId}`
        : f.pageNumber
          ? `page:${f.pageNumber}`
          : `document:${f.location}`;
      // Generic coverage or unrecognized checks may describe different defects.
      // Preserve them unless their exact message agrees; never guess from prose.
      const key = `${target}:${code}${!canonical || code === "unsupported-content" ? `:${f.message}` : ""}`;
      const list = current.get(key) ?? [];
      const exact = list.findIndex((prior) => prior.message === f.message);
      if (exact < 0) list.push(f);
      else
        list[exact] = {
          ...f,
          severity:
            list[exact].severity === "error" || f.severity === "error"
              ? "error"
              : "warning",
        };
      current.set(key, list);
    }
    for (const [key, findings] of current) {
      const earlier = merged.get(key) ?? [];
      const severity = [...earlier, ...findings].some(
        (finding) => finding.severity === "error"
      )
        ? "error"
        : "warning";
      // Distinct observations returned within one final stage stay visible;
      // only earlier-stage wording of that same object/problem is replaced.
      merged.set(
        key,
        findings.map((finding) => ({ ...finding, severity }))
      );
    }
  }
  return [...merged.values()].flat();
}
function unique(findings: WordFinding[]): WordFinding[] {
  return mergeWordFindings(findings);
}
function forUi(
  finding: WordFinding,
  inspection: DocxInspection,
  locations: Map<string, number[]>
): AccessibilityError {
  const object = allObjects(inspection).find((o) => o.id === finding.objectId);
  const pages = finding.pageNumber
    ? [finding.pageNumber]
    : object
      ? (locations.get(object.id) ?? [])
      : [];
  return {
    type: "other",
    severity: finding.severity,
    category: "source-review",
    title: pages.length
      ? `Review page ${pages.join(", ")}`
      : "Review the Word document",
    message: finding.message,
    suggestion: finding.suggestion,
    location: {
      scope: object || pages.length ? "element" : "document",
      sourcePages: pages.length ? pages : null,
      printedPageLabel: null,
      section: null,
      locator: finding.location.slice(0, 200),
      quote:
        object && "text" in object ? object.text.slice(0, 240) || null : null,
    },
  };
}

const summaryText = (value: string, limit: number): string => {
  const text = value.replace(/\s+/gu, " ").trim();
  return text.length <= limit ? text : `${text.slice(0, limit - 1).trimEnd()}…`;
};
function languageName(tag: string): string {
  if (!/^[a-zA-Z]{2,8}(?:-[a-zA-Z0-9]{1,8})*$/.test(tag))
    return summaryText(tag, 60);
  try {
    const name = new Intl.DisplayNames(["en"], { type: "language" }).of(
      tag.split("-")[0]
    );
    return name && name !== tag ? `${name} (${tag})` : tag;
  } catch {
    return tag;
  }
}

/** Describe verified saved changes, using the original words as a faculty locator. */
export function describeWordChange(
  change: DocxChange,
  source: DocxInspection
): string {
  const paragraph = source.paragraphs.find((item) => item.id === change.id);
  const image = source.images.find((item) => item.id === change.id);
  const location = summaryText(change.location, 90);
  const quotedParagraph = `“${summaryText(paragraph?.text ?? "this paragraph", 100)}”`;
  let detail = change.message;
  switch (change.type) {
    case "setHeading":
      if (/^[1-6]$/.test(change.after))
        detail = /^[1-6]$/.test(change.before)
          ? `Changed ${quotedParagraph} from heading level ${change.before} to level ${change.after}.`
          : `Made ${quotedParagraph} a level ${change.after} heading so readers can navigate to it.`;
      break;
    case "setLanguage":
      detail = `Set ${quotedParagraph} to ${languageName(change.after)} for pronunciation; previously ${languageName(change.before)}.`;
      break;
    case "setImageDescription":
      detail = `${change.before.trim() ? "Updated" : "Added"} Alt Text for “${summaryText(image?.name || "this image", 55)}”: “${summaryText(change.after, 300)}”`;
      break;
    case "setTableHeader":
      detail = `Marked the first-row labels “${summaryText(change.after, 240)}” as column headings so readers can identify each column.`;
      break;
    case "setDecorative":
      detail = `Marked “${summaryText(image?.name || "this image", 100)}” as decorative so reading software skips it.`;
      break;
  }
  return summaryText(`${location}: ${detail}`, 500);
}

export async function repairWord(
  buffer: Buffer,
  filename: string,
  options: WordConversionOptions = {}
): Promise<WordConversionResult | ConversionError> {
  const calls: ModelCallUsage[] = [];
  let stage: DiagnosticStage = "docx_prepare";
  const deadline = performance.now() + 260_000;
  const remaining = () => Math.max(1, deadline - performance.now() - 5000);
  const needTime = (minimum: number) => {
    if (remaining() < minimum) throw new WordPlanError("word_timeout");
  };
  const render = async (docx: Buffer): Promise<Evidence> => {
    needTime(6000);
    const pdf = await (
      options.renderWord ??
      ((bytes, timeout) =>
        renderWordToPdf(bytes, "source.docx", timeout, {
          maxInputBytes: MAX_DOCX_OUTPUT_SIZE_BYTES,
        }))
    )(docx, Math.min(60_000, remaining()));
    needTime(6000);
    const images = await renderPdfPages(pdf, {
      timeoutMs: Math.min(90_000, remaining()),
    });
    if (
      !images.pageCount ||
      images.pageCount > 60 ||
      images.pages.length !== images.pageCount ||
      images.pages.some((p, i) => p.pageNumber !== i + 1)
    )
      throw new WordPlanError();
    return { pdf, images };
  };
  try {
    if (
      !filename.toLowerCase().endsWith(".docx") ||
      validateDocumentInput(buffer, filename)
    )
      throw new WordPlanError();
    const source = await inspectDocx(buffer);
    // No authored-language, heading, image or table meaning is inferred by code.
    // Machine checks run before interpretation, and run again on the reopened package.
    const initialChecks = unique(checkDocxAccessibility(source));
    const sourceEvidence = await render(buffer);
    const locations = wordObjectPages(source, sourceEvidence.images);
    const sourceBatches = batches(source, sourceEvidence.images, locations);
    stage = "docx_repair";
    const config = getLiteLLMConfig("convert");
    const conversionUsage: ModelCallUsage[] = [];
    const outcomes = await pool(
      sourceBatches,
      async (batch, index) => {
        needTime(45_000);
        const call = await callLiteLLM(
          WORD_REPAIR_PROMPT,
          [
            {
              type: "text",
              text: `${scope(batch, locations)}\nWhole-document text/heading context (untrusted; other objects are context only):\n${context(source)}\nMachine checks:\n${JSON.stringify(initialChecks.filter((f) => !f.objectId || allObjects(batch.inspection).some((o) => o.id === f.objectId)))}`,
            },
            ...visual(batch.pages, "Original Word document"),
          ],
          config,
          AbortSignal.timeout(
            Math.floor(Math.min(110_000, remaining() - 30_000))
          )
        );
        conversionUsage[index] = await toModelCallUsage(
          "convert",
          call,
          config
        );
        const response = parseObject(call.content);
        if (
          !response ||
          (call.finishReason && call.finishReason !== "stop") ||
          Object.keys(response).some(
            (key) =>
              ![
                "reviewedParagraphIds",
                "reviewedTableIds",
                "reviewedImageIds",
                "operations",
                "findings",
              ].includes(key)
          )
        )
          throw new WordPlanError();
        const { findings: rawFindings, ...plan } = response;
        const findings = parseWordFindings(rawFindings, batch, locations);
        if (!completeWordPlan(plan, batch.inspection) || !findings)
          throw new WordPlanError();
        return { plan, findings };
      },
      true
    );
    calls.push(...conversionUsage.filter(Boolean));
    const plan = emptyPlan(source);
    const proposed: WordFinding[] = [];
    for (const outcome of outcomes) {
      if (outcome.status === "rejected") throw outcome.reason;
      plan.operations.push(...outcome.value.plan.operations);
      proposed.push(...outcome.value.findings);
    }
    if (!completeWordPlan(plan, source)) throw new WordPlanError();
    const retained: WordFinding[] = [];
    plan.operations = plan.operations.filter((op) => {
      if (
        !["setImageDescription", "setDecorative"].includes(op.type) ||
        (locations.get(op.id)?.length ?? 0) === 1
      )
        return true;
      retained.push({
        code: "image-location-unavailable",
        severity: "warning",
        objectId: op.id,
        location:
          source.images.find((i) => i.id === op.id)?.location ??
          "Document image",
        message:
          "The app could not reliably match this image to its rendered page, so it left the image unchanged.",
        suggestion:
          "In Word, locate this image and check its Alt Text or decorative setting before sharing.",
      });
      return false;
    });
    stage = "docx_prepare";
    let repaired = await applyDocxRepairs(buffer, plan);
    let outputEvidence = sourceEvidence;
    try {
      outputEvidence = await render(repaired.buffer);
      if (
        !(await sameWordLayout(sourceEvidence.images, outputEvidence.images))
      ) {
        const metadataPlan = {
          ...plan,
          operations: plan.operations.filter(
            (op) =>
              op.type === "setImageDescription" || op.type === "setDecorative"
          ),
        };
        for (const op of plan.operations.filter(
          (op) =>
            op.type !== "setImageDescription" && op.type !== "setDecorative"
        ))
          retained.push({
            code: "layout-repair-reverted",
            severity: "warning",
            objectId: op.id,
            location:
              allObjects(source).find((o) => o.id === op.id)?.location ??
              "Document",
            message:
              "This proposed repair was undone because the repaired document changed the original page appearance or pagination.",
            suggestion:
              "Review this item in Word and apply the accessibility fix while checking its layout.",
          });
        repaired = await applyDocxRepairs(buffer, metadataPlan);
        outputEvidence = await render(repaired.buffer);
        if (
          !(await sameWordLayout(sourceEvidence.images, outputEvidence.images))
        ) {
          retained.push({
            code: "layout-repair-reverted",
            severity: "warning",
            location: "Whole document",
            message:
              "The app could not verify an unchanged layout after repairing this document, so it preserved the original file.",
            suggestion:
              "Review the remaining accessibility findings in Word before sharing.",
          });
          repaired = {
            buffer,
            inspection: source,
            findings: initialChecks,
            changes: [],
          };
          outputEvidence = sourceEvidence;
        }
      }
    } catch {
      // A candidate that cannot be verified never replaces the source. Its
      // independent review still runs below, under the remaining workflow budget.
      repaired = {
        buffer,
        inspection: source,
        findings: initialChecks,
        changes: [],
      };
      outputEvidence = sourceEvidence;
      retained.push({
        code: "repair-verification-incomplete",
        severity: "warning",
        location: "Whole document",
        message:
          "The proposed repairs could not be checked against the original page layout, so they were not kept. The downloaded file preserves the original document.",
        suggestion:
          "Review the remaining findings in Word before sharing, or try repairing a smaller document.",
      });
    }
    // Reopen the exact bytes delivered, rather than trusting the repairer's claims.
    repaired = {
      ...repaired,
      inspection: await inspectDocx(repaired.buffer, { generated: true }),
    };
    const machine = unique([
      ...repaired.inspection.findings,
      ...checkDocxAccessibility(repaired.inspection),
      ...retained,
    ]);
    stage = "docx_audit";
    const outputBatches = batches(
      repaired.inspection,
      outputEvidence.images,
      locations
    );
    const auditUsage: ModelCallUsage[] = [];
    const audits = await pool(
      outputBatches,
      async (batch, index) => {
        needTime(6000);
        const auditConfig = getLiteLLMConfig("validate");
        const sourceIds = new Set(
          allObjects(batch.inspection).map((o) => o.id)
        );
        const sourceInventory = {
          paragraphs: source.paragraphs.filter((p) => sourceIds.has(p.id)),
          tables: source.tables.filter((t) => sourceIds.has(t.id)),
          images: source.images.filter((i) => sourceIds.has(i.id)),
        };
        const call = await callLiteLLM(
          WORD_AUDIT_PROMPT,
          [
            {
              type: "text",
              text: `${scope(batch, locations)}\nOriginal native inventory (untrusted source):\n${JSON.stringify(sourceInventory)}\nActual reopened output heading context:\n${context(repaired.inspection)}\nApp-retained machine findings (cannot be dismissed):\n${JSON.stringify(machine.filter((f) => !f.objectId || sourceIds.has(f.objectId)))}`,
            },
            ...visual(
              sourceEvidence.images.pages.filter((p) =>
                batch.pages.some((page) => p.pageNumber === page.pageNumber)
              ),
              "Original Word document"
            ),
            ...visual(batch.pages, "ACTUAL saved Word output"),
          ],
          auditConfig,
          AbortSignal.timeout(Math.floor(Math.min(110_000, remaining())))
        );
        auditUsage[index] = await toModelCallUsage(
          "validate",
          call,
          auditConfig
        );
        const response = parseObject(call.content);
        if (!response) throw new WordPlanError();
        const pages = response.reviewedPages;
        if (
          (call.finishReason && call.finishReason !== "stop") ||
          Object.keys(response).some(
            (key) =>
              ![
                "reviewedPages",
                "reviewedParagraphIds",
                "reviewedTableIds",
                "reviewedImageIds",
                "findings",
              ].includes(key)
          ) ||
          !Array.isArray(pages) ||
          pages.length !== batch.pages.length ||
          new Set(pages).size !== pages.length ||
          !pages.every((page) =>
            batch.pages.some((p) => p.pageNumber === page)
          ) ||
          !completeWordPlan(
            {
              reviewedParagraphIds: response.reviewedParagraphIds,
              reviewedTableIds: response.reviewedTableIds,
              reviewedImageIds: response.reviewedImageIds,
              operations: [],
            },
            batch.inspection
          )
        )
          throw new WordPlanError();
        const findings = parseWordFindings(response.findings, batch, locations);
        if (!findings) throw new WordPlanError();
        return findings;
      },
      false
    );
    calls.push(...auditUsage.filter(Boolean));
    const finalFindings: WordFinding[] = [];
    audits.forEach((audit, index) => {
      if (audit.status === "fulfilled") finalFindings.push(...audit.value);
      else
        finalFindings.push({
          code: "audit-incomplete",
          severity: "warning",
          pageNumber: outputBatches[index].pages[0].pageNumber,
          location: `Pages ${outputBatches[index].pages.map((p) => p.pageNumber).join(", ")}`,
          message:
            "The independent review did not finish for these pages. The document's layout was checked, but its accessibility review is incomplete.",
          suggestion:
            "Review these pages with Word's Accessibility Checker and check the remaining findings before sharing, or try the document again.",
        });
    });
    const errors = mergeWordFindings(machine, proposed, finalFindings).map(
      (finding) => forUi(finding, repaired.inspection, locations)
    );
    return {
      docx: repaired.buffer,
      errors,
      changes: repaired.changes.map((change) =>
        describeWordChange(change, source)
      ),
      model: [...new Set(calls.map((call) => call.model))].join(", "),
      tokensUsed: calls.reduce(
        (sum, call) => sum + call.promptTokens + call.completionTokens,
        0
      ),
      calls,
      extractionWarnings: errors
        .filter((error) => error.severity === "warning")
        .map((error) => error.message),
      pageCount: outputEvidence.images.pageCount,
    };
  } catch (error) {
    const diagnostic = createJobDiagnostic(
      error instanceof LiteLLMError ||
        error instanceof PdfRenderingError ||
        error instanceof WordToPdfError
        ? { ...error.diagnostic, stage }
        : {
            stage,
            code:
              error instanceof DocxPackageError
                ? "docx_invalid"
                : error instanceof WordPlanError
                  ? error.code
                  : "unknown_error",
          }
    );
    return { error: describeJobDiagnostic(diagnostic), diagnostic, calls };
  }
}

/** Naming companion to convertPowerPoint; both exports use the same native engine. */
export const convertWord = repairWord;
