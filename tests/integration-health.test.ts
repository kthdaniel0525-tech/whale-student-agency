import { describe, expect, it } from "vitest";
import type { IntegrationSyncState } from "@/generated/prisma/client";
import { integrationHealth } from "@/server/integrations/health";
import { INTEGRATION_FRESHNESS } from "@/server/integrations/freshness";
import { GoogleIntegrationProvider } from "@/server/integrations/google";
import { IntegrationError, safeIntegrationError } from "@/server/integrations/errors";
import { AcademicIntegrationError } from "@/server/academic-integrations/errors";
import { normalizeBackgroundJobError } from "@/server/jobs/errors";
import { getIntegrationRuntimeMetrics, recordIntegrationMetric } from "@/server/integrations/metrics";
const now = new Date("2026-09-19T12:00:00Z");
const account = { status: "ACTIVE" as const, deniedCapabilities: [], lastErrorCode: null, refreshRetryAfter: null };
function sync(type: string, ageMs: number): IntegrationSyncState {
  return { id: "state", connectedAccountId: "account", integrationType: type, cursorEncrypted: "private-cursor", leaseToken: null, leaseUntil: null, status: "COMPLETED", retryAfter: null,
    lastSyncStartedAt: now, lastSyncCompletedAt: now, lastSuccessfulSyncAt: new Date(now.getTime() - ageMs), lastErrorCode: null, createdAt: now, updatedAt: now };
}
describe("safe integration health and failure boundaries", () => {
  it.each(["calendar-read", "drive-read", "academic"] as const)("uses the %s freshness boundary", type => {
    expect(integrationHealth(account, [sync(type, INTEGRATION_FRESHNESS[type] - 1)], now).state).toBe("available");
    expect(integrationHealth(account, [sync(type, INTEGRATION_FRESHNESS[type] + 1)], now).state).toBe("delayed");
  });
  it.each([["REVOKED", "disconnected"], ["EXPIRED", "needs-reconnect"]] as const)("prioritizes %s above healthy cached data", (status, expected) => {
    expect(integrationHealth({ ...account, status }, [sync("calendar-read", 0)], now).state).toBe(expected);
  });
  it("distinguishes missing permission, an outage and a live sync", () => {
    expect(integrationHealth({ ...account, deniedCapabilities: ["drive-read"] }, [], now).state).toBe("missing-permission");
    expect(integrationHealth(account, [{ ...sync("calendar-read", 0), lastErrorCode: "PROVIDER_UNAVAILABLE" }], now).state).toBe("unavailable");
    expect(integrationHealth(account, [{ ...sync("calendar-read", 0), status: "SYNCING", leaseUntil: new Date(now.getTime() + 1000) }], now).state).toBe("syncing");
  });
  it("never copies internal state into health metadata", () => {
    expect(JSON.stringify(integrationHealth(account, [sync("calendar-read", 0)], now))).not.toMatch(/private|cursor|account|Token|ErrorCode/);
  });
  it.each(["0", "-1", "NaN", "99999999999999999999999999"])("bounds an untrusted Retry-After value %s", async header => {
    const provider = new GoogleIntegrationProvider(async () => new Response("private error body", { status: 429, headers: { "retry-after": header } }));
    const error = await provider.read({ capability: "calendar-read", path: "calendars/primary/events", accessToken: "private-token" }).catch(safeIntegrationError);
    expect(error).toBeInstanceOf(IntegrationError);
    const safe = error as IntegrationError;
    expect(safe.code).toBe("PROVIDER_RATE_LIMITED"); expect(safe.retryAfterSeconds).toBeGreaterThanOrEqual(30); expect(safe.retryAfterSeconds).toBeLessThanOrEqual(3600);
    expect(JSON.stringify(safe)).not.toContain("private");
  });
  it("classifies both adapters' rate limits as bounded retryable job failures", () => {
    for (const error of [new IntegrationError("PROVIDER_RATE_LIMITED"), new AcademicIntegrationError("PROVIDER_RATE_LIMITED")]) expect(normalizeBackgroundJobError(error)).toMatchObject({ retryable: true, code: "TRANSIENT_PROVIDER_ERROR" });
  });
  it("exposes safe process counters and average duration", () => {
    const before = getIntegrationRuntimeMetrics(); recordIntegrationMetric("syncSuccesses", 200); recordIntegrationMetric("rateLimits"); recordIntegrationMetric("importsProcessed");
    const after = getIntegrationRuntimeMetrics(); expect(after.syncSuccesses).toBe(before.syncSuccesses + 1); expect(after.rateLimits).toBe(before.rateLimits + 1); expect(after.importsProcessed).toBe(before.importsProcessed + 1); expect(after.averageSyncDurationMs).toBeGreaterThanOrEqual(0);
  });
});
