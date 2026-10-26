import { beforeEach, describe, expect, it, vi } from "vitest";
import { PDFDocument, PDFName } from "pdf-lib";
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
  parseNativePdfHeadingReviews,
  coalesceNativePdfOperations,
  repairNativePdf,
} from "../lib/native-pdf-convert";
import { NativePdfError, pdfSha256 } from "../lib/native-pdf-worker";
import { LiteLLMError } from "../lib/litellm";
import { NATIVE_PDF_AUDIT_PROMPT } from "../lib/prompts/native-pdf-accessibility";
import { presentFinding } from "../lib/accessibility-findings";
import * as interactionEvidence from "../lib/native-pdf-interaction-evidence";

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
    pageReviewPages: number[];
    assignedTagIds: string[];
    tags: NativePdfTag[];
    repairFindingReviewTargets: import("../lib/native-pdf-convert").NativePdfHeadingReviewTarget[];
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
          artifactReviews: assigned.pageReviewPages.map((pageNumber) => ({
            pageNumber,
            decision: "decorative-or-redundant",
            explanation: "The page has no excluded meaningful text.",
          })),
          textReviews: assigned.pageReviewPages.map((pageNumber) => ({
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
  vi.restoreAllMocks();
  vi.resetAllMocks();
  mocks.call.mockImplementation((prompt, parts) =>
    response(validContent(prompt, parts))
  );
});

describe("prior matching PDF interaction tests", () => {
  const fieldId = "field-" + "a".repeat(64);
  const blanket = {
    code: "legacy_form_interaction_review",
    severity: "warning" as const,
    message: "Test this form's interactions.",
  };
  const remaining = [
    {
      code: "form-certification-method",
      severity: "warning" as const,
      pageNumber: 1,
      location: "Certification",
      message: "Signing and dating have not been tested.",
      suggestion: "Check the accepted keyboard method.",
    },
  ];
  function tests(
    state: NativePdfState
  ): interactionEvidence.MatchedNativePdfInteractionTests {
    return {
      schemaVersion: 1,
      evidenceId: "unit-tested-form-v1",
      testedAt: "2026-10-22",
      environment: "Acrobat and NVDA",
      testedPdfSha256: "b".repeat(64),
      savedTestCopySha256: "c".repeat(64),
      sourceSha256: state.sourceSha256,
      matchedCandidateSha256: state.candidateSha256,
      interactionFingerprint: { schemaVersion: 1, sha256: "d".repeat(64) },
      coverage: [
        {
          action: "field-announcement",
          fieldIds: [fieldId],
          observation: "The name was announced.",
        },
      ],
      remainingReviews: remaining,
      remainingReviewCoverage: [
        {
          reviewCode: "form-certification-method",
          pageNumber: 1,
          action: "signing",
          fieldIds: [],
        },
        {
          reviewCode: "form-certification-method",
          pageNumber: 1,
          action: "dating",
          fieldIds: [],
        },
      ],
      scope: "prior-tests-of-matching-form",
      testsRunDuringThisConversion: false,
    };
  }
  function request() {
    return {
      code: "form-interaction-review",
      severity: "warning",
      pageNumber: 1,
      location: "Name",
      message: "Check this announcement.",
      suggestion: "Listen to the name.",
      interactionReview: {
        basis: "not-tested",
        action: "field-announcement",
        fieldIds: [fieldId],
      },
    };
  }
  it("sends matched evidence to both stages and saves the scope without claiming a new screen-reader run", async () => {
    const state = await makeState();
    state.inventory.forms = { fields: [{ fieldId, pageNumbers: [1] }] };
    state.findings = [
      blanket,
      {
        code: "font-mapping",
        severity: "error",
        message: "Current font problem.",
      },
    ];
    const match = vi
      .spyOn(interactionEvidence, "getNativePdfInteractionTests")
      .mockImplementation((candidate, sourceHash) => {
        expect(sourceHash).toBe(pdfSha256(state.pdf));
        return tests(candidate);
      });
    useState(state);
    mocks.call.mockImplementation((prompt, parts) =>
      response({ ...validContent(prompt, parts), findings: [request()] })
    );
    const result = await repairNativePdf(state.pdf, "form.pdf");
    if ("error" in result) throw new Error(result.error);
    expect(match).toHaveBeenCalledTimes(2);
    for (const [, parts] of mocks.call.mock.calls) {
      expect(scope(parts)).toMatchObject({
        priorMatchingInteractionTests: { evidenceId: "unit-tested-form-v1" },
        findings: [
          expect.objectContaining({ code: "font-mapping" }),
          ...remaining,
        ],
      });
    }
    expect(result.errors.map((finding) => finding.message)).toEqual([
      "Current font problem.",
      remaining[0].message,
    ]);
    expect(result.interactionTestSummary?.passedChecks).toEqual([
      "The name was announced.",
    ]);
    expect(result.nativePdfChecks).toMatchObject({
      screenReaderTestPerformed: false,
      priorMatchingInteractionTests: { testsRunDuringThisConversion: false },
    });
  });
  it("does not carry a prepared match forward when the saved form no longer matches", async () => {
    const state = await makeState();
    state.inventory.forms = { fields: [{ fieldId, pageNumbers: [1] }] };
    state.findings = [blanket];
    vi.spyOn(interactionEvidence, "getNativePdfInteractionTests")
      .mockReturnValueOnce(tests(state))
      .mockReturnValueOnce(undefined);
    useState(state);
    const result = await repairNativePdf(state.pdf, "form.pdf");
    if ("error" in result) throw new Error(result.error);
    expect(scope(mocks.call.mock.calls[0][1])).toMatchObject({
      priorMatchingInteractionTests: { evidenceId: "unit-tested-form-v1" },
    });
    expect(scope(mocks.call.mock.calls[1][1])).toMatchObject({
      priorMatchingInteractionTests: null,
      findings: [blanket],
    });
    expect(result.errors.map((finding) => finding.message)).toEqual([
      blanket.message,
    ]);
    expect(result.interactionTestSummary).toBeUndefined();
    expect(
      result.nativePdfChecks.priorMatchingInteractionTests
    ).toBeUndefined();
  });
  it("accepts only typed missing-test requests bound to existing fields on the assigned page", async () => {
    const state = await makeState(2);
    state.inventory.forms = { fields: [{ fieldId, pageNumbers: [1] }] };
    const batch = nativePdfBatches(state)[0];
    expect(
      parseNativePdfFindings([request()], batch, state)[0].interactionReview
    ).toMatchObject({ basis: "not-tested" });
    for (const bad of [
      { ...request(), severity: "error" },
      { ...request(), pageNumber: 2 },
      {
        ...request(),
        interactionReview: {
          ...request().interactionReview,
          fieldIds: ["field-" + "b".repeat(64)],
        },
      },
      {
        ...request(),
        interactionReview: {
          ...request().interactionReview,
          basis: "observed-defect",
        },
      },
      { ...request(), code: "observed-label-problem" },
    ])
      expect(() => parseNativePdfFindings([bad], batch, state)).toThrow();
  });
});

describe("native PDF model contracts", () => {
  it("describes rendering evidence accurately when pixels are not identical", async () => {
    const state = await makeState();
    state.machineChecks.pixelsIdentical = false;
    state.machineChecks.renderingEquivalence = {
      method: "identical-paint-multiscale-v1",
      pages: [
        {
          pageNumber: 1,
          changedPixels: 8,
          totalPixels: 1_000_000,
          verificationScales: [1, 2],
        },
      ],
    };
    useState(state);
    const result = await repairNativePdf(state.pdf, "render-equivalence.pdf");
    if ("error" in result) throw Error(result.error);
    expect(result.nativePdfChecks.pixelsIdentical).toBe(false);
    for (const [, parts] of mocks.call.mock.calls) {
      const descriptions = (parts as LiteLLMContentPart[])
        .filter((part) => part.type === "text")
        .map((part) => part.text);
      expect(descriptions).toContain(
        "Original physical PDF page 1. The machine-check evidence describes how page appearance was verified."
      );
      expect(
        descriptions.some((value) =>
          value.includes("confirms the repaired page is identical")
        )
      ).toBe(false);
      expect(
        descriptions.some((value) => value.includes('"pixelsIdentical":false'))
      ).toBe(true);
    }
  });
  it("splits a detailed four-page inventory below 200 tags by serialized size", async () => {
    const state = await makeState(4);
    state.inventory.tags = Array.from({ length: 186 }, (_, index) => {
      const item = tag(Math.floor(index / 47) + 1, index + 1);
      item.text = "Source paragraph. ".repeat(100);
      item.snapshot.text = item.text;
      return item;
    });
    expect(JSON.stringify(state.inventory.tags).length).toBeGreaterThan(
      350_000
    );
    const batches = nativePdfBatches(state);
    expect(batches.length).toBeGreaterThan(1);
    expect(
      batches.every((batch) => JSON.stringify(batch.tags).length <= 350_000)
    ).toBe(true);
    expect(
      batches.every(
        (batch) =>
          batch.tags.length <= 200 &&
          batch.pages.length <= 4 &&
          batch.visualPages.length <= 12
      )
    ).toBe(true);
    expect(
      batches.flatMap((batch) => batch.tags.map((item) => item.id))
    ).toEqual(state.inventory.tags.map((item) => item.id));
    expect(batches.flatMap((batch) => batch.pageReviewPages)).toEqual([
      1, 2, 3, 4,
    ]);
    expect(batches.filter((batch) => batch.first)).toHaveLength(1);
    useState(state);
    const result = await repairNativePdf(state.pdf, "detailed-inventory.pdf");
    expect("error" in result).toBe(false);
    expect(mocks.call).toHaveBeenCalledTimes(batches.length * 2);
  });

  it("splits a size-heavy single page while retaining exactly one page-wide reviewer", async () => {
    const state = await makeState();
    state.inventory.tags = Array.from({ length: 160 }, (_, index) => {
      const item = tag(1, index + 1);
      item.text = "x".repeat(2500);
      item.snapshot.text = item.text;
      return item;
    });
    const batches = nativePdfBatches(state);
    expect(batches.length).toBeGreaterThan(1);
    expect(batches.flatMap((batch) => batch.pageReviewPages)).toEqual([1]);
    expect(
      batches.flatMap((batch) => batch.tags.map((item) => item.id))
    ).toEqual(state.inventory.tags.map((item) => item.id));
    expect(
      batches.every(
        (batch) =>
          batch.pages.join() === "1" &&
          JSON.stringify(batch.tags).length <= 350_000
      )
    ).toBe(true);
  });

  it("splits combined companion-page scope instead of rejecting individually bounded tags", async () => {
    const state = await makeState(16);
    state.inventory.tags[0].content = Array.from({ length: 8 }, (_, index) => ({
      pageNumber: index + 1,
    }));
    state.inventory.tags[1].content = [2, 9, 10, 11, 12, 13, 14, 15].map(
      (pageNumber) => ({ pageNumber })
    );
    const batches = nativePdfBatches(state);
    expect(batches.every((batch) => batch.visualPages.length <= 12)).toBe(true);
    expect(
      batches.find((batch) => batch.tags.some((item) => item.id === "tag-1"))
        ?.visualPages
    ).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(
      batches.flatMap((batch) => batch.tags.map((item) => item.id))
    ).toEqual(state.inventory.tags.map((item) => item.id));
    expect(batches.flatMap((batch) => batch.pageReviewPages)).toEqual(
      Array.from({ length: 16 }, (_, index) => index + 1)
    );
  });

  it("includes a continuation's previous-page visual context without assigning its read-only anchor twice", async () => {
    const state = await makeState(2);
    state.inventory.tags = [
      ...Array.from({ length: 201 }, (_, index) => tag(1, index + 1)),
      tag(2, 202),
    ];
    state.inventory.structureCandidates = [
      {
        candidateId: "f".repeat(64),
        kind: "move_page_continuation",
        tagId: "tag-202",
        pageNumber: 2,
        text: "continues the previous sentence.",
        preview: "The previous page ends mid-sentence.",
        relatedTagIds: ["tag-201"],
        readonlyTagIds: ["tag-201"],
      },
    ];
    const batches = nativePdfBatches(state);
    const continuation = batches.find((batch) => batch.pages.includes(2))!;
    expect(continuation.pages).toEqual([2]);
    expect(continuation.visualPages).toEqual([1, 2]);
    expect(continuation.tags.map((item) => item.id)).toEqual(["tag-202"]);
    expect(batches.flatMap((batch) => batch.pageReviewPages)).toEqual([1, 2]);
    expect(
      batches.flatMap((batch) => batch.tags.map((item) => item.id))
    ).toEqual(state.inventory.tags.map((item) => item.id));
    expect(() =>
      parseNativePdfPlan(
        {
          reviewedPages: continuation.pages,
          reviewedTagIds: ["tag-202"],
          operations: [{ type: "set_role", tagId: "tag-201", role: "P" }],
          findings: [],
        },
        continuation,
        state
      )
    ).toThrow("native_pdf_invalid_plan");
  });

  it("keeps the visual-page budget when candidate context cannot fit a single assigned tag", async () => {
    const state = await makeState(13);
    state.inventory.structureCandidates = [
      {
        candidateId: "e".repeat(64),
        kind: "move_callout",
        tagId: "tag-13",
        pageNumber: 13,
        text: "Source",
        preview: "Source-derived related content",
        relatedTagIds: Array.from(
          { length: 12 },
          (_, index) => `tag-${index + 1}`
        ),
      },
    ];
    expect(() => nativePdfBatches(state)).toThrow("pdf_complexity_limit");
  });

  it("includes contextual evidence in the existing 900,000-character scope budget", async () => {
    const state = await makeState(3);
    state.inventory.forms = { authoredDescription: "x".repeat(620_000) };
    for (const item of state.inventory.tags) {
      item.text = "x".repeat(55_000);
      item.snapshot.text = item.text;
    }
    expect(JSON.stringify(state.inventory.tags).length).toBeLessThan(350_000);
    const batches = nativePdfBatches(state);
    expect(batches.length).toBeGreaterThan(1);
    expect(
      batches.flatMap((batch) => batch.tags.map((item) => item.id))
    ).toEqual(state.inventory.tags.map((item) => item.id));
    useState(state);
    const result = await repairNativePdf(state.pdf, "context-budget.pdf");
    expect("error" in result).toBe(false);
    for (const [, parts] of mocks.call.mock.calls) {
      const textPart = (parts as LiteLLMContentPart[]).find(
        (part) => part.type === "text"
      );
      if (textPart?.type !== "text") throw Error("Missing model evidence");
      const evidence = textPart.text
        .split("\n")
        .filter((line) => line.startsWith('{"evidenceRole"'));
      expect(evidence.every((value) => value.length <= 900_000)).toBe(true);
    }
  });

  it("still rejects a single tag or global evidence that cannot fit without being discarded", async () => {
    const state = await makeState();
    state.inventory.tags[0].text = "x".repeat(180_000);
    state.inventory.tags[0].snapshot.text = state.inventory.tags[0].text;
    expect(() => nativePdfBatches(state)).toThrow("pdf_complexity_limit");
    state.inventory.tags = [tag(1)];
    state.inventory.forms = { authoredDescription: "x".repeat(900_000) };
    expect(() => nativePdfBatches(state)).toThrow("pdf_complexity_limit");
  });

  it("allows exact phase evidence to split batches without losing review ownership", async () => {
    const state = await makeState(3);
    const evidence = (batch: ReturnType<typeof nativePdfBatches>[number]) => {
      const serialized = JSON.stringify({
        retainedContext: batch.pages.map((pageNumber) => ({
          pageNumber,
          content: "x".repeat(320_000),
        })),
      });
      if (serialized.length > 900_000)
        throw new NativePdfError("pdf_complexity_limit");
      return serialized;
    };
    expect(nativePdfBatches(state)).toHaveLength(1);
    const batches = nativePdfBatches(state, evidence);
    expect(batches).toHaveLength(2);
    expect(batches.flatMap((batch) => batch.pageReviewPages)).toEqual([
      1, 2, 3,
    ]);
    expect(
      batches.flatMap((batch) => batch.tags.map((item) => item.id))
    ).toEqual(["tag-1", "tag-2", "tag-3"]);
    expect(batches.every((batch) => evidence(batch).length <= 900_000)).toBe(
      true
    );
    expect(() =>
      nativePdfBatches(state, () => {
        throw new NativePdfError("pdf_protocol_error");
      })
    ).toThrow("pdf_protocol_error");
  });

  it("sizes audit batches with the actual retained findings", async () => {
    const state = await makeState(3);
    useState(state);
    const findings = Array.from({ length: 240 }, (_, index) => ({
      code: "source-review",
      severity: "warning",
      pageNumber: (index % 3) + 1,
      location: "x".repeat(200),
      message: `Concern ${index}: ` + "x".repeat(1780),
      suggestion: "x".repeat(1800),
    }));
    mocks.call.mockImplementation((prompt, parts) =>
      response({
        ...validContent(prompt, parts),
        ...(prompt !== NATIVE_PDF_AUDIT_PROMPT ? { findings } : {}),
      })
    );
    const result = await repairNativePdf(
      state.pdf,
      "retained-findings-budget.pdf"
    );
    if ("error" in result) throw Error(result.error);
    expect(result.nativePdfChecks.auditComplete).toBe(true);
    const auditCalls = mocks.call.mock.calls.filter(
      ([prompt]) => prompt === NATIVE_PDF_AUDIT_PROMPT
    );
    expect(auditCalls).toHaveLength(2);
    expect(
      auditCalls.flatMap(([, parts]) => scope(parts).pageReviewPages)
    ).toEqual([1, 2, 3]);
    for (const [, parts] of auditCalls) {
      const firstText = (parts as LiteLLMContentPart[]).find(
        (part) => part.type === "text"
      );
      if (firstText?.type !== "text") throw Error("Missing audit evidence");
      const current = firstText.text.split("\n")[1];
      expect(current.length).toBeLessThanOrEqual(900_000);
      expect(
        JSON.parse(current).outstandingRepairFindings.length
      ).toBeGreaterThan(0);
    }
  });

  it("sizes audit batches with the actual historical inventory as well as the output", async () => {
    const prepared = await makeState(3);
    prepared.inventory.forms = { authoredDescription: "x".repeat(620_000) };
    prepared.inventory.tags.forEach((item) => {
      item.extractionDetails = "x".repeat(110_000);
    });
    const repaired: NativePdfState = {
      ...prepared,
      inventory: {
        ...prepared.inventory,
        tags: prepared.inventory.tags.map((item) => {
          const copy = { ...item };
          delete copy.extractionDetails;
          return copy;
        }),
      },
    };
    expect(nativePdfBatches(repaired)).toHaveLength(1);
    useState(prepared);
    mocks.worker
      .mockResolvedValueOnce(prepared)
      .mockResolvedValueOnce(repaired);
    const result = await repairNativePdf(
      prepared.pdf,
      "historical-inventory-budget.pdf"
    );
    if ("error" in result) throw Error(result.error);
    expect(result.nativePdfChecks.auditComplete).toBe(true);
    const auditCalls = mocks.call.mock.calls.filter(
      ([prompt]) => prompt === NATIVE_PDF_AUDIT_PROMPT
    );
    expect(auditCalls).toHaveLength(2);
    expect(
      auditCalls.flatMap(([, parts]) => scope(parts).assignedTagIds)
    ).toEqual(["tag-1", "tag-2", "tag-3"]);
    for (const [, parts] of auditCalls) {
      const firstText = (parts as LiteLLMContentPart[]).find(
        (part) => part.type === "text"
      );
      if (firstText?.type !== "text") throw Error("Missing audit evidence");
      const historical = firstText.text.split("\n")[3];
      expect(historical.length).toBeLessThanOrEqual(900_000);
      expect(
        JSON.parse(historical).tags.every(
          (item: NativePdfTag) => item.extractionDetails === "x".repeat(110_000)
        )
      ).toBe(true);
    }
  });

  it("assigns unpaged wrappers by descendant content without attaching sixty companion pages to the root", async () => {
    const state = await makeState(60);
    const leaves = state.inventory.tags;
    const wrappers = leaves.map((leaf, index) => ({
      ...tag(1, index + 100),
      pageNumber: null,
      content: [],
      role: "Sect",
      children: [leaf.id],
      parentId: "tag-1000",
    }));
    leaves.forEach((leaf, index) => {
      leaf.parentId = wrappers[index].id;
    });
    const root = {
      ...tag(1, 1000),
      pageNumber: null,
      content: [],
      role: "Document",
      children: wrappers.map((wrapper) => wrapper.id),
    };
    state.inventory.tags = [
      root,
      ...wrappers.flatMap((wrapper, index) => [wrapper, leaves[index]]),
    ];
    const batches = nativePdfBatches(state);
    expect(batches).toHaveLength(15);
    expect(batches.every((batch) => batch.visualPages.length === 4)).toBe(true);
    expect(batches[1].tags.map((tag) => tag.id)).toContain("tag-104");
    expect(batches[0].tags.map((tag) => tag.id)).not.toContain("tag-104");
    expect(
      new Set(batches.flatMap((batch) => batch.tags.map((tag) => tag.id))).size
    ).toBe(121);
    const empty = {
      ...tag(1, 2000),
      pageNumber: null,
      content: [],
      parentId: "tag-104",
    };
    wrappers[4].children.unshift(empty.id);
    state.inventory.tags.push(empty);
    const withEmpty = nativePdfBatches(state);
    expect(withEmpty[0].tags.map((tag) => tag.id)).not.toContain("tag-104");
    expect(withEmpty[1].tags.map((tag) => tag.id)).toContain("tag-104");
  });

  it("gives a dense page one owner for page-wide findings while every chunk reviews its tags", async () => {
    const state = await makeState();
    state.inventory.tags = Array.from({ length: 201 }, (_, i) => tag(1, i + 1));
    const [owner, secondary] = nativePdfBatches(state);
    expect(owner.pageReviewPages).toEqual([1]);
    expect(secondary.pageReviewPages).toEqual([]);
    const finding = {
      code: "form-review",
      severity: "warning",
      pageNumber: 1,
      location: "Name field",
      message: "Check the field's announcement.",
      suggestion: "Check it in Acrobat.",
    };
    expect(parseNativePdfFindings([finding], owner)).toHaveLength(1);
    expect(() => parseNativePdfFindings([finding], secondary)).toThrow();
    expect(
      parseNativePdfFindings([{ ...finding, tagId: "tag-201" }], secondary)
    ).toHaveLength(1);
    expect(() =>
      parseNativePdfFindings([{ ...finding, code: "heading-structure" }], owner)
    ).toThrow();
    expect(
      parseNativePdfAudit(
        {
          reviewedPages: [1],
          reviewedTagIds: ["tag-201"],
          artifactReviews: [],
          textReviews: [],
          findings: [],
        },
        secondary
      )
    ).toEqual([]);
  });

  it.each([
    "split_heading",
    "join_list_continuation",
    "mark_note_reference",
    "convert_list",
    "rebuild_table",
    "rebuild_grid_table",
    "join_interrupted_text",
    "restore_decimal_paragraphs",
    "restore_excluded_figure",
    "move_callout",
    "describe_chart",
  ] as const)(
    "binds %s to a supplied candidate and rejects arbitrary changes",
    async (kind) => {
      const state = await makeState();
      const candidateId = "a".repeat(64);
      state.inventory.structureCandidates = [
        {
          candidateId,
          kind,
          tagId: "tag-1",
          pageNumber: 1,
          text: "Source heading and paragraph",
          preview: "Source-bound structural change",
          relatedTagIds: [],
        },
      ];
      const batch = nativePdfBatches(state)[0];
      const operation = {
        type: "repair_structure",
        tagId: "tag-1",
        candidateId,
        ...(kind === "split_heading" ? { role: "H3" } : {}),
        ...(["describe_chart", "restore_excluded_figure"].includes(kind)
          ? {
              alt: "The chart compares the observed results for the two groups.",
            }
          : {}),
      };
      const base = {
        reviewedPages: [1],
        reviewedTagIds: ["tag-1"],
        findings: [],
        operations: [operation],
      };
      expect(parseNativePdfPlan(base, batch, state).operations).toEqual([
        { ...operation, expected: state.inventory.tags[0].snapshot },
      ]);
      for (const change of [
        { candidateId: "b".repeat(64) },
        { tagId: "tag-2" },
        { text: "Invented replacement" },
        { offset: 7 },
        { role: kind === "split_heading" ? "H1" : "H3" },
        {
          alt: ["describe_chart", "restore_excluded_figure"].includes(kind)
            ? ""
            : "An unsupported description",
        },
        { alt: "x".repeat(8001) },
      ])
        expect(() =>
          parseNativePdfPlan(
            { ...base, operations: [{ ...operation, ...change }] },
            batch,
            state
          )
        ).toThrow();
    }
  );

  it("retains omitted heading reviews and accepts only explicit evidence from an eligible current tag", () => {
    const target = {
      findingId: "repair-finding-1",
      finding: {
        code: "heading-structure",
        severity: "warning" as const,
        message: "Check heading level.",
      },
      tagId: "tag-2",
      beforeRole: "H4",
      currentRole: "H3",
      eligibleForResolution: true,
    };
    const review = {
      findingId: target.findingId,
      decision: "resolved",
      explanation: "The saved H3 is a child of the current H2.",
      currentTag: { tagId: "tag-2", role: "H3" },
    };
    expect(parseNativePdfHeadingReviews(undefined, [target])).toEqual([]);
    expect(parseNativePdfHeadingReviews([], [target])).toEqual([]);
    expect(parseNativePdfHeadingReviews([review], [target])).toEqual([
      target.findingId,
    ]);
    expect(
      parseNativePdfHeadingReviews(
        [{ ...review, decision: "uncertain" }],
        [target]
      )
    ).toEqual([]);
    for (const change of [
      { findingId: "machine-finding" },
      { currentTag: { tagId: "tag-1", role: "H3" } },
      { currentTag: { tagId: "tag-2", role: "H4" } },
      { explanation: "" },
      { operation: "set_role" },
    ])
      expect(() =>
        parseNativePdfHeadingReviews([{ ...review, ...change }], [target])
      ).toThrow();
    expect(() =>
      parseNativePdfHeadingReviews([review, review], [target])
    ).toThrow();
    expect(() =>
      parseNativePdfHeadingReviews(
        [review],
        [{ ...target, eligibleForResolution: false }]
      )
    ).toThrow();
  });

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
        operations: [
          { type: "set_form_label", tagId: "tag-1", label: "Invented label" },
        ],
      },
      {
        operations: [
          { type: "set_form_required", tagId: "tag-1", required: true },
        ],
      },
      { operations: [{ type: "enable_xfa_speech", tagId: "tag-1" }] },
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

describe("current excluded-text review reconciliation", () => {
  const reminder = (pageNumber = 1) => ({
    code: "artifact_text_needs_semantic_review",
    severity: "warning" as const,
    pageNumber,
    message: `Check excluded text on page ${pageNumber}.`,
  });
  const missing = (pageNumber = 1) => ({
    code: "missing-content",
    severity: "warning" as const,
    pageNumber,
    location: "Instruction below the figure",
    message: "A unique instruction is absent from reading order.",
    suggestion: "Restore the instruction to the PDF reading order.",
  });
  async function run(state: NativePdfState) {
    const result = await repairNativePdf(state.pdf, "excluded-text.pdf");
    if ("error" in result) throw Error(result.error);
    return result;
  }

  it("retires only a worker reminder with complete current evidence and keeps validator errors and model findings", async () => {
    const prepared = await makeState();
    const doc = await PDFDocument.load(prepared.pdf);
    doc.setTitle("Current repaired PDF");
    const pdf = Buffer.from(await doc.save());
    const repaired = {
      ...prepared,
      pdf,
      candidateSha256: pdfSha256(pdf),
      findings: [
        reminder(),
        {
          code: "pdfua-font-rule",
          severity: "error" as const,
          pageNumber: 1,
          message: "An original font is not embedded.",
        },
        {
          ...reminder(),
          severity: "error" as const,
          message: "An actual excluded-text error must remain.",
        },
      ],
    };
    repaired.machineChecks.veraPdf.failedChecks = 2;
    useState(prepared);
    mocks.worker
      .mockResolvedValueOnce(prepared)
      .mockResolvedValueOnce(repaired);
    mocks.call.mockImplementation((prompt, parts) =>
      response({
        ...validContent(prompt, parts),
        ...(prompt === NATIVE_PDF_AUDIT_PROMPT
          ? {
              findings: [
                {
                  ...reminder(),
                  location: "Footer",
                  message: "Separate model concern.",
                  suggestion: "Review the footer with your accessibility team.",
                },
              ],
            }
          : {}),
      })
    );
    const result = await run(prepared);
    expect(result.errors.map((error) => error.message)).toEqual([
      "An original font is not embedded.",
      "An actual excluded-text error must remain.",
      "Separate model concern.",
    ]);
    expect(result.nativePdfChecks.veraPdf.failedChecks).toBe(2);
    expect(result.nativePdfChecks.artifactTextReview).toEqual({
      candidateSha256: repaired.candidateSha256,
      pages: [
        {
          pageNumber: 1,
          decision: "decorative-or-redundant",
          explanation: "The page has no excluded meaningful text.",
          inventoryComplete: true,
          pageAuditComplete: true,
          reminderRetired: true,
        },
      ],
    });
    expect(result.nativePdfChecks.artifactTextReview?.candidateSha256).not.toBe(
      prepared.candidateSha256
    );
  });

  it.each([
    "false",
    "missing-flag",
    "string-flag",
    "missing-page",
    "wrong-page",
    "duplicate-page",
  ])(
    "retains the reminder when current page evidence is incomplete or ambiguous: %s",
    async (mode) => {
      const state = await makeState();
      state.findings = [reminder()];
      if (mode === "false")
        state.inventory.page_content[0].artifactTextComplete = false;
      if (mode === "missing-flag")
        delete state.inventory.page_content[0].artifactTextComplete;
      if (mode === "string-flag")
        state.inventory.page_content[0].artifactTextComplete = "true";
      if (mode === "missing-page") state.inventory.page_content = [];
      if (mode === "wrong-page") state.inventory.page_content[0].pageNumber = 2;
      if (mode === "duplicate-page")
        state.inventory.page_content.push({
          ...state.inventory.page_content[0],
        });
      useState(state);
      const result = await run(state);
      expect(result.errors.map((error) => error.message)).toContain(
        reminder().message
      );
      expect(result.nativePdfChecks.artifactTextReview?.pages[0]).toMatchObject(
        {
          inventoryComplete: false,
          reminderRetired: false,
        }
      );
    }
  );

  it.each([
    "missing",
    "duplicate",
    "unassigned",
    "empty-explanation",
    "extra-field",
    "uncertain",
    "excluded",
    "provider-failed",
    "truncated",
  ])(
    "does not turn an invalid, uncertain, or failed audit into approval: %s",
    async (mode) => {
      const state = await makeState();
      state.findings = [reminder()];
      useState(state);
      mocks.call.mockImplementation((prompt, parts) => {
        const content = validContent(prompt, parts);
        if (prompt !== NATIVE_PDF_AUDIT_PROMPT) return response(content);
        if (mode === "provider-failed")
          throw new LiteLLMError("private failure details");
        if (!("artifactReviews" in content))
          throw Error("Expected an audit response");
        const review = content.artifactReviews[0];
        if (mode === "missing")
          return response({ ...content, artifactReviews: [] });
        if (mode === "duplicate")
          return response({ ...content, artifactReviews: [review, review] });
        if (mode === "unassigned")
          return response({
            ...content,
            artifactReviews: [{ ...review, pageNumber: 2 }],
          });
        if (mode === "empty-explanation")
          return response({
            ...content,
            artifactReviews: [{ ...review, explanation: " " }],
          });
        if (mode === "extra-field")
          return response({
            ...content,
            artifactReviews: [{ ...review, approved: true }],
          });
        if (mode === "truncated")
          return { ...response(content), finishReason: "length" };
        return response({
          ...content,
          artifactReviews: [
            {
              ...review,
              decision:
                mode === "uncertain"
                  ? "uncertain"
                  : "meaningful-content-excluded",
            },
          ],
          findings: [missing()],
        });
      });
      const result = await run(state);
      expect(result.errors.map((error) => error.message)).toContain(
        reminder().message
      );
      expect(
        result.nativePdfChecks.artifactTextReview?.pages.some(
          (page) => page.reminderRetired
        )
      ).toBe(false);
      expect(result.nativePdfChecks.auditComplete).toBe(
        mode === "uncertain" || mode === "excluded"
      );
    }
  );

  it.each(["repair", "audit", "worker", "unlocated", "descendant-tag"])(
    "retains the reminder when content-loss evidence conflicts: %s",
    async (source) => {
      const state = await makeState();
      state.findings = [reminder()];
      if (source === "worker") state.findings.push(missing());
      if (source === "unlocated") {
        const finding: Partial<ReturnType<typeof missing>> = missing();
        delete finding.pageNumber;
        state.findings.push(finding as ReturnType<typeof missing>);
      }
      if (source === "descendant-tag") {
        const parent = {
          ...tag(1, 2),
          pageNumber: null,
          content: [],
          children: ["tag-1"],
        };
        state.inventory.tags.unshift(parent);
        state.inventory.tags[1].parentId = parent.id;
        state.findings.push({
          ...missing(),
          pageNumber: undefined,
          tagId: parent.id,
        });
      }
      useState(state);
      mocks.call.mockImplementation((prompt, parts) =>
        response({
          ...validContent(prompt, parts),
          findings:
            (source === "repair" && prompt !== NATIVE_PDF_AUDIT_PROMPT) ||
            (source === "audit" && prompt === NATIVE_PDF_AUDIT_PROMPT)
              ? [missing()]
              : [],
        })
      );
      const result = await run(state);
      expect(result.errors.map((error) => error.message)).toContain(
        reminder().message
      );
      expect(
        result.nativePdfChecks.artifactTextReview?.pages[0].reminderRetired
      ).toBe(false);
    }
  );

  it("keeps missing-content findings on their page while resolving another page's reminder", async () => {
    const state = await makeState(2);
    state.findings = [reminder(1), reminder(2)];
    useState(state);
    mocks.call.mockImplementation((prompt, parts) =>
      response({
        ...validContent(prompt, parts),
        findings: prompt === NATIVE_PDF_AUDIT_PROMPT ? [missing(2)] : [],
      })
    );
    const result = await run(state);
    expect(result.errors.map((error) => error.message)).not.toContain(
      reminder(1).message
    );
    expect(result.errors.map((error) => error.message)).toContain(
      reminder(2).message
    );
    expect(
      result.nativePdfChecks.artifactTextReview?.pages.map(
        (page) => page.reminderRetired
      )
    ).toEqual([true, false]);
  });

  it.each(["conflict", "failed", "unassigned-review"])(
    "requires every dense-page batch to finish without a content-loss conflict: %s",
    async (mode) => {
      const state = await makeState();
      state.inventory.tags = Array.from({ length: 201 }, (_, index) =>
        tag(1, index + 1)
      );
      state.findings = [reminder()];
      useState(state);
      mocks.call.mockImplementation((prompt, parts) => {
        const content = validContent(prompt, parts);
        if (
          prompt !== NATIVE_PDF_AUDIT_PROMPT ||
          scope(parts).pageReviewPages.length
        )
          return response(content);
        if (mode === "failed") throw new LiteLLMError("private batch failure");
        if (mode === "unassigned-review")
          return response({
            ...content,
            artifactReviews: [
              {
                pageNumber: 1,
                decision: "decorative-or-redundant",
                explanation: "Not this batch's page review.",
              },
            ],
          });
        return response({
          ...content,
          findings: [{ ...missing(), tagId: content.reviewedTagIds[0] }],
        });
      });
      const result = await run(state);
      expect(result.errors.map((error) => error.message)).toContain(
        reminder().message
      );
      expect(
        result.nativePdfChecks.artifactTextReview?.pages[0].reminderRetired
      ).toBe(false);
      expect(result.nativePdfChecks.auditComplete).toBe(mode === "conflict");
    }
  );
});

describe("native PDF orchestration", () => {
  it.each([false, true])(
    "retains an initial candidate-discovery limit once without reviving resolved defects (still limited: %s)",
    async (stillLimited) => {
      const prepared = await makeState();
      const limit = {
        code: "structure_candidates_limited",
        severity: "warning" as const,
        message:
          "Automatic heading, list and footnote suggestions could not be completed.",
      };
      prepared.findings = [
        limit,
        {
          code: "metadata-missing",
          severity: "error",
          message: "The original title was missing.",
        },
      ];
      const currentLimit = {
        ...limit,
        message:
          "Some structure repair suggestions exceeded the processing limit.",
      };
      const repaired = {
        ...prepared,
        findings: stillLimited ? [currentLimit] : [],
      };
      useState(prepared);
      mocks.worker
        .mockResolvedValueOnce(prepared)
        .mockResolvedValueOnce(repaired);
      const result = await repairNativePdf(prepared.pdf, "lecture.pdf");
      if ("error" in result) throw Error(result.error);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toMatchObject({
        severity: "warning",
        message: stillLimited ? currentLimit.message : limit.message,
      });
      expect(result.nativePdfChecks.auditComplete).toBe(true);
    }
  );

  it("supplies parallel existing and run-in heading context across tag batches without granting edit ownership", async () => {
    const state = await makeState(2);
    state.inventory.tags = Array.from({ length: 201 }, (_, index) =>
      tag(1, index + 1)
    );
    state.inventory.tags.push(tag(2, 202));
    const preceding = state.inventory.tags[197];
    preceding.role = preceding.snapshot.role = "H3";
    preceding.text = preceding.snapshot.text = "Student eligibility";
    const following = state.inventory.tags[200];
    following.role = following.snapshot.role = "H3";
    following.text = following.snapshot.text = "Staff eligibility";
    state.inventory.structureCandidates = [
      {
        candidateId: "e".repeat(64),
        kind: "split_heading",
        tagId: "tag-200",
        pageNumber: 1,
        text: "Visitor eligibility. Visitors qualify under these conditions.",
        preview:
          "Heading: Visitor eligibility.\nParagraph: Visitors qualify under these conditions.",
        relatedTagIds: [],
      },
      {
        candidateId: "f".repeat(64),
        kind: "split_heading",
        tagId: "tag-202",
        pageNumber: 2,
        text: "Volunteer eligibility. Volunteers qualify under these conditions.",
        preview:
          "Heading: Volunteer eligibility.\nParagraph: Volunteers qualify under these conditions.",
        relatedTagIds: [],
      },
    ];
    useState(state);
    const result = await repairNativePdf(state.pdf, "lecture.pdf");
    if ("error" in result) throw Error(result.error);
    const [prompt, parts] = mocks.call.mock.calls[0];
    const evidence = parts.find(
      (part: LiteLLMContentPart) => part.type === "text"
    ).text;
    const current = JSON.parse(evidence.split("\n")[1]);
    expect(current.assignedTagIds).toContain("tag-200");
    expect(current.assignedTagIds).not.toContain("tag-201");
    expect(current.structureCandidates).toHaveLength(1);
    expect(current.structureCandidates[0].headingContext.preceding).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tagId: "tag-198",
          currentRole: "H3",
          kind: "saved-heading",
          excerpt: "Student eligibility",
        }),
      ])
    );
    expect(current.structureCandidates[0].headingContext.following).toEqual([
      expect.objectContaining({
        tagId: "tag-201",
        currentRole: "H3",
        kind: "saved-heading",
      }),
      expect.objectContaining({
        tagId: "tag-202",
        kind: "possible-run-in-heading",
      }),
    ]);
    expect(prompt).toContain(
      "use set_role P on the separate number-only label when editable.role permits"
    );
    expect(prompt).toContain(
      "do not blindly inherit the nearest preceding heading's rank plus one"
    );
    expect(prompt).toContain(
      "Do not add separate edits on any primary or related tag of a selected structural candidate"
    );
  });

  it.each(["role", "split", "omitted", "invalid", "unchanged"] as const)(
    "reconciles a retained heading concern only with a verified change and complete current evidence: %s",
    async (mode) => {
      const prepared = await makeState();
      prepared.inventory.tags = [tag(1, 1), tag(1, 2), tag(1, 3)];
      prepared.inventory.tags[0].role =
        prepared.inventory.tags[0].snapshot.role = "H2";
      prepared.inventory.tags[1].role =
        prepared.inventory.tags[1].snapshot.role =
          mode === "split" ? "P" : "H4";
      prepared.inventory.tags[2].role =
        prepared.inventory.tags[2].snapshot.role = "H4";
      const candidateId = "c".repeat(64);
      prepared.inventory.structureCandidates = [
        {
          candidateId,
          kind: "split_heading",
          tagId: "tag-2",
          pageNumber: 1,
          text: prepared.inventory.tags[1].text,
          preview: "Heading: Existing section\nParagraph: Existing body",
          relatedTagIds: [],
        },
      ];
      const repaired = structuredClone(prepared) as NativePdfState;
      repaired.pdf = prepared.pdf;
      repaired.inventory.tags = prepared.inventory.tags.map((tag) =>
        structuredClone(tag)
      );
      if (mode === "split") {
        const original = repaired.inventory.tags[1];
        const heading = {
          ...structuredClone(original),
          id: "tag-4",
          sourceTagId: "tag-2",
          role: "H3",
        };
        heading.snapshot.role = "H3";
        original.sourceTagId = "tag-2";
        original.id = "tag-5";
        repaired.inventory.tags.splice(1, 1, heading, original);
        repaired.inventory.sourceTagLineage = {
          "tag-1": "tag-1",
          "tag-2": "tag-5",
          "tag-3": "tag-3",
        };
      } else if (mode !== "unchanged") {
        repaired.inventory.tags[1].role =
          repaired.inventory.tags[1].snapshot.role = "H3";
      }
      const machineMessage = "An original font still needs review.";
      repaired.findings = [
        { code: "font", severity: "error", message: machineMessage },
      ];
      useState(prepared);
      mocks.worker
        .mockResolvedValueOnce(prepared)
        .mockResolvedValueOnce(repaired);
      const headingMessage = "The section heading may be too deep.";
      const formMessage = "Check whether Acrobat announces this form field.";
      mocks.call.mockImplementation((prompt, parts) => {
        const content = validContent(prompt, parts);
        if (prompt !== NATIVE_PDF_AUDIT_PROMPT)
          return response({
            ...content,
            operations:
              mode === "unchanged"
                ? []
                : [
                    mode === "split"
                      ? {
                          type: "repair_structure",
                          tagId: "tag-2",
                          candidateId,
                          role: "H3",
                        }
                      : { type: "set_role", tagId: "tag-2", role: "H3" },
                  ],
            findings: [
              {
                code: "heading-structure",
                severity: "warning",
                pageNumber: 1,
                tagId: "tag-2",
                location: "Section heading",
                message: headingMessage,
                suggestion: "Check the heading relationship.",
              },
              {
                code: "form-interaction",
                severity: "warning",
                pageNumber: 1,
                location: "Name field",
                message: formMessage,
                suggestion: "Check announcements in Acrobat.",
              },
            ],
          });
        const [target] = scope(parts).repairFindingReviewTargets;
        expect(target).toMatchObject({
          tagId: mode === "split" ? "tag-4" : "tag-2",
          currentRole: mode === "unchanged" ? "H4" : "H3",
          eligibleForResolution: mode !== "unchanged",
        });
        return response({
          ...content,
          ...(mode === "omitted"
            ? {}
            : {
                repairFindingReviews: [
                  {
                    findingId: target.findingId,
                    decision: "resolved",
                    explanation:
                      "The saved section is directly below its H2 parent.",
                    currentTag: {
                      tagId: target.tagId,
                      role: mode === "invalid" ? "H5" : target.currentRole,
                    },
                  },
                ],
              }),
        });
      });
      const result = await repairNativePdf(prepared.pdf, "lecture.pdf");
      if ("error" in result) throw Error(result.error);
      const messages = result.errors.map((finding) => finding.message);
      expect(messages).toContain(machineMessage);
      expect(messages).toContain(formMessage);
      expect(messages.includes(headingMessage)).toBe(
        !["role", "split"].includes(mode)
      );
      expect(result.nativePdfChecks.auditComplete).toBe(
        !["invalid", "unchanged"].includes(mode)
      );
      const evidence = mocks.call.mock.calls[1][1].find(
        (part: LiteLLMContentPart) => part.type === "text"
      ).text;
      const current = JSON.parse(evidence.split("\n")[1]);
      expect(current.headingOutline[0]).toMatchObject({
        tagId: "tag-1",
        role: "H2",
        precedingLowerLevelHeadingId: null,
      });
      if (mode === "split") {
        const historical = JSON.parse(evidence.split("\n")[3]);
        expect(historical.tags.map((tag: NativePdfTag) => tag.id)).toEqual([
          "tag-1",
          "tag-2",
          "tag-3",
        ]);
        expect(current.outstandingRepairFindings[0].tagId).toBe("tag-5");
      }
    }
  );

  it("coalesces only an exact Note role already applied by a selected reference candidate", async () => {
    const state = await makeState();
    const candidateId = "d".repeat(64);
    state.inventory.structureCandidates = [
      {
        candidateId,
        kind: "mark_note_reference",
        tagId: "tag-1",
        pageNumber: 1,
        text: "An existing footnote marker",
        preview: "The existing note",
        relatedTagIds: ["tag-2"],
      },
    ];
    const expected = state.inventory.tags[0].snapshot;
    const reference = {
      type: "repair_structure" as const,
      tagId: "tag-1",
      candidateId,
      expected,
    };
    const redundant = {
      type: "set_role" as const,
      tagId: "tag-2",
      role: "Note",
      expected,
    };
    const unrelated = { ...redundant, tagId: "tag-3" };
    expect(
      coalesceNativePdfOperations([reference, redundant, unrelated], state)
    ).toEqual([reference, unrelated]);
    const conflicting = { ...redundant, role: "P" };
    expect(
      coalesceNativePdfOperations([reference, conflicting], state)
    ).toEqual([reference, conflicting]);
    expect(coalesceNativePdfOperations([redundant], state)).toEqual([
      redundant,
    ]);
  });

  it.each([
    "rebuild_table",
    "rebuild_grid_table",
    "move_callout",
    "describe_chart",
  ] as const)(
    "%s owns participant roles across model batches without dropping unrelated repairs",
    async (kind) => {
      const state = await makeState();
      const candidateId = "e".repeat(64);
      state.inventory.structureCandidates = [
        {
          candidateId,
          kind,
          tagId: "tag-1",
          pageNumber: 1,
          text: "Source",
          preview: "Verified relationship",
          relatedTagIds: ["tag-2"],
        },
      ];
      const expected = state.inventory.tags[0].snapshot;
      const atomic = {
        type: "repair_structure" as const,
        tagId: "tag-1",
        candidateId,
        expected,
        ...(kind === "describe_chart"
          ? { alt: "A verified chart description." }
          : {}),
      };
      const role = {
        type: "set_role" as const,
        tagId: "tag-2",
        role: "P",
        expected,
      };
      const unrelated = { ...role, tagId: "tag-3" };
      const otherType = {
        type: "set_alt" as const,
        tagId: "tag-2",
        alt: "Conflicting image edit",
        expected,
      };
      expect(
        coalesceNativePdfOperations([role, atomic, unrelated, otherType], state)
      ).toEqual([atomic, unrelated, otherType]);
      expect(coalesceNativePdfOperations([role, unrelated], state)).toEqual([
        role,
        unrelated,
      ]);
    }
  );

  it("preserves a compatible repair on a continuation candidate's read-only anchor", async () => {
    const state = await makeState();
    const candidateId = "f".repeat(64);
    state.inventory.structureCandidates = [
      {
        candidateId,
        kind: "move_page_continuation",
        tagId: "tag-2",
        pageNumber: 1,
        text: "Continuation",
        preview: "After the anchor",
        relatedTagIds: ["tag-1"],
        readonlyTagIds: ["tag-1"],
      },
    ];
    const expected = state.inventory.tags[0].snapshot;
    const continuation = {
      type: "repair_structure" as const,
      tagId: "tag-2",
      candidateId,
      expected,
    };
    const anchor = {
      type: "set_role" as const,
      tagId: "tag-1",
      role: "P",
      expected,
    };
    const conflicting = { ...anchor, tagId: "tag-2" };
    expect(
      coalesceNativePdfOperations([anchor, continuation, conflicting], state)
    ).toEqual([anchor, continuation]);
  });

  it("uses the immutable source and exact saved PDF, preserving all model-call costs and explicit review limits", async () => {
    const state = await makeState();
    useState(state);
    const transport = vi.fn();
    const result = await repairNativePdf(state.pdf, "lecture.pdf", {
      transport,
    });
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
      transport,
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

  it("carries an automatic link description through both model reviews and the saved change summary", async () => {
    const prepared = await makeState();
    const description = "W3C introduction to accessibility";
    prepared.inventory.tags[0].role = "Link";
    prepared.inventory.tags[0].snapshot.role = "Link";
    prepared.inventory.tags[0].contentSequence = [
      {
        kind: "objectReference",
        annotationId: "p1-a1",
        subtype: "Link",
        resolved: true,
        parentTreeVerified: true,
        description,
      },
    ];
    prepared.changes = [
      {
        code: "link_description_added",
        message: "Added the link's existing visible text as its description.",
        pageNumber: 1,
        tagId: "tag-1",
      },
    ];
    useState(prepared);
    mocks.worker
      .mockResolvedValueOnce(prepared)
      .mockResolvedValueOnce({ ...prepared, changes: [] });

    const result = await repairNativePdf(prepared.pdf, "lecture.pdf");
    if ("error" in result) throw Error(result.error);
    expect(mocks.call).toHaveBeenCalledTimes(2);
    for (const [, parts] of mocks.call.mock.calls) {
      expect(scope(parts).tags[0].contentSequence).toEqual(
        prepared.inventory.tags[0].contentSequence
      );
    }
    expect(result.changes).toContain(
      "Page 1: Added the link's existing visible text as its description."
    );
  });

  it("audits current machine evidence without carrying resolved diagnostics into historical comparison", async () => {
    const prepared = await makeState();
    prepared.inventory.title = "";
    prepared.inventory.forms = { fields: [{ name: "Course name" }] };
    prepared.inventory.form_content = [{ artifactText: "Repeated heading" }];
    prepared.findings = [
      {
        code: "metadata-missing",
        severity: "error",
        message: "The original PDF has no metadata container.",
      },
      {
        code: "display-title-missing",
        severity: "error",
        message: "The original PDF does not display its title.",
      },
    ];
    prepared.machineChecks.veraPdf.failedChecks = 3;
    prepared.machineChecks.veraPdf.failedRules = 3;
    const saved = await PDFDocument.load(prepared.pdf);
    saved.setTitle("Synthetic PDF transport test");
    saved.catalog.set(
      PDFName.of("ViewerPreferences"),
      saved.context.obj({ DisplayDocTitle: true })
    );
    saved.catalog.set(
      PDFName.of("Metadata"),
      saved.context.register(
        saved.context.stream(
          '<x:xmpmeta xmlns:x="adobe:ns:meta/">Saved title metadata</x:xmpmeta>',
          { Type: "Metadata", Subtype: "XML" }
        )
      )
    );
    const savedBytes = Buffer.from(await saved.save());
    const repaired: NativePdfState = {
      ...prepared,
      pdf: savedBytes,
      candidateSha256: pdfSha256(savedBytes),
      inventory: {
        ...prepared.inventory,
        title: "Synthetic PDF transport test",
      },
      findings: [
        {
          code: "ua-declaration-missing",
          severity: "warning",
          message: "A PDF/UA declaration has not been added.",
        },
      ],
      machineChecks: {
        ...prepared.machineChecks,
        veraPdf: {
          ...prepared.machineChecks.veraPdf,
          failedRules: 1,
          failedChecks: 1,
        },
      },
      changes: [
        { code: "title", message: "Added document title and viewer setting." },
      ],
    };
    useState(prepared);
    mocks.worker
      .mockResolvedValueOnce(prepared)
      .mockResolvedValueOnce(repaired);
    const result = await repairNativePdf(prepared.pdf, "lecture.pdf");
    if ("error" in result) throw Error(result.error);

    const repairParts = mocks.call.mock.calls[0][1] as LiteLLMContentPart[];
    expect(scope(repairParts)).toMatchObject({ findings: prepared.findings });
    const repairPrompt = mocks.call.mock.calls[0][0] as string;
    expect(repairPrompt).toContain(
      "with an existing or proposed title it sets the window to display that title and adds a missing XMP metadata container containing the title."
    );
    expect(repairPrompt).toContain(
      "It preserves an existing metadata container."
    );
    expect(repairPrompt).toContain(
      "The app independently reruns those checks on the saved output and displays all remaining failures."
    );
    expect(repairPrompt).toContain(
      "Do not copy machine findings into your findings array"
    );
    expect(repairPrompt).toContain(
      "Report additional semantic, ambiguous or unsupported concerns only."
    );
    expect(repairPrompt).toContain("Never add a PDF/UA declaration.");
    const auditParts = mocks.call.mock.calls[1][1] as LiteLLMContentPart[];
    const evidence = auditParts.find((p) => p.type === "text");
    if (!evidence || evidence.type !== "text") throw Error("Missing evidence");
    const lines = evidence.text.split("\n");
    const current = JSON.parse(lines[1]);
    const historical = JSON.parse(lines[3]);
    expect(current).toMatchObject({
      evidenceRole: "current-saved-pdf",
      candidateSha256: repaired.candidateSha256,
      title: "Synthetic PDF transport test",
      machineChecks: repaired.machineChecks,
      findings: repaired.findings,
    });
    expect(historical).toMatchObject({
      evidenceRole: "before-repair-comparison",
      title: "",
      tags: prepared.inventory.tags,
      forms: prepared.inventory.forms,
      nestedFormContent: prepared.inventory.form_content,
      excludedTextAndPageChecks: prepared.inventory.page_content,
    });
    expect(historical.hierarchy).toHaveLength(prepared.inventory.tags.length);
    for (const property of [
      "machineChecks",
      "findings",
      "outstandingRepairFindings",
    ])
      expect(historical).not.toHaveProperty(property);
    expect(evidence.text).not.toContain(prepared.findings[0].message);
    expect(evidence.text).not.toContain(prepared.findings[1].message);
    const auditPrompt = mocks.call.mock.calls[1][0] as string;
    expect(auditPrompt).toContain(
      "Only current-saved-pdf evidence establishes the delivered file's remaining machine defects."
    );
    expect(auditPrompt).toContain(
      "before-repair-comparison inventory is historical evidence"
    );
    expect(auditPrompt).toContain(
      "Never infer that the delivered PDF lacks those properties from an excerpt."
    );
    expect(auditPrompt).toContain(
      "a missing declaration alone does not imply those other properties are absent."
    );
    expect(auditPrompt).toContain(
      "Preserve actual current machine failures and unsupported-evidence findings"
    );

    // Copied pages really omit these catalog settings. Their absence must not
    // be interpreted as evidence about the intact PDF returned to the user.
    const file = auditParts.find(
      (p) => p.type === "file" && p.file.filename === "repaired-excerpt.pdf"
    );
    if (!file || file.type !== "file") throw Error("Missing output excerpt");
    const excerpt = await PDFDocument.load(
      Buffer.from(file.file.file_data!.split(",")[1], "base64")
    );
    expect(excerpt.catalog.has(PDFName.of("ViewerPreferences"))).toBe(false);
    expect(excerpt.catalog.has(PDFName.of("Metadata"))).toBe(false);
    expect(saved.catalog.has(PDFName.of("ViewerPreferences"))).toBe(true);
    expect(saved.catalog.has(PDFName.of("Metadata"))).toBe(true);
    expect(result.pdf).toEqual(savedBytes);
    expect(result.errors.map((f) => f.message)).toEqual([
      repaired.findings[0].message,
    ]);
  });

  it("keeps hybrid form evidence and interaction warnings when the auditor reports no additional issues", async () => {
    const state = await makeState();
    state.inventory.forms = {
      fields: [{ name: "Applicant name", alternativeName: "Full name" }],
      hybrid: {
        type: "static-xfa-with-acroform",
        xfaStructurePreserved: true,
        formLogicPreserved: true,
        nativeFieldDescriptionsAdded: 1,
        readerUsageRightsRemoved: true,
        interactiveViewerReviewRequired: true,
      },
    };
    state.findings = [
      {
        code: "legacy_form_interaction_review",
        severity: "warning",
        message:
          "Check that Acrobat announces the field labels and operates the checkbox choices correctly.",
      },
    ];
    state.changes = [
      {
        code: "hybrid-field-label-added",
        pageNumber: 1,
        message:
          "Copied the existing form description into the PDF field label.",
      },
    ];
    useState(state);
    const result = await repairNativePdf(state.pdf, "fillable-form.pdf");
    if ("error" in result) throw Error(result.error);

    for (const [prompt, parts] of mocks.call.mock.calls) {
      expect(scope(parts)).toMatchObject({
        forms: state.inventory.forms,
        findings: state.findings,
      });
      expect(prompt).toContain(
        "A native field label is not proof of what Acrobat announces"
      );
      expect(prompt).toContain("PDF excerpts may omit the form layer");
    }
    expect(result.errors).toEqual([
      expect.objectContaining({
        severity: "warning",
        message: state.findings[0].message,
      }),
    ]);
    expect(result.changes).toEqual([
      "Page 1: Copied the existing form description into the PDF field label.",
    ]);
    expect(result.nativePdfChecks).toMatchObject({
      auditComplete: true,
      screenReaderTestPerformed: false,
      conformanceClaim: false,
    });
    expect(result.pdf).toEqual(state.pdf);
  });

  it("reviews saved hybrid names and speech without reviving repaired labels or inferring required/signing barriers", async () => {
    const state = await makeState();
    const segmentName = "form[0].identifier[0].segment[1]";
    const currentLabel = "Membership number. Last 4 digits.";
    const requiredLabel = "Applicant name. An entry is required.";
    const fields = [
      {
        fieldId: "field-" + "1".repeat(64),
        name: "form[0].name[0]",
        type: "Tx",
        label: requiredLabel,
        required: false,
        value: "",
        pageNumbers: [1],
        widgets: [{ widgetId: "p1-a1", pageNumber: 1, rect: [10, 10, 80, 20] }],
        speech: {
          supported: true,
          text: requiredLabel,
          disabled: false,
          priority: "custom",
          source: "xfa-assist",
        },
      },
      {
        fieldId: "field-" + "2".repeat(64),
        name: segmentName,
        type: "Tx",
        label: currentLabel,
        required: false,
        value: "",
        pageNumbers: [1],
        widgets: [{ widgetId: "p1-a2", pageNumber: 1, rect: [10, 30, 80, 40] }],
        speech: {
          supported: true,
          text: currentLabel,
          disabled: false,
          priority: "custom",
          source: "xfa-assist",
        },
      },
      {
        fieldId: "field-" + "3".repeat(64),
        name: "form[0].special[0]",
        type: "Btn",
        label: "Special option",
        required: false,
        value: "Off",
        pageNumbers: [1],
        widgets: [{ widgetId: "p1-a3", pageNumber: 1, rect: [10, 50, 20, 60] }],
        speech: {
          supported: false,
          text: null,
          disabled: null,
          priority: null,
          source: "xfa-assist",
        },
      },
    ];
    state.inventory.forms = {
      field_count: fields.length,
      widget_count: fields.length,
      fields,
      hybrid: {
        type: "static-xfa-with-acroform",
        formLogicPreserved: true,
        interactiveViewerReviewRequired: true,
        verification: {
          accessibleNameChanges: [
            {
              fieldName: segmentName,
              oldText: "Last 4 digits.",
              newText: currentLabel,
            },
          ],
          speechPromptsEnabled: fields.slice(0, 2).map((field) => field.name),
        },
      },
    };
    const unresolved =
      "The special option's announcement still needs an interaction check.";
    state.findings = [
      {
        code: "legacy_form_interaction_review",
        severity: "warning",
        message: unresolved,
      },
    ];
    state.changes = [
      {
        code: "form_name_context_added",
        message: "Added the existing group name to a segment description.",
      },
      {
        code: "form_speech_enabled",
        message: "Enabled the existing direct field descriptions.",
      },
    ];
    useState(state);
    const result = await repairNativePdf(state.pdf, "fillable-form.pdf");
    if ("error" in result) throw Error(result.error);

    for (const [prompt, parts] of mocks.call.mock.calls) {
      expect(scope(parts)).toMatchObject({ forms: state.inventory.forms });
      expect(prompt).toContain(
        "Inspect the current field labels, speech settings and preparation records"
      );
      expect(prompt).toContain(
        "A required:false native flag alone is not a demonstrated accessibility defect"
      );
      expect(prompt).toContain(
        "The absence of a signature field, date field or dedicated cross-out control alone does not prove"
      );
      expect(prompt).toContain(
        "Actual keyboard and signing behavior requires interaction evidence"
      );
      expect(prompt).not.toContain("The XFA speech settings remain unchanged");
    }
    expect(mocks.call.mock.calls[1][0]).toContain(
      "Do not repeat the original short-label or disabled-speech concern"
    );
    expect(result.errors.map((finding) => finding.message)).toEqual([
      unresolved,
    ]);
    expect(result.nativePdfChecks).toMatchObject({
      auditComplete: true,
      screenReaderTestPerformed: false,
      conformanceClaim: false,
    });
    expect(result.changes).toEqual(
      state.changes.map((change) => change.message)
    );
  });

  it.each(["metadata-missing", "display-title-missing"])(
    "retains an actual saved %s failure even when the semantic audit finds no additional problem",
    async (code) => {
      const state = await makeState();
      state.findings = [
        { code, severity: "error", message: `Current saved defect: ${code}` },
      ];
      state.machineChecks.veraPdf.failedRules = 1;
      state.machineChecks.veraPdf.failedChecks = 1;
      useState(state);
      const result = await repairNativePdf(state.pdf, "lecture.pdf");
      if ("error" in result) throw Error(result.error);
      const auditParts = mocks.call.mock.calls[1][1] as LiteLLMContentPart[];
      expect(scope(auditParts)).toMatchObject({ findings: state.findings });
      expect(result.errors).toEqual([
        expect.objectContaining({
          severity: "error",
          message: `Current saved defect: ${code}`,
        }),
      ]);
      expect(result.nativePdfChecks).toMatchObject({
        auditComplete: true,
        conformanceClaim: false,
        veraPdf: { failedChecks: 1 },
      });
    }
  );

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

describe("source-bound excluded-text repair plans", () => {
  it("restores only the selected source scopes with verified roles", async () => {
    const state = await makeState();
    const candidateId = "a".repeat(64);
    const first = "b".repeat(64);
    const second = "c".repeat(64);
    state.inventory.structureCandidates = [
      {
        candidateId,
        kind: "restore_artifact_text",
        tagId: "tag-1",
        pageNumber: 1,
        text: "Existing footer",
        preview: "Heading and instructions before footer",
        relatedTagIds: [],
        textScopes: [
          { scopeId: first, text: "Appendix" },
          { scopeId: second, text: "Do NOT discard 19 items." },
        ],
      },
    ];
    const batch = nativePdfBatches(state)[0];
    const selections = [
      { scopeId: first, role: "H2" },
      { scopeId: second, role: "P" },
    ];
    const plan = {
      reviewedPages: [1],
      reviewedTagIds: ["tag-1"],
      operations: [
        { type: "repair_structure", tagId: "tag-1", candidateId, selections },
      ],
      findings: [],
    };
    expect(parseNativePdfPlan(plan, batch, state).operations).toEqual([
      { ...plan.operations[0], expected: state.inventory.tags[0].snapshot },
    ]);
    state.inventory.tags[0].editable.role = true;
    const withFooter = {
      ...plan,
      operations: [{ ...plan.operations[0], anchorRole: "P" }],
    };
    expect(
      parseNativePdfPlan(withFooter, batch, state).operations[0]
    ).toMatchObject({ anchorRole: "P" });
    state.inventory.tags[0].editable.role = false;
    expect(() => parseNativePdfPlan(withFooter, batch, state)).toThrow();
    expect(() =>
      parseNativePdfPlan(
        { ...plan, operations: [{ ...plan.operations[0], anchorRole: "H2" }] },
        batch,
        state
      )
    ).toThrow();
    for (const invalid of [
      [],
      [{ scopeId: "d".repeat(64), role: "P" }],
      [selections[0], selections[0]],
      [{ scopeId: first, role: "Script" }],
      [{ scopeId: first, role: "P", text: "Invented words" }],
    ]) {
      expect(() =>
        parseNativePdfPlan(
          {
            ...plan,
            operations: [{ ...plan.operations[0], selections: invalid }],
          },
          batch,
          state
        )
      ).toThrow();
    }
    expect(() =>
      parseNativePdfPlan(
        {
          ...plan,
          operations: [{ ...plan.operations[0], alt: "Replacement" }],
        },
        batch,
        state
      )
    ).toThrow();
  });
});
