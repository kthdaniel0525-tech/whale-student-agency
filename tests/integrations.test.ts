import "dotenv/config";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { beforeAll, beforeEach, afterAll, afterEach, describe, it, expect, vi } from "vitest";
import { auth } from "@/server/auth/config";
import { db } from "@/server/db/client";
import * as ai from "@/server/ai";
import { AesTokenEncryptionService, credentialContext, getTokenEncryptionService } from "@/server/integrations/encryption";
import { GoogleIntegrationProvider, GOOGLE_SCOPES } from "@/server/integrations/google";
import { IntegrationRegistry } from "@/server/integrations/registry";
import { createIntegrationService, cleanupOAuthSessions } from "@/server/integrations/service";
import { createIntegrationHttpHandlers } from "@/server/integrations/http";
import { IntegrationError, safeIntegrationError } from "@/server/integrations/errors";
import { integrationOrigin } from "@/server/integrations/config";
import { cleanupOAuthSessionsJob } from "@/server/jobs/cleanup-oauth";
import { registerOAuthCleanupSchedule } from "@/server/jobs/schedule";
import { getBackgroundJob } from "@/server/jobs/registry";
import { executeBackgroundJob } from "@/server/jobs/executor";
import type { BackgroundJob } from "@/server/jobs/types";
import { normalizeBackgroundJobError } from "@/server/jobs/errors";
import type { IntegrationCapability } from "@/lib/student/integrations/types";
import { z } from "zod";
import nextConfig from "@/next.config";
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
const NOW = new Date("2026-09-18T20:00:00Z");
const secrets = { access: "secret-access-A", refresh: "secret-refresh-A", rotated: "secret-refresh-B", code: "secret-code", client: "secret-client" };
type Actor = { id: string; headers: Headers; email: string; password: string };
let owner: Actor, foreign: Actor;
async function actor() {
  const credentials = { email: `integration-${randomUUID()}@example.test`, password: "Integration-test-password-2026!" };
  const response = await auth().api.signUpEmail({ body: { name: "Integration student", ...credentials }, asResponse: true });
  expect(response.status).toBe(200); const { user } = await response.json() as { user: { id: string } };
  await db().profile.create({ data: { userId: user.id, school: "Test", program: "CS", currentYear: 1, semester: "Fall", academicGoal: "Learn", studySessionMinutes: 45, explanationDifficulty: "INTERMEDIATE", timezone: "UTC" } });
  return { id: user.id, ...credentials, headers: new Headers({ cookie: response.headers.getSetCookie().map((value) => value.split(";")[0]).join("; "), origin: "http://localhost:3000", "content-type": "application/json" }) };
}
function harness() {
  const key = randomBytes(32).toString("base64"); const crypto = new AesTokenEncryptionService({ v1: key }, "v1");
  const state = { identity: "google-sub-1", scopes: [...GOOGLE_SCOPES["account-profile"]], exchangeRefresh: true, refreshRotation: false,
    refreshError: "", identityFailure: false, revokeFailure: false, exchangeFailure: false,
    refreshHook: undefined as (() => Promise<void>) | undefined, identityHook: undefined as (() => Promise<void>) | undefined,
    readHook: undefined as (() => Promise<void>) | undefined, revokeHook: undefined as (() => Promise<void>) | undefined,
  };
  const http = vi.fn<typeof fetch>(async (resource, init) => {
    const url = String(resource); const body = new URLSearchParams(String(init?.body ?? ""));
    if (url === "https://oauth2.googleapis.com/token") {
      const refresh = body.get("grant_type") === "refresh_token";
      if (refresh) { await state.refreshHook?.(); if (state.refreshError) return Response.json({ error: state.refreshError, error_description: `${secrets.refresh} private` }, { status: state.refreshError === "invalid_grant" ? 400 : 503 }); }
      if (!refresh && state.exchangeFailure) return Response.json({ error: "failure", private: secrets.code }, { status: 503 });
      return Response.json({ access_token: refresh ? "secret-access-B" : secrets.access, token_type: "Bearer", expires_in: 3600,
        scope: state.scopes.join(" "), ...((refresh ? state.refreshRotation : state.exchangeRefresh) ? { refresh_token: refresh ? secrets.rotated : secrets.refresh } : {}) });
    }
    if (url === "https://openidconnect.googleapis.com/v1/userinfo") {
      await state.identityHook?.(); if (state.identityFailure) return Response.json({ private: secrets.access });
      return Response.json({ sub: state.identity, name: "Student", email: "student@example.test", email_verified: true });
    }
    if (url === "https://oauth2.googleapis.com/revoke") {
      await state.revokeHook?.();
      return state.revokeFailure ? Response.json({ error: "temporarily_unavailable", details: secrets.refresh }, { status: 503 }) : new Response(null, { status: 200 });
    }
    if (url.startsWith("https://www.googleapis.com/calendar/v3/")) { await state.readHook?.(); return Response.json({ items: [] }); }
    throw new Error(`Unexpected HTTP; ${secrets.access}`);
  });
  const provider = new GoogleIntegrationProvider(http, () => ({ clientId: "client-id", clientSecret: secrets.client }));
  const registry = new IntegrationRegistry().register(provider);
  const service = createIntegrationService({ registry, encryption: () => crypto });
  const routes = createIntegrationHttpHandlers(service);
  async function start(input: { capabilities?: IntegrationCapability[]; connectedAccountId?: string } = {}, user = owner) {
    const { authorizationUrl } = await service.startIntegrationConnection({ provider: "google", ...input }, user.headers);
    return new URL(authorizationUrl).searchParams.get("state")!;
  }
  async function connect(input: { capabilities?: IntegrationCapability[]; connectedAccountId?: string } = {}, user = owner) {
    return service.handleIntegrationCallback("google", { state: await start(input, user), code: secrets.code }, user.headers);
  }
  async function expire(id: string) { await db().connectedAccount.update({ where: { id }, data: { accessTokenExpiresAt: new Date(NOW.getTime() - 1000) } }); }
  const refreshCalls = () => http.mock.calls.filter(([resource, init]) => String(resource).endsWith("/token") && String(init?.body).includes("grant_type=refresh_token"));
  return { crypto, key, state, http, provider, registry, service, routes, start, connect, expire, refreshCalls };
}
let h: ReturnType<typeof harness>;
beforeAll(async () => { owner = await actor(); foreign = await actor(); });
beforeEach(async () => {
  for (const user of [owner, foreign]) {
    await db().oAuthConnectionSession.deleteMany({ where: { userId: user.id } });
    await db().connectedAccount.deleteMany({ where: { userId: user.id } });
    await db().jobRun.deleteMany({ where: { userId: user.id } });
  }
  h = harness(); vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOW);
  vi.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
afterAll(async () => { await db().user.deleteMany({ where: { id: { in: [owner.id, foreign.id] } } }); await db().$disconnect(); });
const req = (method: string, data?: unknown, user = owner) => new Request("http://localhost:3000/api/student/integrations/connect", { method, headers: user.headers, ...(data !== undefined ? { body: JSON.stringify(data) } : {}) });
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; };

