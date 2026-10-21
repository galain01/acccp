import "server-only";
import { PDFDocument } from "pdf-lib";
import { performance } from "node:perf_hooks";
import { validatePdfInput } from "./document-input";
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
  nativePdfRequest,
  NativePdfError,
  objectRecord,
  pdfSha256,
  type NativePdfState,
  type NativePdfTag,
  type NativePdfPlan,
  type NativePdfOperation,
  type NativePdfFinding,
  type NativePdfTransport,
} from "./native-pdf-worker";
import {
  NATIVE_PDF_REPAIR_PROMPT,
  NATIVE_PDF_AUDIT_PROMPT,
} from "./prompts/native-pdf-accessibility";

interface Batch {
  pages: number[];
  tags: NativePdfTag[];
  visualPages: number[];
  first: boolean;
}
export interface NativePdfConversionResult {
  pdf: Buffer;
  errors: AccessibilityError[];
  changes: string[];
  model: string;
  tokensUsed: number;
  calls: ModelCallUsage[];
  extractionWarnings: string[];
  pageCount: number;
  nativePdfChecks: NativePdfState["machineChecks"] & {
    auditComplete: boolean;
    screenReaderTestPerformed: false;
  };
}
const invalid = (): never => {
  throw new NativePdfError("native_pdf_invalid_plan");
};
const text = (value: unknown, max = 2000): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= max;
const exact = (value: unknown, expected: (string | number)[]) =>
  Array.isArray(value) &&
  value.length === expected.length &&
  new Set(value).size === value.length &&
  value.every((item) => expected.includes(item));
