import "dotenv/config";
import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { operationsConfig, validateRuntimeConfiguration, signupAllowed } from "@/server/operations/config";
import { checkDatabase, checkReadiness, checkRuntimeStorage, migrationsReady, operationsAuthorized } from "@/server/operations/health";
import { redactMonitoringEvent, observeRequest, safeFields, safeRoute, initializeMonitoring, reportError, flushMonitoring } from "@/server/operations/monitoring";
import { captureUsageContext } from "@/server/ai/usage/context";
import { bootstrapPlans } from "@/server/operations/bootstrap";
import { DEVELOPMENT_PLANS } from "@/server/entitlements/config";
import { db } from "@/server/db/client";
import { startHeartbeat } from "@/server/operations/heartbeat";
import { GET as live } from "@/app/api/health/live/route";
import { GET as metrics } from "@/app/api/operations/metrics/route";
import { callbackUri } from "@/server/integrations/config";
import { createBackgroundJobBoss } from "@/server/jobs/client";
import { featureFlags } from "@/server/entitlements/config";
import { syncDevelopmentPlans } from "@/server/entitlements/service";
import { DEFAULT_MODEL_CATALOG } from "@/server/ai/routing/catalog";
import { billingConfig } from "@/server/billing/config";
import type { ErrorEvent } from "@sentry/node";
import { deploymentSmoke } from "../scripts/deployment-smoke.mjs";
import { parse } from "dotenv";
import { betaConfig } from "@/server/beta/config";
import { GuardrailService } from "@/server/ai/guardrails/service";

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
function deployed(environment = "production") {
  const values = { NODE_ENV: "production", APP_ENV: environment, APP_URL: "https://agency.example.com", BETTER_AUTH_URL: "https://agency.example.com",
    BETTER_AUTH_SECRET: "f128754ca9be37d065af1873d7046a83c047891c28ba568e96d", OPERATIONS_TOKEN: "25947afab50841c639b627e981dd260cef51265a037ba68d9", RELEASE_SHA: "test123456",
    DOCUMENT_STORAGE_PATH: "/data/documents", EMBEDDING_CACHE_PATH: "/data/models", EMBEDDING_ALLOW_DOWNLOAD: "false", BILLING_ENABLED: "false",
    ERROR_MONITORING_ENABLED: "false", AI_GUARDRAILS_JSON: '{"disableAllAI":true}', AI_ROUTING_OVERRIDE_JSON: "", AI_ROUTING_EVALUATION_MODE: "false" };
  for (const [key, value] of Object.entries(values)) vi.stubEnv(key, value);
}
describe("production environment boundaries", () => {
  it("ships a closed core beta preset without disabling document ingestion", async () => {
    const template = parse(await readFile("deploy/runtime.env.example", "utf8"));
    for (const key of ["BETA_MODE", "BETA_DEFAULT_COHORT", "BETA_COHORT_FLAGS_JSON", "ENTITLEMENT_FEATURE_FLAGS_JSON", "AI_GUARDRAILS_JSON", "BILLING_ENABLED", "BILLING_CHECKOUT_ENABLED"]) vi.stubEnv(key, template[key]);
    expect(betaConfig().enabled).toBe(true);
    expect(featureFlags()).toMatchObject({ "integration.calendar": false, "integration.drive": false, "integration.lms": false, "ai.career": false, "workflow.career-preparation": false });
    expect(featureFlags()["ai.tutor"]).not.toBe(false);
    expect(billingConfig().enabled).toBe(false);
    const guards = new GuardrailService();
    expect(() => guards.assertEnabled({ source: "rag-document", guardProfile: "BACKGROUND" })).not.toThrow();
    expect(() => guards.assertEnabled({ agentId: "tutor" })).not.toThrow();
    expect(() => guards.assertEnabled({ guardFeature: "evaluate-ai-response", guardProfile: "BACKGROUND" })).toThrow();
  });
  it("keeps development optional integrations optional", () => {
    vi.stubEnv("NODE_ENV", "development"); vi.stubEnv("APP_ENV", "development");
    expect(validateRuntimeConfiguration().deployed).toBe(false);
  });
  it("validates production and isolated staging", () => {
    deployed(); expect(validateRuntimeConfiguration().deployed).toBe(true);
    vi.stubEnv("APP_ENV", "staging"); expect(validateRuntimeConfiguration().APP_ENV).toBe("staging");
  });
  it.each(["APP_URL", "OPERATIONS_TOKEN", "DOCUMENT_STORAGE_PATH", "EMBEDDING_CACHE_PATH"])("fails closed without %s", key => {
    deployed(); vi.stubEnv(key, undefined); expect(() => validateRuntimeConfiguration()).toThrow();
  });
  it("requires provider credentials unless AI is explicitly disabled", () => {
    deployed(); vi.stubEnv("OPENAI_API_KEY", undefined); vi.stubEnv("AI_GUARDRAILS_JSON", "{}");
    expect(() => validateRuntimeConfiguration()).toThrow(/provider key/);
  });
  it("requires monitoring DSN when enabled", () => {
    deployed(); vi.stubEnv("ERROR_MONITORING_ENABLED", "true"); vi.stubEnv("SENTRY_DSN", undefined);
    expect(() => validateRuntimeConfiguration()).toThrow(/SENTRY_DSN/);
  });
  it("rejects downloads, evaluation overrides and HTTP in production", () => {
    deployed(); vi.stubEnv("EMBEDDING_ALLOW_DOWNLOAD", "true"); expect(() => validateRuntimeConfiguration()).toThrow(/Download/);
    vi.stubEnv("EMBEDDING_ALLOW_DOWNLOAD", "false"); vi.stubEnv("AI_ROUTING_EVALUATION_MODE", "true"); expect(() => validateRuntimeConfiguration()).toThrow(/overrides/);
    vi.stubEnv("AI_ROUTING_EVALUATION_MODE", "false"); vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3000"); expect(() => validateRuntimeConfiguration()).toThrow(/HTTPS/);
  });
  it("rejects disabled default and unreviewed models", () => {
    deployed(); vi.stubEnv("AI_GUARDRAILS_JSON", "{}"); vi.stubEnv("OPENAI_API_KEY", "test-only-key");
    vi.stubEnv("AI_MODEL_CATALOG_JSON", JSON.stringify(DEFAULT_MODEL_CATALOG.map(m => ({ ...m, enabled: false }))));
    expect(() => validateRuntimeConfiguration()).toThrow(/enabled/);
    vi.stubEnv("AI_MODEL_CATALOG_JSON", undefined); vi.stubEnv("APPROVED_AI_MODELS", "unreviewed");
    expect(() => validateRuntimeConfiguration()).toThrow(/reviewed/);
  });
  it("derives OAuth callbacks from one trusted canonical origin", () => {
    deployed(); expect(callbackUri("google")).toBe("https://agency.example.com/api/student/integrations/google/callback");
    vi.stubEnv("INTEGRATION_OAUTH_BASE_URL", "https://attacker.example.com"); expect(() => validateRuntimeConfiguration()).toThrow();
  });
  it("keeps live billing out of staging and test billing out of production", () => {
    deployed("staging");
    const billing = { BILLING_ENABLED: "true", BILLING_ENVIRONMENT: "staging", BILLING_MODE: "test", STRIPE_SECRET_KEY: "sk_test_synthetic", STRIPE_WEBHOOK_SECRET: "whsec_synthetic", STRIPE_PORTAL_CONFIGURATION_ID: "bpc_synthetic", BILLING_PRICES_JSON: '{"student":{"monthly":"price_synthetic"}}' };
    for (const [key, value] of Object.entries(billing)) vi.stubEnv(key, value);
    expect(validateRuntimeConfiguration().APP_ENV).toBe("staging");
    vi.stubEnv("APP_ENV", "production"); expect(() => validateRuntimeConfiguration()).toThrow(/Billing/);
    vi.stubEnv("BILLING_ENVIRONMENT", "production"); expect(() => billingConfig()).toThrow();
  });
  it("gates beta signup by exact allowlist and an emergency switch", () => {
    vi.stubEnv("SIGNUP_EMAIL_ALLOWLIST", "student@example.com");
    expect(signupAllowed("Student@example.com")).toBe(true); expect(signupAllowed("other@example.com")).toBe(false);
    vi.stubEnv("SIGNUP_ENABLED", "false"); expect(signupAllowed("student@example.com")).toBe(false);
  });
  it("uses existing feature vetoes", () => {
    vi.stubEnv("ENTITLEMENT_FEATURE_FLAGS_JSON", '{"integration.calendar":false,"ai.quiz":false}');
    expect(featureFlags()["ai.quiz"]).toBe(false);
  });
  it("forbids development plan sync in deployed environments", async () => {
    deployed(); await expect(syncDevelopmentPlans()).rejects.toThrow(/Development plans/);
  });
  it("bounds per-process connection pools", () => {
    vi.stubEnv("DATABASE_POOL_MAX", "1000"); expect(() => operationsConfig()).toThrow();
  });
});

