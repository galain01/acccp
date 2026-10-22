import "server-only";
import { createHash } from "node:crypto";
import { isPdfBuffer, MAX_FILE_SIZE_BYTES } from "./document-input";
import { createJobDiagnostic, type DiagnosticCode } from "./job-diagnostics";
import type { FormInteractionReview } from "./native-pdf-interaction-evidence";

export interface NativePdfTag {
  id: string;
  sourceTagId?: string | null;
  parentId: string | null;
  children: string[];
  role: string;
  pageNumber: number | null;
  text: string;
  alt?: string;
  content: { pageNumber?: number | null; [key: string]: unknown }[];
  editable: { role: boolean; alt: boolean; tableHeader: boolean };
  snapshot: {
    role: string;
    pageNumber: number | null;
    text: string;
    mcids: number[];
    alt: string | null;
  };
  [key: string]: unknown;
}
export interface NativePdfStructureCandidate {
  candidateId: string;
  kind:
    | "split_heading"
    | "join_list_continuation"
    | "mark_note_reference"
    | "convert_list";
  tagId: string;
  pageNumber: number;
  text: string;
  preview: string;
  relatedTagIds: string[];
}
export interface NativePdfFinding {
  code: string;
  severity: "warning" | "error";
  message: string;
  suggestion?: string;
  pageNumber?: number;
  tagId?: string;
  location?: string;
  interactionReview?: FormInteractionReview;
}
export interface NativePdfState {
  schemaVersion: 1;
  sourceSha256: string;
  candidateSha256: string;
  pdf: Buffer;
  pageCount: number;
  inventory: {
    tags: NativePdfTag[];
    language?: string;
    title?: string;
    page_content: Record<string, unknown>[];
    forms: unknown;
    structureCandidates?: NativePdfStructureCandidate[];
    sourceTagLineage?: Record<string, string>;
    [key: string]: unknown;
  };
  findings: NativePdfFinding[];
  changes: {
    code: string;
    message: string;
    pageNumber?: number;
    tagId?: string;
  }[];
  machineChecks: {
    preservationPassed: true;
    pixelsIdentical: true;
    inspectionComplete: true;
    structurePassed: boolean;
    targetStandard: string;
    veraPdf: {
      completed: boolean;
      compliant: boolean;
      failedRules: number;
      failedChecks: number;
    };
    conformanceClaim: false;
  };
}
export type NativePdfOperation = {
  tagId: string;
  expected: NativePdfTag["snapshot"];
} & (
  | { type: "set_role"; role: string }
  | { type: "set_alt"; alt: string }
  | { type: "set_table_header"; scope: "Column" | "Row" }
  | {
      type: "repair_structure";
      candidateId: string;
      role?: "H2" | "H3" | "H4" | "H5" | "H6";
    }
);
export interface NativePdfPlan {
  schemaVersion: 1;
  candidateSha256: string;
  language?: string;
  title?: string;
  operations: NativePdfOperation[];
}
export interface NativePdfStoredRequest {
  requestUrl: string;
  requestSha256: string;
  requestBytes: number;
}
/** Production provides owned, retained storage; standalone local tools can send inline. */
export type NativePdfTransport = <T>(
  payload: Buffer,
  signal: AbortSignal,
  action: (descriptor: NativePdfStoredRequest) => Promise<T>
) => Promise<T>;
export class NativePdfError extends Error {
  readonly diagnostic;
  constructor(
    code: DiagnosticCode = "native_pdf_worker_failed",
    httpStatus?: number
  ) {
    super(code);
    this.name = "NativePdfError";
    this.diagnostic = createJobDiagnostic({
      stage: "native_pdf_prepare",
      code,
      httpStatus,
    });
  }
}
export const pdfSha256 = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
export const objectRecord = (
  value: unknown
): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const boundedText = (value: unknown, max: number) =>
  typeof value === "string" && value.length <= max;
