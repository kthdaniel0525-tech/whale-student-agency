import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_MODEL_CATALOG, getModelCatalog, modelCatalogSchema, MODEL_IDS, ROUTING_POLICY } from "@/server/ai/routing/catalog";
import { analyzeComplexity, requestSignals } from "@/server/ai/routing/complexity";
import { routeModel } from "@/server/ai/routing/router";
import { agentRoutingHints } from "@/server/ai/routing/agent-signals";
import type { AIModelDefinition, ModelRoutingRequest, ModelTier } from "@/server/ai/routing/types";
import type { AdaptiveStrategy } from "@/server/adaptive";
import type { UserContext } from "@/server/context/types";

const base: ModelRoutingRequest = { operationType: "text-generation", contextTokens: 500, outputTokens: 2048 };
const route = (request: Partial<ModelRoutingRequest> = {}) => routeModel({ ...base, ...request });
const model = (name: string, overrides: Partial<AIModelDefinition> = {}): AIModelDefinition => ({ ...DEFAULT_MODEL_CATALOG[0], model: name, tiers: ["BALANCED"], fallbackModels: [], ...overrides });
afterEach(() => vi.unstubAllEnvs());

describe("representative quality-first routing matrix", () => {
  const fixtures: Array<[string, Partial<ModelRoutingRequest>, ModelTier]> = [
    ["simple Tutor", { agentId: "tutor", signals: requestSignals("What is a stack?") }, "BALANCED"],
    ["course-grounded Tutor", { agentId: "tutor", signals: { sourceCount: 1, ragChunkCount: 3 } }, "BALANCED"],
    ["proof", { agentId: "tutor", signals: requestSignals("Explain this induction proof and why the inductive hypothesis is valid.") }, "STRONG"],
    ["new explanation strategy", { agentId: "tutor", signals: requestSignals("I still do not understand. Explain in a different way.") }, "STRONG"],
    ["difficult cross-domain proof", { agentId: "tutor", signals: { proof: true, reasoningSteps: 5, crossDomain: true, actionCount: 3 } }, "REASONING"],
    ["Notes extraction", { agentId: "notes", signals: requestSignals("Extract the key terms.") }, "FAST"],
    ["Notes summary", { agentId: "notes", signals: { sourceCount: 1 } }, "BALANCED"],
    ["large Notes synthesis", { agentId: "notes", contextTokens: 20_000, signals: { sourceCount: 4 } }, "STRONG"],
    ["Quiz generation", { agentId: "quiz", requiresStructuredOutput: true }, "BALANCED"],
    ["short grading", { agentId: "quiz", operationType: "evaluation", signals: { grading: "short" } }, "BALANCED"],
    ["long grading", { agentId: "quiz", operationType: "evaluation", signals: { grading: "long" } }, "STRONG"],
    ["proof grading", { agentId: "quiz", operationType: "evaluation", signals: { grading: "proof" } }, "STRONG"],
    ["difficult short grading", { agentId: "quiz", operationType: "evaluation", qualityCritical: true }, "STRONG"],
    ["simple Study Planner change", { agentId: "study-planner", signals: { ...requestSignals("Move today's session to tomorrow."), planning: true } }, "BALANCED"],
    ["weekly plan", { agentId: "study-planner", signals: { planning: true, deadlineCount: 3 } }, "STRONG"],
    ["multi-exam calendar conflicts", { agentId: "study-planner", signals: { planning: true, deadlineCount: 4, courseCount: 3, calendarConflicts: true } }, "REASONING"],
    ["Academic Manager default", { agentId: "academic-manager" }, "STRONG"],
    ["semester recovery", { agentId: "academic-manager", signals: { planning: true, semesterStrategy: true, courseCount: 4 } }, "REASONING"],
    ["resume rewrite", { agentId: "career", signals: requestSignals("Rewrite this resume bullet.") }, "BALANCED"],
    ["career strategy", { agentId: "career", signals: requestSignals("Assess my skill gaps and career strategy.") }, "STRONG"],
    ["Agent classification", { operationType: "routing", latencySensitive: true, outputTokens: 180 }, "FAST"],
    ["ambiguous classification", { operationType: "routing", signals: { ambiguity: true, actionCount: 4 } }, "BALANCED"],
    ["title extraction", { signals: { task: "title" }, outputTokens: 128 }, "FAST"],
    ["workflow Quiz step", { agentId: "quiz", workflowId: "exam-preparation" }, "BALANCED"],
    ["workflow planner step", { agentId: "study-planner", workflowId: "exam-preparation" }, "STRONG"],
    ["workflow final summary", { operationType: "summarization", workflowId: "exam-preparation" }, "BALANCED"],
    ["unknown task safe default", {}, "BALANCED"],
  ];
  it.each(fixtures)("%s → %s", (_name, request, tier) => { expect(route(request).tier).toBe(tier); });
  it("does not classify request length as difficult reasoning", () => {
    expect(analyzeComplexity({ ...base, signals: { requestCharacters: 20_000 } }).level).toBe("LOW");
    expect(route({ agentId: "tutor", signals: { requestCharacters: 20_000 } }).tier).toBe("BALANCED");
  });
  it.each(["LOW", "MEDIUM", "HIGH", "VERY_HIGH"] as const)("respects explicit complexity %s without weakening inferred evidence", level => {
    expect(analyzeComplexity({ ...base, requestComplexity: level }).level).toBe(level);
    expect(route({ requestComplexity: "LOW", signals: { proof: true } }).tier).toBe("STRONG");
  });
  it("does not mistake a new weekly plan for a simple move", () => {
    expect(requestSignals("Move today's session and create my weekly plan.").task).toBeUndefined();
  });
  it("extracts Korean academic signals without recording text", () => {
    expect(requestSignals("귀납 증명을 다른 방식으로 설명해 줘")).toMatchObject({ proof: true, repeatedMisunderstanding: true });
    expect(Object.values(requestSignals("나의 학기 계획을 분석해 줘"))).not.toContain("나의 학기 계획을 분석해 줘");
  });
});

