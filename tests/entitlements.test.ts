import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { db } from "@/server/db/client";
import { auth } from "@/server/auth/config";
import { entitlementSchema, parseEntitlement, type PublicEntitlements } from "@/lib/entitlements/types";
import { DEVELOPMENT_PLANS } from "@/server/entitlements/config";
import { assertEntitlement, ensureDefaultSubscription, getUserEntitlements, getEntitlementLimit, hasEntitlement, publicPlanCatalog, removeEntitlementOverride, savePlan, setEntitlementOverride, setUserPlan, subscriptionIsEffective, usagePeriod } from "@/server/entitlements/service";
import { aiAllowances, checkAIUsageAllowance, publicUserEntitlements, readUsage } from "@/server/entitlements/usage";
import { assertResourceCreation, canRunBackgroundFeature } from "@/server/entitlements/resources";
import { OpenAIProvider } from "@/server/ai/providers/openai";
import { AI_DEFAULTS } from "@/server/ai/config";
import { createRoutedAIProvider } from "@/server/ai/routing/provider";
import { MODEL_IDS } from "@/server/ai/routing/catalog";
import { writeUsageRecord } from "@/server/ai/usage/records";
import { testGuards, testHealth } from "./guard-fixture";
import { createCourse, listCourses } from "@/server/services/academic";
import { originalFile, retryDocument, uploadDocument } from "@/server/documents/service";
import { replaceDocumentSource } from "@/server/documents/replacement";
import { storage } from "@/server/documents/storage/local";
import { textPdf, inductionPages } from "./fixtures/documents";
import { createIntegrationService } from "@/server/integrations/service";
import { IntegrationRegistry } from "@/server/integrations/registry";
import { GoogleIntegrationProvider, GOOGLE_SCOPES } from "@/server/integrations/google";
import { AesTokenEncryptionService } from "@/server/integrations/encryption";
import { WorkflowEngine } from "@/server/workflows/engine";
import { WorkflowService } from "@/server/workflows/service";
import { ContextReadCache } from "@/server/context/cache";
import { buildUserContext } from "@/server/context/builder";
import type { WorkflowContext, WorkflowDefinition } from "@/server/workflows/types";
import { executeBackgroundJob } from "@/server/jobs/executor";
import type { BackgroundJob } from "@/server/jobs/types";
import { saveExplicitMemory, retrieveRelevantMemories, listMemories } from "@/server/memory";
import * as entitlementRoute from "@/app/api/student/entitlements/route";
import { api } from "@/server/api";

let owner: { id: string; headers: Headers }, other: typeof owner;
const extraUsers: string[] = [];
async function actor() {
  const response = await auth().api.signUpEmail({ body: { name: "Entitlement Student", email: `entitlement-${randomUUID()}@example.test`, password: "Entitlements-test-passphrase-2026!" }, asResponse: true });
  expect(response.status).toBe(200);
  const { user } = await response.json() as { user: { id: string } };
  await db().profile.create({ data: { userId: user.id, school: "Test", program: "Math", currentYear: 1, semester: "Fall", academicGoal: "Learn", studySessionMinutes: 30, explanationDifficulty: "INTERMEDIATE", timezone: "UTC" } });
  return { id: user.id, headers: new Headers({ cookie: response.headers.getSetCookie().map(c => c.split(";")[0]).join("; "), origin: process.env.BETTER_AUTH_URL!, "content-type": "application/json" }) };
}
beforeAll(async () => { owner = await actor(); other = await actor(); });
beforeEach(async () => {
  const files = await db().document.findMany({ where: { userId: owner.id }, select: { storageKey: true } });
  for (const file of files) await storage.remove(file.storageKey).catch(() => {});
  await db().$transaction([
    db().document.deleteMany({ where: { userId: owner.id } }), db().workflowRun.deleteMany({ where: { userId: owner.id } }), db().course.deleteMany({ where: { userId: owner.id } }),
    db().connectedAccount.deleteMany({ where: { userId: owner.id } }), db().userMemory.deleteMany({ where: { userId: owner.id } }),
    db().userEntitlementOverride.deleteMany({ where: { userId: owner.id } }), db().entitlementUsageAdmission.deleteMany({ where: { userId: owner.id } }), db().aIUsageRecord.deleteMany({ where: { userId: owner.id } }),
  ]);
  await setUserPlan(owner.id, "free");
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
afterAll(async () => {
  if (owner) for (const file of await db().document.findMany({ where: { userId: owner.id }, select: { storageKey: true } })) await storage.remove(file.storageKey).catch(() => {});
  await db().user.deleteMany({ where: { id: { in: [owner?.id, other?.id, ...extraUsers].filter(Boolean) } } });
  await db().plan.deleteMany({ where: { code: { startsWith: "test-entitlement-" } } });
  await db().$disconnect();
});
const request = (actorValue = owner) => new Request("http://localhost:3000/api/student/entitlements", { headers: actorValue.headers });
const messages = [{ role: "user", content: "Explain mathematical induction carefully." }] as const;
function providerFixture() {
  const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    return Response.json({ id: randomUUID(), model: body.model, status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "The base case starts the proof; assume k, then establish k+1." }] }], usage: { input_tokens: 40, output_tokens: 30, total_tokens: 70 } });
  });
  const openai = new OpenAIProvider({ ...AI_DEFAULTS, apiKey: "mock-only" }, fetcher, { guards: testGuards() });
  const provider = createRoutedAIProvider({ providers: { openai }, embeddingProvider: openai, history: async () => [], health: testHealth() });
  return { provider, openai, fetcher, usageContext: { userId: owner.id, requestId: randomUUID(), agentId: "tutor" } };
}
async function usage(tokens: number, requestId: string = randomUUID(), createdAt = new Date()) {
  return writeUsageRecord({ id: randomUUID(), userId: owner.id, requestId, provider: "fixture", model: "fixture", operationType: "text-generation", inputTokens: tokens, outputTokens: 0, totalTokens: tokens, usageSource: "provider", estimatedCostUsd: null, pricingVersion: null, latencyMs: 1, success: true, createdAt });
}
const pdf = textPdf(inductionPages);
const course = () => createCourse(owner.id, { courseCode: randomUUID().slice(0, 8), courseName: "Math", semester: "Fall", description: "", professor: "" });
function workflow() {
  const examId = randomUUID();
  const definition: WorkflowDefinition = { id: "exam-preparation", name: "Fixture", description: "Test", intents: [], maxSteps: 1, maxAgentCalls: 1, maxRetries: 0, maxDurationMs: 300000, failurePolicy: "fail-workflow", steps: [{ id: "first", agentId: "tutor", purpose: "Review", outputKey: "review", input: () => ({ request: "Study" }) }] };
  const context: WorkflowContext = { courseId: "fixture", goal: "Study", exam: { id: examId, title: "Math", examDate: new Date().toISOString(), topics: [], daysRemaining: 1, course: { id: "fixture", courseCode: "MATH", courseName: "Math" } }, priorities: [], topics: [], studyPlanId: null, planCurrent: false, quizId: null, quizCurrent: false, quizMode: "practice", tutorTopic: null, targetTopics: [], previousStepSummaries: [] };
  return { definition, context };
}

