import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  PptxChange,
  PptxFinding,
  PptxInspection,
} from "../lib/pptx-types";

vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({
  inspect: vi.fn(),
  repair: vi.fn(),
  render: vi.fn(),
  pages: vi.fn(),
  call: vi.fn(),
  tracked: vi.fn(),
}));
vi.mock("../lib/pptx-package", async (original) => ({
  ...(await original<typeof import("../lib/pptx-package")>()),
  inspectPptx: mocks.inspect,
  applyPptxRepairs: mocks.repair,
}));
vi.mock("../lib/pptx-revisions", async (original) => ({
  ...(await original<typeof import("../lib/pptx-revisions")>()),
  createPptxRevisionBundle: mocks.tracked,
}));
vi.mock("../lib/powerpoint-rendering", async (original) => ({
  ...(await original<typeof import("../lib/powerpoint-rendering")>()),
  renderPowerPointToPdf: mocks.render,
}));
vi.mock("../lib/pdf-rendering", async (original) => ({
  ...(await original<typeof import("../lib/pdf-rendering")>()),
  renderPdfPages: mocks.pages,
}));
vi.mock("../lib/litellm", async (original) => ({
  ...(await original<typeof import("../lib/litellm")>()),
  callLiteLLM: mocks.call,
  getLiteLLMConfig: () => ({
    apiKey: "unit-test",
    baseUrl: "https://unit.test",
    model: "test-model",
  }),
}));

import {
  completePowerPointPlan,
  convertPowerPoint,
  parsePowerPointFindings,
  changedPowerPointSlides,
  recheckPowerPointRevision,
  completePowerPointCorrection,
  buildPowerPointReviewPreviews,
} from "../lib/powerpoint-convert";
import { createCanvas } from "@napi-rs/canvas";
import { LiteLLMError } from "../lib/litellm";
import { MAX_PPTX_FILE_SIZE_BYTES } from "../lib/document-input";

const inspection: PptxInspection = {
  slideCount: 1,
  width: 100,
  height: 100,
  findings: [],
  slides: [
    {
      slideNumber: 1,
      partName: "ppt/slides/slide1.xml",
      hidden: false,
      hasTiming: false,
      hasExternalContent: false,
      objects: [
        {
          id: "2",
          name: "Title",
          kind: "text",
          text: "Sampling",
          description: "",
          title: "",
          decorative: false,
          isTitle: true,
          hidden: false,
          rect: { x: 0, y: 0, width: 50, height: 10 },
          grouped: false,
          parentId: null,
          language: "en-US",
        },
      ],
    },
  ],
};
const input = Buffer.from("PK\x03\x04original-pptx");
const output = Buffer.from("repaired-pptx");
const plan = { slides: [{ slideNumber: 1 }], findings: [] };
const audit = { reviewedSlides: [1], findingReviews: [], findings: [] };
const resultCall = (content: unknown) => ({
  content: JSON.stringify(content),
  model: "test-model",
  promptTokens: 100,
  completionTokens: 50,
  responseCostUsd: 0.01,
  finishReason: "stop",
});
const pages = (png: Buffer = createCanvas(1, 1).toBuffer("image/png")) => ({
  pageCount: 1,
  pages: [
    {
      pageNumber: 1,
      width: 1,
      height: 1,
      png,
      text: "Sampling",
      imageAlternatives: { status: "complete" as const, figures: [] },
    },
  ],
});

beforeEach(() => {
  vi.resetAllMocks();
  mocks.inspect.mockResolvedValue(inspection);
  mocks.tracked.mockImplementation(async (buffer, plan) => {
    const result = await mocks.repair(buffer, plan);
    return {
      result,
      bundle: {
        version: 1,
        sourceHash: "source-hash",
        plan,
        changes: result.changes.map((change: PptxChange, index: number) => ({
          id: `change-${index + 1}`,
          type: change.type,
          slideNumber: change.slideNumber,
          label: change.message,
          before: "Before",
          after: "After",
          reason: "Repair",
          operationIds: [],
          ...(change.generatedSlideNumbers
            ? { generatedSlideNumbers: change.generatedSlideNumbers }
            : {}),
        })),
      },
    };
  });
  mocks.repair.mockResolvedValue({
    buffer: output,
    inspection,
    findings: [],
    changes: [
      {
        slideNumber: 1,
        type: "description",
        message: "Added an image description.",
      },
    ],
  });
  mocks.render.mockResolvedValue(Buffer.from("%PDF-test"));
  mocks.pages.mockResolvedValue(pages());
  mocks.call
    .mockResolvedValueOnce(resultCall(plan))
    .mockResolvedValueOnce(resultCall(audit));
});

