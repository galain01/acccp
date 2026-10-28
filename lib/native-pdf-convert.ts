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
import {
  getNativePdfInteractionTests,
  nativePdfInteractionSummary,
  reconcileNativePdfInteractionFindings,
  validFormInteractionReview,
  type MatchedNativePdfInteractionTests,
} from "./native-pdf-interaction-evidence";
import type { PdfInteractionTestSummary } from "./pdf-interaction-summary";

interface Batch {
  pages: number[];
  /** This batch alone reviews page-wide concerns when a dense page is split. */
  pageReviewPages: number[];
  tags: NativePdfTag[];
  visualPages: number[];
  first: boolean;
}
export interface NativePdfRepairReviewTarget {
  findingId: string;
  finding: NativePdfFinding;
  tagId: string;
  beforeRole: string;
  currentRole: string;
  eligibleForResolution: boolean;
  tableTagId?: string;
}
interface NativePdfArtifactReview {
  pageNumber: number;
  decision:
    | "decorative-or-redundant"
    | "meaningful-content-excluded"
    | "uncertain";
  explanation: string;
}
interface NativePdfArtifactReviewEvidence {
  candidateSha256: string;
  pages: (NativePdfArtifactReview & {
    inventoryComplete: boolean;
    pageAuditComplete: boolean;
    reminderRetired: boolean;
  })[];
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
  interactionTestSummary?: PdfInteractionTestSummary;
  nativePdfChecks: NativePdfState["machineChecks"] & {
    auditComplete: boolean;
    screenReaderTestPerformed: false;
    priorMatchingInteractionTests?: MatchedNativePdfInteractionTests;
    artifactTextReview?: NativePdfArtifactReviewEvidence;
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
export function nativePdfBatches(
  state: NativePdfState,
  validateScope: (batch: Batch) => unknown = (batch) => scope(state, batch)
): Batch[] {
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
  const candidateContextPages = new Map<string, Set<number>>();
  for (const candidate of state.inventory.structureCandidates ?? []) {
    const context =
      candidateContextPages.get(candidate.tagId) ?? new Set<number>();
    for (const relatedId of candidate.relatedTagIds) {
      const related = byId.get(relatedId);
      if (!related) throw new NativePdfError("pdf_protocol_error");
      for (const page of pagesOf(related)) context.add(page);
    }
    candidateContextPages.set(candidate.tagId, context);
  }
  const makeBatch = (
    pages: number[],
    assigned: NativePdfTag[],
    pageReviewPages = pages
  ): Batch => {
    const visualPages = [
      ...new Set([
        ...pages,
        ...assigned.flatMap(pagesOf),
        // Cross-page source relationships need the related page's appearance
        // even when its tags belong to a different batch. Ownership stays put.
        ...assigned.flatMap((tag) => [
          ...(candidateContextPages.get(tag.id) ?? []),
        ]),
      ]),
    ].sort((a, b) => a - b);
    return {
      pages,
      pageReviewPages,
      tags: assigned,
      visualPages,
      first: groups.length === 0,
    };
  };
  const fits = (batch: Batch): boolean => {
    // Two PDF excerpts plus PNGs still fit the gateway image allowance.
    if (
      batch.pages.length > 4 ||
      batch.tags.length > 200 ||
      batch.visualPages.length > 12 ||
      JSON.stringify(batch.tags).length > 350_000
    )
      return false;
    try {
      // Use the actual phase payload, including its prior evidence and findings.
      validateScope(batch);
      return true;
    } catch (error) {
      if (
        error instanceof NativePdfError &&
        error.diagnostic.code === "pdf_complexity_limit"
      )
        return false;
      throw error;
    }
  };
  let pendingPages: number[] = [];
  let pendingTags: NativePdfTag[] = [];
  const flush = () => {
    if (pendingPages.length) groups.push(makeBatch(pendingPages, pendingTags));
    pendingPages = [];
    pendingTags = [];
  };
  for (let page = 1; page <= state.pageCount; page++) {
    const tags = tagsByPage.get(page) ?? [];
    if (fits(makeBatch([...pendingPages, page], [...pendingTags, ...tags]))) {
      pendingPages.push(page);
      pendingTags.push(...tags);
      continue;
    }
    flush();
    if (fits(makeBatch([page], tags))) {
      pendingPages.push(page);
      pendingTags.push(...tags);
      continue;
    }
    let pageReviewAssigned = false;
    const splitPage = (assigned: NativePdfTag[]): void => {
      const batch = makeBatch(
        [page],
        assigned,
        pageReviewAssigned ? [] : [page]
      );
      if (fits(batch)) {
        groups.push(batch);
        pageReviewAssigned = true;
        return;
      }
      if (assigned.length <= 1)
        throw new NativePdfError("pdf_complexity_limit");
      const middle = Math.ceil(assigned.length / 2);
      splitPage(assigned.slice(0, middle));
      splitPage(assigned.slice(middle));
    };
    if (!tags.length) throw new NativePdfError("pdf_complexity_limit");
    for (let offset = 0; offset < tags.length; offset += 200)
      splitPage(tags.slice(offset, offset + 200));
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
  batch: Batch,
  state?: NativePdfState
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
            "interactionReview",
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
    if (f.code === "form-interaction-review") {
      if (
        f.severity !== "warning" ||
        f.tagId !== undefined ||
        !validFormInteractionReview(
          f.interactionReview,
          state,
          Number(f.pageNumber)
        )
      )
        return invalid();
    } else if (f.interactionReview !== undefined) return invalid();
    const tag =
      f.tagId === undefined
        ? undefined
        : batch.tags.find((t) => t.id === f.tagId);
    if (
      (f.tagId !== undefined && !tag) ||
      (["heading-structure", "table-header-relationships"].includes(f.code) &&
        !tag) ||
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
      ...(f.code === "form-interaction-review"
        ? {
            interactionReview:
              f.interactionReview as NativePdfFinding["interactionReview"],
          }
        : {}),
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
        [
          "type",
          "tagId",
          "candidateId",
          "role",
          "alt",
          "selections",
          "anchorRole",
        ].includes(key)
      )
    ) {
      const candidate = state.inventory.structureCandidates?.find(
        (c) => c.tagId === tag.id && c.candidateId === op.candidateId
      );
      if (!candidate) return invalid();
      if (candidate.kind === "restore_artifact_text") {
        if (
          op.role !== undefined ||
          op.alt !== undefined ||
          !Array.isArray(op.selections) ||
          !op.selections.length ||
          op.selections.length > 100
        )
          return invalid();
        if (
          op.anchorRole !== undefined &&
          (op.anchorRole !== "P" || !tag.editable.role)
        )
          return invalid();
        const seenScopes = new Set<string>();
        const selections = op.selections.map((selection) => {
          if (
            !objectRecord(selection) ||
            Object.keys(selection).some(
              (key) => !["scopeId", "role"].includes(key)
            ) ||
            typeof selection.scopeId !== "string" ||
            seenScopes.has(selection.scopeId) ||
            !candidate.textScopes?.some(
              (scope) => scope.scopeId === selection.scopeId
            ) ||
            !["P", "H2", "H3", "H4", "H5", "H6"].includes(
              String(selection.role)
            )
          )
            return invalid();
          seenScopes.add(selection.scopeId);
          return {
            scopeId: selection.scopeId,
            role: selection.role as "P" | "H2" | "H3" | "H4" | "H5" | "H6",
          };
        });
        return {
          ...common,
          type: "repair_structure",
          candidateId: candidate.candidateId,
          selections,
          ...(op.anchorRole === "P" ? { anchorRole: "P" as const } : {}),
        };
      }
      if (op.selections !== undefined || op.anchorRole !== undefined)
        return invalid();
      if (
        ["describe_chart", "restore_excluded_figure"].includes(candidate.kind)
      ) {
        if (op.role !== undefined || !text(op.alt, 8000)) return invalid();
        return {
          ...common,
          type: "repair_structure",
          candidateId: candidate.candidateId,
          alt: op.alt,
        };
      }
      if (op.alt !== undefined) return invalid();
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
    findings: parseNativePdfFindings(raw.findings, batch, state),
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
  // Whole-table, chart and callout repairs establish the roles of their
  // source-derived participants together. A different page/tag batch can
  // propose an ordinary role change without seeing that selected operation.
  const structureTargets = new Set(
    operations.flatMap((operation) => {
      if (operation.type !== "repair_structure") return [];
      const candidate = state.inventory.structureCandidates?.find(
        (candidate) =>
          candidate.candidateId === operation.candidateId &&
          candidate.tagId === operation.tagId &&
          [
            "rebuild_table",
            "rebuild_grid_table",
            "repair_table_headers",
            "restore_excluded_figure",
            "join_interrupted_text",
            "restore_decimal_paragraphs",
            "move_callout",
            "move_page_continuation",
            "describe_chart",
          ].includes(candidate.kind)
      );
      return candidate
        ? [candidate.tagId, ...candidate.relatedTagIds].filter(
            (id) => !candidate.readonlyTagIds?.includes(id)
          )
        : [];
    })
  );
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
        (structureTargets.has(operation.tagId) ||
          (operation.role === "Note" && noteTargets.has(operation.tagId)))
      )
  );
}
function parseNativePdfAuditEvidence(
  raw: Record<string, unknown>,
  batch: Batch,
  state?: NativePdfState
): {
  findings: NativePdfFinding[];
  artifactReviews: NativePdfArtifactReview[];
} {
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
  const findings = parseNativePdfFindings(raw.findings, batch, state);
  const artifactReviews: NativePdfArtifactReview[] = [];
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
      if (key === "artifactReviews")
        artifactReviews.push({
          pageNumber: Number(review.pageNumber),
          decision: review.decision as NativePdfArtifactReview["decision"],
          explanation: String(review.explanation),
        });
    }
  }
  return { findings, artifactReviews };
}
export function parseNativePdfAudit(
  raw: Record<string, unknown>,
  batch: Batch,
  state?: NativePdfState
): NativePdfFinding[] {
  return parseNativePdfAuditEvidence(raw, batch, state).findings;
}

