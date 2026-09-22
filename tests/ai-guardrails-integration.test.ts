import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi, afterEach } from "vitest";
import { auth } from "@/server/auth/config";
import { db } from "@/server/db/client";
import { DEFAULT_GUARDRAILS } from "@/server/ai/guardrails/config";
import { GuardrailService } from "@/server/ai/guardrails/service";
import { postgresGuardStore, guardKey } from "@/server/ai/guardrails/store";
import { recordGuardEvent, getGuardrailMetrics } from "@/server/ai/guardrails/events";
import { executeAssistantRequest, streamAssistantRequest } from "@/server/assistant/service";
import { WorkflowEngine } from "@/server/workflows/engine";
import type { WorkflowContext, WorkflowDefinition } from "@/server/workflows/types";
import { ContextReadCache } from "@/server/context/cache";
import { OpenAIProvider } from "@/server/ai/providers/openai";
import { AI_DEFAULTS } from "@/server/ai/config";
import { captureUsageContext } from "@/server/ai/usage/context";
import type { UnifiedAIResult } from "@/server/dispatcher";

let owner: string, other: string, headers: Headers, courseId: string;
const requestIds: string[] = [];
function context(userId = owner) { const requestId = randomUUID(); requestIds.push(requestId); return { userId, requestId }; }
beforeAll(async () => {
  const response = await auth().api.signUpEmail({ body: { name: "Guard Student", email: `guards-${randomUUID()}@example.test`, password: "Guardrails-test-passphrase-2026!" }, asResponse: true });
  expect(response.status).toBe(200);
  owner = (await response.json() as { user: { id: string } }).user.id;
  other = `guard-other-${randomUUID()}`;
  headers = new Headers({ cookie: response.headers.getSetCookie().map(c => c.split(";")[0]).join("; ") });
  await db().profile.create({ data: { userId: owner, school: "Test", program: "CS", currentYear: 1, semester: "Fall", academicGoal: "Study", studySessionMinutes: 45, explanationDifficulty: "INTERMEDIATE", timezone: "UTC" } });
  courseId = (await db().course.create({ data: { userId: owner, courseCode: "GUARD", courseName: "Safety", semester: "Fall" } })).id;
});
afterEach(() => vi.unstubAllEnvs());
afterAll(async () => {
  await db().aIGuardEvent.deleteMany({ where: { userId: { in: [owner, other] } } });
  await db().user.deleteMany({ where: { id: owner } });
  await db().$disconnect();
});
const reservation = (c: ReturnType<typeof context>) => ({ context: c, provider: `fixture-${owner}`, model: "shared-model", inputTokens: 20, outputTokens: 50, embedding: false, fingerprint: randomUUID() });

