import { testAllowances, testEntitlements } from "./entitlement-fixture";
import { testHealth } from "./guard-fixture";
import { describe, expect, it, vi, afterEach } from "vitest";
import { GuardrailService } from "@/server/ai/guardrails/service";
import { createMemoryGuardStore, guardKey } from "@/server/ai/guardrails/store";
import { DEFAULT_GUARDRAILS, getGuardrailConfig, PROFILES, type GuardrailConfig } from "@/server/ai/guardrails/config";
import { claimAIRequest } from "@/server/ai/guardrails/requests";
import { createRoutedAIProvider } from "@/server/ai/routing/provider";
import { OpenAIProvider } from "@/server/ai/providers/openai";
import { AI_DEFAULTS } from "@/server/ai/config";
import { MODEL_IDS } from "@/server/ai/routing/catalog";
import type { GuardEvent } from "@/server/ai/guardrails/events";
import type { AIUsageContext } from "@/server/ai/usage/types";
import { prepareDocument } from "@/server/documents/processing";
import { MAX_TEXT_CHARS } from "@/server/documents/config";

function fixture(change: (config: GuardrailConfig) => void = () => {}) {
  let now = Date.now(); const config = structuredClone(DEFAULT_GUARDRAILS); change(config);
  const store = createMemoryGuardStore(() => now), events: GuardEvent[] = [];
  const service = new GuardrailService(store, () => config, async e => { events.push(e); });
  return { service, store, config, events, advance: (ms: number) => { now += ms; } };
}
const context: AIUsageContext = { userId: "student", requestId: "one", agentId: "tutor", selectedTier: "BALANCED" };
const call = (overrides: Partial<Parameters<GuardrailService["reserve"]>[0]> = {}) => ({ context, provider: "openai", model: "balanced", inputTokens: 100, outputTokens: 200, embedding: false, fingerprint: "safe-hash", ...overrides });
async function run(service: GuardrailService, input = call()) { const lease = await service.reserve(input); await lease.finish({ inputTokens: 50, outputTokens: 50, totalTokens: 100 }, .001); }
afterEach(() => vi.unstubAllEnvs());

