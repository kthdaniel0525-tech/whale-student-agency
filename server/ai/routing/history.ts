import "server-only";
import { db } from "../../db/client";
import { modelKey } from "./catalog";
import type { ModelHistory } from "./types";

const cache = new Map<string, { until: number; result: Promise<ModelHistory[]> }>();
/** Bounded, indexed, user-scoped observations. Missing history is neutral. Never
 * treat authentication, configuration, cancellation, or invalid input as evidence
 * that a model is unreliable. No cross-user telemetry or quality inference. */
export async function getRecentModelHistory(userId?: string): Promise<ModelHistory[]> {
  if (!userId) return Promise.resolve([]);
  const cached = cache.get(userId);
  if (cached && cached.until > Date.now()) return cached.result;
  if (cache.size >= 200) cache.delete(cache.keys().next().value!);
  const result = db().aIUsageRecord.findMany({
    where: { userId, createdAt: { gte: new Date(Date.now() - 24 * 3600_000) }, operationType: { not: "embedding" },
      OR: [{ success: true }, { errorCode: { in: ["RATE_LIMIT", "PROVIDER_FAILURE", "INVALID_RESPONSE", "TIMEOUT"] } }] },
    select: { provider: true, model: true, selectedModel: true, success: true, latencyMs: true },
    orderBy: { createdAt: "desc" }, take: 200,
  }).then(rows => {
    const groups = new Map<string, { value: ModelHistory; failures: number; successCount: number; latency: number }>();
    for (const row of rows) {
      const ref = { provider: row.provider, model: row.selectedModel ?? row.model }, key = modelKey(ref);
      const group = groups.get(key) ?? { value: { ...ref, samples: 0, failureRate: 0 }, failures: 0, successCount: 0, latency: 0 };
      group.value.samples++;
      if (row.success) { group.successCount++; group.latency += row.latencyMs; } else group.failures++;
      groups.set(key, group);
    }
    return [...groups.values()].map(g => ({ ...g.value, failureRate: g.failures / g.value.samples,
      ...(g.successCount ? { averageLatencyMs: Math.round(g.latency / g.successCount) } : {}) }));
  }).catch(() => []);
  cache.set(userId, { until: Date.now() + 30_000, result });
  return result;
}