const pageNumber = (value: unknown, pages: number) =>
  Number.isInteger(value) && Number(value) >= 1 && Number(value) <= pages;
const fail = (): never => {
  throw new NativePdfError("pdf_protocol_error");
};
const operatorCount = (value: unknown): boolean =>
  Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 200_000;
const orderedMcids = (value: unknown): boolean =>
  Array.isArray(value) &&
  value.length <= 200_000 &&
  value.every(
    (id, index) =>
      Number.isSafeInteger(id) &&
      id >= 0 &&
      (index === 0 || id > value[index - 1])
  );

/** Array positions are used to select physical-page evidence for each audit. */
function completePageEvidence(
  inventory: Record<string, unknown>,
  pages: number
): boolean {
  if (
    !Array.isArray(inventory.page_content) ||
    inventory.page_content.length !== pages ||
    inventory.page_content.some(
      (page, index) =>
        !objectRecord(page) ||
        page.pageNumber !== index + 1 ||
        !boundedText(page.artifactText, 16_000) ||
        page.artifactTextComplete !== true ||
        !orderedMcids(page.mcids) ||
        !operatorCount(page.text_show_operators) ||
        !operatorCount(page.untagged_text_operators) ||
        !operatorCount(page.artifact_text_operators) ||
        (page.form_artifact_text_operators !== undefined &&
          !operatorCount(page.form_artifact_text_operators))
    )
  )
    return false;
  if (
    !Array.isArray(inventory.form_content) ||
    inventory.form_content.length > 10_000
  )
    return false;
  const streamIds = new Set<string>();
  for (const form of inventory.form_content) {
    if (
      !objectRecord(form) ||
      typeof form.streamId !== "string" ||
      !/^form-[1-9]\d{0,5}$/.test(form.streamId) ||
      streamIds.has(form.streamId) ||
      !pageNumber(form.pageNumber, pages) ||
      !orderedMcids(form.mcids) ||
      form.checksComplete !== true ||
      !Array.isArray(form.gaps) ||
      form.gaps.length > 0
    )
      return false;
    streamIds.add(form.streamId);
  }
  return true;
}

