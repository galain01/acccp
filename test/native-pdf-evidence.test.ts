import { beforeEach, expect, it, vi } from "vitest";
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
  getLiteLLMConfig: () => ({
    apiKey: "test-key",
    baseUrl: "https://unit.test",
    model: "test-model",
  }),
}));

import { repairNativePdf } from "../lib/native-pdf-convert";
import { pdfSha256 } from "../lib/native-pdf-worker";
import { NATIVE_PDF_AUDIT_PROMPT } from "../lib/prompts/native-pdf-accessibility";

function evidence(parts: LiteLLMContentPart[]) {
  const text = parts.find((part) => part.type === "text");
  if (!text || text.type !== "text") throw Error("Expected evidence text");
  return JSON.parse(text.text.split("\n")[1]);
}
async function denseState(): Promise<NativePdfState> {
  const document = await PDFDocument.create();
  document.addPage([100, 100]);
  const pdf = Buffer.from(await document.save());
  const tags: NativePdfTag[] = Array.from({ length: 302 }, (_, index) => {
    const id = `tag-${index + 1}`;
    const role = index === 0 ? "Document" : index === 1 ? "H1" : "P";
    const text = index === 0 ? "" : `Synthetic source paragraph ${index + 1}`;
    return {
      id,
      parentId: index === 0 ? null : "tag-1",
      children:
        index === 0
          ? Array.from({ length: 301 }, (_, i) => `tag-${i + 2}`)
          : [],
      role,
      pageNumber: 1,
      text,
      content: index === 0 ? [] : [{ pageNumber: 1, mcid: index }],
      contentSequence:
        index === 0
          ? []
          : [
              {
                kind: "markedContent",
                pageNumber: 1,
                mcid: index,
                resolved: true,
                parentTreeVerified: true,
                text,
              },
            ],
      editable: { role: false, alt: false, tableHeader: false },
      snapshot: { role, pageNumber: 1, text, mcids: [index], alt: null },
    };
  });
  return {
    schemaVersion: 1,
    sourceSha256: pdfSha256(pdf),
    candidateSha256: pdfSha256(pdf),
    pdf,
    pageCount: 1,
    inventory: {
      language: "en-US",
      title: "Synthetic dense form",
      tags,
      page_content: [
        {
          pageNumber: 1,
          mcids: Array.from({ length: 3000 }, (_, i) => i),
          ownership_required_mcids: Array.from({ length: 3000 }, (_, i) => i),
          occurrence_ids_by_mcid: Object.fromEntries(
            Array.from({ length: 3000 }, (_, i) => [
              String(i),
              [`p1-t${i * 2 + 1}`, `p1-t${i * 2 + 2}`],
            ])
          ),
          artifactText: "Do NOT omit this source direction.",
          artifactTextComplete: true,
          requiresVisualTextReview: false,
          customFutureCheck: {
            complete: false,
            reason: "Retain unknown checks",
          },
        },
      ],
      forms: {
        fields: [
          { fieldId: "field-a", label: "Synthetic name", pageNumbers: [1] },
          { fieldId: "field-b", label: "Synthetic choice", pageNumbers: [1] },
        ],
        hybrid: {
          verifiedMetadataOnly: true,
          verification: {
            passed: true,
            xfaScriptsBindingsAndDataUnchanged: true,
          },
        },
      },
      structureCandidates: [
        {
          candidateId: "candidate-1",
          kind: "join_interrupted_text",
          tagId: "tag-2",
          pageNumber: 1,
          text: "Synthetic source paragraph 2",
          preview: "Source-proven adjacent fragments",
          relatedTagIds: ["tag-3", "tag-301", "tag-302"],
        },
      ],
    },
    findings: [
      {
        code: "synthetic-unresolved-check",
        severity: "warning",
        pageNumber: 1,
        message: "Retain this unresolved machine finding.",
      },
    ],
    changes: [],
    machineChecks: {
      preservationPassed: true,
      pixelsIdentical: true,
      inspectionComplete: true,
      structurePassed: true,
      targetStandard: "PDF/UA-1",
      veraPdf: {
        completed: true,
        compliant: false,
        failedRules: 1,
        failedChecks: 1,
      },
      conformanceClaim: false,
    },
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.call.mockImplementation((prompt, parts) => {
    const scope = evidence(parts);
    return {
      content: JSON.stringify({
        reviewedPages: scope.assignedPages,
        reviewedTagIds: scope.assignedTagIds,
        ...(prompt === NATIVE_PDF_AUDIT_PROMPT
          ? {
              artifactReviews: scope.pageReviewPages.map(
                (pageNumber: number) => ({
                  pageNumber,
                  decision: "decorative-or-redundant",
                  explanation: "Synthetic artifact is repeated nearby.",
                })
              ),
              textReviews: scope.pageReviewPages.map((pageNumber: number) => ({
                pageNumber,
                decision: "matches-visible-text",
                explanation: "Synthetic visible wording matches.",
              })),
            }
          : { operations: [] }),
        findings: [],
      }),
      model: "test-model",
      promptTokens: 10,
      completionTokens: 10,
      responseCostUsd: 0.01,
      finishReason: "stop",
    };
  });
});

