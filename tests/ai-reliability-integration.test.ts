import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { auth } from "@/server/auth/config";
import { db } from "@/server/db/client";
import { AIError } from "@/server/ai/errors";
import { AI_DEFAULTS } from "@/server/ai/config";
import { OpenAIProvider } from "@/server/ai/providers/openai";
import { createRoutedAIProvider } from "@/server/ai/routing/provider";
import { DEFAULT_MODEL_CATALOG } from "@/server/ai/routing/catalog";
import { DEFAULT_RELIABILITY } from "@/server/ai/reliability/config";
import { ProviderHealthService } from "@/server/ai/reliability/health";
import { postgresGuardStore, guardKey } from "@/server/ai/guardrails/store";
import { getReliabilityMetrics } from "@/server/ai/usage/analytics";
import { WorkflowEngine } from "@/server/workflows/engine";
import type { WorkflowContext, WorkflowDefinition } from "@/server/workflows/types";
import { ContextReadCache } from "@/server/context/cache";
import { retrieveAcademicContext } from "@/server/documents/retrieval";
import { testHealth } from "./guard-fixture";

let owner: string, other: string, headers: Headers, courseId: string;
const healthProvider = `health-${randomUUID()}`;
beforeAll(async () => {
  const response = await auth().api.signUpEmail({ body: { name: "Reliability Student", email: `reliability-${randomUUID()}@example.test`, password: "Reliability-test-passphrase-2026!" }, asResponse: true });
  expect(response.status).toBe(200); owner = (await response.json() as { user: { id: string } }).user.id; other = `other-${randomUUID()}`;
  headers = new Headers({ cookie: response.headers.getSetCookie().map(c => c.split(";")[0]).join("; ") });
  courseId = (await db().course.create({ data: { userId: owner, courseCode: "RELIABILITY", courseName: "Reliability", semester: "Fall" } })).id;
});
afterAll(async () => {
  await db().aIGuardState.deleteMany({ where: { key: { in: [guardKey("ai-health-provider", healthProvider), guardKey("ai-health-model", healthProvider, "model")] } } });
  await db().aIGuardEvent.deleteMany({ where: { userId: owner } });
  await db().user.deleteMany({ where: { id: owner } }); await db().$disconnect();
});

