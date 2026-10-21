import { beforeEach, describe, expect, it, vi } from "vitest";
import { createCanvas } from "@napi-rs/canvas";
import type {
  DocxInspection,
  DocxRepairPlan,
  DocxChange,
} from "../lib/docx-types";
import type { RenderedPdf } from "../lib/pdf-rendering";
import type { LiteLLMContentPart } from "../lib/litellm";

vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({
  inspect: vi.fn(),
  apply: vi.fn(),
  check: vi.fn(),
  render: vi.fn(),
  pages: vi.fn(),
  call: vi.fn(),
}));
vi.mock("../lib/docx-package", async (original) => ({
  ...(await original<typeof import("../lib/docx-package")>()),
  inspectDocx: mocks.inspect,
  applyDocxRepairs: mocks.apply,
  checkDocxAccessibility: mocks.check,
}));
vi.mock("../lib/word-to-pdf", async (original) => ({
  ...(await original<typeof import("../lib/word-to-pdf")>()),
  renderWordToPdf: mocks.render,
}));
vi.mock("../lib/pdf-rendering", async (original) => ({
  ...(await original<typeof import("../lib/pdf-rendering")>()),
  renderPdfPages: mocks.pages,
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
  completeWordPlan,
  parseWordFindings,
  repairWord,
  sameWordLayout,
  wordObjectPages,
  mergeWordFindings,
  describeWordChange,
  remapWordFindings,
  unresolvedWordProposals,
} from "../lib/word-convert";
import { LiteLLMError } from "../lib/litellm";
import { WORD_AUDIT_PROMPT } from "../lib/prompts/word-accessibility";

const input = Buffer.from("PK\x03\x04original-docx");
const output = Buffer.from("PK\x03\x04repaired-docx");
const paragraph = (
  index: number,
  text = `Section ${index} unique teaching content`
) => ({
  id: `word/document.xml:p:${index}`,
  partName: "word/document.xml",
  index,
  location: `Paragraph ${index}`,
  text,
  styleId: null,
  styleName: null,
  headingLevel: 1,
  language: "en-US",
  inTable: false,
  editable: true,
  formatting: { bold: false, fontSizePt: 12 },
});
const source: DocxInspection = {
  paragraphs: [paragraph(1)],
  tables: [],
  images: [],
  findings: [],
};
function png(color = "white") {
  const canvas = createCanvas(4, 4);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, 4, 4);
  return canvas.toBuffer("image/png");
}
function pages(count = 1, color = "white"): RenderedPdf {
  return {
    pageCount: count,
    pages: Array.from({ length: count }, (_, index) => ({
      pageNumber: index + 1,
      width: 4,
      height: 4,
      png: png(color),
      text: paragraph(index + 1).text,
      imageAlternatives: { status: "complete" as const, figures: [] },
    })),
  };
}
function planFor(inspection: DocxInspection): DocxRepairPlan {
  return {
    reviewedParagraphIds: inspection.paragraphs.map((p) => p.id),
    reviewedTableIds: inspection.tables.map((t) => t.id),
    reviewedImageIds: inspection.images.map((i) => i.id),
    operations: [],
  };
}
function response(content: unknown, model = "test-model") {
  return {
    content: JSON.stringify(content),
    model,
    promptTokens: 100,
    completionTokens: 50,
    responseCostUsd: 0.01,
    finishReason: "stop",
  };
}
function assigned(parts: LiteLLMContentPart[]) {
  const text = parts.find((part) => part.type === "text")!;
  if (text.type !== "text") throw Error();
  return {
    pages: JSON.parse(
      text.text.match(/Assigned pages: (\[[^\n]+\])\./)![1]
    ) as number[],
    inspection: JSON.parse(
      text.text.match(
        /Assigned native objects \(untrusted source data\):\n([^\n]+)/
      )![1]
    ) as DocxInspection,
  };
}
function goodCall(prompt: string, parts: LiteLLMContentPart[]) {
  const scope = assigned(parts);
  const plan = planFor(scope.inspection);
  return response(
    prompt === WORD_AUDIT_PROMPT
      ? {
          reviewedPages: scope.pages,
          reviewedParagraphIds: plan.reviewedParagraphIds,
          reviewedTableIds: plan.reviewedTableIds,
          reviewedImageIds: plan.reviewedImageIds,
          findings: [],
        }
      : { ...plan, findings: [] },
    prompt === WORD_AUDIT_PROMPT ? "audit-model" : "repair-model"
  );
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.inspect.mockResolvedValue(source);
  mocks.check.mockReturnValue([]);
  mocks.apply.mockResolvedValue({
    buffer: output,
    inspection: source,
    changes: [
      {
        type: "setHeading",
        id: source.paragraphs[0].id,
        location: "Paragraph 1",
        message: "Identified the existing heading.",
        before: "No heading",
        after: "1",
      },
    ],
    findings: [],
  });
  mocks.render.mockResolvedValue(Buffer.from("%PDF-test"));
  mocks.pages.mockResolvedValue(pages());
  mocks.call.mockImplementation(goodCall);
});

