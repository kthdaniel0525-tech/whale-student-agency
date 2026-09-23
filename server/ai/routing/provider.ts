import { checkAIUsageAllowance } from "../../entitlements/usage";
import { assertModelTier } from "../../entitlements/service";
import type { Entitlements } from "@/lib/entitlements/types";
import type { AIUsageContext } from "../usage/types";
import "server-only";
import { routingVersion } from "../evaluation/versions";
import { AIProviderRegistry } from "../registry";
import { providerHealth } from "../reliability/health";
import { executeReliable, oneResult, type ReliabilityOptions } from "../reliability/executor";
import { z } from "zod";
import { estimateTokens } from "../../conversations/tokens";
import { AIError } from "../errors";
import type { AIProvider, AIEmbeddingProvider, AITextRequest, AIStructuredRequest } from "../types";
import { captureUsageContext } from "../usage/context";
import { getModelCatalog, ROUTING_POLICY } from "./catalog";
import { getRecentModelHistory } from "./history";
import { routeModel, type RoutingOptions } from "./router";
import { MODEL_TIERS, type ModelHistory, type ModelRoutingDecision, type ModelRoutingRequest } from "./types";
import { getGuardrailConfig } from "../guardrails/config";

type Options = ReliabilityOptions & {
  entitlements?: (usage: AIUsageContext, tokens: number) => Promise<Entitlements | undefined>;
  registry?: AIProviderRegistry;
  /** Already tracked provider implementations; do not wrap tracking twice. */
  providers?: Record<string, AIProvider>;
  embeddingProvider: AIEmbeddingProvider;
  catalog?: RoutingOptions["catalog"];
  history?: (userId?: string) => Promise<ModelHistory[]>;
  pricing?: RoutingOptions["pricing"];
};
const overrideSchema = z.object({ tier: z.enum(MODEL_TIERS).optional(), model: z.object({ provider: z.string().min(1), model: z.string().min(1) }).strict().optional() }).strict();

/** Route after prompt assembly/compression. The messages and schema are passed
 * through unchanged. Reliability executes the validated ordered candidate chain. */