describe.sequential("reliability with real persistence and mocked provider HTTP", () => {
  it("shares circuit evidence and atomically leases a half-open probe across independent PostgreSQL clients", async () => {
    const config = structuredClone(DEFAULT_RELIABILITY), ref = { provider: healthProvider, model: "model" }, context = { userId: owner, requestId: randomUUID() };
    const a = new ProviderHealthService(postgresGuardStore, () => config), b = new ProviderHealthService({ ...postgresGuardStore }, () => config);
    for (const service of [a, b, a]) await (await service.claim(ref, 100, context)).finish({ kind: "provider-unavailable" }, 10);
    expect((await b.list([ref])).find(h => h.model)).toMatchObject({ selectable: false, circuit: "open" });
    const key = guardKey("ai-health-model", healthProvider, "model");
    // Advance the persisted cooldown explicitly; no timing-dependent sleeps.
    await db().$executeRaw`UPDATE "AIGuardState" SET data=jsonb_set(data,'{openUntil}','0'::jsonb) WHERE key=${key}`;
    const outcomes = await Promise.allSettled([a.claim(ref, 100, context), b.claim(ref, 100, context)]);
    expect(outcomes.filter(r => r.status === "fulfilled")).toHaveLength(1);
    for (const r of outcomes) if (r.status === "fulfilled") await r.value.finish("success", 5);
    expect((await b.list([ref])).find(h => h.model)).toMatchObject({ selectable: true, circuit: "closed" });
    const event = await db().aIGuardEvent.findFirstOrThrow({ where: { requestId: context.requestId, type: "AI_CIRCUIT_OPEN" } });
    expect(event).toMatchObject({ provider: healthProvider, model: "model" });
  });
  it.each(["continue-with-warning", "fail-workflow"] as const)("exhausted provider fallbacks honor %s and preserve completed outputs", async policy => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ error: { message: "private upstream details" } }), { status: 503, headers: { "content-type": "application/json" } }));
    const openai = new OpenAIProvider({ ...AI_DEFAULTS, apiKey: "mock-only" }, fetcher);
    const base = DEFAULT_MODEL_CATALOG[1];
    const models = [{ ...base, model: "primary-test", fallbackModels: [{ provider: "openai", model: "backup-test" }] }, { ...base, model: "backup-test", relativeCostClass: 9, fallbackModels: [] }];
    const provider = createRoutedAIProvider({ providers: { openai }, embeddingProvider: openai, catalog: models, history: async () => [], health: testHealth() });
    const definition: WorkflowDefinition = { id: "exam-preparation", name: "Recovery", description: "Test", intents: [], maxSteps: 3, maxAgentCalls: 3, maxRetries: 1, maxDurationMs: 300000, failurePolicy: "continue-with-warning",
      steps: ["saved", "outage", "next"].map(id => ({ id, agentId: "tutor", purpose: id, outputKey: id, failurePolicy: id === "outage" ? policy : "fail-workflow", input: () => ({ request: id }) })) };
    const context: WorkflowContext = { goal: "Prepare", courseId, exam: { id: randomUUID(), title: "Exam", examDate: new Date().toISOString(), topics: [], daysRemaining: 5, course: { id: courseId, courseCode: "R", courseName: "Reliability" } }, priorities: [], topics: [], studyPlanId: null, planCurrent: false, quizId: null, quizCurrent: false, quizMode: "practice", tutorTopic: null, targetTopics: [], previousStepSummaries: [] };
    const engine = new WorkflowEngine(async step => {
      if (step.id === "outage") await provider.generateText({ messages: [{ role: "user", content: "private question" }], maxOutputTokens: 100 });
      return { summary: "Useful saved work", data: { result: "Saved output" } };
    }, new ContextReadCache());
    const result = await engine.run(definition, { workflowId: "exam-preparation", goal: "Prepare" }, context, headers);
    expect(result.status).toBe(policy === "continue-with-warning" ? "completed" : "failed");
    expect(result.outputs.saved).toEqual({ result: "Saved output" }); expect(fetcher).toHaveBeenCalledTimes(2);
    expect(result.steps.find(s => s.stepId === "outage")).toMatchObject({ attempts: 1, errorCode: "AI_SERVICE_TEMPORARILY_UNAVAILABLE" });
    expect((await engine.get(result.runId, headers)).outputs.saved).toEqual(result.outputs.saved);
    const records = await db().aIUsageRecord.findMany({ where: { userId: owner, workflowRunId: result.runId }, orderBy: { createdAt: "asc" } });
    expect(records).toHaveLength(2); expect(records[1]).toMatchObject({ fallbackUsed: true, fallbackDepth: 1, attemptNumber: 2, failureClass: "overloaded" });
    expect(JSON.stringify(records)).not.toContain("private question");
  });
  it("returns real ownership-scoped provider/model reliability metrics", async () => {
    const result = await getReliabilityMetrics({ userId: owner });
    expect(result.groups.find(g => g.model === "backup-test")).toMatchObject({ attempts: 2, fallbackRate: 1, fallbackSuccessRate: 0, successRate: 0 });
    expect(result.events.some(e => e.type === "AI_CIRCUIT_OPEN")).toBe(true);
    expect((await getReliabilityMetrics({ userId: other })).groups).toEqual([]);
  });
  it("RAG propagates embedding unavailability rather than inventing an empty grounded result", async () => {
    const document = await db().document.create({ data: { userId: owner, courseId, title: "Lecture", originalFileName: "lecture.pdf", fileType: "application/pdf", fileSize: 10, storageKey: randomUUID(), processingStatus: "READY", embeddingModel: "exact-space" } });
    const generateEmbedding = vi.fn(async () => { throw new AIError("AI_SERVICE_TEMPORARILY_UNAVAILABLE"); });
    await expect(retrieveAcademicContext(owner, { query: "Explain the lecture", courseId, documentIds: [document.id] }, { id: "exact-space", generateEmbedding })).rejects.toMatchObject({ status: 503 });
    expect(generateEmbedding).toHaveBeenCalledOnce();
  });
});