describe("native Word repair and independent audit", () => {
  it("keeps a verified native list when a separate table repair cannot preserve its layout", async () => {
    const paragraphs = [
      paragraph(1, "• First item"),
      paragraph(2, "• Second item"),
      { ...paragraph(3, "Parent Other"), inTable: true },
      { ...paragraph(4, "First Second"), inTable: true },
    ];
    const table = {
      id: "word/document.xml:t:1",
      partName: "word/document.xml",
      index: 1,
      location: "Table 1",
      cells: [
        ["Parent", "Other"],
        ["First", "Second"],
        ["15", "85"],
      ],
      firstRowHeader: false,
      complex: true,
      editable: false,
      headerCandidate: {
        headerRows: 2 as const,
        labels: ["Parent First", "Other Second"],
        sourceCells: [
          ["Parent", "Other"],
          ["First", "Second"],
          ["15", "85"],
        ],
        headerParagraphIds: [paragraphs[2].id, paragraphs[3].id],
        gridWidthsTwips: [2000, 2000],
        headerHeightsTwips: [null, null],
        indentTwips: null,
        alignment: null,
      },
    };
    const original: DocxInspection = {
      ...source,
      paragraphs,
      tables: [table],
      listCandidates: [
        {
          id: paragraphs[0].id,
          paragraphIds: paragraphs.slice(0, 2).map((p) => p.id),
          sourceTexts: paragraphs.slice(0, 2).map((p) => p.text),
          prefixes: ["• ", "• "],
          kind: "bullet",
          marker: "•",
          start: null,
        },
      ],
    };
    const actual: DocxInspection = {
      ...original,
      paragraphs: paragraphs.map((p, i) =>
        i < 2
          ? {
              ...p,
              text: p.text.slice(2),
              list: { numId: "1", level: 0, format: "bullet", markerText: "•" },
            }
          : p
      ),
      listCandidates: [],
    };
    const listChange: DocxChange = {
      type: "convertTypedList",
      id: paragraphs[0].id,
      paragraphIds: paragraphs.slice(0, 2).map((p) => p.id),
      location: "Paragraph 1",
      message: "Converted list.",
      before: "Typed list",
      after: "Native list",
    };
    const tableChange: DocxChange = {
      type: "simplifyTableHeaders",
      id: table.id,
      paragraphIds: table.headerCandidate.headerParagraphIds,
      location: table.location,
      message: "Combined headers.",
      before: "Merged headers",
      after: "Individual labels",
    };
    mocks.inspect.mockResolvedValueOnce(original).mockResolvedValue(actual);
    mocks.apply
      .mockResolvedValueOnce({
        buffer: Buffer.from("PK\x03\x04unverified"),
        inspection: {
          ...actual,
          tables: [
            {
              ...table,
              complex: false,
              firstRowHeader: true,
              cells: [table.headerCandidate.labels, table.cells[2]],
            },
          ],
        },
        findings: [],
        changes: [listChange, tableChange],
      })
      .mockResolvedValue({
        buffer: output,
        inspection: actual,
        findings: [],
        changes: [listChange],
      });
    const evidence = pages();
    evidence.pages[0].text = paragraphs.map((p) => p.text).join("\n");
    mocks.pages.mockResolvedValue(evidence);
    mocks.call.mockImplementation((prompt, parts) => {
      const value = JSON.parse(goodCall(prompt, parts).content);
      if (prompt !== WORD_AUDIT_PROMPT)
        value.operations = [
          {
            type: "convertTypedList",
            id: paragraphs[0].id,
            items: paragraphs
              .slice(0, 2)
              .map((p) => ({ paragraphId: p.id, sourceText: p.text })),
          },
          {
            type: "simplifyTableHeaders",
            id: table.id,
            sourceCells: table.cells,
          },
        ];
      return response(value);
    });
    const result = await repairWord(input, "course.docx");
    if ("error" in result) throw Error(result.error);
    expect(mocks.apply).toHaveBeenCalledTimes(2);
    expect(
      mocks.apply.mock.calls[1][1].operations.map(
        (op: { type: string }) => op.type
      )
    ).toEqual(["convertTypedList"]);
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]).toContain("native Word list");
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message).toContain("undone");
  });
  it("keeps an entire candidate list together across the normal eighth-page boundary", async () => {
    const inspection: DocxInspection = {
      ...source,
      paragraphs: Array.from({ length: 9 }, (_, i) => paragraph(i + 1)),
      listCandidates: [
        {
          id: paragraph(8).id,
          paragraphIds: [paragraph(8).id, paragraph(9).id],
          sourceTexts: [paragraph(8).text, paragraph(9).text],
          prefixes: ["", ""],
          kind: "bullet",
          marker: "•",
          start: null,
        },
      ],
    };
    mocks.inspect.mockResolvedValue(inspection);
    mocks.pages.mockResolvedValue(pages(9));
    mocks.apply.mockResolvedValue({
      buffer: output,
      inspection,
      findings: [],
      changes: [],
    });
    const result = await repairWord(input, "course.docx");
    expect(result).toHaveProperty("docx");
    const requests = mocks.call.mock.calls
      .filter(([prompt]) => prompt !== WORD_AUDIT_PROMPT)
      .map(([, parts]) => assigned(parts));
    expect(requests.map((r) => r.pages)).toEqual([
      [1, 2, 3, 4, 5, 6, 7],
      [8, 9],
    ]);
    expect(requests[0].inspection.listCandidates).toEqual([]);
    expect(requests[1].inspection.listCandidates?.[0].paragraphIds).toEqual([
      paragraph(8).id,
      paragraph(9).id,
    ]);
  });
  it("requires the full exact candidate and all affected IDs before accepting a typed-list plan", () => {
    const first = { ...paragraph(1), text: "• First" };
    const second = { ...paragraph(2), text: "• Second" };
    const inspection: DocxInspection = {
      ...source,
      paragraphs: [first, second],
      listCandidates: [
        {
          id: first.id,
          paragraphIds: [first.id, second.id],
          sourceTexts: [first.text, second.text],
          prefixes: ["• ", "• "],
          kind: "bullet",
          marker: "•",
          start: null,
        },
      ],
    };
    const plan: DocxRepairPlan = {
      ...planFor(inspection),
      operations: [
        {
          type: "convertTypedList",
          id: first.id,
          items: inspection.paragraphs.map((p) => ({
            paragraphId: p.id,
            sourceText: p.text,
          })),
        },
      ],
    };
    expect(completeWordPlan(plan, inspection)).toBe(true);
    const reordered = structuredClone(plan);
    if (reordered.operations[0].type !== "convertTypedList") throw Error();
    reordered.operations[0].items = reordered.operations[0].items.map(
      ({ paragraphId, sourceText }) => ({ sourceText, paragraphId })
    );
    expect(completeWordPlan(reordered, inspection)).toBe(true);
    const partial = structuredClone(plan);
    if (partial.operations[0].type !== "convertTypedList") throw Error();
    partial.operations[0].items.pop();
    expect(completeWordPlan(partial, inspection)).toBe(false);
    expect(
      completeWordPlan(
        { ...plan, reviewedParagraphIds: [first.id] },
        { ...inspection, paragraphs: [first] }
      )
    ).toBe(false);
  });
  it("uses output identities, recomputed locations and source identity pairs in the independent audit", async () => {
    const original: DocxInspection = {
      ...source,
      paragraphs: [
        paragraph(1, "Removed header"),
        paragraph(2, "Bonjour classe"),
      ],
    };
    const actual: DocxInspection = {
      ...source,
      paragraphs: [paragraph(1, "Bonjour classe")],
    };
    const repaired = {
      buffer: output,
      inspection: actual,
      findings: [],
      changes: [],
      identityMap: {
        [paragraph(1).id]: null,
        [paragraph(2).id]: paragraph(1).id,
      },
    };
    mocks.inspect.mockResolvedValueOnce(original).mockResolvedValue(actual);
    mocks.apply.mockResolvedValue(repaired);
    const evidence = pages();
    evidence.pages[0].text = "Removed header\nBonjour classe";
    mocks.pages.mockResolvedValue(evidence);
    mocks.call.mockImplementation((prompt, parts) => {
      if (prompt !== WORD_AUDIT_PROMPT) return goodCall(prompt, parts);
      const text = parts.find(
        (p: LiteLLMContentPart) => p.type === "text"
      ).text;
      expect(text).toContain(
        `"sourceId":"${paragraph(2).id}","outputId":"${paragraph(1).id}"`
      );
      expect(assigned(parts).inspection.paragraphs.map((p) => p.id)).toEqual([
        paragraph(1).id,
      ]);
      const value = JSON.parse(goodCall(prompt, parts).content);
      value.findings = [
        {
          code: "language",
          severity: "warning",
          objectId: paragraph(1).id,
          pageNumber: 1,
          location: "Paragraph 1",
          message: "Check pronunciation.",
          suggestion: "Check the French text in Word.",
        },
      ];
      return response(value);
    });
    const result = await repairWord(input, "course.docx");
    if ("error" in result) throw Error(result.error);
    expect(result.errors[0].location).toMatchObject({
      sourcePages: [1],
      quote: "Bonjour classe",
    });
  });
  it("clears only verified and audited pre-repair issues while preserving distinct or unaudited concerns", () => {
    const p = paragraph(1, "• Read");
    const original: DocxInspection = { ...source, paragraphs: [p] };
    const native = {
      ...p,
      text: "Read",
      list: { numId: "1", level: 0, format: "bullet", markerText: "•" },
    };
    const repaired = {
      buffer: output,
      inspection: { ...original, paragraphs: [native] },
      findings: [],
      changes: [
        {
          type: "convertTypedList" as const,
          id: p.id,
          paragraphIds: [p.id],
          location: p.location,
          message: "Native list",
          before: p.text,
          after: "Native list",
        },
      ],
    };
    const findings = [
      {
        code: "list-structure",
        severity: "warning" as const,
        objectId: p.id,
        location: p.location,
        message: "Make a list.",
        suggestion: "Use Word numbering.",
      },
      {
        code: "contrast",
        severity: "warning" as const,
        objectId: p.id,
        location: p.location,
        message: "Check color.",
        suggestion: "Choose darker text.",
      },
    ];
    expect(
      unresolvedWordProposals(
        findings,
        original,
        repaired,
        new Set([p.id])
      ).map((f) => f.code)
    ).toEqual(["contrast"]);
    expect(
      unresolvedWordProposals(findings, original, repaired, new Set())
    ).toHaveLength(2);
    expect(
      unresolvedWordProposals(
        findings,
        original,
        { ...repaired, changes: [] },
        new Set([p.id])
      )
    ).toHaveLength(2);
    const mapped = remapWordFindings(findings, original, {
      ...repaired,
      inspection: { ...original, paragraphs: [{ ...native, id: "saved-p" }] },
      identityMap: { [p.id]: "saved-p" },
    });
    expect(mapped.every((f) => f.objectId === "saved-p")).toBe(true);
    expect(
      mergeWordFindings(
        unresolvedWordProposals(findings, original, repaired, new Set([p.id])),
        [findings[0]]
      ).map((f) => f.code)
    ).toEqual(["contrast", "list-structure"]);
  });
  it("checks the source first, reopens actual output and audits source/output page images", async () => {
    const result = await repairWord(input, "course.docx");
    expect(result).toMatchObject({
      docx: output,
      pageCount: 1,
      tokensUsed: 300,
      errors: [],
      model: "repair-model, audit-model",
    });
    if ("error" in result) throw Error();
    expect(result.changes[0]).toContain(`“${paragraph(1).text}”`);
    expect(result.changes[0]).toContain("level 1 heading");
    expect(result.calls.map((call) => [call.stage, call.costUsd])).toEqual([
      ["convert", 0.01],
      ["validate", 0.01],
    ]);
    expect(mocks.check).toHaveBeenCalledTimes(2);
    expect(mocks.check.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.call.mock.invocationCallOrder[0]
    );
    expect(mocks.inspect).toHaveBeenLastCalledWith(output, { generated: true });
    expect(mocks.render.mock.calls.map((call) => call[0])).toEqual([
      input,
      output,
    ]);
    expect(
      (mocks.call.mock.calls[1][1] as LiteLLMContentPart[]).filter(
        (part) => part.type === "image_url"
      )
    ).toHaveLength(2);
  });
  it("uses an injected local renderer with bounded timeouts", async () => {
    const renderer = vi.fn().mockResolvedValue(Buffer.from("%PDF-local"));
    const result = await repairWord(input, "course.docx", {
      renderWord: renderer,
    });
    expect(result).toHaveProperty("docx");
    expect(mocks.render).not.toHaveBeenCalled();
    expect(renderer).toHaveBeenCalledTimes(2);
    expect(
      renderer.mock.calls.every((call) => call[1] > 0 && call[1] <= 60_000)
    ).toBe(true);
  });
  it("covers all 59 pages in eight bounded repair and eight audit batches without downsampling", async () => {
    const inspection: DocxInspection = {
      ...source,
      paragraphs: Array.from({ length: 59 }, (_, i) => paragraph(i + 1)),
    };
    const rendered = pages(59);
    mocks.inspect.mockResolvedValue(inspection);
    mocks.pages.mockResolvedValue(rendered);
    mocks.apply.mockResolvedValue({
      buffer: output,
      inspection,
      changes: [],
      findings: [],
    });
    const result = await repairWord(input, "course.docx");
    expect(result).toMatchObject({
      pageCount: 59,
      tokensUsed: 2400,
      errors: [],
    });
    expect(mocks.call).toHaveBeenCalledTimes(16);
    const conversion = mocks.call.mock.calls.filter(
      ([prompt]) => prompt !== WORD_AUDIT_PROMPT
    );
    const audits = mocks.call.mock.calls.filter(
      ([prompt]) => prompt === WORD_AUDIT_PROMPT
    );
    expect(conversion.flatMap(([, parts]) => assigned(parts).pages)).toEqual(
      Array.from({ length: 59 }, (_, i) => i + 1)
    );
    expect(
      audits.flatMap(([, parts]) =>
        assigned(parts).inspection.paragraphs.map((p) => p.id)
      )
    ).toEqual(inspection.paragraphs.map((p) => p.id));
    expect(
      conversion.every(
        ([, parts]) =>
          parts.filter((p: LiteLLMContentPart) => p.type === "image_url")
            .length <= 8
      )
    ).toBe(true);
    expect(
      audits.every(
        ([, parts]) =>
          parts.filter((p: LiteLLMContentPart) => p.type === "image_url")
            .length <= 16
      )
    ).toBe(true);
    expect(
      conversion[0][1].find((p: LiteLLMContentPart) => p.type === "image_url")
        .image_url.url
    ).toBe(`data:image/png;base64,${rendered.pages[0].png.toString("base64")}`);
  });
  it("retains incurred cost when repair coverage is incomplete", async () => {
    mocks.call.mockResolvedValueOnce(
      response({ ...planFor(source), reviewedParagraphIds: [], findings: [] })
    );
    const result = await repairWord(input, "course.docx");
    expect(result).toMatchObject({
      diagnostic: { stage: "docx_repair", code: "docx_invalid_plan" },
      calls: [{ stage: "convert", costUsd: 0.01 }],
    });
    expect(mocks.apply).not.toHaveBeenCalled();
  });
  it.each(["length", "content_filter"])(
    "rejects truncated/refused %s repair output while accounting its usage",
    async (finishReason) => {
      mocks.call.mockResolvedValueOnce({
        ...response({ ...planFor(source), findings: [] }),
        finishReason,
      });
      const result = await repairWord(input, "course.docx");
      expect(result).toHaveProperty("error");
      expect(result.calls).toHaveLength(1);
      expect(mocks.apply).not.toHaveBeenCalled();
    }
  );
  it("retains machine defects when the auditor reports no findings", async () => {
    mocks.check.mockReturnValue([
      {
        code: "missing-table-header",
        severity: "error",
        objectId: source.paragraphs[0].id,
        location: "Paragraph 1",
        message: "Saved defect remains.",
        suggestion: "Fix this in Word.",
      },
    ]);
    const result = await repairWord(input, "course.docx");
    expect(result).toMatchObject({
      errors: [{ severity: "error", message: "Saved defect remains." }],
    });
  });
  it("keeps a visible incomplete-review warning and cost for malformed audit coverage", async () => {
    mocks.call.mockImplementation((prompt, parts) =>
      prompt === WORD_AUDIT_PROMPT
        ? response({ reviewedPages: [], ...planFor(source), findings: [] })
        : goodCall(prompt, parts)
    );
    const result = await repairWord(input, "course.docx");
    expect(result).toHaveProperty("docx");
    if ("error" in result) throw Error();
    expect(
      result.errors.some((f) => f.message.includes("review did not finish"))
    ).toBe(true);
    expect(result.calls).toHaveLength(2);
  });
  it("retains successfully audited batches when another audit request fails", async () => {
    const inspection = {
      ...source,
      paragraphs: Array.from({ length: 9 }, (_, i) => paragraph(i + 1)),
    };
    mocks.inspect.mockResolvedValue(inspection);
    mocks.pages.mockResolvedValue(pages(9));
    mocks.apply.mockResolvedValue({
      buffer: output,
      inspection,
      findings: [],
      changes: [],
    });
    mocks.call.mockImplementation((prompt, parts) => {
      const batch = assigned(parts);
      if (prompt === WORD_AUDIT_PROMPT && batch.pages[0] === 1)
        throw new LiteLLMError("private provider details");
      const value = goodCall(prompt, parts);
      if (prompt === WORD_AUDIT_PROMPT) {
        const data = JSON.parse(value.content);
        data.findings = [
          {
            code: "heading-hierarchy",
            severity: "warning",
            objectId: paragraph(9).id,
            location: "Paragraph 9",
            message: "Review the final section meaning.",
            suggestion: "Confirm its heading relationship.",
          },
        ];
        value.content = JSON.stringify(data);
      }
      return value;
    });
    const result = await repairWord(input, "course.docx");
    if ("error" in result) throw Error();
    expect(result.errors.map((f) => f.message)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("review did not finish"),
        "Review the final section meaning.",
      ])
    );
    expect(result.calls).toHaveLength(3);
    expect(JSON.stringify(result)).not.toContain("private provider details");
  });
  it("rolls back layout-changing operations and audits the actual fallback file", async () => {
    mocks.call.mockImplementation((prompt, parts) => {
      const value = goodCall(prompt, parts);
      if (prompt !== WORD_AUDIT_PROMPT) {
        const data = JSON.parse(value.content);
        data.operations = [
          {
            type: "setHeading",
            id: paragraph(1).id,
            level: 1,
            sourceText: paragraph(1).text,
          },
        ];
        value.content = JSON.stringify(data);
      }
      return value;
    });
    mocks.pages
      .mockResolvedValueOnce(pages())
      .mockResolvedValueOnce(pages(1, "red"))
      .mockResolvedValueOnce(pages());
    mocks.apply
      .mockResolvedValueOnce({
        buffer: output,
        inspection: source,
        changes: [
          {
            id: paragraph(1).id,
            message: "Changed heading.",
            location: "Paragraph 1",
          },
        ],
        findings: [],
      })
      .mockResolvedValueOnce({
        buffer: input,
        inspection: source,
        changes: [],
        findings: [],
      });
    const result = await repairWord(input, "course.docx");
    expect(result).toMatchObject({ docx: input, changes: [] });
    if ("error" in result) throw Error();
    expect(
      result.errors.some((f) => f.message.includes("repair was undone"))
    ).toBe(true);
    expect(mocks.inspect).toHaveBeenLastCalledWith(input, { generated: true });
    expect(mocks.apply.mock.calls[1][1].operations).toEqual([]);
  });
  it("preserves source bytes when even metadata-only output changes the rendering", async () => {
    mocks.pages
      .mockResolvedValueOnce(pages())
      .mockResolvedValueOnce(pages(1, "red"))
      .mockResolvedValueOnce(pages(1, "blue"));
    const result = await repairWord(input, "course.docx");
    expect(result).toMatchObject({ docx: input, changes: [] });
    if ("error" in result) throw Error();
    expect(
      result.errors.some((f) =>
        f.message.includes("preserved the original file")
      )
    ).toBe(true);
  });

  it("preserves and audits the source if candidate rendering cannot complete", async () => {
    mocks.render
      .mockResolvedValueOnce(Buffer.from("%PDF-source"))
      .mockRejectedValueOnce(new Error("private renderer details"));
    const result = await repairWord(input, "course.docx");
    expect(result).toMatchObject({
      docx: input,
      changes: [],
      calls: [{ stage: "convert" }, { stage: "validate" }],
    });
    if ("error" in result) throw Error();
    expect(
      result.errors.some((f) =>
        f.message.includes("repairs could not be checked")
      )
    ).toBe(true);
    expect(JSON.stringify(result)).not.toContain("private renderer details");
  });
  it("does not submit malformed input or unsupported extension", async () => {
    const result = await repairWord(Buffer.from("not a zip"), "course.pdf");
    expect(result).toHaveProperty("error");
    expect(mocks.call).not.toHaveBeenCalled();
  });
  it("does not return raw provider error details", async () => {
    mocks.call.mockRejectedValue(
      new LiteLLMError("secret API key and private document", {
        version: 1,
        stage: "conversion",
        code: "provider_request_rejected",
      })
    );
    const result = await repairWord(input, "course.docx");
    expect(result).toMatchObject({
      diagnostic: { stage: "docx_repair", code: "provider_request_rejected" },
    });
    expect(JSON.stringify(result)).not.toContain("secret API key");
  });

  it("settles concurrent repair requests and keeps their costs before returning a failure", async () => {
    const inspection = {
      ...source,
      paragraphs: Array.from({ length: 59 }, (_, i) => paragraph(i + 1)),
    };
    mocks.inspect.mockResolvedValue(inspection);
    mocks.pages.mockResolvedValue(pages(59));
    mocks.call.mockImplementation(async (prompt, parts) => {
      const batch = assigned(parts);
      if (batch.pages[0] === 1) throw new LiteLLMError("safe failure");
      await new Promise((resolve) => setTimeout(resolve, 2));
      return goodCall(prompt, parts);
    });
    const result = await repairWord(input, "course.docx");
    expect(result).toHaveProperty("error");
    expect(mocks.call).toHaveBeenCalledTimes(4);
    expect(result.calls).toHaveLength(3);
    expect(result.calls?.every((call) => call.costUsd === 0.01)).toBe(true);
    expect(mocks.apply).not.toHaveBeenCalled();
  });

  it("bounds model concurrency to four requests in each stage", async () => {
    const inspection = {
      ...source,
      paragraphs: Array.from({ length: 59 }, (_, i) => paragraph(i + 1)),
    };
    mocks.inspect.mockResolvedValue(inspection);
    mocks.pages.mockResolvedValue(pages(59));
    mocks.apply.mockResolvedValue({
      buffer: output,
      inspection,
      changes: [],
      findings: [],
    });
    let active = 0;
    let peak = 0;
    mocks.call.mockImplementation(async (prompt, parts) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active--;
      return goodCall(prompt, parts);
    });
    expect(await repairWord(input, "course.docx")).toHaveProperty("docx");
    expect(peak).toBe(4);
    expect(active).toBe(0);
  });

  it("withholds a description change for an image whose visual location is unavailable", async () => {
    const inspection: DocxInspection = {
      ...source,
      images: [
        {
          id: "word/document.xml:i:1",
          partName: "word/document.xml",
          index: 1,
          location: "Image 1",
          paragraphId: paragraph(1).id,
          inline: false,
          name: "Picture",
          description: "",
          title: "",
          decorative: false,
          functional: false,
          editable: true,
          nearbyText: paragraph(1).text,
        },
      ],
    };
    mocks.inspect.mockResolvedValue(inspection);
    mocks.pages.mockResolvedValue(pages(2));
    mocks.apply.mockResolvedValue({
      buffer: output,
      inspection,
      changes: [],
      findings: [],
    });
    mocks.call.mockImplementation((prompt, parts) => {
      const value = goodCall(prompt, parts);
      if (prompt !== WORD_AUDIT_PROMPT) {
        const data = JSON.parse(value.content);
        data.operations = [
          {
            type: "setImageDescription",
            id: inspection.images[0].id,
            text: "Unverified description",
          },
        ];
        value.content = JSON.stringify(data);
      }
      return value;
    });
    const result = await repairWord(input, "course.docx");
    if ("error" in result) throw Error();
    expect(
      result.errors.some((f) => f.message.includes("could not reliably match"))
    ).toBe(true);
    expect(mocks.apply.mock.calls[0][1].operations).toEqual([]);
    expect(result.changes).toEqual([]);
  });
});