function pagesOf(tag: NativePdfTag): number[] {
  return [
    ...new Set(
      [tag.pageNumber, ...tag.content.map((c) => c.pageNumber)].filter(
        (n): n is number => typeof n === "number"
      )
    ),
  ].sort((a, b) => a - b);
}
/** Every actual tag is assigned once; cross-page content receives companion pages. */
export function nativePdfBatches(state: NativePdfState): Batch[] {
  const groups: Batch[] = [];
  for (let start = 1; start <= state.pageCount; start += 4) {
    const pages = Array.from(
      { length: Math.min(4, state.pageCount - start + 1) },
      (_, n) => n + start
    );
    const tags = state.inventory.tags.filter((tag) =>
      pages.includes(pagesOf(tag)[0] ?? 1)
    );
    for (let offset = 0; offset < Math.max(1, tags.length); offset += 200) {
      const assigned = tags.slice(offset, offset + 200);
      const visualPages = [
        ...new Set([...pages, ...assigned.flatMap(pagesOf)]),
      ].sort((a, b) => a - b);
      // Two PDF excerpts plus PNGs still fit the gateway image allowance.
      if (visualPages.length > 12 || JSON.stringify(assigned).length > 350_000)
        throw new NativePdfError("pdf_complexity_limit");
      groups.push({
        pages,
        tags: assigned,
        visualPages,
        first: groups.length === 0,
      });
    }
  }
  if (
    groups.length > 40 ||
    groups.reduce((n, b) => n + b.tags.length, 0) !==
      state.inventory.tags.length
  )
    throw new NativePdfError("pdf_complexity_limit");
  return groups;
}
function parsed(value: string): Record<string, unknown> {
  if (value.length > 1_000_000) return invalid();
  try {
    const result: unknown = JSON.parse(
      value.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")
    );
    return objectRecord(result) ? result : invalid();
  } catch {
    return invalid();
  }
}
export function parseNativePdfFindings(
  raw: unknown,
  batch: Batch
): NativePdfFinding[] {
  if (!Array.isArray(raw) || raw.length > 250) return invalid();
  return raw.map((f) => {
    if (
      !objectRecord(f) ||
      Object.keys(f).some(
        (k) =>
          ![
            "code",
            "severity",
            "pageNumber",
            "tagId",
            "location",
            "message",
            "suggestion",
          ].includes(k)
      ) ||
      !text(f.code, 100) ||
      !/^[a-z][a-z0-9_-]*$/.test(f.code) ||
      !["error", "warning"].includes(String(f.severity)) ||
      !text(f.location, 500) ||
      !text(f.message) ||
      !text(f.suggestion) ||
      !(
        (f.pageNumber === null && batch.first) ||
        (Number.isInteger(f.pageNumber) &&
          batch.visualPages.includes(Number(f.pageNumber)))
      )
    )
      return invalid();
    const tag =
      f.tagId === undefined
        ? undefined
        : batch.tags.find((t) => t.id === f.tagId);
    if (
      (f.tagId !== undefined && !tag) ||
      (tag &&
        pagesOf(tag).length &&
        !pagesOf(tag).includes(Number(f.pageNumber)))
    )
      return invalid();
    return {
      code: f.code,
      severity: f.severity as "error" | "warning",
      message: f.message,
      suggestion: f.suggestion,
      location: f.location,
      ...(typeof f.pageNumber === "number" ? { pageNumber: f.pageNumber } : {}),
      ...(tag ? { tagId: tag.id } : {}),
    };
  });
}
export function parseNativePdfPlan(
  raw: Record<string, unknown>,
  batch: Batch,
  state: NativePdfState
): {
  operations: NativePdfOperation[];
  findings: NativePdfFinding[];
  language?: string;
  title?: string;
} {
  if (
    Object.keys(raw).some(
      (k) =>
        ![
          "reviewedPages",
          "reviewedTagIds",
          "operations",
          "findings",
          "language",
          "title",
        ].includes(k)
    ) ||
    !exact(raw.reviewedPages, batch.pages) ||
    !exact(
      raw.reviewedTagIds,
      batch.tags.map((t) => t.id)
    ) ||
    !Array.isArray(raw.operations) ||
    raw.operations.length > 200
  )
    return invalid();
  if (
    raw.language !== undefined &&
    (!batch.first ||
      !!state.inventory.language ||
      !text(raw.language, 35) ||
      !/^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8})*$/.test(raw.language))
  )
    return invalid();
  if (
    raw.title !== undefined &&
    (!batch.first || !!state.inventory.title || !text(raw.title, 300))
  )
    return invalid();
  const seen = new Set<string>();
  const operations = raw.operations.map((op): NativePdfOperation => {
    if (!objectRecord(op)) return invalid();
    const tag = batch.tags.find((t) => t.id === op.tagId);
    if (!tag || seen.has(tag.id)) return invalid();
    seen.add(tag.id);
    const common = { tagId: tag.id, expected: tag.snapshot };
    if (
      op.type === "set_role" &&
      tag.editable.role &&
      [
        "P",
        "H",
        "H1",
        "H2",
        "H3",
        "H4",
        "H5",
        "H6",
        "Caption",
        "Note",
      ].includes(String(op.role)) &&
      Object.keys(op).every((k) => ["type", "tagId", "role"].includes(k))
    )
      return { ...common, type: "set_role", role: String(op.role) };
    if (
      op.type === "set_alt" &&
      tag.editable.alt &&
      text(op.alt, 8000) &&
      Object.keys(op).every((k) => ["type", "tagId", "alt"].includes(k))
    )
      return { ...common, type: "set_alt", alt: op.alt };
    if (
      op.type === "set_table_header" &&
      tag.editable.tableHeader &&
      ["Column", "Row"].includes(String(op.scope)) &&
      Object.keys(op).every((k) => ["type", "tagId", "scope"].includes(k))
    )
      return {
        ...common,
        type: "set_table_header",
        scope: op.scope as "Column" | "Row",
      };
    return invalid();
  });
  return {
    operations,
    findings: parseNativePdfFindings(raw.findings, batch),
    ...(typeof raw.language === "string" ? { language: raw.language } : {}),
    ...(typeof raw.title === "string" ? { title: raw.title } : {}),
  };
}
async function pool<T, R>(
  items: T[],
  fn: (item: T, index: number) => Promise<R>,
  stop: boolean
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;
  let failed = false;
  await Promise.all(
    Array.from({ length: Math.min(4, items.length) }, async () => {
      while (next < items.length && !(stop && failed)) {
        const index = next++;
        try {
          results[index] = {
            status: "fulfilled",
            value: await fn(items[index], index),
          };
        } catch (reason) {
          failed = true;
          results[index] = { status: "rejected", reason };
        }
      }
    })
  );
  return Array.from(
    { length: items.length },
    (_, index) =>
      results[index] ?? {
        status: "rejected",
        reason: new NativePdfError("native_pdf_timeout"),
      }
  );
}
export function parseNativePdfAudit(
  raw: Record<string, unknown>,
  batch: Batch
): NativePdfFinding[] {
  if (
    Object.keys(raw).some(
      (k) =>
        ![
          "reviewedPages",
          "reviewedTagIds",
          "artifactReviews",
          "textReviews",
          "findings",
        ].includes(k)
    ) ||
    !exact(raw.reviewedPages, batch.pages) ||
    !exact(
      raw.reviewedTagIds,
      batch.tags.map((t) => t.id)
    )
  )
    return invalid();
  const findings = parseNativePdfFindings(raw.findings, batch);
  for (const key of ["artifactReviews", "textReviews"] as const) {
    const reviews = raw[key];
    const pass =
      key === "artifactReviews"
        ? "decorative-or-redundant"
        : "matches-visible-text";
    const failure =
      key === "artifactReviews"
        ? "meaningful-content-excluded"
        : "incorrect-or-incomplete";
    if (
      !Array.isArray(reviews) ||
      !exact(
        reviews.map((r) => (objectRecord(r) ? r.pageNumber : undefined)),
        batch.pages
      )
    )
      return invalid();
    for (const review of reviews) {
      if (
        !objectRecord(review) ||
        Object.keys(review).some(
          (k) => !["pageNumber", "decision", "explanation"].includes(k)
        ) ||
        ![pass, failure, "uncertain"].includes(String(review.decision)) ||
        !text(review.explanation, 1500)
      )
        return invalid();
      if (
        review.decision !== pass &&
        !findings.some(
          (f) =>
            f.pageNumber === review.pageNumber &&
            (f.code === "missing-content" ||
              (key === "textReviews" && f.code === "ocr-accuracy"))
        )
      )
        return invalid();
    }
  }
  return findings;
}
async function subset(doc: PDFDocument, pages: number[]): Promise<Buffer> {
  const part = await PDFDocument.create();
  for (const page of await part.copyPages(
    doc,
    pages.map((n) => n - 1)
  ))
    part.addPage(page);
  return Buffer.from(await part.save());
}
function visuals(pages: RenderedPdfPage[]): LiteLLMContentPart[] {
  return pages.flatMap((p) => [
    {
      type: "text" as const,
      text: `Original physical PDF page ${p.pageNumber}; independent pixel comparison confirms the repaired page is identical.`,
    },
    {
      type: "image_url" as const,
      image_url: {
        url: `data:image/png;base64,${p.png.toString("base64")}` as const,
        detail: "high" as const,
      },
    },
  ]);
}
function scope(
  state: NativePdfState,
  batch: Batch,
  outstandingRepairFindings: NativePdfFinding[] = [],
  evidenceRole: "current-saved-pdf" | "before-repair-comparison" = "current-saved-pdf"
): string {
  const payload = {
    evidenceRole,
    assignedPages: batch.pages,
    assignedTagIds: batch.tags.map((t) => t.id),
    companionPages: batch.visualPages,
    firstBatch: batch.first,
    candidateSha256: state.candidateSha256,
    language: state.inventory.language,
    title: state.inventory.title,
    tags: batch.tags,
    // Every hierarchy link remains available; only assigned tags may change.
    hierarchy: state.inventory.tags.map((t) => ({
      id: t.id,
      parentId: t.parentId,
      role: t.role,
      pageNumber: t.pageNumber,
      ...(/^H[1-6]?$/.test(t.role) ? { text: t.text } : {}),
    })),
    excludedTextAndPageChecks: batch.pages.map(
      (n) => state.inventory.page_content[n - 1]
    ),
    nestedFormContent: state.inventory.form_content,
    forms: state.inventory.forms,
    // Earlier failures may already be repaired. Only checks reopened from the
    // delivered output are evidence of its remaining machine defects.
    ...(evidenceRole === "current-saved-pdf"
      ? {
          machineChecks: state.machineChecks,
          findings: state.findings.filter(
            (f) => !f.pageNumber || batch.visualPages.includes(f.pageNumber)
          ),
          outstandingRepairFindings: outstandingRepairFindings.filter(
            (f) => !f.pageNumber || batch.visualPages.includes(f.pageNumber)
          ),
        }
      : {}),
  };
  const value = JSON.stringify(payload);
  if (value.length > 900_000) throw new NativePdfError("pdf_complexity_limit");
  return value;
}
function forUi(f: NativePdfFinding): AccessibilityError {
  return {
    type: "other",
    severity: f.severity,
    category: "source-review",
    title: f.pageNumber ? `Review PDF page ${f.pageNumber}` : "Review the PDF",
    message: f.message,
    suggestion:
      f.suggestion ??
      "Review this item in a PDF accessibility editor or ask your accessibility support team for help before sharing the PDF.",
    location: {
      scope: f.pageNumber || f.tagId ? "element" : "document",
      sourcePages: f.pageNumber ? [f.pageNumber] : null,
      printedPageLabel: null,
      section: null,
      locator: (
        f.location ?? (f.tagId ? `PDF item ${f.tagId}` : "Whole document")
      ).slice(0, 200),
      quote: null,
    },
  };
}
export async function repairNativePdf(
  source: Buffer,
  filename: string,
  options: { transport?: NativePdfTransport } = {}
): Promise<NativePdfConversionResult | ConversionError> {
  const calls: ModelCallUsage[] = [];
  let stage: DiagnosticStage = "native_pdf_prepare";
  const deadline = performance.now() + 260_000;
  const remaining = () => Math.floor(deadline - performance.now() - 5000);
  const time = (minimum = 1000) => {
    if (remaining() < minimum) throw new NativePdfError("native_pdf_timeout");
    return remaining();
  };
  try {
    if (validatePdfInput(source, filename))
      throw new NativePdfError("pdf_invalid");
    const prepared = await nativePdfRequest("prepare", source, time());
    const rendered: RenderedPdf = await renderPdfPages(source, {
      timeoutMs: Math.min(90_000, time()),
    });
    if (
      rendered.pageCount !== prepared.pageCount ||
      rendered.pages.length !== prepared.pageCount ||
      rendered.pages.some((p, i) => p.pageNumber !== i + 1)
    )
      throw new NativePdfError("pdf_protocol_error");
    const originalDoc = await PDFDocument.load(source, {
      updateMetadata: false,
    });
    const sourceBatches = nativePdfBatches(prepared);
    stage = "native_pdf_repair";
    const config = getLiteLLMConfig("convert");
    const usages: ModelCallUsage[] = [];
    const proposals = await pool(
      sourceBatches,
      async (batch, index) => {
        time(40_000);
        const excerpt = await subset(originalDoc, batch.visualPages);
        const call = await callLiteLLM(
          NATIVE_PDF_REPAIR_PROMPT,
          [
            {
              type: "text",
              text: `Untrusted saved PDF inventory:\n${scope(prepared, batch)}\nThe attached excerpt maps pages in this order: ${batch.visualPages.join(", ")}.`,
            },
            {
              type: "file",
              file: {
                filename: "original-excerpt.pdf",
                file_data: `data:application/pdf;base64,${excerpt.toString("base64")}`,
              },
            },
            ...visuals(
              rendered.pages.filter((p) =>
                batch.visualPages.includes(p.pageNumber)
              )
            ),
          ],
          config,
          AbortSignal.timeout(Math.min(110_000, time() - 30_000))
        );
        usages[index] = await toModelCallUsage("convert", call, config);
        if (call.finishReason && call.finishReason !== "stop") return invalid();
        return parseNativePdfPlan(parsed(call.content), batch, prepared);
      },
      true
    );
    calls.push(...usages.filter(Boolean));
    const plan: NativePdfPlan = {
      schemaVersion: 1,
      candidateSha256: prepared.candidateSha256,
      operations: [],
    };
    const retained: NativePdfFinding[] = [];
    for (const result of proposals) {
      if (result.status === "rejected") throw result.reason;
      plan.operations.push(...result.value.operations);
      retained.push(...result.value.findings);
      if (result.value.language) plan.language = result.value.language;
      if (result.value.title) plan.title = result.value.title;
    }
    if (
      plan.operations.length > 500 ||
      new Set(plan.operations.map((o) => o.tagId)).size !==
        plan.operations.length
    )
      return invalid();
    const repaired = await nativePdfRequest(
      "repair",
      source,
      time(),
      prepared,
      plan,
      options.transport
    );
    if (repaired.pageCount !== prepared.pageCount)
      throw new NativePdfError("native_pdf_preservation");
    stage = "native_pdf_audit";
    const actualDoc = await PDFDocument.load(repaired.pdf, {
      updateMetadata: false,
    });
    const batches = nativePdfBatches(repaired);
    const auditUsages: ModelCallUsage[] = [];
    const audits = await pool(
      batches,
      async (batch, index) => {
        time(4000);
        const excerpts = await Promise.all([
          subset(originalDoc, batch.visualPages),
          subset(actualDoc, batch.visualPages),
        ]);
        const auditConfig = getLiteLLMConfig("validate");
        const call = await callLiteLLM(
          NATIVE_PDF_AUDIT_PROMPT,
          [
            {
              type: "text",
              text: `Untrusted exact saved output evidence:\n${scope(repaired, batch, retained)}\nPrior inventory for comparison:\n${scope(prepared, { ...batch, tags: prepared.inventory.tags.filter((t) => batch.tags.some((a) => a.id === t.id)) }, [], "before-repair-comparison")}\nRepairs: ${JSON.stringify(repaired.changes)}\nBoth excerpts map physical pages ${batch.visualPages.join(", ")} in that order.`,
            },
            ...excerpts.map(
              (pdf, i): LiteLLMContentPart => ({
                type: "file",
                file: {
                  filename: i ? "repaired-excerpt.pdf" : "original-excerpt.pdf",
                  file_data: `data:application/pdf;base64,${pdf.toString("base64")}`,
                },
              })
            ),
            ...visuals(
              rendered.pages.filter((p) =>
                batch.visualPages.includes(p.pageNumber)
              )
            ),
          ],
          auditConfig,
          AbortSignal.timeout(Math.min(110_000, time()))
        );
        auditUsages[index] = await toModelCallUsage(
          "validate",
          call,
          auditConfig
        );
        const data = parsed(call.content);
        if (call.finishReason && call.finishReason !== "stop") return invalid();
        return parseNativePdfAudit(data, batch);
      },
      false
    );
    calls.push(...auditUsages.filter(Boolean));
    const findings = [...repaired.findings, ...retained];
    let auditComplete = true;
    audits.forEach((audit, index) => {
      if (audit.status === "fulfilled") findings.push(...audit.value);
      else {
        auditComplete = false;
        findings.push({
          code: "audit-incomplete",
          severity: "warning",
          pageNumber: batches[index].pages[0],
          location: `Pages ${batches[index].pages.join(", ")}`,
          message:
            "The independent accessibility review did not finish for these pages. Their original appearance was preserved, but the accessibility review is incomplete.",
          suggestion:
            "Review these pages with a PDF accessibility editor and your accessibility support team, or try the document again before sharing.",
        });
      }
    });
    if (
      !repaired.machineChecks.veraPdf.completed &&
      !findings.some((f) => f.code === "validation-incomplete")
    )
      findings.push({
        code: "validation-incomplete",
        severity: "warning",
        message:
          "The PDF/UA machine checks did not finish, so the app could not verify all technical requirements.",
      });
    if (
      (!repaired.machineChecks.structurePassed ||
        repaired.machineChecks.veraPdf.failedChecks > 0) &&
      findings.length === 0
    )
      findings.push({
        code: "machine-checks-unresolved",
        severity: "warning",
        message:
          "Some PDF accessibility requirements remain unresolved. The PDF preserves the original pages, but needs further review.",
      });
    if (pdfSha256(repaired.pdf) !== repaired.candidateSha256)
      throw new NativePdfError("pdf_protocol_error");
    const errors = [
      ...new Map(
        findings.map((f) => [
          // Distinct validator rules can produce identical faculty guidance.
          // Their rule records stay in nativePdfChecks; show the guidance once.
          JSON.stringify([
            f.pageNumber ?? null,
            f.tagId ?? null,
            f.message,
            f.suggestion ?? null,
            f.location ?? null,
          ]),
          forUi(f),
        ])
      ).values(),
    ];
    const changes = [...prepared.changes, ...repaired.changes]
      .map((c) => `${c.pageNumber ? `Page ${c.pageNumber}: ` : ""}${c.message}`)
      .filter((c, i, all) => all.indexOf(c) === i);
    return {
      pdf: repaired.pdf,
      errors,
      changes,
      model: [...new Set(calls.map((c) => c.model))].join(", "),
      tokensUsed: calls.reduce(
        (n, c) => n + c.promptTokens + c.completionTokens,
        0
      ),
      calls,
      extractionWarnings: errors
        .filter((e) => e.severity === "warning")
        .map((e) => e.message),
      pageCount: repaired.pageCount,
      nativePdfChecks: {
        ...repaired.machineChecks,
        auditComplete,
        screenReaderTestPerformed: false,
      },
    };
  } catch (error) {
    const diagnostic = createJobDiagnostic({
      ...(error instanceof NativePdfError ||
      error instanceof PdfRenderingError ||
      error instanceof LiteLLMError
        ? error.diagnostic
        : { code: "native_pdf_worker_failed" }),
      stage,
    });
    return { error: describeJobDiagnostic(diagnostic), diagnostic, calls };
  }
}