describe("execution budget policies and atomic live accounting", () => {
  it.each(PROFILES)("creates a bounded %s budget", async guardProfile => {
    const f = fixture(); await run(f.service, call({ context: { ...context, guardProfile, selectedTier: f.config.profiles[guardProfile].qualityFloorTier } }));
    const saved = await f.store.transaction([guardKey("request", context.userId, context.requestId)], tx => tx.get(guardKey("request", context.userId, context.requestId)));
    expect(saved?.data).toMatchObject({ calls: 1, input: 50, output: 50, total: 100, profile: guardProfile });
    expect(f.config.profiles[guardProfile].maxAICalls).toBeGreaterThan(1);
  });
  it("blocks the next call before provider execution and retains failed reservations", async () => {
    const f = fixture(c => { c.profiles.STANDARD.maxAICalls = 2; });
    await run(f.service); const retry = await f.service.reserve(call()); await retry.finish();
    await expect(f.service.reserve(call({ fingerprint: "third" }))).rejects.toMatchObject({ code: "AI_REQUEST_BUDGET_EXCEEDED" });
    expect(f.events).toHaveLength(1);
  });
  it("reconciles real usage instead of permanently charging maximum output", async () => {
    const f = fixture(c => { c.profiles.STANDARD.maxTotalTokens = 450; });
    await run(f.service); await run(f.service, call({ fingerprint: "second" }));
    await expect(f.service.reserve(call({ fingerprint: "third" }))).rejects.toMatchObject({ code: "AI_REQUEST_BUDGET_EXCEEDED" });
  });
  it("reserves concurrent tokens atomically", async () => {
    const f = fixture(c => { c.profiles.STANDARD.maxTotalTokens = 400; });
    const values = await Promise.allSettled([f.service.reserve(call()), f.service.reserve(call({ fingerprint: "two" }))]);
    expect(values.filter(v => v.status === "fulfilled")).toHaveLength(1);
    for (const v of values) if (v.status === "fulfilled") await v.value.finish();
  });
  it("counts embeddings separately and bounds them per job", async () => {
    const f = fixture(c => { c.profiles.BACKGROUND.maxEmbeddingCalls = 2; });
    const input = call({ context: { ...context, backgroundJobId: "job", guardProfile: "BACKGROUND" }, embedding: true, outputTokens: 0 });
    await run(f.service, input); await run(f.service, input);
    await expect(f.service.reserve(input)).rejects.toMatchObject({ code: "AI_EMBEDDING_LIMIT" });
  });
  it("survives workflow resume request IDs and counts each step only once", async () => {
    const f = fixture(); const c = { ...context, workflowRunId: "run", workflowId: "exam-preparation" };
    await f.service.step(c, "prepare", 2); await f.service.step(c, "prepare", 2);
    await f.service.step({ ...c, requestId: "resume" }, "quiz", 2);
    await expect(f.service.step({ ...c, requestId: "another" }, "loop", 2)).rejects.toMatchObject({ code: "AI_WORKFLOW_STEP_LIMIT" });
  });
  it("shares a workflow AI allowance across resumed and nested calls", async () => {
    const f = fixture(); const c = { ...context, workflowRunId: "run", workflowId: "exam-preparation", guardWorkflowCalls: 2 };
    await run(f.service, call({ context: c })); await run(f.service, call({ context: { ...c, requestId: "resume" } }));
    await expect(f.service.reserve(call({ context: { ...c, requestId: "third" }, fingerprint: "new" }))).rejects.toMatchObject({ code: "AI_REQUEST_BUDGET_EXCEEDED" });
    await expect(f.service.reserve(call({ context: { ...c, requestId: "grading", guardWorkflowCalls: undefined }, fingerprint: "grading" }))).rejects.toMatchObject({ code: "AI_REQUEST_BUDGET_EXCEEDED" });
  });
  it("detects agent loops while allowing different designed purposes", async () => {
    const f = fixture(c => { c.profiles.WORKFLOW.maxAgentCalls = 2; });
    const c = { ...context, workflowRunId: "run", workflowStepId: "explain" };
    await run(f.service, call({ context: c, fingerprint: "a" })); await run(f.service, call({ context: c, fingerprint: "b" }));
    await expect(f.service.reserve(call({ context: c, fingerprint: "c" }))).rejects.toMatchObject({ code: "AI_REQUEST_BUDGET_EXCEEDED" });
    await expect(run(f.service, call({ context: { ...c, workflowStepId: "feedback" }, fingerprint: "d" }))).resolves.toBeUndefined();
  });
  it("stops repeated identical attempts, including retry/fallback candidates", async () => {
    const f = fixture(); await run(f.service); await run(f.service, call({ model: "alternate" }));
    await expect(f.service.reserve(call())).rejects.toMatchObject({ code: "AI_REQUEST_BUDGET_EXCEEDED" });
  });
  it("keeps actual overrun debt and stops subsequent calls", async () => {
    const f = fixture(c => { c.profiles.STANDARD.maxTotalTokens = 400; });
    const lease = await f.service.reserve(call()); await lease.finish({ inputTokens: 500, outputTokens: 100, totalTokens: 600 });
    await expect(f.service.reserve(call())).rejects.toMatchObject({ code: "AI_REQUEST_BUDGET_EXCEEDED" });
  });
  it("enforces deadline and quality floor without downgrading", async () => {
    const f = fixture();
    await expect(f.service.reserve(call({ context: { ...context, guardProfile: "COMPLEX", guardQualityFloorTier: "FAST" } }))).rejects.toMatchObject({ code: "AI_REQUEST_BUDGET_EXCEEDED" });
    await expect(f.service.reserve(call({ context: { ...context, guardQualityFloorTier: "STRONG" } }))).rejects.toMatchObject({ code: "AI_REQUEST_BUDGET_EXCEEDED" });
    await run(f.service); f.advance(300001);
    await expect(f.service.reserve(call({ fingerprint: "next" }))).rejects.toMatchObject({ code: "AI_REQUEST_BUDGET_EXCEEDED" });
  });
});

