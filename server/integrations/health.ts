import "server-only";
import type { ConnectedAccount, IntegrationSyncState } from "@/generated/prisma/client";
import type { IntegrationHealth } from "@/lib/student/integrations/health";
import { INTEGRATION_FRESHNESS } from "./freshness";
/** Safe DTO only: no scopes, identity, cursor, credential or raw error details. */
export function integrationHealth(account: Pick<ConnectedAccount, "status" | "deniedCapabilities" | "lastErrorCode" | "refreshRetryAfter">, states: IntegrationSyncState[] = [], now = new Date()): IntegrationHealth {
  const auth = account.status === "REVOKED" ? "disconnected" : account.status === "EXPIRED" ? "needs-reconnect" : account.deniedCapabilities.length ? "missing-permission" : "healthy";
  const failed = states.some(s => s.lastErrorCode && s.lastErrorCode !== "PROVIDER_RATE_LIMITED") || account.status === "ERROR" && account.lastErrorCode !== "PROVIDER_RATE_LIMITED";
  const syncing = states.some(s => s.status === "SYNCING" && s.leaseUntil && s.leaseUntil > now);
  const delayed = states.some(s => s.retryAfter && s.retryAfter > now || !s.lastSuccessfulSyncAt || now.getTime() - s.lastSuccessfulSyncAt.getTime() > (INTEGRATION_FRESHNESS[s.integrationType as keyof typeof INTEGRATION_FRESHNESS] ?? INTEGRATION_FRESHNESS.academic));
  const retries = [...states.map(s => s.retryAfter), account.refreshRetryAfter].filter((v): v is Date => Boolean(v && v > now));
  const successes = states.map(s => s.lastSuccessfulSyncAt).filter((v): v is Date => Boolean(v));
  const sync = failed ? "unavailable" : syncing ? "syncing" : delayed || retries.length ? "delayed" : "healthy";
  return { state: auth !== "healthy" ? auth : sync === "healthy" ? "available" : sync, auth, sync,
    lastSuccessfulSync: successes.length ? new Date(Math.max(...successes.map(d => d.getTime()))).toISOString() : null,
    retryAt: retries.length ? new Date(Math.max(...retries.map(d => d.getTime()))).toISOString() : null };
}
