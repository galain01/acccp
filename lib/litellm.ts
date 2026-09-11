/**
 * Shared LiteLLM client used by the conversion pipeline (lib/convert.ts) and
 * the admin cost/metrics routes.
 *
 * Required env vars:
 *   LITELLM_BASE_URL   e.g. https://litellm.cloud.osu.edu
 *   LITELLM_API_KEY    a proxy key with access to the configured model
 *   LITELLM_MODEL      optional override; defaults to gpt-5.6-sol-2026-07-09
 *   LITELLM_CONVERSION_MODEL optional conversion-stage model override
 *   LITELLM_AUDIT_MODEL      optional audit-stage model override
 */

import { createHash } from "node:crypto";

export interface LiteLLMConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export const DEFAULT_LITELLM_MODEL = "gpt-5.6-sol-2026-07-09";

/** Contains only diagnostics authored by this client, never a provider body. */
export class LiteLLMError extends Error {}

export function getLiteLLMConfig(
  stage?: "convert" | "validate"
): LiteLLMConfig {
  const baseUrl = process.env.LITELLM_BASE_URL;
  const apiKey = process.env.LITELLM_API_KEY;
  // The key grants access; the model field selects what the proxy runs.
  const stageModel =
    stage === "convert"
      ? process.env.LITELLM_CONVERSION_MODEL
      : stage === "validate"
        ? process.env.LITELLM_AUDIT_MODEL
        : undefined;
  const model =
    stageModel?.trim() ||
    process.env.LITELLM_MODEL?.trim() ||
    DEFAULT_LITELLM_MODEL;
  if (!baseUrl) throw new LiteLLMError("Missing env var: LITELLM_BASE_URL");
  if (!apiKey) throw new LiteLLMError("Missing env var: LITELLM_API_KEY");
  return { baseUrl, apiKey, model };
}

export interface LiteLLMCallResult {
  content: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  /** Gateway-reported USD cost, when supplied as a valid response header. */
  responseCostUsd?: number;
  cachedPromptTokens?: number;
  cacheCreationPromptTokens?: number;
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
        prompt_tokens_details?: {
          cached_tokens?: number;
          cache_write_tokens?: number;
          cache_creation_tokens?: number;
        };
      };
    };

    const responseCostUsd = parseNonnegativeNumber(
      response.headers.get("x-litellm-response-cost")
    );
    const cachedPromptTokens = data.usage?.prompt_tokens_details?.cached_tokens;
    const cacheCreationPromptTokens =
      data.usage?.prompt_tokens_details?.cache_write_tokens ??
      data.usage?.prompt_tokens_details?.cache_creation_tokens;

    return {
      content: data.choices[0]?.message.content?.trim() ?? "",
      model: data.model,
      promptTokens: data.usage?.prompt_tokens ?? 0,
      completionTokens: data.usage?.completion_tokens ?? 0,
      ...(responseCostUsd !== null ? { responseCostUsd } : {}),
      ...(cachedPromptTokens !== undefined ? { cachedPromptTokens } : {}),
      ...(cacheCreationPromptTokens !== undefined
        ? { cacheCreationPromptTokens }
        : {}),
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
  cachedInputCostPerToken?: number;
  cacheCreationInputCostPerToken?: number;
  source?: "gateway" | "openai-list-price";
  sourceUrl?: string;
  verifiedAt?: string;
  validUntil?: string;
  longContext?: {
    abovePromptTokens: number;
    inputCostPerToken: number;
    outputCostPerToken: number;
    cachedInputCostPerToken?: number;
    cacheCreationInputCostPerToken?: number;
  };
}

function parseNonnegativeNumber(value: unknown): number | null {
  if (typeof value === "string") {
    // Number("") and Number(null) are zero; neither means a free API call.
    if (!/^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim()))
      return null;
    value = Number(value);
  }
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

export const PUBLISHED_PRICING_MODELS = [
  "gpt-5.6-sol-2026-07-09",
  "gpt-5.6-sol",
  "gpt-5.6",
] as const;

