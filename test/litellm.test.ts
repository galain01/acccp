import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  callLiteLLM,
  clearModelPricingCache,
  computeCallCostUsd,
  fetchModelPricing,
} from "@/lib/litellm";

const CONFIG = { baseUrl: "https://litellm.test", apiKey: "test-key" };

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
