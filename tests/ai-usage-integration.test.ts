import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { auth } from "@/server/auth/config";
import { db } from "@/server/db/client";
import { writeUsageRecord, type UsageRecordInput } from "@/server/ai/usage/records";
import { getAgentUsage, getDailyUsage, getModelUsage, getOperationUsage, getRequestUsage, getUserAIUsage, getUserUsageSummary, getWorkflowUsage } from "@/server/ai/usage/analytics";
import { OpenAIProvider } from "@/server/ai/providers/openai";
import { AI_DEFAULTS } from "@/server/ai/config";
import { IntelligentDispatcher } from "@/server/dispatcher/service";
import { WorkflowEngine } from "@/server/workflows/engine";
import { ContextReadCache } from "@/server/context/cache";
import { createStudentAgentRegistry } from "@/server/agents/student-service";
import { AgentExecutor } from "@/server/agents/executor";
import type { WorkflowContext, WorkflowDefinition } from "@/server/workflows/types";
import { GET } from "@/app/api/student/usage/route";
import { appendConversationMessage, createConversation } from "@/server/conversations";
import { embeddingProvider } from "@/server/documents/embeddings";
import { withAIUsageContext } from "@/server/ai/usage/context";

type Actor = { id: string; headers: Headers };
let owner: Actor, other: Actor;
async function actor(): Promise<Actor> {
  const response = await auth().api.signUpEmail({ body: { name: "Usage Student", email: `usage-${randomUUID()}@example.test`, password: "Usage-test-passphrase-2026!" }, asResponse: true });
  expect(response.status).toBe(200);
  const { user } = await response.json() as { user: { id: string } };
  await db().profile.create({ data: { userId: user.id, school: "Usage University", program: "Math", currentYear: 2, semester: "Fall", academicGoal: "Learn", studySessionMinutes: 30, explanationDifficulty: "INTERMEDIATE", timezone: "UTC" } });
  return { id: user.id, headers: new Headers({ cookie: response.headers.getSetCookie().map(c => c.split(";")[0]).join("; ") }) };
}
const now = new Date("2026-09-19T18:00:00Z");
function record(overrides: Partial<UsageRecordInput> = {}): UsageRecordInput {
  return { id: randomUUID(), userId: owner.id, requestId: "request-one", provider: "openai", model: "gpt-4.1-mini", operationType: "text-generation", agentId: "tutor", inputTokens: 100, outputTokens: 50, totalTokens: 150, estimatedCostUsd: .00012, pricingVersion: "fixture-v1", latencyMs: 100, success: true, usageSource: "provider", createdAt: new Date("2026-09-19T12:00:00Z"), ...overrides };
}
function boundary(failFirst = false) {
  const bodies: Array<{ input: Array<{ content: string }>; text?: { format: { name: string } } }> = [];
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
    const body = JSON.parse(String(init?.body)); bodies.push(body);
    if (failFirst && bodies.length === 1) return new Response(JSON.stringify({ error: { message: "busy" } }), { status: 429, headers: { "content-type": "application/json" } });
    const format = body.text?.format?.name;
    const data = format === "intelligent_dispatch" ? { targetType: "agent", targetId: "tutor", confidence: .76, needsClarification: false, clarificationQuestion: null }
      : format === "conversation_summary" ? { activeGoals: [], importantFacts: [], decisions: [], unresolvedItems: [], activeResources: [], recentProgress: [], corrections: [], summaryText: "The student is practicing induction." } : null;
    const text = data ? JSON.stringify(data) : "Start with the base case and then the inductive step.";
    return new Response(JSON.stringify({ id: randomUUID(), model: "gpt-4.1-mini", status: "completed", output: [{ type: "message", content: [{ type: "output_text", text }] }], usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 } }), { headers: { "content-type": "application/json" } });
  });
  return { provider: new OpenAIProvider({ ...AI_DEFAULTS, apiKey: "test-only" }, fetcher), fetcher, bodies };
}
beforeAll(async () => { owner = await actor(); other = await actor(); });
beforeEach(async () => { await db().aIUsageRecord.deleteMany({ where: { userId: { in: [owner.id, other.id] } } }); });
afterEach(() => vi.restoreAllMocks());
afterAll(async () => { await db().user.deleteMany({ where: { id: { in: [owner.id, other.id] } } }); await db().$disconnect(); });

