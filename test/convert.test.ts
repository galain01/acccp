import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AccessibilityError } from "@/lib/convert";
import type { LiteLLMConfig, LiteLLMContentPart } from "@/lib/litellm";
import type { RenderedPdf } from "@/lib/pdf-rendering";

// Defaults to the real formatter so most tests exercise actual pretty-printing;
// individual tests can override with mockRejectedValueOnce/mockImplementationOnce.
const prettierFormatMock = vi.fn();
vi.mock("prettier", async () => {
  const actual = await vi.importActual<typeof import("prettier")>("prettier");
  prettierFormatMock.mockImplementation(actual.format);
  return {
    ...actual,
    format: prettierFormatMock,
  };
});

const callLiteLLMMock = vi.fn();
const fetchModelPricingMock = vi.fn();
const getLiteLLMConfigMock = vi.fn();
const renderPdfPagesMock = vi.fn();
vi.mock("../lib/pdf-rendering", async () => ({
  ...(await vi.importActual<typeof import("../lib/pdf-rendering")>(
    "../lib/pdf-rendering"
  )),
  renderPdfPages: renderPdfPagesMock,
}));

vi.mock("../lib/litellm", async () => {
  const actual =
    await vi.importActual<typeof import("../lib/litellm")>("../lib/litellm");
  return {
    ...actual,
    callLiteLLM: callLiteLLMMock,
    fetchModelPricing: fetchModelPricingMock,
    getLiteLLMConfig: getLiteLLMConfigMock,
  };
});

const TEST_CONFIG: LiteLLMConfig = {
  baseUrl: "https://litellm.test",
  apiKey: "test-key",
  model: "test-model",
};

const PDF_BYTES = Buffer.from("%PDF-1.7\nmock pdf bytes\n%%EOF");
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aP1sAAAAASUVORK5CYII=",
  "base64"
);
const RENDERED: RenderedPdf = {
  pageCount: 5,
  pages: Array.from({ length: 5 }, (_, index) => ({
    pageNumber: index + 1,
    width: 1,
    height: 1,
    png: TINY_PNG,
    text: null,
  })),
};
const SOURCE = { buffer: PDF_BYTES, filename: "test.pdf", rendered: RENDERED };
const EMPTY_HEADING_REVIEW = {
  pagesReviewed: [1, 2, 3, 4, 5],
  sourceHeadings: [],
  unmatchedHtmlHeadingIds: [],
};
function completedAudit(
  findings: unknown[] = [],
  headingReview: unknown = EMPTY_HEADING_REVIEW
) {
  return JSON.stringify({ headingReview, findings });
}
function expectCompleteSourceParts(parts: LiteLLMContentPart[]) {
  expect(parts.filter((part) => part.type === "file")).toEqual([
    {
      type: "file",
      file: {
        filename: "test.pdf",
        file_data: `data:application/pdf;base64,${PDF_BYTES.toString("base64")}`,
      },
    },
  ]);
  expect(parts.filter((part) => part.type === "image_url")).toEqual(
    RENDERED.pages.map((page) => ({
      type: "image_url",
      image_url: {
        url: `data:image/png;base64,${page.png.toString("base64")}`,
        detail: "high",
      },
    }))
  );
  const pageLabels = parts.flatMap((part, index) =>
    part.type === "image_url" ? [parts[index - 1]] : []
  );
  expect(pageLabels).toHaveLength(RENDERED.pageCount);
  for (const [index, label] of pageLabels.entries()) {
    if (label?.type !== "text") throw new Error("Missing image page label");
    expect(label.text).toContain(`page ${index + 1} of ${RENDERED.pageCount}`);
  }
}

beforeEach(() => {
  getLiteLLMConfigMock.mockReset().mockReturnValue(TEST_CONFIG);
  renderPdfPagesMock.mockReset().mockResolvedValue(RENDERED);
});

const VALID_FINDING: AccessibilityError = {
  type: "missing-alt",
  severity: "error",
  message: "The diagram is missing alternate text.",
  suggestion: "Add alternate text describing the diagram.",
};

// Imported after the mocks above so convert.ts picks up the mocked module.
const { convertPdf, validateWithAI } = await import("../lib/convert");
const { LiteLLMError } = await import("../lib/litellm");

