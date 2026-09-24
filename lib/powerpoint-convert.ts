import "server-only";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { performance } from "node:perf_hooks";
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

function visualInput(pdf: Buffer, rendered: RenderedPdf): LiteLLMContentPart[] {
  return [
    {
      type: "file",
      file: {
        filename: "slide-reference.pdf",
        file_data: `data:application/pdf;base64,${pdf.toString("base64")}`,
      },
    },
    {
      type: "text",
      text: "This PDF is a temporary slide preview rendered from the original PPTX. It includes hidden slides, excludes speaker-note pages, and is not the editable output. Match slide numbers to the following images and object inventory. Do not treat PDF accessibility tags as PowerPoint metadata.",
    },
    ...rendered.pages.flatMap((page) => [
      {
        type: "text" as const,
        text: `PowerPoint slide ${page.pageNumber} of ${rendered.pageCount}:`,
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

export async function convertPowerPoint(
  buffer: Buffer,
  filename: string
): Promise<PowerPointConversionResult | ConversionError> {
  const calls: ModelCallUsage[] = [];
  let stage: DiagnosticStage = "pptx_prepare";
  const deadline = performance.now() + 260_000;
  const needTime = (minimum: number) => {
    if (deadline - performance.now() < minimum)
      throw new PowerPointRenderingError();
  };
  const remaining = () => Math.max(1, deadline - performance.now() - 5000);
  const renderSlides = async (pptx: Buffer) => {
    needTime(6000);
    const pdf = await renderPowerPointToPdf(
      pptx,
      Math.min(60_000, remaining())
    );
    needTime(6000);
    const images = await renderPdfPages(pdf, {
      timeoutMs: Math.min(120_000, remaining()),
    });
    return { pdf, images };
  };
  try {
    if (!filename.toLowerCase().endsWith(".pptx"))
      throw new PptxPackageError(
        "pptx_invalid",
        "Upload a .pptx presentation."
      );
    const source = await inspectPptx(buffer);
    const sourceChecks = checkPptxAccessibility(source);
    const { pdf: sourcePdf, images: sourceImages } = await renderSlides(buffer);
    if (sourceImages.pageCount !== source.slideCount)
      throw new PowerPointRenderingError();
    stage = "conversion";
    const config = getLiteLLMConfig("convert");
    needTime(45_000);
    const call = await callLiteLLM(
      POWERPOINT_REPAIR_PROMPT,
      [
        {
          type: "text",
          text: `Original PowerPoint inventory (untrusted source data):\n${JSON.stringify(source)}\nMachine-detected source defects (repair supported, unambiguous cases):\n${JSON.stringify(sourceChecks)}`,
        },
        ...visualInput(sourcePdf, sourceImages),
      ],
      config,
      AbortSignal.timeout(
        Math.floor(Math.min(110_000, Math.max(1000, remaining() - 40_000)))
      )
    );
    calls.push(await toModelCallUsage("convert", call, config));
    const response = jsonObject(call.content);
    const plan = response ? { slides: response.slides } : null;
    if (call.finishReason && call.finishReason !== "stop")
      throw new PowerPointPlanError("pptx_invalid_plan");
    if (
      !response ||
      Object.keys(response).some((k) => !["slides", "findings"].includes(k)) ||
      !completePowerPointPlan(plan, source)
    ) {
      throw new PowerPointPlanError("pptx_invalid_plan");
    }
    const proposedFindings = parsePowerPointFindings(response.findings, source);
    if (!proposedFindings) throw new PowerPointPlanError("pptx_invalid_plan");
    let repaired = await applyPptxRepairs(buffer, plan);
    stage = "pptx_prepare";
    let reverted: PptxFinding[] = [];
    let outputImages = sourceImages;
    if (!repaired.buffer.equals(buffer)) {
      const { images: candidateImages } = await renderSlides(repaired.buffer);
      outputImages = candidateImages;
      const changed = await changedPowerPointSlides(
        sourceImages,
        candidateImages,
        { source, changes: repaired.changes }
      );
      if (changed.length) {
        // Rebuild from immutable source. Keep only description metadata on changed slides.
        const saferPlan: PptxRepairPlan = {
          slides: plan.slides.map((s) =>
            changed.includes(s.slideNumber)
              ? { slideNumber: s.slideNumber, descriptions: s.descriptions }
              : s
          ),
        };
        repaired = await applyPptxRepairs(buffer, saferPlan);
        reverted = changed.map((slideNumber) => ({
          code: "visual-change-skipped",
          severity: "warning",
          slideNumber,
          message:
            "A proposed repair changed this slide's appearance outside the supported repair area, so the app kept its original structure and applied only safe description changes.",
          suggestion:
            "In PowerPoint, review this slide's title, table headers and reading order while keeping its intended layout.",
        }));
        const { images: fallbackImages } = await renderSlides(repaired.buffer);
        outputImages = fallbackImages;
        if (
          (
            await changedPowerPointSlides(sourceImages, fallbackImages, {
              source,
              changes: repaired.changes,
            })
          ).length
        ) {
          throw new PowerPointPlanError("pptx_visual_change");
        }
      }
    }
    stage = "audit";
    const review = buildPowerPointReview(
      repaired.inspection,
      repaired.findings,
      proposedFindings,
      reverted
    );
    // Unresolved until a complete audit explicitly reviews every concern.
    let findings = [...review.fixed, ...review.concerns.map((c) => c.finding)];
    try {
      const auditConfig = getLiteLLMConfig("validate");
      needTime(10_000);
      const auditCall = await callLiteLLM(
        POWERPOINT_AUDIT_PROMPT,
        [
          {
            type: "text",
            text: `Original object inventory:\n${JSON.stringify(source)}\nRepaired object inventory re-read from the output PPTX:\n${JSON.stringify(repaired.inspection)}\nApplied changes:\n${JSON.stringify(repaired.changes)}\nConfirmed output defects or checks without sufficient evidence (retained by code; do not duplicate):\n${JSON.stringify(review.fixed)}\nConcerns requiring an explicit findingReviews decision using the saved output evidence:\n${JSON.stringify(review.concerns)}`,
          },
          ...visualInput(sourcePdf, sourceImages),
          ...outputImages.pages
            .filter((page) =>
              repaired.changes.some(
                (change) =>
                  change.type === "table-caption" &&
                  change.slideNumber === page.pageNumber
              )
            )
            .flatMap((page): LiteLLMContentPart[] => [
              {
                type: "text",
                text: `ACTUAL REPAIRED slide ${page.pageNumber}: its table/caption structure intentionally changed. Compare this output image with the original above. Verify the new header meanings, preserved cell relationships, readable text, caption placement and lack of clipping. This image comes from the saved PPTX.`,
              },
              {
                type: "image_url",
                image_url: {
                  url: `data:image/png;base64,${page.png.toString("base64")}`,
                  detail: "high",
                },
              },
            ]),
        ],
        auditConfig,
        AbortSignal.timeout(Math.floor(Math.min(110_000, remaining())))
      );
      calls.push(await toModelCallUsage("validate", auditCall, auditConfig));
      const audit = jsonObject(auditCall.content);
      const reviewed = audit?.reviewedSlides;
      const auditFindings = parsePowerPointFindings(
        audit?.findings,
        repaired.inspection
      );
      const remainingConcerns = resolvePowerPointReviews(
        audit?.findingReviews,
        review.concerns
      );
      if (
        !audit ||
        Object.keys(audit).some(
          (k) => !["reviewedSlides", "findingReviews", "findings"].includes(k)
        ) ||
        (auditCall.finishReason && auditCall.finishReason !== "stop") ||
        !Array.isArray(reviewed) ||
        reviewed.length !== source.slideCount ||
        new Set(reviewed).size !== source.slideCount ||
        reviewed.some(
          (n) => !Number.isInteger(n) || n < 1 || n > source.slideCount
        ) ||
        !auditFindings ||
        !remainingConcerns
      )
        throw new Error("Incomplete audit");
      findings = [...review.fixed, ...remainingConcerns, ...auditFindings];
    } catch {
      findings.push({
        code: "audit-incomplete",
        severity: "warning",
        message:
          "The app repaired and checked the presentation package, but the independent AI review did not finish checking every slide and review item.",
        suggestion:
          "Review every slide in PowerPoint with Check Accessibility and the Reading Order pane before sharing the file.",
      });
    }
    const seen = new Set<string>();
    const unique = findings.filter((f) => {
      const key = `${f.slideNumber ?? 0}:${f.objectId ?? ""}:${f.code}:${f.message}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return {
      pptx: repaired.buffer,
      pageCount: source.slideCount,
      errors: unique.map((f) => findingForUi(f, repaired.inspection)),
      changes: repaired.changes.map(
        (c) => `Slide ${c.slideNumber}: ${c.message}`
      ),
      model: calls[0]?.model ?? config.model,
      tokensUsed: calls.reduce(
        (total, c) => total + c.promptTokens + c.completionTokens,
        0
      ),
      calls,
      extractionWarnings: unique
        .filter((f) => f.severity === "warning")
        .map((f) => f.message),
    };
  } catch (error) {
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
}