/** Resolve only the worker's request for semantic review of excluded text. */
function reconcileNativePdfArtifactReminders(
  workerFindings: NativePdfFinding[],
  modelFindings: NativePdfFinding[],
  state: NativePdfState,
  batches: Batch[],
  audits: PromiseSettledResult<{ artifactReviews: NativePdfArtifactReview[] }>[]
): { findings: NativePdfFinding[]; evidence: NativePdfArtifactReviewEvidence } {
  const byId = new Map(state.inventory.tags.map((tag) => [tag.id, tag]));
  const pagesForTag = (tagId: string): Set<number> => {
    const pages = new Set<number>();
    const pending = [tagId];
    const seen = new Set<string>();
    while (pending.length) {
      const id = pending.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      const tag = byId.get(id);
      if (!tag) continue;
      pagesOf(tag).forEach((page) => pages.add(page));
      pending.push(...tag.children);
    }
    return pages;
  };
  const missingContent = [...workerFindings, ...modelFindings].filter(
    (finding) => finding.code === "missing-content"
  );
  const conflicts = (page: number, reminder: NativePdfFinding): boolean =>
    missingContent.some((finding) => {
      if (finding.pageNumber === page) return true;
      if (finding.tagId && finding.tagId === reminder.tagId) return true;
      const tagPages = finding.tagId ? pagesForTag(finding.tagId) : undefined;
      if (tagPages?.has(page)) return true;
      // An unlocated or unmapped content-loss concern cannot be cleared by a
      // positive review of one page. Located concerns on other pages remain.
      return finding.pageNumber === undefined && !tagPages?.size;
    });
  const evidence: NativePdfArtifactReviewEvidence = {
    candidateSha256: state.candidateSha256,
    pages: audits.flatMap((audit, index) => {
      if (audit.status !== "fulfilled") return [];
      return audit.value.artifactReviews.map((review) => {
        const matching = state.inventory.page_content.filter(
          (page) => page.pageNumber === review.pageNumber
        );
        return {
          ...review,
          inventoryComplete:
            state.inventory.page_content.length === state.pageCount &&
            matching.length === 1 &&
            state.inventory.page_content[review.pageNumber - 1] ===
              matching[0] &&
            matching[0].artifactTextComplete === true &&
            typeof matching[0].artifactText === "string",
          pageAuditComplete:
            batches[index].pageReviewPages.includes(review.pageNumber) &&
            batches.filter((batch) =>
              batch.pageReviewPages.includes(review.pageNumber)
            ).length === 1 &&
            batches.every(
              (batch, batchIndex) =>
                !batch.visualPages.includes(review.pageNumber) ||
                audits[batchIndex]?.status === "fulfilled"
            ),
          reminderRetired: false,
        };
      });
    }),
  };
  const findings = workerFindings.filter((finding) => {
    if (
      finding.code !== "artifact_text_needs_semantic_review" ||
      finding.severity !== "warning" ||
      !Number.isInteger(finding.pageNumber) ||
      finding.pageNumber! < 1 ||
      finding.pageNumber! > state.pageCount
    )
      return true;
    const matches = evidence.pages.filter(
      (page) => page.pageNumber === finding.pageNumber
    );
    const review = matches.length === 1 ? matches[0] : undefined;
    if (
      !review ||
      review.decision !== "decorative-or-redundant" ||
      !review.inventoryComplete ||
      !review.pageAuditComplete ||
      conflicts(review.pageNumber, finding)
    )
      return true;
    review.reminderRetired = true;
    return false;
  });
  return { findings, evidence };
}
/** Only an explicit current-state review can retire a verified targeted repair. */
export function parseNativePdfRepairFindingReviews(
  raw: unknown,
  targets: NativePdfRepairReviewTarget[]
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
      text: `Original physical PDF page ${p.pageNumber}. The machine-check evidence describes how page appearance was verified.`,
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
/** Native ownership is verified by the worker; avoid repeating its raw indexes.
 * Full assigned tags retain their exact MCIDs and ordered content. Keep every
 * other page check, excluded passage and incompleteness signal unchanged.
 */
function scopedPageChecks(
  page: Record<string, unknown> | undefined,
  tags: NativePdfTag[]
): Record<string, unknown> | undefined {
  if (!page) return page;
  const {
    mcids,
    ownership_required_mcids: required,
    occurrence_ids_by_mcid: occurrences,
    ...checks
  } = page;
  if (
    !Array.isArray(mcids) ||
    !Array.isArray(required) ||
    !objectRecord(occurrences) ||
    !Object.values(occurrences).every(Array.isArray)
  )
    return page;
  const assigned = new Set(
    tags.flatMap((tag) =>
      tag.content.flatMap((content) =>
        content.pageNumber === page.pageNumber &&
        content.streamId === undefined &&
        typeof content.mcid === "number"
          ? [content.mcid]
          : []
      )
    )
  );
  return {
    ...checks,
    nativeContent: {
      markedScopeCount: mcids.length,
      ownershipRequiredScopeCount: required.length,
      textOccurrenceCount: Object.values(occurrences).reduce<number>(
        (count, ids) => count + (ids as unknown[]).length,
        0
      ),
      assignedMarkedScopes: mcids.filter((mcid) => assigned.has(mcid)),
      assignedOwnershipRequiredScopes: required.filter((mcid) =>
        assigned.has(mcid)
      ),
      assignedTextOccurrenceCounts: Object.fromEntries(
        Object.entries(occurrences)
          .filter(([mcid]) => assigned.has(Number(mcid)))
          .map(([mcid, ids]) => [mcid, (ids as unknown[]).length])
      ),
    },
  };
}
function modelTag(tag: NativePdfTag): Record<string, unknown> {
  const evidence: Record<string, unknown> = { ...tag };
  // Writer preconditions stay in immutable state and are attached only after
  // the model's operation has passed validation. They repeat current facts.
  delete evidence.snapshot;
  const marked = Array.isArray(tag.contentSequence)
    ? tag.contentSequence.filter(
        (entry): entry is Record<string, unknown> =>
          objectRecord(entry) && entry.kind === "markedContent"
      )
    : undefined;
  if (
    marked &&
    marked.length === tag.content.length &&
    tag.content.every((content, index) =>
      Object.entries(content).every(
        ([key, value]) => marked[index][key] === value
      )
    )
  )
    delete evidence.content;
  return evidence;
}
/** Follow verified header links to their actual text, including across tag batches. */
function tableHeaderContext(
  state: NativePdfState,
  assigned: NativePdfTag[]
): Set<string> {
  const tags = new Map(state.inventory.tags.map((tag) => [tag.id, tag]));
  const related = new Set<string>(),
    visited = new Set<string>();
  const seeds = new Set(assigned);
  for (const tag of assigned) {
    const ancestors = new Set<string>();
    let parent = tag.parentId ? tags.get(tag.parentId) : undefined;
    while (parent && ancestors.size < 64 && !ancestors.has(parent.id)) {
      ancestors.add(parent.id);
      if (["TD", "TH"].includes(parent.role)) {
        seeds.add(parent);
        related.add(parent.id);
        break;
      }
      if (parent.role === "Table") break;
      parent = parent.parentId ? tags.get(parent.parentId) : undefined;
    }
  }
  const pending: NativePdfTag[] = [];
  const links = (tag: NativePdfTag) => {
    for (const attribute of Array.isArray(tag.attributes)
      ? tag.attributes
      : []) {
      if (
        !objectRecord(attribute) ||
        attribute.owner !== "Table" ||
        !attribute.headersEffective ||
        !attribute.headersResolved ||
        !attribute.headersAcyclic ||
        !Array.isArray(attribute.headerTagIds)
      )
        continue;
      for (const id of attribute.headerTagIds) {
        const header = tags.get(String(id));
        if (header) pending.push(header);
      }
    }
  };
  seeds.forEach(links);
  while (pending.length) {
    const tag = pending.pop()!;
    if (visited.has(tag.id)) continue;
    visited.add(tag.id);
    related.add(tag.id);
    links(tag);
    for (const id of tag.children) {
      const child = tags.get(id);
      if (child) pending.push(child);
    }
  }
  return related;
}
function scope(
  state: NativePdfState,
  batch: Batch,
  outstandingRepairFindings: NativePdfFinding[] = [],
  evidenceRole:
    | "current-saved-pdf"
    | "before-repair-comparison" = "current-saved-pdf",
  repairReviewTargets: NativePdfRepairReviewTarget[] = [],
  interactionTests?: MatchedNativePdfInteractionTests
): string {
  const structureCandidates = (state.inventory.structureCandidates ?? [])
    .filter((candidate) => batch.tags.some((tag) => tag.id === candidate.tagId))
    .map((candidate) => ({
      ...candidate,
      ...(candidate.kind === "split_heading"
        ? { headingContext: nearbyHeadingContext(state, candidate.tagId) }
        : {}),
    }));
  const relatedTagIds = new Set([
    ...structureCandidates.flatMap((candidate) => candidate.relatedTagIds),
    ...tableHeaderContext(state, batch.tags),
  ]);
  const assignedTagIds = new Set(batch.tags.map((tag) => tag.id));
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
    tags: batch.tags.map(modelTag),
    structureCandidates,
    relatedTagContext: state.inventory.tags
      .filter((tag) => relatedTagIds.has(tag.id) && !assignedTagIds.has(tag.id))
      .map(modelTag),
    headingOutline: headingOutline(state),
    // Every hierarchy link remains available; only assigned tags may change.
    hierarchyColumns: ["id", "parentId", "role", "pageNumber", "headingText"],
    hierarchy: state.inventory.tags.map((t) => [
      t.id,
      t.parentId,
      t.role,
      t.pageNumber,
      /^H[1-6]?$/.test(t.role) ? t.text : null,
    ]),
    excludedTextAndPageChecks: batch.pages.map((n) =>
      scopedPageChecks(state.inventory.page_content[n - 1], batch.tags)
    ),
    nestedFormContent: state.inventory.form_content,
    forms: state.inventory.forms,
    priorMatchingInteractionTests: interactionTests ?? null,
    // Earlier failures may already be repaired. Only checks reopened from the
    // delivered output are evidence of its remaining machine defects.
    ...(evidenceRole === "current-saved-pdf"
      ? {
          machineChecks: state.machineChecks,
          findings: reconcileNativePdfInteractionFindings(
            state.findings,
            [],
            state,
            interactionTests
          ).filter(
            (f) => !f.pageNumber || batch.visualPages.includes(f.pageNumber)
          ),
          outstandingRepairFindings: outstandingRepairFindings.filter(
            (f) => !f.pageNumber || batch.visualPages.includes(f.pageNumber)
          ),
          repairFindingReviewTargets: repairReviewTargets,
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
    const sourceSha256 = pdfSha256(source);
    const preparedInteractionTests = getNativePdfInteractionTests(
      prepared,
      sourceSha256
    );
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
    const repairEvidence = (batch: Batch): string =>
      `Untrusted saved PDF inventory:\n${scope(prepared, batch, [], "current-saved-pdf", [], preparedInteractionTests)}\nThe attached excerpt maps pages in this order: ${batch.visualPages.join(", ")}.`;
    const sourceBatches = nativePdfBatches(prepared, repairEvidence);
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
              text: repairEvidence(batch),
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
    const repairedInteractionTests = getNativePdfInteractionTests(
      repaired,
      sourceSha256
    );
    stage = "native_pdf_audit";
    const actualDoc = await PDFDocument.load(repaired.pdf, {
      updateMetadata: false,
    });
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
    const repairFindingTargets = (
      batch: Batch
    ): NativePdfRepairReviewTarget[] =>
      retainedRecords.flatMap((record) => {
        const before = record.sourceFinding.tagId
          ? preparedById.get(record.sourceFinding.tagId)
          : undefined;
        const preserved = repaired.inventory.tags.find(
          (tag) => tag.id === record.finding.tagId
        );
        if (!before || !preserved) return [];
        if (record.finding.code === "table-header-relationships") {
          if (!batch.tags.some((tag) => tag.id === preserved.id)) return [];
          const candidate = prepared.inventory.structureCandidates?.find(
            (candidate) =>
              candidate.kind === "repair_table_headers" &&
              [candidate.tagId, ...candidate.relatedTagIds].includes(before.id)
          );
          const table = candidate
            ? repaired.inventory.tags.find(
                (tag) =>
                  tag.role === "Table" &&
                  (tag.id ===
                    repaired.inventory.sourceTagLineage?.[candidate.tagId] ||
                    originalTagId(tag) === candidate.tagId)
              )
            : undefined;
          const selected =
            !!candidate &&
            plan.operations.some(
              (op) =>
                op.type === "repair_structure" &&
                op.tagId === candidate.tagId &&
                op.candidateId === candidate.candidateId
            );
          const seen = new Set<string>();
          let ancestor: NativePdfTag | undefined = preserved;
          while (
            ancestor &&
            ancestor !== table &&
            !seen.has(ancestor.id) &&
            seen.size < 64
          ) {
            seen.add(ancestor.id);
            ancestor = repaired.inventory.tags.find(
              (tag) => tag.id === ancestor?.parentId
            );
          }
          return [
            {
              findingId: record.findingId,
              finding: record.finding,
              tagId: preserved.id,
              beforeRole: before.role,
              currentRole: preserved.role,
              ...(table ? { tableTagId: table.id } : {}),
              eligibleForResolution:
                selected &&
                !!table &&
                ancestor === table &&
                repaired.changes.some(
                  (change) =>
                    change.code === "repair_table_headers" &&
                    change.tagId === table.id
                ),
            },
          ];
        }
        if (record.finding.code !== "heading-structure") return [];
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
    const auditEvidence = (batch: Batch) => {
      const reviewTargets = repairFindingTargets(batch);
      const priorIds = new Set(batch.tags.map(originalTagId).filter(Boolean));
      const historicalBatch = {
        ...batch,
        tags: prepared.inventory.tags.filter((tag) => priorIds.has(tag.id)),
      };
      return {
        reviewTargets,
        text: `Untrusted exact saved output evidence:\n${scope(repaired, batch, mappedRetained, "current-saved-pdf", reviewTargets, repairedInteractionTests)}\nPrior inventory for comparison:\n${scope(prepared, historicalBatch, [], "before-repair-comparison", [], preparedInteractionTests)}\nRepairs: ${JSON.stringify(repaired.changes)}\nBoth excerpts map physical pages ${batch.visualPages.join(", ")} in that order.`,
      };
    };
    const batches = nativePdfBatches(repaired, auditEvidence);
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
        const { reviewTargets, text: evidenceText } = auditEvidence(batch);
        const call = await callLiteLLM(
          NATIVE_PDF_AUDIT_PROMPT,
          [
            {
              type: "text",
              text: evidenceText,
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
        const { findings, artifactReviews } = parseNativePdfAuditEvidence(
          data,
          batch,
          repaired
        );
        const resolvedFindingIds = parseNativePdfRepairFindingReviews(
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
                finding.code === target.finding.code &&
                finding.tagId === target.tagId
            );
          })
        )
          return invalid();
        return { findings, resolvedFindingIds, artifactReviews };
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
    const modelFindings: NativePdfFinding[] = [];
    const workerFindings = [
      ...repaired.findings,
      ...(skippedCandidateDiscovery &&
      !repaired.findings.some(
        (finding) => finding.code === "structure_candidates_limited"
      )
        ? [skippedCandidateDiscovery]
        : []),
    ];
    modelFindings.push(
      ...retainedRecords
        .filter((record) => !resolvedFindingIds.has(record.findingId))
        .map((record) => record.finding)
    );
    let auditComplete = true;
    audits.forEach((audit, index) => {
      if (audit.status === "fulfilled")
        modelFindings.push(...audit.value.findings);
      else {
        auditComplete = false;
        modelFindings.push({
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
    const artifactReview = reconcileNativePdfArtifactReminders(
      workerFindings,
      modelFindings,
      repaired,
      batches,
      audits
    );
    const findings = reconcileNativePdfInteractionFindings(
      artifactReview.findings,
      modelFindings,
      repaired,
      repairedInteractionTests
    );
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
      ...(repairedInteractionTests
        ? {
            interactionTestSummary: nativePdfInteractionSummary(
              repairedInteractionTests
            ),
          }
        : {}),
      nativePdfChecks: {
        ...repaired.machineChecks,
        auditComplete,
        screenReaderTestPerformed: false,
        artifactTextReview: artifactReview.evidence,
        ...(repairedInteractionTests
          ? { priorMatchingInteractionTests: repairedInteractionTests }
          : {}),
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