export function createRoutedAIProvider(options: Options): AIProvider {
  const registry = options.registry ?? new AIProviderRegistry(() => options.catalog ?? getModelCatalog(), options.health ?? providerHealth);
  for (const [id, provider] of Object.entries(options.providers ?? {})) registry.register({ id, create: () => provider });
  async function prepare<T extends AITextRequest>(request: T, mode: "text-generation" | "structured-output" | "streaming", schema?: z.ZodTypeAny) {
    if (request.signal?.aborted) throw new AIError("CANCELLED");
    const usage = captureUsageContext(request.usageContext);
    const hints = request.routing ?? {};
    const operationType = usage.operationType ?? mode;
    const profileFloor = usage.guardProfile ? getGuardrailConfig().profiles[usage.guardProfile].qualityFloorTier : undefined;
    const qualityFloor = profileFloor || usage.guardQualityFloorTier
      ? MODEL_TIERS[Math.max(MODEL_TIERS.indexOf(profileFloor ?? "FAST"), MODEL_TIERS.indexOf(usage.guardQualityFloorTier ?? "FAST"))] : undefined;
    const structure = schema ? schemaFootprint(schema) : { tokens: 0, fields: 0 };
    const contextTokens = request.messages.reduce((sum, message) => sum + estimateTokens(message.content) + 8, 4) + structure.tokens;
    const budgets = ROUTING_POLICY.outputTokens;
    const key = operationType === "routing" || operationType === "semantic-classification" ? "classification"
      : hints.signals?.task && hints.signals.task in budgets ? hints.signals.task : usage.agentId ?? "default";
    const outputTokens = request.maxOutputTokens ?? Math.max(budgets[key as keyof typeof budgets] ?? budgets.default, Number(process.env.AI_MAX_OUTPUT_TOKENS ?? 0));
    const entitlements = await (options.entitlements ?? (async (context, tokens) => context.userId ? (await checkAIUsageAllowance(context.userId, context, tokens)).values : undefined))(usage, contextTokens + outputTokens);
    const allowOverride = process.env.NODE_ENV !== "production" || process.env.AI_ROUTING_EVALUATION_MODE === "true";
    let explicitOverride: ModelRoutingRequest["explicitOverride"];
    try {
      if (process.env.AI_ROUTING_OVERRIDE_JSON) explicitOverride = overrideSchema.parse(JSON.parse(process.env.AI_ROUTING_OVERRIDE_JSON));
      if (request.model) explicitOverride = { ...explicitOverride, model: { provider: "openai", model: request.model } };
    } catch { throw new AIError("CONFIGURATION"); }
    const catalog = options.catalog ?? getModelCatalog();
    if (explicitOverride && !allowOverride) throw new AIError("CONFIGURATION");
    // Optional observations never hold up the request beyond a short read budget.
    const history = await historyWithinBudget(() => (options.history ?? getRecentModelHistory)(usage.userId));
    if (request.signal?.aborted) throw new AIError("CANCELLED");
    const decision = routeModel({
      ...hints, operationType, agentId: usage.agentId, workflowId: usage.workflowId, contextTokens, outputTokens,
      ...(!["routing", "summarization", "semantic-classification"].includes(operationType) && qualityFloor ? {
        minimumTier: MODEL_TIERS[Math.max(MODEL_TIERS.indexOf(hints.minimumTier ?? "FAST"), MODEL_TIERS.indexOf(qualityFloor))],
      } : {}),
      signals: { ...hints.signals, structuredFieldCount: Math.max(hints.signals?.structuredFieldCount ?? 0, structure.fields) },
      requiresStreaming: mode === "streaming", requiresStructuredOutput: mode === "structured-output",
      latencySensitive: hints.latencySensitive ?? (operationType === "routing" || operationType === "semantic-classification"),
      ...(explicitOverride ? { explicitOverride } : {}),
    }, { catalog, availableProviders: registry.listEnabled(), history, health: await (options.health ?? providerHealth).list(catalog),
      pricing: options.pricing, allowExplicitOverride: allowOverride, preferredModel: process.env.AI_CHAT_MODEL });
    if (entitlements) {
      assertModelTier(entitlements, decision.tier);
      decision.fallbackChain = decision.fallbackChain.filter(candidate => MODEL_TIERS.indexOf(candidate.tier) <= MODEL_TIERS.indexOf(entitlements["ai.modelTier.max"]));
    }
    return { decision, catalog, request: {
      ...request, model: decision.model, maxOutputTokens: decision.maxOutputTokens, reasoningEffort: decision.reasoningEffort,
      usageContext: { ...usage, ...routingTelemetry(decision), routingVersion: routingVersion(catalog), guardQualityFloorTier: qualityFloor ?? decision.tier, guardInputTokens: contextTokens },
    } };
  }
  function reliabilityInput(prepared: Awaited<ReturnType<typeof prepare>>) {
    return { candidates: [prepared.decision, ...prepared.decision.fallbackChain].map(c => ({ ...c, contextWindow: prepared.catalog.find(m => m.provider === c.provider && m.model === c.model)?.contextWindow })),
      primary: prepared.decision.primary, initialDepth: prepared.decision.fallbackDepth, signal: prepared.request.signal,
      usageContext: prepared.request.usageContext, reasoning: prepared.decision.reasoningEffort !== "none" };
  }
  return {
    async generateText(request) {
      const prepared = await prepare(request, "text-generation");
      return oneResult(executeReliable({ ...reliabilityInput(prepared), operation: "text",
        invoke: async function* (candidate, attempt) { yield await registry.get(candidate.provider).generateText({ ...prepared.request, ...candidate, ...attempt, usageContext: { ...attempt.usageContext, selectedTier: candidate.tier } }); },
      }, options));
    },
    async generateStructuredOutput<T>(request: AIStructuredRequest<T>) {
      const prepared = await prepare(request, "structured-output", request.schema);
      return oneResult(executeReliable({ ...reliabilityInput(prepared), operation: "structured",
        invoke: async function* (candidate, attempt) { yield await registry.get(candidate.provider).generateStructuredOutput({ ...prepared.request, ...candidate, ...attempt, usageContext: { ...attempt.usageContext, selectedTier: candidate.tier } }); },
      }, options));
    },
    streamText(request) {
      // Capture ownership/correlation before the stream escapes its parent scope.
      const captured = { ...request, usageContext: captureUsageContext(request.usageContext) };
      return (async function* () {
        const prepared = await prepare(captured, "streaming");
        yield* executeReliable({ ...reliabilityInput(prepared), operation: "streaming",
          invoke: (candidate, attempt) => registry.get(candidate.provider).streamText({ ...prepared.request, ...candidate, ...attempt, usageContext: { ...attempt.usageContext, selectedTier: candidate.tier } }),
          content: value => value.type === "text-delta" ? value.text : "", isFinal: value => value.type === "complete",
        }, options);
      })();
    },
    // Persisted embedding spaces must never change through chat routing.
    generateEmbedding: request => options.embeddingProvider.generateEmbedding(request),
  };
}

