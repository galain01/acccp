/**
 * GET /api/admin/model-info
 * Optional query: stage=convert|validate selects that stage's configured model.
 *
 * Current gateway rates, or a dated OpenAI list-price estimate for known Sol
 * model IDs. Historical model_calls costs remain immutable snapshots.
 *
 * Response: application/json
 *   { model: string, ...ModelPricing } including source and optional cache rates.
 *   Includes stage when explicitly selected; no query preserves the shared model.
 *   404 if neither source has usable pricing for the configured model.
 */

import { NextResponse } from "next/server";

import { verifyRoleOrUnauthorized } from "@/lib/auth";
import { fetchModelPricing, getLiteLLMConfig } from "@/lib/litellm";

export async function GET(request: Request) {
  const authCheck = await verifyRoleOrUnauthorized(["admin"]);
  if ("response" in authCheck) return authCheck.response;

  const stages = new URL(request.url).searchParams.getAll("stage");
  const stage = stages[0];
  if (
    stages.length > 1 ||
    (stage !== undefined && stage !== "convert" && stage !== "validate")
  ) {
    return NextResponse.json(
      { error: 'The stage must be either "convert" or "validate".' },
      { status: 400 }
    );
  }

  let config;
  try {
    config = stage ? getLiteLLMConfig(stage) : getLiteLLMConfig();
  } catch {
    return NextResponse.json(
      { error: "Model provider configuration is unavailable." },
      { status: 500 }
    );
  }

  let pricing;
  try {
    pricing = await fetchModelPricing(config.model, config);
  } catch {
    return NextResponse.json(
      { error: "Model pricing is temporarily unavailable." },
      { status: 502 }
    );
  }
  if (!pricing) {
    return NextResponse.json(
      { error: `No pricing available for model "${config.model}".` },
      { status: 404 }
    );
  }

  return NextResponse.json({
    model: config.model,
    ...(stage ? { stage } : {}),
    ...pricing,
  });
}
