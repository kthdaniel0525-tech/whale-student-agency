import { testAllowances, testEntitlements } from "./entitlement-fixture";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { AI_DEFAULTS } from "@/server/ai/config";
import { OpenAIProvider } from "@/server/ai/providers/openai";
import { testGuards, testHealth } from "./guard-fixture";
import { createRoutedAIProvider } from "@/server/ai/routing/provider";
import { DEFAULT_MODEL_CATALOG, MODEL_IDS } from "@/server/ai/routing/catalog";
import { withAIUsageContext } from "@/server/ai/usage/context";
import type { AIStreamEvent } from "@/server/ai/types";
import type { UsageRecordInput } from "@/server/ai/usage/records";

const messages = [{ role: "user", content: "A private student question" }] as const;
const usageContext = { userId: "routing-owner", requestId: "routing-request", agentId: "tutor" };
type Body = { model: string; input: unknown; max_output_tokens?: number; reasoning?: { effort: string }; temperature?: number; stream?: boolean; text?: unknown };
function boundary(options: { fail?: boolean; stream?: boolean; invalid?: boolean } = {}) {
  const bodies: Body[] = [], records: UsageRecordInput[] = [];
  const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
    const body: Body = JSON.parse(String(init?.body)); bodies.push(body);
    if (options.fail) return new Response(JSON.stringify({ error: { message: "secret raw error" } }), { status: 429, headers: { "content-type": "application/json" } });
    if (String(_url).endsWith("/embeddings")) return new Response(JSON.stringify({ model: body.model, data: [{ index: 0, embedding: [1, 2, 3] }], usage: { prompt_tokens: 4, total_tokens: 4 } }), { headers: { "content-type": "application/json" } });
    const text = options.invalid ? "invalid-json" : body.text ? '{"answer":"valid"}' : "An answer";
    const response = { id: "resp_test", model: body.model, status: "completed", output: [{ type: "message", content: [{ type: "output_text", text }] }],
      usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150, output_tokens_details: { reasoning_tokens: body.reasoning ? 25 : 0 } } };
    if (body.stream || options.stream) return new Response([
      { type: "response.output_text.delta", delta: text }, { type: "response.completed", response },
    ].map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
    return new Response(JSON.stringify(response), { headers: { "content-type": "application/json" } });
  });
  const openai = new OpenAIProvider({ ...AI_DEFAULTS, apiKey: "mock-only", temperature: .2, embeddingDimensions: 3 }, fetcher, { write: async record => { records.push(record); }, allowances: testAllowances, guards: testGuards() });
  const history = vi.fn(async () => []);
  return { bodies, records, fetcher, history, openai, provider: createRoutedAIProvider({ entitlements: testEntitlements, health: testHealth(), providers: { openai }, embeddingProvider: openai, history }) };
}
afterEach(() => vi.unstubAllEnvs());