describe("Word evidence boundaries", () => {
  it("describes saved heading changes using the original words and actual before/after levels", () => {
    const change: DocxChange = {
      type: "setHeading",
      id: paragraph(1).id,
      location: "Document, paragraph 1",
      message: "A model proposed level 6 for unrelated text.",
      before: "3",
      after: "2",
    };
    const summary = describeWordChange(change, source);
    expect(summary).toContain(`“${paragraph(1).text}”`);
    expect(summary).toContain("from heading level 3 to level 2");
    expect(summary).not.toContain("proposed");
    expect(summary).not.toContain("unrelated text");
  });

  it("shows the actual saved alternative and existing table labels rather than generic repair claims", () => {
    const inspection: DocxInspection = {
      ...source,
      images: [
        {
          id: "word/document.xml:i:1",
          partName: "word/document.xml",
          index: 1,
          location: "Image 1",
          inline: true,
          name: "Institution logo",
          description: "",
          title: "",
          decorative: false,
          functional: false,
          editable: true,
          nearbyText: "",
        },
      ],
    };
    const alt: DocxChange = {
      type: "setImageDescription",
      id: inspection.images[0].id,
      location: "Document, image 1",
      message: "Model claimed a mountain photograph.",
      before: "",
      after: "Accessible University",
    };
    const summary = describeWordChange(alt, inspection);
    expect(summary).toContain("Institution logo");
    expect(summary).toContain("“Accessible University”");
    expect(summary).not.toContain("mountain");
    const table = describeWordChange(
      {
        type: "setTableHeader",
        id: "word/document.xml:t:1",
        location: "Document, table 1",
        message: "Generic change",
        before: "No first-row heading flag",
        after: "Week | Topic | Reading assignment",
      },
      source
    );
    expect(table).toContain("“Week | Topic | Reading assignment”");
    expect(table).toContain("column headings");
  });

  it("uses understandable language names while retaining the exact saved language tags", () => {
    const summary = describeWordChange(
      {
        type: "setLanguage",
        id: paragraph(1).id,
        location: "Document, paragraph 1",
        message: "Generic change",
        before: "en-US",
        after: "fr-FR",
      },
      source
    );
    expect(summary).toContain("French (fr-FR)");
    expect(summary).toContain("previously English (en-US)");
    expect(summary).toContain(`“${paragraph(1).text}”`);
  });

  it("bounds saved summaries and marks shortened alternative text with an ellipsis", () => {
    const summary = describeWordChange(
      {
        type: "setImageDescription",
        id: "word/document.xml:i:1",
        location: "Document, image 1".repeat(30),
        message: "Generic change",
        before: "",
        after: "An actual saved long description. ".repeat(100),
      },
      source
    );
    expect(summary.length).toBeLessThanOrEqual(500);
    expect(summary).toContain("An actual saved long description.");
    expect(summary).toContain("…");
    const longHeading = {
      ...source,
      paragraphs: [
        paragraph(1, "A heading with many original words ".repeat(20)),
      ],
    };
    const heading = describeWordChange(
      {
        type: "setHeading",
        id: paragraph(1).id,
        location: "Document, paragraph 1",
        message: "Generic change",
        before: "No heading level",
        after: "1",
      },
      longHeading
    );
    expect(heading).toContain("…");
    expect(heading.length).toBeLessThanOrEqual(500);
  });

  it("associates a floating main-story image with the sole rendered page", () => {
    const inspection: DocxInspection = {
      ...source,
      images: [
        {
          id: "word/document.xml:i:1",
          partName: "word/document.xml",
          index: 1,
          location: "Image 1",
          inline: false,
          name: "Logo",
          description: "",
          title: "",
          decorative: false,
          functional: false,
          editable: true,
          nearbyText: "",
        },
      ],
    };
    expect(
      wordObjectPages(inspection, pages()).get(inspection.images[0].id)
    ).toEqual([1]);
    expect(
      wordObjectPages(inspection, pages(2)).get(inspection.images[0].id)
    ).toEqual([]);
    inspection.images[0].partName = "word/header1.xml";
    expect(
      wordObjectPages(inspection, pages()).get(inspection.images[0].id)
    ).toEqual([]);
  });

  it("merges known machine, repair and audit codes by object and problem while retaining maximum severity", () => {
    const base = {
      severity: "warning" as const,
      objectId: "word/document.xml:t:2",
      location: "Table 2",
      suggestion: "Check table labels.",
    };
    const merged = mergeWordFindings(
      [
        {
          ...base,
          code: "docx_complex_table",
          severity: "error",
          message: "Complex table machine finding.",
        },
      ],
      [{ ...base, code: "complex-table", message: "Conversion details." }],
      [
        {
          ...base,
          code: "complex-table",
          message: "Final audit explains the merged Exams and Projects labels.",
          suggestion:
            "In Word, simplify this table or add a clearly labeled list of the weights.",
        },
      ]
    );
    expect(merged).toEqual([
      {
        ...base,
        code: "complex-table",
        severity: "error",
        message: "Final audit explains the merged Exams and Projects labels.",
        suggestion:
          "In Word, simplify this table or add a clearly labeled list of the weights.",
      },
    ]);
  });

  it("preserves distinct problems on one object and machine findings the audit did not mention", () => {
    const base = {
      severity: "warning" as const,
      objectId: "word/document.xml:p:1",
      location: "Paragraph 1",
      suggestion: "Review this in Word.",
    };
    const merged = mergeWordFindings(
      [
        {
          ...base,
          code: "docx_language_review",
          message: "Pronunciation language needs checking.",
        },
        {
          ...base,
          code: "docx_unsupported_field",
          message: "A field needs checking.",
        },
        {
          ...base,
          code: "docx_unsupported_text_box",
          message: "A text box needs checking.",
        },
      ],
      [{ ...base, code: "contrast", message: "Caption color needs checking." }]
    );
    expect(merged.map((finding) => finding.code)).toEqual([
      "language",
      "unsupported-field",
      "unsupported-text-box",
      "contrast",
    ]);
  });

  it("keeps distinct final-stage observations and unknown checks instead of guessing from prose", () => {
    const base = {
      severity: "warning" as const,
      objectId: "word/document.xml:p:1",
      location: "Paragraph 1",
      suggestion: "Review this in Word.",
    };
    const merged = mergeWordFindings(
      [
        {
          ...base,
          code: "future-machine-check",
          message: "First unrecognized problem.",
        },
        {
          ...base,
          code: "future-machine-check",
          message: "Second unrecognized problem.",
        },
      ],
      [
        {
          ...base,
          code: "contrast",
          message: "First text span has poor contrast.",
        },
        {
          ...base,
          code: "contrast",
          message: "A different text span has poor contrast.",
        },
      ]
    );
    expect(merged).toHaveLength(4);
  });

  it("rejects model findings outside the finite taxonomy", () => {
    const finding = {
      code: "manual-review",
      severity: "warning",
      objectId: paragraph(1).id,
      location: "Section 1",
      message: "Check heading.",
      suggestion: "Review outline.",
    };
    expect(
      parseWordFindings(
        [finding],
        { inspection: source, pages: pages().pages },
        wordObjectPages(source, pages())
      )
    ).toBeNull();
  });
  it("rejects missing, duplicated, foreign or unsupported operations", () => {
    expect(completeWordPlan(planFor(source), source)).toBe(true);
    expect(
      completeWordPlan({ ...planFor(source), reviewedParagraphIds: [] }, source)
    ).toBe(false);
    expect(
      completeWordPlan(
        {
          ...planFor(source),
          reviewedParagraphIds: [paragraph(1).id, paragraph(1).id],
        },
        source
      )
    ).toBe(false);
    expect(
      completeWordPlan(
        {
          ...planFor(source),
          operations: [
            {
              type: "setHeading",
              id: paragraph(2).id,
              sourceText: "foreign",
              level: 1,
            },
          ],
        },
        source
      )
    ).toBe(false);
    expect(
      completeWordPlan(
        {
          ...planFor(source),
          operations: [
            { type: "replaceXml", id: paragraph(1).id, xml: "<evil/>" },
          ],
        },
        source
      )
    ).toBe(false);
  });
  it("matches unique text spanning pages but refuses repeated text as a locator", () => {
    const inspection = {
      ...source,
      paragraphs: [
        paragraph(1, "One opening phrase and final phrase"),
        paragraph(2, "Repeated phrase"),
      ],
    };
    const rendered = pages(2);
    rendered.pages[0].text = "Repeated phrase One opening phrase";
    rendered.pages[1].text = "and final phrase Repeated phrase";
    const mapping = wordObjectPages(inspection, rendered);
    expect(mapping.get(paragraph(1).id)).toEqual([1, 2]);
    expect(mapping.get(paragraph(2).id)).toEqual([]);
  });

  it("locates a title's unique full line even when running footers repeat its words", () => {
    const inspection = {
      ...source,
      paragraphs: [
        paragraph(1, "Classroom activity guide"),
        paragraph(2, "The workflow"),
      ],
    };
    const rendered = pages(2);
    rendered.pages[0].text =
      "Classroom activity guide | Page 1\nClassroom activity guide\nLearn the workflow before class.\nThe workflow\nStep one.";
    rendered.pages[1].text = "Classroom activity guide | Page 2\nMore text.";
    const mapping = wordObjectPages(inspection, rendered);
    expect(mapping.get(paragraph(1).id)).toEqual([1]);
    expect(mapping.get(paragraph(2).id)).toEqual([1]);
  });
  it("refuses a floating image anchor as evidence of the image's physical page", () => {
    const inspection: DocxInspection = {
      ...source,
      images: [
        {
          id: "word/document.xml:i:1",
          partName: "word/document.xml",
          index: 1,
          location: "Image 1",
          paragraphId: paragraph(1).id,
          inline: false,
          name: "Picture",
          description: "",
          title: "",
          decorative: false,
          functional: false,
          editable: true,
          nearbyText: paragraph(1).text,
        },
      ],
    };
    expect(
      wordObjectPages(inspection, pages(2)).get(inspection.images[0].id)
    ).toEqual([]);
    inspection.images[0].inline = true;
    expect(
      wordObjectPages(inspection, pages(2)).get(inspection.images[0].id)
    ).toEqual([1]);
    inspection.images.push({
      ...inspection.images[0],
      id: "word/document.xml:i:2",
      index: 2,
    });
    expect(
      wordObjectPages(inspection, pages(2)).get(inspection.images[0].id)
    ).toEqual([]);
  });
  it("rejects fabricated finding page numbers and IDs", () => {
    const batch = { inspection: source, pages: pages().pages };
    const locations = wordObjectPages(source, pages());
    const finding = {
      code: "heading-hierarchy",
      severity: "warning",
      objectId: paragraph(1).id,
      location: "Section 1",
      message: "Check heading.",
      suggestion: "Review outline.",
    };
    expect(
      parseWordFindings([{ ...finding, pageNumber: 5 }], batch, locations)
    ).toBeNull();
    expect(
      parseWordFindings(
        [{ ...finding, objectId: paragraph(2).id }],
        batch,
        locations
      )
    ).toBeNull();
    expect(
      parseWordFindings([{ ...finding, pageNumber: 1 }], batch, locations)
    ).toHaveLength(1);
  });
  it("detects changed pixels, changed text and changed pagination", async () => {
    expect(await sameWordLayout(pages(), pages())).toBe(true);
    expect(await sameWordLayout(pages(), pages(1, "red"))).toBe(false);
    expect(await sameWordLayout(pages(), pages(2))).toBe(false);
    const changed = pages();
    changed.pages[0].text = "Missing content";
    expect(await sameWordLayout(pages(), changed)).toBe(false);
  });
});