describe("catalog, capabilities, quality and context constraints", () => {
  it("validates defaults and conservatively shares the existing baseline across fast/balanced", () => {
    expect(modelCatalogSchema.parse(DEFAULT_MODEL_CATALOG)).toEqual(DEFAULT_MODEL_CATALOG);
    expect(route({ operationType: "routing" }).model).toBe(route({ agentId: "tutor" }).model);
    expect(route({ agentId: "tutor" }).model).toBe(MODEL_IDS.baseline);
  });
  it("rejects duplicate models, invalid fallbacks and fictional reasoning capabilities", () => {
    expect(modelCatalogSchema.safeParse([...DEFAULT_MODEL_CATALOG, DEFAULT_MODEL_CATALOG[0]]).success).toBe(false);
    expect(modelCatalogSchema.safeParse([model("bad", { fallbackModels: [{ provider: "other", model: "missing" }] })]).success).toBe(false);
    expect(modelCatalogSchema.safeParse([model("bad", { tiers: ["REASONING"] })]).success).toBe(false);
  });
  it("loads a complete env catalog and rejects unknown legacy model capability assumptions", () => {
    vi.stubEnv("AI_MODEL_CATALOG_JSON", JSON.stringify(DEFAULT_MODEL_CATALOG.map(m => ({ ...m, enabled: m.model !== MODEL_IDS.baseline }))));
    expect(route({ agentId: "tutor" }).tier).toBe("STRONG");
    vi.stubEnv("AI_CHAT_MODEL", "unvalidated-model");
    expect(() => getModelCatalog()).toThrow(expect.objectContaining({ code: "CONFIGURATION" }));
  });
  it("fails closed for malformed catalog", () => {
    vi.stubEnv("AI_MODEL_CATALOG_JSON", "not json");
    expect(() => route()).toThrow(expect.objectContaining({ code: "CONFIGURATION" }));
  });
  it.each(["requiresStructuredOutput", "requiresStreaming", "requiresTools"] as const)("excludes incompatible models for %s", capability => {
    const unsupported = { requiresStructuredOutput: "supportsStructuredOutput", requiresStreaming: "supportsStreaming", requiresTools: "supportsTools" }[capability];
    const catalog = [model("cheap", { [unsupported]: false }), model("capable")];
    expect(routeModel({ ...base, [capability]: true }, { catalog }).model).toBe("capable");
  });
  it("only selects registered providers in execution", () => {
    const catalog = [model("fast", { provider: "future" }), model("installed", { provider: "openai" })];
    expect(routeModel(base, { catalog, availableProviders: ["openai"] }).model).toBe("installed");
    expect(routeModel(base, { catalog, availableProviders: ["future"] }).provider).toBe("future");
  });
  it("chooses capacity without truncating or lowering output", () => {
    const catalog = [model("small", { contextWindow: 4096, maxOutputTokens: 2048 }), model("large", { relativeCostClass: 5 })];
    const result = routeModel({ ...base, contextTokens: 4000 }, { catalog });
    expect(result.model).toBe("large"); expect(result.maxOutputTokens).toBe(2048);
  });
  it("rejects output caps and safety-margin overruns", () => {
    expect(() => routeModel(base, { catalog: [model("small", { maxOutputTokens: 1024 })] })).toThrow();
    const catalog = [model("small", { contextWindow: 4096, maxOutputTokens: 2048 })];
    expect(() => routeModel({ ...base, contextTokens: 2000 }, { catalog })).toThrow(expect.objectContaining({ code: "AI_CONTEXT_LIMIT" }));
  });
  it("uses a large strong model if very large synthesis cannot fit a reasoning model", () => {
    const result = route({ contextTokens: 250_000, signals: { sourceCount: 5, actionCount: 3 } });
    expect(result.tier).toBe("STRONG"); expect(result.reasonCode).toBe("CAPABILITY_OR_AVAILABILITY");
    expect(() => route({ contextTokens: 250_000, reasoningRequired: true })).toThrow();
  });
  it("retains quality floors even when all strong models are disabled", () => {
    const catalog = DEFAULT_MODEL_CATALOG.map(m => ({ ...m, enabled: m.tiers.includes("BALANCED") }));
    expect(() => routeModel({ ...base, signals: { proof: true } }, { catalog })).toThrow();
  });
  it.each(["tutor", "study-planner", "academic-manager"])("never routes quality-critical %s to FAST", agentId => {
    expect(["STRONG", "REASONING"]).toContain(route({ agentId, qualityCritical: true, latencySensitive: true }).tier);
  });
  it("does not route embeddings through chat models", () => {
    expect(() => route({ operationType: "embedding" })).toThrow(expect.objectContaining({ code: "INVALID_REQUEST" }));
  });
  it("rejects invalid routing metrics", () => {
    expect(() => route({ contextTokens: -1 })).toThrow();
    expect(() => route({ signals: { actionCount: NaN } })).toThrow();
  });
});

