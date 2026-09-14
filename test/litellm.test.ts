import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  callLiteLLM,
  clearModelPricingCache,
  computeCallCostUsd,
  fetchModelPricing,
  getPublishedModelPricing,
  getLiteLLMConfig,
  LiteLLMError,
  PUBLISHED_PRICING_MODELS,
} from "@/lib/litellm";

const CONFIG = { baseUrl: "https://litellm.test", apiKey: "test-key" };

async function failedCall(response: Response): Promise<LiteLLMError> {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
  const failure = await callLiteLLM("private instructions", "private source", {
    ...CONFIG,
    model: "test-model",
  }).catch((error) => error);
  expect(failure).toBeInstanceOf(LiteLLMError);
  return failure as LiteLLMError;
}

describe("safe provider failure diagnostics", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it.each([
    ["budget_exceeded", "provider_budget"],
    ["insufficient_quota", "provider_quota"],
    ["rate_limit_exceeded", "provider_rate_limit"],
    ["invalid_api_key", "provider_auth"],
    ["model_not_found", "provider_model_not_found"],
    ["key_model_access_denied", "provider_auth"],
  ])(
    "classifies explicit %s without preserving surrounding private content",
    async (code, expected) => {
      const failure = await failedCall(
        jsonResponse(
          {
            error: {
              code,
              type: "invalid_request_error",
              message: "private-source.pdf private source sk-secret",
              model: "private document text",
              request: { api_key: "sk-secret", body: "private source" },
            },
          },
          429
        )
      );
      expect(failure.diagnostic).toMatchObject({
        version: 1,
        stage: "conversion",
        code: expected,
        model: "test-model",
        httpStatus: 429,
        elapsedMs: expect.any(Number),
      });
      for (const privateText of [
        "private-source.pdf",
        "private source",
        "sk-secret",
        "private document text",
      ])
        expect(JSON.stringify(failure) + failure.message).not.toContain(
          privateText
        );
    }
  );

  it("understands an exact gateway type when code is an HTTP number", async () => {
    const failure = await failedCall(
      jsonResponse({ error: { type: "budget_exceeded", code: "429" } }, 429)
    );
    expect(failure.diagnostic?.code).toBe("provider_budget");
  });

  it.each([
    {
      message: "budget_exceeded: spending limit reached",
      type: "throttling_error",
      code: "429",
    },
    { code: "BudgetExceededError" },
    { code: "insufficient_quota private source" },
    { code: "constructor" },
    { type: "__proto__" },
    { code: "x".repeat(100_000) },
    { code: "insufficient_quota", type: "rate_limit_exceeded" },
  ])(
    "keeps ambiguous or unrecognized 429 responses ambiguous (case %#)",
    async (error) => {
      const failure = await failedCall(jsonResponse({ error }, 429));
      expect(failure.diagnostic?.code).toBe("provider_rate_or_quota");
      expect(failure.message).not.toContain("spending limit was reached");
    }
  );

  it.each([
    [400, "provider_request_rejected"],
    [401, "provider_auth"],
    [403, "provider_auth"],
    [404, "provider_model_not_found"],
    [413, "provider_payload_limit"],
    [422, "provider_request_rejected"],
    [429, "provider_rate_or_quota"],
    [503, "provider_unavailable"],
  ])(
    "uses a safe HTTP %s fallback for non-JSON responses",
    async (status, code) => {
      const failure = await failedCall(
        new Response("<html>private text sk-secret</html>", {
          status: status as number,
        })
      );
      expect(failure.diagnostic?.code).toBe(code);
      expect(failure.message).not.toContain("private text");
      expect(failure.message).not.toContain("sk-secret");
      if (status === 400)
        expect(failure.message).not.toMatch(
          /PDF is readable|supports this input/
        );
    }
  );

  it("keeps only numeric Retry-After and a UUID LiteLLM call ID", async () => {
    const failure = await failedCall(
      new Response("{}", {
        status: 429,
        headers: {
          "retry-after": "12",
          "x-litellm-call-id": "019b2c4d-e5f6-7890-abcd-ef1234567890",
          "x-request-id": "private-other-id",
          "x-litellm-model-api-base": "https://provider.test/secret",
        },
      })
    );
    expect(failure.diagnostic).toMatchObject({
      retryAfterSeconds: 12,
      providerRequestId: "019b2c4d-e5f6-7890-abcd-ef1234567890",
    });
    expect(JSON.stringify(failure)).not.toContain("private-other-id");
    expect(JSON.stringify(failure)).not.toContain("provider.test");
  });

  it.each([
    "99999999999",
    "86401",
    "-1",
    "1.5",
    "Wed, 21 Oct 2026 07:28:00 GMT",
    "12 sk-secret",
  ])(
    "discards invalid Retry-After %j and private request IDs",
    async (retryAfter) => {
      const failure = await failedCall(
        new Response("{}", {
          status: 429,
          headers: {
            "retry-after": retryAfter,
            "x-litellm-call-id": "sk-private-source",
          },
        })
      );
      expect(failure.diagnostic).not.toHaveProperty("retryAfterSeconds");
      expect(failure.diagnostic).not.toHaveProperty("providerRequestId");
      expect(JSON.stringify(failure)).not.toContain("sk-private-source");
    }
  );

  it("discards oversized bodies even if the beginning contains a recognized code", async () => {
    const failure = await failedCall(
      jsonResponse(
        {
          error: {
            code: "budget_exceeded",
            message: "private source ".repeat(2000),
          },
        },
        429
      )
    );
    expect(failure.diagnostic?.code).toBe("provider_rate_or_quota");
    expect(JSON.stringify(failure)).not.toContain("private source");
  });

  it("bounds streamed body bytes and cancels the stream", async () => {
    const cancel = vi.fn();
    let index = 0;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          index += 1;
          controller.enqueue(
            new TextEncoder().encode(
              index === 1
                ? '{"error":{"code":"budget_exceeded","message":"'
                : "x".repeat(9000)
            )
          );
        },
        cancel,
      },
      { highWaterMark: 0 }
    );
    const failure = await failedCall(new Response(body, { status: 429 }));
    expect(failure.diagnostic?.code).toBe("provider_rate_or_quota");
    expect(index).toBe(3);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("does not wait indefinitely for a stalled error body", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const pending = failedCall(
      new Response(new ReadableStream({ start() {}, cancel }), { status: 429 })
    );
    await vi.advanceTimersByTimeAsync(1500);
    const failure = await pending;
    expect(failure.diagnostic?.code).toBe("provider_rate_or_quota");
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("rejects an advertised oversized body before reading it", async () => {
    const pull = vi.fn();
    const cancel = vi.fn();
    const failure = await failedCall(
      new Response(new ReadableStream({ pull, cancel }, { highWaterMark: 0 }), {
        status: 429,
        headers: { "content-length": "999999" },
      })
    );
    expect(failure.diagnostic?.code).toBe("provider_rate_or_quota");
    expect(pull).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("falls back safely when the error body stream fails or is already locked", async () => {
    const broken = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error("private source sk-secret"));
      },
    });
    const failure = await failedCall(new Response(broken, { status: 503 }));
    expect(failure.diagnostic?.code).toBe("provider_unavailable");
    expect(JSON.stringify(failure) + failure.message).not.toContain(
      "sk-secret"
    );
    const response = new Response("private source", { status: 503 });
    const lockedReader = response.body!.getReader();
    const lockedFailure = await failedCall(response);
    expect(lockedFailure.diagnostic?.code).toBe("provider_unavailable");
    await lockedReader.cancel();
  });

  it("classifies configuration and network failures without source exceptions", async () => {
    vi.stubEnv("LITELLM_BASE_URL", "");
    expect(() => getLiteLLMConfig()).toThrow(LiteLLMError);
    try {
      getLiteLLMConfig();
    } catch (error) {
      expect((error as LiteLLMError).diagnostic?.code).toBe(
        "provider_configuration"
      );
    }
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("private source sk-secret"))
    );
    const failure = await callLiteLLM("system", "source", {
      ...CONFIG,
      model: "test-model",
    }).catch((error) => error);
    expect(failure.diagnostic.code).toBe("provider_connection");
    expect(failure.diagnostic).not.toHaveProperty("httpStatus");
    expect(JSON.stringify(failure) + failure.message).not.toContain(
      "sk-secret"
    );
  });

  it("distinguishes unreadable JSON from unexpected successful response structure", async () => {
    const unreadable = await failedCall(
      new Response("private source sk-secret", { status: 200 })
    );
    expect(unreadable.diagnostic?.code).toBe("provider_invalid_json");
    const unexpected = await failedCall(
      jsonResponse({ error: { message: "private source sk-secret" } })
    );
    expect(unexpected.diagnostic?.code).toBe("provider_invalid_response");
    expect(JSON.stringify([unreadable, unexpected])).not.toContain("sk-secret");
  });

  it("preserves the existing message-only constructor", () => {
    const failure = new LiteLLMError("Safe older summary");
    expect(failure.message).toBe("Safe older summary");
    expect(failure.diagnostic).toBeUndefined();
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("computeCallCostUsd", () => {
  it("returns null when pricing is unavailable", () => {
    expect(computeCallCostUsd(100, 50, null)).toBeNull();
  });

  it("computes prompt/completion cost separately", () => {
    const cost = computeCallCostUsd(1000, 500, {
      inputCostPerToken: 0.000002,
      outputCostPerToken: 0.000004,
    });
    expect(cost).toBeCloseTo(1000 * 0.000002 + 500 * 0.000004, 10);
  });
});

describe("callLiteLLM", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("parses content, model, and token usage from a successful response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          choices: [{ message: { content: "  <p>hi</p>  " } }],
          model: "gpt-5.4-nano-2026-03-17",
          usage: {
            prompt_tokens: 120,
            completion_tokens: 40,
            total_tokens: 160,
          },
        })
      )
    );

    const result = await callLiteLLM("system", "user", {
      ...CONFIG,
      model: "gpt-5.4-nano-2026-03-17",
    });

    expect(result).toEqual({
      content: "<p>hi</p>",
      model: "gpt-5.4-nano-2026-03-17",
      promptTokens: 120,
      completionTokens: 40,
    });
  });

  it("defaults token counts to 0 when usage is missing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          choices: [{ message: { content: "ok" } }],
          model: "some-model",
        })
      )
    );

    const result = await callLiteLLM("system", "user", {
      ...CONFIG,
      model: "some-model",
    });

    expect(result.promptTokens).toBe(0);
    expect(result.completionTokens).toBe(0);
  });

  it("throws with the HTTP status on a non-2xx response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("boom", { status: 500 }))
    );

    await expect(
      callLiteLLM("system", "user", { ...CONFIG, model: "m" })
    ).rejects.toThrow(/LiteLLM error 500/);
  });
});