describe("health and monitoring", () => {
  it("separates liveness from readiness without querying a provider", async () => {
    expect(await live().json()).toEqual({ status: "alive" });
    const database = vi.fn().mockResolvedValue(undefined), storage = vi.fn().mockResolvedValue(undefined);
    expect(await checkReadiness({ database, storage })).toBe(true);
    database.mockRejectedValue(new Error("private connection string"));
    expect(await checkReadiness({ database, storage })).toBe(false);
    expect(database).toHaveBeenCalledTimes(2);
  });
  it("accepts completed matching migrations and rejects partial/drifted schemas", () => {
    const expected = [{ name: "migration", checksum: "sha" }];
    const row = { migration_name: "migration", checksum: "sha", finished_at: new Date(), rolled_back_at: null };
    expect(migrationsReady(expected, [row])).toBe(true);
    expect(migrationsReady(expected, [{ ...row, checksum: "tampered" }])).toBe(false);
    expect(migrationsReady(expected, [{ ...row, finished_at: null }])).toBe(false);
    expect(migrationsReady(expected, [row, { ...row, migration_name: "next", finished_at: null }])).toBe(false);
  });
  it("checks the actual migrated database and private pinned-model storage", async () => {
    await expect(checkDatabase()).resolves.toBeUndefined();
    await expect(checkRuntimeStorage()).resolves.toBeUndefined();
  });
  it("requires a separate operations bearer token and hides metrics publicly", async () => {
    vi.stubEnv("OPERATIONS_TOKEN", "operations-32-character-test-secret");
    expect(operationsAuthorized(new Request("https://agency.example.com", { headers: { authorization: "Bearer operations-32-character-test-secret" } }))).toBe(true);
    expect(operationsAuthorized(new Request("https://agency.example.com?token=operations-32-character-test-secret"))).toBe(false);
    expect((await metrics(new Request("https://agency.example.com/api/operations/metrics"))).status).toBe(404);
  });
  it("redacts sensitive content including exception messages, stack context and headers", () => {
    const raw = { type: undefined, message: "prompt private", user: { email: "student@example.com" }, request: { headers: { authorization: "secret" }, data: "document" }, extra: { password: "secret" }, breadcrumbs: [{ message: "secret" }], tags: { requestId: "safe-id", token: "secret" }, exception: { values: [{ value: "private query", stacktrace: { frames: [{ filename: "/app/server/api.ts", lineno: 12, vars: { token: "secret" }, context_line: "secret" }, { filename: "/private/home/student.txt" }] } }] } } as ErrorEvent;
    const redacted = redactMonitoringEvent(raw);
    expect(redacted.tags).toEqual({ requestId: "safe-id" });
    expect(redacted.exception?.values?.[0]?.stacktrace?.frames).toEqual([{ filename: "server/api.ts", lineno: 12, colno: undefined, in_app: true }]);
    expect(JSON.stringify(redacted)).not.toMatch(/secret|student@|document|prompt private|private query|breadcrumbs|request"/);
    expect(safeFields({ userId: "private", prompt: "private", event: "safe-event" })).toEqual({ event: "safe-event" });
  });
  it("correlates a request through nested AI context and errors without accepting a spoofed ID", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const request = new Request("https://agency.example.com/api/student/documents/private-id?token=secret", { headers: { "X-Request-ID": "spoofed" } });
    let captured: string | undefined;
    const response = await observeRequest(request, async () => { captured = captureUsageContext({ agentId: "tutor" }).requestId; return new Response(null, { status: 401 }); });
    expect(response.headers.get("X-Request-ID")).toBe(captured);
    expect(captured).not.toBe("spoofed");
    expect(safeRoute(request)).toBe("/api/student/documents/[resource]");
  });
  it("records worker liveness and removes its lease on clean shutdown", async () => {
    const before = await db().runtimeHeartbeat.count();
    const stop = await startHeartbeat("jobs");
    expect(await db().runtimeHeartbeat.count()).toBe(before + 1);
    await stop(); expect(await db().runtimeHeartbeat.count()).toBe(before);
  });
  it("bootstraps only system plans idempotently without users", async () => {
    const code = `ops-${randomUUID().slice(0, 8)}`;
    vi.stubEnv("DEFAULT_PLAN_CODE", code);
    const plan = { ...DEVELOPMENT_PLANS[0], code };
    const users = await db().user.count();
    try {
      await bootstrapPlans([plan]); await bootstrapPlans([{ ...plan, name: "Reviewed beta" }]);
      expect(await db().plan.count({ where: { code } })).toBe(1);
      expect((await db().plan.findUnique({ where: { code } }))?.name).toBe("Reviewed beta");
      expect(await db().user.count()).toBe(users);
      await expect(bootstrapPlans([{ ...plan, internal: true }])).rejects.toThrow();
    } finally { await db().plan.deleteMany({ where: { code } }); }
  });
  it("constructs production workers without automatic migration or connection", () => {
    deployed(); const boss = createBackgroundJobBoss("worker"); expect(boss).toBeDefined();
  });
  it("ships persistent private volumes, draining and rollback instructions", async () => {
    const compose = await readFile("compose.production.yaml", "utf8");
    expect(compose).toContain("documents:/data/documents"); expect(compose).toContain("stop_grace_period: 40s");
    expect(compose).not.toContain("5432:5432");
    const runbook = await readFile("docs/production-operations.md", "utf8");
    expect(runbook).toContain("rollback"); expect(runbook).toContain("restore");
  });
  it("smoke checks are read-only and reject a failing dependency", async () => {
    const fetcher = vi.fn<typeof fetch>(async input => {
      const url = new URL(input instanceof Request ? input.url : input);
      const status = url.pathname === "/api/student/courses" ? 401 : url.pathname === "/api/operations/metrics" ? 404 : 200;
      return new Response("{}", { status, headers: { "content-security-policy": "default-src 'self'", "x-content-type-options": "nosniff" } });
    });
    expect((await deploymentSmoke({ origin: "https://staging.example.com", cookie: undefined, operationsToken: undefined, fetcher })).passed).toBe(5);
    expect(fetcher.mock.calls.every(([url]) => !String(url).includes("?"))).toBe(true);
    fetcher.mockImplementation(async () => new Response(null, { status: 503 }));
    await expect(deploymentSmoke({ origin: "https://staging.example.com", cookie: undefined, operationsToken: undefined, fetcher })).rejects.toThrow(/Smoke/);
  });
  it("sends a redacted real SDK envelope through a mocked transport", async () => {
    vi.stubEnv("ERROR_MONITORING_ENABLED", "true");
    vi.stubEnv("SENTRY_DSN", "https://public@example.test/1");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const envelopes: unknown[] = [];
    initializeMonitoring(() => ({ send: async envelope => { envelopes.push(envelope); return { statusCode: 200 }; }, flush: async () => true }));
    reportError(new Error("private-document-and-token"), { requestId: "verified-correlation-id", route: "/api/student/documents" });
    await flushMonitoring();
    expect(envelopes).toHaveLength(1);
    expect(JSON.stringify(envelopes)).toContain("verified-correlation-id");
    expect(JSON.stringify(envelopes)).not.toContain("private-document-and-token");
  });
});
