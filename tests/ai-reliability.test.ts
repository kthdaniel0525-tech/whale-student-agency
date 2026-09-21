import { testAllowances, testEntitlements } from "./entitlement-fixture";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { AIError } from "@/server/ai/errors";
import type { AIProvider, AIStreamEvent, AITextRequest } from "@/server/ai/types";
import { AIProviderRegistry } from "@/server/ai/registry";
import { DEFAULT_MODEL_CATALOG } from "@/server/ai/routing/catalog";
import type { AIModelDefinition } from "@/server/ai/routing/types";
import { createRoutedAIProvider } from "@/server/ai/routing/provider";
import { DEFAULT_RELIABILITY, getReliabilityConfig } from "@/server/ai/reliability/config";
import { ProviderHealthService } from "@/server/ai/reliability/health";
import { classifyFailure } from "@/server/ai/reliability/failures";
import { createReliableEmbeddingProvider } from "@/server/ai/reliability/embeddings";
import { createMemoryGuardStore, guardKey } from "@/server/ai/guardrails/store";
import { GuardrailService } from "@/server/ai/guardrails/service";
import { DEFAULT_GUARDRAILS } from "@/server/ai/guardrails/config";
import { type UsageRecordInput } from "@/server/ai/usage/records";
import { testGuards } from "./guard-fixture";

const messages = [{ role: "user", content: "private student content" }] as const;
const catalog: AIModelDefinition[] = [
  { ...DEFAULT_MODEL_CATALOG[1], provider: "primary", model: "strong", tiers: ["STRONG"], contextWindow: 100000, fallbackModels: [{ provider: "backup", model: "equivalent" }, { provider: "cheap", model: "fast" }] },
  { ...DEFAULT_MODEL_CATALOG[1], provider: "backup", model: "equivalent", tiers: ["STRONG"], contextWindow: 200000, relativeCostClass: 9, fallbackModels: [] },
  { ...DEFAULT_MODEL_CATALOG[0], provider: "cheap", model: "fast", tiers: ["FAST"], fallbackModels: [] },
];
function adapter(): AIProvider {
  return {
    generateText: vi.fn(async r => ({ id: "response", model: r.model!, text: "Useful answer", usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 } })),
    generateStructuredOutput: vi.fn(async r => ({ id: "structured", model: r.model!, text: '{"answer":"valid"}', data: await r.schema.parseAsync({ answer: "valid" }) })),
    streamText: vi.fn(async function* (r: AITextRequest): AsyncGenerator<AIStreamEvent> { yield { type: "text-delta", text: "Useful answer" }; yield { type: "complete", response: { id: "stream", model: r.model!, text: "Useful answer" } }; }),
    generateEmbedding: vi.fn(async r => ({ model: r.model!, vector: [1, 0, 0] })),
  };
}
function fixture(models = structuredClone(catalog)) {
  const config = structuredClone(DEFAULT_RELIABILITY); config.interactive.retryDelayMs = 0; config.background.retryDelayMs = 0;
  let now = 1_800_000_000_000;
  const store = createMemoryGuardStore(() => now), events: string[] = [], records: UsageRecordInput[] = [];
  const health = new ProviderHealthService(store, () => config, async e => { events.push(e.type); });
  const guardStore = createMemoryGuardStore(), guardConfig = structuredClone(DEFAULT_GUARDRAILS);
  const guards = new GuardrailService(guardStore, () => guardConfig, async () => {});
  const registry = new AIProviderRegistry(() => models, health), transports = { primary: adapter(), backup: adapter(), cheap: adapter() };
  for (const [id, transport] of Object.entries(transports)) registry.register({ id, create: () => transport, tracking: { embeddingModel: "vector", allowances: testAllowances, guards, write: async r => { records.push(r); } } });
  const provider = createRoutedAIProvider({ entitlements: testEntitlements, registry, embeddingProvider: transports.primary, catalog: models, history: async () => [], health, config: () => config });
  const request = { messages, maxOutputTokens: 100, routing: { minimumTier: "STRONG" as const }, usageContext: { userId: "owner", requestId: randomUUID() } };
  return { provider, registry, transports, request, config, health, store, records, events, models, guardStore, guardConfig, advance: (ms: number) => { now += ms; } };
}
afterEach(() => vi.unstubAllEnvs());

