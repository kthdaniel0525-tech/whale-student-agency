import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/server/db/client";
import { auth } from "@/server/auth/config";
import { betaAccess, assertBetaAdmin, assertBetaBilling } from "@/server/beta/access";
import { signupAllowed } from "@/server/operations/config";
import { getUserEntitlements, setUserPlan } from "@/server/entitlements/service";
import { parseEvent, clientEventSchema, DEFAULT_MEANINGFUL_EVENTS } from "@/lib/product-analytics/events";
import { analyticsConfig } from "@/server/product-analytics/config";
import { trackProductEvent, flushProductAnalytics, setAnalyticsPreference, ConsoleAnalytics, DatabaseAnalytics, deliveryHealth, recommendationProperties } from "@/server/product-analytics/service";
import { trackApiSuccess } from "@/server/product-analytics/http";
import { createProductFeedback, feedbackPrompt, dismissFeedbackPrompt, triageFeedback, listPrivateFeedback } from "@/server/beta/feedback";
import { getBetaOverview, getActivationFunnel, getRetentionMetrics, getWorkflowMetrics, getFeedbackSummary, getLaunchReadiness } from "@/server/beta/metrics";
import { GET as courses, POST as createCourse } from "@/app/api/student/courses/route";
import { PUT as profile } from "@/app/api/student/profile/route";
import { POST as clientEvent } from "@/app/api/student/product-analytics/route";
import { GET as internalMetrics } from "@/app/api/internal/beta/route";
import { api, RequestError } from "@/server/api";
import { WorkflowEngine } from "@/server/workflows/engine";
import { ContextReadCache } from "@/server/context/cache";
import type { WorkflowDefinition } from "@/server/workflows/types";
import { AgentExecutor } from "@/server/agents/executor";
import { createStudentAgentRegistry } from "@/server/agents/student-service";
import type { AIProvider } from "@/server/ai/types";
import { submitFeedback } from "@/server/ai/evaluation/feedback";
import { startRecommendedAction } from "@/server/recommendations/service";
import { uploadDocument } from "@/server/documents/service";
import { processNextDocument } from "@/server/documents/processor";
import { cleanupFiles } from "@/server/documents/cleanup";
import { RAG_EMBEDDING } from "@/server/ai/config";
import { QuizAgentService } from "@/server/agents/quiz/service";
import { createCheckoutSession, processBillingEvent, syncSubscriptionFromProvider } from "@/server/billing/service";
import type { BillingProvider, ProviderSubscription } from "@/server/billing/types";

