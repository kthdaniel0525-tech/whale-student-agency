import "server-only";
import { z } from "zod";
import { AIError } from "../errors";
import { AI_OPERATIONS } from "../usage/types";
import { estimateCost, getModelPricing, type AIPricing } from "../usage/pricing";
import { getModelCatalog, modelCatalogSchema, modelKey, ROUTING_POLICY } from "./catalog";
import { analyzeComplexity } from "./complexity";
import type { ProviderHealth } from "../reliability/health";
import { COMPLEXITY_LEVELS, MODEL_TIERS, type AIModelDefinition, type ModelHistory, type ModelRoutingDecision, type ModelRoutingRequest, type ModelTier, type ReasoningEffort } from "./types";

const count = z.number().int().nonnegative().max(100_000_000).optional();
const flag = z.boolean().optional();
const requestSchema = z.object({
  degradationPolicy: z.enum(["none", "same-tier-only"]).optional(),
  operationType: z.enum(AI_OPERATIONS), agentId: z.string().nullish(), workflowId: z.string().optional(),
  contextTokens: z.number().int().nonnegative(), outputTokens: z.number().int().min(16),
  requiresStructuredOutput: flag, requiresStreaming: flag, requiresTools: flag,
  qualityCritical: flag, latencySensitive: flag, reasoningRequired: flag,
  minimumTier: z.enum(MODEL_TIERS).optional(), requestComplexity: z.enum(COMPLEXITY_LEVELS).optional(),
  signals: z.object({
    task: z.enum(["classification", "title", "extraction", "transformation", "reschedule", "career-strategy"]).optional(),
    requestCharacters: count, actionCount: count, sourceCount: count, ragChunkCount: count, structuredFieldCount: count,
    reasoningSteps: count, deadlineCount: count, courseCount: count, proof: flag, crossDomain: flag,
    ambiguity: flag, planning: flag, calendarConflicts: flag, semesterStrategy: flag, repeatedMisunderstanding: flag,
    grading: z.enum(["short", "long", "proof"]).optional(),
  }).strict().optional(),
  explicitOverride: z.object({ tier: z.enum(MODEL_TIERS).optional(), model: z.object({ provider: z.string(), model: z.string() }).strict().optional() }).strict().optional(),
}).strict();
export type RoutingOptions = {
  health?: ProviderHealth[];
  catalog?: AIModelDefinition[];
  availableProviders?: string[];
  history?: ModelHistory[];
  pricing?: AIPricing | null;
  allowExplicitOverride?: boolean;
  preferredModel?: string;
};
const rank = (tier: ModelTier) => MODEL_TIERS.indexOf(tier);
const maxTier = (...tiers: ModelTier[]) => MODEL_TIERS[Math.max(...tiers.map(rank))];

