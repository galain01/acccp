import { sql, type SQL } from "drizzle-orm";
import { modelCalls } from "./db/schema";
import {
  getPublishedModelPricing,
  PUBLISHED_PRICING_MODELS,
  type ModelPricing,
} from "./litellm";

/** Shared by dashboard reads and the atomic purge archive. Never rewrites calls. */
export function effectiveModelCallCostSql(): SQL<number | null> {
  const prompt = modelCalls.promptTokens;
  const output = modelCalls.completionTokens;
  const cached = sql`coalesce(${modelCalls.cachedPromptTokens}, 0)::bigint`;
  const written = sql`coalesce(${modelCalls.cacheCreationPromptTokens}, 0)::bigint`;
  const price = (rates: ModelPricing): SQL => sql`(
    (${prompt} - ${cached} - ${written})::numeric * ${rates.inputCostPerToken}::numeric
    + ${cached}::numeric * ${rates.cachedInputCostPerToken ?? rates.inputCostPerToken}::numeric
    + ${written}::numeric * ${rates.cacheCreationInputCostPerToken ?? rates.inputCostPerToken}::numeric
    + ${output}::numeric * ${rates.outputCostPerToken}::numeric)`;
  const alternatives = PUBLISHED_PRICING_MODELS.flatMap((model) => {
    const rates = getPublishedModelPricing(model);
    if (!rates) return [];
    const estimate = rates.longContext
      ? sql`case when ${prompt} > ${rates.longContext.abovePromptTokens}
          then ${price(rates.longContext)} else ${price(rates)} end`
      : price(rates);
    return [sql`when ${modelCalls.model} = ${model} then ${estimate}`];
  });
  if (!alternatives.length) return sql`${modelCalls.costUsd}`;
  return sql`coalesce(${modelCalls.costUsd}, case
    when ${prompt} < 0 or ${output} < 0 or ${cached} < 0 or ${written} < 0
      or ${cached} + ${written} > ${prompt} then null
    else case ${sql.join(alternatives, sql` `)} else null end end)`;
}

/** Metadata-derived and list-price amounts are estimates, including legacy costs. */
export function estimatedModelCallSql(): SQL<boolean> {
  return sql`(${effectiveModelCallCostSql()} is not null and
    (${modelCalls.costUsd} is null or ${modelCalls.costSource} is distinct from 'gateway'))`;
}