describe("fetchModelPricing", () => {
  beforeEach(() => {
    clearModelPricingCache();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("finds pricing by model_name", async () => {
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

  it("falls back to litellm_params.model when model_name doesn't match", async () => {
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

  it("returns null when no entry matches the model", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ data: [] }))
    );
    expect(await fetchModelPricing("unknown-model", CONFIG)).toBeNull();
  });

  it("returns null when model_info is missing cost fields", async () => {
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

  it("returns null (not throw) on a non-2xx response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("nope", { status: 503 }))
    );
    expect(await fetchModelPricing("m", CONFIG)).toBeNull();
  });

  it("returns null (not throw) when fetch itself rejects", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("network down"))
    );
    expect(await fetchModelPricing("m", CONFIG)).toBeNull();
  });

  it("caches the result so a second call doesn't refetch", async () => {
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

describe("gateway cost and Sol price fallback", () => {
  const sol = "gpt-5.6-sol-2026-07-09";

  beforeEach(() => {
    clearModelPricingCache();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-10T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    clearModelPricingCache();
  });

  function completionWithCost(value?: string) {
    const response = jsonResponse({
      choices: [{ message: { content: "<p>Test</p>" } }],
      model: sol,
      usage: {
        prompt_tokens: 1000,
        completion_tokens: 100,
        prompt_tokens_details: {
          cached_tokens: 200,
          cache_write_tokens: 300,
          // Alias describes the same tokens; do not add it twice.
          cache_creation_tokens: 300,
        },
      },
    });
    if (value !== undefined)
      response.headers.set("x-litellm-response-cost", value);
    return response;
  }

  it.each(["0", "0.0123", "1.23e-4"])(
    "preserves valid gateway cost %s and cache usage",
    async (value) => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(completionWithCost(value))
      );
      const call = await callLiteLLM("system", "synthetic input", {
        ...CONFIG,
        model: sol,
      });
      expect(call.responseCostUsd).toBe(Number(value));
      expect(call.cachedPromptTokens).toBe(200);
      expect(call.cacheCreationPromptTokens).toBe(300);
    }
  );

  it.each([undefined, "", " ", "None", "NaN", "Infinity", "-0.2", "1.2junk"])(
    "does not turn invalid or absent cost %j into a zero charge",
    async (value) => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(completionWithCost(value))
      );
      const call = await callLiteLLM("system", "synthetic input", {
        ...CONFIG,
        model: sol,
      });
      expect(call.responseCostUsd).toBeUndefined();
    }
  );

  it("falls back to dated Sol standard rates when metadata is unavailable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(null, { status: 400 }))
    );
    const pricing = await fetchModelPricing(sol, CONFIG);
    expect(pricing).toMatchObject({
      source: "openai-list-price",
      verifiedAt: "2026-09-10",
      validUntil: "2026-11-22T00:00:00.000Z",
      inputCostPerToken: 0.000004,
      outputCostPerToken: 0.00002,
      cacheCreationInputCostPerToken: 0.000005,
    });
    expect(pricing!.cachedInputCostPerToken! * 1_000_000).toBeCloseTo(0.4, 12);
    // 500 ordinary + 200 cache reads + 300 cache writes + 100 output.
    expect(
      computeCallCostUsd(1000, 100, pricing, {
        cachedPromptTokens: 200,
        cacheCreationPromptTokens: 300,
      })
    ).toBeCloseTo(0.00558, 12);
  });

  it("uses the full-request long-context tier only above 272,000 prompt tokens", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ data: [] }))
    );
    const pricing = await fetchModelPricing(sol, CONFIG);
    expect(computeCallCostUsd(272_000, 100, pricing)).toBeCloseTo(1.09, 12);
    expect(
      computeCallCostUsd(272_001, 100, pricing, {
        cachedPromptTokens: 100,
        cacheCreationPromptTokens: 200,
      })
    ).toBeCloseTo(
      271_701 * 0.000008 + 100 * 0.0000008 + 200 * 0.00001 + 100 * 0.00003,
      12
    );
  });

  it("estimates history without a cache breakdown using ordinary input rates", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ data: [] }))
    );
    const pricing = await fetchModelPricing(sol, CONFIG);
    expect(computeCallCostUsd(1000, 100, pricing)).toBeCloseTo(0.006, 12);
  });

  it("never applies Sol prices to unknown snapshots, other tiers, or provider aliases", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ data: [] }))
    );
    for (const model of [
      "gpt-5.6-sol-2099-01-01",
      "gpt-5.6-terra",
      "department-sol",
      "openai/department-sol",
    ])
      expect(await fetchModelPricing(model, CONFIG)).toBeNull();
  });

  it("expires the fallback and its cache when the verified promotional period ends", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ data: [] }))
    );
    vi.setSystemTime(new Date("2026-11-21T23:59:59Z"));
    expect(await fetchModelPricing(sol, CONFIG)).not.toBeNull();
    vi.setSystemTime(new Date("2026-11-22T00:00:00Z"));
    expect(await fetchModelPricing(sol, CONFIG)).toBeNull();
  });

  it("exposes the same allowlisted rates without network access for SQL estimates", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    for (const model of PUBLISHED_PRICING_MODELS) {
      expect(
        getPublishedModelPricing(model, new Date("2026-09-10"))?.source
      ).toBe("openai-list-price");
    }
    expect(getPublishedModelPricing(sol, new Date("2026-11-22"))).toBeNull();
    expect(getPublishedModelPricing(sol, new Date("invalid"))).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("prefers exact gateway model pricing, accepts decimal strings, and preserves free rates", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          data: [
            {
              model_name: "another-alias",
              litellm_params: { model: sol },
              model_info: { input_cost_per_token: 9, output_cost_per_token: 9 },
            },
            {
              model_name: sol,
              model_info: {
                input_cost_per_token: "0.000003",
                output_cost_per_token: 0,
                cache_read_input_token_cost: "0.000001",
                cache_creation_input_token_cost: "0.000004",
              },
            },
          ],
        })
      )
    );
    const pricing = await fetchModelPricing(sol, CONFIG);
    expect(pricing).toEqual({
      source: "gateway",
      inputCostPerToken: 0.000003,
      outputCostPerToken: 0,
      cachedInputCostPerToken: 0.000001,
      cacheCreationInputCostPerToken: 0.000004,
    });
    expect(
      computeCallCostUsd(1000, 100, pricing, {
        cachedPromptTokens: 200,
        cacheCreationPromptTokens: 300,
      })
    ).toBeCloseTo(0.0029, 12);
  });

  it.each([-1, "NaN", "Infinity", "", null])(
    "rejects unusable gateway rates %j",
    async (value) => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          jsonResponse({
            data: [
              {
                model_name: "unknown-model",
                model_info: {
                  input_cost_per_token: value,
                  output_cost_per_token: 1,
                },
              },
            ],
          })
        )
      );
      expect(await fetchModelPricing("unknown-model", CONFIG)).toBeNull();
    }
  );

  it("does not reuse rates across gateway endpoints or credentials", async () => {
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(
        jsonResponse({
          data: [
            {
              model_name: "m",
              model_info: {
                input_cost_per_token: 1,
                output_cost_per_token: 2,
              },
            },
          ],
        })
      )
    );
    vi.stubGlobal("fetch", fetchMock);
    await fetchModelPricing("m", CONFIG);
    await fetchModelPricing("m", CONFIG);
    await fetchModelPricing("m", { ...CONFIG, apiKey: "other-synthetic-key" });
    await fetchModelPricing("m", { ...CONFIG, baseUrl: "https://other.test" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        redirect: "error",
        signal: expect.any(AbortSignal),
      })
    );
  });

  it("does not persist nonsensical or double-counted token usage as a cost", () => {
    const pricing = { inputCostPerToken: 1, outputCostPerToken: 2 };
    expect(computeCallCostUsd(-1, 2, pricing)).toBeNull();
    expect(computeCallCostUsd(1, NaN, pricing)).toBeNull();
    expect(
      computeCallCostUsd(10, 2, pricing, {
        cachedPromptTokens: 8,
        cacheCreationPromptTokens: 8,
      })
    ).toBeNull();
  });
});
