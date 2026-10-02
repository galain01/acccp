import "server-only";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { performance } from "node:perf_hooks";
import { validateDocumentInput } from "./document-input";
import {
  applyPptxRepairs,
  checkPptxAccessibility,
  inspectPptx,
  PptxPackageError,
  validatePptxRepairPlan,
} from "./pptx-package";
import type {
  PptxChange,
  PptxFinding,
  PptxInspection,
  PptxRepairPlan,
  PptxRepairResult,
  PptxRevisionBundle,
} from "./pptx-types";
import {
  renderPowerPointToPdf,
  PowerPointRenderingError,
} from "./powerpoint-rendering";
import {
  renderPdfPages,
  PdfRenderingError,
  type RenderedPdf,
} from "./pdf-rendering";
import {
  toModelCallUsage,
  type ConversionError,
  type ModelCallUsage,
} from "./convert";
import type { AccessibilityError } from "./accessibility-findings";
import {
  callLiteLLM,
  getLiteLLMConfig,
  LiteLLMError,
  type LiteLLMContentPart,
} from "./litellm";
import {
  createJobDiagnostic,
  describeJobDiagnostic,
  type DiagnosticCode,
  type DiagnosticStage,
} from "./job-diagnostics";
import {
  POWERPOINT_AUDIT_PROMPT,
  POWERPOINT_REPAIR_PROMPT,
} from "./prompts/powerpoint-accessibility";
import { buildPowerPointReview, resolvePowerPointReviews } from "./pptx-review";
import {
  buildPptxMechanicalPlan,
  createPptxRevisionBundle,
  mergePptxRepairPlans,
  normalizePptxReadingOrders,
} from "./pptx-revisions";

export interface PowerPointConversionResult {
  pptx: Buffer;
  errors: AccessibilityError[];
  changes: string[];
  model: string;
  tokensUsed: number;
  calls: ModelCallUsage[];
  extractionWarnings: string[];
  /** For shared volume metrics, this is the number of slides, including hidden slides. */
  pageCount: number;
  revisions?: PptxRevisionBundle;
  reviewPreviews?: PowerPointReviewPreview[];
}

export interface PowerPointReviewPreview {
  slideNumber: number;
  before?: string;
  after: string;
}

export interface PowerPointConversionOptions {
  /** Persists large previews outside the renderer request when supplied by the app. */
  renderPowerPoint?: (buffer: Buffer, timeoutMs: number) => Promise<Buffer>;
}

class PowerPointPlanError extends Error {
  constructor(readonly code: "pptx_invalid_plan" | "pptx_visual_change") {
    super(code);
  }
}

