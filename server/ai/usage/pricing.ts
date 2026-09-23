import "server-only";
import { z } from "zod";
import { RAG_EMBEDDING } from "../config";
import { MODEL_IDS, MODEL_PRICE_ALIASES } from "../routing/catalog";
import type { AIUsage } from "../types";

const priceSchema = z.object({
  provider: z.string().min(1).max(100), model: z.string().min(1).max(200),
  inputPerMillion: z.number().finite().nonnegative().max(1_000_000),
  outputPerMillion: z.number().finite().nonnegative().max(1_000_000),
  cachedInputPerMillion: z.number().finite().nonnegative().max(1_000_000).optional(),
  // Reasoning tokens are a subset of output, not an additional token charge.
  reasoningPerMillion: z.number().finite().nonnegative().max(1_000_000).optional(),
}).strict();
export const pricingSchema = z.object({ version: z.string().min(1).max(100).regex(/^[A-Za-z0-9_.:/@+-]+$/), models: z.array(priceSchema).max(200) }).strict()
  .refine(value => new Set(value.models.map(p => `${p.provider}:${p.model}`)).size === value.models.length);
export type AIPricing = z.infer<typeof pricingSchema>;
// Standard API rates checked 2026-09-20. Sources:
// https://developers.openai.com/api/docs/models/gpt-4.1-mini
// https://developers.openai.com/api/docs/models/gpt-4.1
// https://developers.openai.com/api/docs/models/o3
// https://developers.openai.com/api/docs/models/text-embedding-3-small
const mini = { provider: "openai", inputPerMillion: 0.4, outputPerMillion: 1.6, cachedInputPerMillion: 0.1 };
export const DEFAULT_PRICING: AIPricing = {
  version: "standard-2026-09-20",
  models: [
    { ...mini, model: MODEL_IDS.baseline },
    { ...mini, model: MODEL_PRICE_ALIASES.baseline },
    { provider: "openai", model: MODEL_IDS.strong, inputPerMillion: 2, outputPerMillion: 8, cachedInputPerMillion: 0.5 },
    { provider: "openai", model: MODEL_IDS.reasoning, inputPerMillion: 2, outputPerMillion: 8, cachedInputPerMillion: 0.5 },
    { provider: "openai", model: MODEL_PRICE_ALIASES.strong, inputPerMillion: 2, outputPerMillion: 8, cachedInputPerMillion: 0.5 },
    { provider: "openai", model: MODEL_PRICE_ALIASES.reasoning, inputPerMillion: 2, outputPerMillion: 8, cachedInputPerMillion: 0.5 },
    { provider: "openai", model: MODEL_IDS.embedding, inputPerMillion: 0.02, outputPerMillion: 0 },
    // Zero external API token charge; this does not estimate local compute cost.
    { provider: "local", model: RAG_EMBEDDING.id, inputPerMillion: 0, outputPerMillion: 0 },
  ],
};
let cachedEnv: string | undefined;
let cachedPricing: AIPricing | null = DEFAULT_PRICING;
export function getModelPricing(): AIPricing | null {
  const raw = process.env.AI_MODEL_PRICING_JSON;
  if (raw === cachedEnv) return cachedPricing;
  cachedEnv = raw;
  if (!raw) return (cachedPricing = DEFAULT_PRICING);
  try { return (cachedPricing = pricingSchema.parse(JSON.parse(raw))); }
  catch {
    console.warn("AI usage pricing configuration invalid", { code: "INVALID_PRICING" });
    return (cachedPricing = null);
  }
}
export function estimateCost(provider: string, model: string, usage: AIUsage | undefined, pricing = getModelPricing()) {
  const price = pricing?.models.find(p => p.provider === provider && p.model === model);
  if (!usage || !price) return { estimatedCostUsd: null, pricingVersion: pricing?.version ?? null };
  const cached = Math.min(usage.inputTokens, usage.cachedInputTokens ?? 0);
  const reasoning = Math.min(usage.outputTokens, usage.reasoningTokens ?? 0);
  const amount = ((usage.inputTokens - cached) * price.inputPerMillion + cached * (price.cachedInputPerMillion ?? price.inputPerMillion)
    + (usage.outputTokens - reasoning) * price.outputPerMillion + reasoning * (price.reasoningPerMillion ?? price.outputPerMillion)) / 1_000_000;
  return { estimatedCostUsd: Number(amount.toFixed(10)), pricingVersion: pricing!.version };
}
