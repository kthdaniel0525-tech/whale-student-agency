import "dotenv/config";
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { validateSecurityConfiguration } from "@/server/security/startup";
import { register } from "../instrumentation";

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("BETTER_AUTH_URL", "https://student.example.test");
  vi.stubEnv("BETTER_AUTH_SECRET", randomBytes(32).toString("hex"));
  for (const name of ["GOOGLE_INTEGRATION_CLIENT_ID", "GOOGLE_INTEGRATION_CLIENT_SECRET", "INTEGRATION_OAUTH_BASE_URL", "INTEGRATION_TOKEN_KEYS", "INTEGRATION_TOKEN_ACTIVE_KEY_ID"]) vi.stubEnv(name, undefined);
  vi.stubEnv("BILLING_ENABLED", "false");
});
afterEach(() => vi.unstubAllEnvs());
describe("startup security validation", () => {
  it("allows disabled optional providers without credentials", () => expect(() => validateSecurityConfiguration()).not.toThrow());
  it("requires both OAuth credentials and a configured encryption key for an enabled provider", () => {
    vi.stubEnv("GOOGLE_INTEGRATION_CLIENT_ID", "fixture-client");
    expect(() => validateSecurityConfiguration()).toThrow();
    vi.stubEnv("GOOGLE_INTEGRATION_CLIENT_SECRET", "fixture-secret");
    expect(() => validateSecurityConfiguration()).toThrow();
    vi.stubEnv("INTEGRATION_TOKEN_KEYS", JSON.stringify({ v1: randomBytes(32).toString("base64") }));
    vi.stubEnv("INTEGRATION_TOKEN_ACTIVE_KEY_ID", "v1");
    expect(() => validateSecurityConfiguration()).not.toThrow();
  });
  it("rejects mismatched OAuth origin at startup", () => {
    vi.stubEnv("INTEGRATION_OAUTH_BASE_URL", "https://attacker.example");
    expect(() => validateSecurityConfiguration()).toThrow();
  });
  it("checks runtime secrets at production startup but permits a build without them", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs"); vi.stubEnv("BETTER_AUTH_SECRET", "");
    vi.stubEnv("NEXT_PHASE", "phase-production-build"); await expect(register()).resolves.toBeUndefined();
    vi.stubEnv("NEXT_PHASE", "phase-production-server"); await expect(register()).rejects.toThrow("configuration");
  });
});