async function run(suppliedState?: NativePdfState) {
  const state = suppliedState ?? (await denseState());
  mocks.worker.mockResolvedValue(state);
  mocks.render.mockResolvedValue({
    pageCount: 1,
    pages: [
      {
        pageNumber: 1,
        width: 100,
        height: 100,
        png: Buffer.from("synthetic-png"),
        text: "Synthetic source paragraphs",
        imageAlternatives: { status: "complete", figures: [] },
      },
    ],
  });
  const result = await repairNativePdf(state.pdf, "synthetic.pdf");
  expect(result).not.toHaveProperty("error");
  return {
    state,
    scopes: mocks.call.mock.calls.map(([, parts]) => evidence(parts)),
  };
}

it("encodes the complete ordered hierarchy once as documented columns and tuples", async () => {
  const { state, scopes } = await run();
  for (const scope of scopes) {
    expect(scope.hierarchyColumns).toEqual([
      "id",
      "parentId",
      "role",
      "pageNumber",
      "headingText",
    ]);
    expect(scope.hierarchy).toEqual(
      state.inventory.tags.map((tag) => [
        tag.id,
        tag.parentId,
        tag.role,
        tag.pageNumber,
        /^H[1-6]?$/.test(tag.role) ? tag.text : null,
      ])
    );
    expect(JSON.stringify(scope.hierarchy).length).toBeLessThan(15_000);
  }
});

it("summarizes redundant native page indexes while retaining exclusions and exact assigned ownership", async () => {
  const { state, scopes } = await run();
  for (const scope of scopes) {
    const page = scope.excludedTextAndPageChecks[0];
    expect(page).not.toHaveProperty("mcids");
    expect(page).not.toHaveProperty("ownership_required_mcids");
    expect(page).not.toHaveProperty("occurrence_ids_by_mcid");
    expect(page).toMatchObject({
      artifactText: "Do NOT omit this source direction.",
      artifactTextComplete: true,
      requiresVisualTextReview: false,
      customFutureCheck: { complete: false, reason: "Retain unknown checks" },
      nativeContent: {
        markedScopeCount: 3000,
        ownershipRequiredScopeCount: 3000,
        textOccurrenceCount: 6000,
      },
    });
    const expected = state.inventory.tags
      .filter((tag) => scope.assignedTagIds.includes(tag.id))
      .flatMap((tag) => tag.content.map((content) => content.mcid));
    expect(page.nativeContent.assignedMarkedScopes).toEqual(expected);
    expect(page.nativeContent.assignedOwnershipRequiredScopes).toEqual(
      expected
    );
    expect(page.nativeContent.assignedTextOccurrenceCounts).toEqual(
      Object.fromEntries(expected.map((mcid) => [String(mcid), 2]))
    );
    expect(JSON.stringify(page).length).toBeLessThan(10_000);
  }
});