async function historyWithinBudget(load: () => Promise<ModelHistory[]>): Promise<ModelHistory[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([load(), new Promise<ModelHistory[]>(resolve => {
      timer = setTimeout(() => resolve([]), ROUTING_POLICY.historyWaitMs);
    })]);
  } catch { return []; }
  finally { if (timer) clearTimeout(timer); }
}

export function routingTelemetry(decision: ModelRoutingDecision) {
  return { selectedModel: decision.model, selectedTier: decision.tier, routingComplexity: decision.complexity,
    routingReasonCode: decision.reasonCode, routingMethod: decision.routingMethod, fallbackUsed: decision.fallbackUsed };
}

/** Conservative provider-independent schema overhead estimate, including field
 * names, enum values and descriptions. No schema content is persisted. */
function schemaFootprint(schema: z.ZodTypeAny, active = new Set<z.ZodTypeAny>()): { tokens: number; fields: number } {
  if (active.has(schema)) return { tokens: 32, fields: 0 };
  active.add(schema);
  let tokens = 32 + estimateTokens(schema.description ?? ""), fields = 0;
  const children: z.ZodTypeAny[] = [];
  if (schema instanceof z.ZodObject) {
    for (const [key, value] of Object.entries(schema.shape as Record<string, z.ZodTypeAny>)) {
      tokens += 16 + estimateTokens(key); fields++; children.push(value);
    }
  } else if (schema instanceof z.ZodArray) children.push(schema.element);
  else if (schema instanceof z.ZodEffects) children.push(schema.innerType());
  else if (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable) children.push(schema.unwrap());
  else if (schema instanceof z.ZodUnion) children.push(...schema.options);
  else if (schema instanceof z.ZodDiscriminatedUnion) children.push(...schema.options);
  else if (schema instanceof z.ZodIntersection) children.push(schema._def.left, schema._def.right);
  else if (schema instanceof z.ZodTuple) children.push(...schema.items, ...(schema._def.rest ? [schema._def.rest] : []));
  else if (schema instanceof z.ZodDefault) children.push(schema.removeDefault());
  else if (schema instanceof z.ZodRecord) children.push(schema.keySchema, schema.valueSchema);
  else if (schema instanceof z.ZodLazy) children.push(schema.schema);
  else tokens += estimateTokens(JSON.stringify(schema._def));
  for (const child of children) { const result = schemaFootprint(child, active); tokens += result.tokens; fields += result.fields; }
  active.delete(schema);
  return { tokens, fields };
}