describe.sequential("plans, subscription resolution and public security", () => {
  it("assigns a concrete default on signup and lazily backfills existing users", async () => {
    expect(await db().userSubscription.findUnique({ where: { userId: owner.id }, include: { plan: true } })).toMatchObject({ status: "active", plan: { code: "free" } });
    const id = randomUUID(); extraUsers.push(id);
    await db().user.create({ data: { id, name: "Legacy", email: `${id}@example.test` } });
    await Promise.all([ensureDefaultSubscription(id), ensureDefaultSubscription(id)]);
    expect(await db().userSubscription.count({ where: { userId: id } })).toBe(1);
  });
  it("honors a configured public default without permitting an internal default", async () => {
    const id = randomUUID(); extraUsers.push(id); await db().user.create({ data: { id, name: "Legacy", email: `${id}@example.test` } });
    vi.stubEnv("DEFAULT_PLAN_CODE", "student"); expect((await ensureDefaultSubscription(id)).plan.code).toBe("student");
    const second = randomUUID(); extraUsers.push(second); await db().user.create({ data: { id: second, name: "Legacy", email: `${second}@example.test` } });
    vi.stubEnv("DEFAULT_PLAN_CODE", "internal-unlimited"); await expect(ensureDefaultSubscription(second)).rejects.toThrow("public");
  });
  it.each(["free", "student", "pro"])("resolves the complete typed %s capability map", async code => {
    await setUserPlan(owner.id, code);
    expect((await getUserEntitlements(owner.id)).values).toEqual(DEVELOPMENT_PLANS.find(p => p.code === code)!.entitlements);
    expect(await hasEntitlement(owner.id, "ai.tutor")).toBe(true);
    expect(await getEntitlementLimit(owner.id, "ai.monthlyRequests")).toBeGreaterThan(0);
  });
  it("validates types, unknown keys and negative limits", () => {
    expect(() => parseEntitlement("ai.tutor", "true")).toThrow();
    expect(() => parseEntitlement("courses.max", -1)).toThrow();
    expect(() => parseEntitlement("ai.modelTier.max", "cheap-model-id")).toThrow();
    expect(() => entitlementSchema.parse({ ...DEVELOPMENT_PLANS[0].entitlements, unknown: true })).toThrow();
    expect(parseEntitlement("ai.monthlyTokens", null)).toBeNull();
  });
  it("supports new catalog codes without feature logic changes", async () => {
    await savePlan({ ...DEVELOPMENT_PLANS[0], code: "test-entitlement-custom", name: "Campus", entitlements: { ...DEVELOPMENT_PLANS[0].entitlements, "integration.calendar": false } });
    await setUserPlan(owner.id, "test-entitlement-custom");
    expect(await hasEntitlement(owner.id, "integration.calendar")).toBe(false);
  });
  it("applies typed overrides, ignores expired overrides and removes them immediately", async () => {
    await setEntitlementOverride(owner.id, "ai.tutor", false);
    await expect(assertEntitlement(owner.id, "ai.tutor")).rejects.toMatchObject({ code: "ENTITLEMENT_REQUIRED" });
    await setEntitlementOverride(owner.id, "ai.tutor", false, { expiresAt: new Date(0) });
    expect(await hasEntitlement(owner.id, "ai.tutor")).toBe(true);
    await setEntitlementOverride(owner.id, "courses.max", 0); expect(await getEntitlementLimit(owner.id, "courses.max")).toBe(0);
    await removeEntitlementOverride(owner.id, "courses.max"); expect(await getEntitlementLimit(owner.id, "courses.max")).toBe(50);
    await setEntitlementOverride(owner.id, "courses.max", null); expect(await getEntitlementLimit(owner.id, "courses.max")).toBeNull();
  });
  it("gives global disable flags final veto and does not let true flags grant denied access", async () => {
    await setEntitlementOverride(owner.id, "ai.quiz", true);
    vi.stubEnv("ENTITLEMENT_FEATURE_FLAGS_JSON", '{"ai.quiz":false,"ai.notes":true}');
    await expect(assertEntitlement(owner.id, "ai.quiz")).rejects.toMatchObject({ code: "ENTITLEMENT_FEATURE_DISABLED" });
    await setEntitlementOverride(owner.id, "ai.notes", false); expect(await hasEntitlement(owner.id, "ai.notes")).toBe(false);
    vi.stubEnv("ENTITLEMENT_FEATURE_FLAGS_JSON", "{}"); expect(await hasEntitlement(owner.id, "ai.quiz")).toBe(true);
  });
  it("applies upgrades/downgrades without stale cache and records significant changes", async () => {
    await setUserPlan(owner.id, "student"); expect(await getEntitlementLimit(owner.id, "ai.monthlyRequests")).toBe(4000);
    await setUserPlan(owner.id, "pro"); expect(await getEntitlementLimit(owner.id, "ai.monthlyRequests")).toBe(10000);
    await setUserPlan(owner.id, "free"); expect(await getEntitlementLimit(owner.id, "ai.monthlyRequests")).toBe(2000);
    expect(await db().entitlementEvent.count({ where: { userId: owner.id, type: "plan-changed" } })).toBeGreaterThanOrEqual(3);
  });
  it.each(["expired", "cancelled", "past-due"] as const)("falls back to base access for %s", async status => {
    await setUserPlan(owner.id, "pro", { status }); expect((await getUserEntitlements(owner.id)).plan.code).toBe("free");
  });
  it("supports trials, period end cancellation and bounded grace without billing", async () => {
    const past = new Date(Date.now() - 86400000), future = new Date(Date.now() + 86400000);
    await setUserPlan(owner.id, "pro", { status: "trialing", trialEndsAt: future }); expect((await getUserEntitlements(owner.id)).plan.code).toBe("pro");
    await setUserPlan(owner.id, "pro", { status: "trialing", trialEndsAt: past }); expect((await getUserEntitlements(owner.id)).plan.code).toBe("free");
    await setUserPlan(owner.id, "pro", { status: "past-due", graceUntil: future }); expect((await getUserEntitlements(owner.id)).plan.code).toBe("pro");
    await setUserPlan(owner.id, "pro", { currentPeriodStart: past, currentPeriodEnd: future, cancelAtPeriodEnd: true }); expect((await getUserEntitlements(owner.id)).plan.code).toBe("pro");
    expect(subscriptionIsEffective((await getUserEntitlements(owner.id)).subscription, new Date(future.getTime() + 1))).toBe(false);
  });
  it("uses valid subscription periods and deterministic UTC calendar fallbacks", async () => {
    const now = new Date("2026-09-21T10:00:00Z"), start = new Date("2026-09-10T00:00:00Z"), end = new Date("2026-10-10T00:00:00Z");
    expect(usagePeriod({ currentPeriodStart: start, currentPeriodEnd: end }, now)).toEqual({ start, end });
    expect(usagePeriod({ currentPeriodStart: null, currentPeriodEnd: null }, now)).toEqual({ start: new Date("2026-09-01Z"), end: new Date("2026-10-01Z") });
    await expect(setUserPlan(owner.id, "pro", { currentPeriodStart: end, currentPeriodEnd: start })).rejects.toThrow();
  });
  it("returns a frontend-safe owner-only view and exposes no subscription mutation route", async () => {
    await setUserPlan(other.id, "pro");
    const response = await entitlementRoute.GET(new Request(`http://localhost:3000/api/student/entitlements?userId=${other.id}&planId=internal-unlimited`, { headers: owner.headers }));
    expect(response.status).toBe(200); const body = await response.json() as PublicEntitlements;
    expect(body.plan.code).toBe("free"); expect(body).not.toHaveProperty("subscription"); expect(body).not.toHaveProperty("userId"); expect(body).not.toHaveProperty("overrides");
    expect(body.usage).not.toHaveProperty("aiTokens"); expect(body.usage).not.toHaveProperty("estimatedCostUsd");
    expect(Object.keys(entitlementRoute).sort()).toEqual(["GET", "dynamic"]);
    expect((await entitlementRoute.GET(new Request("http://localhost:3000/api/student/entitlements"))).status).toBe(401);
    expect((await getUserEntitlements(other.id)).plan.code).toBe("pro");
  });
  it("keeps the internal plan out of public catalog and allows it only through trusted service", async () => {
    expect((await publicPlanCatalog()).some(p => p.code === "internal-unlimited")).toBe(false);
    await setUserPlan(owner.id, "internal-unlimited"); expect(await getEntitlementLimit(owner.id, "ai.monthlyTokens")).toBeNull();
  });
  it("performs no network/LLM calls for entitlement resolution or allowance decisions", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch");
    await publicPlanCatalog(); await publicUserEntitlements(owner.id); await checkAIUsageAllowance(owner.id);
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe.sequential("usage admission, AI enforcement and quality protection", () => {
  it("counts logical requests once across provider attempts and all actual tokens", async () => {
    await usage(40, "same"); await usage(60, "same"); await usage(100, "other");
    expect(await readUsage(await getUserEntitlements(owner.id))).toMatchObject({ aiRequests: 2, aiTokens: 200 });
    await setEntitlementOverride(owner.id, "ai.monthlyRequests", 2);
    await expect(checkAIUsageAllowance(owner.id, { requestId: "new" })).rejects.toMatchObject({ code: "PLAN_USAGE_EXHAUSTED" });
    await expect(checkAIUsageAllowance(owner.id, { requestId: "same" })).resolves.toBeDefined();
  });
  it("ignores old usage and respects the current period", async () => {
    await usage(99999, "old", new Date("2020-01-01")); await setEntitlementOverride(owner.id, "ai.monthlyTokens", 100);
    await expect(checkAIUsageAllowance(owner.id, {}, 90)).resolves.toBeDefined();
  });
  it("reserves concurrent capacity atomically and avoids double counting settled attempts", async () => {
    await setEntitlementOverride(owner.id, "ai.monthlyRequests", 1);
    const outcomes = await Promise.allSettled([aiAllowances.reserve({ userId: owner.id, requestId: "one" }, 100, randomUUID()), aiAllowances.reserve({ userId: owner.id, requestId: "two" }, 100, randomUUID())]);
    expect(outcomes.filter(r => r.status === "fulfilled")).toHaveLength(1);
    for (const result of outcomes) if (result.status === "fulfilled") await result.value.release();
    const f = providerFixture(); await f.provider.generateText({ messages, usageContext: f.usageContext, maxOutputTokens: 100 });
    expect(await readUsage(await getUserEntitlements(owner.id))).toMatchObject({ aiRequests: 1, aiTokens: 70 });
    expect(await db().entitlementUsageAdmission.count({ where: { userId: owner.id, kind: "ai" } })).toBe(0);
  });
  it("reserves tokens across concurrent calls sharing one logical request", async () => {
    await setEntitlementOverride(owner.id, "ai.monthlyTokens", 150);
    const results = await Promise.allSettled([aiAllowances.reserve({ userId: owner.id, requestId: "same" }, 100, randomUUID()), aiAllowances.reserve({ userId: owner.id, requestId: "same" }, 100, randomUUID())]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
  });
  it("blocks a denied agent at the provider boundary before transport or usage records", async () => {
    await setEntitlementOverride(owner.id, "ai.tutor", false); const f = providerFixture();
    await expect(f.provider.generateText({ messages, usageContext: f.usageContext })).rejects.toMatchObject({ code: "ENTITLEMENT_REQUIRED" });
    await expect(f.openai.generateText({ messages, usageContext: f.usageContext })).rejects.toMatchObject({ code: "ENTITLEMENT_REQUIRED" });
    expect(f.fetcher).not.toHaveBeenCalled(); expect(await db().aIUsageRecord.count({ where: { userId: owner.id } })).toBe(0);
  });
  it("rejects exhausted allowances with safe actionable API errors", async () => {
    await setEntitlementOverride(owner.id, "ai.monthlyTokens", 10); const f = providerFixture();
    const response = await api(request(), () => f.provider.generateText({ messages, usageContext: f.usageContext, maxOutputTokens: 100 }));
    expect(response.status).toBe(429); expect(await response.json()).toMatchObject({ code: "PLAN_USAGE_EXHAUSTED", plansUrl: "/plans" }); expect(f.fetcher).not.toHaveBeenCalled();
  });
  it("never lowers a task quality floor to fit the maximum plan tier", async () => {
    await setEntitlementOverride(owner.id, "ai.modelTier.max", "BALANCED"); const f = providerFixture();
    await expect(f.provider.generateText({ messages, usageContext: f.usageContext, routing: { signals: { proof: true } } })).rejects.toMatchObject({ code: "PLAN_MODEL_QUALITY_CONFLICT" });
    expect(f.fetcher).not.toHaveBeenCalled();
    await setEntitlementOverride(owner.id, "ai.modelTier.max", "STRONG");
    await f.provider.generateText({ messages, usageContext: f.usageContext, routing: { signals: { proof: true } }, maxOutputTokens: 100 });
    expect(JSON.parse(String(f.fetcher.mock.calls[0][1]?.body))).toMatchObject({ model: MODEL_IDS.strong, input: messages, max_output_tokens: 100 });
  });
  it("near-quota execution preserves messages, required model and output budget", async () => {
    await setEntitlementOverride(owner.id, "ai.monthlyTokens", 1100); await usage(900); const f = providerFixture();
    await f.provider.generateText({ messages, usageContext: f.usageContext, maxOutputTokens: 100, routing: { signals: { proof: true } } });
    expect(JSON.parse(String(f.fetcher.mock.calls[0][1]?.body))).toMatchObject({ model: MODEL_IDS.strong, input: messages, max_output_tokens: 100 });
  });
  it("checks access before Context Builder can retrieve documents", async () => {
    await setEntitlementOverride(owner.id, "ai.notes", false);
    await expect(buildUserContext({ request: "Notes", options: { documents: true } }, owner.headers, undefined, { agentId: "notes" })).rejects.toMatchObject({ code: "ENTITLEMENT_REQUIRED" });
  });
});

describe.sequential("resource limits and non-destructive lifecycle", () => {
  it("serializes course creation and preserves existing courses after downgrade", async () => {
    await setEntitlementOverride(owner.id, "courses.max", 1);
    const results = await Promise.allSettled([course(), course()]); expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    await setEntitlementOverride(owner.id, "academic.courses", false); expect(await listCourses(owner.id)).toHaveLength(1); await expect(course()).rejects.toMatchObject({ code: "ENTITLEMENT_REQUIRED" });
  });
  it("enforces stored document and file size caps before publication", async () => {
    await setEntitlementOverride(owner.id, "documents.maxFileBytes", 1);
    await expect(uploadDocument(owner.id, { title: "Math" }, "math.pdf", pdf)).rejects.toMatchObject({ code: "PLAN_USAGE_EXHAUSTED" });
    await removeEntitlementOverride(owner.id, "documents.maxFileBytes"); await setEntitlementOverride(owner.id, "documents.max", 1);
    const results = await Promise.allSettled([uploadDocument(owner.id, { title: "Math" }, "math.pdf", pdf), uploadDocument(owner.id, { title: "Logic" }, "logic.pdf", pdf)]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
  });
  it("counts retries/replacements as processing, never refunds quota by deleting files", async () => {
    await setEntitlementOverride(owner.id, "documents.monthlyProcessing", 1);
    const c = await course(), document = await uploadDocument(owner.id, { title: "Math", courseId: c.id }, "math.pdf", pdf);
    await db().document.update({ where: { id: document.id }, data: { processingStatus: "FAILED" } });
    await expect(retryDocument(owner.id, document.id)).rejects.toMatchObject({ code: "PLAN_USAGE_EXHAUSTED" });
    const embed = vi.fn();
    await expect(replaceDocumentSource({ userId: owner.id, documentId: document.id, courseId: c.id, bytes: pdf, fileName: "new.pdf" }, { guard: async () => {}, complete: async () => {}, provider: { generateEmbedding: embed, id: "fixture" } })).rejects.toMatchObject({ code: "PLAN_USAGE_EXHAUSTED" });
    expect(embed).not.toHaveBeenCalled();
    const saved = await db().document.delete({ where: { id: document.id } }); await storage.remove(saved.storageKey);
    await expect(uploadDocument(owner.id, { title: "New" }, "new.pdf", pdf)).rejects.toMatchObject({ code: "PLAN_USAGE_EXHAUSTED" });
  });
  it("keeps original files readable when document access is removed", async () => {
    const document = await uploadDocument(owner.id, { title: "Math" }, "math.pdf", pdf);
    await setEntitlementOverride(owner.id, "academic.documents", false);
    expect((await originalFile(owner.id, document.id)).bytes).toEqual(pdf);
    await expect(uploadDocument(owner.id, { title: "New" }, "new.pdf", pdf)).rejects.toMatchObject({ code: "ENTITLEMENT_REQUIRED" });
    await expect(originalFile(other.id, document.id)).rejects.toThrow();
  });
  it("caps active memories and preserves read/archive history on downgrade", async () => {
    await setEntitlementOverride(owner.id, "memory.maxActive", 1);
    await saveExplicitMemory({ category: "user-defined", key: "study-note", value: "I prefer short examples" }, owner.headers, { embeddingProvider: null });
    await expect(saveExplicitMemory({ category: "user-defined", key: "second-note", value: "Use induction" }, owner.headers, { embeddingProvider: null })).rejects.toMatchObject({ code: "PLAN_USAGE_EXHAUSTED" });
    await setEntitlementOverride(owner.id, "personalization.memory", false);
    expect(await retrieveRelevantMemories({ userId: owner.id, request: "Study", categories: ["user-defined"] }, { embeddingProvider: null })).toEqual([]);
    expect(await listMemories({ status: "active" }, owner.headers)).toHaveLength(1);
    await setEntitlementOverride(owner.id, "personalization.memory", true); expect(await listMemories({ status: "active" }, owner.headers)).toHaveLength(1);
  });
  it("checks workflow quota atomically and rejects starts before provider/context work", async () => {
    await setEntitlementOverride(owner.id, "workflow.monthlyRuns", 1);
    const execute = vi.fn(async () => ({ summary: "Done" })), engine = new WorkflowEngine(execute, new ContextReadCache());
    const a = workflow(), b = workflow();
    const results = await Promise.allSettled([engine.run(a.definition, { workflowId: "exam-preparation", goal: "Study" }, a.context, owner.headers), engine.run(b.definition, { workflowId: "exam-preparation", goal: "Study" }, b.context, owner.headers)]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1); expect(execute).toHaveBeenCalledTimes(1);
    const getProvider = vi.fn();
    await expect(new WorkflowService({ getProvider }).runWorkflow({ workflowId: "exam-preparation", goal: "Make a plan" }, owner.headers)).rejects.toMatchObject({ code: "PLAN_USAGE_EXHAUSTED" });
    expect(getProvider).not.toHaveBeenCalled();
  });
  it("preserves connected accounts but denies premium sync and re-enables on upgrade", async () => {
    const service = createIntegrationService();
    const account = await db().connectedAccount.create({ data: { userId: owner.id, provider: "google", providerAccountId: randomUUID(), scopes: [...GOOGLE_SCOPES["calendar-read"]], status: "ACTIVE", accessTokenEncrypted: "preserved-ciphertext" } });
    await setEntitlementOverride(owner.id, "integration.calendar", false);
    const send = vi.fn();
    await expect(service.withProviderClient({ userId: owner.id, connectedAccountId: account.id, provider: "google", capability: "calendar-read" }, send)).rejects.toMatchObject({ code: "ENTITLEMENT_REQUIRED" });
    expect(send).not.toHaveBeenCalled(); expect((await db().connectedAccount.findUniqueOrThrow({ where: { id: account.id } })).accessTokenEncrypted).toBe("preserved-ciphertext");
    expect((await service.getConnectedAccount(owner.id, account.id)).status).toBe("connected");
    await removeEntitlementOverride(owner.id, "integration.calendar"); await service.assertProviderAccess(owner.id, account.id, "calendar-read", "google");
    await expect(service.assertProviderAccess(other.id, account.id, "calendar-read", "google")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
  it("enforces account slots and capability access before starting OAuth", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const registry = new IntegrationRegistry().register(new GoogleIntegrationProvider(fetcher, () => ({ clientId: "test", clientSecret: "test" })));
    const service = createIntegrationService({ registry, encryption: () => new AesTokenEncryptionService({ v1: Buffer.alloc(32, 1).toString("base64") }, "v1") });
    await setEntitlementOverride(owner.id, "integrations.maxAccounts", 0);
    await expect(service.startIntegrationConnection({ provider: "google" }, owner.headers)).rejects.toMatchObject({ code: "PLAN_USAGE_EXHAUSTED" });
    await removeEntitlementOverride(owner.id, "integrations.maxAccounts"); await setEntitlementOverride(owner.id, "integration.drive", false);
    await expect(service.startIntegrationConnection({ provider: "google", capabilities: ["drive-read"] }, owner.headers)).rejects.toMatchObject({ code: "ENTITLEMENT_REQUIRED" });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("serializes account cap checks with inserts", async () => {
    await setEntitlementOverride(owner.id, "integrations.maxAccounts", 1);
    const create = () => db().$transaction(async tx => { await assertResourceCreation(owner.id, "account", tx); return tx.connectedAccount.create({ data: { userId: owner.id, provider: "google", providerAccountId: randomUUID() } }); });
    expect((await Promise.allSettled([create(), create()])).filter(r => r.status === "fulfilled")).toHaveLength(1);
  });
  it("skips disabled background premium work while allowing core maintenance", async () => {
    await setEntitlementOverride(owner.id, "automation.recommendations", false);
    const handler = vi.fn(async () => ({ refreshed: true }));
    const definition: BackgroundJob<{ version: number; userId: string; trackingId: string }> = { name: "refresh-user-recommendations", version: 1, payloadSchema: z.object({ version: z.number(), userId: z.string(), trackingId: z.string() }), retryPolicy: { limit: 0, delaySeconds: 1, maximumDelaySeconds: 1, exponentialBackoff: false }, timeoutSeconds: 30, priority: "normal", executionScope: "user", concurrency: { scope: "user", limit: 1 }, debounceSeconds: 0, handler };
    const run = await db().jobRun.create({ data: { userId: owner.id, jobName: definition.name, jobVersion: 1, queueJobId: randomUUID(), idempotencyKey: randomUUID() } });
    const result = await executeBackgroundJob(definition, { id: run.queueJobId!, name: definition.name, data: { version: 1, userId: owner.id, trackingId: run.id }, retryCount: 0, retryLimit: 0, signal: new AbortController().signal }, { logger: { info() {}, error() {} } });
    expect(result.output).toMatchObject({ skipped: true, reason: "ENTITLEMENT_REQUIRED" }); expect(handler).not.toHaveBeenCalled();
    expect(await canRunBackgroundFeature(owner.id, "cleanup-oauth-sessions")).toBe(true);
    expect(await db().jobRun.findUnique({ where: { id: run.id } })).toMatchObject({ status: "COMPLETED" });
  });
});

describe.sequential("policy transitions across in-flight and background work", () => {
  it("does not lose token reservations when usage persistence fails", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ id: randomUUID(), model: MODEL_IDS.baseline, status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "Answer" }] }], usage: { input_tokens: 40, output_tokens: 30, total_tokens: 70 } }));
    const provider = new OpenAIProvider({ ...AI_DEFAULTS, apiKey: "mock" }, fetcher, { guards: testGuards(), write: async () => { throw new Error("write unavailable"); } });
    await provider.generateText({ messages, usageContext: { userId: owner.id, requestId: randomUUID() }, maxOutputTokens: 100 });
    const pending = await db().entitlementUsageAdmission.findFirstOrThrow({ where: { userId: owner.id, kind: "ai" } });
    expect(pending.reservedTokens).toBeGreaterThan(100); expect(log).toHaveBeenCalled();
    await setEntitlementOverride(owner.id, "ai.monthlyTokens", pending.reservedTokens);
    await expect(checkAIUsageAllowance(owner.id)).rejects.toMatchObject({ code: "PLAN_USAGE_EXHAUSTED" });
  });
  it("rechecks a live workflow between steps and preserves committed output", async () => {
    const f = workflow();
    f.definition = { ...f.definition, maxSteps: 2, maxAgentCalls: 2, steps: [...f.definition.steps, { ...f.definition.steps[0], id: "second", outputKey: "second" }] };
    const execute = vi.fn(async () => { await setEntitlementOverride(owner.id, "workflow.exam-preparation", false); return { summary: "Saved first step", data: { saved: true } }; });
    const result = await new WorkflowEngine(execute, new ContextReadCache()).run(f.definition, { workflowId: "exam-preparation", goal: "Study" }, f.context, owner.headers);
    expect(result.status).toBe("failed"); expect(execute).toHaveBeenCalledTimes(1);
    const steps = await db().workflowStepRun.findMany({ where: { userId: owner.id, workflowRunId: result.runId } });
    expect(steps.find(s => s.stepId === "first")?.status).toBe("COMPLETED");
  });
  it("rejects resume after access expires without altering completed history", async () => {
    const f = workflow();
    const execute = vi.fn(async () => ({ summary: "Waiting for practice", waitForInput: { kind: "quiz" as const, referenceId: "saved-quiz" } }));
    const engine = new WorkflowEngine(execute, new ContextReadCache());
    const result = await engine.run(f.definition, { workflowId: "exam-preparation", goal: "Study" }, f.context, owner.headers);
    await setEntitlementOverride(owner.id, "workflow.exam-preparation", false);
    const prepare = vi.fn(async () => ({}));
    await expect(engine.resume(f.definition, result.runId, owner.headers, prepare)).rejects.toMatchObject({ code: "ENTITLEMENT_REQUIRED" });
    expect(prepare).not.toHaveBeenCalled(); expect((await engine.get(result.runId, owner.headers)).status).toBe("waiting-for-input");
  });
  it("keeps required learning evidence when the progress dashboard is locked", async () => {
    await setEntitlementOverride(owner.id, "academic.progress", false);
    const progress = await import("@/server/progress");
    await expect(progress.getStudentProgress(owner.id, owner.headers)).rejects.toMatchObject({ code: "ENTITLEMENT_REQUIRED" });
    const c = await course();
    await db().learningTopic.create({ data: { userId: owner.id, courseId: c.id, name: "Induction", normalizedName: "induction" } });
    const context = await buildUserContext({ request: "Plan learning", courseId: c.id, options: { learning: true } }, owner.headers, undefined, { agentId: "study-planner" });
    expect(context.metadata.requestedCategories).toContain("learning");
    expect(context.learning).toBeDefined();
  });
  it("rechecks memory access outside a reused Context Builder cache", async () => {
    await saveExplicitMemory({ category: "preference", key: "explanationStyle", value: "step-by-step" }, owner.headers, { embeddingProvider: null });
    const cache = new ContextReadCache(), input = { request: "Explain a proof", options: { memories: true } };
    const before = await buildUserContext(input, owner.headers, cache);
    expect(before.memories?.length).toBeGreaterThan(0);
    await setEntitlementOverride(owner.id, "personalization.memory", false);
    const after = await buildUserContext(input, owner.headers, cache);
    expect(after.memories).toBeUndefined(); expect(after.metadata.unavailableCategories).toContain("memories");
  });
  it("does not deliver new premium notifications or delete existing history", async () => {
    const { deliverUserNotifications, getNotifications } = await import("@/server/notifications");
    const row = await db().notification.create({ data: { userId: owner.id, type: "ASSIGNMENT_DUE", title: "Saved notice", message: "Saved notice", priority: "HIGH", scheduledFor: new Date(), deliveredAt: new Date(), status: "DELIVERED" } });
    await setEntitlementOverride(owner.id, "automation.notifications", false);
    expect(await deliverUserNotifications(owner.id)).toMatchObject({ attempted: 0, delivered: 0 });
    expect(JSON.stringify(await getNotifications({ userId: owner.id }))).toContain(row.id);
    expect(await db().notification.findUnique({ where: { id: row.id } })).toMatchObject({ status: "DELIVERED" });
  });
  it("skips system-scoped integration jobs using their owned resource identity", async () => {
    const { createExternalCourseSyncJob } = await import("@/server/jobs/sync-external-course");
    const { academicIntegrationService } = await import("@/server/academic-integrations/service");
    const account = await db().connectedAccount.create({ data: { userId: owner.id, provider: "fixture", providerAccountId: randomUUID() } });
    await setEntitlementOverride(owner.id, "integration.lms", false);
    const sync = vi.spyOn(academicIntegrationService, "syncExternalCourse");
    const result = await createExternalCourseSyncJob().handler({ payload: { version: 1, connectedAccountId: account.id, externalCourseId: "course" }, signal: new AbortController().signal, attempt: 1, jobRunId: "fixture" });
    expect(result).toMatchObject({ skipped: true, reason: "ENTITLEMENT_REQUIRED" }); expect(sync).not.toHaveBeenCalled();
  });
  it("applies calendar restriction before consulting cached events or an external source", async () => {
    const { createAvailabilityService } = await import("@/server/calendar/availability");
    await setEntitlementOverride(owner.id, "integration.calendar", false);
    const result = await createAvailabilityService()({ userId: owner.id, start: new Date(), end: new Date(Date.now() + 86400000) });
    expect(result.status).toBe("unavailable"); expect(result.assumptions.join(" ")).toContain("current access");
  });
  it("does not retry into a fallback tier excluded by the plan", async () => {
    await setEntitlementOverride(owner.id, "ai.modelTier.max", "STRONG");
    const f = providerFixture();
    f.fetcher.mockImplementation(async () => Response.json({ error: { message: "unavailable" } }, { status: 503 }));
    await expect(f.provider.generateText({ messages, usageContext: f.usageContext, maxOutputTokens: 100, routing: { signals: { proof: true } } })).rejects.toMatchObject({ code: "AI_SERVICE_TEMPORARILY_UNAVAILABLE" });
    expect(f.fetcher.mock.calls.every(([, init]) => JSON.parse(String(init?.body)).model === MODEL_IDS.strong)).toBe(true);
  });
});

describe.sequential("workflow replay allowance", () => {
  it("does not charge or execute an already active run twice at the period limit", async () => {
    await setEntitlementOverride(owner.id, "workflow.monthlyRuns", 1);
    const f = workflow();
    const execute = vi.fn(async () => ({ summary: "Complete the saved quiz", waitForInput: { kind: "quiz" as const, referenceId: "saved-quiz" } }));
    const engine = new WorkflowEngine(execute, new ContextReadCache());
    const first = await engine.run(f.definition, { workflowId: "exam-preparation", goal: "Study" }, f.context, owner.headers);
    const again = await engine.run(f.definition, { workflowId: "exam-preparation", goal: "Study" }, f.context, owner.headers);
    expect(again.runId).toBe(first.runId); expect(execute).toHaveBeenCalledTimes(1);
    expect((await readUsage(await getUserEntitlements(owner.id))).workflowRuns).toBe(1);
  });
});