describe("PowerPoint repair orchestration", () => {
  it("uses the injected renderer for both original and repaired presentations", async () => {
    const renderPowerPoint = vi
      .fn()
      .mockResolvedValue(Buffer.from("%PDF-test"));
    const result = await convertPowerPoint(input, "test.pptx", {
      renderPowerPoint,
    });
    expect(result).not.toHaveProperty("error");
    expect(renderPowerPoint.mock.calls.map((call) => call[0])).toEqual([
      input,
      output,
    ]);
    expect(
      renderPowerPoint.mock.calls.every(
        (call) => call[1] > 0 && call[1] <= 60_000
      )
    ).toBe(true);
    expect(mocks.render).not.toHaveBeenCalled();
  });

  it("uses the injected renderer when rechecking a selected revision", async () => {
    mocks.call.mockReset().mockResolvedValue(resultCall(audit));
    const renderPowerPoint = vi
      .fn()
      .mockResolvedValue(Buffer.from("%PDF-test"));
    const result = await recheckPowerPointRevision(input, output, [], {
      renderPowerPoint,
    });
    expect(result).not.toHaveProperty("error");
    expect(renderPowerPoint.mock.calls.map((call) => call[0])).toEqual([
      input,
      output,
    ]);
    expect(mocks.render).not.toHaveBeenCalled();
  });

  it("rejects over-25 MiB sources before package inspection, rendering or model calls", async () => {
    const oversized = Buffer.alloc(MAX_PPTX_FILE_SIZE_BYTES + 1);
    input.copy(oversized);
    expect(await convertPowerPoint(oversized, "large.pptx")).toHaveProperty(
      "error"
    );
    expect(await recheckPowerPointRevision(oversized, output)).toHaveProperty(
      "error"
    );
    expect(mocks.inspect).not.toHaveBeenCalled();
    expect(mocks.render).not.toHaveBeenCalled();
    expect(mocks.call).not.toHaveBeenCalled();
  });

  it("returns native PPTX, keeps all billable calls, and uses independent PPTX prompts", async () => {
    const result = await convertPowerPoint(input, "test.pptx");
    expect(result).not.toHaveProperty("error");
    if ("error" in result) return;
    expect(result.pptx).toEqual(output);
    expect(result).not.toHaveProperty("html");
    expect(result.calls.map((c) => [c.stage, c.costUsd])).toEqual([
      ["convert", 0.01],
      ["validate", 0.01],
    ]);
    expect(result.tokensUsed).toBe(300);
    expect(result.errors).toHaveLength(0);
    expect(result.extractionWarnings).toEqual([]);
    expect(mocks.call.mock.calls[0][0]).toContain("PowerPoint");
    expect(mocks.call.mock.calls[1][0]).toContain("independently audit");
    expect(mocks.call.mock.calls[0][0]).not.toContain(
      "Canvas HTML compatibility"
    );
    expect(mocks.render.mock.calls.map((c) => c[0])).toEqual([input, output]);
    expect(
      mocks.pages.mock.calls.every(
        (call) => call[1].inputKind === "powerpoint-preview"
      )
    ).toBe(true);
    expect(mocks.call.mock.calls[1][1]).toContainEqual(
      expect.objectContaining({
        type: "text",
        text: expect.stringContaining("ACTUAL REPAIRED slide 1"),
      })
    );
    expect(result.revisions?.changes).toHaveLength(1);
    expect(result.reviewPreviews?.[0].after).toMatch(
      /^data:image\/jpeg;base64,/
    );
  });

  it("rejects incomplete repair coverage after recording the completed call cost", async () => {
    mocks.call
      .mockReset()
      .mockResolvedValue(resultCall({ slides: [], findings: [] }));
    const result = await convertPowerPoint(input, "test.pptx");
    expect(result).toMatchObject({
      diagnostic: { code: "pptx_invalid_plan" },
      calls: [{ costUsd: 0.01 }],
    });
    expect(mocks.repair).not.toHaveBeenCalled();
  });

  it("gives the repair model source defects confirmed by code", async () => {
    const source = structuredClone(inspection);
    source.slides[0].objects[0].isTitle = false;
    mocks.inspect.mockResolvedValue(source);
    await convertPowerPoint(input, "test.pptx");
    const evidence = mocks.call.mock.calls[0][1];
    expect(evidence).toContainEqual({
      type: "text",
      text: expect.stringContaining('"code":"slide-title"'),
    });
    expect(evidence).toContainEqual({
      type: "text",
      text: expect.stringContaining("Machine-detected source defects"),
    });
  });

  const concern: PptxFinding = {
    code: "complex-object-review",
    severity: "warning",
    slideNumber: 1,
    objectId: "3",
    message: "Review this chart's description.",
    suggestion: "Check whether it explains the comparison.",
  };
  const chartInspection: PptxInspection = {
    ...inspection,
    slides: [
      {
        ...inspection.slides[0],
        objects: [
          ...inspection.slides[0].objects,
          {
            ...inspection.slides[0].objects[0],
            id: "3",
            name: "Observation chart",
            kind: "chart",
            isTitle: false,
            text: "",
            description:
              "Group A recorded 10 observations and Group B recorded 20.",
          },
        ],
      },
    ],
  };
  const resolved = {
    id: "review-1",
    status: "resolved",
    reason:
      "The saved description states both groups' exact visible values and their comparison.",
  };

  it("removes a generic chart concern only after explicit output-based audit resolution", async () => {
    mocks.repair.mockResolvedValue({
      buffer: output,
      inspection: chartInspection,
      findings: [concern],
      changes: [],
    });
    mocks.call
      .mockReset()
      .mockResolvedValueOnce(resultCall(plan))
      .mockResolvedValueOnce(
        resultCall({ ...audit, findingReviews: [resolved] })
      );
    const result = await convertPowerPoint(input, "chart.pptx");
    if ("error" in result) throw new Error(result.error);
    expect(result.errors).toEqual([]);
    expect(mocks.call.mock.calls[1][1]).toContainEqual({
      type: "text",
      text: expect.stringContaining('"id":"review-1"'),
    });
  });

  it.each([
    ["missing decisions", undefined],
    ["empty decisions", []],
    ["unknown ID", [{ ...resolved, id: "review-99" }]],
    ["duplicate ID", [resolved, resolved]],
    ["unsupported claim", [{ ...resolved, reason: "Fixed" }]],
  ])(
    "keeps original concerns and completed costs for %s",
    async (_label, decisions) => {
      mocks.repair.mockResolvedValue({
        buffer: output,
        inspection: chartInspection,
        findings: [concern],
        changes: [],
      });
      mocks.call
        .mockReset()
        .mockResolvedValueOnce(resultCall(plan))
        .mockResolvedValueOnce(
          resultCall({ ...audit, findingReviews: decisions })
        );
      const result = await convertPowerPoint(input, "chart.pptx");
      if ("error" in result) throw new Error(result.error);
      expect(result.errors.map((f) => f.message)).toEqual([
        concern.message,
        expect.stringContaining("independent AI review did not finish"),
      ]);
      expect(result.calls.map((c) => c.costUsd)).toEqual([0.01, 0.01]);
    }
  );

  it("clears a source concern after repair without hiding a separate confirmed output defect", async () => {
    const stale = {
      ...concern,
      code: "chart-description-review",
      message: "Check the original chart description.",
    };
    const confirmed = {
      ...concern,
      code: "missing-table-header",
      severity: "error" as const,
      objectId: "4",
      message: "This table still lacks a header row.",
    };
    const inventory = structuredClone(chartInspection);
    inventory.slides[0].objects.push({
      ...inventory.slides[0].objects[1],
      id: "4",
      kind: "table",
      name: "Observations table",
    });
    mocks.inspect.mockResolvedValue(inventory);
    mocks.repair.mockResolvedValue({
      buffer: output,
      inspection: inventory,
      findings: [confirmed],
      changes: [],
    });
    mocks.call
      .mockReset()
      .mockResolvedValueOnce(resultCall({ ...plan, findings: [stale] }))
      .mockResolvedValueOnce(
        resultCall({ ...audit, findingReviews: [resolved] })
      );
    const result = await convertPowerPoint(input, "table.pptx");
    if ("error" in result) throw new Error(result.error);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({
      severity: "error",
      message: confirmed.message,
    });
  });

  it("keeps ambiguous decisions and additional located audit defects", async () => {
    mocks.repair.mockResolvedValue({
      buffer: output,
      inspection: chartInspection,
      findings: [concern],
      changes: [],
    });
    mocks.call
      .mockReset()
      .mockResolvedValueOnce(resultCall(plan))
      .mockResolvedValueOnce(
        resultCall({
          ...audit,
          findingReviews: [
            {
              id: "review-1",
              status: "needs_review",
              message: "The chart does not identify its units.",
              suggestion: "Add the measurement units to its description.",
            },
          ],
          findings: [
            {
              ...concern,
              code: "chart-description-incorrect",
              severity: "error",
              message: "The description reverses Group A and Group B.",
            },
          ],
        })
      );
    const result = await convertPowerPoint(input, "chart.pptx");
    if ("error" in result) throw new Error(result.error);
    expect(result.errors).toHaveLength(2);
    expect(result.errors.map((f) => f.severity)).toEqual(["warning", "error"]);
    expect(result.errors.every((f) => f.location?.sourcePages?.[0] === 1)).toBe(
      true
    );
  });

  it("fails before model work when PDF preview omits a slide", async () => {
    mocks.pages.mockResolvedValue({ pageCount: 0, pages: [] });
    const result = await convertPowerPoint(input, "test.pptx");
    expect(result).toHaveProperty("error");
    expect(mocks.call).not.toHaveBeenCalled();
  });

  it("keeps a repaired file and an explicit warning for incomplete audit coverage", async () => {
    mocks.call
      .mockReset()
      .mockResolvedValueOnce(resultCall(plan))
      .mockResolvedValueOnce(resultCall({ reviewedSlides: [], findings: [] }));
    const result = await convertPowerPoint(input, "test.pptx");
    if ("error" in result) throw new Error(result.error);
    expect(result.calls).toHaveLength(2);
    expect(
      result.errors.some((f) => f.message.includes("independent AI review"))
    ).toBe(true);
  });

  it("preserves usage and suppresses untrusted exception text after repair failure", async () => {
    mocks.repair.mockRejectedValue(new Error("private source content and key"));
    const result = await convertPowerPoint(input, "test.pptx");
    expect(result).toHaveProperty("error");
    expect(result.calls).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain("private source");
  });

  it("retains a controlled audit warning when the provider is unavailable", async () => {
    mocks.call
      .mockReset()
      .mockResolvedValueOnce(resultCall(plan))
      .mockRejectedValueOnce(new LiteLLMError("private provider body"));
    const result = await convertPowerPoint(input, "test.pptx");
    if ("error" in result) throw new Error(result.error);
    expect(
      result.errors.some((f) => f.message.includes("independent AI review"))
    ).toBe(true);
    expect(result.calls).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain("private provider");
  });

  it("keeps intentional visible edits and gives the audit real before/after evidence", async () => {
    const blank = createCanvas(1, 1).toBuffer("image/png");
    const dark = createCanvas(1, 1);
    dark.getContext("2d").fillRect(0, 0, 1, 1);
    const candidate = dark.toBuffer("image/png");
    mocks.pages
      .mockReset()
      .mockResolvedValueOnce(pages(blank))
      .mockResolvedValueOnce(pages(candidate));
    const result = await convertPowerPoint(input, "test.pptx");
    expect(result).not.toHaveProperty("error");
    expect(mocks.repair).toHaveBeenCalledTimes(1);
    const evidence = mocks.call.mock.calls[1][1];
    expect(evidence).toContainEqual(
      expect.objectContaining({
        type: "text",
        text: expect.stringContaining(
          "ORIGINAL slide 1 before visible changes"
        ),
      })
    );
    expect(evidence).toContainEqual({
      type: "image_url",
      image_url: {
        detail: "high",
        url: `data:image/png;base64,${candidate.toString("base64")}`,
      },
    });
  });

  it("rejects a rendered candidate that omits slides before auditing", async () => {
    mocks.pages
      .mockReset()
      .mockResolvedValueOnce(pages())
      .mockResolvedValueOnce({ pageCount: 0, pages: [] });
    const result = await convertPowerPoint(input, "test.pptx");
    expect(result).toHaveProperty("error");
    expect(result.calls).toHaveLength(1);
    expect(mocks.call).toHaveBeenCalledTimes(1);
  });

  it("rechecks the chosen export without automatically restoring declined changes", async () => {
    mocks.call.mockReset().mockResolvedValueOnce(resultCall(audit));
    const result = await recheckPowerPointRevision(input, input);
    expect(result).not.toHaveProperty("error");
    expect(mocks.tracked).not.toHaveBeenCalled();
    expect(mocks.repair).not.toHaveBeenCalled();
    expect(mocks.call).toHaveBeenCalledTimes(1);
    expect(mocks.call.mock.calls[0][1]).toContainEqual(
      expect.objectContaining({
        type: "text",
        text: expect.stringContaining("Automatic correction DISABLED"),
      })
    );
    expect(result.calls?.map((call) => call.stage)).toEqual(["validate"]);
  });

  it("does not hide a machine defect restored by undo", async () => {
    const restored = structuredClone(inspection);
    restored.slides[0].objects[0].isTitle = false;
    mocks.inspect
      .mockResolvedValueOnce(inspection)
      .mockResolvedValueOnce(restored);
    mocks.call.mockReset().mockResolvedValueOnce(resultCall(audit));
    const result = await recheckPowerPointRevision(input, input);
    if ("error" in result) throw new Error(result.error);
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        severity: "error",
        message: expect.stringContaining("title identified"),
      })
    );
  });

  it("rejects a corrective plan in a selected-export audit and preserves audit charges", async () => {
    mocks.call.mockReset().mockResolvedValueOnce(
      resultCall({
        ...audit,
        correctivePlan: {
          slides: [
            {
              slideNumber: 1,
              descriptions: [{ objectId: "2", text: "Changed" }],
            },
          ],
        },
      })
    );
    const result = await recheckPowerPointRevision(input, input);
    if ("error" in result) throw new Error(result.error);
    expect(result.pptx).toEqual(input);
    expect(
      result.errors.some((finding) =>
        finding.message.includes("independent AI review")
      )
    ).toBe(true);
    expect(result.calls).toHaveLength(1);
    expect(mocks.tracked).not.toHaveBeenCalled();
  });

  it("replays an auditor correction from the original and independently checks it once more", async () => {
    const corrected = Buffer.from("corrected-pptx");
    const correction = {
      slides: [
        {
          slideNumber: 1,
          descriptions: [{ objectId: "2", text: "Correct description" }],
        },
      ],
    };
    mocks.repair
      .mockResolvedValueOnce({
        buffer: output,
        inspection,
        findings: [],
        changes: [],
      })
      .mockResolvedValueOnce({
        buffer: corrected,
        inspection,
        findings: [],
        changes: [],
      });
    mocks.call
      .mockReset()
      .mockResolvedValueOnce(resultCall(plan))
      .mockResolvedValueOnce(
        resultCall({ ...audit, correctivePlan: correction })
      )
      .mockResolvedValueOnce(resultCall(audit));
    const result = await convertPowerPoint(input, "test.pptx");
    if ("error" in result) throw new Error(result.error);
    expect(result.pptx).toEqual(corrected);
    expect(mocks.tracked.mock.calls[1][0]).toEqual(input);
    expect(mocks.tracked.mock.calls[1][1]).toMatchObject(correction);
    expect(result.calls.map((call) => call.stage)).toEqual([
      "convert",
      "validate",
      "validate",
    ]);
    expect(result.tokensUsed).toBe(450);
    expect(mocks.render.mock.calls.map((call) => call[0])).toEqual([
      input,
      output,
      corrected,
    ]);
  });

  it("keeps the prior audited candidate if the corrective output cannot be audited", async () => {
    const correction = {
      slides: [
        {
          slideNumber: 1,
          descriptions: [{ objectId: "2", text: "Correct description" }],
        },
      ],
    };
    mocks.repair
      .mockResolvedValueOnce({
        buffer: output,
        inspection,
        findings: [],
        changes: [],
      })
      .mockResolvedValueOnce({
        buffer: Buffer.from("correction"),
        inspection,
        findings: [],
        changes: [],
      });
    mocks.call
      .mockReset()
      .mockResolvedValueOnce(resultCall(plan))
      .mockResolvedValueOnce(
        resultCall({ ...audit, correctivePlan: correction })
      )
      .mockResolvedValueOnce(resultCall({ reviewedSlides: [] }));
    const result = await convertPowerPoint(input, "test.pptx");
    if ("error" in result) throw new Error(result.error);
    expect(result.pptx).toEqual(output);
    expect(result.calls).toHaveLength(3);
    expect(
      result.errors.some((finding) =>
        finding.message.includes("previously checked version")
      )
    ).toBe(true);
  });

  it("does not accept structural edits in the focused corrective pass", () => {
    expect(
      completePowerPointCorrection(
        { slides: [{ slideNumber: 1, titleObjectId: "2" }] },
        inspection
      )
    ).toBe(false);
    expect(
      completePowerPointCorrection(
        {
          slides: [
            {
              slideNumber: 1,
              textLanguages: [
                { objectId: "2", sourceText: "Sampling", tag: "en-US" },
              ],
            },
          ],
        },
        inspection
      )
    ).toBe(true);
  });
});

