/**
 * GET /api/admin/model-info
 *
 * Current gateway rates, or a dated OpenAI list-price estimate for known Sol
 * model IDs. Historical model_calls costs remain immutable snapshots.
 *
 * Response: application/json
 *   { model: string, ...ModelPricing } including source and optional cache rates.
 *   404 if neither source has usable pricing for the configured model.
 */

import { NextResponse } from "next/server";

import { verifyRoleOrUnauthorized } from "@/lib/auth";
import { fetchModelPricing, getLiteLLMConfig } from "@/lib/litellm";

export async function GET() {
  const authCheck = await verifyRoleOrUnauthorized(["admin"]);
  if ("response" in authCheck) return authCheck.response;

  let config;
  try {
    config = getLiteLLMConfig();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }

  const pricing = await fetchModelPricing(config.model, config);
  if (!pricing) {
    return NextResponse.json(
      { error: `No pricing available for model "${config.model}".` },
      { status: 404 }
    );
  }

  return NextResponse.json({
    model: config.model,
    ...pricing,
  });
}
