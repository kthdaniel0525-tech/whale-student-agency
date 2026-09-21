import "server-only";
import { z } from "zod";
import { Prisma } from "@/generated/prisma/client";
import { db } from "../../db/client";

const filterSchema = z.object({
  userId: z.string().min(1).max(200),
  start: z.date().optional(), end: z.date().optional(),
}).refine(v => !v.start || !v.end || v.start < v.end);
export type UsageFilter = z.infer<typeof filterSchema>;
type Group = "user" | "agent" | "workflow" | "model" | "day" | "operation" | "tier";
type UsageAggregate = {
  key: string | null; provider: string | null; kind: "generation" | "embedding";
  providerAttempts: number; successfulProviderAttempts: number; failedProviderAttempts: number;
  topLevelRequests: number; requestsWithSuccessfulProviderCalls: number;
  inputTokens: number; outputTokens: number; totalTokens: number;
  cachedInputTokens: number; reasoningTokens: number;
  estimatedTokenAttempts: number; unknownTokenAttempts: number; unpricedAttempts: number;
  estimatedCostUsd: number | null; averageLatencyMs: number; failureRate: number;
  ragProviderAttempts: number; ragTotalTokens: number; ragEstimatedCostUsd: number | null;
  averageContextTokens: number | null; compressedConversationAttempts: number;
  workflowRuns: number; averageCallsPerWorkflowRun: number | null;
  averageTokensPerWorkflowRun: number | null; averageCostPerWorkflowRun: number | null;
  averageProviderMsPerWorkflowRun: number | null;
};
/** Internal server APIs require a session-derived userId. There is deliberately
 * no optional user filter or cross-user/admin mode. All ranges are [start,end). */
async function aggregate(input: UsageFilter, group: Group) {
  const filter = filterSchema.parse(input);
  const key = {
    user: Prisma.sql`NULL::text`, agent: Prisma.sql`"agentId"`, workflow: Prisma.sql`"workflowId"`,
    model: Prisma.sql`model`, day: Prisma.sql`to_char("createdAt", 'YYYY-MM-DD')`, operation: Prisma.sql`"operationType"`,
    tier: Prisma.sql`"selectedTier"`,
  }[group];
  const provider = group === "model" ? Prisma.sql`provider` : Prisma.sql`NULL::text`;
  const rows = await db().$queryRaw<UsageAggregate[]>(Prisma.sql`
    SELECT ${key} AS key, ${provider} AS provider,
      CASE WHEN "operationType"='embedding' THEN 'embedding' ELSE 'generation' END AS kind,
      COUNT(*)::int AS "providerAttempts",
      COUNT(*) FILTER (WHERE success)::int AS "successfulProviderAttempts",
      COUNT(*) FILTER (WHERE NOT success)::int AS "failedProviderAttempts",
      COUNT(DISTINCT "requestId")::int AS "topLevelRequests",
      COUNT(DISTINCT "requestId") FILTER (WHERE success)::int AS "requestsWithSuccessfulProviderCalls",
      COALESCE(SUM("inputTokens"),0)::float8 AS "inputTokens",
      COALESCE(SUM("outputTokens"),0)::float8 AS "outputTokens",
      COALESCE(SUM("totalTokens"),0)::float8 AS "totalTokens",
      COALESCE(SUM("cachedInputTokens"),0)::float8 AS "cachedInputTokens",
      COALESCE(SUM("reasoningTokens"),0)::float8 AS "reasoningTokens",
      COUNT(*) FILTER (WHERE "usageSource"='estimated')::int AS "estimatedTokenAttempts",
      COUNT(*) FILTER (WHERE "usageSource"='unavailable')::int AS "unknownTokenAttempts",
      COUNT(*) FILTER (WHERE "estimatedCostUsd" IS NULL)::int AS "unpricedAttempts",
      SUM("estimatedCostUsd")::float8 AS "estimatedCostUsd",
      AVG("latencyMs")::float8 AS "averageLatencyMs",
      AVG(CASE WHEN success THEN 0 ELSE 1 END)::float8 AS "failureRate",
      COUNT(*) FILTER (WHERE "ragChunkCount">0 OR source IN ('rag-document','rag-query'))::int AS "ragProviderAttempts",
      COALESCE(SUM("totalTokens") FILTER (WHERE "ragChunkCount">0 OR source IN ('rag-document','rag-query')),0)::float8 AS "ragTotalTokens",
      SUM("estimatedCostUsd") FILTER (WHERE "ragChunkCount">0 OR source IN ('rag-document','rag-query'))::float8 AS "ragEstimatedCostUsd",
      AVG("estimatedContextTokens")::float8 AS "averageContextTokens",
      COUNT(*) FILTER (WHERE "conversationSummaryUsed")::int AS "compressedConversationAttempts",
      COUNT(DISTINCT "workflowRunId")::int AS "workflowRuns",
      COUNT(*) FILTER (WHERE "workflowRunId" IS NOT NULL)::float8 / NULLIF(COUNT(DISTINCT "workflowRunId"),0) AS "averageCallsPerWorkflowRun",
      SUM("totalTokens") FILTER (WHERE "workflowRunId" IS NOT NULL)::float8 / NULLIF(COUNT(DISTINCT "workflowRunId"),0) AS "averageTokensPerWorkflowRun",
      SUM("estimatedCostUsd") FILTER (WHERE "workflowRunId" IS NOT NULL)::float8 / NULLIF(COUNT(DISTINCT "workflowRunId"),0) AS "averageCostPerWorkflowRun",
      SUM("latencyMs") FILTER (WHERE "workflowRunId" IS NOT NULL)::float8 / NULLIF(COUNT(DISTINCT "workflowRunId"),0) AS "averageProviderMsPerWorkflowRun"
    FROM "AIUsageRecord"
    WHERE "userId"=${filter.userId}
      ${filter.start ? Prisma.sql`AND "createdAt">=${filter.start}` : Prisma.empty}
      ${filter.end ? Prisma.sql`AND "createdAt"<${filter.end}` : Prisma.empty}
    GROUP BY 1,2,3 ORDER BY 1,2,3 LIMIT 1001
  `);
  return { groups: rows.slice(0, 1000), truncated: rows.length > 1000 };
}
export const getUserAIUsage = (input: UsageFilter) => aggregate(input, "user");
export const getAgentUsage = (input: UsageFilter) => aggregate(input, "agent");
export const getWorkflowUsage = (input: UsageFilter) => aggregate(input, "workflow");
export const getModelUsage = (input: UsageFilter) => aggregate(input, "model");
export const getModelTierUsage = (input: UsageFilter) => aggregate(input, "tier");
export const getOperationUsage = (input: UsageFilter) => aggregate(input, "operation");
export function getDailyUsage(input: UsageFilter) {
  const end = input.end ?? new Date();
  const start = input.start ?? new Date(end.getTime() - 30 * 86400000);
  if (end.getTime() - start.getTime() > 366 * 86400000) throw new Error("Usage daily range must be at most 366 days.");
  return aggregate({ ...input, start, end }, "day");
}
export async function getUserUsageSummary(userId: string, now = new Date()) {
  const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const month = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const [today, currentMonth, lifetime] = await Promise.all([
    getUserAIUsage({ userId, start: day, end: now }),
    getUserAIUsage({ userId, start: month, end: now }),
    getUserAIUsage({ userId, end: now }),
  ]);
  return { timezone: "UTC", today, currentMonth, lifetime };
}