describe("deterministic empty-placeholder preprocessing", () => {
  const original = (): PptxInspection => {
    const source = structuredClone(inspection);
    source.slides[0].objects.push(
      {
        ...source.slides[0].objects[0],
        id: "4",
        name: "Content Placeholder 4",
        text: "",
        isTitle: false,
        emptyPlaceholder: true,
      },
      {
        ...source.slides[0].objects[0],
        id: "3",
        name: "Image 3",
        kind: "image",
        text: "",
        isTitle: false,
        description: "A tree beside the path.",
      }
    );
    return source;
  };
  const cleaned = () => {
    const source = original();
    source.slides[0].objects = source.slides[0].objects.filter(
      (object) => object.id !== "4"
    );
    return source;
  };
  const cleanupChange: PptxChange = {
    type: "empty-placeholder",
    slideNumber: 1,
    objectId: "4",
    message: "Removed an unused empty placeholder.",
    operationId: "1:empty-placeholder:4",
  };
  const cleanBuffer = Buffer.from("mechanically-cleaned-pptx");
  const prepare = () => {
    mocks.inspect.mockResolvedValue(original());
    mocks.repair.mockResolvedValueOnce({
      buffer: cleanBuffer,
      inspection: cleaned(),
      findings: [],
      changes: [cleanupChange],
    });
    mocks.repair.mockResolvedValue({
      buffer: output,
      inspection: cleaned(),
      findings: [],
      changes: [cleanupChange],
    });
    mocks.render
      .mockResolvedValueOnce(Buffer.from("%PDF-original"))
      .mockResolvedValueOnce(Buffer.from("%PDF-cleaned"))
      .mockResolvedValue(Buffer.from("%PDF-final"));
  };

  it("removes verified placeholders before model interpretation and keeps original evidence for audit and replay", async () => {
    prepare();
    mocks.call
      .mockReset()
      .mockResolvedValueOnce(
        resultCall({
          slides: [{ slideNumber: 1, readingOrder: ["2", "3"] }],
          findings: [],
        })
      )
      .mockResolvedValueOnce(resultCall(audit));
    const result = await convertPowerPoint(input, "test.pptx");
    if ("error" in result) throw new Error(result.error);
    expect(mocks.repair.mock.calls[0]).toEqual([
      input,
      { slides: [{ slideNumber: 1, removeEmptyPlaceholders: ["4"] }] },
      { revisioned: true },
    ]);
    expect(mocks.render.mock.calls.map((call) => call[0])).toEqual([
      input,
      cleanBuffer,
      output,
    ]);
    const repairEvidence = mocks.call.mock.calls[0][1];
    const inventory = repairEvidence.find(
      (part: { type: string; text?: string }) =>
        part.type === "text" &&
        part.text?.startsWith(
          "PowerPoint inventory after deterministic cleanup"
        )
    );
    expect(inventory.text).not.toContain('"id":"4"');
    expect(repairEvidence).toContainEqual({
      type: "file",
      file: {
        filename: "original-slides.pdf",
        file_data: `data:application/pdf;base64,${Buffer.from("%PDF-cleaned").toString("base64")}`,
      },
    });
    expect(mocks.tracked.mock.calls[0][0]).toEqual(input);
    expect(mocks.tracked.mock.calls[0][1].slides[0]).toMatchObject({
      removeEmptyPlaceholders: ["4"],
      readingOrder: ["2", "4", "3"],
    });
    expect(mocks.call.mock.calls[1][1]).toContainEqual(
      expect.objectContaining({
        type: "text",
        text: expect.stringContaining('"emptyPlaceholder":true'),
      })
    );
    expect(mocks.call.mock.calls[1][0]).toContain(
      "Their absence is intentional and is not lost teaching content"
    );
    expect(result.calls).toHaveLength(2);
    expect(result.errors).toEqual([]);
  });

  it("rejects model-proposed deletion fields rather than replacing deterministic cleanup", async () => {
    prepare();
    mocks.call.mockReset().mockResolvedValueOnce(
      resultCall({
        slides: [{ slideNumber: 1, removeEmptyPlaceholders: [] }],
        findings: [],
      })
    );
    const result = await convertPowerPoint(input, "test.pptx");
    expect(result).toMatchObject({
      diagnostic: { code: "pptx_invalid_plan" },
      calls: [{ costUsd: 0.01 }],
    });
    expect(mocks.tracked).not.toHaveBeenCalled();
  });

  it("normalizes an audit's cleaned reading order without dropping the original removal plan", async () => {
    prepare();
    mocks.repair.mockResolvedValueOnce({
      buffer: output,
      inspection: cleaned(),
      findings: [],
      changes: [cleanupChange],
    });
    mocks.repair.mockResolvedValue({
      buffer: Buffer.from("corrected-order"),
      inspection: cleaned(),
      findings: [],
      changes: [cleanupChange],
    });
    mocks.call
      .mockReset()
      .mockResolvedValueOnce(resultCall(plan))
      .mockResolvedValueOnce(
        resultCall({
          ...audit,
          correctivePlan: {
            slides: [{ slideNumber: 1, readingOrder: ["3", "2"] }],
          },
        })
      )
      .mockResolvedValueOnce(resultCall(audit));
    const result = await convertPowerPoint(input, "test.pptx");
    if ("error" in result) throw new Error(result.error);
    expect(mocks.tracked.mock.calls[1][1].slides[0]).toMatchObject({
      removeEmptyPlaceholders: ["4"],
      readingOrder: ["3", "4", "2"],
    });
    expect(result.calls).toHaveLength(3);
    expect(result.errors).toEqual([]);
  });

  it.each([
    { readingOrder: ["2"] },
    {
      objectBounds: [
        {
          objectId: "4",
          sourceRect: { x: 0, y: 0, width: 50, height: 10 },
          rect: { x: 0, y: 0, width: 60, height: 10 },
        },
      ],
    },
    {
      revisionNotes: [
        {
          type: "empty-placeholder",
          objectId: "4",
          reason: "Replace the recorded mechanical explanation.",
        },
      ],
    },
  ])(
    "rejects semantic edits to a placeholder already removed by code: %j",
    async (operation) => {
      prepare();
      mocks.call.mockReset().mockResolvedValueOnce(
        resultCall({
          slides: [{ slideNumber: 1, ...operation }],
          findings: [],
        })
      );
      const result = await convertPowerPoint(input, "test.pptx");
      expect(result).toMatchObject({
        diagnostic: { code: "pptx_invalid_plan" },
      });
      expect(mocks.tracked).not.toHaveBeenCalled();
    }
  );

  it("keeps the audited cleaned output if a corrective plan targets a removed placeholder", async () => {
    prepare();
    mocks.call
      .mockReset()
      .mockResolvedValueOnce(resultCall(plan))
      .mockResolvedValueOnce(
        resultCall({
          ...audit,
          correctivePlan: {
            slides: [
              {
                slideNumber: 1,
                descriptions: [
                  { objectId: "4", text: "Bring back the unused box." },
                ],
              },
            ],
          },
        })
      );
    const result = await convertPowerPoint(input, "test.pptx");
    if ("error" in result) throw new Error(result.error);
    expect(mocks.tracked).toHaveBeenCalledTimes(1);
    expect(result.pptx).toEqual(output);
    expect(result.calls).toHaveLength(2);
    expect(
      result.errors.some((finding) =>
        finding.message.includes("previously checked version")
      )
    ).toBe(true);
  });

  it("keeps an intentionally restored placeholder during the selected-version check", async () => {
    mocks.inspect.mockResolvedValue(original());
    mocks.call.mockReset().mockResolvedValueOnce(resultCall(audit));
    const result = await recheckPowerPointRevision(input, input);
    if ("error" in result) throw new Error(result.error);
    expect(result.pptx).toEqual(input);
    expect(mocks.repair).not.toHaveBeenCalled();
    expect(mocks.tracked).not.toHaveBeenCalled();
    expect(mocks.call.mock.calls[0][0]).toContain(
      "An instructor may restore an empty placeholder"
    );
  });
});