it("keeps all assigned tags, related source candidates, form labels, findings and page-wide review ownership", async () => {
  const { state, scopes } = await run();
  const repairScopes = scopes.slice(0, 2);
  for (const scope of scopes) {
    expect(scope.tags).toEqual(
      state.inventory.tags
        .filter((tag) => scope.assignedTagIds.includes(tag.id))
        .map((tag) =>
          Object.fromEntries(
            Object.entries(tag).filter(
              ([key]) => !["snapshot", "content"].includes(key)
            )
          )
        )
    );
    expect(scope.forms).toEqual(state.inventory.forms);
    expect(scope.findings).toEqual(state.findings);
    expect(scope.machineChecks).toEqual(state.machineChecks);
    expect(scope.priorMatchingInteractionTests).toBeNull();
    expect(scope.headingOutline[0]).toMatchObject({
      tagId: "tag-2",
      role: "H1",
    });
  }
  expect(repairScopes.flatMap((scope) => scope.assignedTagIds)).toEqual(
    state.inventory.tags.map((tag) => tag.id)
  );
  expect(repairScopes.flatMap((scope) => scope.pageReviewPages)).toEqual([1]);
  expect(repairScopes[0].structureCandidates).toEqual(
    state.inventory.structureCandidates
  );
  expect(repairScopes[0].relatedTagContext).toEqual(
    state.inventory.tags
      .slice(-2)
      .map((tag) =>
        Object.fromEntries(
          Object.entries(tag).filter(
            ([key]) => !["snapshot", "content"].includes(key)
          )
        )
      )
  );
});

it("omits writer-only snapshots and duplicate content from both assigned and related tags without losing semantic facts", async () => {
  const state = await denseState();
  for (const tag of state.inventory.tags) {
    tag.attributes = [
      { owner: "Table", scope: "Column", headers: ["header-a"] },
    ];
    tag.nativeIdHex = `a${tag.id}`;
    tag.effectiveLanguage = "en-US";
  }
  const original = structuredClone(state.inventory);
  const { scopes } = await run(state);
  for (const scope of scopes) {
    for (const tag of [...scope.tags, ...scope.relatedTagContext]) {
      const source = state.inventory.tags.find((item) => item.id === tag.id)!;
      expect(tag).not.toHaveProperty("snapshot");
      expect(tag).not.toHaveProperty("content");
      const facts = Object.fromEntries(
        Object.entries(source).filter(
          ([key]) => !["snapshot", "content"].includes(key)
        )
      );
      expect(tag).toEqual(facts);
    }
    expect(
      scope.relatedTagContext.every(
        (tag: NativePdfTag) => !scope.assignedTagIds.includes(tag.id)
      )
    ).toBe(true);
  }
  expect(state.inventory).toEqual(original);
});

it("retains nonduplicated native content evidence and builds operation preconditions from the untouched internal snapshot", async () => {
  const state = await denseState();
  state.inventory.tags[2].editable.role = true;
  state.inventory.tags[3].content[0].unrepresentedEvidence =
    "Keep this source association";
  const original = structuredClone(state.inventory);
  const defaultReply = mocks.call.getMockImplementation()!;
  mocks.call.mockImplementation((prompt, parts) => {
    const result = defaultReply(prompt, parts);
    const scope = evidence(parts);
    if (
      prompt !== NATIVE_PDF_AUDIT_PROMPT &&
      scope.assignedTagIds.includes("tag-3")
    ) {
      const content = JSON.parse(result.content);
      content.operations = [{ type: "set_role", tagId: "tag-3", role: "H2" }];
      return { ...result, content: JSON.stringify(content) };
    }
    return result;
  });
  const { scopes } = await run(state);
  for (const scope of scopes) {
    const incomplete = scope.tags.find(
      (tag: NativePdfTag) => tag.id === "tag-4"
    );
    if (incomplete)
      expect(incomplete.content).toEqual(state.inventory.tags[3].content);
  }
  const writeRequest = mocks.worker.mock.calls.find(
    ([mode]) => mode === "repair"
  )!;
  expect(writeRequest[4].operations).toEqual([
    {
      type: "set_role",
      tagId: "tag-3",
      role: "H2",
      expected: state.inventory.tags[2].snapshot,
    },
  ]);
  expect(writeRequest[4].operations[0].expected).toBe(
    state.inventory.tags[2].snapshot
  );
  expect(state.inventory).toEqual(original);
});