describe("bounded quality-preserving reliability", () => {
  it("uses the healthy primary exactly once and lazily registers providers", async () => {
    const f = fixture(); await expect(f.provider.generateText(f.request)).resolves.toMatchObject({ model: "strong" });
    expect(f.transports.primary.generateText).toHaveBeenCalledOnce(); expect(f.transports.backup.generateText).not.toHaveBeenCalled();
    expect(f.records[0]).toMatchObject({ primaryProvider: "primary", primaryModel: "strong", attemptNumber: 1, fallbackDepth: 0, finalProvider: "primary" });
    expect((await f.registry.listHealthyProviders()).map(h => h.providerId)).toContain("primary");
    expect(f.registry.capabilities("primary", "strong")?.supportsStructuredOutput).toBe(true);
  });
  it.each(["TIMEOUT", "RATE_LIMIT", "PROVIDER_FAILURE"] as const)("%s falls back and accounts for both attempts", async code => {
    const f = fixture(); vi.mocked(f.transports.primary.generateText).mockRejectedValue(new AIError(code));
    await expect(f.provider.generateText(f.request)).resolves.toMatchObject({ model: "equivalent" });
    expect(f.records).toHaveLength(2);
    expect(f.records[1]).toMatchObject({ fallbackUsed: true, fallbackDepth: 1, attemptNumber: 2, fallbackFromProvider: "primary", finalProvider: "backup" });
    expect(new Set(f.records.map(r => r.requestId)).size).toBe(1); expect(new Set(f.records.map(r => r.id)).size).toBe(2);
    expect(JSON.stringify(f.records)).not.toContain(messages[0].content);
  });
  it("actually bounds an unresponsive adapter using the central timeout", async () => {
    const f = fixture(); f.config.timeouts.text = 10;
    vi.mocked(f.transports.primary.generateText).mockImplementation(() => new Promise(() => {}));
    await expect(f.provider.generateText(f.request)).resolves.toMatchObject({ model: "equivalent" });
    expect(f.records[0]).toMatchObject({ errorCode: "TIMEOUT", failureClass: "timeout" });
    expect(vi.mocked(f.transports.primary.generateText).mock.calls[0][0].signal?.aborted).toBe(true);
  });
  it("does not retry malformed application input", async () => {
    const f = fixture(); vi.mocked(f.transports.primary.generateText).mockRejectedValue(new AIError("INVALID_REQUEST"));
    await expect(f.provider.generateText(f.request)).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(f.records).toHaveLength(1); expect(f.transports.backup.generateText).not.toHaveBeenCalled();
  });
  it("auth failure skips models sharing credentials but accepts another provider", async () => {
    const f = fixture(); vi.mocked(f.transports.primary.generateText).mockRejectedValue(new AIError("AUTHENTICATION"));
    await f.provider.generateText(f.request);
    expect((await f.health.list(f.models)).find(h => h.providerId === "primary" && !h.model)?.selectable).toBe(false);
    expect(f.events).toContain("AI_AUTH_FAILURE"); expect(f.records[1].provider).toBe("backup");
  });
  it("does not downgrade when the strong fallback also fails", async () => {
    const f = fixture(); vi.mocked(f.transports.primary.generateText).mockRejectedValue(new AIError("PROVIDER_FAILURE"));
    vi.mocked(f.transports.backup.generateText).mockRejectedValue(new AIError("PROVIDER_FAILURE"));
    await expect(f.provider.generateText(f.request)).rejects.toMatchObject({ code: "AI_SERVICE_TEMPORARILY_UNAVAILABLE" });
    expect(f.records).toHaveLength(2); expect(f.transports.cheap.generateText).not.toHaveBeenCalled();
  });
  it("explicit none policy retries once but never changes model", async () => {
    const f = fixture(); vi.mocked(f.transports.primary.generateText).mockRejectedValue(new AIError("TIMEOUT"));
    await expect(f.provider.generateText({ ...f.request, routing: { ...f.request.routing, degradationPolicy: "none" } })).rejects.toMatchObject({ code: "AI_SERVICE_TEMPORARILY_UNAVAILABLE" });
    expect(f.transports.primary.generateText).toHaveBeenCalledTimes(2); expect(f.transports.backup.generateText).not.toHaveBeenCalled();
  });
  it("recovers schema failure with an equivalent capable adapter and validates data", async () => {
    const f = fixture(); vi.mocked(f.transports.primary.generateStructuredOutput).mockResolvedValue({ id: "invalid", model: "strong", text: "{}", data: {} });
    const r = await f.provider.generateStructuredOutput({ ...f.request, schemaName: "answer", schema: z.object({ answer: z.string() }) });
    expect(r.data).toEqual({ answer: "valid" }); expect(f.records[0].failureClass).toBe("content-schema");
  });
  it.each(["supportsStructuredOutput", "supportsStreaming", "supportsReasoning"] as const)("filters missing %s capability", async capability => {
    const models = structuredClone(catalog); models[1][capability] = false;
    if (capability === "supportsReasoning") { models[0].tiers = ["REASONING"]; models[0].supportsReasoning = true; models[0].reasoningEfforts = ["low", "medium", "high"]; }
    const f = fixture(models);
    vi.mocked(f.transports.primary.generateText).mockRejectedValue(new AIError("TIMEOUT"));
    vi.mocked(f.transports.primary.generateStructuredOutput).mockRejectedValue(new AIError("TIMEOUT"));
    vi.mocked(f.transports.primary.streamText).mockImplementation(async function* () { throw new AIError("TIMEOUT"); });
    const action = capability === "supportsStructuredOutput" ? f.provider.generateStructuredOutput({ ...f.request, schemaName: "answer", schema: z.object({ answer: z.string() }) })
      : capability === "supportsStreaming" ? collect(f.provider.streamText(f.request)) : f.provider.generateText({ ...f.request, routing: { ...f.request.routing, reasoningRequired: true } });
    await expect(action).rejects.toMatchObject({ code: "AI_SERVICE_TEMPORARILY_UNAVAILABLE" });
    expect(f.records.every(r => r.provider === "primary")).toBe(true);
  });
  it("context overflow goes only to a larger capable model, not same-model retry", async () => {
    const f = fixture(); vi.mocked(f.transports.primary.generateText).mockRejectedValue(new AIError("CONTEXT_TOO_LARGE"));
    await f.provider.generateText(f.request); expect(f.transports.primary.generateText).toHaveBeenCalledOnce(); expect(f.records[1].provider).toBe("backup");
    const small = fixture(catalog.map(m => ({ ...m, contextWindow: 50000 })));
    vi.mocked(small.transports.primary.generateText).mockRejectedValue(new AIError("CONTEXT_TOO_LARGE"));
    await expect(small.provider.generateText(small.request)).rejects.toMatchObject({ code: "AI_SERVICE_TEMPORARILY_UNAVAILABLE" }); expect(small.records).toHaveLength(1);
  });
  it("retries streaming before content but never mixes answers after content", async () => {
    const f = fixture(); vi.mocked(f.transports.primary.streamText).mockImplementation(async function* () { throw new AIError("PROVIDER_FAILURE"); });
    expect((await collect(f.provider.streamText(f.request)))[0]).toMatchObject({ text: "Useful answer" });
    const partial = fixture(); vi.mocked(partial.transports.primary.streamText).mockImplementation(async function* () { yield { type: "text-delta", text: "Partial" }; throw new AIError("TIMEOUT"); });
    const received: AIStreamEvent[] = [];
    await expect((async () => { for await (const e of partial.provider.streamText(partial.request)) received.push(e); })()).rejects.toMatchObject({ code: "AI_STREAM_INTERRUPTED", failure: { streamStarted: true } });
    expect(received).toEqual([{ type: "text-delta", text: "Partial" }]); expect(partial.transports.backup.streamText).not.toHaveBeenCalled();
    expect(partial.records[0]).toMatchObject({ streamStarted: true, tokensEmitted: 2, success: false });
  });
  it("a hung stream is aborted and safely fails over before content", async () => {
    const f = fixture(); f.config.timeouts.text = 10;
    vi.mocked(f.transports.primary.streamText).mockImplementation(async function* () { await new Promise(() => {}); yield { type: "text-delta", text: "never" }; });
    expect((await collect(f.provider.streamText(f.request))).at(-1)?.type).toBe("complete"); expect(f.records).toHaveLength(2);
  });
  it("consumer cancellation does not execute fallback or damage provider health", async () => {
    const f = fixture(); for await (const event of f.provider.streamText(f.request)) { expect(event.type).toBe("text-delta"); break; }
    expect(f.records).toHaveLength(1); expect(f.records[0].errorCode).toBe("CANCELLED");
    expect((await f.health.list(f.models)).every(h => h.recentFailureRate === 0)).toBe(true);
  });
  it("respects provider/model operator disable switches without calling disabled adapters", async () => {
    const f = fixture(); f.registry.setEnabled("primary", false); await f.provider.generateText(f.request); expect(f.records[0].provider).toBe("backup");
    const g = fixture(); vi.stubEnv("AI_RELIABILITY_JSON", JSON.stringify({ disabledProviders: ["primary"] })); await g.provider.generateText(g.request); expect(g.records[0].provider).toBe("backup");
    vi.unstubAllEnvs(); const h = fixture(catalog.map(m => ({ ...m, enabled: m.provider !== "primary" }))); await h.provider.generateText(h.request); expect(h.records[0].provider).toBe("backup");
  });
  it("uses the same accounting and policy for background AI", async () => {
    const f = fixture(); vi.mocked(f.transports.primary.generateText).mockRejectedValue(new AIError("TIMEOUT"));
    await f.provider.generateText({ ...f.request, usageContext: { ...f.request.usageContext, backgroundJobId: "job", guardProfile: "BACKGROUND" } });
    expect(f.records).toHaveLength(2); expect(vi.mocked(f.transports.backup.generateText).mock.calls[0][0].timeoutMs).toBe(f.config.timeouts.background);
  });
  it("spends the original guard budget and cannot mint fallback allowances", async () => {
    const f = fixture(); f.guardConfig.profiles.STANDARD.maxAICalls = 1;
    vi.mocked(f.transports.primary.generateText).mockRejectedValue(new AIError("TIMEOUT"));
    await expect(f.provider.generateText({ ...f.request, usageContext: { ...f.request.usageContext, guardProfile: "STANDARD" } })).rejects.toMatchObject({ code: "AI_REQUEST_BUDGET_EXCEEDED" });
    expect(f.transports.backup.generateText).not.toHaveBeenCalled();
    const data = await f.guardStore.transaction([guardKey("request", "owner", f.request.usageContext.requestId)], tx => tx.get(guardKey("request", "owner", f.request.usageContext.requestId))?.data);
    expect(data?.calls).toBe(1);
  });
  it("classifies unknown errors safely without retrying programming errors", async () => {
    const f = fixture(); vi.mocked(f.transports.primary.generateText).mockRejectedValue(new Error("private infrastructure secret"));
    await expect(f.provider.generateText(f.request)).rejects.not.toThrow("private infrastructure secret"); expect(f.records).toHaveLength(1);
    expect(classifyFailure(new AIError("UNSUPPORTED_CAPABILITY"))?.kind).toBe("unsupported-capability");
  });
  it("uses the shorter classification timeout and records a synchronous stream failure", async () => {
    const f = fixture();
    await f.provider.generateText({ ...f.request, usageContext: { ...f.request.usageContext, operationType: "routing" } });
    expect(vi.mocked(f.transports.primary.generateText).mock.calls[0][0].timeoutMs).toBe(f.config.timeouts.routing);
    const g = fixture(); vi.mocked(g.transports.primary.streamText).mockImplementation(() => { throw new AIError("PROVIDER_FAILURE"); });
    await collect(g.provider.streamText(g.request)); expect(g.records).toHaveLength(2); expect(g.records[0].success).toBe(false);
  });
  it("fails closed when shared health storage cannot be read", async () => {
    const f = fixture(); vi.spyOn(f.store, "transaction").mockRejectedValue(new Error("private storage details"));
    await expect(f.provider.generateText(f.request)).rejects.toMatchObject({ code: "AI_SERVICE_TEMPORARILY_UNAVAILABLE" });
    expect(f.transports.primary.generateText).not.toHaveBeenCalled();
  });
  it("rejects malformed operator configuration", () => { vi.stubEnv("AI_RELIABILITY_JSON", '{"interactive":{"maxAttempts":8}}'); expect(getReliabilityConfig).toThrow(AIError); });
});
async function collect(stream: AsyncIterable<AIStreamEvent>) { const values: AIStreamEvent[] = []; for await (const v of stream) values.push(v); return values; }

