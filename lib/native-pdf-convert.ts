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
  /** This batch alone reviews page-wide concerns when a dense page is split. */
  pageReviewPages: number[];
  tags: NativePdfTag[];
  visualPages: number[];
  first: boolean;
}
export interface NativePdfHeadingReviewTarget {
  findingId: string;
  finding: NativePdfFinding;
  tagId: string;
  beforeRole: string;
  currentRole: string;
  eligibleForResolution: boolean;
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
function originalTagId(tag: NativePdfTag): string | undefined {
  return tag.sourceTagId === undefined
    ? tag.id
    : (tag.sourceTagId ?? undefined);
}
/** Every actual tag is assigned once; cross-page content receives companion pages. */
export function nativePdfBatches(state: NativePdfState): Batch[] {
  const groups: Batch[] = [];
  const byId = new Map(state.inventory.tags.map((tag) => [tag.id, tag]));
  const owners = new Map<string, number | undefined>();
  const active = new Set<string>();
  const owner = (tag: NativePdfTag, depth = 0): number | undefined => {
    if (owners.has(tag.id)) return owners.get(tag.id);
    if (depth > 128 || active.has(tag.id))
      throw new NativePdfError("pdf_complexity_limit");
    active.add(tag.id);
    const direct = pagesOf(tag);
    const descendants = direct.length
      ? []
      : (tag.children ?? [])
          .map((id) => {
            const child = byId.get(id);
            if (!child) throw new NativePdfError("pdf_protocol_error");
            return owner(child, depth + 1);
          })
          .filter((page): page is number => page !== undefined);
    const page =
      direct[0] ?? (descendants.length ? Math.min(...descendants) : undefined);
    active.delete(tag.id);
    owners.set(tag.id, page);
    return page;
  };
  const tagsByPage = new Map<number, NativePdfTag[]>();
  for (const tag of state.inventory.tags) {
    const page = owner(tag) ?? 1;
    const assigned = tagsByPage.get(page) ?? [];
    assigned.push(tag);
    tagsByPage.set(page, assigned);
  }
  const add = (
    pages: number[],
    assigned: NativePdfTag[],
    pageReviewPages = pages
  ) => {
    const visualPages = [
      ...new Set([...pages, ...assigned.flatMap(pagesOf)]),
    ].sort((a, b) => a - b);
    // Two PDF excerpts plus PNGs still fit the gateway image allowance.
    if (visualPages.length > 12 || JSON.stringify(assigned).length > 350_000)
      throw new NativePdfError("pdf_complexity_limit");
    groups.push({
      pages,
      pageReviewPages,
      tags: assigned,
      visualPages,
      first: groups.length === 0,
    });
  };
  let pendingPages: number[] = [];
  let pendingTags: NativePdfTag[] = [];
  const flush = () => {
    if (pendingPages.length) add(pendingPages, pendingTags);
    pendingPages = [];
    pendingTags = [];
  };
  for (let page = 1; page <= state.pageCount; page++) {
    const tags = tagsByPage.get(page) ?? [];
    if (tags.length > 200) {
      flush();
      for (let offset = 0; offset < tags.length; offset += 200)
        add(
          [page],
          tags.slice(offset, offset + 200),
          offset === 0 ? [page] : []
        );
      continue;
    }
    if (pendingPages.length === 4 || pendingTags.length + tags.length > 200)
      flush();
    pendingPages.push(page);
    pendingTags.push(...tags);
  }
  flush();
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
          batch.visualPages.includes(Number(f.pageNumber)) &&
          (f.tagId !== undefined ||
            batch.pageReviewPages.includes(Number(f.pageNumber))))
      )
    )
      return invalid();
    const tag =
      f.tagId === undefined
        ? undefined
        : batch.tags.find((t) => t.id === f.tagId);
    if (
      (f.tagId !== undefined && !tag) ||
      (f.code === "heading-structure" && !tag) ||
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
    if (
      op.type === "repair_structure" &&
      Object.keys(op).every((key) =>
        ["type", "tagId", "candidateId", "role"].includes(key)
      )
    ) {
      const candidate = state.inventory.structureCandidates?.find(
        (c) => c.tagId === tag.id && c.candidateId === op.candidateId
      );
      if (!candidate) return invalid();
      if (candidate.kind === "split_heading") {
        if (!["H2", "H3", "H4", "H5", "H6"].includes(String(op.role)))
          return invalid();
        return {
          ...common,
          type: "repair_structure",
          candidateId: candidate.candidateId,
          role: op.role as "H2" | "H3" | "H4" | "H5" | "H6",
        };
      }
      if (op.role !== undefined) return invalid();
      return {
        ...common,
        type: "repair_structure",
        candidateId: candidate.candidateId,
      };
    }
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
/** Atomic reference repair already assigns its verified related note this role. */
export function coalesceNativePdfOperations(
  operations: NativePdfOperation[],
  state: NativePdfState
): NativePdfOperation[] {
  const noteTargets = new Set(
    operations.flatMap((operation) => {
      if (operation.type !== "repair_structure") return [];
      const candidate = state.inventory.structureCandidates?.find(
        (candidate) =>
          candidate.candidateId === operation.candidateId &&
          candidate.tagId === operation.tagId &&
          candidate.kind === "mark_note_reference"
      );
      return candidate?.relatedTagIds ?? [];
    })
  );
  return operations.filter(
    (operation) =>
      !(
        operation.type === "set_role" &&
        operation.role === "Note" &&
        noteTargets.has(operation.tagId)
      )
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
          "repairFindingReviews",
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
        batch.pageReviewPages
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
/** Only an explicit current-state review can retire a targeted heading concern. */
export function parseNativePdfHeadingReviews(
  raw: unknown,
  targets: NativePdfHeadingReviewTarget[]
): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > targets.length) return invalid();
  const seen = new Set<string>();
  const resolved: string[] = [];
  for (const review of raw) {
    if (
      !objectRecord(review) ||
      Object.keys(review).some(
        (key) =>
          !["findingId", "decision", "explanation", "currentTag"].includes(key)
      ) ||
      typeof review.findingId !== "string" ||
      seen.has(review.findingId) ||
      !["still-present", "resolved", "uncertain"].includes(
        String(review.decision)
      ) ||
      !text(review.explanation, 1500) ||
      !objectRecord(review.currentTag) ||
      Object.keys(review.currentTag).some(
        (key) => !["tagId", "role"].includes(key)
      )
    )
      return invalid();
    const target = targets.find(
      (target) => target.findingId === review.findingId
    );
    if (
      !target ||
      review.currentTag.tagId !== target.tagId ||
      review.currentTag.role !== target.currentRole
    )
      return invalid();
    seen.add(review.findingId);
    if (review.decision === "resolved") {
      if (!target.eligibleForResolution) return invalid();
      resolved.push(target.findingId);
    }
  }
  return resolved;
}

function headingOutline(state: NativePdfState) {
  const stack: { tagId: string; level: number }[] = [];
  return state.inventory.tags
    .filter((tag) => /^H[1-6]?$/.test(tag.role))
    .map((tag) => {
      const level = Number(tag.role.slice(1)) || null;
      if (level === null) stack.length = 0;
      else
        while (stack.length && stack[stack.length - 1].level >= level)
          stack.pop();
      const row = {
        tagId: tag.id,
        role: tag.role,
        level,
        text: tag.text,
        pageNumber: tag.pageNumber,
        precedingLowerLevelHeadingId: stack.at(-1)?.tagId ?? null,
      };
      if (level !== null) stack.push({ tagId: tag.id, level });
      return row;
    });
}
function nearbyHeadingContext(state: NativePdfState, tagId: string) {
  const candidates = new Map(
    (state.inventory.structureCandidates ?? [])
      .filter((candidate) => candidate.kind === "split_heading")
      .map((candidate) => [candidate.tagId, candidate])
  );
  const tagIndex = state.inventory.tags.findIndex((tag) => tag.id === tagId);
  const events = state.inventory.tags.flatMap((tag, index) => {
    const candidate = candidates.get(tag.id);
    if (!/^H[1-6]?$/.test(tag.role) && !candidate) return [];
    // These bounded excerpts are context only. The complete candidate and its
    // original text remain in the assigned inventory for the actual decision.
    return [
      {
        index,
        tagId: tag.id,
        pageNumber: tag.pageNumber,
        currentRole: tag.role,
        kind: candidate ? "possible-run-in-heading" : "saved-heading",
        excerpt: (candidate?.preview ?? tag.text).slice(0, 800),
      },
    ];
  });
  return {
    preceding: events.filter((event) => event.index < tagIndex).slice(-4),
    following: events.filter((event) => event.index > tagIndex).slice(0, 4),
  };
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
  evidenceRole:
    | "current-saved-pdf"
    | "before-repair-comparison" = "current-saved-pdf",
  headingReviewTargets: NativePdfHeadingReviewTarget[] = []
): string {
  const structureCandidates = (state.inventory.structureCandidates ?? [])
    .filter((candidate) => batch.tags.some((tag) => tag.id === candidate.tagId))
    .map((candidate) => ({
      ...candidate,
      ...(candidate.kind === "split_heading"
        ? { headingContext: nearbyHeadingContext(state, candidate.tagId) }
        : {}),
    }));
  const relatedTagIds = new Set(
    structureCandidates.flatMap((candidate) => candidate.relatedTagIds)
  );
  const payload = {
    evidenceRole,
    assignedPages: batch.pages,
    pageReviewPages: batch.pageReviewPages,
    assignedTagIds: batch.tags.map((t) => t.id),
    companionPages: batch.visualPages,
    firstBatch: batch.first,
    candidateSha256: state.candidateSha256,
    language: state.inventory.language,
    title: state.inventory.title,
    tags: batch.tags,
    structureCandidates,
    relatedTagContext: state.inventory.tags.filter((tag) =>
      relatedTagIds.has(tag.id)
    ),
    headingOutline: headingOutline(state),
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
          repairFindingReviewTargets: headingReviewTargets,
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
    plan.operations = coalesceNativePdfOperations(plan.operations, prepared);
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
    const preparedById = new Map(
      prepared.inventory.tags.map((tag) => [tag.id, tag])
    );
    const retainedRecords = retained.map((finding, index) => {
      const mappedId =
        finding.tagId === undefined
          ? undefined
          : (repaired.inventory.sourceTagLineage?.[finding.tagId] ??
            repaired.inventory.tags.find(
              (tag) => originalTagId(tag) === finding.tagId
            )?.id);
      const located = { ...finding };
      delete located.tagId;
      return {
        findingId: `repair-finding-${index + 1}`,
        sourceFinding: finding,
        finding: { ...located, ...(mappedId ? { tagId: mappedId } : {}) },
      };
    });
    const mappedRetained = retainedRecords.map((record) => record.finding);
    const headingTargets = (batch: Batch): NativePdfHeadingReviewTarget[] =>
      retainedRecords.flatMap((record) => {
        const before = record.sourceFinding.tagId
          ? preparedById.get(record.sourceFinding.tagId)
          : undefined;
        const preserved = repaired.inventory.tags.find(
          (tag) => tag.id === record.finding.tagId
        );
        if (
          record.finding.code !== "heading-structure" ||
          !before ||
          !preserved
        )
          return [];
        const splitOperation = plan.operations.find(
          (op) =>
            op.tagId === before.id &&
            op.type === "repair_structure" &&
            prepared.inventory.structureCandidates?.some(
              (candidate) =>
                candidate.tagId === before.id &&
                candidate.candidateId === op.candidateId &&
                candidate.kind === "split_heading"
            )
        );
        // The verified helper inserts the new heading immediately before the
        // preserved paragraph, with both nodes retaining the same source lineage.
        const preceding =
          repaired.inventory.tags[
            repaired.inventory.tags.indexOf(preserved) - 1
          ];
        const splitHeading =
          splitOperation?.type === "repair_structure" &&
          preceding &&
          preceding.sourceTagId === before.id &&
          preserved.sourceTagId === before.id &&
          preceding.parentId === preserved.parentId &&
          preceding.role === splitOperation.role &&
          /^H[2-6]$/.test(preceding.role)
            ? preceding
            : undefined;
        const after = splitHeading ?? preserved;
        if (!batch.tags.some((tag) => tag.id === after.id)) return [];
        return [
          {
            findingId: record.findingId,
            finding: record.finding,
            tagId: after.id,
            beforeRole: before.role,
            currentRole: after.role,
            eligibleForResolution:
              !!splitHeading ||
              (before.role !== after.role &&
                (/^H[1-6]?$/.test(before.role) ||
                  /^H[1-6]?$/.test(after.role))),
          },
        ];
      });
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
        const reviewTargets = headingTargets(batch);
        const priorIds = new Set(batch.tags.map(originalTagId).filter(Boolean));
        const historicalBatch = {
          ...batch,
          tags: prepared.inventory.tags.filter((tag) => priorIds.has(tag.id)),
        };
        const call = await callLiteLLM(
          NATIVE_PDF_AUDIT_PROMPT,
          [
            {
              type: "text",
              text: `Untrusted exact saved output evidence:\n${scope(repaired, batch, mappedRetained, "current-saved-pdf", reviewTargets)}\nPrior inventory for comparison:\n${scope(prepared, historicalBatch, [], "before-repair-comparison")}\nRepairs: ${JSON.stringify(repaired.changes)}\nBoth excerpts map physical pages ${batch.visualPages.join(", ")} in that order.`,
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
        const findings = parseNativePdfAudit(data, batch);
        const resolvedFindingIds = parseNativePdfHeadingReviews(
          data.repairFindingReviews,
          reviewTargets
        );
        if (
          resolvedFindingIds.some((id) => {
            const target = reviewTargets.find(
              (target) => target.findingId === id
            )!;
            return findings.some(
              (finding) =>
                finding.code === "heading-structure" &&
                finding.tagId === target.tagId
            );
          })
        )
          return invalid();
        return { findings, resolvedFindingIds };
      },
      false
    );
    calls.push(...auditUsages.filter(Boolean));
    const resolvedFindingIds = new Set(
      audits.flatMap((audit) =>
        audit.status === "fulfilled" ? audit.value.resolvedFindingIds : []
      )
    );
    // Later role repairs can make discovery fit its limit, but cannot restore
    // candidates that were unavailable when the repair plan was proposed.
    const skippedCandidateDiscovery = prepared.findings.find(
      (finding) => finding.code === "structure_candidates_limited"
    );
    const findings = [
      ...repaired.findings,
      ...(skippedCandidateDiscovery &&
      !repaired.findings.some(
        (finding) => finding.code === "structure_candidates_limited"
      )
        ? [skippedCandidateDiscovery]
        : []),
      ...retainedRecords
        .filter((record) => !resolvedFindingIds.has(record.findingId))
        .map((record) => record.finding),
    ];
    let auditComplete = true;
    audits.forEach((audit, index) => {
      if (audit.status === "fulfilled") findings.push(...audit.value.findings);
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
