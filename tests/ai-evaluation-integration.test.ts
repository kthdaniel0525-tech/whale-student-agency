import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "@/server/db/client";
import { auth } from "@/server/auth/config";
import { withAIUsageContext } from "@/server/ai/usage/context";
import { writeUsageRecord } from "@/server/ai/usage/records";
import { appendConversationMessage, createConversation } from "@/server/conversations";
import { saveEvaluation } from "@/server/ai/evaluation/store";
import { evaluateDeterministic } from "@/server/ai/evaluation/deterministic";
import { getFeedback, submitFeedback } from "@/server/ai/evaluation/feedback";
import { getQualityAnalytics } from "@/server/ai/evaluation/analytics";
import { hasEvaluationConsent, maybeSampleResponse, setEvaluationConsent } from "@/server/ai/evaluation/sampling";
import { createEvaluateAIResponseJob, evaluationJobPayload, loadEvaluationContext } from "@/server/jobs/evaluate-ai-response";
import { enqueueTrackedUserJob } from "@/server/jobs/enqueue";
import { getBackgroundJob } from "@/server/jobs/registry";
import { PUT, GET } from "@/app/api/student/assistant/messages/[messageId]/feedback/route";
import type { AIProvider, AIStructuredRequest } from "@/server/ai/types";
import type { BackgroundJobPublisher } from "@/server/jobs/client";
import { QUALITY_PROFILES } from "@/server/ai/evaluation/profiles";
const versions = { datasetVersion: "test-v1", promptVersion: "prompt-v1", routingVersion: "route-v1", contextVersion: "context-v1" };
const result = evaluateDeterministic({ profile: "tutor", request: "Explain induction", output: "Establish a base case, then prove the inductive step." });
type Actor = { id: string; headers: Headers };
let owner: Actor, other: Actor;
async function actor() {
  const response = await auth().api.signUpEmail({ body: { name: "Quality Student", email: `quality-${randomUUID()}@example.test`, password: "Quality-test-passphrase-2026!" }, asResponse: true });
  expect(response.status).toBe(200); const { user } = await response.json() as { user: { id: string } };
  await db().profile.create({ data: { userId: user.id, school: "Test University", program: "Math", currentYear: 2, semester: "Fall", academicGoal: "Learn", studySessionMinutes: 30, explanationDifficulty: "INTERMEDIATE", timezone: "UTC" } });
  return { id: user.id, headers: new Headers({ cookie: response.headers.getSetCookie().map(c => c.split(";")[0]).join("; ") }) };
}
async function fixture(actor = owner) {
  const requestId = randomUUID(), turnId = randomUUID(), usageId = randomUUID();
  const conversation = await createConversation({}, actor.headers);
  const message = await withAIUsageContext({ userId: actor.id, requestId }, async () => {
    await appendConversationMessage({ conversationId: conversation.id, role: "user", content: "Explain induction.", turnId, metadata: { workspaceVisible: true } }, actor.headers, { embeddingProvider: null });
    await writeUsageRecord({ id: usageId, userId: actor.id, requestId, conversationId: conversation.id, provider: "openai", model: "fixture-model", selectedTier: "STRONG", fallbackUsed: true, agentId: "tutor", operationType: "text-generation", latencyMs: 123, usageSource: "provider", inputTokens: 100, outputTokens: 20, totalTokens: 120, estimatedCostUsd: .001, pricingVersion: "test-v1", createdAt: new Date(), success: true, promptVersion: "original-prompt", routingVersion: "original-route", contextVersion: "original-context" });
    return appendConversationMessage({ conversationId: conversation.id, role: "assistant", agentId: "tutor", content: "Establish a base case, then prove the inductive step.", turnId, metadata: { workspaceVisible: true } }, actor.headers, { embeddingProvider: null });
  });
  return { userId: actor.id, messageId: message.id, requestId, usageRecordId: usageId, conversationId: conversation.id };
}
beforeAll(async () => { owner = await actor(); other = await actor(); });
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
afterAll(async () => { await db().user.deleteMany({ where: { id: { in: [owner.id, other.id] } } }); await db().$disconnect(); });
function policy() { vi.stubEnv("AI_EVAL_SAMPLING_ENABLED", "true"); vi.stubEnv("AI_EVAL_POLICY_VERSION", "approved-test-v1"); vi.stubEnv("AI_EVAL_POLICY_URL", "https://example.test/privacy/evaluation"); }
function links(f: Awaited<ReturnType<typeof fixture>>) { return { userId: f.userId, messageId: f.messageId, requestId: f.requestId, usageRecordId: f.usageRecordId }; }
describe.sequential("quality persistence and privacy", () => {
  it("persists idempotent safe scores linked to owned immutable usage versions", async () => {
    const f = await fixture(), a = await saveEvaluation({ result, versions, links: links(f) }), b = await saveEvaluation({ result, versions, links: links(f) });
    expect(a.id).toBe(b.id); expect(a).toMatchObject({ model: "fixture-model", promptVersion: "original-prompt", routingVersion: "original-route", selectedTier: "STRONG", fallbackUsed: true });
    expect(JSON.stringify(a)).not.toContain("Establish a base case");
    expect(await db().conversationMessage.findUnique({ where: { id: f.messageId } })).toHaveProperty("requestId", f.requestId);
  });
  it("rejects cross-user evaluation links and mismatched owned request/message pairs", async () => {
    const a = await fixture(), b = await fixture(other), c = await fixture();
    await expect(saveEvaluation({ result, versions, links: { ...links(b), userId: owner.id } })).rejects.toThrow("OWNERSHIP");
    await expect(saveEvaluation({ result, versions, links: { ...links(a), usageRecordId: c.usageRecordId } })).rejects.toThrow("OWNERSHIP");
    await expect(saveEvaluation({ result, versions, links: { ...links(a), requestId: "fake" } })).rejects.toThrow("OWNERSHIP");
    await expect(saveEvaluation({ result, versions, links: { usageRecordId: b.usageRecordId } })).rejects.toThrow("OWNERSHIP");
  });
  it("records optional feedback separately from correctness and links the evaluation", async () => {
    const f = await fixture();
    await saveEvaluation({ result, versions, links: links(f) });
    await submitFeedback(owner.id, f.messageId, { rating: -1, reasonCode: "TOO_LONG", comment: "private-comment" });
    const feedback = await db().aIUserFeedback.findUniqueOrThrow({ where: { userId_messageId: { userId: owner.id, messageId: f.messageId } } });
    expect(feedback.usageRecordId).toBe(f.usageRecordId);
    const derived = await db().aIEvaluationRecord.findFirstOrThrow({ where: { feedbackId: feedback.id } });
    expect(derived).toMatchObject({ evaluationType: "user-feedback", passed: null, score: 0, dimensions: {} });
    expect(JSON.stringify(derived)).not.toContain("private-comment");
    await submitFeedback(owner.id, f.messageId, { rating: 1, comment: null });
    expect(await getFeedback(owner.id, f.messageId)).toMatchObject({ rating: 1, comment: null });
    expect(await db().aIEvaluationRecord.count({ where: { feedbackId: feedback.id } })).toBe(1);
  });
  it("enforces feedback authentication, origin, ownership and input allowlist", async () => {
    const f = await fixture(other), context = { params: Promise.resolve({ messageId: f.messageId }) }, base = process.env.BETTER_AUTH_URL!;
    const request = (headers: Headers, body: object) => { const h = new Headers(headers); h.set("origin", base); h.set("content-type", "application/json"); return new Request(`${base}/api/student/assistant/messages/${f.messageId}/feedback`, { method: "PUT", headers: h, body: JSON.stringify(body) }); };
    expect((await GET(new Request(base), context)).status).toBe(401);
    expect((await PUT(request(owner.headers, { rating: 1 }), context)).status).toBe(404);
    expect((await PUT(request(other.headers, { rating: 1, userId: owner.id }), context)).status).toBe(400);
    expect((await PUT(request(other.headers, { rating: 1 }), context)).status).toBe(200);
    await expect(getFeedback(owner.id, f.messageId)).rejects.toMatchObject({ status: 404 });
  });
  it("omits comments and joins costs/latency by owned usage, preserving conflicting satisfaction", async () => {
    const f = await fixture(); await saveEvaluation({ result, versions, links: links(f) });
    await submitFeedback(owner.id, f.messageId, { rating: -1, comment: "never in analytics" });
    const report = await getQualityAnalytics({ userId: owner.id, since: new Date(Date.now() - 60000), until: new Date(Date.now() + 60000) });
    expect(report.cohorts.some(c => c.meanCostUsd === .001 && c.meanLatencyMs === 123)).toBe(true);
    expect(report.positiveEvaluationWithNegativeFeedback).toBeGreaterThan(0); expect(JSON.stringify(report)).not.toContain("never in analytics");
    const isolated = await getQualityAnalytics({ userId: other.id, since: new Date(Date.now() - 60000), until: new Date(Date.now() + 60000) });
    expect(isolated.positiveEvaluationWithNegativeFeedback).toBe(0);
  });
  it("requires policy-specific opt-in and rechecks revocation before background evaluation", async () => {
    const f = await fixture(), getProvider = vi.fn(() => { throw new Error("must not call"); }), job = createEvaluateAIResponseJob(getProvider);
    const payload = evaluationJobPayload.parse({ ...links(f), version: 1, trackingId: "test", policyVersion: "approved-test-v1" });
    expect(await job.handler({ payload, signal: new AbortController().signal, attempt: 1, jobRunId: "test" })).toMatchObject({ skipped: true });
    policy(); await setEvaluationConsent(owner.id, { enabled: true, policyVersion: "approved-test-v1" });
    expect(await hasEvaluationConsent(owner.id, "approved-test-v1")).toBe(true);
    expect(await hasEvaluationConsent(owner.id, "new-policy")).toBe(false);
    await setEvaluationConsent(owner.id, { enabled: false });
    expect(await job.handler({ payload, signal: new AbortController().signal, attempt: 1, jobRunId: "test" })).toMatchObject({ reason: "NO_CONSENT" });
    expect(getProvider).not.toHaveBeenCalled();
  });
  it("loads only owned persisted text and executes a structured judge via the existing job contract", async () => {
    const f = await fixture(); policy(); await setEvaluationConsent(owner.id, { enabled: true, policyVersion: "approved-test-v1" });
    const payload = evaluationJobPayload.parse({ ...links(f), version: 1, trackingId: "test", policyVersion: "approved-test-v1" });
    expect(await loadEvaluationContext({ ...payload, userId: other.id })).toBeNull();
    const generateStructuredOutput = vi.fn(async <T>(r: AIStructuredRequest<T>) => ({ data: r.schema.parse({ judgments: QUALITY_PROFILES.tutor.semantic.map(d => ({ dimension: d, score: d === "sourceFaithfulness" ? null : 1, failures: [], rationale: "brief private verdict" })) }), model: "judge", text: "" }));
    const provider = { generateStructuredOutput } as unknown as AIProvider;
    const job = createEvaluateAIResponseJob(() => provider);
    expect(getBackgroundJob(job.name)).toBeDefined();
    expect(await job.handler({ payload, signal: new AbortController().signal, attempt: 1, jobRunId: "test" })).toMatchObject({ evaluated: true });
    const rows = await db().aIEvaluationRecord.findMany({ where: { messageId: f.messageId } });
    expect(rows).toHaveLength(2); expect(JSON.stringify(rows)).not.toContain("private verdict");
    expect(generateStructuredOutput.mock.calls[0][0].usageContext).toMatchObject({ guardFeature: "quality-evaluation", userId: owner.id });
    await setEvaluationConsent(owner.id, { enabled: false });
  });
  it("queues only references with transaction/deduplication using the existing publisher", async () => {
    const f = await fixture(), job = createEvaluateAIResponseJob(), sendDebounced = vi.fn(async () => randomUUID());
    const options = { idempotencyKey: `quality-test:${f.messageId}`, resourceId: f.messageId };
    const payload = { messageId: f.messageId, requestId: f.requestId, usageRecordId: f.usageRecordId, policyVersion: "approved-test-v1" };
    const publisher = { sendDebounced } as unknown as BackgroundJobPublisher;
    const a = await enqueueTrackedUserJob(job, owner.id, options, { publisher, payload });
    const b = await enqueueTrackedUserJob(job, owner.id, options, { publisher, payload });
    expect(a.id).toBe(b.id); expect(sendDebounced).toHaveBeenCalledTimes(1);
    const args = sendDebounced.mock.calls[0] as unknown as [string, unknown];
    expect(evaluationJobPayload.safeParse(args[1]).success).toBe(true); expect(JSON.stringify(args[1])).not.toContain("Explain induction");
  });
  it("always allows consent withdrawal even if operator configuration becomes invalid", async () => {
    policy(); await setEvaluationConsent(owner.id, { enabled: true, policyVersion: "approved-test-v1" });
    vi.stubEnv("AI_EVAL_POLICY_URL", "");
    await expect(setEvaluationConsent(owner.id, { enabled: false })).resolves.toEqual({ enabled: false, policyVersion: null });
    expect(await hasEvaluationConsent(owner.id, "approved-test-v1")).toBe(false);
  });
  it("does not sample without explicit consent or evaluate deleted source records", async () => {
    const f = await fixture(); policy();
    expect(await maybeSampleResponse(owner.id, f.messageId, true)).toEqual({ queued: false });
    const payload = evaluationJobPayload.parse({ ...links(f), version: 1, trackingId: "test", policyVersion: "approved-test-v1" });
    await db().conversationMessage.update({ where: { id: f.messageId }, data: { metadata: { workspaceVisible: true, sourceRefs: JSON.stringify([{ documentId: "deleted", documentTitle: "Old lecture", chunkIndex: 0 }]) } } });
    expect(await loadEvaluationContext(payload)).toBeNull();
  });
});