/** Validate identity and complete inventory before source data reaches the model. */
export function parseNativePdfState(
  raw: unknown,
  source: Buffer
): NativePdfState {
  if (
    !objectRecord(raw) ||
    raw.schemaVersion !== 1 ||
    raw.sourceSha256 !== pdfSha256(source) ||
    !boundedText(raw.pdfBase64, Math.ceil(MAX_FILE_SIZE_BYTES / 3) * 4) ||
    typeof raw.candidateSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(raw.candidateSha256) ||
    !pageNumber(raw.pageCount, 60)
  )
    return fail();
  const encoded = raw.pdfBase64 as string;
  const pdf = Buffer.from(encoded, "base64");
  if (
    !pdf.length ||
    pdf.length > MAX_FILE_SIZE_BYTES ||
    pdf.toString("base64") !== encoded ||
    !isPdfBuffer(pdf) ||
    pdfSha256(pdf) !== raw.candidateSha256
  )
    return fail();
  const pages = raw.pageCount as number;
  const inv = raw.inventory;
  const checks = raw.machineChecks;
  if (
    !objectRecord(inv) ||
    !Array.isArray(inv.tags) ||
    inv.tags.length > 5000 ||
    !completePageEvidence(inv, pages) ||
    !boundedText(inv.title ?? "", 10_000) ||
    !boundedText(inv.language ?? "", 100) ||
    !objectRecord(checks) ||
    checks.preservationPassed !== true ||
    checks.pixelsIdentical !== true ||
    checks.inspectionComplete !== true ||
    typeof checks.structurePassed !== "boolean" ||
    checks.conformanceClaim !== false ||
    !boundedText(checks.targetStandard, 100) ||
    !objectRecord(checks.veraPdf)
  )
    return fail();
  const vera = checks.veraPdf;
  if (
    objectRecord(inv.forms) &&
    inv.forms.interactionFingerprint !== undefined
  ) {
    const fingerprint = inv.forms.interactionFingerprint;
    if (
      !objectRecord(fingerprint) ||
      Object.keys(fingerprint).some(
        (key) => !["schemaVersion", "sha256"].includes(key)
      ) ||
      fingerprint.schemaVersion !== 1 ||
      typeof fingerprint.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(fingerprint.sha256)
    )
      return fail();
  }
  if (
    typeof vera.completed !== "boolean" ||
    typeof vera.compliant !== "boolean" ||
    [vera.failedRules, vera.failedChecks].some(
      (n) => !Number.isInteger(n) || Number(n) < 0 || Number(n) > 1_000_000
    )
  )
    return fail();
  const ids = new Set<string>();
  let chars = 0;
  for (const tag of inv.tags) {
    if (
      !objectRecord(tag) ||
      typeof tag.id !== "string" ||
      !/^tag-[1-9]\d{0,5}$/.test(tag.id) ||
      ids.has(tag.id) ||
      (tag.sourceTagId !== undefined &&
        tag.sourceTagId !== null &&
        (typeof tag.sourceTagId !== "string" ||
          !/^tag-[1-9]\d{0,5}$/.test(tag.sourceTagId))) ||
      !(tag.parentId === null || typeof tag.parentId === "string") ||
      !Array.isArray(tag.children) ||
      tag.children.some((id) => typeof id !== "string") ||
      !boundedText(tag.role, 100) ||
      !(tag.pageNumber === null || pageNumber(tag.pageNumber, pages)) ||
      !boundedText(tag.text, 500_000) ||
      !boundedText(tag.alt ?? "", 8000) ||
      !Array.isArray(tag.content) ||
      tag.content.some(
        (c) =>
          !objectRecord(c) ||
          !(c.pageNumber == null || pageNumber(c.pageNumber, pages))
      ) ||
      !objectRecord(tag.editable) ||
      ["role", "alt", "tableHeader"].some(
        (k) => typeof (tag.editable as Record<string, unknown>)[k] !== "boolean"
      ) ||
      !objectRecord(tag.snapshot) ||
      tag.snapshot.role !== tag.role ||
      tag.snapshot.text !== tag.text ||
      tag.snapshot.pageNumber !== tag.pageNumber ||
      tag.snapshot.alt !== (tag.alt ?? null) ||
      !Array.isArray(tag.snapshot.mcids) ||
      tag.snapshot.mcids.some((n) => !Number.isInteger(n) || Number(n) < 0)
    )
      return fail();
    chars += (tag.text as string).length;
    if (chars > 500_000) return fail();
    ids.add(tag.id);
  }
  const tags = inv.tags as unknown as NativePdfTag[];
  if (inv.structureCandidates !== undefined) {
    const candidates = inv.structureCandidates;
    const candidateIds = new Set<string>();
    if (!Array.isArray(candidates) || candidates.length > 500) return fail();
    for (const candidate of candidates) {
      if (
        !objectRecord(candidate) ||
        typeof candidate.candidateId !== "string" ||
        !/^[a-f0-9]{64}$/.test(candidate.candidateId) ||
        candidateIds.has(candidate.candidateId) ||
        ![
          "split_heading",
          "join_list_continuation",
          "mark_note_reference",
          "convert_list",
        ].includes(String(candidate.kind)) ||
        !ids.has(String(candidate.tagId)) ||
        !pageNumber(candidate.pageNumber, pages) ||
        !boundedText(candidate.text, 20_000) ||
        !boundedText(candidate.preview, 20_000) ||
        !Array.isArray(candidate.relatedTagIds) ||
        candidate.relatedTagIds.length > 20 ||
        candidate.relatedTagIds.some((id) => !ids.has(String(id))) ||
        new Set(candidate.relatedTagIds).size !== candidate.relatedTagIds.length
      )
        return fail();
      candidateIds.add(candidate.candidateId);
    }
  }
  if (
    inv.sourceTagLineage !== undefined &&
    (!objectRecord(inv.sourceTagLineage) ||
      Object.keys(inv.sourceTagLineage).length > 5000 ||
      Object.entries(inv.sourceTagLineage).some(
        ([sourceId, currentId]) =>
          !/^tag-[1-9]\d{0,5}$/.test(sourceId) ||
          typeof currentId !== "string" ||
          !ids.has(currentId)
      ))
  )
    return fail();
  const byId = new Map(tags.map((t) => [t.id, t]));
  for (const tag of tags) {
    if (
      (tag.parentId !== null &&
        (!ids.has(tag.parentId) ||
          tag.parentId === tag.id ||
          !byId.get(tag.parentId)?.children.includes(tag.id))) ||
      new Set(tag.children).size !== tag.children.length ||
      tag.children.some((id) => byId.get(id)?.parentId !== tag.id)
    )
      return fail();
    const visited = new Set([tag.id]);
    let parent = tag.parentId;
    while (parent) {
      if (visited.has(parent) || visited.size > 100) return fail();
      visited.add(parent);
      parent = byId.get(parent)?.parentId ?? null;
    }
  }
  for (const name of ["findings", "changes"] as const) {
    const list = raw[name];
    if (
      !Array.isArray(list) ||
      list.length > 1000 ||
      list.some(
        (f) =>
          !objectRecord(f) ||
          !boundedText(f.code, 100) ||
          !boundedText(f.message, 4000) ||
          (f.pageNumber !== undefined && !pageNumber(f.pageNumber, pages)) ||
          (f.tagId !== undefined && !ids.has(String(f.tagId))) ||
          (f.suggestion !== undefined && !boundedText(f.suggestion, 4000)) ||
          (f.location !== undefined && !boundedText(f.location, 500)) ||
          (name === "findings" &&
            !["error", "warning"].includes(String(f.severity)))
      )
    )
      return fail();
  }
  return {
    schemaVersion: 1,
    sourceSha256: raw.sourceSha256 as string,
    candidateSha256: raw.candidateSha256,
    pdf,
    pageCount: pages,
    inventory: inv as unknown as NativePdfState["inventory"],
    findings: raw.findings as NativePdfFinding[],
    changes: raw.changes as NativePdfState["changes"],
    machineChecks: checks as unknown as NativePdfState["machineChecks"],
  };
}