describe("shared passive circuit breaker", () => {
  const ref = { provider: "primary", model: "strong" };
  async function fail(f: ReturnType<typeof fixture>, n = 1) { for (let i = 0; i < n; i++) { const lease = await f.health.claim(ref, 100, f.request.usageContext); await lease.finish({ kind: "provider-unavailable" }, 25); } }
  it("one normal failure degrades without opening, repeated failures isolate one model", async () => {
    const f = fixture(); await fail(f); expect((await f.health.list([ref])).find(h => h.model)?.selectable).toBe(true);
    await fail(f, 2); const h = await f.health.list([ref]); expect(h.find(h => h.model)).toMatchObject({ circuit: "open", selectable: false }); expect(h.find(h => !h.model)?.selectable).toBe(true);
    expect(f.events).toContain("AI_CIRCUIT_OPEN");
  });
  it("skips an open primary immediately and attributes the selected fallback", async () => {
    const f = fixture(); await fail(f, 3); await f.provider.generateText(f.request);
    expect(f.transports.primary.generateText).not.toHaveBeenCalled(); expect(f.records[0]).toMatchObject({ attemptNumber: 1, fallbackDepth: 1, primaryModel: "strong", fallbackUsed: true });
  });
  it("admits one shared half-open probe across instances, then recovers", async () => {
    const f = fixture(); await fail(f, 3); f.advance(f.config.breaker.cooldownMs + 1);
    const second = new ProviderHealthService(f.store, () => f.config, async () => {});
    const attempts = await Promise.allSettled([f.health.claim(ref, 100, f.request.usageContext), second.claim(ref, 100, f.request.usageContext)]);
    expect(attempts.filter(a => a.status === "fulfilled")).toHaveLength(1);
    const accepted = attempts.find(a => a.status === "fulfilled")!; if (accepted.status === "fulfilled") await accepted.value.finish("success", 12);
    expect((await second.list([ref])).find(h => h.model)).toMatchObject({ circuit: "closed", status: "healthy", selectable: true }); expect(f.events).toContain("AI_CIRCUIT_RECOVERED");
  });
  it("reopens on failed probe and fences stale concurrent results", async () => {
    const f = fixture(); const late = await f.health.claim(ref, 100, f.request.usageContext); await fail(f, 3); await late.finish("success", 1);
    expect((await f.health.list([ref])).find(h => h.model)?.selectable).toBe(false);
    f.advance(f.config.breaker.cooldownMs + 1); await fail(f); expect((await f.health.list([ref])).find(h => h.model)?.selectable).toBe(false);
  });
  it("respects Retry-After and distinguishes provider-wide from model-only throttling", async () => {
    const f = fixture(); await (await f.health.claim(ref, 100, f.request.usageContext)).finish({ kind: "rate-limit", scope: "provider", retryAfterMs: 120000 }, 1);
    f.advance(60000); expect((await f.health.list([ref])).every(h => !h.selectable)).toBe(true);
    f.advance(60001); expect((await f.health.list([ref])).every(h => h.selectable)).toBe(true);
  });
  it("opens on rolling failure rate even without consecutive failures", async () => {
    const f = fixture();
    for (const failed of [true, false, true, false, true]) await (await f.health.claim(ref, 100, f.request.usageContext)).finish(failed ? { kind: "provider-unavailable" } : "success", 10);
    expect((await f.health.list([ref])).find(h => h.model)).toMatchObject({ circuit: "open", recentFailureRate: .6 });
  });
  it("opens a broad provider outage only with failures across models", async () => {
    const f = fixture();
    for (const model of ["one", "two", "one"]) await (await f.health.claim({ ...ref, model }, 100, f.request.usageContext)).finish({ kind: "provider-unavailable" }, 10);
    expect((await f.health.list([ref])).find(h => !h.model)).toMatchObject({ circuit: "open", selectable: false });
    await f.provider.generateText(f.request); expect(f.transports.primary.generateText).not.toHaveBeenCalled(); expect(f.records[0].provider).toBe("backup");
  });
  it("a completed stream recovers its half-open circuit even if consumption stops at complete", async () => {
    const f = fixture(); await fail(f, 3); f.advance(f.config.breaker.cooldownMs + 1);
    for await (const event of f.provider.streamText(f.request)) if (event.type === "complete") break;
    expect((await f.health.list([ref])).find(h => h.model)).toMatchObject({ circuit: "closed", status: "healthy" });
  });
  it("expires old failure evidence and resets consecutive failures", async () => {
    const f = fixture(); await fail(f, 2); f.advance(f.config.breaker.windowMs + 1); await fail(f);
    expect((await f.health.list([ref])).find(h => h.model)?.selectable).toBe(true);
  });
});

