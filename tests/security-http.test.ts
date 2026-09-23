import "dotenv/config";
import { randomUUID, createHmac } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { auth } from "@/server/auth/config";
import { db } from "@/server/db/client";
import { api, readJson } from "@/server/api";
import { getEnv } from "@/server/env";
import { AIError } from "@/server/ai/errors";
import { POST as authPost, GET as authGet } from "@/app/api/auth/[...all]/route";
import nextConfig from "../next.config";

const origin = process.env.BETTER_AUTH_URL!;
const password = "Security-test-passphrase-2026!";
const email = `security-http-${randomUUID()}@example.test`;
let userId: string, cookie: string;
const cookies = (response: Response) => response.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
const request = (path: string, options: { method?: string; body?: unknown; cookie?: string; origin?: string | null } = {}) => new Request(`${origin}${path}`, {
  method: options.method ?? "GET",
  headers: { ...(options.origin === null ? {} : { origin: options.origin ?? origin }), "content-type": "application/json", ...(options.cookie ? { cookie: options.cookie } : {}) },
  body: options.body === undefined ? undefined : JSON.stringify(options.body),
});
beforeAll(async () => {
  const response = await auth().api.signUpEmail({ body: { name: "Security fixture", email, password }, asResponse: true });
  expect(response.status).toBe(200);
  userId = (await response.json() as { user: { id: string } }).user.id;
  cookie = cookies(response);
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
afterAll(async () => {
  if (userId) {
    await db().user.deleteMany({ where: { id: userId, email } });
    for (const action of ["change-password"]) {
      const key = "credential:" + createHmac("sha256", process.env.BETTER_AUTH_SECRET!).update(`${action}:${userId.trim().toLowerCase()}`).digest("hex");
      await db().rateLimit.deleteMany({ where: { key } });
    }
  }
  await db().$disconnect();
});

describe.sequential("HTTP security boundaries", () => {
  it("every student HTTP mutation denies anonymous access before performing work", async () => {
    async function routeFiles(directory: string): Promise<string[]> {
      const files = await readdir(directory, { withFileTypes: true });
      return (await Promise.all(files.map(item => item.isDirectory() ? routeFiles(join(directory, item.name)) : item.name === "route.ts" ? [join(directory, item.name)] : []))).flat();
    }
    let tested = 0;
    for (const file of await routeFiles(join(process.cwd(), "app/api/student"))) {
      const handlers = await import(file);
      const path = file.slice(file.indexOf("/app/") + 4).replace(/\/route\.ts$/, "").replace(/\[[^\]]+\]/g, "foreign-resource");
      for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
        if (typeof handlers[method] !== "function") continue;
        const result = await handlers[method](request(path, { method, body: {} }), { params: Promise.resolve({ id: "foreign-resource", messageId: "foreign-resource", provider: "google" }) });
        expect(result.status, `${method} ${path}`).toBe(401);
        expect(result.headers.get("cache-control")).toContain("no-store");
        tested++;
      }
    }
    expect(tested).toBeGreaterThan(40);
  });
  it.each([null, "null", "https://evil.example", "http://localhost:3000.evil.example"])("rejects missing/cross-origin %s even with a real cookie", async candidate => {
    const work = vi.fn();
    const response = await api(request("/api/student/profile", { method: "PUT", body: {}, cookie, origin: candidate }), work, false);
    expect(response.status).toBe(403); expect(work).not.toHaveBeenCalled();
  });
  it("derives identity from the session and ignores forged identity headers", async () => {
    const req = request("/api/student/profile", { cookie }); req.headers.set("oai-authenticated-user-id", "attacker"); req.headers.set("x-user-id", "attacker");
    const response = await api(req, async id => ({ id }), false);
    expect(await response.json()).toEqual({ id: userId });
  });
  it("rejects an expired session against authoritative storage", async () => {
    const signedIn = await auth().api.signInEmail({ body: { email, password }, asResponse: true });
    const token = (await signedIn.json() as { token: string }).token;
    await db().session.updateMany({ where: { userId, token }, data: { expiresAt: new Date(0) } });
    expect((await api(request("/api/student/profile", { cookie: cookies(signedIn) }), async () => ({ ok: true }), false)).status).toBe(401);
  });
  it("redacts upstream authentication diagnostics", async () => {
    const logger = vi.spyOn(console, "error").mockImplementation(() => {});
    const context = await auth().$context;
    context.logger.error("private-callback-and-token", { email, password });
    expect(JSON.parse(logger.mock.calls[0][0] as string)).toMatchObject({ event: "authentication-diagnostic", level: "error", requestId: expect.any(String) });
    expect(JSON.stringify(logger.mock.calls)).not.toMatch(/private-callback|passphrase|@example/);
  });
  it.each(["P2002", "P2003", "P2025", "ECONNREFUSED", "STORAGE_FAILURE", "INVALID_RESPONSE"])("does not disclose raw %s errors or log their messages", async code => {
    const secret = "private-query-schema-and-api-key";
    const logger = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await api(request("/api/student/profile", { cookie }), async () => { throw Object.assign(new Error(secret), { code }); }, false);
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(await response.text()).not.toContain(secret);
    expect(JSON.stringify(logger.mock.calls)).not.toContain(secret);
  });
  it("reconstructs trusted AI errors instead of forwarding mutated messages", async () => {
    const failure = new AIError("RATE_LIMIT"); failure.message = "private-provider-token";
    const response = await api(request("/api/student/profile", { cookie }), async () => { throw failure; }, false);
    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({ error: new AIError("RATE_LIMIT").message });
  });
  it("bounds streaming JSON before parsing and rejects content-type spoofing", async () => {
    await expect(readJson(request("/api/student/profile", { method: "PUT", body: { value: "x".repeat(33000) } }), z.unknown())).rejects.toMatchObject({ status: 413 });
    const req = request("/api/student/profile", { method: "PUT", body: {} }); req.headers.set("content-type", "application/json-evil");
    await expect(readJson(req, z.unknown())).rejects.toMatchObject({ status: 415 });
  });
  it("blocks raw Better Auth deletion and rejects external login callbacks", async () => {
    for (const path of ["/api/auth/delete-user", "/api/auth/delete-user/callback"]) {
      expect((await authGet(request(path, { cookie }))).status).toBe(403);
      expect((await authPost(request(path, { method: "POST", body: {}, cookie }))).status).toBe(403);
    }
    for (const callbackURL of ["https://evil.example/steal", "//evil.example", "/\\evil.example", "javascript:alert(1)"]) {
      const result = await authPost(request("/api/auth/sign-in/email", { method: "POST", body: { email, password, callbackURL } }));
      expect(result.status).toBe(403);
      expect(result.headers.get("location")).toBeNull();
      expect((await authGet(request(`/api/auth/reset-password/fixture?callbackURL=${encodeURIComponent(callbackURL)}`))).status).toBe(403);
    }
  });
  it("password changes rotate the session and revoke every older session even if opted out", async () => {
    const second = await auth().api.signInEmail({ body: { email, password }, asResponse: true });
    const previousCookie = cookie;
    const changed = await authPost(request("/api/auth/change-password", { method: "POST", cookie, body: { currentPassword: password, newPassword: `${password}-changed`, revokeOtherSessions: false } }));
    expect(changed.status).toBe(200);
    cookie = cookies(changed);
    for (const staleCookie of [previousCookie, cookies(second)]) {
      expect((await api(request("/api/student/profile", { cookie: staleCookie }), async () => ({ ok: true }), false)).status).toBe(401);
    }
    expect((await api(request("/api/student/profile", { cookie }), async () => ({ ok: true }), false)).status).toBe(200);
  });
  it("password verification capacity cannot be reset by creating another session", async () => {
    const key = "credential:" + createHmac("sha256", process.env.BETTER_AUTH_SECRET!).update(`change-password:${userId.toLowerCase()}`).digest("hex");
    await db().rateLimit.upsert({ where: { key }, create: { id: randomUUID(), key, count: 10, lastRequest: BigInt(Date.now()) }, update: { count: 10, lastRequest: BigInt(Date.now()) } });
    try {
      const second = await auth().api.signInEmail({ body: { email, password: `${password}-changed` }, asResponse: true });
      for (const sessionCookie of [cookie, cookies(second)]) {
        const response = await authPost(request("/api/auth/change-password", { method: "POST", cookie: sessionCookie, body: { currentPassword: "wrong-password", newPassword: `${password}-again` } }));
        expect(response.status).toBe(429);
      }
    } finally { await db().rateLimit.deleteMany({ where: { key } }); }
  });
  it("blocks API access and new sessions while account deletion is pending", async () => {
    await db().user.update({ where: { id: userId }, data: { deletionRequestedAt: new Date() } });
    try {
      const work = vi.fn();
      expect((await api(request("/api/student/profile", { cookie }), work, false)).status).toBe(401);
      expect(work).not.toHaveBeenCalled();
      const signIn = await auth().api.signInEmail({ body: { email, password: `${password}-changed` }, asResponse: true });
      expect(signIn.status).toBeGreaterThanOrEqual(400);
    } finally { await db().user.update({ where: { id: userId }, data: { deletionRequestedAt: null } }); }
  });
  it("sign-out invalidates the authoritative server session", async () => {
    expect((await authPost(request("/api/auth/sign-out", { method: "POST", body: {}, cookie }))).status).toBe(200);
    expect((await api(request("/api/student/profile", { cookie }), async () => ({ ok: true }), false)).status).toBe(401);
  });
});

