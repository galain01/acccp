import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PptxInspection } from "../lib/pptx-types";

vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({
  inspect: vi.fn(),
  repair: vi.fn(),
  render: vi.fn(),
  pages: vi.fn(),
  call: vi.fn(),
}));
vi.mock("../lib/pptx-package", async (original) => ({
  ...(await original<typeof import("../lib/pptx-package")>()),
  inspectPptx: mocks.inspect,
  applyPptxRepairs: mocks.repair,
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
const audit = { reviewedSlides: [1], findings: [] };
const resultCall = (content: unknown) => ({
  content: JSON.stringify(content),
  model: "test-model",
  promptTokens: 100,
  completionTokens: 50,
  responseCostUsd: 0.01,
  finishReason: "stop",
});
const pages = (png: Buffer = Buffer.from("identical-png")) => ({
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
  vi.clearAllMocks();
  mocks.inspect.mockResolvedValue(inspection);
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
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].location?.sourceKind).toBe("slide");
    expect(mocks.call.mock.calls[0][0]).toContain("PowerPoint");
    expect(mocks.call.mock.calls[1][0]).toContain("independently audit");
    expect(mocks.call.mock.calls[0][0]).not.toContain(
      "Canvas HTML compatibility"
    );
    expect(mocks.render.mock.calls.map((c) => c[0])).toEqual([input, output]);
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

  it("rebuilds changed slides from original bytes and retains descriptions only", async () => {
    const blank = createCanvas(1, 1).toBuffer("image/png");
    const dark = createCanvas(1, 1);
    dark.getContext("2d").fillRect(0, 0, 1, 1);
    mocks.pages
      .mockReset()
      .mockResolvedValueOnce(pages(blank))
      .mockResolvedValueOnce(pages(dark.toBuffer("image/png")))
      .mockResolvedValueOnce(pages(blank));
    mocks.call
      .mockReset()
      .mockResolvedValueOnce(
        resultCall({
          slides: [{ slideNumber: 1, titleObjectId: "2", descriptions: [] }],
          findings: [],
        })
      )
      .mockResolvedValueOnce(resultCall(audit));
    const result = await convertPowerPoint(input, "test.pptx");
    if ("error" in result) throw new Error(result.error);
    expect(mocks.repair.mock.calls[1]).toEqual([
      input,
      { slides: [{ slideNumber: 1, descriptions: [] }] },
    ]);
    expect(
      result.errors.some((f) =>
        f.message.includes("changed this slide's appearance")
      )
    ).toBe(true);
  });

  it("does not return a file if fallback still changes the slide pixels", async () => {
    const blank = createCanvas(1, 1).toBuffer("image/png");
    const dark = createCanvas(1, 1);
    dark.getContext("2d").fillRect(0, 0, 1, 1);
    mocks.pages
      .mockReset()
      .mockResolvedValueOnce(pages(blank))
      .mockResolvedValue(pages(dark.toBuffer("image/png")));
    const result = await convertPowerPoint(input, "test.pptx");
    expect(result).toMatchObject({
      diagnostic: { code: "pptx_visual_change" },
    });
    expect(result).not.toHaveProperty("pptx");
  });
});

describe("PowerPoint evidence boundaries", () => {
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
      pages: [{ ...pages().pages[0], width: 400, height: 400, png: canvas.toBuffer("image/png") }],
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

  it.each([
    ["removed diagram edge", (data: Uint8ClampedArray) => {
      data.set([255, 255, 255, 255], (20 * 400 + 20) * 4);
    }],
    ["widespread color shift", (data: Uint8ClampedArray) => {
      for (let x = 20; x < 120; x++) data[(20 * 400 + x) * 4]++;
    }],
    ["concentrated visible edge changes", (data: Uint8ClampedArray) => {
      for (let x = 20; x < 40; x++) data[(20 * 400 + x) * 4] += 10;
    }],
    ["changed opacity", (data: Uint8ClampedArray) => {
      data[(20 * 400 + 20) * 4 + 3] = 250;
    }],
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
