import { beforeEach, describe, expect, it, vi } from "vitest";
import { PDFDocument } from "pdf-lib";
import type { NativePdfState, NativePdfTag } from "../lib/native-pdf-worker";
import type { LiteLLMContentPart } from "../lib/litellm";

vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({
  worker: vi.fn(),
  render: vi.fn(),
  call: vi.fn(),
}));
vi.mock("../lib/native-pdf-worker", async (original) => ({
  ...(await original<typeof import("../lib/native-pdf-worker")>()),
  nativePdfRequest: mocks.worker,
}));
vi.mock("../lib/pdf-rendering", async (original) => ({
  ...(await original<typeof import("../lib/pdf-rendering")>()),
  renderPdfPages: mocks.render,
}));
vi.mock("../lib/litellm", async (original) => ({
  ...(await original<typeof import("../lib/litellm")>()),
  callLiteLLM: mocks.call,
  getLiteLLMConfig: (stage: string) => ({
    apiKey: "test-key",
    baseUrl: "https://unit.test",
    model: `${stage}-model`,
  }),
}));

import {
  nativePdfBatches,
  parseNativePdfFindings,
  parseNativePdfPlan,
  parseNativePdfAudit,
  repairNativePdf,
} from "../lib/native-pdf-convert";
import { NativePdfError, pdfSha256 } from "../lib/native-pdf-worker";
import { LiteLLMError } from "../lib/litellm";
import { NATIVE_PDF_AUDIT_PROMPT } from "../lib/prompts/native-pdf-accessibility";
import { presentFinding } from "../lib/accessibility-findings";

function tag(pageNumber: number, id = pageNumber): NativePdfTag {
  const text = `Teaching material on page ${pageNumber}`;
  return {
    id: `tag-${id}`,
    parentId: null,
    children: [],
    role: "P",
    pageNumber,
    text,
    content: [{ pageNumber }],
    editable: { role: true, alt: false, tableHeader: false },
    snapshot: { role: "P", pageNumber, text, mcids: [id], alt: null },
  };
}
async function makeState(count = 1): Promise<NativePdfState> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < count; i++) doc.addPage([100, 100]);
  const pdf = Buffer.from(await doc.save());
  return {
    schemaVersion: 1,
    sourceSha256: pdfSha256(pdf),
    candidateSha256: pdfSha256(pdf),
    pdf,
    pageCount: count,
    inventory: {
      tags: Array.from({ length: count }, (_, i) => tag(i + 1)),
      language: "en-US",
      title: "Teaching material",
      page_content: Array.from({ length: count }, (_, i) => ({
        pageNumber: i + 1,
        artifactText: "",
        artifactTextComplete: true,
      })),
      forms: {},
    },
    findings: [],
    changes: [{ code: "tagged", message: "Added native accessibility tags." }],
    machineChecks: {
      preservationPassed: true,
      pixelsIdentical: true,
      inspectionComplete: true,
      structurePassed: true,
      targetStandard: "PDF/UA-1 (ISO 14289-1:2014)",
      veraPdf: {
        completed: true,
        compliant: false,
        failedRules: 0,
        failedChecks: 0,
      },
      conformanceClaim: false,
    },
  };
}
function useState(state: NativePdfState) {
  mocks.worker.mockResolvedValue(state);
  mocks.render.mockResolvedValue({
    pageCount: state.pageCount,
    pages: Array.from({ length: state.pageCount }, (_, i) => ({
      pageNumber: i + 1,
      width: 100,
      height: 100,
      png: Buffer.from(`mock-png-${i}`),
      text: `Teaching material on page ${i + 1}`,
      imageAlternatives: { status: "complete", figures: [] },
    })),
  });
}
function scope(parts: LiteLLMContentPart[]) {
  const part = parts.find((p) => p.type === "text");
  if (!part || part.type !== "text") throw Error("No scoped evidence");
  return JSON.parse(part.text.split("\n")[1]) as {
    assignedPages: number[];
    assignedTagIds: string[];
    tags: NativePdfTag[];
  };
}
function response(content: unknown) {
  return {
    content: JSON.stringify(content),
    model: "test-model",
    promptTokens: 100,
    completionTokens: 50,
    responseCostUsd: 0.01,
    finishReason: "stop",
  };
}
function validContent(prompt: string, parts: LiteLLMContentPart[]) {
  const assigned = scope(parts);
  return {
    reviewedPages: assigned.assignedPages,
    reviewedTagIds: assigned.assignedTagIds,
    ...(prompt === NATIVE_PDF_AUDIT_PROMPT
      ? {
          artifactReviews: assigned.assignedPages.map((pageNumber) => ({
            pageNumber,
            decision: "decorative-or-redundant",
            explanation: "The page has no excluded meaningful text.",
          })),
          textReviews: assigned.assignedPages.map((pageNumber) => ({
            pageNumber,
            decision: "matches-visible-text",
            explanation:
              "All visible teaching text is present in reading order.",
          })),
        }
      : { operations: [] }),
    findings: [],
  };
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.call.mockImplementation((prompt, parts) =>
    response(validContent(prompt, parts))
  );
});

