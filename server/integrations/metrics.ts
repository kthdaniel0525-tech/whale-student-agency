import "server-only";
import { db } from "../db/client";
type Counter = "syncSuccesses" | "syncFailures" | "refreshFailures" | "rateLimits" | "importsProcessed";
const counters: Record<Counter, number> = { syncSuccesses: 0, syncFailures: 0, refreshFailures: 0, rateLimits: 0, importsProcessed: 0 };
let durationMs = 0;
/** Process-local operational counters, like job metrics; no content or credentials.
 * Production log collectors may aggregate events across workers/restarts. */
export function recordIntegrationMetric(counter: Counter, duration = 0, count = 1) {
  counters[counter] += Math.max(0, count);
  if (counter === "syncSuccesses" || counter === "syncFailures") durationMs += Math.max(0, duration);
}
export function getIntegrationRuntimeMetrics() {
  const finished = counters.syncSuccesses + counters.syncFailures;
  return { ...counters, averageSyncDurationMs: finished ? Math.round(durationMs / finished) : 0 };
}
/** Ownership-scoped durable inventory, separately from worker operational totals. */
export async function getIntegrationInventory(userId: string) {
  const rows = await db().connectedAccount.groupBy({ by: ["status"], where: { userId }, _count: true });
  const count = (status: string) => rows.find(r => r.status === status)?._count ?? 0;
  return { connectedAccounts: count("ACTIVE") + count("ERROR"), reconnectRequiredAccounts: count("EXPIRED"), disconnectedAccounts: count("REVOKED") };
}