describe("appended image description slides", () => {
  const addedInspection = (): PptxInspection => ({
    ...structuredClone(inspection),
    slideCount: 2,
    slides: [
      structuredClone(inspection.slides[0]),
      {
        ...structuredClone(inspection.slides[0]),
        slideNumber: 2,
        partName: "ppt/slides/description1.xml",
        objects: [
          {
            ...structuredClone(inspection.slides[0].objects[0]),
            text: "Sampling image: full description",
          },
        ],
      },
    ],
  });
  const addedPages = () => ({
    pageCount: 2,
    pages: [pages().pages[0], { ...pages().pages[0], pageNumber: 2 }],
  });
  const changes: PptxChange[] = [
    {
      type: "long-description",
      slideNumber: 1,
      objectId: "2",
      message: "Added a description slide.",
      generatedSlideNumbers: [2],
    },
  ];
  const prepareOutput = () => {
    mocks.repair.mockResolvedValue({
      buffer: output,
      inspection: addedInspection(),
      findings: [],
      changes,
    });
    mocks.pages
      .mockReset()
      .mockResolvedValueOnce(pages())
      .mockResolvedValue(addedPages());
  };

  it("renders and audits every actual output slide and exposes an after-only added preview", async () => {
    prepareOutput();
    mocks.call
      .mockReset()
      .mockResolvedValueOnce(resultCall(plan))
      .mockResolvedValueOnce(resultCall({ ...audit, reviewedSlides: [1, 2] }));
    const result = await convertPowerPoint(input, "test.pptx");
    if ("error" in result) throw new Error(result.error);
    expect(result.pageCount).toBe(2);
    expect(result.errors).toEqual([]);
    expect(result.calls).toHaveLength(2);
    expect(mocks.call.mock.calls[1][1]).toContainEqual(
      expect.objectContaining({
        type: "text",
        text: expect.stringContaining("ACTUAL REPAIRED slide 2"),
      })
    );
    expect(mocks.call.mock.calls[1][1]).not.toContainEqual(
      expect.objectContaining({
        type: "text",
        text: expect.stringContaining(
          "ORIGINAL slide 1 before visible changes"
        ),
      })
    );
    expect(
      result.reviewPreviews?.map((preview) => preview.slideNumber)
    ).toEqual([1, 2]);
    expect(result.reviewPreviews?.[1]).not.toHaveProperty("before");
    expect(result.reviewPreviews?.[1].after).toMatch(
      /^data:image\/jpeg;base64,/
    );
  });

  it("retains an incomplete-audit warning when the auditor misses the appended slide", async () => {
    prepareOutput();
    const result = await convertPowerPoint(input, "test.pptx");
    if ("error" in result) throw new Error(result.error);
    expect(
      result.errors.some((finding) =>
        finding.message.includes("independent AI review")
      )
    ).toBe(true);
    expect(result.calls).toHaveLength(2);
  });

  it("trims empty appended-slide correction entries before replaying against the original", async () => {
    prepareOutput();
    mocks.repair
      .mockResolvedValueOnce({
        buffer: output,
        inspection: addedInspection(),
        findings: [],
        changes,
      })
      .mockResolvedValue({
        buffer: Buffer.from("corrected with added slide"),
        inspection: addedInspection(),
        findings: [],
        changes,
      });
    mocks.call
      .mockReset()
      .mockResolvedValueOnce(resultCall(plan))
      .mockResolvedValueOnce(
        resultCall({
          ...audit,
          reviewedSlides: [1, 2],
          correctivePlan: {
            slides: [
              {
                slideNumber: 1,
                decorativeObjects: [{ objectId: "2", decorative: false }],
              },
              { slideNumber: 2 },
            ],
          },
        })
      )
      .mockResolvedValueOnce(resultCall({ ...audit, reviewedSlides: [1, 2] }));
    const result = await convertPowerPoint(input, "test.pptx");
    if ("error" in result) throw new Error(result.error);
    expect(mocks.tracked).toHaveBeenCalledTimes(2);
    expect(
      mocks.tracked.mock.calls[1][1].slides.map(
        (slide: { slideNumber: number }) => slide.slideNumber
      )
    ).toEqual([1]);
    expect(result.calls).toHaveLength(3);
    expect(result.errors).toEqual([]);
  });

  it("allows original-slide decorative corrections but rejects edits to appended slides or additional descriptions", () => {
    const repair = { objectId: "2", decorative: false };
    expect(
      completePowerPointCorrection(
        {
          slides: [
            { slideNumber: 1, decorativeObjects: [repair] },
            { slideNumber: 2 },
          ],
        },
        addedInspection(),
        1
      )
    ).toBe(true);
    expect(
      completePowerPointCorrection(
        {
          slides: [
            { slideNumber: 1 },
            { slideNumber: 2, decorativeObjects: [repair] },
          ],
        },
        addedInspection(),
        1
      )
    ).toBe(false);
    expect(
      completePowerPointCorrection(
        {
          slides: [
            {
              slideNumber: 1,
              longDescriptions: [
                {
                  objectId: "2",
                  title: "Chart description",
                  summary: "Chart details on the description slide.",
                  paragraphs: ["The chart contains ten observations."],
                },
              ],
            },
            { slideNumber: 2 },
          ],
        },
        addedInspection(),
        1
      )
    ).toBe(false);
  });

  it("audits all slides of a replayed selection without regenerating declined changes", async () => {
    mocks.inspect
      .mockResolvedValueOnce(inspection)
      .mockResolvedValueOnce(addedInspection());
    mocks.pages
      .mockReset()
      .mockResolvedValueOnce(pages())
      .mockResolvedValueOnce(addedPages());
    mocks.call
      .mockReset()
      .mockResolvedValueOnce(resultCall({ ...audit, reviewedSlides: [1, 2] }));
    const result = await recheckPowerPointRevision(input, output, changes);
    if ("error" in result) throw new Error(result.error);
    expect(result.errors).toEqual([]);
    expect(result.pageCount).toBe(2);
    expect(result.calls).toHaveLength(1);
    expect(mocks.repair).not.toHaveBeenCalled();
    expect(result.reviewPreviews?.[1]).not.toHaveProperty("before");
  });

  it.each([
    "unrecorded",
    "duplicate",
    "outside-output",
    "source-renamed",
    "unknown-source-object",
  ])(
    "rejects %s appended-slide evidence before model work",
    async (scenario) => {
      const candidate = addedInspection();
      const declared = structuredClone(changes);
      if (scenario === "unrecorded") declared.length = 0;
      if (scenario === "duplicate") declared[0].generatedSlideNumbers = [2, 2];
      if (scenario === "outside-output")
        declared[0].generatedSlideNumbers = [3];
      if (scenario === "source-renamed")
        candidate.slides[0].partName = "ppt/slides/swapped.xml";
      if (scenario === "unknown-source-object") declared[0].objectId = "999";
      mocks.inspect
        .mockResolvedValueOnce(inspection)
        .mockResolvedValueOnce(candidate);
      const result = await recheckPowerPointRevision(input, output, declared);
      expect(result).toMatchObject({
        diagnostic: { code: "pptx_invalid_plan" },
        calls: [],
      });
      expect(mocks.render).not.toHaveBeenCalled();
      expect(mocks.call).not.toHaveBeenCalled();
    }
  );

  it("requires trusted generated-slide identities for previews without an original", async () => {
    await expect(
      buildPowerPointReviewPreviews(pages(), addedPages(), [2])
    ).rejects.toHaveProperty("code", "pptx_invalid_plan");
    const preview = await buildPowerPointReviewPreviews(
      pages(),
      addedPages(),
      [2],
      [2]
    );
    expect(preview[0]).not.toHaveProperty("before");
    await expect(
      buildPowerPointReviewPreviews(
        { pageCount: 1, pages: [] },
        pages(),
        [1],
        [1]
      )
    ).rejects.toHaveProperty("code", "pptx_invalid_plan");
  });
});

