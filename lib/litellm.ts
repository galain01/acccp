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
import {
  createJobDiagnostic,
  describeJobDiagnostic,
  type DiagnosticCode,
  type JobDiagnostic,
} from "./job-diagnostics";

export interface LiteLLMConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export const DEFAULT_LITELLM_MODEL = "gpt-5.6-sol-2026-07-09";

/** Contains only diagnostics authored by this client, never a provider body. */
export class LiteLLMError extends Error {
  readonly diagnostic?: JobDiagnostic;

  constructor(message: string, diagnostic?: JobDiagnostic) {
    super(message);
    this.name = "LiteLLMError";
    if (diagnostic) this.diagnostic = createJobDiagnostic(diagnostic);
  }
}

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
  const diagnostic = createJobDiagnostic({
    stage: "conversion",
    code: "provider_configuration",
    model,
  });
  if (!baseUrl)
    throw new LiteLLMError("Missing env var: LITELLM_BASE_URL", diagnostic);
  if (!apiKey)
    throw new LiteLLMError("Missing env var: LITELLM_API_KEY", diagnostic);
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
      type: "image_url";
      image_url: {
        url: `data:image/png;base64,${string}`;
        detail: "high";
      };
    }
  | {
      type: "file";
      file: {
        filename: string;
        file_data: `data:application/pdf;base64,${string}`;
      };
    };

export type LiteLLMUserMessage = string | LiteLLMContentPart[];

function providerStatusCode(status: number): DiagnosticCode {
  if (status === 401 || status === 403) return "provider_auth";
  if (status === 404) return "provider_model_not_found";
  if (status === 413) return "provider_payload_limit";
  if (status === 429) return "provider_rate_or_quota";
  if (status >= 500) return "provider_unavailable";
  return "provider_request_rejected";
}

const MAX_ERROR_BODY_BYTES = 16_384;
const ERROR_BODY_TIMEOUT_MS = 1_500;

// Only exact documented codes/types are understood. Never inspect error.message:
// it can contain source text, filenames, credentials, URLs or nested exceptions.
// LiteLLM's generic throttling_error also covers budgets, so it is deliberately
// absent. Sources: litellm/proxy/_types.py (ProxyErrorTypes), litellm/exceptions.py,
// and OpenAI's openai-api-troubleshooting skill in openai/openai-developers-for-cursor.
const PROVIDER_ERROR_CODES = new Map<string, DiagnosticCode>([
  ["budget_exceeded", "provider_budget"],
  ["insufficient_quota", "provider_quota"],
  ["rate_limit_exceeded", "provider_rate_limit"],
  ["invalid_api_key", "provider_auth"],
  ["model_not_found", "provider_model_not_found"],
  ["token_not_found_in_db", "provider_auth"],
  ["key_model_access_denied", "provider_auth"],
  ["team_model_access_denied", "provider_auth"],
  ["user_model_access_denied", "provider_auth"],
  ["org_model_access_denied", "provider_auth"],
]);

function providerBodyCode(value: unknown): DiagnosticCode | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return;
  const error = (value as Record<string, unknown>).error;
  if (error === null || typeof error !== "object" || Array.isArray(error))
    return;
  const known = ["code", "type"].flatMap((key) => {
    const item = (error as Record<string, unknown>)[key];
    const mapped =
      typeof item === "string" && item.length <= 64
        ? PROVIDER_ERROR_CODES.get(item)
        : undefined;
    return mapped ? [mapped] : [];
  });
  // Conflicting recognized fields are not enough evidence for a precise cause.
  return known.length && known.every((code) => code === known[0])
    ? known[0]
    : undefined;
}

/** Read at most a small error envelope; discard oversized, slow or invalid bodies. */
async function readProviderErrorCode(
  response: Response
): Promise<DiagnosticCode | undefined> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    reader = response.body?.getReader();
    if (!reader) return;
    const bodyReader = reader;
    const contentLength = response.headers.get("content-length");
    if (
      contentLength &&
      /^\d+$/.test(contentLength) &&
      Number(contentLength) > MAX_ERROR_BODY_BYTES
    )
      return;
    const read = async () => {
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const { done, value } = await bodyReader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_ERROR_BODY_BYTES) return;
        chunks.push(value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return providerBodyCode(JSON.parse(new TextDecoder().decode(bytes)));
    };
    return await Promise.race([
      read(),
      new Promise<undefined>((resolve) => {
        timeout = setTimeout(() => resolve(undefined), ERROR_BODY_TIMEOUT_MS);
      }),
    ]);
  } catch {
    return;
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    if (reader) void reader.cancel().catch(() => undefined);
  }
}

function providerDiagnosticHeaders(response: Response): Partial<JobDiagnostic> {
  const retryAfter = response.headers.get("retry-after");
  // LiteLLM documents x-litellm-call-id as its request ID; accept UUIDs only.
  // https://docs.litellm.ai/docs/proxy/response_headers
  return createJobDiagnostic({
    providerRequestId: response.headers.get("x-litellm-call-id"),
    retryAfterSeconds:
      retryAfter && /^\d{1,5}$/.test(retryAfter)
        ? Number(retryAfter)
        : undefined,
  });
}

export async function callLiteLLM(
  systemPrompt: string,
  userMessage: LiteLLMUserMessage,
  config: LiteLLMConfig
): Promise<LiteLLMCallResult> {
  const startedAt = performance.now();
  const diagnosticFor = (code: DiagnosticCode, received?: Response) =>
    createJobDiagnostic({
      ...(received ? providerDiagnosticHeaders(received) : {}),
      stage: "conversion",
      code,
      model: config.model,
      elapsedMs: Math.max(0, Math.round(performance.now() - startedAt)),
      ...(received ? { httpStatus: received.status } : {}),
    });
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
      "Could not connect to the model provider. Check the proxy URL and network access.",
      diagnosticFor("provider_connection")
    );
  }

  if (!response.ok) {
    const code =
      (await readProviderErrorCode(response)) ??
      providerStatusCode(response.status);
    const diagnostic = diagnosticFor(code, response);
    throw new LiteLLMError(
      `LiteLLM error ${response.status}: ${describeJobDiagnostic(diagnostic)}`,
      diagnostic
    );
  }

  // JSON parse errors can include snippets of the response. Never let those
  // exceptions escape to the conversion result or CLI output.
  let rawData: unknown;
  try {
    rawData = await response.json();
  } catch {
    throw new LiteLLMError(
      "The model provider returned a response the app could not read. Please try again.",
      diagnosticFor("provider_invalid_json", response)
    );
  }
  try {
    const data = rawData as {
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
    if (
      !data ||
      !Array.isArray(data.choices) ||
      typeof data.model !== "string" ||
      !data.model.trim()
    )
      throw new Error("Unexpected response structure");

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
      "The model provider returned an invalid response. Please try again.",
      diagnosticFor("provider_invalid_response", response)
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
