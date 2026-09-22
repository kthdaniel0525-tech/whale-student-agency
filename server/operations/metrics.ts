import "server-only";
import { healthPool } from "./health";
import { operationsConfig } from "./config";
import { providerHealth } from "../ai/reliability/health";
import { getModelCatalog } from "../ai/routing/catalog";
import { getBackgroundJobPublisher } from "../jobs/client";

/** Internal aggregate view of the existing telemetry, not a second event store.
 * No user IDs/content, raw errors, connection strings or queue payloads. */
export async function operationalMetrics() {
  const pool = healthPool();
  const [ai, agents, workflows, jobs, integrations, billing, workers, database, health, queues, reconnects, reconciliation] = await Promise.all([
    pool.query(`SELECT count(*)::int AS calls, count(DISTINCT "userId")::int AS "activeUsers",
      count(*) FILTER (WHERE NOT success)::int AS failures,
      count(*) FILTER (WHERE "fallbackUsed")::int AS fallbacks,
      count(*) FILTER (WHERE "operationType"='embedding')::int AS embeddings,
      coalesce(sum("estimatedCostUsd") FILTER (WHERE "createdAt">=date_trunc('day', NOW() AT TIME ZONE 'UTC')),0)::float8 AS "todayCostUsd",
      coalesce(sum("estimatedCostUsd"),0)::float8 AS "estimatedCostUsd",
      count(*) FILTER (WHERE "estimatedCostUsd" IS NULL)::int AS "unpricedCalls",
      coalesce(avg("latencyMs"),0)::float8 AS "meanLatencyMs",
      percentile_cont(0.95) WITHIN GROUP (ORDER BY "latencyMs") AS "p95LatencyMs"
      FROM "AIUsageRecord" WHERE "createdAt" >= NOW()-INTERVAL '24 hours'`),
    pool.query(`SELECT "agentId", count(*)::int AS calls, sum("estimatedCostUsd")::float8 AS "estimatedCostUsd" FROM "AIUsageRecord" WHERE "createdAt">=NOW()-INTERVAL '24 hours' AND "agentId" IS NOT NULL GROUP BY "agentId" ORDER BY calls DESC LIMIT 30`),
    pool.query(`SELECT "workflowId", count(*)::int AS calls, sum("estimatedCostUsd")::float8 AS "estimatedCostUsd" FROM "AIUsageRecord" WHERE "createdAt">=NOW()-INTERVAL '24 hours' AND "workflowId" IS NOT NULL GROUP BY "workflowId" ORDER BY calls DESC LIMIT 30`),
    pool.query(`SELECT "jobName", status, count(*)::int AS count, count(*) FILTER (WHERE attempt>1)::int AS retried,
      max(EXTRACT(EPOCH FROM (NOW()-"createdAt")))::float8 AS "oldestAgeSeconds",
      avg(EXTRACT(EPOCH FROM ("completedAt"-"startedAt"))*1000)::float8 AS "meanDurationMs"
      FROM "JobRun" WHERE "createdAt">=NOW()-INTERVAL '24 hours' OR status IN ('PENDING','RUNNING') GROUP BY "jobName",status`),
    pool.query(`SELECT "integrationType", status, count(*)::int AS count FROM "IntegrationSyncState" GROUP BY "integrationType",status LIMIT 30`),
    pool.query(`SELECT status, count(*)::int AS count FROM "BillingWebhookEvent" WHERE "receivedAt">=NOW()-INTERVAL '24 hours' GROUP BY status LIMIT 10`),
    pool.query(`SELECT role, max("seenAt") AS "lastSeenAt", count(*) FILTER (WHERE "seenAt">NOW()-INTERVAL '90 seconds')::int AS "healthyInstances" FROM "RuntimeHeartbeat" GROUP BY role`),
    pool.query(`SELECT (SELECT count(*)::int FROM pg_stat_activity WHERE datname=current_database()) AS connections,
      pg_database_size(current_database())::float8 AS "sizeBytes",
      (SELECT count(*)::int FROM pg_locks WHERE NOT granted) AS "waitingLocks"`),
    providerHealth.list(getModelCatalog().map(m => ({ provider: m.provider, model: m.model }))),
    getBackgroundJobPublisher().then(boss => boss.getQueues()).catch(() => null),
    pool.query(`SELECT provider,status,count(*)::int AS count FROM "ConnectedAccount" WHERE status<>'ACTIVE' GROUP BY provider,status LIMIT 20`),
    pool.query(`SELECT count(*)::int AS "customersAwaitingReconciliation" FROM "BillingCustomer" WHERE "providerCustomerId" IS NOT NULL AND ("lastReconciledAt" IS NULL OR "lastReconciledAt"<NOW()-INTERVAL '30 minutes')`),
  ]);
  const usage = ai.rows[0];
  return { release: operationsConfig().RELEASE_SHA, environment: operationsConfig().APP_ENV, windowHours: 24,
    ai: { ...usage, costPerActiveUserUsd: usage.activeUsers ? usage.estimatedCostUsd / usage.activeUsers : 0, agents: agents.rows, workflows: workflows.rows, providerHealth: health },
    jobs: jobs.rows, integrations: integrations.rows, reconnects: reconnects.rows, billing: billing.rows, reconciliation: reconciliation.rows[0], workers: workers.rows, database: database.rows[0],
    queues: queues?.map(queue => ({ name: queue.name, queued: queue.queuedCount, active: queue.activeCount, failed: queue.failedCount, ready: queue.readyCount, total: queue.totalCount })) ?? null,
    // First-token timing is not in the current persisted usage schema. Do not
    // mislabel total provider latency as TTFT or fabricate a baseline.
    firstTokenLatencyAvailable: false,
  };
}
let cached: { expires: number; value: ReturnType<typeof operationalMetrics> } | undefined;
export function cachedOperationalMetrics() {
  if (!cached || cached.expires < Date.now()) cached = { expires: Date.now() + 30000, value: operationalMetrics() };
  return cached.value;
}