describe("native PDF model contracts", () => {
  it("binds supported changes to exact worker snapshots and refuses locked descriptions", async () => {
    const state = await makeState();
    const batch = nativePdfBatches(state)[0];
    const base = {
      reviewedPages: [1],
      reviewedTagIds: ["tag-1"],
      findings: [],
      operations: [],
    };
    expect(
      parseNativePdfPlan(
        {
          ...base,
          operations: [{ type: "set_role", tagId: "tag-1", role: "H1" }],
        },
        batch,
        state
      ).operations
    ).toEqual([
      {
        type: "set_role",
        tagId: "tag-1",
        role: "H1",
        expected: state.inventory.tags[0].snapshot,
      },
    ]);
    expect(() =>
      parseNativePdfPlan(
        {
          ...base,
          operations: [
            { type: "set_alt", tagId: "tag-1", alt: "Invented alternative" },
          ],
        },
        batch,
        state
      )
    ).toThrow();
    expect(() =>
      parseNativePdfPlan(
        {
          ...base,
          operations: [
            { type: "replace_text", tagId: "tag-1", text: "Changed facts" },
          ],
        },
        batch,
        state
      )
    ).toThrow();
  });

  it("rejects incomplete, repeated or foreign coverage and unsupplied operation fields", async () => {
    const state = await makeState();
    const batch = nativePdfBatches(state)[0];
    const base = {
      reviewedPages: [1],
      reviewedTagIds: ["tag-1"],
      findings: [],
      operations: [],
    };
    for (const changed of [
      { reviewedPages: [] },
      { reviewedPages: [1, 1] },
      { reviewedTagIds: [] },
      { reviewedTagIds: ["tag-2"] },
      { reviewedTagIds: ["tag-1", "tag-1"] },
      {
        operations: [
          { type: "set_role", tagId: "tag-1", role: "H1", expected: {} },
        ],
      },
      { operations: [{ type: "set_role", tagId: "tag-2", role: "H1" }] },
      {
        operations: Array.from({ length: 2 }, () => ({
          type: "set_role",
          tagId: "tag-1",
          role: "H1",
        })),
      },
    ])
      expect(() =>
        parseNativePdfPlan({ ...base, ...changed }, batch, state)
      ).toThrow();
  });

  it("accepts missing metadata only in the first batch and never overwrites authored metadata", async () => {
    const state = await makeState(5);
    const first = nativePdfBatches(state)[0];
    const plan = {
      reviewedPages: first.pages,
      reviewedTagIds: first.tags.map((t) => t.id),
      operations: [],
      findings: [],
      language: "fr-FR",
      title: "Cours",
    };
    expect(() => parseNativePdfPlan(plan, first, state)).toThrow();
    state.inventory.language = "";
    state.inventory.title = "";
    expect(parseNativePdfPlan(plan, first, state)).toMatchObject({
      language: "fr-FR",
      title: "Cours",
    });
    const last = nativePdfBatches(state)[1];
    expect(() =>
      parseNativePdfPlan(
        {
          ...plan,
          reviewedPages: last.pages,
          reviewedTagIds: last.tags.map((t) => t.id),
        },
        last,
        state
      )
    ).toThrow();
  });

  it("rejects fabricated issue locations and document-wide findings outside the first batch", async () => {
    const state = await makeState(5);
    const [first, last] = nativePdfBatches(state);
    const finding = {
      code: "reading-order",
      severity: "warning",
      pageNumber: 1,
      tagId: "tag-1",
      location: "Teaching material",
      message: "Check this reading order.",
      suggestion: "Review it in a PDF editor.",
    };
    expect(parseNativePdfFindings([finding], first)).toHaveLength(1);
    for (const changed of [
      { pageNumber: 5 },
      { tagId: "tag-5" },
      { pageNumber: 2 },
      { message: "" },
    ])
      expect(() =>
        parseNativePdfFindings([{ ...finding, ...changed }], first)
      ).toThrow();
    const documentFinding = { ...finding, pageNumber: null, tagId: undefined };
    expect(parseNativePdfFindings([documentFinding], first)).toHaveLength(1);
    expect(() => parseNativePdfFindings([documentFinding], last)).toThrow();
  });

  it("assigns every tag exactly once, includes companion pages, and refuses excessive cross-page scope", async () => {
    const state = await makeState(16);
    state.inventory.tags[0].content.push({ pageNumber: 9 });
    const batches = nativePdfBatches(state);
    expect(batches[0].visualPages).toEqual([1, 2, 3, 4, 9]);
    expect(batches.flatMap((b) => b.tags.map((t) => t.id))).toEqual(
      state.inventory.tags.map((t) => t.id)
    );
    state.inventory.tags[0].content = Array.from({ length: 13 }, (_, i) => ({
      pageNumber: i + 1,
    }));
    expect(() => nativePdfBatches(state)).toThrow();
  });

  it("requires explicit excluded-content and visible-text review of every assigned page", async () => {
    const state = await makeState(2);
    const batch = nativePdfBatches(state)[0];
    const base = {
      reviewedPages: [1, 2],
      reviewedTagIds: ["tag-1", "tag-2"],
      findings: [],
      artifactReviews: [1, 2].map((pageNumber) => ({
        pageNumber,
        decision: "decorative-or-redundant",
        explanation: "Only the repeated running title is excluded.",
      })),
      textReviews: [1, 2].map((pageNumber) => ({
        pageNumber,
        decision: "matches-visible-text",
        explanation: "The saved reading text includes the visible lesson.",
      })),
    };
    expect(parseNativePdfAudit(base, batch)).toEqual([]);
    for (const field of ["artifactReviews", "textReviews"] as const) {
      expect(() =>
        parseNativePdfAudit({ ...base, [field]: undefined }, batch)
      ).toThrow();
      expect(() =>
        parseNativePdfAudit(
          { ...base, [field]: base[field].slice(0, 1) },
          batch
        )
      ).toThrow();
      expect(() =>
        parseNativePdfAudit(
          { ...base, [field]: [base[field][0], base[field][0]] },
          batch
        )
      ).toThrow();
      expect(() =>
        parseNativePdfAudit(
          {
            ...base,
            [field]: base[field].map((review) => ({
              ...review,
              explanation: "",
            })),
          },
          batch
        )
      ).toThrow();
    }
  });

  it("requires a located finding when excluded content or OCR remains uncertain", async () => {
    const state = await makeState();
    const batch = nativePdfBatches(state)[0];
    const base = {
      reviewedPages: [1],
      reviewedTagIds: ["tag-1"],
      findings: [],
      artifactReviews: [
        {
          pageNumber: 1,
          decision: "uncertain",
          explanation: "An instruction might have been excluded.",
        },
      ],
      textReviews: [
        {
          pageNumber: 1,
          decision: "matches-visible-text",
          explanation: "The tagged words match the page.",
        },
      ],
    };
    expect(() => parseNativePdfAudit(base, batch)).toThrow();
    const finding = {
      code: "missing-content",
      severity: "warning",
      pageNumber: 1,
      location: "Instruction below lesson",
      message: "The instruction may be missing from reading order.",
      suggestion: "Check this instruction in a PDF editor.",
    };
    expect(
      parseNativePdfAudit({ ...base, findings: [finding] }, batch)
    ).toHaveLength(1);
    const textUncertain = {
      ...base,
      artifactReviews: [
        { ...base.artifactReviews[0], decision: "decorative-or-redundant" },
      ],
      textReviews: [
        { ...base.textReviews[0], decision: "incorrect-or-incomplete" },
      ],
    };
    expect(() => parseNativePdfAudit(textUncertain, batch)).toThrow();
    expect(
      parseNativePdfAudit(
        { ...textUncertain, findings: [{ ...finding, code: "ocr-accuracy" }] },
        batch
      )
    ).toHaveLength(1);
  });
});