describe("validateWithAI", () => {
  beforeEach(() => {
    callLiteLLMMock.mockReset();
  });

  it("sends the exact PDF and measured page count with the output HTML", async () => {
    callLiteLLMMock.mockResolvedValueOnce({
      content: completedAudit(),
      model: "test-model",
      promptTokens: 10,
      completionTokens: 2,
    });
    await validateWithAI("<p>Course schedule</p>", TEST_CONFIG, SOURCE);
    expectCompleteSourceParts(callLiteLLMMock.mock.calls[0][1]);
    expect(callLiteLLMMock.mock.calls[0][1][0].text).toContain(
      "<p>Course schedule</p>"
    );
    expect(callLiteLLMMock.mock.calls[0][1][0].text).toContain("page count: 5");
  });

  it.each(["length", "content_filter", "tool_calls"])(
    "does not accept even valid JSON as a completed audit after %s",
    async (finishReason) => {
      const response = {
        content: completedAudit(),
        model: "test-model",
        promptTokens: 10,
        completionTokens: 2,
        finishReason,
      };
      callLiteLLMMock.mockResolvedValueOnce(response);
      const result = await validateWithAI(
        "<p>Course schedule</p>",
        TEST_CONFIG,
        SOURCE
      );
      expect(result.call).toEqual(response);
      expect(result.errors).toEqual([
        expect.objectContaining({
          title: "The document check is incomplete",
          location: expect.objectContaining({
            scope: "document",
            sourcePages: null,
          }),
        }),
      ]);
    }
  );

  it("keeps a usable finding when optional metadata is malformed or not present in the HTML", async () => {
    callLiteLLMMock.mockResolvedValueOnce({
      content: completedAudit([
        {
          ...VALID_FINDING,
          element: "<h2>Invented</h2>",
          wcag: 1.1,
          category: {},
          title: [],
          location: {
            sourcePages: [6],
            section: "Course schedule",
            locator: "first row",
          },
        },
      ]),
      model: "test-model",
      promptTokens: 10,
      completionTokens: 2,
    });
    const { errors } = await validateWithAI(
      "<p>Course schedule</p>",
      TEST_CONFIG,
      SOURCE
    );
    expect(errors).toEqual([
      {
        ...VALID_FINDING,
        location: {
          scope: "element",
          sourcePages: null,
          printedPageLabel: null,
          section: "Course schedule",
          locator: "first row",
          quote: null,
        },
      },
    ]);
  });

  it("retains a valid source location with a matching HTML snippet", async () => {
    const location = {
      scope: "element",
      sourcePages: [5],
      printedPageLabel: "3",
      section: "Course schedule",
      locator: "first row",
      quote: "Due date",
    };
    const finding = {
      ...VALID_FINDING,
      title: "Describe the course diagram",
      category: "accessibility",
      element: "<p>Due date</p>",
      location,
    };
    callLiteLLMMock.mockResolvedValueOnce({
      content: completedAudit([finding]),
      model: "test-model",
      promptTokens: 10,
      completionTokens: 2,
    });
    const { errors } = await validateWithAI(
      "<p>Due date</p>",
      TEST_CONFIG,
      SOURCE
    );
    expect(errors).toEqual([finding]);
  });

  it("bounds finding locations by the rendered page count", async () => {
    callLiteLLMMock.mockResolvedValueOnce({
      content: completedAudit(
        [
          {
            ...VALID_FINDING,
            location: {
              sourcePages: [5],
              printedPageLabel: "3",
              quote: "Due date",
            },
          },
        ],
        { ...EMPTY_HEADING_REVIEW, pagesReviewed: [1, 2, 3] }
      ),
      model: "test-model",
      promptTokens: 10,
      completionTokens: 2,
    });
    const { errors } = await validateWithAI("<p>Due date</p>", TEST_CONFIG, {
      ...SOURCE,
      rendered: { pageCount: 3, pages: RENDERED.pages.slice(0, 3) },
    });
    expect(errors[0].location).toMatchObject({
      sourcePages: null,
      printedPageLabel: null,
      quote: "Due date",
    });
    expect(callLiteLLMMock.mock.calls[0][1][0].text).toContain("page count: 3");
  });

  it("preserves supported finding types, severities, and optional strings", async () => {
    const types: AccessibilityError["type"][] = [
      "missing-alt",
      "bad-link",
      "no-table-caption",
      "no-table-headers",
      "missing-list-markup",
      "color-only-meaning",
      "non-descriptive-link",
      "missing-image",
      "missing-link",
      "other",
    ];
    const findings: AccessibilityError[] = types.map((type, index) => ({
      ...VALID_FINDING,
      type,
      severity: index % 2 === 0 ? "error" : "warning",
      ...(index === 0
        ? { element: '<img src="diagram.png">', wcag: "WCAG 1.1.1" }
        : {}),
    }));
    const response = {
      content: completedAudit(findings),
      model: "test-model",
      promptTokens: 10,
      completionTokens: 5,
    };
    callLiteLLMMock.mockResolvedValueOnce(response);

    const { errors, call } = await validateWithAI(
      '<img src="diagram.png">',
      TEST_CONFIG,
      SOURCE
    );

    expect(errors).toEqual(findings);
    expect(call).toEqual(response);
  });

  it.each([
    ["malformed JSON", "not valid json"],
    ["an object", '{"not":"an array"}'],
    ["a legacy empty array", "[]"],
    ["a legacy findings array", JSON.stringify([VALID_FINDING])],
    ["null", "null"],
    ["a string", '"no issues"'],
    ["a number", "0"],
    ["a boolean", "false"],
  ])(
    "warns and retains usage when the audit returns %s",
    async (_, content) => {
      const response = {
        content,
        model: "test-model",
        promptTokens: 8,
        completionTokens: 2,
      };
      callLiteLLMMock.mockResolvedValueOnce(response);

      const { errors, call } = await validateWithAI(
        "<p>html</p>",
        TEST_CONFIG,
        SOURCE
      );

      expect(errors).toEqual([
        expect.objectContaining({
          type: "other",
          severity: "warning",
          message: expect.any(String),
          title: "The document check is incomplete",
          suggestion: expect.stringMatching(
            /ask your campus accessibility support team/i
          ),
        }),
      ]);
      expect(call).toEqual(response);
    }
  );

  it("accepts an empty findings array only with a complete heading review", async () => {
    callLiteLLMMock.mockResolvedValueOnce({
      content: completedAudit(),
      model: "test-model",
      promptTokens: 1,
      completionTokens: 1,
    });

    const { errors } = await validateWithAI("<p>html</p>", TEST_CONFIG, SOURCE);
    expect(errors).toEqual([]);
  });

  it.each([
    ["missing", null],
    [
      "missing a rendered page",
      { ...EMPTY_HEADING_REVIEW, pagesReviewed: [1, 2, 3, 4] },
    ],
    [
      "claiming an unknown HTML heading",
      { ...EMPTY_HEADING_REVIEW, unmatchedHtmlHeadingIds: ["h99"] },
    ],
  ])(
    "keeps useful findings and warns when heading review is %s",
    async (_, headingReview) => {
      const response = {
        content: completedAudit([VALID_FINDING], headingReview),
        model: "test-model",
        promptTokens: 10,
        completionTokens: 4,
      };
      callLiteLLMMock.mockResolvedValueOnce(response);
      const result = await validateWithAI(
        "<p>Course schedule</p>",
        TEST_CONFIG,
        SOURCE
      );
      expect(result.errors).toEqual([
        VALID_FINDING,
        expect.objectContaining({
          title: "The document check is incomplete",
          severity: "warning",
        }),
      ]);
      expect(result.call).toEqual(response);
    }
  );

  it("withholds output heading ranks, attributes and comments from the audit model", async () => {
    const html =
      '<section><h2 class="private-rank-hint">Course overview</h2><h4 id="rank-four">Lab steps</h4><p>Preserved passage.</p><!-- HEADING REVIEW REQUIRED: use h4; private-comment-evidence --></section>';
    callLiteLLMMock.mockResolvedValueOnce({
      content: completedAudit([], {
        ...EMPTY_HEADING_REVIEW,
        sourceHeadings: [
          {
            id: "s1",
            page: 1,
            text: "Course overview",
            parentId: null,
            rank: 1,
            certainty: "supported",
            evidence: "Document title above the teaching content.",
            htmlHeadingIds: ["h1"],
          },
          {
            id: "s2",
            page: 1,
            text: "Lab steps",
            parentId: "s1",
            rank: 2,
            certainty: "supported",
            evidence: "Subsection introducing the lab instructions.",
            htmlHeadingIds: ["h2"],
          },
        ],
      }),
      model: "test-model",
      promptTokens: 10,
      completionTokens: 4,
    });
    await validateWithAI(html, TEST_CONFIG, SOURCE);
    const parts = callLiteLLMMock.mock.calls[0][1] as LiteLLMContentPart[];
    const visibleText = parts
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n");
    expect(visibleText).toContain('data-audit-heading-id="h1"');
    expect(visibleText).toContain('data-audit-heading-id="h2"');
    expect(visibleText).toMatch(/"id"\s*:\s*"h1"/);
    expect(visibleText).toMatch(/"text"\s*:\s*"Course overview"/);
    expect(visibleText).toContain("<p>Preserved passage.</p>");
    expect(visibleText).not.toMatch(/<\/?h[1-6]\b|"level"\s*:|"parentId"\s*:/i);
    expect(visibleText).not.toContain("private-rank-hint");
    expect(visibleText).not.toContain("rank-four");
    expect(visibleText).not.toContain("private-comment-evidence");
  });

  it("keeps known HTML defects and useful findings when structured heading review is missing", async () => {
    callLiteLLMMock.mockResolvedValueOnce({
      content: completedAudit([VALID_FINDING], null),
      model: "test-model",
      promptTokens: 10,
      completionTokens: 4,
    });
    const { errors } = await validateWithAI(
      "<h1>Title</h1><h4></h4>",
      TEST_CONFIG,
      SOURCE
    );
    expect(errors[0]).toEqual(VALID_FINDING);
    expect(errors.map((finding) => finding.type)).toEqual([
      "missing-alt",
      "h1-present",
      "empty-heading",
      "heading-skip",
      "other",
    ]);
    expect(errors.at(-1)?.title).toBe("The document check is incomplete");
  });

  it("ignores model claims about heading markup that was hidden from the model", async () => {
    callLiteLLMMock.mockResolvedValueOnce({
      content: completedAudit(
        ["h1-present", "heading-skip", "empty-heading"].map((type) => ({
          ...VALID_FINDING,
          type,
        }))
      ),
      model: "test-model",
      promptTokens: 10,
      completionTokens: 4,
    });
    const { errors } = await validateWithAI(
      "<p>No headings here.</p>",
      TEST_CONFIG,
      SOURCE
    );
    expect(errors).toEqual([]);
  });

  it.each([
    ["null", null],
    ["a number", 7],
    ["a string", "missing-alt"],
    ["a boolean", false],
    ["an array", []],
    ["missing required fields", {}],
    ["an unsupported type", { ...VALID_FINDING, type: "unknown-rule" }],
    ["an unsupported severity", { ...VALID_FINDING, severity: "info" }],
    ["a blank message", { ...VALID_FINDING, message: " \t\n" }],
    ["a blank suggestion", { ...VALID_FINDING, suggestion: "" }],
    ["a non-string message", { ...VALID_FINDING, message: 42 }],
    ["a non-string suggestion", { ...VALID_FINDING, suggestion: null }],
  ])(
    "replaces an invalid finding containing %s with a review warning",
    async (_, finding) => {
      callLiteLLMMock.mockResolvedValueOnce({
        content: completedAudit([finding]),
        model: "test-model",
        promptTokens: 8,
        completionTokens: 2,
      });

      const { errors } = await validateWithAI(
        "<p>html</p>",
        TEST_CONFIG,
        SOURCE
      );

      expect(errors).toEqual([
        expect.objectContaining({
          type: "other",
          severity: "warning",
          title: "The document check is incomplete",
          suggestion: expect.stringMatching(
            /ask your campus accessibility support team/i
          ),
        }),
      ]);
    }
  );

  it("retains valid findings in order and appends one warning for multiple invalid entries", async () => {
    const secondFinding: AccessibilityError = {
      type: "bad-link",
      severity: "warning",
      message: "The guide link has no usable destination.",
      suggestion: "Add the intended guide address.",
      element: '<a href="#">Guide</a>',
    };
    callLiteLLMMock.mockResolvedValueOnce({
      content: completedAudit([
        null,
        VALID_FINDING,
        {},
        secondFinding,
        "invalid",
      ]),
      model: "test-model",
      promptTokens: 8,
      completionTokens: 2,
    });

    const { errors } = await validateWithAI(
      '<p>html</p><a href="#">Guide</a>',
      TEST_CONFIG,
      SOURCE
    );

    expect(errors).toEqual([
      VALID_FINDING,
      secondFinding,
      expect.objectContaining({ type: "other", severity: "warning" }),
    ]);
  });
});