describe("PowerPoint evidence boundaries", () => {
  it("creates distinct bounded before/after previews for selected slides", async () => {
    const before = createCanvas(1600, 900);
    before.getContext("2d").fillRect(0, 0, 1600, 900);
    const after = createCanvas(1600, 900);
    const previews = await buildPowerPointReviewPreviews(
      pages(before.toBuffer("image/png")),
      pages(after.toBuffer("image/png")),
      [1, 1, 99]
    );
    expect(previews).toHaveLength(1);
    expect(previews[0].before).not.toEqual(previews[0].after);
    expect(previews[0].before!.length + previews[0].after.length).toBeLessThan(
      8_000_000
    );
  });
  const raster = (edit?: (data: Uint8ClampedArray) => void) => {
    const canvas = createCanvas(400, 400);
    const context = canvas.getContext("2d");
    context.fillStyle = "white";
    context.fillRect(0, 0, 400, 400);
    // A dark line acts as a text/diagram edge in an otherwise unchanged slide.
    context.fillStyle = "#203040";
    context.fillRect(20, 20, 250, 1);
    const pixels = context.getImageData(0, 0, 400, 400);
    edit?.(pixels.data);
    context.putImageData(pixels, 0, 0);
    return {
      ...pages(),
      pages: [
        {
          ...pages().pages[0],
          width: 400,
          height: 400,
          png: canvas.toBuffer("image/png"),
        },
      ],
    };
  };

  it("accepts sparse low-amplitude edge noise while preserving the slide", async () => {
    const noisy = raster((data) => {
      for (let x = 20; x < 60; x++) {
        const offset = (20 * 400 + x) * 4;
        data[offset] += x < 24 ? 20 : 1;
      }
    });
    expect(await changedPowerPointSlides(raster(), noisy)).toEqual([]);
  });

  const tableSource: PptxInspection = {
    ...inspection,
    slides: [
      {
        ...inspection.slides[0],
        objects: [
          ...inspection.slides[0].objects,
          {
            ...inspection.slides[0].objects[0],
            id: "3",
            kind: "table",
            isTitle: false,
            rect: { x: 5, y: 5, width: 60, height: 40 },
          },
        ],
      },
    ],
  };
  const tableChange: PptxChange = {
    type: "table-caption",
    slideNumber: 1,
    objectId: "3",
    message: "Separated caption and added column headers.",
    visualRegion: { x: 5, y: 5, width: 60, height: 10 },
  };

  it("permits an intentional caption repair but still detects changes to table data and other slide objects", async () => {
    const repairs = { source: tableSource, changes: [tableChange] };
    const captionOnly = raster((data) =>
      data.set([255, 255, 255, 255], (20 * 400 + 20) * 4)
    );
    expect(
      await changedPowerPointSlides(raster(), captionOnly, repairs)
    ).toEqual([]);
    for (const [x, y] of [
      [100, 90],
      [350, 350],
    ]) {
      const damaged = raster((data) =>
        data.set([0, 0, 0, 255], (y * 400 + x) * 4)
      );
      expect(await changedPowerPointSlides(raster(), damaged, repairs)).toEqual(
        [1]
      );
    }
    // Merely claiming a nonstructural edit never exempts its rectangle.
    expect(
      await changedPowerPointSlides(raster(), captionOnly, {
        source: tableSource,
        changes: [{ ...tableChange, type: "table-header" }],
      })
    ).toEqual([1]);
  });

  it("rejects a repair region that extends beyond the original table", async () => {
    const altered = raster((data) => data.set([0, 0, 0, 255], 0));
    await expect(
      changedPowerPointSlides(raster(), altered, {
        source: tableSource,
        changes: [
          {
            ...tableChange,
            visualRegion: { x: 0, y: 0, width: 100, height: 100 },
          },
        ],
      })
    ).rejects.toThrow("pptx_visual_change");
  });

  it("sends the actual structurally repaired slide image to the audit", async () => {
    const source = raster();
    const candidate = raster((data) =>
      data.set([255, 255, 255, 255], (20 * 400 + 20) * 4)
    );
    mocks.inspect.mockResolvedValue(tableSource);
    mocks.repair.mockResolvedValue({
      buffer: output,
      inspection: tableSource,
      findings: [],
      changes: [tableChange],
    });
    mocks.pages
      .mockReset()
      .mockResolvedValueOnce(source)
      .mockResolvedValueOnce(candidate);
    const result = await convertPowerPoint(input, "table.pptx");
    expect(result).not.toHaveProperty("error");
    const evidence = mocks.call.mock.calls[1][1];
    expect(evidence).toContainEqual(
      expect.objectContaining({
        type: "text",
        text: expect.stringContaining("ACTUAL REPAIRED slide 1"),
      })
    );
    expect(evidence).toContainEqual({
      type: "image_url",
      image_url: {
        detail: "high",
        url: `data:image/png;base64,${candidate.pages[0].png.toString("base64")}`,
      },
    });
  });

  it("retains a deterministic missing-header error when the model audit reports no issues", async () => {
    mocks.repair.mockResolvedValue({
      buffer: output,
      inspection: tableSource,
      changes: [],
      findings: [
        {
          code: "missing-table-header",
          severity: "error",
          slideNumber: 1,
          objectId: "3",
          message: "This table has no header row identified.",
          suggestion: "Add meaningful column headings and select Header Row.",
        },
      ],
    });
    const result = await convertPowerPoint(input, "table.pptx");
    if ("error" in result) throw new Error(result.error);
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        severity: "error",
        message: "This table has no header row identified.",
        location: expect.objectContaining({
          sourcePages: [1],
          sourceKind: "slide",
        }),
      })
    );
  });

  it.each([
    [
      "removed diagram edge",
      (data: Uint8ClampedArray) => {
        data.set([255, 255, 255, 255], (20 * 400 + 20) * 4);
      },
    ],
    [
      "widespread color shift",
      (data: Uint8ClampedArray) => {
        for (let x = 20; x < 120; x++) data[(20 * 400 + x) * 4]++;
      },
    ],
    [
      "concentrated visible edge changes",
      (data: Uint8ClampedArray) => {
        for (let x = 20; x < 40; x++) data[(20 * 400 + x) * 4] += 10;
      },
    ],
    [
      "changed opacity",
      (data: Uint8ClampedArray) => {
        data[(20 * 400 + 20) * 4 + 3] = 250;
      },
    ],
  ])("rejects %s", async (_label, edit) => {
    expect(await changedPowerPointSlides(raster(), raster(edit))).toEqual([1]);
  });

  it("rejects nonexisting slides/objects and duplicated coverage", () => {
    expect(
      completePowerPointPlan(
        { slides: [{ slideNumber: 1 }, { slideNumber: 1 }] },
        inspection
      )
    ).toBe(false);
    expect(
      parsePowerPointFindings(
        [
          {
            code: "manual-review",
            severity: "warning",
            slideNumber: 2,
            message: "Issue",
            suggestion: "Check",
          },
        ],
        inspection
      )
    ).toBeNull();
    expect(
      parsePowerPointFindings(
        [
          {
            code: "manual-review",
            severity: "warning",
            slideNumber: 1,
            objectId: "99",
            message: "Issue",
            suggestion: "Check",
          },
        ],
        inspection
      )
    ).toBeNull();
  });
  it("does not mistake matching PNG bytes with different slide dimensions for equal layout", async () => {
    expect(
      await changedPowerPointSlides(pages(), {
        ...pages(),
        pages: [{ ...pages().pages[0], width: 2 }],
      })
    ).toEqual([1]);
  });
});