function configuration(path: string): { url: URL; key: string } {
  let url: URL;
  try {
    url = new URL(process.env.NATIVE_PDF_URL ?? "");
  } catch {
    throw new NativePdfError("native_pdf_configuration");
  }
  const key = process.env.NATIVE_PDF_API_KEY ?? "";
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    key.length < 32 ||
    key.length > 256 ||
    /[^\x21-\x7e]/.test(key) ||
    (local && !!process.env.VERCEL) ||
    (url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        local &&
        process.env.NODE_ENV !== "production"
      ))
  )
    throw new NativePdfError("native_pdf_configuration");
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/${path}`;
  return { url, key };
}
async function boundedResponse(
  response: Response,
  signal: AbortSignal,
  maxBytes: number
): Promise<unknown> {
  if (!response.body) return fail();
  const reader = response.body.getReader();
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      if (signal.aborted) throw new NativePdfError("native_pdf_timeout");
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        cancel();
        return fail();
      }
      chunks.push(value);
    }
    if (signal.aborted) throw new NativePdfError("native_pdf_timeout");
    return JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}
const WORKER_CODES: DiagnosticCode[] = [
  "native_pdf_unsupported",
  "native_pdf_preservation",
  "native_pdf_invalid_plan",
  "native_pdf_worker_failed",
  "native_pdf_timeout",
  "native_pdf_busy",
  "pdf_invalid",
  "pdf_password",
  "pdf_page_limit",
  "pdf_complexity_limit",
  "pdf_output_limit",
];
export async function nativePdfRequest(
  path: "prepare" | "repair",
  source: Buffer,
  timeoutMs: number,
  candidate?: NativePdfState,
  plan?: NativePdfPlan,
  transport?: NativePdfTransport
): Promise<NativePdfState> {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1)
    throw new NativePdfError("native_pdf_timeout");
  if (
    !source.length ||
    source.length > MAX_FILE_SIZE_BYTES ||
    !isPdfBuffer(source)
  )
    throw new NativePdfError("pdf_invalid");
  const { url, key } = configuration(path);
  if (
    path === "repair" &&
    (!candidate ||
      !plan ||
      plan.candidateSha256 !== candidate.candidateSha256 ||
      candidate.sourceSha256 !== pdfSha256(source) ||
      pdfSha256(candidate.pdf) !== candidate.candidateSha256)
  )
    return fail();
  const body =
    path === "prepare"
      ? new Uint8Array(source)
      : JSON.stringify({
          sourcePdfBase64: source.toString("base64"),
          candidatePdfBase64: candidate!.pdf.toString("base64"),
          plan,
        });
  if (typeof body === "string" && Buffer.byteLength(body) > 12 * 1024 * 1024)
    throw new NativePdfError("pdf_complexity_limit");
  const signal = AbortSignal.timeout(
    Math.max(1, Math.floor(Math.min(timeoutMs, 90_000)))
  );
  const send = async (
    requestUrl: URL,
    requestBody: Uint8Array<ArrayBuffer> | string
  ) => {
    const response = await fetch(requestUrl, {
      method: "POST",
      redirect: "manual",
      cache: "no-store",
      signal,
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type":
          path === "prepare" ? "application/pdf" : "application/json",
      },
      body: requestBody,
    });
    if (
      (response.status >= 300 && response.status < 400) ||
      [401, 403].includes(response.status)
    ) {
      void response.body?.cancel().catch(() => {});
      throw new NativePdfError("native_pdf_configuration", response.status);
    }
    if (!response.ok) {
      // Platform errors can be plain text. Preserve the safe status even when
      // there is no worker JSON; never retain arbitrary upstream error bodies.
      let raw: unknown;
      try {
        raw = await boundedResponse(response, signal, 4096);
      } catch {
        if (signal.aborted) throw new NativePdfError("native_pdf_timeout");
      }
      const code =
        objectRecord(raw) && objectRecord(raw.error)
          ? raw.error.code
          : undefined;
      throw new NativePdfError(
        response.status === 413
          ? "pdf_complexity_limit"
          : WORKER_CODES.includes(code as DiagnosticCode)
            ? (code as DiagnosticCode)
            : response.status === 503 || response.status === 429
              ? "native_pdf_busy"
              : "native_pdf_worker_failed",
        response.status
      );
    }
    const raw = await boundedResponse(response, signal, 16 * 1024 * 1024);
    return parseNativePdfState(raw, source);
  };
  try {
    if (
      path === "repair" &&
      typeof body === "string" &&
      Buffer.byteLength(body) > MAX_FILE_SIZE_BYTES &&
      transport
    ) {
      const payload = Buffer.from(body);
      const storedUrl = configuration("repair-stored").url;
      return await transport(payload, signal, async (descriptor) => {
        if (
          descriptor.requestBytes !== payload.length ||
          descriptor.requestSha256 !== pdfSha256(payload) ||
          typeof descriptor.requestUrl !== "string" ||
          descriptor.requestUrl.length > 8000
        )
          return fail();
        return send(storedUrl, JSON.stringify(descriptor));
      });
    }
    return await send(url, body);
  } catch (error) {
    if (signal.aborted) throw new NativePdfError("native_pdf_timeout");
    if (error instanceof NativePdfError) throw error;
    throw new NativePdfError("native_pdf_worker_failed");
  }
}
