import "server-only";
import { z } from "zod";
import { AIError } from "../errors";
import { MODEL_TIERS, type AIModelDefinition } from "./types";

export const MODEL_IDS = { baseline: "gpt-4.1-mini", strong: "gpt-4.1", reasoning: "o3", embedding: "text-embedding-3-small" } as const;
// Response metadata can report a snapshot even when the request used an alias.
// These are price aliases only, not additional enabled routing candidates.
export const MODEL_PRICE_ALIASES = { baseline: "gpt-4.1-mini-2025-04-14", strong: "gpt-4.1-2025-04-14", reasoning: "o3-2025-04-16" } as const;
const identifier = z.string().min(1).regex(/^[A-Za-z0-9_.:/@+-]+$/);
const reference = z.object({ provider: identifier.max(100), model: identifier.max(200) }).strict();
const definition = reference.extend({
  tiers: z.array(z.enum(MODEL_TIERS)).min(1).max(4),
  supportsStreaming: z.boolean(), supportsStructuredOutput: z.boolean(), supportsReasoning: z.boolean(),
  supportsEmbeddings: z.boolean(), supportsTools: z.boolean(),
  reasoningEfforts: z.array(z.enum(["none", "low", "medium", "high"])).max(4),
  contextWindow: z.number().int().positive(), maxOutputTokens: z.number().int().positive(),
  relativeCostClass: z.number().int().min(1).max(10), latencyClass: z.number().int().min(1).max(10),
  enabled: z.boolean(), fallbackModels: z.array(reference).max(20),
}).strict();
export const modelCatalogSchema = z.array(definition).min(1).max(100).superRefine((models, ctx) => {
  const keys = new Set(models.map(modelKey));
  if (keys.size !== models.length) ctx.addIssue({ code: "custom", message: "Duplicate model" });
  for (const model of models) {
    if (model.supportsReasoning !== model.reasoningEfforts.some(e => e !== "none") || model.maxOutputTokens > model.contextWindow)
      ctx.addIssue({ code: "custom", message: "Inconsistent capabilities" });
    if (model.tiers.includes("REASONING") && !model.supportsReasoning)
      ctx.addIssue({ code: "custom", message: "Reasoning tier requires reasoning support" });
    if (model.fallbackModels.some(ref => !keys.has(modelKey(ref)) || modelKey(ref) === modelKey(model)))
      ctx.addIssue({ code: "custom", message: "Invalid fallback reference" });
  }
});
export const modelKey = (model: { provider: string; model: string }) => `${model.provider}:${model.model}`;
const strong = { provider: "openai", model: MODEL_IDS.strong };
const reasoning = { provider: "openai", model: MODEL_IDS.reasoning };
const shared = { provider: "openai", supportsStreaming: true, supportsStructuredOutput: true, supportsTools: true,
  supportsEmbeddings: false, enabled: true, supportsReasoning: false, reasoningEfforts: [], contextWindow: 1_047_576, maxOutputTokens: 32_768 };
// FAST intentionally retains the existing baseline: no unvalidated cheap-model
// downgrade. Different tiers can share a physical model until quality is evaluated.
export const DEFAULT_MODEL_CATALOG: AIModelDefinition[] = [
  { ...shared, model: MODEL_IDS.baseline, tiers: ["FAST", "BALANCED"], relativeCostClass: 1, latencyClass: 1, fallbackModels: [strong, reasoning] },
  { ...shared, ...strong, tiers: ["STRONG"], relativeCostClass: 3, latencyClass: 2, fallbackModels: [reasoning] },
  { ...shared, ...reasoning, tiers: ["REASONING"], supportsReasoning: true, reasoningEfforts: ["low", "medium", "high"],
    contextWindow: 200_000, maxOutputTokens: 100_000, relativeCostClass: 3, latencyClass: 3, fallbackModels: [strong] },
];

/** Complete replacement is deliberate: never guess an unknown model's quality or
 * capabilities. Environment is read at selection time so disabled entries apply
 * without recreating the provider singleton (deployment env changes need reload). */
export function getModelCatalog(): AIModelDefinition[] {
  try {
    const catalog = modelCatalogSchema.parse(process.env.AI_MODEL_CATALOG_JSON ? JSON.parse(process.env.AI_MODEL_CATALOG_JSON) : DEFAULT_MODEL_CATALOG);
    if (process.env.AI_CHAT_MODEL && !catalog.some(m => m.model === process.env.AI_CHAT_MODEL && m.provider === "openai")) throw new Error();
    return catalog;
  } catch { throw new AIError("CONFIGURATION"); }
}

export const ROUTING_POLICY = {
  contextSafetyFactor: 1.15,
  contextOverheadTokens: 256,
  historyMinSamples: 5,
  historyWaitMs: 250,
  unhealthyFailureRate: 0.25,
  // Reasoning shares the output cap. Reserve capacity without shortening answers.
  reasoningReserve: { low: 8_000, medium: 16_000, high: 25_000, none: 0 },
  outputTokens: { classification: 256, title: 128, extraction: 2048, transformation: 2048, tutor: 4096,
    notes: 8192, quiz: 4096, "study-planner": 8192, "academic-manager": 8192, career: 4096, default: 2048 },
} as const;