/** Pure selection: no provider calls, DB queries, retries, or prompt mutation. */
export function routeModel(input: ModelRoutingRequest, options: RoutingOptions = {}): ModelRoutingDecision {
  const parsed = requestSchema.safeParse(input);
  if (!parsed.success || input.operationType === "embedding") throw new AIError("INVALID_REQUEST");
  const request = parsed.data, signals = request.signals ?? {};
  const complexity = analyzeComplexity(request);
  const classification = ["routing", "semantic-classification"].includes(request.operationType) || signals.task === "classification";
  const simple = classification || ["title", "extraction", "transformation"].includes(signals.task ?? "");
  const planner = request.agentId === "study-planner" || request.operationType === "workflow-planning";
  let floor: ModelTier = simple ? "FAST" : "BALANCED";
  if ((planner && signals.task !== "reschedule") || request.agentId === "academic-manager") floor = "STRONG";
  if (planner && signals.task === "reschedule") floor = "BALANCED";
  if (complexity.level === "MEDIUM") floor = maxTier(floor, "BALANCED");
  if (complexity.level === "HIGH" || complexity.level === "VERY_HIGH" || request.qualityCritical) floor = maxTier(floor, "STRONG");
  if (request.reasoningRequired) floor = "REASONING";
  floor = maxTier(floor, request.minimumTier ?? "FAST");
  let desired = complexity.level === "VERY_HIGH" ? "REASONING" as const : floor;
  let reasonCode = request.reasoningRequired ? "REASONING_REQUIRED" : request.qualityCritical ? "QUALITY_CRITICAL"
    : complexity.level === "VERY_HIGH" ? "VERY_HIGH_COMPLEXITY" : complexity.level === "HIGH" ? "HIGH_COMPLEXITY"
    : planner && signals.task === "reschedule" ? "SIMPLE_RESCHEDULE" : floor === "STRONG" ? "STRATEGIC_PLANNING"
    : simple ? "SIMPLE_OPERATION" : "BALANCED_DEFAULT";
  const override = request.explicitOverride;
  if (override && !options.allowExplicitOverride) throw new AIError("CONFIGURATION");
  if (override?.tier) {
    if (rank(override.tier) < rank(floor)) throw new AIError("INVALID_REQUEST");
    desired = override.tier;
    floor = maxTier(floor, override.tier);
  }
  const catalogResult = modelCatalogSchema.safeParse(options.catalog ?? getModelCatalog());
  if (!catalogResult.success) throw new AIError("CONFIGURATION");
  const pricing = options.pricing === undefined ? getModelPricing() : options.pricing;
  let capacityExcluded = false;
  const candidates = catalogResult.data.flatMap(model => {
    if (!model.enabled || (options.availableProviders && !options.availableProviders.includes(model.provider))
      || (request.requiresStreaming && !model.supportsStreaming) || (request.requiresStructuredOutput && !model.supportsStructuredOutput)
      || (request.requiresTools && !model.supportsTools) || (request.reasoningRequired && !model.supportsReasoning)) return [];
    const tiers = model.tiers.filter(t => rank(t) >= rank(floor));
    // Prefer the requested tier, then higher tiers, then still-safe lower tiers.
    tiers.sort((a, b) => distance(a, desired) - distance(b, desired));
    const tier = tiers[0];
    if (!tier) return [];
    const desiredEffort: ReasoningEffort = model.supportsReasoning
      ? complexity.level === "VERY_HIGH" ? "high" : complexity.level === "HIGH" || request.qualityCritical ? "medium" : "low"
      : "none";
    const efforts: ReasoningEffort[] = ["none", "low", "medium", "high"];
    const effort = model.supportsReasoning ? efforts.find(e => efforts.indexOf(e) >= efforts.indexOf(desiredEffort) && model.reasoningEfforts.includes(e)) : "none";
    if (!effort) return [];
    const outputTokens = request.outputTokens + ROUTING_POLICY.reasoningReserve[effort];
    const requiredCapacity = Math.ceil(request.contextTokens * ROUTING_POLICY.contextSafetyFactor) + ROUTING_POLICY.contextOverheadTokens + outputTokens;
    if (outputTokens > model.maxOutputTokens || requiredCapacity > model.contextWindow) { capacityExcluded = true; return []; }
    const history = options.history?.find(h => modelKey(h) === modelKey(model) && h.samples >= ROUTING_POLICY.historyMinSamples
      && Number.isFinite(h.failureRate) && h.failureRate >= 0 && h.failureRate <= 1);
    const unhealthy = !!history && history.failureRate >= ROUTING_POLICY.unhealthyFailureRate;
    const cost = estimateCost(model.provider, model.model, { inputTokens: request.contextTokens, outputTokens, totalTokens: request.contextTokens + outputTokens }, pricing).estimatedCostUsd;
    return [{ model, tier, effort, outputTokens, history, unhealthy, cost }];
  });
  candidates.sort((a, b) => distance(a.tier, desired) - distance(b.tier, desired)
    || Number(a.unhealthy) - Number(b.unhealthy)
    || (request.latencySensitive ? a.history?.averageLatencyMs !== undefined && b.history?.averageLatencyMs !== undefined
      ? a.history.averageLatencyMs - b.history.averageLatencyMs : a.model.latencyClass - b.model.latencyClass : 0)
    || (Number(b.model.model === options.preferredModel) - Number(a.model.model === options.preferredModel))
    || (a.cost !== null && b.cost !== null ? a.cost - b.cost : a.model.relativeCostClass - b.model.relativeCostClass)
    || modelKey(a.model).localeCompare(modelKey(b.model)));
  const selected = override?.model ? candidates.find(c => modelKey(c.model) === modelKey(override.model!)) : candidates[0];
  // Fail closed if no capable, quality-safe model exists. Never silently shrink
  // context, output budget, or quality floor to make an unavailable model fit.
  if (!selected) throw new AIError(override ? "INVALID_REQUEST" : capacityExcluded ? "AI_CONTEXT_LIMIT" : "AI_SERVICE_TEMPORARILY_UNAVAILABLE");
  let routingMethod: ModelRoutingDecision["routingMethod"] = "rule";
  if (override) { routingMethod = "explicit"; reasonCode = "CONTROLLED_OVERRIDE"; }
  else if (candidates.some(c => c !== selected && c.tier === selected.tier && c.unhealthy) && !selected.unhealthy) {
    routingMethod = "historical"; reasonCode = "MODEL_RELIABILITY";
  } else if (request.latencySensitive && selected.history?.averageLatencyMs !== undefined && candidates.some(c => c !== selected && c.tier === selected.tier
    && c.history?.averageLatencyMs !== undefined && c.history.averageLatencyMs > selected.history!.averageLatencyMs!)) {
    routingMethod = "historical"; reasonCode = "MODEL_LATENCY";
  } else if (selected.tier !== desired) reasonCode = "CAPABILITY_OR_AVAILABILITY";
  // The preferred primary remains stable. Health selects from its explicit,
  // capability-validated chain, rather than silently choosing an unrelated model.
  const safeFloor = maxTier(floor, selected.tier);
  const alternatives = request.degradationPolicy === "none" ? [] : selected.model.fallbackModels.flatMap(ref => {
    const found = candidates.find(c => modelKey(c.model) === modelKey(ref) && rank(c.tier) >= rank(safeFloor));
    return found ? [found] : [];
  });
  const choice = (c: typeof selected) => ({ provider: c.model.provider, model: c.model.model, tier: c.tier, reasoningEffort: c.effort, maxOutputTokens: c.outputTokens });
  const chain = [selected, ...alternatives];
  const available = (c: typeof selected) => !options.health?.some(h => h.providerId === c.model.provider && (!h.model || h.model === c.model.model) && !h.selectable);
  const depth = chain.findIndex(available);
  if (depth < 0) throw new AIError("AI_SERVICE_TEMPORARILY_UNAVAILABLE");
  const actual = chain[depth];
  const fallbackModels = alternatives.map(c => ({ provider: c.model.provider, model: c.model.model }));
  return {
    provider: actual.model.provider, model: actual.model.model, tier: actual.tier, complexity: complexity.level,
    reasonCode, routingMethod, confidence: reasonCode === "BALANCED_DEFAULT" ? 0.7 : 0.9,
    fallbackModels, fallbackChain: chain.slice(depth + 1).map(choice), qualityFloorTier: safeFloor, primary: choice(selected), fallbackDepth: depth,
    fallbackUsed: depth > 0, reasoningEffort: actual.effort, maxOutputTokens: actual.outputTokens,
  };
}
function distance(tier: ModelTier, desired: ModelTier) {
  return rank(tier) >= rank(desired) ? rank(tier) - rank(desired) : 10 + rank(desired) - rank(tier);
}