export async function getRequestUsage(userId: string, requestId: string) {
  filterSchema.parse({ userId });
  z.string().min(1).max(200).parse(requestId);
  const groups = await db().$queryRaw<Array<{
    operationType: string; agentId: string | null; workflowId: string | null; model: string; source: string | null;
    calls: number; successfulCalls: number; totalTokens: number; estimatedCostUsd: number | null;
    maximumContextTokens: number | null; ragChunksUsed: number; summariesUsed: number;
  }>>(Prisma.sql`
    SELECT "operationType","agentId","workflowId",model,source,COUNT(*)::int AS calls,
      COUNT(*) FILTER (WHERE success)::int AS "successfulCalls",COALESCE(SUM("totalTokens"),0)::float8 AS "totalTokens",
      SUM("estimatedCostUsd")::float8 AS "estimatedCostUsd", MAX("estimatedContextTokens") AS "maximumContextTokens",
      COALESCE(SUM("ragChunkCount"),0)::float8 AS "ragChunksUsed",COUNT(*) FILTER (WHERE "conversationSummaryUsed")::int AS "summariesUsed"
    FROM "AIUsageRecord" WHERE "userId"=${userId} AND "requestId"=${requestId}
    GROUP BY 1,2,3,4,5 ORDER BY calls DESC LIMIT 1001
  `);
  const aiCallCount = groups.reduce((sum, row) => sum + row.calls, 0);
  const routingCalls = groups.filter(r => r.operationType === "routing").reduce((sum, r) => sum + r.calls, 0);
  const repeatedOperations = groups.filter(r => r.operationType !== "embedding" && r.successfulCalls > 1);
  // Heuristics only. Legitimate workflow steps and retries may repeat metadata.
  return { requestId, aiCallCount, routingCalls, callExplosion: aiCallCount >= 20, repeatedRouting: routingCalls > 1,
    repeatedOperations: repeatedOperations.slice(0, 20), groups: groups.slice(0, 1000), truncated: groups.length > 1000 };
}

/** Bounded, ownership-scoped reliability aggregates; never reads prompt bodies. */
export async function getReliabilityMetrics(input: UsageFilter) {
  const f = filterSchema.parse(input), end = f.end ?? new Date(), start = f.start ?? new Date(end.getTime() - 30 * 86400000);
  const rows = await db().$queryRaw<Array<{ provider: string; model: string | null; attempts: number; successRate: number; timeoutRate: number; rateLimitRate: number; fallbackRate: number; fallbackSuccessRate: number | null; averageLatencyMs: number }>>(Prisma.sql`
    SELECT provider, model, COUNT(*)::int AS attempts, AVG(success::int)::float8 AS "successRate",
      AVG(CASE WHEN "failureClass"='timeout' THEN 1 ELSE 0 END)::float8 AS "timeoutRate",
      AVG(CASE WHEN "failureClass"='rate-limit' THEN 1 ELSE 0 END)::float8 AS "rateLimitRate",
      AVG(CASE WHEN "fallbackUsed" THEN 1 ELSE 0 END)::float8 AS "fallbackRate",
      AVG(success::int) FILTER (WHERE "fallbackUsed")::float8 AS "fallbackSuccessRate", AVG("latencyMs")::float8 AS "averageLatencyMs"
    FROM "AIUsageRecord" WHERE "userId"=${f.userId} AND "createdAt">=${start} AND "createdAt"<${end}
    GROUP BY GROUPING SETS ((provider), (provider,model)) ORDER BY provider,model LIMIT 1001
  `);
  const events = await db().aIGuardEvent.groupBy({ by: ["type"], where: { userId: f.userId, createdAt: { gte: start, lt: end }, type: { in: ["AI_CIRCUIT_OPEN", "AI_CIRCUIT_RECOVERED", "AI_AUTH_FAILURE"] } }, _count: { _all: true } });
  return { groups: rows.slice(0, 1000), truncated: rows.length > 1000, events };
}
