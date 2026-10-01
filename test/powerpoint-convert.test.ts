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
const input = Buffer.from("original-pptx");
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
    expect(previews[0].before.length + previews[0].after.length).toBeLessThan(
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
