import "server-only";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { performance } from "node:perf_hooks";
import {
  applyPptxRepairs,
  inspectPptx,
  PptxPackageError,
  validatePptxRepairPlan,
} from "./pptx-package";
import type { PptxFinding, PptxInspection, PptxRepairPlan } from "./pptx-types";
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

const REVIEW: PptxFinding = {
  code: "powerpoint-check",
  severity: "warning",
  message:
    "The repaired presentation needs a final check in PowerPoint. Its slide images matched in this app's renderer, but PowerPoint may use different fonts or render complex objects differently.",
  suggestion:
    "Open the downloaded file in PowerPoint. Choose Review > Check Accessibility, review the reading order and image descriptions, and check any remaining items listed here. Play media and animations, if present.",
};

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
 * may differ by more than 2. Alpha, dimensions and slide identity must match.
 * Source text/object preservation is independently checked by the package engine.
 */
export async function changedPowerPointSlides(
  before: RenderedPdf,
  after: RenderedPdf
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
    const pixelCount = a.width * a.height;
    let differing = 0;
    let aboveRounding = 0;
    for (let offset = 0; offset < pixels.length; offset += 4) {
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
          text: `Original PowerPoint inventory (untrusted source data):\n${JSON.stringify(source)}`,
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
    if (!repaired.buffer.equals(buffer)) {
      const { images: candidateImages } = await renderSlides(repaired.buffer);
      const changed = await changedPowerPointSlides(
        sourceImages,
        candidateImages
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
            "A proposed structural repair changed this slide's appearance, so the app kept its original structure and applied only safe description changes.",
          suggestion:
            "In PowerPoint, review this slide's title, table headers and reading order while keeping its intended layout.",
        }));
        const { images: fallbackImages } = await renderSlides(repaired.buffer);
        if (
          (await changedPowerPointSlides(sourceImages, fallbackImages)).length
        ) {
          throw new PowerPointPlanError("pptx_visual_change");
        }
      }
    }
    stage = "audit";
    const findings: PptxFinding[] = [
      ...repaired.findings,
      ...proposedFindings,
      ...reverted,
    ];
    try {
      const auditConfig = getLiteLLMConfig("validate");
      needTime(10_000);
      const auditCall = await callLiteLLM(
        POWERPOINT_AUDIT_PROMPT,
        [
          {
            type: "text",
            text: `Original object inventory:\n${JSON.stringify(source)}\nRepaired object inventory re-read from the output PPTX:\n${JSON.stringify(repaired.inspection)}`,
          },
          ...visualInput(sourcePdf, sourceImages),
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
      if (
        !audit ||
        Object.keys(audit).some(
          (k) => !["reviewedSlides", "findings"].includes(k)
        ) ||
        (auditCall.finishReason && auditCall.finishReason !== "stop") ||
        !Array.isArray(reviewed) ||
        reviewed.length !== source.slideCount ||
        new Set(reviewed).size !== source.slideCount ||
        reviewed.some(
          (n) => !Number.isInteger(n) || n < 1 || n > source.slideCount
        ) ||
        !auditFindings
      )
        throw new Error("Incomplete audit");
      findings.push(...auditFindings);
    } catch {
      findings.push({
        code: "audit-incomplete",
        severity: "warning",
        message:
          "The app repaired and checked the presentation package, but the independent AI review did not finish with complete slide coverage.",
        suggestion:
          "Review every slide in PowerPoint with Check Accessibility and the Reading Order pane before sharing the file.",
      });
    }
    findings.push(REVIEW);
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