function jsonObject(text: string): Record<string, unknown> | null {
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

/** Reject incomplete coverage rather than interpreting a partial response as success. */
export function completePowerPointPlan(
  value: unknown,
  inspection: PptxInspection
): value is PptxRepairPlan {
  if (!validatePptxRepairPlan(value)) return false;
  return (
    value.slides.length === inspection.slideCount &&
    new Set(value.slides.map((s) => s.slideNumber)).size ===
      inspection.slideCount &&
    value.slides.every((s) =>
      inspection.slides.some((source) => source.slideNumber === s.slideNumber)
    )
  );
}

export function parsePowerPointFindings(
  value: unknown,
  inspection: PptxInspection
): PptxFinding[] | null {
  if (!Array.isArray(value) || value.length > 500) return null;
  const findings: PptxFinding[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const f = item as Record<string, unknown>;
    if (
      Object.keys(f).some(
        (key) =>
          ![
            "code",
            "severity",
            "slideNumber",
            "objectId",
            "message",
            "suggestion",
          ].includes(key)
      ) ||
      typeof f.code !== "string" ||
      !/^[a-z][a-z0-9-]{0,59}$/.test(f.code) ||
      !["error", "warning"].includes(String(f.severity)) ||
      typeof f.message !== "string" ||
      !f.message.trim() ||
      f.message.length > 2000 ||
      typeof f.suggestion !== "string" ||
      !f.suggestion.trim() ||
      f.suggestion.length > 2000
    )
      return null;
    const slide = inspection.slides.find(
      (s) => s.slideNumber === f.slideNumber
    );
    if (f.slideNumber !== undefined && !slide) return null;
    if (
      f.objectId !== undefined &&
      (typeof f.objectId !== "string" ||
        !slide?.objects.some((o) => o.id === f.objectId))
    )
      return null;
    findings.push({
      code: f.code,
      severity: f.severity as PptxFinding["severity"],
      message: f.message.trim(),
      suggestion: f.suggestion.trim(),
      ...(slide ? { slideNumber: slide.slideNumber } : {}),
      ...(typeof f.objectId === "string" ? { objectId: f.objectId } : {}),
    });
  }
  return findings;
}

function findingForUi(
  f: PptxFinding,
  inspection: PptxInspection
): AccessibilityError {
  const slide = inspection.slides.find((s) => s.slideNumber === f.slideNumber);
  const object = slide?.objects.find((o) => o.id === f.objectId);
  return {
    type: "other",
    severity: f.severity,
    category: "source-review",
    title: slide
      ? `Review slide ${slide.slideNumber}${object ? `: ${object.name || "slide object"}` : ""}`
      : "Review the PowerPoint presentation",
    message: f.message,
    suggestion: f.suggestion,
    location: {
      scope: slide ? "element" : "document",
      sourceKind: "slide",
      sourcePages: slide ? [slide.slideNumber] : null,
      printedPageLabel: null,
      section:
        slide?.objects.find((o) => o.isTitle)?.text.slice(0, 200) || null,
      locator: object
        ? `${object.name || object.kind} (object ${object.id})`.slice(0, 200)
        : null,
      quote: object?.text.slice(0, 240) || null,
    },
  };
}

function visualInput(
  pdf: Buffer,
  rendered: RenderedPdf,
  actualOutput = false
): LiteLLMContentPart[] {
  return [
    {
      type: "file",
      file: {
        filename: actualOutput
          ? "actual-repaired-slides.pdf"
          : "original-slides.pdf",
        file_data: `data:application/pdf;base64,${pdf.toString("base64")}`,
      },
    },
    {
      type: "text",
      text: `This PDF was rendered from the ${actualOutput ? "ACTUAL SAVED OUTPUT" : "ORIGINAL"} PPTX. It includes hidden slides and excludes speaker-note pages. Match the numbered images to the inventory. PDF accessibility tags are not PowerPoint metadata.`,
    },
    ...rendered.pages.flatMap((page) => [
      {
        type: "text" as const,
        text: `${actualOutput ? "ACTUAL REPAIRED" : "ORIGINAL"} slide ${page.pageNumber} of ${rendered.pageCount}:`,
      },
      {
        type: "image_url" as const,
        image_url: {
          url: `data:image/png;base64,${page.png.toString("base64")}` as const,
          detail: "high" as const,
        },
      },
    ]),
  ];
}

/**
 * Compare decoded slide pixels, allowing only bounded text-edge rasterization
 * noise observed when reading-order changes alter PDF font-subset emission.
 * At most 0.05% of pixels may differ, with channel deltas <=32; at most 0.005%
 * may differ by more than 2. Alpha outside permitted repairs, dimensions and
 * slide identity must match. Only a successfully applied caption/table repair
 * permits intentional changes inside the ORIGINAL caption row. The engine
 * computes that region and it must fit the original table's source bounds;
 * model-supplied rectangles are never accepted.
 * Source text/object preservation is independently checked by the package engine.
 */
export async function changedPowerPointSlides(
  before: RenderedPdf,
  after: RenderedPdf,
  repairs?: { source: PptxInspection; changes: readonly PptxChange[] }
): Promise<number[]> {
  if (before.pageCount !== after.pageCount)
    return before.pages.map((p) => p.pageNumber);
  const changed: number[] = [];
  for (let i = 0; i < before.pages.length; i++) {
    const a = before.pages[i],
      b = after.pages[i];
    if (
      !b ||
      a.pageNumber !== b.pageNumber ||
      a.width !== b.width ||
      a.height !== b.height
    ) {
      changed.push(a.pageNumber);
      continue;
    }
    if (a.png.equals(b.png)) continue;
    const canvas = createCanvas(a.width, a.height);
    const context = canvas.getContext("2d");
    context.drawImage(await loadImage(a.png), 0, 0);
    const pixels = context.getImageData(0, 0, a.width, a.height).data;
    context.clearRect(0, 0, a.width, a.height);
    context.drawImage(await loadImage(b.png), 0, 0);
    const output = context.getImageData(0, 0, a.width, a.height).data;
    const mask = new Uint8Array(a.width * a.height);
    for (const change of repairs?.changes ?? []) {
      if (
        change.slideNumber !== a.pageNumber ||
        change.type !== "table-caption"
      )
        continue;
      const source = repairs!.source;
      const table = source.slides
        .find((s) => s.slideNumber === a.pageNumber)
        ?.objects.find((o) => o.id === change.objectId && o.kind === "table");
      const bounds = table?.rect;
      const rect = change.visualRegion;
      if (
        !rect ||
        source.width <= 0 ||
        source.height <= 0 ||
        !bounds ||
        rect.x !== bounds.x ||
        rect.y !== bounds.y ||
        rect.width !== bounds.width ||
        rect.height > bounds.height ||
        ![
          rect.x,
          rect.y,
          rect.width,
          rect.height,
          source.width,
          source.height,
        ].every(Number.isFinite) ||
        rect.x < 0 ||
        rect.y < 0 ||
        rect.width <= 0 ||
        rect.height <= 0 ||
        rect.x + rect.width > source.width ||
        rect.y + rect.height > source.height
      )
        throw new PowerPointPlanError("pptx_visual_change");
      // Two pixels cover antialiasing at the existing table's outer border.
      const left = Math.max(
        0,
        Math.floor((rect.x / source.width) * a.width) - 2
      );
      const right = Math.min(
        a.width,
        Math.ceil(((rect.x + rect.width) / source.width) * a.width) + 2
      );
      const top = Math.max(
        0,
        Math.floor((rect.y / source.height) * a.height) - 2
      );
      const bottom = Math.min(
        a.height,
        Math.ceil(((rect.y + rect.height) / source.height) * a.height) + 2
      );
      for (let y = top; y < bottom; y++)
        mask.fill(1, y * a.width + left, y * a.width + right);
    }
    const pixelCount =
      mask.length - mask.reduce((total, value) => total + value, 0);
    let differing = 0;
    let aboveRounding = 0;
    for (let offset = 0; offset < pixels.length; offset += 4) {
      if (mask[offset / 4]) continue;
      const delta = Math.max(
        Math.abs(pixels[offset] - output[offset]),
        Math.abs(pixels[offset + 1] - output[offset + 1]),
        Math.abs(pixels[offset + 2] - output[offset + 2])
      );
      if (delta > 0) differing++;
      if (delta > 2) aboveRounding++;
      if (
        pixels[offset + 3] !== output[offset + 3] ||
        delta > 32 ||
        differing > Math.floor(pixelCount * 0.0005) ||
        aboveRounding > Math.floor(pixelCount * 0.00005)
      ) {
        changed.push(a.pageNumber);
        break;
      }
    }
  }
  return changed;
}

interface SlideEvidence {
  pdf: Buffer;
  images: RenderedPdf;
}

function workflowClock(options: PowerPointConversionOptions) {
  const deadline = performance.now() + 260_000;
  const remaining = () => Math.max(1, deadline - performance.now() - 5000);
  const needTime = (minimum: number) => {
    if (remaining() < minimum) throw new PowerPointRenderingError();
  };
  const render = async (
    pptx: Buffer,
    slideCount: number
  ): Promise<SlideEvidence> => {
    needTime(6000);
    const pdf = await (options.renderPowerPoint ?? renderPowerPointToPdf)(
      pptx,
      Math.min(60_000, remaining())
    );
    needTime(6000);
    const images = await renderPdfPages(pdf, {
      timeoutMs: Math.min(90_000, remaining()),
      inputKind: "powerpoint-preview",
    });
    if (
      images.pageCount !== slideCount ||
      images.pages.length !== slideCount ||
      images.pages.some((page, index) => page.pageNumber !== index + 1)
    )
      throw new PowerPointRenderingError();
    return { pdf, images };
  };
  return { remaining, needTime, render };
}

type WorkflowClock = ReturnType<typeof workflowClock>;

function uniqueFindings(findings: readonly PptxFinding[]): PptxFinding[] {
  const found = new Map<string, PptxFinding>();
  for (const finding of findings) {
    const key = `${finding.slideNumber ?? 0}:${finding.objectId ?? ""}:${finding.code}:${finding.message}`;
    if (!found.has(key)) found.set(key, finding);
  }
  return [...found.values()];
}

const incompleteAudit = (): PptxFinding => ({
  code: "audit-incomplete",
  severity: "warning",
  message:
    "The app checked the presentation package, but the independent AI review did not finish checking every slide and review item.",
  suggestion:
    "Review every slide in PowerPoint with Check Accessibility and the Reading Order pane before sharing the file.",
});

/** Only these operations can correct the first candidate; structural edits are not repeated. */
export function completePowerPointCorrection(
  value: unknown,
  inspection: PptxInspection,
  originalSlideCount = inspection.slideCount
): value is PptxRepairPlan {
  return (
    completePowerPointPlan(value, inspection) &&
    value.slides.every(
      (slide) =>
        (slide.slideNumber <= originalSlideCount ||
          !hasOperations({ slides: [slide] })) &&
        Object.keys(slide).every((key) =>
          [
            "slideNumber",
            "descriptions",
            "decorativeObjects",
            "textLanguages",
            "readingOrder",
            "linkTexts",
            "textStyles",
            "objectBounds",
            "revisionNotes",
          ].includes(key)
        )
    )
  );
}

function hasOperations(plan: PptxRepairPlan): boolean {
  return plan.slides.some((slide) =>
    Object.entries(slide).some(
      ([key, value]) =>
        key !== "slideNumber" &&
        key !== "revisionNotes" &&
        (Array.isArray(value) ? value.length > 0 : value !== undefined)
    )
  );
}

/** A semantic edit must not recreate or modify an object already removed by code. */
function editsRemovedPlaceholder(
  plan: PptxRepairPlan,
  mechanical: PptxRepairPlan
): boolean {
  return plan.slides.some((slide) => {
    const removed = new Set(
      mechanical.slides.find((item) => item.slideNumber === slide.slideNumber)
        ?.removeEmptyPlaceholders ?? []
    );
    if (slide.titleObjectId && removed.has(slide.titleObjectId)) return true;
    if (
      slide.revisionNotes?.some(
        (note) =>
          note.type === "empty-placeholder" ||
          (note.objectId !== undefined && removed.has(note.objectId))
      )
    )
      return true;
    return (
      [
        "descriptions",
        "decorativeObjects",
        "longDescriptions",
        "tableHeaders",
        "splitTableCaption",
        "textLanguages",
        "linkTexts",
        "textStyles",
        "objectBounds",
      ] as const
    ).some((key) => slide[key]?.some((entry) => removed.has(entry.objectId)));
  });
}

async function auditOutput(options: {
  source: PptxInspection;
  repaired: PptxRepairResult;
  sourceEvidence: SlideEvidence;
  outputEvidence: SlideEvidence;
  proposedFindings: PptxFinding[];
  allowCorrection: boolean;
  clock: WorkflowClock;
  calls: ModelCallUsage[];
}): Promise<{ findings: PptxFinding[]; correction: PptxRepairPlan | null }> {
  const { source, repaired, sourceEvidence, outputEvidence, clock, calls } =
    options;
  const engineFindings = uniqueFindings([
    ...repaired.inspection.findings,
    ...repaired.findings,
    ...checkPptxAccessibility(repaired.inspection),
  ]);
  const review = buildPowerPointReview(
    repaired.inspection,
    engineFindings,
    options.proposedFindings,
    []
  );
  const unresolved = [
    ...review.fixed,
    ...review.concerns.map((item) => item.finding),
  ];
  try {
    // Pixel changes identify comparison evidence; they do not reject intentional repairs.
    // Appended description slides have no original counterpart. Compare the
    // preserved source prefix, then send every actual output slide below.
    const visiblyChanged = await changedPowerPointSlides(
      sourceEvidence.images,
      outputEvidence.images.pageCount >= sourceEvidence.images.pageCount
        ? {
            ...outputEvidence.images,
            pageCount: sourceEvidence.images.pageCount,
            pages: outputEvidence.images.pages.slice(
              0,
              sourceEvidence.images.pageCount
            ),
          }
        : outputEvidence.images
    );
    const auditConfig = getLiteLLMConfig("validate");
    clock.needTime(10_000);
    const call = await callLiteLLM(
      POWERPOINT_AUDIT_PROMPT,
      [
        {
          type: "text",
          text: `Automatic correction ${options.allowCorrection ? "ENABLED for one focused pass" : "DISABLED: this is the final selected version. Do not reapply declined changes or return a corrective plan"}.\nOriginal inventory (untrusted source data):\n${JSON.stringify(source)}\nActual saved output inventory:\n${JSON.stringify(repaired.inspection)}\nApplied changes:\n${JSON.stringify(repaired.changes)}\nApp-retained output defects/checks (do not duplicate):\n${JSON.stringify(review.fixed)}\nConcerns requiring one findingReviews decision each:\n${JSON.stringify(review.concerns)}`,
        },
        ...sourceEvidence.images.pages
          .filter((page) => visiblyChanged.includes(page.pageNumber))
          .flatMap((page): LiteLLMContentPart[] => [
            {
              type: "text",
              text: `ORIGINAL slide ${page.pageNumber} before visible changes. Compare its content with the ACTUAL REPAIRED slide below.`,
            },
            {
              type: "image_url",
              image_url: {
                url: `data:image/png;base64,${page.png.toString("base64")}`,
                detail: "high",
              },
            },
          ]),
        ...visualInput(outputEvidence.pdf, outputEvidence.images, true),
      ],
      auditConfig,
      AbortSignal.timeout(Math.floor(Math.min(110_000, clock.remaining())))
    );
    // Persist completed-call usage even if the response is malformed or a repair later fails.
    calls.push(await toModelCallUsage("validate", call, auditConfig));
    const audit = jsonObject(call.content);
    const reviewed = audit?.reviewedSlides;
    const findings = parsePowerPointFindings(
      audit?.findings,
      repaired.inspection
    );
    const concerns = resolvePowerPointReviews(
      audit?.findingReviews,
      review.concerns
    );
    const correction = audit?.correctivePlan ?? null;
    if (
      !audit ||
      Object.keys(audit).some(
        (key) =>
          ![
            "reviewedSlides",
            "findingReviews",
            "findings",
            "correctivePlan",
          ].includes(key)
      ) ||
      (call.finishReason && call.finishReason !== "stop") ||
      !Array.isArray(reviewed) ||
      reviewed.length !== repaired.inspection.slideCount ||
      new Set(reviewed).size !== repaired.inspection.slideCount ||
      reviewed.some(
        (number) =>
          !Number.isInteger(number) ||
          number < 1 ||
          number > repaired.inspection.slideCount
      ) ||
      !findings ||
      !concerns ||
      (correction !== null &&
        (!options.allowCorrection ||
          !completePowerPointCorrection(
            correction,
            repaired.inspection,
            source.slideCount
          )))
    )
      throw new Error("Incomplete audit");
    return {
      findings: uniqueFindings([...review.fixed, ...concerns, ...findings]),
      correction: correction
        ? {
            slides: (correction as PptxRepairPlan).slides.filter(
              (slide) => slide.slideNumber <= source.slideCount
            ),
          }
        : null,
    };
  } catch {
    return {
      findings: uniqueFindings([...unresolved, incompleteAudit()]),
      correction: null,
    };
  }
}

/** Small before/after previews are private retained document content, just like the PPTX. */
export async function buildPowerPointReviewPreviews(
  before: RenderedPdf,
  after: RenderedPdf,
  slideNumbers: readonly number[],
  generatedSlideNumbers: readonly number[] = []
): Promise<PowerPointReviewPreview[]> {
  const previews: PowerPointReviewPreview[] = [];
  let bytes = 0;
  const resize = async (png: Buffer) => {
    const image = await loadImage(png);
    const width = Math.max(1, Math.min(640, image.width));
    const height = Math.max(
      1,
      Math.round((image.height * width) / image.width)
    );
    const canvas = createCanvas(width, height);
    const context = canvas.getContext("2d");
    context.fillStyle = "white";
    context.fillRect(0, 0, width, height);
    context.drawImage(image, 0, 0, width, height);
    return `data:image/jpeg;base64,${canvas.toBuffer("image/jpeg", 80).toString("base64")}`;
  };
  for (const slideNumber of [...new Set(slideNumbers)].slice(0, 60)) {
    const a = before.pages.find((page) => page.pageNumber === slideNumber);
    const b = after.pages.find((page) => page.pageNumber === slideNumber);
    if (!b) continue;
    if (
      !a &&
      (slideNumber <= before.pageCount ||
        !generatedSlideNumbers.includes(slideNumber))
    )
      throw new PowerPointPlanError("pptx_invalid_plan");
    const pair = {
      slideNumber,
      ...(a ? { before: await resize(a.png) } : {}),
      after: await resize(b.png),
    };
    bytes += (pair.before?.length ?? 0) + pair.after.length;
    if (bytes > 8_000_000) break;
    previews.push(pair);
  }
  return previews;
}

function finishResult(
  repaired: PptxRepairResult,
  findings: PptxFinding[],
  calls: ModelCallUsage[],
  reviewPreviews: PowerPointReviewPreview[],
  revisions?: PptxRevisionBundle
): PowerPointConversionResult {
  const unique = uniqueFindings(findings);
  return {
    pptx: repaired.buffer,
    pageCount: repaired.inspection.slideCount,
    errors: unique.map((finding) => findingForUi(finding, repaired.inspection)),
    changes: repaired.changes.map(
      (change) => `Slide ${change.slideNumber}: ${change.message}`
    ),
    model: calls[0]?.model ?? getLiteLLMConfig("convert").model,
    tokensUsed: calls.reduce(
      (total, call) => total + call.promptTokens + call.completionTokens,
      0
    ),
    calls,
    extractionWarnings: unique
      .filter((finding) => finding.severity === "warning")
      .map((finding) => finding.message),
    reviewPreviews,
    ...(revisions ? { revisions } : {}),
  };
}

function failure(
  error: unknown,
  stage: DiagnosticStage,
  calls: ModelCallUsage[]
): ConversionError {
  let code: DiagnosticCode = "unknown_error";
  if (error instanceof PptxPackageError) code = "pptx_invalid";
  if (error instanceof PowerPointPlanError) code = error.code;
  const diagnostic = createJobDiagnostic(
    error instanceof LiteLLMError ||
      error instanceof PdfRenderingError ||
      error instanceof PowerPointRenderingError
      ? { ...error.diagnostic, stage }
      : { stage, code }
  );
  return { error: describeJobDiagnostic(diagnostic), diagnostic, calls };
}

export async function convertPowerPoint(
  buffer: Buffer,
  filename: string,
  options: PowerPointConversionOptions = {}
): Promise<PowerPointConversionResult | ConversionError> {
  const calls: ModelCallUsage[] = [];
  const clock = workflowClock(options);
  let stage: DiagnosticStage = "pptx_prepare";
  try {
    if (!filename.toLowerCase().endsWith(".pptx"))
      throw new PptxPackageError(
        "pptx_invalid",
        "Upload a .pptx presentation."
      );
    const inputError = validateDocumentInput(buffer, filename);
    if (inputError) throw new PptxPackageError("pptx_invalid", inputError);
    const source = await inspectPptx(buffer);
    const mechanicalPlan = buildPptxMechanicalPlan(source);
    const mechanical = hasOperations(mechanicalPlan)
      ? await applyPptxRepairs(buffer, mechanicalPlan, { revisioned: true })
      : null;
    const modelSource = mechanical?.inspection ?? source;
    const sourceChecks = checkPptxAccessibility(modelSource);
    const sourceEvidence = await clock.render(buffer, source.slideCount);
    const modelEvidence =
      mechanical && !mechanical.buffer.equals(buffer)
        ? await clock.render(mechanical.buffer, modelSource.slideCount)
        : sourceEvidence;
    stage = "conversion";
    clock.needTime(45_000);
    const config = getLiteLLMConfig("convert");
    const call = await callLiteLLM(
      POWERPOINT_REPAIR_PROMPT,
      [
        {
          type: "text",
          text: `PowerPoint inventory after deterministic cleanup (untrusted source data):\n${JSON.stringify(modelSource)}\nMachine-detected source defects (repair supported, unambiguous cases):\n${JSON.stringify(sourceChecks)}\nVerified empty placeholders have already been removed. Keep them removed; do not propose object deletion or restore absent placeholders.`,
        },
        ...visualInput(modelEvidence.pdf, modelEvidence.images),
      ],
      config,
      AbortSignal.timeout(
        Math.floor(
          Math.min(110_000, Math.max(1000, clock.remaining() - 40_000))
        )
      )
    );
    calls.push(await toModelCallUsage("convert", call, config));
    const response = jsonObject(call.content);
    const semanticPlan = response ? { slides: response.slides } : null;
    if (
      (call.finishReason && call.finishReason !== "stop") ||
      !response ||
      Object.keys(response).some(
        (key) => !["slides", "findings"].includes(key)
      ) ||
      !completePowerPointPlan(semanticPlan, modelSource) ||
      semanticPlan.slides.some(
        (slide) => slide.removeEmptyPlaceholders !== undefined
      ) ||
      editsRemovedPlaceholder(semanticPlan, mechanicalPlan)
    )
      throw new PowerPointPlanError("pptx_invalid_plan");
    const proposedFindings = parsePowerPointFindings(
      response.findings,
      modelSource
    );
    if (!proposedFindings) throw new PowerPointPlanError("pptx_invalid_plan");
    let plan: PptxRepairPlan;
    try {
      plan = normalizePptxReadingOrders(
        mergePptxRepairPlans(mechanicalPlan, semanticPlan),
        source
      );
    } catch {
      throw new PowerPointPlanError("pptx_invalid_plan");
    }
    let tracked = await createPptxRevisionBundle(buffer, plan);
    stage = "pptx_prepare";
    // Always render the actual saved candidate, even for metadata-only changes.
    let outputEvidence = await clock.render(
      tracked.result.buffer,
      tracked.result.inspection.slideCount
    );
    stage = "audit";
    let audited = await auditOutput({
      source,
      repaired: tracked.result,
      sourceEvidence,
      outputEvidence,
      proposedFindings,
      allowCorrection: true,
      clock,
      calls,
    });
    if (
      audited.correction &&
      hasOperations(audited.correction) &&
      clock.remaining() >= 55_000
    ) {
      try {
        if (editsRemovedPlaceholder(audited.correction, mechanicalPlan))
          throw new PowerPointPlanError("pptx_invalid_plan");
        const merged = normalizePptxReadingOrders(
          mergePptxRepairPlans(plan, audited.correction),
          source
        );
        const corrected = await createPptxRevisionBundle(buffer, merged);
        if (!corrected.result.buffer.equals(tracked.result.buffer)) {
          const correctedEvidence = await clock.render(
            corrected.result.buffer,
            corrected.result.inspection.slideCount
          );
          // A second independent audit is the final authority; no unverified loop.
          const finalAudit = await auditOutput({
            source,
            repaired: corrected.result,
            sourceEvidence,
            outputEvidence: correctedEvidence,
            proposedFindings: audited.findings.filter(
              (finding) => finding.code !== "audit-incomplete"
            ),
            allowCorrection: false,
            clock,
            calls,
          });
          if (
            finalAudit.findings.some(
              (finding) => finding.code === "audit-incomplete"
            )
          )
            throw new Error("The corrective output was not fully audited");
          tracked = corrected;
          outputEvidence = correctedEvidence;
          audited = finalAudit;
        }
      } catch {
        audited.findings.push({
          code: "correction-incomplete",
          severity: "warning",
          message:
            "An additional repair could not be verified, so the app kept the previously checked version.",
          suggestion:
            "Review the remaining slide-specific findings before sharing this presentation.",
        });
      }
    }
    const previews = await buildPowerPointReviewPreviews(
      sourceEvidence.images,
      outputEvidence.images,
      tracked.bundle.changes.flatMap((change) => [
        change.slideNumber,
        ...(change.generatedSlideNumbers ?? []),
      ]),
      tracked.bundle.changes.flatMap(
        (change) => change.generatedSlideNumbers ?? []
      )
    );
    return finishResult(
      tracked.result,
      audited.findings,
      calls,
      previews,
      tracked.bundle
    );
  } catch (error) {
    return failure(error, stage, calls);
  }
}

/** Rechecks exactly the user's replayed selection. It never repairs or reapplies declined edits. */
export async function recheckPowerPointRevision(
  sourceBuffer: Buffer,
  candidate: Buffer,
  changes: PptxChange[] = [],
  options: PowerPointConversionOptions = {}
): Promise<PowerPointConversionResult | ConversionError> {
  const calls: ModelCallUsage[] = [];
  const clock = workflowClock(options);
  let stage: DiagnosticStage = "pptx_prepare";
  try {
    const inputError = validateDocumentInput(sourceBuffer, "source.pptx");
    if (inputError) throw new PptxPackageError("pptx_invalid", inputError);
    const source = await inspectPptx(sourceBuffer);
    const inspection = await inspectPptx(candidate);
    const appendedSlides = changes.flatMap((change) =>
      change.type === "long-description"
        ? (change.generatedSlideNumbers ?? [])
        : []
    );
    if (
      inspection.slideCount < source.slideCount ||
      inspection.slideCount > 60 ||
      appendedSlides.length !== inspection.slideCount - source.slideCount ||
      new Set(appendedSlides).size !== appendedSlides.length ||
      appendedSlides.some(
        (number) =>
          !Number.isInteger(number) ||
          number <= source.slideCount ||
          number > inspection.slideCount
      ) ||
      source.slides.some(
        (slide, index) => inspection.slides[index]?.partName !== slide.partName
      ) ||
      changes.some(
        (change) =>
          change.type === "long-description" &&
          (!source.slides.some(
            (slide) =>
              slide.slideNumber === change.slideNumber &&
              slide.objects.some((object) => object.id === change.objectId)
          ) ||
            !change.generatedSlideNumbers?.length)
      )
    )
      throw new PowerPointPlanError("pptx_invalid_plan");
    const sourceEvidence = await clock.render(sourceBuffer, source.slideCount);
    const outputEvidence = await clock.render(candidate, inspection.slideCount);
    const repaired: PptxRepairResult = {
      buffer: candidate,
      inspection,
      changes,
      findings: uniqueFindings([
        ...inspection.findings,
        ...checkPptxAccessibility(inspection),
      ]),
    };
    stage = "audit";
    const audited = await auditOutput({
      source,
      repaired,
      sourceEvidence,
      outputEvidence,
      proposedFindings: [],
      allowCorrection: false,
      clock,
      calls,
    });
    const previews = await buildPowerPointReviewPreviews(
      sourceEvidence.images,
      outputEvidence.images,
      changes.flatMap((change) => [
        change.slideNumber,
        ...(change.generatedSlideNumbers ?? []),
      ]),
      appendedSlides
    );
    return finishResult(repaired, audited.findings, calls, previews);
  } catch (error) {
    return failure(error, stage, calls);
  }
}