describe("shared rate limits, concurrency, deduplication and operations safety", () => {
  it("refills a standard token bucket over time and isolates users", async () => {
    const f = fixture(c => { c.rates.interactiveMinute = 1; }); await f.service.admit(context);
    await expect(f.service.admit({ ...context, requestId: "two" })).rejects.toMatchObject({ code: "AI_REQUEST_RATE_LIMITED" });
    await expect(f.service.admit({ ...context, userId: "other" })).resolves.toBeUndefined();
    f.advance(60000); await expect(f.service.admit({ ...context, requestId: "two" })).resolves.toBeUndefined();
  });
  it("separates workflow starts and background traffic from interactive admission", async () => {
    const f = fixture(c => { c.rates.workflowHour = 1; c.rates.backgroundHour = 1; });
    await f.service.admit(context, true);
    await expect(f.service.admit({ ...context, requestId: "two" }, true)).rejects.toMatchObject({ code: "AI_REQUEST_RATE_LIMITED" });
    await f.service.admit({ ...context, requestId: "job", backgroundJobId: "job" });
    await expect(f.service.admit({ ...context, requestId: "job-two", backgroundJobId: "job-two" })).rejects.toMatchObject({ code: "AI_REQUEST_RATE_LIMITED" });
    await expect(f.service.admit({ ...context, requestId: "interactive" })).resolves.toBeUndefined();
  });
  it("limits embedding volume across multiple requests", async () => {
    const f = fixture(c => { c.rates.embeddingMinute = 1; });
    await run(f.service, call({ embedding: true, outputTokens: 0 }));
    await expect(f.service.reserve(call({ context: { ...context, requestId: "next" }, embedding: true }))).rejects.toMatchObject({ code: "AI_EMBEDDING_LIMIT" });
  });
  it.each(["user", "provider", "model", "background"] as const)("enforces %s concurrency and releases leases once", async scope => {
    const f = fixture(c => { c.concurrency[scope] = 1; });
    const input = call({ context: { ...context, ...(scope === "background" ? { backgroundJobId: "job" } : {}) } });
    const first = await f.service.reserve(input);
    await expect(f.service.reserve({ ...input, context: { ...input.context, requestId: "parallel" }, fingerprint: "parallel" })).rejects.toMatchObject({ code: "AI_CONCURRENCY_LIMIT" });
    await first.finish(); await first.finish(); await expect(run(f.service, { ...input, fingerprint: "next" })).resolves.toBeUndefined();
  });
  it("reserves interactive capacity even when background capacity is full", async () => {
    const f = fixture(c => { c.concurrency.background = 1; });
    const first = await f.service.reserve(call({ context: { ...context, backgroundJobId: "job" } }));
    await expect(run(f.service, call({ context: { ...context, userId: "interactive", requestId: "fresh" } }))).resolves.toBeUndefined();
    await first.finish();
  });
  it("keeps a student's last AI slot available for interactive work", async () => {
    const f = fixture(c => { c.concurrency.user = 2; });
    const job = await f.service.reserve(call({ context: { ...context, requestId: "job", backgroundJobId: "job" } }));
    await expect(f.service.reserve(call({ context: { ...context, requestId: "job-two", backgroundJobId: "job-two" } }))).rejects.toMatchObject({ code: "AI_CONCURRENCY_LIMIT" });
    await expect(run(f.service, call({ context: { ...context, requestId: "interactive" } }))).resolves.toBeUndefined();
    await job.finish();
  });
  it("bounds whole concurrent requests before any provider call", async () => {
    const f = fixture(c => { c.concurrency.user = 1; });
    const first = await claimAIRequest(context, "one", {}, f.service);
    await expect(claimAIRequest(context, "two", {}, f.service)).rejects.toMatchObject({ code: "AI_CONCURRENCY_LIMIT" });
    await first.complete("saved");
    const next = await claimAIRequest(context, "two", {}, f.service); await next.complete();
  });
  it("claims duplicate JSON/stream turns once and replays only owned references", async () => {
    const f = fixture(); const first = await claimAIRequest(context, "turn", { request: "private words" }, f.service);
    await expect(claimAIRequest(context, "turn", { request: "private words" }, f.service)).rejects.toMatchObject({ code: "AI_DUPLICATE_REQUEST" });
    await first.complete("conversation");
    expect(await claimAIRequest(context, "turn", { request: "private words" }, f.service)).toMatchObject({ replay: true, conversationId: "conversation" });
    await expect(claimAIRequest(context, "turn", { request: "different" }, f.service)).rejects.toMatchObject({ code: "AI_DUPLICATE_REQUEST" });
    expect(await claimAIRequest({ ...context, userId: "another" }, "turn", { request: "private words" }, f.service)).toMatchObject({ replay: false });
    const key = guardKey("dedupe", context.userId, "turn");
    expect(JSON.stringify(await f.store.transaction([key], tx => tx.get(key)))).not.toContain("private words");
  });
  it("does not retry abandoned stream claims automatically", async () => {
    const f = fixture(); const claim = await claimAIRequest(context, "stream", {}, f.service); await claim.complete();
    await expect(claimAIRequest(context, "stream", {}, f.service)).rejects.toMatchObject({ code: "AI_DUPLICATE_REQUEST" });
  });
  it.each(["global", "background", "workflow", "feature"])("honors %s kill switches", async kind => {
    const f = fixture(c => { c.disableAllAI = kind === "global"; c.disableBackgroundAI = kind === "background"; c.disabledFeatures = [kind === "workflow" ? "lecture-study" : "memory-index"]; });
    await expect(f.service.reserve(call({ context: { ...context, backgroundJobId: "job", workflowId: "lecture-study", guardFeature: "memory-index" } }))).rejects.toMatchObject({ code: "AI_FEATURE_DISABLED" });
  });
  it("reports soft cost pressure without reducing quality or blocking valid work", async () => {
    const f = fixture(c => { c.profiles.STANDARD.softCostUsd = .01; });
    const first = await f.service.reserve(call()); await first.finish(undefined, .1);
    expect(f.events.map(e => e.type)).toContain("AI_SOFT_COST_THRESHOLD");
    await expect(run(f.service, call({ fingerprint: "next" }))).resolves.toBeUndefined();
  });
  it("reuses user usage costs as a cached soft observation only", async () => {
    const f = fixture(); const cost = vi.fn(async () => 999);
    const service = new GuardrailService(f.store, () => f.config, async e => { f.events.push(e); }, cost);
    await run(service); await run(service, call({ context: { ...context, requestId: "two" } }));
    expect(cost).toHaveBeenCalledTimes(1);
    expect(f.events.filter(e => e.type === "AI_USER_SOFT_COST_THRESHOLD")).toHaveLength(1);
  });
  it("keeps analytics/event failure separate from authoritative safety failure", async () => {
    const f = fixture(); const service = new GuardrailService(f.store, () => f.config, async () => { throw new Error("analytics down"); });
    await expect(run(service)).resolves.toBeUndefined();
    const unavailable = new GuardrailService({ transaction: async () => { throw new Error("private DB details"); } }, () => f.config, async () => {});
    await expect(unavailable.reserve(call())).rejects.toMatchObject({ code: "AI_GUARD_STORAGE_UNAVAILABLE" });
  });
  it("rejects oversized context/embedding input before execution", async () => {
    const f = fixture();
    await expect(f.service.reserve(call({ inputTokens: f.config.maxContextTokens + 1 }))).rejects.toMatchObject({ code: "AI_CONTEXT_LIMIT" });
    await expect(f.service.reserve(call({ embedding: true, inputTokens: f.config.maxEmbeddingInputTokens + 1 }))).rejects.toMatchObject({ code: "AI_EMBEDDING_LIMIT" });
  });
  it("rejects pathological documents before any embedding call", async () => {
    const generateEmbedding = vi.fn();
    await expect(prepareDocument(new TextEncoder().encode("a".repeat(MAX_TEXT_CHARS + 1)), "TXT", { id: "fixture", generateEmbedding })).rejects.toThrow();
    expect(generateEmbedding).not.toHaveBeenCalled();
  });
  it("supports controlled config overrides without automatically relaxed development policy", () => {
    vi.stubEnv("NODE_ENV", "development"); expect(getGuardrailConfig()).toEqual(DEFAULT_GUARDRAILS);
    vi.stubEnv("AI_GUARDRAILS_JSON", JSON.stringify({ profiles: { STANDARD: { maxAICalls: 2 } } }));
    expect(getGuardrailConfig().profiles.STANDARD.maxAICalls).toBe(2);
    vi.stubEnv("AI_GUARDRAILS_JSON", '{"rates":{"interactiveMinute":0}}'); expect(() => getGuardrailConfig()).toThrow();
  });
  it("protects model quality at the actual SDK boundary with zero extra AI calls", async () => {
    const f = fixture(c => { c.profiles.COMPLEX.maxAICalls = 1; }); const models: string[] = [];
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => { const body = JSON.parse(String(init?.body)); models.push(body.model);
      return new Response(JSON.stringify({ id: "response", model: body.model, status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "Explanation" }] }], usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 } }), { headers: { "content-type": "application/json" } }); });
    const openai = new OpenAIProvider({ ...AI_DEFAULTS, apiKey: "mock" }, fetcher, { allowances: testAllowances, guards: f.service, write: async () => {} });
    const provider = createRoutedAIProvider({ entitlements: testEntitlements, health: testHealth(), providers: { openai }, embeddingProvider: openai, history: async () => [] });
    const input = { messages: [{ role: "user" as const, content: "Explain" }], usageContext: { ...context, guardProfile: "COMPLEX" as const, guardQualityFloorTier: "FAST" as const } };
    await provider.generateText(input); await expect(provider.generateText(input)).rejects.toMatchObject({ code: "AI_REQUEST_BUDGET_EXCEEDED" });
    expect(models).toEqual([MODEL_IDS.strong]); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("releases provider capacity when a stream consumer cancels without replaying the request", async () => {
    const f = fixture(c => { c.concurrency.user = 1; });
    const fetcher = vi.fn<typeof fetch>(async () => new Response('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"partial"}\n\n', { headers: { "content-type": "text/event-stream" } }));
    const provider = new OpenAIProvider({ ...AI_DEFAULTS, apiKey: "mock" }, fetcher, { allowances: testAllowances, guards: f.service, write: async () => {} });
    for await (const event of provider.streamText({ messages: [{ role: "user", content: "Explain" }], usageContext: context })) { expect(event.type).toBe("text-delta"); break; }
    await expect(run(f.service, call({ context: { ...context, requestId: "after-cancel" } }))).resolves.toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("aborts an in-flight provider operation at its deadline", async () => {
    const f = fixture(c => { c.profiles.STANDARD.deadlineMs = 30; });
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => new Promise((_resolve, reject) => {
      if (init?.signal?.aborted) reject(new DOMException("Aborted", "AbortError"));
      else init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    }));
    const provider = new OpenAIProvider({ ...AI_DEFAULTS, apiKey: "mock" }, fetcher, { allowances: testAllowances, guards: f.service, write: async () => {} });
    await expect(provider.generateText({ messages: [{ role: "user", content: "Explain" }], usageContext: context })).rejects.toMatchObject({ code: "AI_REQUEST_BUDGET_EXCEEDED" });
    expect(fetcher.mock.calls.length).toBeLessThanOrEqual(1);
  });
});