describe.sequential("durable AI usage and authenticated integrations", () => {
  it("idempotently stores one attempt and preserves historical pricing on repeat delivery", async () => {
    const row = record();
    await Promise.all([writeUsageRecord(row), writeUsageRecord(row)]);
    await writeUsageRecord({ ...row, estimatedCostUsd: 9, pricingVersion: "new-rate" });
    const saved = await db().aIUsageRecord.findMany({ where: { userId: owner.id } });
    expect(saved).toHaveLength(1);
    expect(Number(saved[0].estimatedCostUsd)).toBe(.00012);
    expect(saved[0].pricingVersion).toBe("fixture-v1");
  });
  it("rejects cross-user conversation/workflow attribution", async () => {
    const conversation = await db().conversation.create({ data: { userId: other.id } });
    const run = await db().workflowRun.create({ data: { userId: other.id, workflowId: "exam-preparation", input: {}, context: {} } });
    await expect(writeUsageRecord(record({ conversationId: conversation.id }))).rejects.toThrow("USAGE_OWNERSHIP");
    await expect(writeUsageRecord(record({ workflowRunId: run.id, workflowId: "exam-preparation" }))).rejects.toThrow("USAGE_OWNERSHIP");
    expect(await db().aIUsageRecord.count({ where: { userId: owner.id } })).toBe(0);
  });
  it("aggregates attempts versus distinct requests, exposes failures/unknown costs, and separates embeddings", async () => {
    await writeUsageRecord(record());
    await writeUsageRecord(record({ success: false, inputTokens: null, outputTokens: null, totalTokens: null, estimatedCostUsd: null, usageSource: "unavailable", errorCode: "RATE_LIMIT", latencyMs: 300 }));
    await writeUsageRecord(record({ requestId: "request-two", agentId: "quiz", usageSource: "estimated" }));
    await writeUsageRecord(record({ userId: other.id, totalTokens: 99999, estimatedCostUsd: 100 }));
    await writeUsageRecord(record({ operationType: "embedding", source: "rag-query", model: "text-embedding-3-small", outputTokens: 0, totalTokens: 100 }));
    const result = await getUserAIUsage({ userId: owner.id });
    expect(result.groups.find(g => g.kind === "generation")).toMatchObject({ providerAttempts: 3, topLevelRequests: 2, successfulProviderAttempts: 2, failedProviderAttempts: 1, totalTokens: 300, estimatedTokenAttempts: 1, unknownTokenAttempts: 1, unpricedAttempts: 1 });
    expect(result.groups.find(g => g.kind === "generation")?.failureRate).toBeCloseTo(1 / 3);
    expect(result.groups.find(g => g.kind === "embedding")).toMatchObject({ providerAttempts: 1, totalTokens: 100 });
    expect((await getAgentUsage({ userId: owner.id })).groups.find(g => g.key === "quiz")).toMatchObject({ providerAttempts: 1 });
    expect((await getModelUsage({ userId: owner.id })).groups.find(g => g.key === "text-embedding-3-small")).toMatchObject({ kind: "embedding" });
    expect((await getOperationUsage({ userId: owner.id })).groups).toHaveLength(2);
  });
  it("supports daily/period summaries with exclusive end boundaries", async () => {
    await writeUsageRecord(record({ createdAt: new Date("2026-09-18T23:59:59Z") }));
    await writeUsageRecord(record({ createdAt: new Date("2026-09-19T00:00:00Z") }));
    await writeUsageRecord(record({ createdAt: new Date("2026-08-01T00:00:00Z") }));
    const summary = await getUserUsageSummary(owner.id, now);
    expect(summary.today.groups[0].providerAttempts).toBe(1);
    expect(summary.currentMonth.groups[0].providerAttempts).toBe(2);
    expect(summary.lifetime.groups[0].providerAttempts).toBe(3);
    const daily = await getDailyUsage({ userId: owner.id, start: new Date("2026-09-18T00:00:00Z"), end: new Date("2026-09-19T00:00:00Z") });
    expect(daily.groups).toHaveLength(1);
    expect(daily.groups[0]).toMatchObject({ key: "2026-09-18", providerAttempts: 1 });
    expect(() => getDailyUsage({ userId: owner.id, start: new Date("2020-01-01"), end: now })).toThrow();
  });
  it("computes workflow averages across distinct runs and retains usage after run deletion", async () => {
    const runs = await Promise.all([1, 2].map(() => db().workflowRun.create({ data: { userId: owner.id, workflowId: "exam-preparation", input: {}, context: {} } })));
    for (const run of [runs[0], runs[0], runs[1]]) await writeUsageRecord(record({ workflowId: "exam-preparation", workflowRunId: run.id }));
    const group = (await getWorkflowUsage({ userId: owner.id })).groups[0];
    expect(group).toMatchObject({ workflowRuns: 2, providerAttempts: 3, averageCallsPerWorkflowRun: 1.5, averageTokensPerWorkflowRun: 225, averageProviderMsPerWorkflowRun: 150 });
    expect(group.averageCostPerWorkflowRun).toBeCloseTo(.00018);
    await db().workflowRun.deleteMany({ where: { id: { in: runs.map(r => r.id) } } });
    expect((await getWorkflowUsage({ userId: owner.id })).groups[0].providerAttempts).toBe(3);
  });
  it("flags repeated routing/operations and call explosions without blocking calls", async () => {
    for (let i = 0; i < 20; i++) await writeUsageRecord(record({ operationType: i < 2 ? "routing" : "text-generation", agentId: i < 2 ? null : "tutor" }));
    expect(await getRequestUsage(owner.id, "request-one")).toMatchObject({ aiCallCount: 20, routingCalls: 2, repeatedRouting: true, callExplosion: true, repeatedOperations: expect.any(Array) });
    expect(await getRequestUsage(other.id, "request-one")).toMatchObject({ aiCallCount: 0, repeatedOperations: [] });
  });
  it("keeps the authenticated usage endpoint scoped and rejects frontend user IDs", async () => {
    await writeUsageRecord(record({ createdAt: new Date(Date.now() - 1000) }));
    const request = (query: string, headers = owner.headers) => new Request(`http://localhost:3000/api/student/usage${query}`, { headers });
    expect((await GET(request("", new Headers()))).status).toBe(401);
    expect((await GET(request(`?userId=${other.id}`))).status).toBe(400);
    const response = await GET(request(""));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("x-request-id")).toBeTruthy();
    expect(await response.json()).toMatchObject({ lifetime: { groups: [{ providerAttempts: 1 }] } });
    expect(await (await GET(request("", other.headers))).json()).toMatchObject({ lifetime: { groups: [] } });
  });
  it("correlates real Dispatcher routing and AgentExecutor calls under one request", async () => {
    const f = boundary();
    const result = await new IntelligentDispatcher({ getProvider: () => f.provider }).handleUserAIRequest({ request: "Could you guide me through this concept?" }, owner.headers);
    expect(result, JSON.stringify(result)).toMatchObject({ mode: "agent", result: { ok: true } });
    const records = await db().aIUsageRecord.findMany({ where: { userId: owner.id }, orderBy: { createdAt: "asc" } });
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({ operationType: "routing", agentId: null });
    expect(records[1]).toMatchObject({ operationType: "text-generation", agentId: "tutor" });
    expect(new Set(records.map(r => r.requestId)).size).toBe(1);
    expect(records[1].personalizationFieldsUsed).toBeGreaterThan(0);
    expect(JSON.stringify(f.bodies)).not.toContain(records[0].requestId);
  });
  it("attributes every WorkflowEngine retry/step to the same run and request", async () => {
    const f = boundary(true);
    const course = await db().course.create({ data: { userId: owner.id, courseCode: "USAGE101", courseName: "Usage Math", semester: "Fall" } });
    const exam = await db().exam.create({ data: { userId: owner.id, courseId: course.id, title: "Exam", examDate: new Date(Date.now() + 86400000), topics: ["Logic"] } });
    const initial: WorkflowContext = { goal: "Study", courseId: course.id, exam: { id: exam.id, title: "Exam", examDate: exam.examDate.toISOString(), topics: ["Logic"], daysRemaining: 1, course: { id: course.id, courseCode: course.courseCode, courseName: course.courseName } }, priorities: [], topics: [], studyPlanId: null, planCurrent: false, quizId: null, quizCurrent: false, quizMode: "practice", tutorTopic: null, targetTopics: [], previousStepSummaries: [] };
    const definition: WorkflowDefinition = { id: "exam-preparation", name: "Test", description: "Test", intents: [], maxSteps: 2, maxAgentCalls: 3, maxRetries: 1, maxDurationMs: 60000, failurePolicy: "fail-workflow", steps: ["tutor", "notes"].map(agent => ({ id: agent, agentId: agent as "tutor" | "notes", purpose: "Practice", outputKey: agent, input: () => ({ request: "Explain logic" }) })) };
    const engine = new WorkflowEngine(async () => ({ summary: (await f.provider.generateText({ messages: [{ role: "user", content: "Explain logic" }] })).text }), new ContextReadCache());
    const result = await engine.run(definition, { workflowId: "exam-preparation", goal: "Study", courseId: course.id, examId: exam.id }, initial, owner.headers);
    expect(result.status).toBe("completed");
    const records = await db().aIUsageRecord.findMany({ where: { userId: owner.id } });
    expect(records).toHaveLength(3);
    expect(new Set(records.map(r => r.workflowRunId))).toEqual(new Set([result.runId]));
    expect(new Set(records.map(r => r.requestId)).size).toBe(1);
    expect(records.filter(r => !r.success)).toHaveLength(1);
    expect(new Set(records.map(r => r.agentId))).toEqual(new Set(["tutor", "notes"]));
  });
  it("carries real conversation compression and context counts into executor usage", async () => {
    const f = boundary();
    const conversation = await createConversation({ title: "Usage conversation" }, owner.headers);
    for (let i = 0; i < 26; i++) await appendConversationMessage({ conversationId: conversation.id, role: i % 2 ? "assistant" : "user", content: `Practice induction step ${i}.`, turnId: `usage-${i}` }, owner.headers, { embeddingProvider: null });
    const executor = new AgentExecutor(createStudentAgentRegistry(), { getProvider: () => f.provider, conversationEmbeddingProvider: null });
    await executor.execute({ agentId: "tutor", request: "Continue the induction example", conversation: { id: conversation.id } }, owner.headers);
    const records = await db().aIUsageRecord.findMany({ where: { userId: owner.id } });
    const summary = records.find(r => r.operationType === "summarization");
    const execution = records.find(r => r.operationType === "text-generation");
    expect(summary).toMatchObject({ conversationId: conversation.id, source: "conversation-summary" });
    expect(execution).toMatchObject({ conversationId: conversation.id, conversationSummaryUsed: true, agentId: "tutor" });
    expect(execution!.recentMessageCount).toBeGreaterThan(0);
    expect(summary!.requestId).toBe(execution!.requestId);
  });
  it("tracks local document/query embeddings and the actual RAG chunks used by Tutor", async () => {
    const f = boundary();
    const content = "Mathematical induction proves statements about natural numbers. First establish the base case, then assume P(k) and prove P(k+1).";
    const course = await db().course.create({ data: { userId: owner.id, courseCode: "RAG101", courseName: "Induction", semester: "Fall" } });
    const document = await db().document.create({ data: { userId: owner.id, courseId: course.id, title: "Private lecture", originalFileName: "lecture.txt", fileType: "TXT", fileSize: content.length, storageKey: randomUUID(), processingStatus: "READY", embeddingModel: embeddingProvider.id, pageCount: 1 } });
    await withAIUsageContext({ userId: owner.id }, async () => {
      const vector = JSON.stringify(await embeddingProvider.generateEmbedding(content, { source: "rag-document", userId: owner.id }));
      await db().$executeRaw`INSERT INTO "DocumentChunk" (id,"documentId","userId","courseId","chunkIndex",content,"pageNumber","pageEnd","tokenCount",embedding,"embeddingModel",metadata) VALUES (${randomUUID()},${document.id},${owner.id},${course.id},0,${content},1,1,30,${vector}::vector,${embeddingProvider.id},'{}'::jsonb)`;
      const executor = new AgentExecutor(createStudentAgentRegistry(), { getProvider: () => f.provider, conversationEmbeddingProvider: null });
      await executor.execute({ agentId: "tutor", request: content, courseId: course.id, documentIds: [document.id] }, owner.headers);
    });
    const records = await db().aIUsageRecord.findMany({ where: { userId: owner.id } });
    expect(records.filter(r => r.operationType === "embedding")).toHaveLength(2);
    expect(new Set(records.map(r => r.requestId)).size).toBe(1);
    expect(records.find(r => r.source === "rag-document")).toMatchObject({ provider: "local", usageSource: "provider", batchSize: 1 });
    expect(records.find(r => r.source === "rag-query")).toMatchObject({ provider: "local", agentId: "tutor" });
    expect(records.find(r => r.operationType === "text-generation")).toMatchObject({ agentId: "tutor", ragChunkCount: 1 });
    const usage = await getUserAIUsage({ userId: owner.id });
    expect(usage.groups.find(g => g.kind === "generation")).toMatchObject({ ragProviderAttempts: 1, ragTotalTokens: 150 });
    expect(usage.groups.find(g => g.kind === "embedding")).toMatchObject({ ragProviderAttempts: 2 });
    expect((await getRequestUsage(owner.id, records[0].requestId)).groups.find(g => g.operationType === "text-generation")).toMatchObject({ ragChunksUsed: 1 });
    expect(JSON.stringify(records)).not.toContain("Private lecture");
    expect(JSON.stringify(records)).not.toContain("assume P(k)");
  });
});