describe("native PDF orchestration", () => {
  it("uses the immutable source and exact saved PDF, preserving all model-call costs and explicit review limits", async () => {
    const state = await makeState();
    useState(state);
    const result = await repairNativePdf(state.pdf, "lecture.pdf");
    if ("error" in result) throw Error(result.error);
    expect(result.pdf).toEqual(state.pdf);
    expect(mocks.worker.mock.calls[1]).toEqual([
      "repair",
      state.pdf,
      expect.any(Number),
      state,
      {
        schemaVersion: 1,
        candidateSha256: state.candidateSha256,
        operations: [],
      },
    ]);
    expect(result.calls.map((c) => c.stage)).toEqual(["convert", "validate"]);
    expect(result.calls.map((c) => c.costUsd)).toEqual([0.01, 0.01]);
    expect(result.tokensUsed).toBe(300);
    expect(result.nativePdfChecks).toMatchObject({
      auditComplete: true,
      screenReaderTestPerformed: false,
      conformanceClaim: false,
    });
    const auditParts = mocks.call.mock.calls[1][1] as LiteLLMContentPart[];
    const pdfs = auditParts.filter((p) => p.type === "file");
    expect(pdfs).toHaveLength(2);
    for (const part of pdfs) {
      if (part.type !== "file") throw Error();
      expect(
        (
          await PDFDocument.load(
            Buffer.from(part.file.file_data!.split(",")[1], "base64")
          )
        ).getPageCount()
      ).toBe(1);
    }
  });

  it("rejects unsupported input before work and never returns raw worker diagnostics", async () => {
    expect(
      await repairNativePdf(Buffer.from("private invalid input"), "lecture.pdf")
    ).toHaveProperty("error");
    expect(mocks.worker).not.toHaveBeenCalled();
    const state = await makeState();
    useState(state);
    mocks.worker.mockRejectedValueOnce(
      new Error("private source text and credentials")
    );
    expect(
      JSON.stringify(await repairNativePdf(state.pdf, "lecture.pdf"))
    ).not.toContain("private source");
    expect(mocks.call).not.toHaveBeenCalled();
  });

  it("waits for active repair calls and retains billed invalid responses when one batch fails", async () => {
    const state = await makeState(20);
    useState(state);
    let active = 0;
    mocks.call.mockImplementation(async (prompt, parts) => {
      const assigned = scope(parts);
      active++;
      if (assigned.assignedPages[0] !== 1)
        await new Promise((resolve) => setTimeout(resolve, 10));
      active--;
      return response(
        assigned.assignedPages[0] === 1
          ? { ...validContent(prompt, parts), reviewedTagIds: [] }
          : validContent(prompt, parts)
      );
    });
    const result = await repairNativePdf(state.pdf, "lecture.pdf");
    expect(result).toHaveProperty("error");
    expect(active).toBe(0);
    expect(mocks.call).toHaveBeenCalledTimes(4);
    expect(result.calls).toHaveLength(4);
    expect(result.calls?.every((c) => c.costUsd === 0.01)).toBe(true);
    expect(mocks.worker).toHaveBeenCalledTimes(1);
  });

  it("retains repair-call costs if writing or preservation verification fails", async () => {
    const state = await makeState();
    useState(state);
    mocks.worker
      .mockResolvedValueOnce(state)
      .mockRejectedValueOnce(new NativePdfError("native_pdf_preservation"));
    const result = await repairNativePdf(state.pdf, "lecture.pdf");
    expect(result).toMatchObject({
      diagnostic: {
        stage: "native_pdf_repair",
        code: "native_pdf_preservation",
      },
      calls: [{ stage: "convert", costUsd: 0.01 }],
    });
    expect(mocks.call).toHaveBeenCalledTimes(1);
  });

  it("keeps completed audit findings, machine issues and costs when another audit batch has incomplete coverage", async () => {
    const state = await makeState(8);
    useState(state);
    state.findings.push({
      code: "unembedded-font",
      severity: "error",
      message: "An original font is not embedded.",
      pageNumber: 1,
    });
    mocks.call.mockImplementation((prompt, parts) => {
      const content = validContent(prompt, parts);
      if (prompt !== NATIVE_PDF_AUDIT_PROMPT) return response(content);
      if (content.reviewedPages[0] === 1)
        return response({ ...content, reviewedPages: [] });
      return response({
        ...content,
        findings: [
          {
            code: "image-description",
            severity: "warning",
            pageNumber: 5,
            tagId: "tag-5",
            location: "Course diagram",
            message: "The diagram's meaning is not fully explained.",
            suggestion: "Add an explanation of the diagram in a PDF editor.",
          },
        ],
      });
    });
    const result = await repairNativePdf(state.pdf, "lecture.pdf");
    if ("error" in result) throw Error(result.error);
    expect(result.nativePdfChecks.auditComplete).toBe(false);
    expect(result.calls).toHaveLength(4);
    expect(result.errors.map((e) => e.message)).toEqual(
      expect.arrayContaining([
        "An original font is not embedded.",
        "The diagram's meaning is not fully explained.",
        expect.stringContaining("did not finish"),
      ])
    );
    expect(
      result.errors
        .map(presentFinding)
        .every((f) => !`${f.message} ${f.suggestion}`.includes("Canvas"))
    ).toBe(true);
  });

  it("records failed provider audits as visible incomplete review without exposing response details", async () => {
    const state = await makeState();
    useState(state);
    mocks.call.mockImplementation((prompt, parts) => {
      if (prompt === NATIVE_PDF_AUDIT_PROMPT)
        throw new LiteLLMError("private provider response");
      return response(validContent(prompt, parts));
    });
    const result = await repairNativePdf(state.pdf, "lecture.pdf");
    if ("error" in result) throw Error(result.error);
    expect(result.nativePdfChecks.auditComplete).toBe(false);
    expect(result.calls).toHaveLength(1);
    expect(
      result.errors.some((f) => f.message.includes("did not finish"))
    ).toBe(true);
    expect(JSON.stringify(result.errors)).not.toContain("private provider");
  });

  it("processes sixty pages with at most four active calls and bounded real PDF excerpts", async () => {
    const state = await makeState(60);
    useState(state);
    let active = 0,
      peak = 0;
    const excerptCounts: number[] = [];
    mocks.call.mockImplementation(
      async (prompt, parts: LiteLLMContentPart[]) => {
        active++;
        peak = Math.max(peak, active);
        const images = parts.filter((p) => p.type === "image_url");
        expect(images).toHaveLength(4);
        for (const part of parts)
          if (part.type === "file") {
            const excerpt = await PDFDocument.load(
              Buffer.from(part.file.file_data!.split(",")[1], "base64")
            );
            excerptCounts.push(excerpt.getPageCount());
          }
        await new Promise((resolve) => setTimeout(resolve, 2));
        active--;
        return response(validContent(prompt, parts));
      }
    );
    const result = await repairNativePdf(state.pdf, "lecture.pdf");
    if ("error" in result) throw Error(result.error);
    expect(peak).toBe(4);
    expect(active).toBe(0);
    expect(mocks.call).toHaveBeenCalledTimes(30);
    expect(result.calls).toHaveLength(30);
    expect(result.pageCount).toBe(60);
    expect(result.nativePdfChecks.auditComplete).toBe(true);
    expect(excerptCounts).toHaveLength(45);
    expect(excerptCounts.every((count) => count === 4)).toBe(true);
  });
});