type Actor = { id: string; email: string; headers: Headers };
const actors: Actor[] = [];
let owner: Actor, other: Actor, admin: Actor;
const base = process.env.BETTER_AUTH_URL!;
const request = (path: string, method = "GET", body?: unknown, actor = owner) => new Request(base + path, { method, headers: actor.headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const feedback = (extra: Record<string, unknown> = {}) => ({ submissionId: randomUUID(), category: "bug", message: "Private lecture details and a secret prompt", page: "assistant", feature: "assistant", ...extra });
async function actor() {
  const email = `beta-${randomUUID()}@example.test`;
  const response = await auth().api.signUpEmail({ body: { name: "Beta fixture", email, password: "Beta-fixture-passphrase!" }, asResponse: true });
  expect(response.status).toBe(200);
  const { user } = await response.json();
  const result = { id: user.id as string, email, headers: new Headers({ cookie: response.headers.getSetCookie().map(c => c.split(";")[0]).join("; "), origin: base, "content-type": "application/json" }) };
  actors.push(result);
  await db().profile.create({ data: { userId: result.id, school: "Fixture", program: "Math", academicGoal: "Practice", currentYear: 1, semester: "Fall", studySessionMinutes: 45, explanationDifficulty: "INTERMEDIATE", timezone: "UTC" } });
  return result;
}
beforeAll(async () => { owner = await actor(); other = await actor(); admin = await actor(); });
beforeEach(async () => {
  vi.stubEnv("PRODUCT_ANALYTICS_ENABLED", "true"); vi.stubEnv("PRODUCT_ANALYTICS_PROVIDER", "database"); vi.stubEnv("APP_ENV", "test"); vi.stubEnv("BETA_MODE", "false"); vi.stubEnv("BETA_ADMIN_USER_IDS", admin.id);
  await db().productEvent.deleteMany({ where: { userId: { in: actors.map(a => a.id) } } });
  await db().productFeedback.deleteMany({ where: { userId: { in: actors.map(a => a.id) } } });
  await db().productAnalyticsState.deleteMany({ where: { userId: { in: actors.map(a => a.id) } } });
  for (const a of [owner, other, admin]) await db().betaAccess.upsert({ where: { userId: a.id }, create: { userId: a.id, status: "active", cohort: "integrations", internal: false }, update: { status: "active", cohort: "integrations", internal: false } });
});
afterEach(async () => { await flushProductAnalytics(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
afterAll(async () => { await flushProductAnalytics(); await db().user.deleteMany({ where: { id: { in: actors.map(a => a.id) } } }); for (const a of actors) await cleanupFiles(a.id); });
async function events(userId = owner.id) { await flushProductAnalytics(); return db().productEvent.findMany({ where: { userId }, orderBy: { createdAt: "asc" } }); }

describe("closed beta boundaries", () => {
  it("requires an exact signup allowlist in closed mode", () => { vi.stubEnv("BETA_MODE", "true"); vi.stubEnv("SIGNUP_EMAIL_ALLOWLIST", ""); expect(signupAllowed(owner.email)).toBe(false); vi.stubEnv("SIGNUP_EMAIL_ALLOWLIST", owner.email.toUpperCase()); expect(signupAllowed(owner.email)).toBe(true); expect(signupAllowed(`other${owner.email}`)).toBe(false); });
  it("activates an invited account once", async () => { vi.stubEnv("BETA_MODE", "true"); await db().betaAccess.update({ where: { userId: owner.id }, data: { status: "invited", activatedAt: null } }); const access = await betaAccess(owner.id); expect(access?.status).toBe("active"); expect((await betaAccess(owner.id))?.activatedAt).toEqual(access?.activatedAt); });
  it("grants allowlisted existing accounts and keeps revocations authoritative", async () => { vi.stubEnv("BETA_MODE", "true"); vi.stubEnv("SIGNUP_EMAIL_ALLOWLIST", owner.email); await db().betaAccess.delete({ where: { userId: owner.id } }); expect((await betaAccess(owner.id))?.source).toBe("allowlist"); await db().betaAccess.update({ where: { userId: owner.id }, data: { status: "revoked" } }); await expect(betaAccess(owner.id)).rejects.toThrow(/beta access/); });
  it("blocks a non-beta authenticated user at the API and entitlement boundaries", async () => { vi.stubEnv("BETA_MODE", "true"); await db().betaAccess.delete({ where: { userId: owner.id } }); expect((await courses(request("/api/student/courses"))).status).toBe(403); await expect(getUserEntitlements(owner.id)).rejects.toThrow(/beta access/); });
  it("keeps privacy settings available after beta revocation", async () => { vi.stubEnv("BETA_MODE", "true"); await db().betaAccess.update({ where: { userId: owner.id }, data: { status: "revoked" } }); expect((await api(request("/api/student/product-analytics"), async () => ({ ok: true }), false)).status).toBe(200); });
  it("applies stable cohort vetoes and never overrides a global veto", async () => { vi.stubEnv("BETA_MODE", "true"); await db().betaAccess.update({ where: { userId: owner.id }, data: { cohort: "core" } }); vi.stubEnv("ENTITLEMENT_FEATURE_FLAGS_JSON", '{"integration.calendar":true,"ai.tutor":false}'); const a = await getUserEntitlements(owner.id); expect(a.values["integration.calendar"]).toBe(false); expect(a.values["ai.tutor"]).toBe(false); expect((await getUserEntitlements(owner.id)).values).toEqual(a.values); });
  it("restricts new billing to paid-pilot without confusing paid plans and admins", async () => { vi.stubEnv("BETA_MODE", "true"); await expect(assertBetaBilling(owner.id)).rejects.toThrow(); await db().betaAccess.update({ where: { userId: owner.id }, data: { cohort: "paid-pilot" } }); await assertBetaBilling(owner.id); await setUserPlan(owner.id, "pro"); await expect(assertBetaAdmin(owner.id)).rejects.toThrow(); });
  it("protects internal aggregate routes from ordinary and anonymous users", async () => { expect((await internalMetrics(request("/api/internal/beta"))).status).toBe(403); expect((await internalMetrics(new Request(base + "/api/internal/beta"))).status).toBe(401); await expect(listPrivateFeedback(owner.id)).rejects.toThrow(); });
});

describe("safe analytics delivery", () => {
  it.each(["prompt", "response", "document", "resume", "email", "oauthToken", "billing", "comment", "mastery"])("rejects arbitrary %s properties", field => { expect(() => parseEvent("course_created", { [field]: "PRIVATE" })).toThrow(); });
  it("rejects unknown events, forged server events and unsafe identifiers", () => { expect(() => parseEvent("random_event")).toThrow(); expect(() => parseEvent("agent_used", { agentId: "private-topic" })).toThrow(); expect(clientEventSchema.safeParse({ event: "subscription_started", eventId: randomUUID() }).success).toBe(false); });
  it("deduplicates stable server IDs across retries", async () => { for (let i = 0; i < 8; i++) trackProductEvent(owner.id, "course_created", {}, "course-1"); expect(await events()).toHaveLength(1); });
  it("uses pseudonymous identity for adapters with no user names or emails", async () => { vi.stubEnv("PRODUCT_ANALYTICS_PROVIDER", "console"); const output = vi.spyOn(console, "info").mockImplementation(() => {}); trackProductEvent(owner.id, "course_created"); await flushProductAnalytics(); const text = JSON.stringify(output.mock.calls); expect(text).toContain("anonymousId"); expect(text).not.toContain(owner.id); expect(text).not.toContain(owner.email); expect(text).not.toContain("Beta fixture"); });
  it("separates environment IDs and forbids deployed console adapters", async () => { trackProductEvent(owner.id, "course_created", {}, "same"); await flushProductAnalytics(); vi.stubEnv("APP_ENV", "staging"); trackProductEvent(owner.id, "course_created", {}, "same"); const rows = await events(); expect(new Set(rows.map(e => e.environment))).toEqual(new Set(["test", "staging"])); vi.stubEnv("PRODUCT_ANALYTICS_PROVIDER", "console"); expect(analyticsConfig).toThrow(); });
  it("can disable collection globally or per user and removes stored behavior on opt-out", async () => { trackProductEvent(owner.id, "course_created"); await flushProductAnalytics(); await setAnalyticsPreference(owner.id, true); trackProductEvent(owner.id, "quiz_completed"); expect(await events()).toHaveLength(0); vi.stubEnv("PRODUCT_ANALYTICS_ENABLED", "false"); trackProductEvent(other.id, "course_created"); expect(await events(other.id)).toHaveLength(0); });
  it("excludes internal users even when previously tracked", async () => { await db().betaAccess.update({ where: { userId: owner.id }, data: { internal: true } }); trackProductEvent(owner.id, "course_created"); trackProductEvent(admin.id, "course_created"); expect(await events()).toHaveLength(0); expect(await events(admin.id)).toHaveLength(0); });
  it("contains storage and adapter failures without breaking a product response", async () => { const before = deliveryHealth().dropped; vi.spyOn(DatabaseAnalytics.prototype, "track").mockRejectedValue(new Error("private connection details")); const response = await api(request("/api/student/profile", "PUT", {}), async () => ({ saved: true }), false); expect(response.status).toBe(200); await flushProductAnalytics(); expect(deliveryHealth().dropped).toBeGreaterThan(before); vi.stubEnv("PRODUCT_ANALYTICS_PROVIDER", "console"); vi.spyOn(ConsoleAnalytics.prototype, "track").mockRejectedValue(new Error("provider down")); expect(() => trackProductEvent(owner.id, "course_created")).not.toThrow(); await flushProductAnalytics(); });
  it("bounds queued events during a provider outage", async () => { let release!: () => void; const wait = new Promise<void>(resolve => { release = resolve; }); vi.stubEnv("PRODUCT_ANALYTICS_PROVIDER", "console"); vi.spyOn(ConsoleAnalytics.prototype, "identify").mockResolvedValue(); vi.spyOn(ConsoleAnalytics.prototype, "track").mockImplementation(async () => wait); for (let i = 0; i < 520; i++) trackProductEvent(owner.id, "course_created"); expect(deliveryHealth().queued).toBeLessThanOrEqual(500); expect(deliveryHealth().inFlight).toBeLessThanOrEqual(4); release(); await flushProductAnalytics(); });
  it("fences concurrent event delivery against opt-out", async () => { for (let i = 0; i < 25; i++) trackProductEvent(owner.id, "course_created"); await setAnalyticsPreference(owner.id, true); await flushProductAnalytics(); expect(await db().productEvent.count({ where: { userId: owner.id } })).toBe(0); });
  it("correlates safe feature failures without logging raw errors or mislabeling validation as outages", async () => { const response = await api(request("/api/student/assistant/requests", "POST", {}), async () => { throw new RequestError("Private prompt content", 400); }); expect(response.status).toBe(400); const rows = await events(); expect(rows[0].properties).toMatchObject({ feature: "assistant", errorCode: "INVALID_REQUEST" }); expect(JSON.stringify(rows)).not.toContain("Private prompt"); });
});

describe("real product event boundaries", () => {
  it("tracks successful onboarding and course creation without academic fields", async () => {
    const res = await profile(request("/api/student/profile", "PUT", { name: "Private name", school: "Private school", program: "Math", currentYear: 1, semester: "Fall", academicGoal: "Private goal", studySessionMinutes: 45, explanationDifficulty: "INTERMEDIATE", timezone: "UTC" })); expect(res.status).toBe(200);
    const created = await createCourse(request("/api/student/courses", "POST", { courseCode: "MATH", courseName: "Private course", semester: "Fall", professor: "Private professor", description: "Private content" })); expect(created.status).toBe(200);
    const rows = await events(); expect(rows.map(e => e.name)).toEqual(["onboarding_completed", "course_created"]); expect(JSON.stringify(rows)).not.toContain("Private");
  });
  it("tracks uploads from safe response IDs only and ignores failed/streaming responses", async () => { trackApiSuccess(owner.id, request("/api/student/documents", "POST", {}), { id: "doc-safe", title: "private", contents: "private" }); trackApiSuccess(owner.id, request("/api/student/documents", "POST", {}), new Response("private", { status: 400 })); expect((await events()).map(e => e.name)).toEqual(["document_uploaded"]); });
  it("emits document_ready after the real processor commits with mocked embeddings", async () => {
    const document = await uploadDocument(owner.id, { title: "Private document" }, "private.txt", Buffer.from("Mathematical induction consists of a base case and an inductive step. ".repeat(20)));
    await processNextDocument({ id: RAG_EMBEDDING.id, generateEmbedding: async () => Array.from({ length: 384 }, (_, i) => i === 0 ? 1 : 0) }, document.id);
    expect((await db().document.findUniqueOrThrow({ where: { id: document.id } })).processingStatus).toBe("READY");
    expect((await events()).map(e => e.name)).toContain("document_ready"); expect(JSON.stringify(await events())).not.toContain("Private document");
  });
  it("emits quiz start/completion once when objective grading succeeds", async () => {
    const quiz = await db().quiz.create({ data: { userId: owner.id, title: "Private quiz", difficulty: "EASY", questions: { create: { position: 0, type: "TRUE_FALSE", prompt: "Private question", correctAnswer: "true", explanation: "Private reason" } } }, include: { questions: true } });
    const service = new QuizAgentService(createStudentAgentRegistry());
    const answer = await service.evaluateAnswer({ quizId: quiz.id, questionId: quiz.questions[0].id, userAnswer: "true" }, owner.headers);
    await service.evaluateAnswer({ quizId: quiz.id, questionId: quiz.questions[0].id, userAnswer: "true", quizAttemptId: answer.quizAttemptId }, owner.headers);
    // Both events can share a millisecond; concurrent delivery has no SQL tie order.
    expect((await events()).map(e => e.name).sort()).toEqual(["quiz_completed", "quiz_started"]);
  });
  it("tracks billing only after provider-confirmed persistence, deduplicating webhook replay", async () => {
    const suffix = randomUUID(), customerId = `cus_${suffix}`, subscriptionId = `sub_${suffix}`, checkoutId = `cs_${suffix}`;
    const billingEnv = { BILLING_ENABLED: "true", BILLING_ENVIRONMENT: "development", BILLING_MODE: "test", STRIPE_SECRET_KEY: "sk_test_fixture", STRIPE_WEBHOOK_SECRET: "whsec_fixture", STRIPE_PORTAL_CONFIGURATION_ID: "bpc_fixture", BILLING_PRICES_JSON: '{"student":{"monthly":"price_fixture"}}' };
    for (const [key, value] of Object.entries(billingEnv)) vi.stubEnv(key, value);
    const subscription: ProviderSubscription = { id: subscriptionId, customerId, priceId: "price_fixture", itemId: "si_fixture", createdAt: new Date(), status: "active", periodStart: new Date(), periodEnd: new Date(Date.now() + 30 * 86400000), cancelAtPeriodEnd: false, trialEnd: null, delinquentSince: null, live: false, pending: null };
    const provider = { createCustomer: async () => customerId, price: async () => ({ id: "price_fixture", productId: "prod_fixture", active: true, amount: 1000, currency: "usd", interval: "monthly", live: false }), subscriptionIds: async () => [], checkout: async () => ({ id: checkoutId, url: "https://checkout.stripe.com/fixture" }), subscription: async () => subscription } as unknown as BillingProvider;
    await createCheckoutSession(owner.id, { planCode: "student", billingInterval: "monthly" }, provider);
    expect((await events()).map(e => e.name)).toEqual(["checkout_started"]);
    const event = { id: `evt_${suffix}`, type: "checkout.session.completed", live: false, subscriptionId, customerId, checkoutId, supported: true };
    try {
      await processBillingEvent(event, provider); await processBillingEvent(event, provider);
      expect((await events()).map(e => e.name)).toEqual(expect.arrayContaining(["checkout_completed", "subscription_started"]));
      expect((await events()).filter(e => e.name === "subscription_started")).toHaveLength(1);
      // Enabling analytics for an existing subscriber must not invent a new conversion.
      await db().productEvent.deleteMany({ where: { userId: owner.id } });
      await syncSubscriptionFromProvider(subscriptionId, provider, owner.id);
      expect(await events()).toHaveLength(0);
      subscription.status = "cancelled";
      await syncSubscriptionFromProvider(subscriptionId, provider, owner.id);
      await syncSubscriptionFromProvider(subscriptionId, provider, owner.id);
      expect((await events()).map(e => e.name)).toEqual(["subscription_cancelled"]);
    }
    finally { await db().billingWebhookEvent.deleteMany({ where: { providerEventId: event.id } }); }
  });
  it("tracks a real AgentExecutor result with a mocked external AI boundary", async () => { const provider = { generateText: vi.fn().mockResolvedValue({ text: "Private explanation", model: "fixture" }) } as unknown as AIProvider; const executor = new AgentExecutor(createStudentAgentRegistry(), { getProvider: () => provider }); await executor.execute({ agentId: "tutor", request: "Explain induction" }, owner.headers); const event = (await events()).find(e => e.name === "agent_used"); expect(event?.properties).toMatchObject({ agentId: "tutor", success: true }); expect(JSON.stringify(event)).not.toContain("Private explanation"); });
  it("tracks workflow starts, steps, waiting and completion from canonical transitions", async () => {
    const definition: WorkflowDefinition = { id: "exam-preparation", name: "Fixture", description: "Test", intents: [], maxSteps: 2, maxAgentCalls: 2, maxRetries: 0, maxDurationMs: 10000, failurePolicy: "fail-workflow", steps: [{ id: "one", agentId: "tutor", purpose: "Private description", outputKey: "one", input: () => ({ request: "Private question" }) }] };
    const engine = new WorkflowEngine(async () => ({ summary: "Private result" }), new ContextReadCache());
    const result = await engine.run(definition, { workflowId: "exam-preparation", goal: "Private request", examId: randomUUID() }, { goal: "Private goal", exam: { id: randomUUID(), title: "Private exam", date: "2099-01-01", topics: [] }, previousStepSummaries: [] } as never, owner.headers);
    expect(result.status).toBe("completed"); expect((await events()).map(e => e.name)).toEqual(expect.arrayContaining(["workflow_started", "workflow_step_completed", "workflow_completed"]));
    expect(JSON.stringify(await events())).not.toContain("Private");
  });
  it("validates recommendation ownership and deduplicates impressions and clicks", async () => {
    const recommendation = await db().recommendation.create({ data: { userId: owner.id, type: "WEAK_TOPIC", priority: "HIGH", priorityScore: 70, title: "Private weakness", message: "Private course", sourceType: "COURSE", sourceId: null, reasonCode: "WEAK_TOPIC", reasonData: {}, dedupeKey: randomUUID(), supersessionKey: randomUUID(), stateFingerprint: randomUUID(), recommendedAgentId: "tutor", actionPayload: {} } });
    for (let i = 0; i < 2; i++) { expect((await clientEvent(request("/api/student/product-analytics", "POST", { event: "recommendation_shown", eventId: randomUUID(), recommendationId: recommendation.id, page: "dashboard" }))).status).toBe(200); await startRecommendedAction(owner.id, recommendation.id); }
    expect((await clientEvent(request("/api/student/product-analytics", "POST", { event: "recommendation_shown", eventId: randomUUID(), recommendationId: recommendation.id }, other))).status).toBe(404);
    expect((await events()).map(e => e.name)).toEqual(["recommendation_shown", "recommendation_clicked"]);
    trackProductEvent(owner.id, "recommendation_clicked", recommendationProperties(owner.id, "unobserved"), "unobserved");
    await flushProductAnalytics();
    expect((await getBetaOverview(admin.id)).recommendations).toMatchObject({ shown: 1, clicked: 1, clickPercent: 100 });
  });
});

describe("private feedback and internal beta review", () => {
  it("creates private feedback idempotently without exporting its text", async () => { const input = feedback(); const a = await createProductFeedback(owner.id, input); expect(await createProductFeedback(owner.id, input)).toEqual(a); expect(await db().productFeedback.count({ where: { userId: owner.id } })).toBe(1); const event = (await events())[0]; expect(event.properties).toEqual({ feature: "assistant" }); expect(JSON.stringify(event)).not.toContain(input.message); expect((await listPrivateFeedback(admin.id)).some(f => f.id === a.id)).toBe(true); });
  it("validates optional survey and stores answers only as private content", async () => { const input = feedback({ category: "beta-survey", survey: { usefulness: 4, valuableFeature: "assistant", confusing: "private issue", weeklyValue: "private wish", willingnessToPay: "maybe", missing: "private wish" } }); await createProductFeedback(owner.id, input); expect((await events())[0].name).toBe("beta_survey_submitted"); expect(JSON.stringify(await events())).not.toContain("private wish"); await expect(createProductFeedback(owner.id, feedback({ category: "beta-survey" }))).rejects.toThrow(); });
  it("rejects foreign workflow/request correlation and frontend user IDs", async () => { const run = await db().workflowRun.create({ data: { userId: other.id, workflowId: "lecture-study", input: {}, context: {} } }); await expect(createProductFeedback(owner.id, feedback({ workflowRunId: run.id }))).rejects.toThrow(/not found/); await expect(createProductFeedback(owner.id, feedback({ requestId: randomUUID() }))).rejects.toThrow(/not found/); await expect(createProductFeedback(owner.id, feedback({ userId: other.id }))).rejects.toThrow(); });
  it("correlates existing AI feedback with usage model/tier without copying prompts", async () => {
    const requestId = randomUUID(), conversation = await db().conversation.create({ data: { userId: owner.id, title: "Private" } });
    const message = await db().conversationMessage.create({ data: { userId: owner.id, conversationId: conversation.id, role: "ASSISTANT", content: "Private answer", sequence: 1, tokenEstimate: 3, agentId: "tutor", requestId, metadata: { workspaceVisible: true } } });
    await db().aIUsageRecord.create({ data: { id: randomUUID(), userId: owner.id, conversationId: conversation.id, requestId, provider: "openai", model: "fixture", selectedTier: "BALANCED", agentId: "tutor", operationType: "text-generation", usageSource: "provider", latencyMs: 2, success: true } });
    await submitFeedback(owner.id, message.id, { rating: 1, reasonCode: "USEFUL", comment: "Private comment" });
    const summary = await getFeedbackSummary(admin.id); expect(summary.ai).toEqual(expect.arrayContaining([expect.objectContaining({ model: "fixture", tier: "BALANCED", positive: 1 })])); expect(JSON.stringify(await events())).not.toContain("Private");
  });
  it("shows one optional prompt after a meaningful workflow and honors dismissal", async () => { await db().workflowRun.create({ data: { userId: owner.id, workflowId: "lecture-study", input: {}, context: {}, status: "COMPLETED", completedAt: new Date() } }); expect((await feedbackPrompt(owner.id)).eligible).toBe(true); await dismissFeedbackPrompt(owner.id); expect((await feedbackPrompt(owner.id)).eligible).toBe(false); });
  it("supports P0–P3 triage only for explicit admins", async () => { const saved = await createProductFeedback(owner.id, feedback()); await expect(triageFeedback(owner.id, saved.id, { status: "reviewed", severity: "P0" })).rejects.toThrow(); await triageFeedback(admin.id, saved.id, { status: "reviewed", severity: "P0" }); expect((await getLaunchReadiness(admin.id)).blocked).toBe(true); await triageFeedback(admin.id, saved.id, { status: "resolved", severity: "P0" }); expect((await getLaunchReadiness(admin.id)).requiresOperatorReview).toBe(true); });
  it("calculates configurable activation and separates staging events", async () => { for (const name of ["onboarding_completed", "course_created", "ai_request_completed"] as const) trackProductEvent(owner.id, name); await flushProductAnalytics(); expect((await events()).map(e => e.name)).toEqual(expect.arrayContaining(["onboarding_completed", "course_created", "ai_request_completed"])); expect(await getActivationFunnel(admin.id)).toMatchObject({ activated: 1, definition: ["onboarding_completed", "course_created", "ai_request_completed"] }); vi.stubEnv("APP_ENV", "staging"); expect((await getActivationFunnel(admin.id)).activated).toBe(0); vi.stubEnv("APP_ENV", "test"); vi.stubEnv("PRODUCT_ACTIVATION_EVENTS_JSON", '["quiz_completed"]'); expect((await getActivationFunnel(admin.id)).activated).toBe(0); });
  it("measures exact D1/D7/D30 returns with mature cohorts and meaningful actions only", async () => {
    const now = new Date(); now.setUTCHours(12, 0, 0, 0); const day = (d: number) => new Date(now.getTime() - d * 86400000);
    await db().productEvent.createMany({ data: [31, 30, 24, 1].map(d => ({ userId: owner.id, environment: "test", name: "quiz_completed", properties: {}, dedupeKey: randomUUID(), createdAt: day(d) })) });
    const result = await getRetentionMetrics(admin.id); expect(result.cohorts.map(c => c.returned)).toEqual([1, 1, 1]); expect(DEFAULT_MEANINGFUL_EVENTS).not.toContain("plans_viewed");
  });
  it("measures workflow drop-off by step without loading workflow content", async () => { await db().workflowRun.create({ data: { userId: owner.id, workflowId: "lecture-study", status: "WAITING_FOR_INPUT", input: { prompt: "Private" }, context: {}, updatedAt: new Date(Date.now() - 4 * 86400000), steps: { create: [{ stepId: "notes", position: 0, agentId: "notes", status: "COMPLETED", attempts: 1 }, { stepId: "quiz", position: 1, agentId: "quiz", status: "PENDING" }] } } }); const result = await getWorkflowMetrics(admin.id); expect(result.workflows.find(w => w.workflowId === "lecture-study")?.abandoned).toBeGreaterThanOrEqual(1); expect(result.steps.find(s => s.workflowId === "lecture-study" && s.position === 0)?.completed).toBeGreaterThanOrEqual(1); expect(JSON.stringify(result)).not.toContain("Private"); });
  it("returns internal beta health and excludes QA users retroactively", async () => { trackProductEvent(owner.id, "quiz_completed"); await flushProductAnalytics(); const overview = await getBetaOverview(admin.id); expect(overview.activity.weeklyActive).toBe(1); expect(overview).toHaveProperty("reliability"); expect(overview).toHaveProperty("quality"); await db().betaAccess.update({ where: { userId: owner.id }, data: { internal: true } }); expect((await getBetaOverview(admin.id)).activity.weeklyActive).toBe(0); });
});