describe("production configuration", () => {
  it("rejects insecure origins, URL credentials and development secrets in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    for (const unsafe of ["http://example.test", "http://localhost:3000", "javascript:alert(1)", "https://user:pass@example.test", "https://example.test/path"]) {
      vi.stubEnv("BETTER_AUTH_URL", unsafe); expect(() => getEnv()).toThrow();
    }
    vi.stubEnv("BETTER_AUTH_URL", "https://example.test");
    vi.stubEnv("BETTER_AUTH_SECRET", "replace-with-a-random-secret-of-at-least-32-characters"); expect(() => getEnv()).toThrow();
    vi.stubEnv("BETTER_AUTH_SECRET", randomUUID() + randomUUID()); expect(getEnv().BETTER_AUTH_URL).toBe("https://example.test");
  });
  it("emits browser hardening headers without production eval or wildcard sources", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const rules = await nextConfig.headers!();
    const headers = Object.fromEntries(rules[0].headers.map(item => [item.key, item.value]));
    expect(headers["Content-Security-Policy"]).toContain("frame-ancestors 'none'");
    expect(headers["Content-Security-Policy"]).not.toContain("unsafe-eval");
    expect(headers["Content-Security-Policy"]).not.toContain("*");
    expect(headers["X-Content-Type-Options"]).toBe("nosniff");
    expect(headers["Referrer-Policy"]).toBe("no-referrer");
    expect(headers["Strict-Transport-Security"]).toBe("max-age=31536000");
  });
});