describe("convertPdf", () => {
  beforeEach(() => {
    callLiteLLMMock.mockReset();
    fetchModelPricingMock.mockReset();
  });

  it("selects each stage independently and keeps its actual model, tokens and cost", async () => {
    const conversionConfig = { ...TEST_CONFIG, model: "conversion-choice" };
    const auditConfig = { ...TEST_CONFIG, model: "audit-choice" };
    getLiteLLMConfigMock.mockImplementation((stage) =>
      stage === "convert" ? conversionConfig : auditConfig
    );
    callLiteLLMMock
      .mockResolvedValueOnce({
        content: "<p>converted</p>",
        model: "conversion-actual",
        promptTokens: 100,
        completionTokens: 50,
        responseCostUsd: 0.012,
      })
      .mockResolvedValueOnce({
        content: completedAudit(),
        model: "audit-actual",
        promptTokens: 80,
        completionTokens: 20,
        responseCostUsd: 0.002,
      });
    const result = await convertPdf(PDF_BYTES, "test.pdf");
    if ("error" in result) throw new Error(result.error);
    expect(getLiteLLMConfigMock.mock.calls).toEqual([
      ["convert"],
      ["validate"],
    ]);
    expect(callLiteLLMMock.mock.calls.map((call) => call[2])).toEqual([
      conversionConfig,
      auditConfig,
    ]);
    expect(result.model).toBe("conversion-actual");
    expect(result.calls).toEqual([
      expect.objectContaining({
        stage: "convert",
        model: "conversion-actual",
        costUsd: 0.012,
      }),
      expect.objectContaining({
        stage: "validate",
        model: "audit-actual",
        costUsd: 0.002,
      }),
    ]);
    expect(result.tokensUsed).toBe(250);
    expect(result.pageCount).toBe(RENDERED.pageCount);
    expect(fetchModelPricingMock).not.toHaveBeenCalled();
    expect(renderPdfPagesMock).toHaveBeenCalledExactlyOnceWith(PDF_BYTES);
  });

  it.each([
    ["a Word filename", PDF_BYTES, "test.docx"],
    ["an empty file", Buffer.alloc(0), "test.pdf"],
    ["a file without a PDF header", Buffer.from("not a PDF"), "test.pdf"],
    [
      "a file larger than 4 MiB",
      Buffer.concat([PDF_BYTES, Buffer.alloc(4 * 1024 * 1024)]),
      "test.pdf",
    ],
  ])("rejects %s before any model or pricing calls", async (_, bytes, name) => {
    const result = await convertPdf(bytes, name);

    expect(result).toHaveProperty("error");
    expect(renderPdfPagesMock).not.toHaveBeenCalled();
    expect(callLiteLLMMock).not.toHaveBeenCalled();
    expect(fetchModelPricingMock).not.toHaveBeenCalled();
  });

  it("does not make model or pricing calls when complete PDF rendering fails", async () => {
    renderPdfPagesMock.mockRejectedValueOnce(
      new Error("private-renderer-output and source contents")
    );
    const result = await convertPdf(PDF_BYTES, "private-source.pdf");
    expect(result).toMatchObject({ error: "Conversion failed", calls: [] });
    expect(renderPdfPagesMock).toHaveBeenCalledExactlyOnceWith(PDF_BYTES);
    expect(callLiteLLMMock).not.toHaveBeenCalled();
    expect(fetchModelPricingMock).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("private-renderer-output");
    expect(JSON.stringify(result)).not.toContain("private-source.pdf");
  });

  it.each([
    ["empty content", "", "stop"],
    ["whitespace-only content", " \t\n", "stop"],
    ["plain text instead of HTML", "The PDF is unavailable.", "stop"],
    ["truncated HTML", "<p>Incomplete content</p>", "length"],
    ["filtered HTML", "<p>Partial content</p>", "content_filter"],
  ])(
    "rejects %s while retaining its billable usage and skipping the audit",
    async (_, content, finishReason) => {
      callLiteLLMMock.mockResolvedValueOnce({
        content,
        finishReason,
        model: "test-model",
        promptTokens: 100,
        completionTokens: 50,
      });
      fetchModelPricingMock.mockResolvedValue(null);

      const result = await convertPdf(PDF_BYTES, "test.pdf");

      if (!("error" in result)) throw new Error("expected failure");
      expect(callLiteLLMMock).toHaveBeenCalledTimes(1);
      expect(result.calls).toEqual([
        {
          stage: "convert",
          model: "test-model",
          promptTokens: 100,
          completionTokens: 50,
          costUsd: null,
        },
      ]);
    }
  );

  it("returns one calls[] entry per stage whose tokens sum to tokensUsed", async () => {
    callLiteLLMMock
      .mockResolvedValueOnce({
        content: "<p>converted</p>",
        model: "test-model",
        promptTokens: 100,
        completionTokens: 50,
      })
      .mockResolvedValueOnce({
        content: completedAudit(),
        model: "test-model",
        promptTokens: 30,
        completionTokens: 10,
      });
    fetchModelPricingMock.mockResolvedValue({
      inputCostPerToken: 0.000002,
      outputCostPerToken: 0.000004,
    });

    const result = await convertPdf(PDF_BYTES, "test.pdf");

    if ("error" in result)
      throw new Error(`expected success, got: ${result.error}`);

    expect(result.calls).toHaveLength(2);
    expect(result.calls[0].stage).toBe("convert");
    expect(result.calls[1].stage).toBe("validate");
    expect(callLiteLLMMock).toHaveBeenCalledTimes(2);
    expectCompleteSourceParts(callLiteLLMMock.mock.calls[0][1]);
    expectCompleteSourceParts(callLiteLLMMock.mock.calls[1][1]);
    expect(callLiteLLMMock.mock.calls[1][1].slice(1)).toEqual(
      callLiteLLMMock.mock.calls[0][1].slice(1)
    );
    expect(renderPdfPagesMock).toHaveBeenCalledExactlyOnceWith(PDF_BYTES);
    expect(result.pageCount).toBe(RENDERED.pageCount);
    expect(callLiteLLMMock.mock.calls[1][1][0].text).toContain("page count: 5");

    const tokenSum = result.calls.reduce(
      (sum, call) => sum + call.promptTokens + call.completionTokens,
      0
    );
    expect(result.tokensUsed).toBe(tokenSum);
    expect(result.calls[0].costUsd).toBeCloseTo(
      100 * 0.000002 + 50 * 0.000004,
      10
    );
  });

  it("still reports calls[] made before a mid-pipeline failure", async () => {
    callLiteLLMMock
      .mockResolvedValueOnce({
        content: "<p>converted</p>",
        model: "test-model",
        promptTokens: 100,
        completionTokens: 50,
      })
      .mockRejectedValueOnce(new Error("LiteLLM error 500: boom"));
    fetchModelPricingMock.mockResolvedValue(null);

    const result = await convertPdf(PDF_BYTES, "test.pdf");

    if (!("error" in result)) throw new Error("expected failure");
    expect(result.calls ?? []).toHaveLength(1);
    expect(result.calls?.[0].stage).toBe("convert");
  });

  it.each([0, 0.003456])(
    "preserves gateway cost %s and skips pricing lookup for both stages",
    async (reportedCost) => {
      callLiteLLMMock
        .mockResolvedValueOnce({
          content: "<p>converted</p>",
          model: "test-model",
          promptTokens: 1_000,
          completionTokens: 50,
          cachedPromptTokens: 200,
          cacheCreationPromptTokens: 100,
          responseCostUsd: reportedCost,
        })
        .mockResolvedValueOnce({
          content: completedAudit(),
          model: "test-model",
          promptTokens: 30,
          completionTokens: 10,
          cachedPromptTokens: 0,
          cacheCreationPromptTokens: 0,
          responseCostUsd: 0,
        });
      // Even unavailable pricing cannot interfere with a reported amount.
      fetchModelPricingMock.mockRejectedValue(new Error("Pricing unavailable"));

      const result = await convertPdf(PDF_BYTES, "test.pdf");
      if ("error" in result) throw new Error(result.error);
      expect(fetchModelPricingMock).not.toHaveBeenCalled();
      expect(result.calls).toEqual([
        {
          stage: "convert",
          model: "test-model",
          promptTokens: 1_000,
          completionTokens: 50,
          cachedPromptTokens: 200,
          cacheCreationPromptTokens: 100,
          costUsd: reportedCost,
          costSource: "gateway",
        },
        {
          stage: "validate",
          model: "test-model",
          promptTokens: 30,
          completionTokens: 10,
          cachedPromptTokens: 0,
          cacheCreationPromptTokens: 0,
          costUsd: 0,
          costSource: "gateway",
        },
      ]);
      expect(result.tokensUsed).toBe(1_090); // Cache tokens are subsets of input.
    }
  );

  it.each([
    ["gateway", "model-info"],
    ["openai-list-price", "openai-list-price"],
  ] as const)(
    "integrates %s fallback rates, cache usage, and the %s cost source",
    async (pricingSource, costSource) => {
      callLiteLLMMock
        .mockResolvedValueOnce({
          content: "<p>converted</p>",
          model: "test-model",
          promptTokens: 1_000,
          completionTokens: 50,
          cachedPromptTokens: 200,
          cacheCreationPromptTokens: 100,
        })
        .mockResolvedValueOnce({
          content: completedAudit(),
          model: "test-model",
          promptTokens: 30,
          completionTokens: 10,
          responseCostUsd: 0,
        });
      fetchModelPricingMock.mockResolvedValue({
        source: pricingSource,
        inputCostPerToken: 0.000004,
        cachedInputCostPerToken: 0.0000004,
        cacheCreationInputCostPerToken: 0.000005,
        outputCostPerToken: 0.00002,
      });

      const result = await convertPdf(PDF_BYTES, "test.pdf");
      if ("error" in result) throw new Error(result.error);
      expect(fetchModelPricingMock).toHaveBeenCalledExactlyOnceWith(
        "test-model",
        TEST_CONFIG
      );
      expect(result.calls[0]).toMatchObject({
        costSource,
        cachedPromptTokens: 200,
        cacheCreationPromptTokens: 100,
      });
      expect(result.calls[0].costUsd).toBeCloseTo(0.00438, 12);
      expect(result.calls[1]).toMatchObject({
        costUsd: 0,
        costSource: "gateway",
      });
    }
  );

  it("keeps unpriced calls unknown while retaining known cache zeroes", async () => {
    callLiteLLMMock
      .mockResolvedValueOnce({
        content: "<p>converted</p>",
        model: "unknown-model",
        promptTokens: 100,
        completionTokens: 50,
        cachedPromptTokens: 0,
        cacheCreationPromptTokens: 0,
      })
      .mockResolvedValueOnce({
        content: completedAudit(),
        model: "unknown-model",
        promptTokens: 30,
        completionTokens: 10,
      });
    fetchModelPricingMock.mockResolvedValue(null);

    const result = await convertPdf(PDF_BYTES, "test.pdf");
    if ("error" in result) throw new Error(result.error);
    expect(result.calls[0]).toMatchObject({
      costUsd: null,
      cachedPromptTokens: 0,
      cacheCreationPromptTokens: 0,
    });
    for (const call of result.calls)
      expect(call).not.toHaveProperty("costSource");
    expect(result.calls[1]).not.toHaveProperty("cachedPromptTokens");
    expect(result.calls[1]).not.toHaveProperty("cacheCreationPromptTokens");
  });

  describe.each([
    ["negative", -1, 10],
    ["fractional", 20, 1.5],
    ["outside the database integer range", 2_147_483_648, 0],
    ["combined cache usage exceeds the prompt", 80, 30],
  ])(
    "invalid cache metadata: %s",
    (_, cachedPromptTokens, cacheCreationPromptTokens) => {
      it.each([undefined, 0, 0.0123])(
        "drops the invalid pair without losing conversion or gateway cost %s",
        async (responseCostUsd) => {
          callLiteLLMMock
            .mockResolvedValueOnce({
              content: "<p>converted</p>",
              model: "test-model",
              promptTokens: 100,
              completionTokens: 50,
              cachedPromptTokens,
              cacheCreationPromptTokens,
              ...(responseCostUsd !== undefined ? { responseCostUsd } : {}),
            })
            .mockResolvedValueOnce({
              content: completedAudit(),
              model: "test-model",
              promptTokens: 30,
              completionTokens: 10,
              responseCostUsd: 0,
            });
          fetchModelPricingMock.mockResolvedValue({
            source: "gateway",
            inputCostPerToken: 0.000004,
            cachedInputCostPerToken: 0.0000004,
            cacheCreationInputCostPerToken: 0.000005,
            outputCostPerToken: 0.00002,
          });

          const result = await convertPdf(PDF_BYTES, "test.pdf");
          if ("error" in result) throw new Error(result.error);
          expect(result.html).toContain("<p>converted</p>");
          expect(result.tokensUsed).toBe(190);
          const call = result.calls[0];
          expect(call).not.toHaveProperty("cachedPromptTokens");
          expect(call).not.toHaveProperty("cacheCreationPromptTokens");
          if (responseCostUsd === undefined) {
            expect(call.costUsd).toBeCloseTo(0.0014, 12);
            expect(call.costSource).toBe("model-info");
            expect(fetchModelPricingMock).toHaveBeenCalledExactlyOnceWith(
              "test-model",
              TEST_CONFIG
            );
          } else {
            expect(call.costUsd).toBe(responseCostUsd);
            expect(call.costSource).toBe("gateway");
            expect(fetchModelPricingMock).not.toHaveBeenCalled();
          }
        }
      );
    }
  );

  it.each(["incomplete output", "audit failure"])(
    "retains gateway billing and cache metadata after %s",
    async (failure) => {
      callLiteLLMMock.mockResolvedValueOnce({
        content: "<p>converted</p>",
        model: "test-model",
        promptTokens: 100,
        completionTokens: 50,
        cachedPromptTokens: 20,
        cacheCreationPromptTokens: 10,
        responseCostUsd: 0.0123,
        finishReason: failure === "incomplete output" ? "length" : "stop",
      });
      if (failure === "audit failure")
        callLiteLLMMock.mockRejectedValueOnce(
          new Error("Private gateway diagnostics")
        );

      const result = await convertPdf(PDF_BYTES, "test.pdf");
      if (!("error" in result)) throw new Error("Expected failed conversion");
      expect(result.calls).toEqual([
        {
          stage: "convert",
          model: "test-model",
          promptTokens: 100,
          completionTokens: 50,
          cachedPromptTokens: 20,
          cacheCreationPromptTokens: 10,
          costUsd: 0.0123,
          costSource: "gateway",
        },
      ]);
      expect(fetchModelPricingMock).not.toHaveBeenCalled();
      expect(JSON.stringify(result)).not.toContain(
        "Private gateway diagnostics"
      );
      expect(callLiteLLMMock).toHaveBeenCalledTimes(
        failure === "audit failure" ? 2 : 1
      );
    }
  );

  it("keeps controlled provider diagnostics but omits arbitrary exception text", async () => {
    callLiteLLMMock.mockRejectedValueOnce(
      new LiteLLMError(
        "LiteLLM error 401: Check the API key and its access to the configured model."
      )
    );
    expect(await convertPdf(PDF_BYTES, "test.pdf")).toMatchObject({
      error: "Conversion failed",
      detail:
        "LiteLLM error 401: Check the API key and its access to the configured model.",
    });
    callLiteLLMMock.mockRejectedValueOnce(
      new Error("private-document-text; upstream-secret")
    );
    const failure = await convertPdf(PDF_BYTES, "test.pdf");
    expect(JSON.stringify(failure)).not.toContain("private-document-text");
    expect(JSON.stringify(failure)).not.toContain("upstream-secret");
  });

  it("preserves converted HTML, valid findings, and usage when some audit entries are invalid", async () => {
    callLiteLLMMock
      .mockResolvedValueOnce({
        content: "<p>converted</p>",
        model: "test-model",
        promptTokens: 100,
        completionTokens: 50,
      })
      .mockResolvedValueOnce({
        content: completedAudit([null, VALID_FINDING, { severity: "error" }]),
        model: "test-model",
        promptTokens: 30,
        completionTokens: 10,
      });
    fetchModelPricingMock.mockResolvedValue(null);

    const result = await convertPdf(PDF_BYTES, "test.pdf");

    if ("error" in result)
      throw new Error(`expected success, got: ${result.error}`);

    expect(result.html).toContain("<p>converted</p>");
    expect(result.errors).toEqual([
      VALID_FINDING,
      expect.objectContaining({
        type: "other",
        severity: "warning",
        title: "The document check is incomplete",
        suggestion: expect.stringMatching(
          /ask your campus accessibility support team/i
        ),
      }),
    ]);
    expect(result.calls).toEqual([
      {
        stage: "convert",
        model: "test-model",
        promptTokens: 100,
        completionTokens: 50,
        costUsd: null,
      },
      {
        stage: "validate",
        model: "test-model",
        promptTokens: 30,
        completionTokens: 10,
        costUsd: null,
      },
    ]);
    expect(result.tokensUsed).toBe(190);
  });

  it("flags every image placeholder even when the AI audit reports no issues", async () => {
    callLiteLLMMock
      .mockResolvedValueOnce({
        content:
          '<p>Course diagrams</p><img src="{{PLACEHOLDER:image1.png}}" alt="A process diagram"><img src="{{PLACEHOLDER:image2.png}}" alt="">',
        model: "test-model",
        promptTokens: 100,
        completionTokens: 50,
      })
      .mockResolvedValueOnce({
        content: completedAudit(),
        model: "test-model",
        promptTokens: 30,
        completionTokens: 10,
      });
    fetchModelPricingMock.mockResolvedValue(null);

    const result = await convertPdf(PDF_BYTES, "test.pdf");

    if ("error" in result)
      throw new Error(`expected success, got: ${result.error}`);

    expect(result.errors).toEqual([
      expect.objectContaining({
        type: "missing-image",
        severity: "warning",
        element: expect.stringContaining("{{PLACEHOLDER:image1.png}}"),
      }),
      expect.objectContaining({
        type: "missing-image",
        severity: "warning",
        element: expect.stringContaining("{{PLACEHOLDER:image2.png}}"),
      }),
    ]);
  });

  it("surfaces unreadable source content even when the output audit is clean", async () => {
    callLiteLLMMock
      .mockResolvedValueOnce({
        content:
          "<p>Visible passage.</p><!-- SOURCE TEXT REVIEW REQUIRED: page 3; bottom paragraph --><!-- LINK TARGET REQUIRED -->",
        model: "test-model",
        promptTokens: 100,
        completionTokens: 50,
      })
      .mockResolvedValueOnce({
        content: completedAudit(),
        model: "test-model",
        promptTokens: 30,
        completionTokens: 10,
      });
    fetchModelPricingMock.mockResolvedValue(null);

    const result = await convertPdf(PDF_BYTES, "test.pdf");
    if ("error" in result) throw new Error(result.error);
    expect(result.errors).toEqual([
      expect.objectContaining({
        type: "other",
        severity: "warning",
        location: expect.objectContaining({
          sourcePages: [3],
          locator: "bottom paragraph",
        }),
      }),
      expect.objectContaining({ type: "missing-link", severity: "warning" }),
    ]);
  });

  it.each([false, true])(
    "restores masked excerpts and merges only identifiable missing-link occurrences (ambiguous: %s)",
    async (ambiguous) => {
      const quotes = ambiguous
        ? ["Click here", "Click here"]
        : ["Read the guide.", "Open the workbook."];
      const html = quotes
        .map(
          (quote, index) =>
            `<p>${quote}<!-- LINK TARGET REQUIRED: PDF page ${index + 1}; section Resources; near reference ${index + 1}; the destination is not available --></p>`
        )
        .join("");
      // These fixtures already represent the post-format HTML supplied to stage 2.
      prettierFormatMock.mockResolvedValueOnce(html);
      const findings = quotes.map((quote, index) => ({
        type: "missing-link",
        severity: "error",
        category: "content-fidelity",
        title: `Add the ${index + 1 === 1 ? "guide" : "workbook"} link`,
        message: "The source link has no destination in the converted page.",
        suggestion: "Restore the destination from the original document.",
        element: `<p>${quote}</p>`,
        location: {
          scope: "element",
          sourcePages: [index + 1],
          printedPageLabel: null,
          section: "Resources",
          locator: `Paragraph ${index + 1}`,
          quote,
        },
      }));
      callLiteLLMMock
        .mockResolvedValueOnce({
          content: html,
          model: "test-model",
          promptTokens: 100,
          completionTokens: 50,
        })
        .mockResolvedValueOnce({
          content: completedAudit(findings),
          model: "test-model",
          promptTokens: 30,
          completionTokens: 10,
        });
      fetchModelPricingMock.mockResolvedValue(null);
      const result = await convertPdf(PDF_BYTES, "test.pdf");
      if ("error" in result) throw new Error(result.error);
      expect(result.html).toBe(html);
      expect(result.errors).toHaveLength(ambiguous ? 4 : 2);
      const audited = result.errors.filter(
        (finding) => finding.severity === "error"
      );
      expect(audited.map((finding) => finding.location)).toEqual(
        findings.map((finding) => finding.location)
      );
      if (ambiguous) {
        expect(audited.every((finding) => finding.element === undefined)).toBe(
          true
        );
      } else {
        expect(
          audited.every(
            (finding) => finding.element && html.includes(finding.element)
          )
        ).toBe(true);
        expect(audited[0].element).toContain("Read the guide.");
        expect(audited[1].element).toContain("Open the workbook.");
      }
    }
  );

  it("pretty-prints the AI's single-line HTML for easier review", async () => {
    callLiteLLMMock
      .mockResolvedValueOnce({
        content: "<div><p>one</p><ul><li>a</li><li>b</li></ul></div>",
        model: "test-model",
        promptTokens: 100,
        completionTokens: 50,
      })
      .mockResolvedValueOnce({
        content: completedAudit(),
        model: "test-model",
        promptTokens: 30,
        completionTokens: 10,
      });
    fetchModelPricingMock.mockResolvedValue(null);

    const result = await convertPdf(PDF_BYTES, "test.pdf");

    if ("error" in result)
      throw new Error(`expected success, got: ${result.error}`);
    expect(result.html.split("\n").length).toBeGreaterThan(1);
    expect(result.html).toContain("  <p>one</p>");
  });

  it("falls back to the unformatted HTML if formatting fails", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    prettierFormatMock.mockRejectedValueOnce(
      new Error("parse error containing private-document-text")
    );
    callLiteLLMMock
      .mockResolvedValueOnce({
        content: "<p>converted</p>",
        model: "test-model",
        promptTokens: 100,
        completionTokens: 50,
      })
      .mockResolvedValueOnce({
        content: completedAudit(),
        model: "test-model",
        promptTokens: 30,
        completionTokens: 10,
      });
    fetchModelPricingMock.mockResolvedValue(null);

    const result = await convertPdf(PDF_BYTES, "private-filename.pdf");

    if ("error" in result)
      throw new Error(`expected success, got: ${result.error}`);
    expect(result.html).toBe("<p>converted</p>");
    expect(JSON.stringify(warning.mock.calls)).not.toContain(
      "private-document-text"
    );
    expect(JSON.stringify(log.mock.calls)).not.toContain(
      "private-filename.pdf"
    );
    warning.mockRestore();
    log.mockRestore();
  });
});
