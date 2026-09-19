import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { OpenAIProvider } from "@/server/ai/providers/openai";
import { AI_DEFAULTS } from "@/server/ai/config";
import { captureUsageContext, withAIUsageContext, withAIUsageStream } from "@/server/ai/usage/context";
import { DEFAULT_PRICING, estimateCost, getModelPricing, pricingSchema } from "@/server/ai/usage/pricing";
import { usageRecordSchema, type UsageRecordInput } from "@/server/ai/usage/records";
import type { AIStreamEvent } from "@/server/ai/types";
import { quizOutputSchema } from "@/server/agents/quiz/schemas";
import { generatedStudyPlanSchema } from "@/server/agents/study-planner/schemas";
import { structuredNotesSchema } from "@/server/agents/notes/structured";
import { careerAnalysisSchema } from "@/server/agents/career/schemas";

const messages = [{ role: "user" as const, content: "PRIVATE student document content 한글" }];
const usageContext = { userId: "usage-student", requestId: "request-1" };
function response(text = "PRIVATE answer", usage: unknown = { input_tokens: 1000, output_tokens: 100, total_tokens: 1100, input_tokens_details: { cached_tokens: 400 }, output_tokens_details: { reasoning_tokens: 20 } }) {
  return { id: "response-1", model: "gpt-4.1-mini", status: "completed", output: [{ type: "message", content: [{ type: "output_text", text }] }], usage };
}
function json(value: unknown, status = 200) { return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } }); }
function fixture(value: unknown = response(), status = 200) {
  const records: UsageRecordInput[] = [];
  const write = vi.fn(async (record: UsageRecordInput) => { records.push(record); });
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => json(value, status));
  let ticks = 0;
  const provider = new OpenAIProvider({ ...AI_DEFAULTS, apiKey: "test-only" }, fetcher, { write, clock: () => ticks++ * 125, pricing: DEFAULT_PRICING });
  return { provider, records, write, fetcher };
}
function stream(events: unknown[]) {
  const f = fixture();
  f.fetcher.mockImplementation(async () => new Response(events.map(event => `event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } }));
  return f;
}
async function collect(value: AsyncIterable<AIStreamEvent>) { const events = []; for await (const e of value) events.push(e); return events; }
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("AI usage at the real provider / mocked HTTP boundary", () => {
  it.each([
    ["quiz", quizOutputSchema(2, "mixed")], ["study_plan", generatedStudyPlanSchema],
    ["study_notes", structuredNotesSchema()], ["career", careerAnalysisSchema],
  ])("accounts for real %s output schemas through the SDK boundary", async (schemaName, schema) => {
    const f = fixture(response('{}'));
    // Invalid educational output must reach the provider then fail local
    // validation, retaining charged tokens instead of failing schema conversion.
    await expect(f.provider.generateStructuredOutput({ messages, usageContext, schemaName: String(schemaName), schema: schema as z.ZodType<unknown> })).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    expect(f.fetcher).toHaveBeenCalledTimes(1);
    expect(f.records[0]).toMatchObject({ success: false, totalTokens: 1100 });
  });
  it("records authoritative text tokens, cache/reasoning subsets, cost and provider latency", async () => {
    const f = fixture();
    const result = await f.provider.generateText({ messages, usageContext });
    expect(result.usage).toEqual({ inputTokens: 1000, outputTokens: 100, totalTokens: 1100, cachedInputTokens: 400, reasoningTokens: 20 });
    expect(f.records).toHaveLength(1);
    expect(f.records[0]).toMatchObject({ ...usageContext, provider: "openai", operationType: "text-generation", usageSource: "provider", estimatedCostUsd: 0.00044, latencyMs: 125, success: true });
  });
  it("tracks structured output once and excludes accounting metadata from the API body", async () => {
    const f = fixture(response('{"answer":"yes"}'));
    const result = await f.provider.generateStructuredOutput({ messages, usageContext, schemaName: "answer", schema: z.object({ answer: z.string() }) });
    expect(result.data.answer).toBe("yes");
    expect(f.records).toHaveLength(1);
    expect(f.records[0].operationType).toBe("structured-output");
    expect(String(f.fetcher.mock.calls[0][1]?.body)).not.toContain("usage-student");
    expect(String(f.fetcher.mock.calls[0][1]?.body)).not.toContain("request-1");
  });
  it("retains charged tokens when structured output fails local validation", async () => {
    const f = fixture(response('{"answer":3}'));
    await expect(f.provider.generateStructuredOutput({ messages, usageContext, schemaName: "answer", schema: z.object({ answer: z.string() }) })).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    expect(f.records[0]).toMatchObject({ success: false, errorCode: "INVALID_RESPONSE", totalTokens: 1100, usageSource: "provider", estimatedCostUsd: .00044 });
  });
  it("sends nested refinement shapes while retaining original server validation", async () => {
    const f = fixture(response('{"items":[{"score":3}]}'));
    const schema = z.object({ items: z.array(z.object({ score: z.number() }).refine(v => v.score > 5)) }).superRefine((v, ctx) => { if (!v.items.length) ctx.addIssue({ code: "custom", message: "Need items" }); });
    await expect(f.provider.generateStructuredOutput({ messages, usageContext, schemaName: "refined", schema })).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    expect(f.fetcher).toHaveBeenCalledTimes(1);
    expect(f.records[0]).toMatchObject({ success: false, totalTokens: 1100 });
  });
  it("keeps authoritative usage from an incomplete response", async () => {
    const f = fixture({ ...response(), status: "incomplete" });
    await expect(f.provider.generateText({ messages, usageContext })).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    expect(f.records[0]).toMatchObject({ success: false, totalTokens: 1100 });
  });
  it("uses the multilingual estimator only when successful provider usage is absent", async () => {
    const f = fixture(response("short", null));
    await f.provider.generateText({ messages, usageContext });
    expect(f.records[0]).toMatchObject({ usageSource: "estimated", outputTokens: 2 });
    expect(f.records[0].inputTokens).toBeGreaterThan(10);
  });
  it("preserves authoritative zero usage instead of replacing it with an estimate", async () => {
    const f = fixture(response("zero", { input_tokens: 0, output_tokens: 0, total_tokens: 0 }));
    await f.provider.generateText({ messages, usageContext });
    expect(f.records[0]).toMatchObject({ usageSource: "provider", totalTokens: 0, estimatedCostUsd: 0 });
  });
  it("stores one final record for many streaming deltas", async () => {
    const f = stream([{ type: "response.output_text.delta", delta: "hello " }, { type: "response.output_text.delta", delta: "world" }, { type: "response.completed", response: response("hello world") }]);
    expect(await collect(f.provider.streamText({ messages, usageContext }))).toHaveLength(3);
    expect(f.records).toHaveLength(1);
    expect(f.records[0]).toMatchObject({ operationType: "streaming", success: true, totalTokens: 1100 });
  });
  it("records cancellation on early stream consumer exit exactly once", async () => {
    const f = stream([{ type: "response.output_text.delta", delta: "hello" }, { type: "response.completed", response: response("hello") }]);
    for await (const event of f.provider.streamText({ messages, usageContext })) { expect(event.type).toBe("text-delta"); break; }
    expect(f.records).toHaveLength(1);
    expect(f.records[0]).toMatchObject({ success: false, errorCode: "CANCELLED", usageSource: "unavailable", estimatedCostUsd: null });
  });
  it("records terminal stream failure and provider usage", async () => {
    const f = stream([{ type: "response.failed", response: { ...response(), status: "failed" } }]);
    await expect(collect(f.provider.streamText({ messages, usageContext }))).rejects.toMatchObject({ code: "PROVIDER_FAILURE" });
    expect(f.records).toHaveLength(1);
    expect(f.records[0]).toMatchObject({ success: false, totalTokens: 1100 });
  });
  it("captures the original stream scope even when consumed later", async () => {
    const f = stream([{ type: "response.output_text.delta", delta: "ok" }, { type: "response.completed", response: response("ok") }]);
    const iterable = withAIUsageContext(usageContext, () => f.provider.streamText({ messages }));
    await withAIUsageContext({ ...usageContext, requestId: "different-request", workflowId: "unrelated-workflow" }, () => collect(iterable));
    expect(f.records[0]).toMatchObject(usageContext);
    expect(f.records[0].workflowId).toBeUndefined();
  });
  it("tracks embedding tokens and batch size separately from routing", async () => {
    const f = fixture({ model: "text-embedding-3-small", data: [{ index: 0, embedding: [1, 0] }], usage: { prompt_tokens: 30, total_tokens: 30 } });
    await withAIUsageContext({ ...usageContext, operationType: "routing" }, () => f.provider.generateEmbedding({ input: "PRIVATE", dimensions: 2, usageContext: { source: "rag-query" } }));
    expect(f.records[0]).toMatchObject({ operationType: "embedding", source: "rag-query", batchSize: 1, inputTokens: 30, outputTokens: 0, estimatedCostUsd: .0000006 });
  });
  it("retains embedding usage when the returned vector is invalid", async () => {
    const f = fixture({ model: "text-embedding-3-small", data: [{ index: 0, embedding: [0, 0] }], usage: { prompt_tokens: 30, total_tokens: 30 } });
    await expect(f.provider.generateEmbedding({ input: "private", dimensions: 2, usageContext })).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    expect(f.records[0]).toMatchObject({ success: false, totalTokens: 30 });
  });
  it.each([[401, "AUTHENTICATION"], [429, "RATE_LIMIT"], [503, "PROVIDER_FAILURE"]])("stores a safe error code for HTTP %s", async (status, errorCode) => {
    const f = fixture({ error: { message: "SECRET upstream prompt", type: "api_error" } }, Number(status));
    await expect(f.provider.generateText({ messages, usageContext })).rejects.toMatchObject({ code: errorCode });
    expect(f.records[0]).toMatchObject({ success: false, errorCode, totalTokens: null, usageSource: "unavailable", estimatedCostUsd: null });
    expect(JSON.stringify(f.records)).not.toContain("SECRET");
  });
  it("makes each retry visible under the same top-level request", async () => {
    const f = fixture();
    f.fetcher.mockResolvedValueOnce(json({ error: { message: "busy" } }, 429));
    await withAIUsageContext(usageContext, async () => {
      await f.provider.generateText({ messages }).catch(() => {});
      await f.provider.generateText({ messages });
    });
    expect(f.fetcher).toHaveBeenCalledTimes(2);
    expect(f.records.map(r => r.success)).toEqual([false, true]);
    expect(new Set(f.records.map(r => r.id)).size).toBe(2);
    expect(new Set(f.records.map(r => r.requestId))).toEqual(new Set(["request-1"]));
  });
  it("keeps Agent/Workflow and bounded RAG/compression metadata without contents", async () => {
    const f = fixture();
    const metadata = { ...usageContext, workflowId: "exam-preparation", workflowRunId: "run-1", agentId: "tutor", conversationId: "conversation-1", ragChunkCount: 4, retrievedTokenEstimate: 500, estimatedContextTokens: 900, memoriesUsed: 2, personalizationFieldsUsed: 3, conversationSummaryUsed: true, recentMessageCount: 6, historicalMessageCount: 2, estimatedConversationTokens: 1200 };
    await withAIUsageContext(metadata, () => f.provider.generateText({ messages }));
    expect(f.records[0]).toMatchObject(metadata);
    expect(JSON.stringify(f.records)).not.toContain("PRIVATE");
    expect(usageRecordSchema.parse({ ...f.records[0], prompt: "SECRET", response: "SECRET" })).not.toHaveProperty("prompt");
  });
  it("labels router calls independently of a surrounding agent", async () => {
    const f = fixture(response('{"route":"tutor"}'));
    await withAIUsageContext({ ...usageContext, agentId: "tutor" }, () => f.provider.generateStructuredOutput({ messages, schemaName: "route", schema: z.object({ route: z.string() }), usageContext: { operationType: "routing", agentId: null } }));
    expect(f.records[0]).toMatchObject({ operationType: "routing", agentId: null });
  });
  it("does not break successful output when the analytics writer fails", async () => {
    const f = fixture();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    f.write.mockRejectedValue(new Error("SECRET SQL contents"));
    expect((await f.provider.generateText({ messages, usageContext })).text).toBe("PRIVATE answer");
    expect(log).toHaveBeenCalledWith("AI usage persistence failed", { code: "USAGE_WRITE_FAILED", attemptId: expect.any(String) });
    expect(JSON.stringify(log.mock.calls)).not.toContain("SECRET");
  });
  it("persists usage with unknown pricing instead of claiming a zero cost", async () => {
    const f = fixture({ ...response(), model: "unknown-future-model" });
    await f.provider.generateText({ messages, usageContext });
    expect(f.records[0]).toMatchObject({ estimatedCostUsd: null, totalTokens: 1100 });
  });
});

describe("central pricing and isolated usage scopes", () => {
  it("prices reasoning as an output subset without double charging", () => {
    const pricing = { version: "fixture", models: [{ provider: "test", model: "reasoner", inputPerMillion: 1, outputPerMillion: 3, cachedInputPerMillion: .5, reasoningPerMillion: 4 }] };
    expect(estimateCost("test", "reasoner", { inputTokens: 100, outputTokens: 50, totalTokens: 150, cachedInputTokens: 20, reasoningTokens: 10 }, pricing).estimatedCostUsd).toBe(.00025);
  });
  it("accepts replaceable versioned pricing, rejects duplicates and negative rates", () => {
    expect(pricingSchema.safeParse(DEFAULT_PRICING).success).toBe(true);
    expect(pricingSchema.safeParse({ ...DEFAULT_PRICING, models: [DEFAULT_PRICING.models[0], DEFAULT_PRICING.models[0]] }).success).toBe(false);
    expect(pricingSchema.safeParse({ version: "bad", models: [{ provider: "p", model: "m", inputPerMillion: -1, outputPerMillion: 0 }] }).success).toBe(false);
    vi.stubEnv("AI_MODEL_PRICING_JSON", JSON.stringify({ version: "v2", models: [] }));
    expect(getModelPricing()).toEqual({ version: "v2", models: [] });
    vi.stubEnv("AI_MODEL_PRICING_JSON", "SECRET-invalid");
    expect(getModelPricing()).toBeNull();
  });
  it("isolates concurrent users and prevents inherited foreign attribution", async () => {
    const f = fixture();
    await Promise.all(["alice", "bob"].map(userId => withAIUsageContext({ userId }, async () => { await Promise.resolve(); await f.provider.generateText({ messages }); })));
    expect(new Set(f.records.map(r => r.userId))).toEqual(new Set(["alice", "bob"]));
    expect(new Set(f.records.map(r => r.requestId)).size).toBe(2);
    withAIUsageContext({ userId: "alice", workflowId: "private-workflow" }, () => expect(captureUsageContext({ userId: "bob" }).workflowId).toBeUndefined());
  });
  it("restores nested attribution and maintains scope across generator cancellation", async () => {
    const scopes: string[] = [];
    const iterable = withAIUsageContext(usageContext, () => withAIUsageStream({}, async function* () {
      try { scopes.push(captureUsageContext().requestId!); yield 1; }
      finally { scopes.push(captureUsageContext().requestId!); }
    }));
    for await (const value of iterable) { expect(value).toBe(1); break; }
    expect(scopes).toEqual(["request-1", "request-1"]);
  });
});