describe("reliability, latency, cost, effort and controlled overrides", () => {
  const catalog = [model("cheap"), model("expensive", { relativeCostClass: 5 })];
  const pricing = { version: "fixture", models: catalog.map((m, i) => ({ provider: m.provider, model: m.model, inputPerMillion: 1 + i, outputPerMillion: 1 + i })) };
  it("uses price only within equivalent quality/capability candidates", () => {
    expect(routeModel(base, { catalog, pricing }).model).toBe("cheap");
    const inverse = { ...pricing, models: pricing.models.map(p => ({ ...p, inputPerMillion: p.model === "cheap" ? 99 : 1 })) };
    expect(routeModel(base, { catalog, pricing: inverse }).model).toBe("expensive");
    expect(route({ qualityCritical: true }).tier).toBe("STRONG");
  });
  it("prefers an equivalent reliable model over lower cost with sufficient evidence", () => {
    const result = routeModel(base, { catalog, pricing, history: [{ provider: "openai", model: "cheap", samples: 10, failureRate: .5 }] });
    expect(result.model).toBe("expensive"); expect(result.routingMethod).toBe("historical");
    expect(routeModel(base, { catalog, pricing, history: [{ provider: "openai", model: "cheap", samples: 1, failureRate: 1 }] }).model).toBe("cheap");
  });
  it("uses latency ahead of price when quality is adequate", () => {
    const history = [{ provider: "openai", model: "cheap", samples: 10, failureRate: 0, averageLatencyMs: 5000 },
      { provider: "openai", model: "expensive", samples: 10, failureRate: 0, averageLatencyMs: 100 }];
    expect(routeModel({ ...base, latencySensitive: true }, { catalog, pricing, history }).model).toBe("expensive");
    expect(routeModel(base, { catalog, pricing, history }).model).toBe("cheap");
  });
  it("keeps unknown prices usable without assuming zero cost", () => {
    expect(routeModel(base, { catalog, pricing: null }).model).toBe("cheap");
  });
  it.each([["LOW", "low"], ["HIGH", "medium"], ["VERY_HIGH", "high"]] as const)("chooses %s effort and reserves answer capacity", (requestComplexity, effort) => {
    const result = route({ reasoningRequired: true, requestComplexity });
    expect(result.reasoningEffort).toBe(effort);
    expect(result.maxOutputTokens).toBe(base.outputTokens + ROUTING_POLICY.reasoningReserve[effort]);
  });
  it("does not enable reasoning on ordinary requests", () => { expect(route().reasoningEffort).toBe("none"); });
  it("adapts to a model's supported effort levels without reducing required reasoning", () => {
    const highOnly = { ...DEFAULT_MODEL_CATALOG[2], reasoningEfforts: ["high" as const], fallbackModels: [] };
    expect(routeModel({ ...base, reasoningRequired: true }, { catalog: [highOnly] }).reasoningEffort).toBe("high");
    const lowOnly = { ...highOnly, reasoningEfforts: ["low" as const] };
    expect(() => routeModel({ ...base, reasoningRequired: true, requestComplexity: "VERY_HIGH" }, { catalog: [lowOnly] })).toThrow();
  });
  it("restricts explicit overrides and enforces quality floors", () => {
    const explicitOverride = { tier: "STRONG" as const };
    expect(() => routeModel({ ...base, explicitOverride })).toThrow(expect.objectContaining({ code: "CONFIGURATION" }));
    expect(routeModel({ ...base, explicitOverride }, { allowExplicitOverride: true }).routingMethod).toBe("explicit");
    expect(() => routeModel({ ...base, qualityCritical: true, explicitOverride: { tier: "FAST" } }, { allowExplicitOverride: true })).toThrow();
    expect(() => routeModel({ ...base, qualityCritical: true, explicitOverride: { model: { provider: "openai", model: MODEL_IDS.baseline } } }, { allowExplicitOverride: true })).toThrow();
  });
  it("does not include unsafe/disabled/undersized alternatives in fallback references", () => {
    const result = route({ qualityCritical: true });
    expect(result.fallbackModels).toEqual([{ provider: "openai", model: MODEL_IDS.reasoning }]);
    expect(result.fallbackUsed).toBe(false);
    expect(route({ reasoningRequired: true }).fallbackModels).toEqual([]);
    expect(route({ qualityCritical: true, contextTokens: 250_000 }).fallbackModels).toEqual([]);
  });
  it("derives planning and adaptation from bounded Context Builder data", () => {
    const course = { id: "math", courseCode: "MATH", courseName: "Math" };
    const context = { metadata: {}, documents: [{ documentId: "d1" }, { documentId: "d1" }],
      assignments: [{ status: "COMPLETED", course }, { status: "TODO", course }], exams: [{ course }],
      availability: { days: [{ availableMinutes: 0 }] }, academicOverview: { totalActiveCourses: 3 } } as unknown as UserContext;
    const adaptive = { retryStrategy: "switch-approach", feedbackStyle: "guided-feedback" } as AdaptiveStrategy;
    const hints = agentRoutingHints("study-planner", "Plan my week", context, adaptive);
    expect(hints.signals).toMatchObject({ sourceCount: 1, ragChunkCount: 2, planning: true, deadlineCount: 2, courseCount: 3, calendarConflicts: true, repeatedMisunderstanding: true });
  });
});