describe("embedding vector-space safety", () => {
  function vectors(space = "revision:pooling:normalization:v1", dimensions = 3) {
    const f = fixture(), first = adapter(), backup = adapter();
    const tracking = { allowances: testAllowances, guards: testGuards(), write: async (r: UsageRecordInput) => { f.records.push(r); } };
    const provider = createReliableEmbeddingProvider({ provider: "primary", model: "vector", dimensions: 3, spaceId: "revision:pooling:normalization:v1", create: () => first, tracking },
      [{ provider: "backup", model: "vector-mirror", dimensions, spaceId: space, create: () => backup, tracking }], { health: f.health, config: () => f.config });
    vi.mocked(first.generateEmbedding).mockRejectedValue(new AIError("TIMEOUT"));
    return { ...f, first, backup, provider };
  }
  it("uses an explicitly compatible mirror with the same vector space", async () => {
    const f = vectors(); expect((await f.provider.generateEmbedding({ input: "proof", usageContext: f.request.usageContext })).vector).toEqual([1, 0, 0]); expect(f.records).toHaveLength(2);
  });
  it("rejects malformed vectors before persisting a successful attempt", async () => {
    const f = vectors(); vi.mocked(f.first.generateEmbedding).mockResolvedValue({ model: "vector", vector: [1, 0] });
    const result = await f.provider.generateEmbedding({ input: "proof", usageContext: f.request.usageContext });
    expect(result).toMatchObject({ model: "vector", vector: [1, 0, 0] }); expect(f.records[0]).toMatchObject({ success: false, failureClass: "content-schema" });
    expect(f.records[1]).toMatchObject({ model: "vector-mirror", fallbackUsed: true });
  });
  it.each([["different-model:same-dimensions", 3], ["revision:pooling:normalization:v1", 4]] as const)("prevents incompatible embedding fallback: %s %i", async (space, dimensions) => {
    const f = vectors(space, dimensions); await expect(f.provider.generateEmbedding({ input: "proof", usageContext: f.request.usageContext })).rejects.toMatchObject({ code: "AI_SERVICE_TEMPORARILY_UNAVAILABLE" }); expect(f.backup.generateEmbedding).not.toHaveBeenCalled();
  });
});