describe.sequential("distributed PostgreSQL guardrails at application boundaries", () => {
  it("serializes shared counters across independent store clients without lost updates", async () => {
    const key = guardKey("integration-counter", owner);
    await Promise.all(Array.from({ length: 12 }, () => ({ ...postgresGuardStore }).transaction([key], (tx, now) => {
      tx.set(key, { data: { count: Number(tx.get(key)?.data.count ?? 0) + 1 }, expiresAt: now + 60000 });
    })));
    expect((await db().aIGuardState.findUniqueOrThrow({ where: { key } })).data).toEqual({ count: 12 });
  });
  it("enforces atomic rate admission across instances and isolates authenticated identities", async () => {
    const config = structuredClone(DEFAULT_GUARDRAILS); config.rates.interactiveMinute = 1;
    const id = `rate-${randomUUID()}`;
    const a = new GuardrailService(postgresGuardStore, () => config), b = new GuardrailService({ ...postgresGuardStore }, () => config);
    const results = await Promise.allSettled([a.admit(context(id)), b.admit(context(id))]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find(r => r.status === "rejected")).toMatchObject({ reason: { code: "AI_REQUEST_RATE_LIMITED" } });
    await expect(b.admit(context(`other-${id}`))).resolves.toBeUndefined();
  });
  it("shares provider leases and releases capacity for a second server", async () => {
    const config = structuredClone(DEFAULT_GUARDRAILS); config.concurrency.provider = 1;
    const a = new GuardrailService(postgresGuardStore, () => config), b = new GuardrailService({ ...postgresGuardStore }, () => config);
    const first = await a.reserve(reservation(context()));
    try { await expect(b.reserve(reservation(context(other)))).rejects.toMatchObject({ code: "AI_CONCURRENCY_LIMIT" }); }
    finally { await first.finish({ inputTokens: 5, outputTokens: 5, totalTokens: 10 }); }
    const second = await b.reserve(reservation(context(other))); await second.finish();
  });
  it("reconciles actual tokens once in a shared request ledger", async () => {
    const service = new GuardrailService(); const c = context();
    const lease = await service.reserve(reservation(c)); await lease.finish({ inputTokens: 5, outputTokens: 7, totalTokens: 12 }); await lease.finish();
    const row = await db().aIGuardState.findUniqueOrThrow({ where: { key: guardKey("request", owner, c.requestId) } });
    expect(row.data).toMatchObject({ calls: 1, input: 5, output: 7, total: 12 });
  });
  it("prevents first-turn double execution across JSON/stream and replays saved content", async () => {
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    const execute = vi.fn(async (): Promise<UnifiedAIResult> => {
      entered(); await gate;
      return { needsClarification: false, mode: "agent", target: { id: "tutor", name: "Tutor" }, dispatch: { confidence: 1, method: "rule" },
        metrics: { dispatchDurationMs: 0, executionDurationMs: 1, totalDurationMs: 1, aiCalls: 1, ragCalls: 0, contextCharacters: 0, contextEstimatedTokens: 0, workflowSteps: 0, success: true },
        result: { ok: true, agent: { id: "tutor", name: "Tutor" }, routing: { agentId: "tutor", method: "rule", confidence: 1 }, response: { content: "Saved explanation", sources: [] }, metadata: { totalDurationMs: 1 } } };
    });
    const input = { request: "Explain induction.", turnId: randomUUID(), courseId };
    const pending = executeAssistantRequest(input, headers, { execute });
    await started;
    try {
      await expect(executeAssistantRequest(input, headers, { execute })).rejects.toMatchObject({ code: "AI_DUPLICATE_REQUEST" });
      await expect(streamAssistantRequest(input, headers)).rejects.toMatchObject({ code: "AI_DUPLICATE_REQUEST" });
    } finally { release(); }
    const first = await pending;
    const replay = await executeAssistantRequest(input, headers, { execute });
    expect(replay.conversation.id).toBe(first.conversation.id); expect(execute).toHaveBeenCalledTimes(1);
    const stream = await streamAssistantRequest(input, headers);
    expect(await stream.text()).toContain("Saved explanation"); expect(execute).toHaveBeenCalledTimes(1);
    await expect(executeAssistantRequest({ ...input, userId: other }, headers, { execute })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(executeAssistantRequest(input, new Headers(), { execute })).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  });
  it("keeps completed workflow output when a real provider-boundary budget stops the next step", async () => {
    vi.stubEnv("AI_GUARDRAILS_JSON", JSON.stringify({ profiles: { WORKFLOW: { maxAICalls: 1 } } }));
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => new Response(JSON.stringify({ id: "fixture-response", model: JSON.parse(String(init?.body)).model,
      status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "Useful work" }] }], usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 } }), { headers: { "content-type": "application/json" } }));
    const provider = new OpenAIProvider({ ...AI_DEFAULTS, apiKey: "mock" }, fetcher);
    const definition: WorkflowDefinition = { id: "exam-preparation", name: "Guard test", description: "Bounded", intents: [], maxSteps: 2, maxAgentCalls: 2, maxRetries: 1, maxDurationMs: 300000, failurePolicy: "continue-with-warning",
      steps: ["first", "next"].map(id => ({ id, agentId: "tutor", purpose: id, outputKey: id, input: () => ({ request: id }) })) };
    const exam = { id: `exam-${randomUUID()}`, title: "Exam", examDate: new Date().toISOString(), topics: ["Induction"], daysRemaining: 3, course: { id: courseId, courseCode: "GUARD", courseName: "Safety" } };
    const initial: WorkflowContext = { goal: "Prepare", courseId, exam, priorities: [], topics: [], studyPlanId: null, planCurrent: false, quizId: null, quizCurrent: false, quizMode: "practice", tutorTopic: null, targetTopics: [], previousStepSummaries: [] };
    const seenRequests: string[] = [];
    const engine = new WorkflowEngine(async step => {
      seenRequests.push(captureUsageContext().requestId!);
      const response = await provider.generateText({ messages: [{ role: "user", content: step.id }] });
      return { summary: response.text, data: { explanation: response.text } };
    }, new ContextReadCache());
    const result = await engine.run(definition, { workflowId: "exam-preparation", goal: "Prepare" }, initial, headers);
    expect(result).toMatchObject({ status: "failed", errorCode: "AI_REQUEST_BUDGET_EXCEEDED", completedSteps: ["first"], outputs: { first: { explanation: "Useful work" } } });
    expect(result.summary).toContain("Completed work remains available");
    expect(fetcher).toHaveBeenCalledTimes(1); expect(new Set(seenRequests).size).toBe(1);
    expect(await db().aIUsageRecord.count({ where: { userId: owner, workflowRunId: result.runId } })).toBe(1);
    const saved = await engine.get(result.runId, headers); expect(saved.outputs).toEqual(result.outputs);
  });
  it("does not recreate guard telemetry for deleted or deletion-pending owners, while preserving system events", async () => {
    const user = await db().user.create({ data: { id: randomUUID(), name: "Deleting guard owner", email: `guard-delete-${randomUUID()}@example.test` } });
    const before = context(user.id), pending = context(user.id), deleted = context(user.id), system = randomUUID();
    try {
      await recordGuardEvent({ context: before, type: "AI_CONTEXT_LIMIT" });
      expect(await db().aIGuardEvent.count({ where: { requestId: before.requestId } })).toBe(1);
      await db().user.update({ where: { id: user.id }, data: { deletionRequestedAt: new Date() } });
      await recordGuardEvent({ context: pending, type: "AI_CONTEXT_LIMIT" });
      expect(await db().aIGuardEvent.count({ where: { requestId: pending.requestId } })).toBe(0);
      let beganDeletion!: () => void, finishDeletion!: () => void;
      const started = new Promise<void>(resolve => { beganDeletion = resolve; });
      const gate = new Promise<void>(resolve => { finishDeletion = resolve; });
      const deletion = db().$transaction(async tx => {
        await tx.$queryRaw`SELECT id FROM "User" WHERE id=${user.id} FOR UPDATE`;
        await tx.aIGuardEvent.deleteMany({ where: { userId: user.id } });
        await tx.user.delete({ where: { id: user.id } });
        beganDeletion();
        await gate;
      });
      await started;
      const lateEvent = recordGuardEvent({ context: deleted, type: "AI_CONTEXT_LIMIT" });
      finishDeletion();
      await Promise.all([deletion, lateEvent]);
      await recordGuardEvent({ context: deleted, type: "AI_CONTEXT_LIMIT" });
      expect(await db().aIGuardEvent.count({ where: { userId: user.id } })).toBe(0);
      await recordGuardEvent({ context: { requestId: system }, type: "AI_SERVICE_TEMPORARILY_UNAVAILABLE" });
      expect(await db().aIGuardEvent.findFirst({ where: { requestId: system } })).toMatchObject({ userId: null });
    } finally {
      await db().aIGuardEvent.deleteMany({ where: { OR: [{ userId: user.id }, { requestId: system }] } });
      await db().user.deleteMany({ where: { id: user.id } });
    }
  });

  it("records safe guard events and exposes only each owner's aggregates", async () => {
    const c = context(); await recordGuardEvent({ context: c, type: "AI_EMBEDDING_LIMIT", snapshot: { embeddingCalls: 3 } });
    await recordGuardEvent({ context: context(other), type: "AI_CONTEXT_LIMIT" });
    expect(await getGuardrailMetrics(owner)).toEqual(expect.arrayContaining([expect.objectContaining({ type: "AI_EMBEDDING_LIMIT", _count: { _all: 1 } })]));
    expect((await getGuardrailMetrics(owner)).some(r => r.type === "AI_CONTEXT_LIMIT")).toBe(false);
    const row = await db().aIGuardEvent.findFirstOrThrow({ where: { requestId: c.requestId } });
    expect(Object.keys(row)).not.toEqual(expect.arrayContaining(["prompt", "messages", "content"]));
  });
});