describe.sequential("Integration OAuth foundation", () => {
  async function calendarConnection() {
    h.state.scopes.push(...GOOGLE_SCOPES["calendar-read"], ...GOOGLE_SCOPES["drive-read"]);
    const { account } = await h.connect({ capabilities: ["calendar-read", "drive-read"] });
    const read = () => h.service.withProviderClient({ userId: owner.id, connectedAccountId: account.id, provider: "google", capability: "calendar-read" }, client => client.read({ path: "calendars/primary/events" }));
    return { account, read };
  }
  it("refreshes a provider-rejected access token once and continues the original operation", async () => {
    const { account, read } = await calendarConnection();
    h.http.mockResolvedValueOnce(Response.json({ private: secrets.access }, { status: 401 }));
    expect(await read()).toEqual({ items: [] }); expect(h.refreshCalls()).toHaveLength(1);
    expect((await h.service.getConnectedAccount(owner.id, account.id)).health?.auth).toBe("healthy");
  });
  it("stops future calls after the refreshed token is also rejected", async () => {
    const { account, read } = await calendarConnection(); const original = h.http.getMockImplementation()!;
    h.http.mockImplementation(async (url, init) => String(url).includes("/calendar/v3/") ? Response.json({}, { status: 401 }) : original(url, init));
    await expect(read()).rejects.toMatchObject({ code: "RECONNECT_REQUIRED" });
    expect(h.refreshCalls()).toHaveLength(1); h.http.mockClear();
    await expect(read()).rejects.toMatchObject({ code: "RECONNECT_REQUIRED" }); expect(h.http).not.toHaveBeenCalled();
    expect((await h.service.getConnectedAccount(owner.id, account.id)).health?.state).toBe("needs-reconnect");
  });
  it("persists scope loss for only the affected capability and clears it on incremental consent", async () => {
    const { account, read } = await calendarConnection();
    h.http.mockResolvedValueOnce(Response.json({ error: { errors: [{ reason: "insufficientPermissions" }] } }, { status: 403 }));
    await expect(read()).rejects.toMatchObject({ code: "AUTHORIZATION_REQUIRED" }); h.http.mockClear();
    await expect(read()).rejects.toMatchObject({ code: "AUTHORIZATION_REQUIRED" }); expect(h.http).not.toHaveBeenCalled();
    expect((await h.service.getConnectedAccount(owner.id, account.id)).capabilities).toContain("drive-read");
    expect((await h.service.getConnectedAccount(owner.id, account.id)).health?.state).toBe("missing-permission");
    await h.connect({ connectedAccountId: account.id, capabilities: ["calendar-read"] });
    expect(await read()).toEqual({ items: [] }); expect(await db().connectedAccount.count({ where: { userId: owner.id } })).toBe(1);
  });
  it("does not mistake a single resource permission failure for account scope revocation", async () => {
    const { account, read } = await calendarConnection();
    h.http.mockResolvedValueOnce(Response.json({ error: { errors: [{ reason: "forbidden" }] } }, { status: 403 }));
    await expect(read()).rejects.toMatchObject({ code: "RESOURCE_ACCESS_DENIED" });
    expect((await h.service.getConnectedAccount(owner.id, account.id)).capabilities).toContain("calendar-read");
    expect(await read()).toEqual({ items: [] });
  });
  it.each([429, 403])("normalizes rate limiting (%s), clamps Retry-After and suppresses repeat network calls", async status => {
    const { account, read } = await calendarConnection();
    h.http.mockResolvedValueOnce(Response.json({ error: { errors: [{ reason: "rateLimitExceeded" }], secret: secrets.access } }, { status, headers: { "retry-after": "120" } }));
    await expect(read()).rejects.toMatchObject({ code: "PROVIDER_RATE_LIMITED", status: 429, retryAfterSeconds: 120 });
    h.http.mockClear(); await Promise.all(Array.from({ length: 12 }, () => expect(read()).rejects.toMatchObject({ code: "PROVIDER_RATE_LIMITED" })));
    expect(h.http).not.toHaveBeenCalled();
    expect((await h.service.getConnectedAccount(owner.id, account.id)).health?.state).toBe("delayed");
    vi.setSystemTime(new Date(NOW.getTime() + 121000)); expect(await read()).toEqual({ items: [] });
  });
  it.each(["invalid-blob", "v9.old.aa.bb.cc", "v1.unknown.aa.bb.cc"])("quarantines corrupt credentials (%s) without repeated decryption attempts", async blob => {
    const { account } = await h.connect();
    await db().connectedAccount.update({ where: { id: account.id }, data: { accessTokenEncrypted: blob } });
    await expect(h.service.getValidAccessToken(owner.id, account.id)).rejects.toMatchObject({ code: "ENCRYPTION_FAILURE" });
    await expect(h.service.getValidAccessToken(owner.id, account.id)).rejects.toMatchObject({ code: "RECONNECT_REQUIRED" });
    expect((await h.service.getConnectedAccount(owner.id, account.id)).health?.auth).toBe("needs-reconnect");
  });
  it("recovers a lease left by a terminated worker", async () => {
    const { account } = await h.connect(); await h.expire(account.id);
    await db().connectedAccount.update({ where: { id: account.id }, data: { refreshLeaseToken: "old-worker", refreshLeaseUntil: new Date(NOW.getTime() - 1) } });
    expect(await h.service.getValidAccessToken(owner.id, account.id)).toBe("secret-access-B"); expect(h.refreshCalls()).toHaveLength(1);
  });
  it("preserves encrypted credentials during temporary key-store configuration failure", async () => {
    const { account } = await h.connect();
    const before = await db().connectedAccount.findUniqueOrThrow({ where: { id: account.id } });
    const unavailable = createIntegrationService({ registry: h.registry, encryption: () => { throw new IntegrationError("CONFIGURATION"); } });
    await expect(unavailable.getValidAccessToken(owner.id, account.id)).rejects.toMatchObject({ code: "CONFIGURATION" });
    expect(await db().connectedAccount.findUnique({ where: { id: account.id } })).toMatchObject({ status: "ERROR", refreshTokenEncrypted: before.refreshTokenEncrypted, accessTokenEncrypted: before.accessTokenEncrypted });
    vi.setSystemTime(new Date(NOW.getTime() + 61000)); expect(await h.service.getValidAccessToken(owner.id, account.id)).toBe(secrets.access);
  });
  it("does not overwrite a reconnect that wins while an older refresh is in flight", async () => {
    const { account } = await h.connect(); await h.expire(account.id);
    const entered = deferred(), release = deferred(); h.state.refreshHook = async () => { entered.resolve(); await release.promise; };
    const refresh = h.service.getValidAccessToken(owner.id, account.id); await entered.promise;
    await h.connect({ connectedAccountId: account.id }); release.resolve();
    expect(await refresh).toBe(secrets.access);
    expect(await h.service.getValidAccessToken(owner.id, account.id)).toBe(secrets.access);
  });
  it("registers typed providers and refuses unsupported or duplicate providers", () => {
    expect(h.registry.get("google")).toBe(h.provider); expect(h.registry.list()).toHaveLength(1);
    expect(h.registry.isSupported("microsoft")).toBe(false);
    expect(() => h.registry.get("unknown")).toThrow(); expect(() => h.registry.register(h.provider)).toThrow();
  });
  it("builds least-privilege authorization with state, S256 PKCE and fixed callback", async () => {
    const { authorizationUrl } = await h.service.startIntegrationConnection({ provider: "google" }, owner.headers);
    const url = new URL(authorizationUrl); expect(url.origin).toBe("https://accounts.google.com");
    expect(url.searchParams.get("scope")?.split(" ")).toEqual(GOOGLE_SCOPES["account-profile"]);
    expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:3000/api/student/integrations/google/callback");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256"); expect(url.searchParams.get("include_granted_scopes")).toBe("true");
    const state = url.searchParams.get("state")!; expect(state).toHaveLength(43);
    const row = await db().oAuthConnectionSession.findFirstOrThrow({ where: { userId: owner.id } });
    expect(row.stateHash).not.toBe(state); expect(row.expiresAt.getTime() - NOW.getTime()).toBe(600000);
    const verifier = h.crypto.decrypt(row.codeVerifierEncrypted!, credentialContext(owner.id, "google", row.id, "pkce"));
    expect(createHash("sha256").update(verifier).digest("base64url")).toBe(url.searchParams.get("code_challenge"));
    expect(authorizationUrl).not.toContain(verifier); expect(JSON.stringify(row)).not.toContain(verifier);
  });
  it("valid callback encrypts credentials and returns only safe account metadata", async () => {
    const result = await h.connect(); const row = await db().connectedAccount.findUniqueOrThrow({ where: { id: result.account.id } });
    expect(row.status).toBe("ACTIVE"); expect(row.providerAccountId).toBe("google-sub-1");
    expect(row.accessTokenEncrypted).not.toContain(secrets.access); expect(row.refreshTokenEncrypted).not.toContain(secrets.refresh);
    expect(await h.service.getValidAccessToken(owner.id, row.id)).toBe(secrets.access);
    expect(JSON.stringify(result)).not.toMatch(/Token|scopes|secret-/);
    const session = await db().oAuthConnectionSession.findFirstOrThrow({ where: { userId: owner.id } });
    expect(session.usedAt).toEqual(NOW); expect(session.completedAt).toEqual(NOW); expect(session.codeVerifierEncrypted).toBeNull();
  });
  it.each(["", "invalid", "A".repeat(43)])("rejects invalid state %s before any provider request", async (state) => {
    await expect(h.service.handleIntegrationCallback("google", { state, code: secrets.code }, owner.headers)).rejects.toMatchObject({ code: "INVALID_STATE" });
    expect(h.http).not.toHaveBeenCalled();
  });
  it("expires authorization state and cleans temporary credentials", async () => {
    const state = await h.start(); vi.setSystemTime(new Date(NOW.getTime() + 600001));
    await expect(h.service.handleIntegrationCallback("google", { state, code: secrets.code }, owner.headers)).rejects.toMatchObject({ code: "INVALID_STATE" });
    expect(await cleanupOAuthSessions()).toBeGreaterThanOrEqual(1); expect(h.http).not.toHaveBeenCalled();
  });
  it("binds callbacks to the initiating user and exact authentication session", async () => {
    const state = await h.start();
    await expect(h.service.handleIntegrationCallback("google", { state, code: secrets.code }, foreign.headers)).rejects.toMatchObject({ code: "INVALID_STATE" });
    const response = await auth().api.signInEmail({ body: { email: owner.email, password: owner.password }, asResponse: true });
    const headers = new Headers({ cookie: response.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ") });
    await expect(h.service.handleIntegrationCallback("google", { state, code: secrets.code }, headers)).rejects.toMatchObject({ code: "INVALID_STATE" });
    expect(h.http).not.toHaveBeenCalled();
    expect((await h.service.handleIntegrationCallback("google", { state, code: secrets.code }, owner.headers)).account.status).toBe("connected");
  });
  it("consumes a denied callback and prevents replay", async () => {
    const state = await h.start();
    await expect(h.service.handleIntegrationCallback("google", { state, error: "access_denied" }, owner.headers)).rejects.toMatchObject({ code: "ACCESS_DENIED" });
    await expect(h.service.handleIntegrationCallback("google", { state, code: secrets.code }, owner.headers)).rejects.toMatchObject({ code: "INVALID_STATE" });
    expect(h.http).not.toHaveBeenCalled();
  });
  it.each(["exchangeFailure", "identityFailure"] as const)("handles %s safely, without creating accounts or reusable state", async (key) => {
    h.state[key] = true; const state = await h.start();
    await expect(h.service.handleIntegrationCallback("google", { state, code: secrets.code }, owner.headers)).rejects.toBeInstanceOf(IntegrationError);
    expect(await h.service.listConnectedAccounts(owner.id)).toEqual([]);
    await expect(h.service.handleIntegrationCallback("google", { state, code: secrets.code }, owner.headers)).rejects.toMatchObject({ code: "INVALID_STATE" });
  });
  it("rolls back credential storage on encryption failure without leaving reusable state", async () => {
    const state = await h.start();
    vi.spyOn(h.crypto, "encrypt").mockImplementation(() => { throw new IntegrationError("ENCRYPTION_FAILURE"); });
    await expect(h.service.handleIntegrationCallback("google", { state, code: secrets.code }, owner.headers)).rejects.toMatchObject({ code: "ENCRYPTION_FAILURE" });
    expect(await h.service.listConnectedAccounts(owner.id)).toHaveLength(0);
    expect(await db().oAuthConnectionSession.findFirst({ where: { userId: owner.id } })).toMatchObject({ codeVerifierEncrypted: null, completedAt: null, usedAt: NOW });
    await expect(h.service.handleIntegrationCallback("google", { state, code: secrets.code }, owner.headers)).rejects.toMatchObject({ code: "INVALID_STATE" });
  });
  it("rejects an authentication callback without a session and duplicate state parameters", async () => {
    const state = await h.start();
    await expect(h.service.handleIntegrationCallback("google", { state, code: secrets.code }, new Headers())).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    const response = await h.routes.callback(new Request(`http://localhost:3000/api/student/integrations/google/callback?state=${state}&state=${state}&code=code`, { headers: owner.headers }), "google");
    expect(response.headers.get("location")).toContain("integration=INVALID_STATE"); expect(h.http).not.toHaveBeenCalled();
  });
  it("repeated successful callbacks are idempotent without repeating token exchange", async () => {
    const state = await h.start(); const first = await h.service.handleIntegrationCallback("google", { state, code: secrets.code }, owner.headers);
    const count = h.http.mock.calls.length;
    const second = await h.service.handleIntegrationCallback("google", { state, code: "different-code" }, owner.headers);
    expect(second).toMatchObject({ replayed: true, account: { id: first.account.id } }); expect(h.http).toHaveBeenCalledTimes(count);
    expect(await h.service.listConnectedAccounts(owner.id)).toHaveLength(1);
  });
  it("claims concurrent callbacks once", async () => {
    const state = await h.start(); const results = await Promise.allSettled([1, 2].map(() => h.service.handleIntegrationCallback("google", { state, code: secrets.code }, owner.headers)));
    expect(results.some((result) => result.status === "fulfilled")).toBe(true);
    expect(h.http.mock.calls.filter(([url]) => String(url).endsWith("/token"))).toHaveLength(1);
    expect(await h.service.listConnectedAccounts(owner.id)).toHaveLength(1);
  });
  it("reconnects the same account without duplicates and preserves an omitted refresh token", async () => {
    const first = await h.connect(); h.state.exchangeRefresh = false;
    const second = await h.connect({ connectedAccountId: first.account.id }); expect(second.account.id).toBe(first.account.id);
    await h.expire(first.account.id); expect(await h.service.getValidAccessToken(owner.id, first.account.id)).toBe("secret-access-B");
    expect(h.refreshCalls()[0][1]?.body?.toString()).toContain(encodeURIComponent(secrets.refresh));
  });
  it("supports multiple accounts but refuses an account swap during explicit reconnect", async () => {
    const first = await h.connect(); h.state.identity = "google-sub-2";
    await expect(h.connect({ connectedAccountId: first.account.id })).rejects.toMatchObject({ code: "ACCOUNT_MISMATCH" });
    const second = await h.connect(); expect(second.account.id).not.toBe(first.account.id);
    expect(await h.service.listConnectedAccounts(owner.id)).toHaveLength(2);
  });
  it("requires explicitly authorized scopes and supports incremental consent", async () => {
    const first = await h.connect(); const state = await h.start({ connectedAccountId: first.account.id, capabilities: ["calendar-read"] });
    const pending = await db().oAuthConnectionSession.findFirstOrThrow({ where: { stateHash: createHash("sha256").update(state).digest("base64url") } });
    expect(pending.requestedScopes).toContain(GOOGLE_SCOPES["calendar-read"][0]);
    expect(pending.requestedScopes).not.toContain(GOOGLE_SCOPES["drive-read"][0]);
    await expect(h.service.handleIntegrationCallback("google", { state, code: secrets.code }, owner.headers)).rejects.toMatchObject({ code: "AUTHORIZATION_REQUIRED" });
    h.state.scopes = [...h.state.scopes, ...GOOGLE_SCOPES["calendar-read"]];
    const changed = await h.connect({ connectedAccountId: first.account.id, capabilities: ["calendar-read"] });
    expect(changed.account.capabilities).toContain("calendar-read"); expect(changed.account.id).toBe(first.account.id);
  });
  it("refreshes centrally once for concurrent expired-token requests", async () => {
    const { account } = await h.connect(); await h.expire(account.id);
    const tokens = await Promise.all(Array.from({ length: 6 }, () => h.service.getValidAccessToken(owner.id, account.id)));
    expect(new Set(tokens)).toEqual(new Set(["secret-access-B"])); expect(h.refreshCalls()).toHaveLength(1);
    expect(await db().connectedAccount.findUnique({ where: { id: account.id } })).toMatchObject({ status: "ACTIVE", lastRefreshedAt: NOW });
  });
  it("stores rotated refresh tokens and retains them when later refreshes omit them", async () => {
    const { account } = await h.connect(); await h.expire(account.id); h.state.refreshRotation = true;
    await h.service.getValidAccessToken(owner.id, account.id); await h.expire(account.id); h.state.refreshRotation = false;
    await h.service.getValidAccessToken(owner.id, account.id);
    expect(h.refreshCalls()[1][1]?.body?.toString()).toContain(encodeURIComponent(secrets.rotated));
    const row = await db().connectedAccount.findUniqueOrThrow({ where: { id: account.id } });
    expect(h.crypto.decrypt(row.refreshTokenEncrypted!, credentialContext(owner.id, "google", account.id, "refresh"))).toBe(secrets.rotated);
  });
  it("retains granted scopes when a valid refresh response omits the scope field", async () => {
    h.state.scopes.push(...GOOGLE_SCOPES["calendar-read"]); const { account } = await h.connect({ capabilities: ["calendar-read"] }); await h.expire(account.id);
    h.http.mockImplementationOnce(async () => Response.json({ access_token: "refreshed-token", token_type: "Bearer", expires_in: 3600 }));
    expect(await h.service.getValidAccessToken(owner.id, account.id, "calendar-read")).toBe("refreshed-token");
    expect((await h.service.getConnectedAccount(owner.id, account.id)).capabilities).toContain("calendar-read");
  });
  it("refuses ciphertext copied from another connected account", async () => {
    const first = await h.connect(); h.state.identity = "second-account"; const second = await h.connect();
    const row = await db().connectedAccount.findUniqueOrThrow({ where: { id: first.account.id } });
    await db().connectedAccount.update({ where: { id: second.account.id }, data: { accessTokenEncrypted: row.accessTokenEncrypted } });
    await expect(h.service.getValidAccessToken(owner.id, second.account.id)).rejects.toMatchObject({ code: "ENCRYPTION_FAILURE" });
  });
  it("marks invalid_grant as requiring reconnect, clears credentials and never retries it endlessly", async () => {
    const { account } = await h.connect(); await h.expire(account.id); h.state.refreshError = "invalid_grant";
    await expect(h.service.getValidAccessToken(owner.id, account.id)).rejects.toMatchObject({ code: "RECONNECT_REQUIRED" });
    await expect(h.service.getValidAccessToken(owner.id, account.id)).rejects.toMatchObject({ code: "RECONNECT_REQUIRED" });
    expect(h.refreshCalls()).toHaveLength(1);
    expect(await db().connectedAccount.findUnique({ where: { id: account.id } })).toMatchObject({ status: "EXPIRED", accessTokenEncrypted: null, refreshTokenEncrypted: null });
    h.state.refreshError = ""; expect((await h.connect({ connectedAccountId: account.id })).account.status).toBe("connected");
  });
  it("records temporary provider failure with bounded retry cooldown", async () => {
    const { account } = await h.connect(); await h.expire(account.id); h.state.refreshError = "temporarily_unavailable";
    await expect(h.service.getValidAccessToken(owner.id, account.id)).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    await expect(h.service.getValidAccessToken(owner.id, account.id)).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    expect(h.refreshCalls()).toHaveLength(1); expect((await h.service.getConnectedAccount(owner.id, account.id)).status).toBe("error");
    vi.setSystemTime(new Date(NOW.getTime() + 61000)); h.state.refreshError = "";
    expect(await h.service.getValidAccessToken(owner.id, account.id)).toBe("secret-access-B");
  });
  it("missing refresh tokens require reconnect once the access token expires", async () => {
    h.state.exchangeRefresh = false; const { account } = await h.connect(); await h.expire(account.id);
    await expect(h.service.getValidAccessToken(owner.id, account.id)).rejects.toMatchObject({ code: "RECONNECT_REQUIRED" }); expect(h.refreshCalls()).toHaveLength(0);
  });
  it("checks ownership and capability before obtaining tokens or creating a client", async () => {
    const { account } = await h.connect(); h.http.mockClear();
    for (const run of [() => h.service.getConnectedAccount(foreign.id, account.id), () => h.service.getValidAccessToken(foreign.id, account.id), () => h.service.disconnectConnectedAccount(foreign.id, account.id)])
      await expect(run()).rejects.toMatchObject({ code: "NOT_FOUND" });
    const operation = vi.fn(async () => null);
    await expect(h.service.withProviderClient({ userId: owner.id, connectedAccountId: account.id, provider: "google", capability: "drive-read" }, operation)).rejects.toMatchObject({ code: "AUTHORIZATION_REQUIRED" });
    await expect(h.service.withProviderClient({ userId: owner.id, connectedAccountId: account.id, provider: "microsoft", capability: "account-profile" }, operation)).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(operation).not.toHaveBeenCalled(); expect(h.http).not.toHaveBeenCalled();
  });
  it("refresh-time scope loss is detected before a feature can access data", async () => {
    h.state.scopes.push(...GOOGLE_SCOPES["calendar-read"]); const { account } = await h.connect({ capabilities: ["calendar-read"] }); await h.expire(account.id);
    h.state.scopes = [...GOOGLE_SCOPES["account-profile"]];
    await expect(h.service.getValidAccessToken(owner.id, account.id, "calendar-read")).rejects.toMatchObject({ code: "AUTHORIZATION_REQUIRED" });
    expect((await h.service.getConnectedAccount(owner.id, account.id)).capabilities).not.toContain("calendar-read");
  });
  it("disconnects idempotently, erases tokens and blocks all later access", async () => {
    const { account } = await h.connect();
    expect((await h.service.disconnectConnectedAccount(owner.id, account.id)).status).toBe("disconnected");
    await h.service.disconnectConnectedAccount(owner.id, account.id);
    expect(h.http.mock.calls.filter(([url]) => String(url).endsWith("/revoke"))).toHaveLength(1);
    expect(await db().connectedAccount.findUnique({ where: { id: account.id } })).toMatchObject({ accessTokenEncrypted: null, refreshTokenEncrypted: null, status: "REVOKED" });
    await expect(h.service.getValidAccessToken(owner.id, account.id)).rejects.toMatchObject({ code: "DISCONNECTED" });
  });
  it("denies local access before remote revocation finishes, including on remote failure", async () => {
    const { account } = await h.connect(); const entered = deferred(), release = deferred();
    h.state.revokeHook = async () => { entered.resolve(); await release.promise; }; h.state.revokeFailure = true;
    const disconnect = h.service.disconnectConnectedAccount(owner.id, account.id); await entered.promise;
    await expect(h.service.getValidAccessToken(owner.id, account.id)).rejects.toMatchObject({ code: "DISCONNECTED" });
    await expect(h.start({ connectedAccountId: account.id })).rejects.toMatchObject({ code: "CONNECTION_BUSY" });
    release.resolve(); expect(await disconnect).toMatchObject({ status: "disconnected", revocationFailed: true });
  });
  it("disconnects before an in-flight refresh finishes and rejects its rotated credential", async () => {
    const { account } = await h.connect(); await h.expire(account.id); const entered = deferred(), release = deferred();
    h.state.refreshHook = async () => { entered.resolve(); await release.promise; }; h.state.refreshRotation = true;
    const refresh = h.service.getValidAccessToken(owner.id, account.id);
    const rejected = expect(refresh).rejects.toMatchObject({ code: "DISCONNECTED" }); await entered.promise;
    expect(await h.service.disconnectConnectedAccount(owner.id, account.id)).toMatchObject({ status: "disconnected" });
    release.resolve(); await rejected;
    expect(await db().connectedAccount.findUnique({ where: { id: account.id } })).toMatchObject({ status: "REVOKED", accessTokenEncrypted: null, refreshTokenEncrypted: null });
    const revoke = h.http.mock.calls.find(([url]) => String(url).endsWith("/revoke")); expect(String(revoke?.[1]?.body)).toContain(encodeURIComponent(secrets.refresh));
    await expect(h.service.getValidAccessToken(owner.id, account.id)).rejects.toMatchObject({ code: "DISCONNECTED" });
  });
  it("invalidates pending callbacks when an account is disconnected", async () => {
    const { account } = await h.connect(); const state = await h.start({ connectedAccountId: account.id }); const entered = deferred(), release = deferred();
    h.state.identityHook = async () => { entered.resolve(); await release.promise; };
    const pending = h.service.handleIntegrationCallback("google", { state, code: secrets.code }, owner.headers);
    const rejected = expect(pending).rejects.toMatchObject({ code: "INVALID_STATE" });
    await entered.promise; await h.service.disconnectConnectedAccount(owner.id, account.id); release.resolve(); await rejected;
    expect((await h.service.getConnectedAccount(owner.id, account.id)).status).toBe("disconnected");
  });
  it("scope upgrades during a provider read preserve account identity and safe results", async () => {
    h.state.scopes.push(...GOOGLE_SCOPES["calendar-read"]); const { account } = await h.connect({ capabilities: ["calendar-read"] });
    const entered = deferred(), release = deferred(); h.state.readHook = async () => { entered.resolve(); await release.promise; };
    const read = h.service.withProviderClient({ userId: owner.id, connectedAccountId: account.id, provider: "google", capability: "calendar-read" }, (client) => client.read({ path: "calendars/primary/events" }));
    await entered.promise; h.state.scopes.push(...GOOGLE_SCOPES["drive-read"]); await h.connect({ connectedAccountId: account.id, capabilities: ["drive-read"] }); release.resolve();
    expect(await read).toEqual({ items: [] }); expect((await h.service.getConnectedAccount(owner.id, account.id)).capabilities).toContain("drive-read");
  });
  it("does not return in-flight provider results after local disconnect", async () => {
    h.state.scopes.push(...GOOGLE_SCOPES["calendar-read"]); const { account } = await h.connect({ capabilities: ["calendar-read"] });
    const entered = deferred(), release = deferred(); h.state.readHook = async () => { entered.resolve(); await release.promise; };
    const read = h.service.withProviderClient({ userId: owner.id, connectedAccountId: account.id, provider: "google", capability: "calendar-read" }, (client) => client.read({ path: "calendars/primary/events" }));
    const rejected = expect(read).rejects.toMatchObject({ code: "DISCONNECTED" }); await entered.promise;
    await h.service.disconnectConnectedAccount(owner.id, account.id); release.resolve(); await rejected;
  });
  it.each(["https://evil.test", "//evil.test", "/student/settings?next=https://evil.test", "/student/../outside", "javascript:alert(1)"])("blocks unapproved post-OAuth redirects: %s", async (redirectPath) => {
    await expect(h.service.startIntegrationConnection({ provider: "google", redirectPath: redirectPath as "/student/settings" }, owner.headers)).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(await db().oAuthConnectionSession.count({ where: { userId: owner.id } })).toBe(0);
  });
  it("enforces authenticated API identity, origin checks and safe callback redirects", async () => {
    expect((await h.routes.list(new Request("http://localhost:3000/api/student/integrations"))).status).toBe(401);
    expect((await h.routes.connect(req("POST", { provider: "google", userId: foreign.id }))).status).toBe(400);
    const bad = req("POST", { provider: "google" }); bad.headers.set("origin", "https://evil.test"); expect((await h.routes.connect(bad)).status).toBe(403);
    const { account } = await h.connect(); expect((await h.routes.disconnect(req("DELETE", undefined, foreign), account.id)).status).toBe(404);
    const callback = await h.routes.callback(new Request(`http://localhost:3000/api/student/integrations/google/callback?code=${secrets.code}&state=bad&error_description=${secrets.refresh}`, { headers: owner.headers }), "google");
    expect(callback.status).toBe(303); expect(callback.headers.get("referrer-policy")).toBe("no-referrer");
    expect(callback.headers.get("location")).toBe("http://localhost:3000/student/settings?integration=INVALID_STATE#integrations");
    const safe = await h.routes.list(req("GET")); expect(JSON.stringify(await safe.json())).not.toMatch(/secret-|Encrypted|accessToken|refreshToken/);
  });
  it("models sync state separately, encrypts cursors and enforces ownership", async () => {
    const { account } = await h.connect();
    await h.service.updateIntegrationSyncState(owner.id, account.id, "account-profile", { status: "SYNCING" });
    await h.service.updateIntegrationSyncState(owner.id, account.id, "account-profile", { status: "COMPLETED", cursor: "private-sync-cursor" });
    await h.service.updateIntegrationSyncState(owner.id, account.id, "account-profile", { status: "FAILED", errorCode: "PROVIDER_UNAVAILABLE" });
    const sync = await db().integrationSyncState.findFirstOrThrow({ where: { connectedAccountId: account.id } });
    expect(sync).toMatchObject({ status: "FAILED", lastSuccessfulSyncAt: NOW }); expect(sync.cursorEncrypted).not.toContain("private-sync-cursor");
    expect((await h.service.getIntegrationSyncState(owner.id, account.id, "account-profile"))?.cursor).toBe("private-sync-cursor");
    await expect(h.service.getIntegrationSyncState(foreign.id, account.id, "account-profile")).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await h.service.getConnectedAccount(owner.id, account.id)).status).toBe("connected");
    await expect(h.service.updateIntegrationSyncState(foreign.id, account.id, "account-profile", { status: "SYNCING" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
  it("uses account tokens from the existing background executor without browser cookies", async () => {
    const { account } = await h.connect(); await h.expire(account.id);
    const queueJobId = randomUUID(); const run = await db().jobRun.create({ data: { userId: owner.id, queueJobId, jobName: "integration-test", jobVersion: 1, idempotencyKey: queueJobId } });
    const definition: BackgroundJob<{ version: 1; trackingId: string; userId: string }> = {
      name: "integration-test", version: 1, payloadSchema: z.object({ version: z.literal(1), trackingId: z.string(), userId: z.string() }),
      retryPolicy: { limit: 1, delaySeconds: 1, maximumDelaySeconds: 2, exponentialBackoff: false }, timeoutSeconds: 30, priority: "normal", executionScope: "user", concurrency: { scope: "user", limit: 1 }, debounceSeconds: 1,
      async handler({ payload }) { const token = await h.service.getValidAccessToken(payload.userId, account.id); return { authorized: Boolean(token) }; },
    };
    expect((await executeBackgroundJob(definition, { id: queueJobId, name: definition.name, data: { version: 1, trackingId: run.id, userId: owner.id }, signal: new AbortController().signal, retryCount: 0, retryLimit: 1 })).status).toBe("completed");
    expect(JSON.stringify(await db().jobRun.findUnique({ where: { id: run.id } }))).not.toContain("secret-");
    expect(normalizeBackgroundJobError(new IntegrationError("INVALID_GRANT"))).toMatchObject({ code: "AUTHORIZATION_ERROR", retryable: false });
  });
  it("cascades credentials, OAuth sessions and sync state on user deletion", async () => {
    const disposable = await actor(); const { account } = await h.connect({}, disposable);
    await h.service.updateIntegrationSyncState(disposable.id, account.id, "account-profile", { status: "COMPLETED", cursor: "cursor" });
    await h.start({}, disposable); await db().user.delete({ where: { id: disposable.id } });
    expect(await db().connectedAccount.count({ where: { userId: disposable.id } })).toBe(0);
    expect(await db().oAuthConnectionSession.count({ where: { userId: disposable.id } })).toBe(0);
    expect(await db().integrationSyncState.count({ where: { connectedAccountId: account.id } })).toBe(0);
  });
  it("registers periodic cleanup through the existing job infrastructure", async () => {
    expect(getBackgroundJob("cleanup-oauth-sessions")).toBe(cleanupOAuthSessionsJob);
    const schedule = vi.fn(async () => {}); await registerOAuthCleanupSchedule({ schedule } as never, { enabled: true });
    expect(schedule).toHaveBeenCalledWith("cleanup-oauth-sessions", "17 * * * *", { version: 1 }, expect.any(Object));
    await h.start(); vi.setSystemTime(new Date(NOW.getTime() + 600001));
    expect(await cleanupOAuthSessionsJob.handler({ payload: { version: 1 }, signal: new AbortController().signal, attempt: 1, jobRunId: "cleanup" })).toMatchObject({ deleted: expect.any(Number) });
    expect(await db().oAuthConnectionSession.count({ where: { userId: owner.id } })).toBe(0);
  });
  it("never logs token values or raw provider errors, and uses no LLM calls", async () => {
    const provider = vi.spyOn(ai, "getAIProvider").mockImplementation(() => { throw new Error("Unexpected LLM"); });
    const { account } = await h.connect(); await h.expire(account.id); h.state.refreshError = "invalid_grant";
    await h.service.getValidAccessToken(owner.id, account.id).catch(() => {}); await h.service.disconnectConnectedAccount(owner.id, account.id);
    const logs = JSON.stringify(vi.mocked(console.info).mock.calls); for (const secret of Object.values(secrets)) expect(logs).not.toContain(secret);
    const wrapped = safeIntegrationError(new Error(`${secrets.access} ${secrets.code}`)); expect(JSON.stringify(wrapped)).not.toContain("secret-"); expect(wrapped.cause).toBeUndefined();
    expect(provider).not.toHaveBeenCalled();
    const logging = nextConfig.logging;
    expect(logging && typeof logging.incomingRequests === "object" && logging.incomingRequests.ignore?.some((pattern) => pattern.test(`/api/student/integrations/google/callback?code=${secrets.code}`))).toBe(true);
  });
});

describe("Token encryption and provider HTTP boundary", () => {
  it("authenticates ciphertext, record context and random nonces", () => {
    const cipher = h.crypto.encrypt(secrets.access, "user/account/access");
    expect(h.crypto.decrypt(cipher, "user/account/access")).toBe(secrets.access);
    expect(h.crypto.encrypt(secrets.access, "user/account/access")).not.toBe(cipher);
    expect(() => h.crypto.decrypt(cipher, "other/account/access")).toThrow();
    const parts = cipher.split("."); parts[3] = Buffer.alloc(16).toString("base64url"); expect(() => h.crypto.decrypt(parts.join("."), "user/account/access")).toThrow();
    expect(() => h.crypto.decrypt("plaintext", "context")).toThrow();
  });
  it("supports versioned keys without losing old ciphertext", () => {
    const old = h.crypto.encrypt(secrets.refresh, "context"); const newer = new AesTokenEncryptionService({ v1: h.key, v2: randomBytes(32).toString("base64") }, "v2");
    expect(newer.decrypt(old, "context")).toBe(secrets.refresh); expect(newer.encrypt("value", "context")).toMatch(/^v1\.v2\./);
    expect(() => new AesTokenEncryptionService({ v1: "bad" }, "v1")).toThrow();
  });
  it("does not require provider secrets for unrelated settings and validates configuration safely", async () => {
    vi.stubEnv("INTEGRATION_TOKEN_KEYS", "{}"); expect(() => getTokenEncryptionService()).toThrow();
    vi.stubEnv("INTEGRATION_OAUTH_BASE_URL", "https://evil.test"); expect(() => integrationOrigin()).toThrow();
    const service = createIntegrationService({ registry: h.registry });
    expect((await service.getIntegrationSettings(owner.id)).providers[0].available).toBe(false);
  });
  it("uses HTTPS fixed endpoints, body credentials, bounded requests and no redirects", async () => {
    await h.connect(); const [url, options] = h.http.mock.calls[0];
    expect(String(url)).toBe("https://oauth2.googleapis.com/token"); expect(options).toMatchObject({ method: "POST", redirect: "error", cache: "no-store", signal: expect.any(AbortSignal) });
    expect(String(options?.body)).toContain("code_verifier="); expect(String(url)).not.toContain(secrets.code);
  });
  it("rejects malformed token responses and sanitizes network exceptions", async () => {
    const malformed = new GoogleIntegrationProvider(async () => Response.json({ access_token: secrets.access, expires_in: -1 }), () => ({ clientId: "id", clientSecret: secrets.client }));
    await expect(malformed.refreshAccessToken(secrets.refresh)).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    const failing = new GoogleIntegrationProvider(async () => { throw new Error(secrets.refresh); }, () => ({ clientId: "id", clientSecret: secrets.client }));
    const failure = await failing.refreshAccessToken(secrets.refresh).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "PROVIDER_UNAVAILABLE" }); expect(failure).not.toHaveProperty("cause");
    expect(String(failure)).not.toContain(secrets.refresh);
  });
  it.each(["https://evil.test", "//evil.test", "../userinfo", "%2e%2e/userinfo", "calendars%2F..%2Fuserinfo"])("rejects unsafe provider-client paths %s", async (path) => {
    await expect(h.provider.read({ capability: "calendar-read", path, accessToken: secrets.access })).rejects.toMatchObject({ code: "INVALID_REQUEST" }); expect(h.http).not.toHaveBeenCalled();
  });
});
