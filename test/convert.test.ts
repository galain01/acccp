import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AccessibilityError } from "@/lib/convert";
import type { LiteLLMConfig } from "@/lib/litellm";

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

vi.mock("../lib/litellm", async () => {
  const actual =
    await vi.importActual<typeof import("../lib/litellm")>("../lib/litellm");
  return {
    ...actual,
    callLiteLLM: callLiteLLMMock,
    fetchModelPricing: fetchModelPricingMock,
    getLiteLLMConfig: () => TEST_CONFIG,
  };
});

const TEST_CONFIG: LiteLLMConfig = {
  baseUrl: "https://litellm.test",
  apiKey: "test-key",
  model: "test-model",
};

const PDF_BYTES = Buffer.from("%PDF-1.7\nmock pdf bytes\n%%EOF");

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

  it("preserves supported finding types, severities, and optional strings", async () => {
    const types: AccessibilityError["type"][] = [
      "missing-alt",
      "heading-skip",
      "bad-link",
      "no-table-caption",
      "no-table-headers",
      "missing-list-markup",
      "empty-heading",
      "color-only-meaning",
      "h1-present",
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
      content: JSON.stringify(findings),
      model: "test-model",
      promptTokens: 10,
      completionTokens: 5,
    };
    callLiteLLMMock.mockResolvedValueOnce(response);

    const { errors, call } = await validateWithAI("<p>html</p>", TEST_CONFIG);

    expect(errors).toEqual(findings);
    expect(call).toEqual(response);
  });

  it.each([
    ["malformed JSON", "not valid json"],
    ["an object", '{"not":"an array"}'],
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

      const { errors, call } = await validateWithAI("<p>html</p>", TEST_CONFIG);

      expect(errors).toEqual([
        expect.objectContaining({
          type: "other",
          severity: "warning",
          message: expect.any(String),
          suggestion: expect.stringMatching(/review.*manually/i),
        }),
      ]);
      expect(call).toEqual(response);
    }
  );

  it("accepts an empty findings array as a completed audit with no issues", async () => {
    callLiteLLMMock.mockResolvedValueOnce({
      content: "[]",
      model: "test-model",
      promptTokens: 1,
      completionTokens: 1,
    });

    const { errors } = await validateWithAI("<p>html</p>", TEST_CONFIG);
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
    ["a non-string element", { ...VALID_FINDING, element: {} }],
    ["a non-string WCAG value", { ...VALID_FINDING, wcag: 1.1 }],
  ])(
    "replaces an invalid finding containing %s with a review warning",
    async (_, finding) => {
      callLiteLLMMock.mockResolvedValueOnce({
        content: JSON.stringify([finding]),
        model: "test-model",
        promptTokens: 8,
        completionTokens: 2,
      });

      const { errors } = await validateWithAI("<p>html</p>", TEST_CONFIG);

      expect(errors).toEqual([
        expect.objectContaining({
          type: "other",
          severity: "warning",
          suggestion: expect.stringMatching(/review.*manually/i),
        }),
      ]);
    }
  );

  it("retains valid findings in order and appends one warning for multiple invalid entries", async () => {
    const secondFinding: AccessibilityError = {
      type: "empty-heading",
      severity: "warning",
      message: "The final heading is empty.",
      suggestion: "Remove the empty heading.",
      element: "<h2></h2>",
    };
    callLiteLLMMock.mockResolvedValueOnce({
      content: JSON.stringify([
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

    const { errors } = await validateWithAI("<p>html</p>", TEST_CONFIG);

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
    expect(callLiteLLMMock).not.toHaveBeenCalled();
    expect(fetchModelPricingMock).not.toHaveBeenCalled();
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
        content: "[]",
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
    expect(callLiteLLMMock.mock.calls[0][1]).toEqual([
      { type: "text", text: expect.any(String) },
      {
        type: "file",
        file: {
          filename: "test.pdf",
          file_data: `data:application/pdf;base64,${PDF_BYTES.toString("base64")}`,
        },
      },
    ]);
    expect(callLiteLLMMock.mock.calls[1][1]).toEqual(
      expect.stringContaining(result.html)
    );

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
          content: "[]",
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
          content: "[]",
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
        content: "[]",
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
              content: "[]",
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
        content: JSON.stringify([null, VALID_FINDING, { severity: "error" }]),
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
        suggestion: expect.stringMatching(/review.*manually/i),
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
        content: "[]",
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
        content: "[]",
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
        message: expect.stringContaining("page 3; bottom paragraph"),
      }),
      expect.objectContaining({ type: "missing-link", severity: "warning" }),
    ]);
  });

  it("pretty-prints the AI's single-line HTML for easier review", async () => {
    callLiteLLMMock
      .mockResolvedValueOnce({
        content: "<div><p>one</p><ul><li>a</li><li>b</li></ul></div>",
        model: "test-model",
        promptTokens: 100,
        completionTokens: 50,
      })
      .mockResolvedValueOnce({
        content: "[]",
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
        content: "[]",
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
