/**
 * API Testing — LiteLLM
 *
 * Matches test suite slide categories:
 *   1. AI & LiteLLM connection  — config is readable; the right endpoint/headers are used
 *   2. Response validation       — successful responses are parsed into the expected shape
 *   3. Error handling            — API failures and invalid inputs are handled gracefully
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  callLiteLLM,
  clearModelPricingCache,
  computeCallCostUsd,
  fetchModelPricing,
  getLiteLLMConfig,
} from "./litellm";

const CONFIG = {
  baseUrl: "https://litellm.test",
  apiKey: "test-key",
  model: "test-model",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ── 1. AI & LiteLLM connection ────────────────────────────────────────────────
// These tests verify that the client is configured correctly and talks to the
// right endpoint — without making a real call to the LLM.

describe("Independent conversion and audit models", () => {
  beforeEach(() => {
    vi.stubEnv("LITELLM_BASE_URL", CONFIG.baseUrl);
    vi.stubEnv("LITELLM_API_KEY", CONFIG.apiKey);
    vi.stubEnv("LITELLM_MODEL", undefined);
    vi.stubEnv("LITELLM_CONVERSION_MODEL", undefined);
    vi.stubEnv("LITELLM_AUDIT_MODEL", undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("selects each trimmed override independently and preserves the shared connection", () => {
    vi.stubEnv("LITELLM_MODEL", " shared-model ");
    vi.stubEnv("LITELLM_CONVERSION_MODEL", " conversion-model \t");
    vi.stubEnv("LITELLM_AUDIT_MODEL", "\n audit-model ");

    expect(getLiteLLMConfig("convert")).toEqual({
      ...CONFIG,
      model: "conversion-model",
    });
    expect(getLiteLLMConfig("validate")).toEqual({
      ...CONFIG,
      model: "audit-model",
    });
    expect(getLiteLLMConfig()).toEqual({ ...CONFIG, model: "shared-model" });
  });

  it.each([undefined, "", " \t\n "])(
    "falls back to the shared model when a stage override is %j",
    (override) => {
      vi.stubEnv("LITELLM_MODEL", " shared-model ");
      vi.stubEnv("LITELLM_CONVERSION_MODEL", override);
      vi.stubEnv("LITELLM_AUDIT_MODEL", override);

      expect(getLiteLLMConfig("convert").model).toBe("shared-model");
      expect(getLiteLLMConfig("validate").model).toBe("shared-model");
    }
  );

  it.each([undefined, "", " \t\n "])(
    "keeps the current default when the shared and stage overrides are %j",
    (override) => {
      vi.stubEnv("LITELLM_MODEL", override);
      vi.stubEnv("LITELLM_CONVERSION_MODEL", override);
      vi.stubEnv("LITELLM_AUDIT_MODEL", override);

      expect(getLiteLLMConfig("convert").model).toBe("gpt-5.6-sol-2026-07-09");
      expect(getLiteLLMConfig("validate").model).toBe("gpt-5.6-sol-2026-07-09");
      expect(getLiteLLMConfig().model).toBe("gpt-5.6-sol-2026-07-09");
    }
  );

  it.each([
    ["LITELLM_CONVERSION_MODEL", "convert", "validate"],
    ["LITELLM_AUDIT_MODEL", "validate", "convert"],
  ] as const)(
    "%s does not change the other stage or callers without a stage",
    (variable, selectedStage, otherStage) => {
      vi.stubEnv(variable, "selected-model");

      expect(getLiteLLMConfig(selectedStage).model).toBe("selected-model");
      expect(getLiteLLMConfig(otherStage).model).toBe("gpt-5.6-sol-2026-07-09");
      expect(getLiteLLMConfig().model).toBe("gpt-5.6-sol-2026-07-09");
    }
  );

  it("sends the selected stage model in each request", async () => {
    vi.stubEnv("LITELLM_CONVERSION_MODEL", "conversion-model");
    vi.stubEnv("LITELLM_AUDIT_MODEL", "audit-model");
    const fetchMock = vi
      .fn()
      .mockImplementation(async () =>
        jsonResponse({ choices: [{ message: { content: "ok" } }] })
      );
    vi.stubGlobal("fetch", fetchMock);

    await callLiteLLM("Convert", "PDF", getLiteLLMConfig("convert"));
    await callLiteLLM("Audit", "HTML and PDF", getLiteLLMConfig("validate"));

    expect(
      fetchMock.mock.calls.map((call) =>
        JSON.parse((call as [string, RequestInit])[1].body as string)
      )
    ).toEqual([
      expect.objectContaining({ model: "conversion-model" }),
      expect.objectContaining({ model: "audit-model" }),
    ]);
  });
});

describe("AI & LiteLLM connection", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    clearModelPricingCache();
  });

  it("getLiteLLMConfig reads credentials from environment variables", () => {
    vi.stubEnv("LITELLM_BASE_URL", "https://litellm.cloud.osu.edu");
    vi.stubEnv("LITELLM_API_KEY", "real-key");
    vi.stubEnv("LITELLM_MODEL", "gpt-5.4-nano-2026-03-17");

    const config = getLiteLLMConfig();

    expect(config.baseUrl).toBe("https://litellm.cloud.osu.edu");
    expect(config.apiKey).toBe("real-key");
    expect(config.model).toBe("gpt-5.4-nano-2026-03-17");
  });

  it.each([
    ["unset", undefined],
    ["empty", ""],
    ["whitespace-only", " \t\n "],
  ])(
    "getLiteLLMConfig defaults to GPT-5.6 Sol when LITELLM_MODEL is %s",
    (_label, model) => {
      vi.stubEnv("LITELLM_BASE_URL", "https://litellm.cloud.osu.edu");
      vi.stubEnv("LITELLM_API_KEY", "updated-test-key");
      vi.stubEnv("LITELLM_MODEL", model);

      expect(getLiteLLMConfig().model).toBe("gpt-5.6-sol-2026-07-09");
    }
  );

  it.each([
    ["gpt-5.6-sol-2026-07-09", "gpt-5.6-sol-2026-07-09"],
    ["gpt-5.4-nano-2026-03-17", "gpt-5.4-nano-2026-03-17"],
    ["custom-conversion-model", "custom-conversion-model"],
    ["  custom-conversion-model \t", "custom-conversion-model"],
  ])("getLiteLLMConfig respects the model override %j", (model, expected) => {
    vi.stubEnv("LITELLM_BASE_URL", "https://litellm.cloud.osu.edu");
    vi.stubEnv("LITELLM_API_KEY", "updated-test-key");
    vi.stubEnv("LITELLM_MODEL", model);

    expect(getLiteLLMConfig().model).toBe(expected);
  });

  it("uses the new model and updated key while preserving usage and live pricing", async () => {
    vi.stubEnv("LITELLM_BASE_URL", "https://litellm.test");
    vi.stubEnv("LITELLM_API_KEY", "updated-test-key");
    vi.stubEnv("LITELLM_MODEL", undefined);
    clearModelPricingCache();

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          choices: [{ message: { content: "  <p>Accessible content</p>  " } }],
          model: "gpt-5.6-sol-2026-07-09",
          usage: {
            prompt_tokens: 120,
            completion_tokens: 40,
            total_tokens: 160,
          },
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          data: [
            {
              model_name: "gpt-5.4-nano-2026-03-17",
              model_info: {
                input_cost_per_token: 0.000001,
                output_cost_per_token: 0.000002,
              },
            },
            {
              model_name: "gpt-5.6-sol-2026-07-09",
              model_info: {
                input_cost_per_token: 0.000003,
                output_cost_per_token: 0.000006,
              },
            },
          ],
        })
      );
    vi.stubGlobal("fetch", fetchMock);

    const config = getLiteLLMConfig();
    const result = await callLiteLLM(
      "conversion instructions",
      "source",
      config
    );
    const pricing = await fetchModelPricing(result.model, config);

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://litellm.test/chat/completions",
      expect.objectContaining({
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer updated-test-key",
        },
      })
    );
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      model: "gpt-5.6-sol-2026-07-09",
      messages: [
        { role: "system", content: "conversion instructions" },
        { role: "user", content: "source" },
      ],
    });
    expect(result).toEqual({
      content: "<p>Accessible content</p>",
      model: "gpt-5.6-sol-2026-07-09",
      promptTokens: 120,
      completionTokens: 40,
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://litellm.test/model/info",
      expect.objectContaining({
        headers: { Authorization: "Bearer updated-test-key" },
      })
    );
    expect(pricing).toEqual({
      source: "gateway",
      inputCostPerToken: 0.000003,
      outputCostPerToken: 0.000006,
    });
    expect(
      computeCallCostUsd(result.promptTokens, result.completionTokens, pricing)
    ).toBeCloseTo(0.0006, 10);
  });

  it("getLiteLLMConfig throws when LITELLM_BASE_URL is missing", () => {
    vi.stubEnv("LITELLM_BASE_URL", "");
    vi.stubEnv("LITELLM_API_KEY", "real-key");

    expect(() => getLiteLLMConfig()).toThrow("LITELLM_BASE_URL");
  });

  it("getLiteLLMConfig throws when LITELLM_API_KEY is missing", () => {
    vi.stubEnv("LITELLM_BASE_URL", "https://litellm.cloud.osu.edu");
    vi.stubEnv("LITELLM_API_KEY", "");

    expect(() => getLiteLLMConfig()).toThrow("LITELLM_API_KEY");
  });

  it("callLiteLLM sends a POST to /chat/completions on the configured base URL", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        choices: [{ message: { content: "ok" } }],
        model: "test-model",
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    await callLiteLLM("system", "user", CONFIG);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://litellm.test/chat/completions",
      expect.objectContaining({ method: "POST" })
    );
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      model: "test-model",
      messages: [
        { role: "system", content: "system" },
        { role: "user", content: "user" },
      ],
    });
  });

  it("callLiteLLM sends inline PDF content with text instructions to the configured model", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        choices: [{ message: { content: "  <p>From PDF</p>  " } }],
        model: "test-model",
        usage: { prompt_tokens: 200, completion_tokens: 20 },
      })
    );
    vi.stubGlobal("fetch", fetchMock);
    const fileData = "data:application/pdf;base64,JVBERi0xLjcK";

    const result = await callLiteLLM(
      "Return accessible HTML",
      [
        { type: "text", text: "Convert every page of the attached PDF." },
        {
          type: "file",
          file: { filename: "source.pdf", file_data: fileData },
        },
      ],
      CONFIG
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://litellm.test/chat/completions",
      expect.objectContaining({
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer test-key",
        },
      })
    );
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      model: "test-model",
      messages: [
        { role: "system", content: "Return accessible HTML" },
        {
          role: "user",
          content: [
            { type: "text", text: "Convert every page of the attached PDF." },
            {
              type: "file",
              file: { filename: "source.pdf", file_data: fileData },
            },
          ],
        },
      ],
    });
    expect(result).toEqual({
      content: "<p>From PDF</p>",
      model: "test-model",
      promptTokens: 200,
      completionTokens: 20,
    });
  });

  it("callLiteLLM sends the API key as a Bearer token", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        choices: [{ message: { content: "ok" } }],
        model: "test-model",
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    await callLiteLLM("system", "user", CONFIG);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)["Authorization"]).toBe(
      "Bearer test-key"
    );
  });

  it("fetchModelPricing queries /model/info on the configured base URL", async () => {
    clearModelPricingCache();
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: [] }));
    vi.stubGlobal("fetch", fetchMock);

    await fetchModelPricing("some-model", CONFIG);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://litellm.test/model/info",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer test-key" }),
      })
    );
  });
});

// ── 2. Response validation ────────────────────────────────────────────────────
// These tests verify that successful API responses are parsed into the shape
// the rest of the application expects.

describe("Response validation", () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each([
    ["  <p>Partial content</p>  ", "length", "<p>Partial content</p>"],
    [null, "content_filter", ""],
  ])(
    "retains usage and finish reason for incomplete content %j",
    async (content, finishReason, expectedContent) => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          jsonResponse({
            choices: [{ message: { content }, finish_reason: finishReason }],
            model: "test-model",
            usage: { prompt_tokens: 120, completion_tokens: 40 },
          })
        )
      );

      expect(await callLiteLLM("system", "user", CONFIG)).toEqual({
        content: expectedContent,
        model: "test-model",
        promptTokens: 120,
        completionTokens: 40,
        finishReason,
      });
    }
  );

  it("callLiteLLM returns trimmed content, model name, and token counts", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          choices: [{ message: { content: "  <p>hi</p>  " } }],
          model: "gpt-5.4-nano-2026-03-17",
          usage: { prompt_tokens: 120, completion_tokens: 40 },
        })
      )
    );

    const result = await callLiteLLM("system", "user", CONFIG);

    expect(result).toEqual({
      content: "<p>hi</p>",
      model: "gpt-5.4-nano-2026-03-17",
      promptTokens: 120,
      completionTokens: 40,
    });
  });

  it("callLiteLLM defaults token counts to 0 when usage is absent from the response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          choices: [{ message: { content: "ok" } }],
          model: "some-model",
        })
      )
    );

    const result = await callLiteLLM("system", "user", CONFIG);

    expect(result.promptTokens).toBe(0);
    expect(result.completionTokens).toBe(0);
  });

  it("fetchModelPricing finds pricing by model_name and returns per-token costs", async () => {
    clearModelPricingCache();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          data: [
            {
              model_name: "gpt-5.4-nano-2026-03-17",
              model_info: {
                input_cost_per_token: 0.000002,
                output_cost_per_token: 0.000004,
              },
            },
          ],
        })
      )
    );

    const pricing = await fetchModelPricing("gpt-5.4-nano-2026-03-17", CONFIG);

    expect(pricing).toEqual({
      source: "gateway",
      inputCostPerToken: 0.000002,
      outputCostPerToken: 0.000004,
    });
  });

  it("fetchModelPricing falls back to litellm_params.model when model_name does not match", async () => {
    clearModelPricingCache();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          data: [
            {
              model_name: "alias",
              litellm_params: { model: "gpt-5.4-nano-2026-03-17" },
              model_info: {
                input_cost_per_token: 0.000001,
                output_cost_per_token: 0.000002,
              },
            },
          ],
        })
      )
    );

    const pricing = await fetchModelPricing("gpt-5.4-nano-2026-03-17", CONFIG);

    expect(pricing).toEqual({
      source: "gateway",
      inputCostPerToken: 0.000001,
      outputCostPerToken: 0.000002,
    });
  });

  it("computeCallCostUsd computes prompt and completion cost separately", () => {
    const cost = computeCallCostUsd(1000, 500, {
      inputCostPerToken: 0.000002,
      outputCostPerToken: 0.000004,
    });

    expect(cost).toBeCloseTo(1000 * 0.000002 + 500 * 0.000004, 10);
  });

  it("fetchModelPricing caches the result so the endpoint is not called twice", async () => {
    clearModelPricingCache();
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        data: [
          {
            model_name: "m",
            model_info: { input_cost_per_token: 1, output_cost_per_token: 2 },
          },
        ],
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    await fetchModelPricing("m", CONFIG);
    await fetchModelPricing("m", CONFIG);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

// ── 3. Error handling ─────────────────────────────────────────────────────────
// These tests verify that API failures and invalid inputs are handled without
// crashing — errors are surfaced clearly and degraded gracefully.

describe("Error handling", () => {
  afterEach(() => vi.unstubAllGlobals());
  beforeEach(() => clearModelPricingCache());

  it("callLiteLLM throws with the HTTP status and safe reason on a non-2xx response", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response("Internal Server Error", { status: 500 })
        )
    );

    await expect(callLiteLLM("system", "user", CONFIG)).rejects.toThrow(
      "LiteLLM error 500: The model provider is temporarily unavailable. Please try again later."
    );
  });

  it("never exposes credentials, filenames, plaintext documents, or inline PDFs from provider errors", async () => {
    const encodedPdf = Buffer.from("private PDF contents").toString("base64");
    const fileData = `data:application/pdf;base64,${encodedPdf}`;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(
          {
            error: {
              message: `Unsupported PDF ${fileData} with key ${CONFIG.apiKey}; authorization Bearer upstream-secret; private-filename.pdf; confidential document passage`,
            },
            request: { file_data: fileData, api_key: CONFIG.apiKey },
          },
          400
        )
      )
    );

    const failure = await callLiteLLM("system", "user", CONFIG).catch(
      (error: Error) => error
    );

    expect(failure).toBeInstanceOf(Error);
    const message = (failure as Error).message;
    expect(message).toContain("LiteLLM error 400:");
    expect(message).not.toContain(CONFIG.apiKey);
    expect(message).not.toContain("upstream-secret");
    expect(message).not.toContain("data:application/pdf");
    expect(message).not.toContain(encodedPdf);
    expect(message).not.toContain("request");
    expect(message).not.toContain("private-filename.pdf");
    expect(message).not.toContain("confidential document passage");
  });

  it("omits long unquoted file payloads from non-JSON provider errors", async () => {
    const encodedPdf = "JVBERi0".repeat(1000);
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            `Invalid file data:application/pdf;base64,${encodedPdf} ${"details ".repeat(1000)}`,
            { status: 400 }
          )
        )
    );

    const failure = await callLiteLLM("system", "user", CONFIG).catch(
      (error: Error) => error
    );

    expect(failure).toBeInstanceOf(Error);
    const message = (failure as Error).message;
    expect(message).toContain("LiteLLM error 400:");
    expect(message).not.toContain("JVBERi0");
    expect(message.length).toBeLessThanOrEqual(1024);
  });

  it.each([
    [
      "transport failure",
      () =>
        Promise.reject(
          new Error("request failed: private-document-text; upstream-secret")
        ),
    ],
    [
      "malformed successful response",
      () =>
        Promise.resolve(
          new Response("private-document-text; upstream-secret", {
            status: 200,
          })
        ),
    ],
  ])("does not expose exception text on %s", async (_label, implementation) => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(implementation));
    const error = await callLiteLLM("system", "user", CONFIG).catch(
      (failure: Error) => failure
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain("private-document-text");
    expect((error as Error).message).not.toContain("upstream-secret");
  });

  it("callLiteLLM throws on a 401 Unauthorized response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("Unauthorized", { status: 401 }))
    );

    await expect(callLiteLLM("system", "user", CONFIG)).rejects.toThrow(
      /LiteLLM error 401/
    );
  });

  it("computeCallCostUsd returns null when pricing is unavailable", () => {
    expect(computeCallCostUsd(100, 50, null)).toBeNull();
  });

  it("fetchModelPricing returns null (not throw) when the model has no cost fields", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse({ data: [{ model_name: "m", model_info: {} }] })
        )
    );

    expect(await fetchModelPricing("m", CONFIG)).toBeNull();
  });

  it("fetchModelPricing returns null when no entry matches the requested model", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ data: [] }))
    );

    expect(await fetchModelPricing("unknown-model", CONFIG)).toBeNull();
  });

  it("fetchModelPricing returns null (not throw) on a non-2xx response", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(new Response("Service Unavailable", { status: 503 }))
    );

    expect(await fetchModelPricing("m", CONFIG)).toBeNull();
  });

  it("fetchModelPricing returns null (not throw) when the network request fails entirely", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("network down"))
    );

    expect(await fetchModelPricing("m", CONFIG)).toBeNull();
  });
});