/** A dated list-price estimate, never a claim about the gateway's bill. */
export function getPublishedModelPricing(
  model: string,
  at = new Date()
): ModelPricing | null {
  if (!PUBLISHED_PRICING_MODELS.some((supported) => supported === model))
    return null;
  // The published promotional rates are guaranteed only through Nov 21.
  const validUntil = "2026-11-22T00:00:00.000Z";
  if (!Number.isFinite(at.getTime()) || at.getTime() >= Date.parse(validUntil))
    return null;
  return {
    inputCostPerToken: 4 / 1_000_000,
    outputCostPerToken: 20 / 1_000_000,
    cachedInputCostPerToken: 0.4 / 1_000_000,
    cacheCreationInputCostPerToken: 5 / 1_000_000,
    source: "openai-list-price",
    sourceUrl: "https://developers.openai.com/api/docs/models/gpt-5.6-sol",
    verifiedAt: "2026-09-10",
    validUntil,
    longContext: {
      abovePromptTokens: 272_000,
      inputCostPerToken: 8 / 1_000_000,
      outputCostPerToken: 30 / 1_000_000,
      cachedInputCostPerToken: 0.8 / 1_000_000,
      cacheCreationInputCostPerToken: 10 / 1_000_000,
    },
  };
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
 * Uses a dated, labeled OpenAI list-price estimate for known Sol IDs when the
 * gateway has no usable rates. Other unavailable rates remain null. Gateway
 * results are cached for five minutes per endpoint, credential and model.
 */
export async function fetchModelPricing(
  model: string,
  config: Pick<LiteLLMConfig, "baseUrl" | "apiKey">
): Promise<ModelPricing | null> {
  const cacheKey = createHash("sha256")
    .update(JSON.stringify([config.baseUrl, config.apiKey, model]))
    .digest("hex");
  const cached = pricingCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const value =
    (await fetchModelPricingUncached(model, config)) ??
    getPublishedModelPricing(model);
  pricingCache.set(cacheKey, {
    value,
    expiresAt: Math.min(
      Date.now() + PRICING_CACHE_TTL_MS,
      value?.validUntil ? Date.parse(value.validUntil) : Infinity
    ),
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
      signal: AbortSignal.timeout(5_000),
      redirect: "error",
    });
    if (!response.ok) return null;

    const data = (await response.json()) as {
      data?: Array<{
        model_name?: string;
        litellm_params?: { model?: string };
        model_info?: Record<string, unknown>;
      }>;
    };

    const entry =
      data.data?.find((m) => m.model_name === model) ??
      data.data?.find((m) => m.litellm_params?.model === model);
    const info = entry?.model_info;
    const inputCostPerToken = parseNonnegativeNumber(
      info?.input_cost_per_token
    );
    const outputCostPerToken = parseNonnegativeNumber(
      info?.output_cost_per_token
    );
    if (inputCostPerToken === null || outputCostPerToken === null) return null;
    const cachedInputCostPerToken = parseNonnegativeNumber(
      info?.cache_read_input_token_cost
    );
    const cacheCreationInputCostPerToken = parseNonnegativeNumber(
      info?.cache_creation_input_token_cost
    );

    return {
      inputCostPerToken,
      outputCostPerToken,
      source: "gateway",
      ...(cachedInputCostPerToken !== null ? { cachedInputCostPerToken } : {}),
      ...(cacheCreationInputCostPerToken !== null
        ? { cacheCreationInputCostPerToken }
        : {}),
    };
  } catch {
    return null;
  }
}

/** Pure — no I/O — so it's trivially unit-testable. */
export function computeCallCostUsd(
  promptTokens: number,
  completionTokens: number,
  pricing: ModelPricing | null,
  details: Pick<
    LiteLLMCallResult,
    "cachedPromptTokens" | "cacheCreationPromptTokens"
  > = {}
): number | null {
  if (!pricing) return null;
  const cached = details.cachedPromptTokens ?? 0;
  const written = details.cacheCreationPromptTokens ?? 0;
  if (
    ![promptTokens, completionTokens, cached, written].every(
      (value) => Number.isSafeInteger(value) && value >= 0
    ) ||
    cached + written > promptTokens
  )
    return null;
  const rates =
    pricing.longContext && promptTokens > pricing.longContext.abovePromptTokens
      ? pricing.longContext
      : pricing;
  // Preserve the ordinary-input estimate if a gateway omits cache rates. The
  // response cost, when available, is always preferred by the caller.
  const cacheReadRate =
    rates.cachedInputCostPerToken ?? rates.inputCostPerToken;
  const cacheWriteRate =
    rates.cacheCreationInputCostPerToken ?? rates.inputCostPerToken;
  if (
    [
      rates.inputCostPerToken,
      rates.outputCostPerToken,
      cacheReadRate,
      cacheWriteRate,
    ].some((value) => parseNonnegativeNumber(value) === null)
  )
    return null;
  const cost =
    (promptTokens - cached - written) * rates.inputCostPerToken +
    cached * cacheReadRate +
    written * cacheWriteRate +
    completionTokens * rates.outputCostPerToken;
  return Number.isFinite(cost) ? cost : null;
}
