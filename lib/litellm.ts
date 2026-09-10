/**
 * Shared LiteLLM client used by the conversion pipeline (lib/convert.ts) and
 * the admin cost/metrics routes.
 *
 * Required env vars:
 *   LITELLM_BASE_URL   e.g. https://litellm.cloud.osu.edu
 *   LITELLM_API_KEY    a proxy key with access to the configured model
 *   LITELLM_MODEL      optional override; defaults to gpt-5.6-sol-2026-07-09
 */

export interface LiteLLMConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export const DEFAULT_LITELLM_MODEL = "gpt-5.6-sol-2026-07-09";

/** Contains only diagnostics authored by this client, never a provider body. */
export class LiteLLMError extends Error {}

export function getLiteLLMConfig(): LiteLLMConfig {
  const baseUrl = process.env.LITELLM_BASE_URL;
  const apiKey = process.env.LITELLM_API_KEY;
  // The key grants access; the model field selects what the proxy runs.
  const model = process.env.LITELLM_MODEL?.trim() || DEFAULT_LITELLM_MODEL;
  if (!baseUrl) throw new LiteLLMError("Missing env var: LITELLM_BASE_URL");
  if (!apiKey) throw new LiteLLMError("Missing env var: LITELLM_API_KEY");
  return { baseUrl, apiKey, model };
}

export interface LiteLLMCallResult {
  content: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  /** Used to avoid saving a truncated document as a successful conversion. */
  finishReason?: string;
}

export type LiteLLMContentPart =
  | { type: "text"; text: string }
  | {
      type: "file";
      file: {
        filename: string;
        file_data: `data:application/pdf;base64,${string}`;
      };
    };

export type LiteLLMUserMessage = string | LiteLLMContentPart[];

function providerErrorReason(status: number): string {
  // Error bodies may echo document text, filenames, or upstream credentials in
  // arbitrary formats. Do not forward or log them, even after pattern redaction.
  if (status === 401 || status === 403)
    return "Check the API key and its access to the configured model.";
  if (status === 404) return "Check the proxy URL and configured model ID.";
  if (status === 400 || status === 413 || status === 422)
    return "Check that the configured model supports this input and that the PDF is readable and within provider limits.";
  if (status === 429)
    return "The provider rate limit or quota was reached. Check available quota and try again later.";
  if (status >= 500)
    return "The model provider is temporarily unavailable. Please try again later.";
  return "The model provider rejected the request. Check the proxy configuration.";
}

export async function callLiteLLM(
  systemPrompt: string,
  userMessage: LiteLLMUserMessage,
  config: LiteLLMConfig
): Promise<LiteLLMCallResult> {
  let response: Response;
  try {
    response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userMessage },
        ],
      }),
    });
  } catch {
    throw new LiteLLMError(
      "Could not connect to the model provider. Check the proxy URL and network access."
    );
  }

  if (!response.ok) {
    throw new LiteLLMError(
      `LiteLLM error ${response.status}: ${providerErrorReason(response.status)}`
    );
  }

  // JSON parse errors can include snippets of the response. Never let those
  // exceptions escape to the conversion result or CLI output.
  try {
    const data = (await response.json()) as {
      choices: Array<{
        message: { content: string | null };
        finish_reason?: string;
      }>;
      model: string;
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
      };
    };

    return {
      content: data.choices[0]?.message.content?.trim() ?? "",
      model: data.model,
      promptTokens: data.usage?.prompt_tokens ?? 0,
      completionTokens: data.usage?.completion_tokens ?? 0,
      ...(data.choices[0]?.finish_reason
        ? { finishReason: data.choices[0].finish_reason }
        : {}),
    };
  } catch {
    throw new LiteLLMError(
      "The model provider returned an invalid response. Please try again."
    );
  }
}

// ─── Pricing ──────────────────────────────────────────────────────────────────

export interface ModelPricing {
  inputCostPerToken: number;
  outputCostPerToken: number;
}

const PRICING_CACHE_TTL_MS = 5 * 60 * 1000;
const pricingCache = new Map<
  string,
  { value: ModelPricing | null; expiresAt: number }
>();

/** Test-only: clears the in-memory pricing cache between test cases. */
export function clearModelPricingCache(): void {
  pricingCache.clear();
}

/**
 * Looks up per-token pricing for `model` from LiteLLM's /model/info endpoint.
 * Returns null (never throws) if the endpoint or the cost fields are
 * unavailable — cost tracking degrades gracefully; token counts still get
 * recorded either way. Cached for 5 minutes per model since pricing is
 * low-cardinality and slow-changing.
 */
export async function fetchModelPricing(
  model: string,
  config: Pick<LiteLLMConfig, "baseUrl" | "apiKey">
): Promise<ModelPricing | null> {
  const cached = pricingCache.get(model);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const value = await fetchModelPricingUncached(model, config);
  pricingCache.set(model, {
    value,
    expiresAt: Date.now() + PRICING_CACHE_TTL_MS,
  });
  return value;
}

async function fetchModelPricingUncached(
  model: string,
  config: Pick<LiteLLMConfig, "baseUrl" | "apiKey">
): Promise<ModelPricing | null> {
  try {
    const response = await fetch(`${config.baseUrl}/model/info`, {
      headers: { Authorization: `Bearer ${config.apiKey}` },
    });
    if (!response.ok) return null;

    const data = (await response.json()) as {
      data?: Array<{
        model_name?: string;
        litellm_params?: { model?: string };
        model_info?: {
          input_cost_per_token?: number;
          output_cost_per_token?: number;
        };
      }>;
    };

    const entry = data.data?.find(
      (m) => m.model_name === model || m.litellm_params?.model === model
    );
    const info = entry?.model_info;
    if (
      !info ||
      typeof info.input_cost_per_token !== "number" ||
      typeof info.output_cost_per_token !== "number"
    ) {
      return null;
    }

    return {
      inputCostPerToken: info.input_cost_per_token,
      outputCostPerToken: info.output_cost_per_token,
    };
  } catch {
    return null;
  }
}

/** Pure — no I/O — so it's trivially unit-testable. */
export function computeCallCostUsd(
  promptTokens: number,
  completionTokens: number,
  pricing: ModelPricing | null
): number | null {
  if (!pricing) return null;
  return (
    promptTokens * pricing.inputCostPerToken +
    completionTokens * pricing.outputCostPerToken
  );
}