describe("routed AIProvider with real transport and mocked HTTP", () => {
  it("selects different models for the same Agent and preserves original messages", async () => {
    const f = boundary();
    await f.provider.generateText({ messages, usageContext });
    await f.provider.generateText({ messages, usageContext, routing: { signals: { proof: true } } });
    expect(f.bodies.map(b => b.model)).toEqual([MODEL_IDS.baseline, MODEL_IDS.strong]);
    expect(f.bodies.map(b => b.input)).toEqual([messages, messages]);
    expect(f.records).toHaveLength(2);
    expect(f.records[1]).toMatchObject({ selectedModel: MODEL_IDS.strong, selectedTier: "STRONG", routingComplexity: "HIGH", routingReasonCode: "HIGH_COMPLEXITY", routingMethod: "rule", fallbackUsed: false });
    expect(JSON.stringify(f.records)).not.toContain(messages[0].content);
    expect(f.history).toHaveBeenCalledWith(usageContext.userId);
  });
  it("routes structured output and preserves schema validation", async () => {
    const f = boundary();
    const result = await f.provider.generateStructuredOutput({ messages, usageContext, schemaName: "routed", schema: z.object({ answer: z.string() }), routing: { qualityCritical: true }, maxOutputTokens: 4096 });
    expect(result.data).toEqual({ answer: "valid" });
    expect(f.bodies[0]).toMatchObject({ model: MODEL_IDS.strong, max_output_tokens: 4096, text: { format: { name: "routed", type: "json_schema" } } });
  });
  it("retains routing metadata on invalid structured responses", async () => {
    const f = boundary({ invalid: true });
    await expect(f.provider.generateStructuredOutput({ messages, usageContext, schemaName: "routed", schema: z.object({ answer: z.string() }) })).rejects.toMatchObject({ code: "AI_SERVICE_TEMPORARILY_UNAVAILABLE" });
    expect(f.records[0]).toMatchObject({ success: false, selectedTier: "BALANCED", inputTokens: 100, errorCode: "INVALID_RESPONSE" });
  });
  it("routes streaming once, captures ownership at creation, and records completion once", async () => {
    const f = boundary();
    const stream = withAIUsageContext(usageContext, () => f.provider.streamText({ messages, routing: { signals: { proof: true } } }));
    const collected: AIStreamEvent[] = [];
    await withAIUsageContext({ userId: "different-user", requestId: "different-request" }, async () => { for await (const event of stream) collected.push(event); });
    expect(collected.map(e => e.type)).toEqual(["text-delta", "complete"]);
    expect(f.fetcher).toHaveBeenCalledTimes(1);
    expect(f.records).toHaveLength(1);
    expect(f.records[0]).toMatchObject({ userId: usageContext.userId, requestId: usageContext.requestId, selectedTier: "STRONG", success: true });
  });
  it("records a cancelled stream once without executing fallback", async () => {
    const f = boundary();
    const iterator = f.provider.streamText({ messages, usageContext })[Symbol.asyncIterator]();
    await iterator.next(); await iterator.return?.();
    expect(f.records).toHaveLength(1); expect(f.records[0]).toMatchObject({ errorCode: "CANCELLED", selectedTier: "BALANCED", fallbackUsed: false });
    expect(f.fetcher).toHaveBeenCalledTimes(1);
  });
  it("routes workflow steps independently under the original correlation scope", async () => {
    const f = boundary();
    await withAIUsageContext({ ...usageContext, workflowId: "exam-preparation", workflowRunId: "run-owned" }, async () => {
      await f.provider.generateText({ messages, usageContext: { agentId: "study-planner" } });
      await f.provider.generateText({ messages, usageContext: { agentId: "quiz" } });
      await f.provider.generateText({ messages, usageContext: { agentId: null, operationType: "summarization" } });
    });
    expect(f.records.map(r => r.selectedTier)).toEqual(["STRONG", "BALANCED", "BALANCED"]);
    expect(f.records.every(r => r.workflowRunId === "run-owned" && r.requestId === usageContext.requestId)).toBe(true);
  });
  it("uses actual post-compression messages, not historical token counts", async () => {
    const f = boundary();
    await f.provider.generateText({ messages, usageContext: { ...usageContext, conversationSummaryUsed: true, estimatedConversationTokens: 600_000, historicalMessageCount: 100 } });
    expect(f.bodies[0].model).toBe(MODEL_IDS.baseline);
    expect(f.records[0].conversationSummaryUsed).toBe(true);
  });
  it("counts the structured schema when deciding whether required context fits", async () => {
    const f = boundary();
    const common = { ...DEFAULT_MODEL_CATALOG[0], fallbackModels: [] };
    const provider = createRoutedAIProvider({ entitlements: testEntitlements, health: testHealth(), providers: { openai: f.openai }, embeddingProvider: f.openai, history: f.history,
      catalog: [{ ...common, model: "small", contextWindow: 1000, maxOutputTokens: 500 }, { ...common, model: "large", relativeCostClass: 2 }] });
    const schema = z.object({ answer: z.string().describe("Required domain metadata ".repeat(200)) });
    await provider.generateStructuredOutput({ messages, usageContext, schemaName: "routed", schema, maxOutputTokens: 256 });
    expect(f.bodies[0].model).toBe("large");
  });
  it("includes reasoning parameters without unsupported temperature or a reduced answer budget", async () => {
    const f = boundary();
    await f.provider.generateText({ messages, usageContext, maxOutputTokens: 8000, routing: { reasoningRequired: true, requestComplexity: "VERY_HIGH" } });
    expect(f.bodies[0]).toMatchObject({ model: MODEL_IDS.reasoning, reasoning: { effort: "high" }, max_output_tokens: 33000 });
    expect(f.bodies[0]).not.toHaveProperty("temperature");
    expect(f.records[0]).toMatchObject({ selectedTier: "REASONING", reasoningTokens: 25, estimatedCostUsd: .0006 });
  });
  it("does not retry the same provider after a provider-wide rate limit", async () => {
    const f = boundary({ fail: true });
    await expect(f.provider.generateText({ messages, usageContext, routing: { qualityCritical: true } })).rejects.toMatchObject({ code: "AI_SERVICE_TEMPORARILY_UNAVAILABLE" });
    expect(f.fetcher).toHaveBeenCalledTimes(1);
    expect(f.records).toHaveLength(1);
    expect(f.records[0]).toMatchObject({ selectedTier: "STRONG", fallbackUsed: false, success: false });
    expect(JSON.stringify(f.records)).not.toContain("secret raw error");
  });
  it("keeps embeddings outside chat routing even if chat catalog is unavailable", async () => {
    const f = boundary(); vi.stubEnv("AI_MODEL_CATALOG_JSON", "invalid");
    const response = await f.provider.generateEmbedding({ input: "Embedding input", usageContext });
    expect(response.vector).toEqual([1, 2, 3]);
    expect(f.bodies[0].model).toBe(AI_DEFAULTS.embeddingModel);
    expect(f.history).not.toHaveBeenCalled();
    expect(f.records[0].selectedTier).toBeUndefined();
  });
  it("enforces production override isolation and quality floors in controlled evaluations", async () => {
    const f = boundary(); vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("AI_ROUTING_OVERRIDE_JSON", '{"tier":"STRONG"}');
    await expect(f.provider.generateText({ messages, usageContext })).rejects.toMatchObject({ code: "CONFIGURATION" });
    expect(f.fetcher).not.toHaveBeenCalled();
    vi.stubEnv("AI_ROUTING_EVALUATION_MODE", "true");
    await f.provider.generateText({ messages, usageContext });
    expect(f.records[0].routingMethod).toBe("explicit");
    vi.stubEnv("AI_ROUTING_OVERRIDE_JSON", '{"tier":"FAST"}');
    await expect(f.provider.generateText({ messages, usageContext, routing: { qualityCritical: true } })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });
  it("handles missing history without adding AI calls or losing the safe default", async () => {
    const f = boundary();
    const provider = createRoutedAIProvider({ entitlements: testEntitlements, health: testHealth(), providers: { openai: f.openai }, embeddingProvider: f.openai, history: async () => { throw new Error("unavailable"); } });
    await provider.generateText({ messages, usageContext });
    expect(f.bodies[0].model).toBe(MODEL_IDS.baseline); expect(f.fetcher).toHaveBeenCalledTimes(1);
  });
  it("validates disabled models on each call rather than keeping a stale decision", async () => {
    const f = boundary();
    await f.provider.generateText({ messages, usageContext });
    vi.stubEnv("AI_MODEL_CATALOG_JSON", JSON.stringify(DEFAULT_MODEL_CATALOG.map(m => ({ ...m, enabled: m.model !== MODEL_IDS.baseline }))));
    await f.provider.generateText({ messages, usageContext });
    expect(f.records.map(r => r.selectedTier)).toEqual(["BALANCED", "STRONG"]);
  });
  it("does not wait indefinitely for optional historical telemetry", async () => {
    const f = boundary();
    const provider = createRoutedAIProvider({ entitlements: testEntitlements, health: testHealth(), providers: { openai: f.openai }, embeddingProvider: f.openai, history: () => new Promise(() => {}) });
    await expect(provider.generateText({ messages, usageContext })).resolves.toMatchObject({ model: MODEL_IDS.baseline });
    expect(f.fetcher).toHaveBeenCalledTimes(1);
  });
});
