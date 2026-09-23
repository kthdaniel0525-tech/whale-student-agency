import "server-only";
import { Prisma } from "@/generated/prisma/client";
import { db } from "../db/client";
import { assertBetaAdmin } from "./access";
import { betaConfig, cohortSchema } from "./config";
import { analyticsConfig } from "../product-analytics/config";
import { deliveryHealth } from "../product-analytics/service";
import { z } from "zod";

const filterSchema = z.object({ days: z.number().int().min(1).max(90).default(30), cohort: cohortSchema.optional() }).strict();
type Filter = z.input<typeof filterSchema>;
const list = (values: readonly string[]) => Prisma.join(values.length ? values : ["__none__"]);
async function scope(adminId: string, filter: Filter) {
  await assertBetaAdmin(adminId);
  const { days, cohort } = filterSchema.parse(filter), config = analyticsConfig(), beta = betaConfig();
  const start = new Date(Date.now() - days * 86400000);
  const users = Prisma.sql`SELECT u.id FROM "User" u JOIN "BetaAccess" b ON b."userId"=u.id
    LEFT JOIN "ProductAnalyticsState" s ON s."userId"=u.id
    WHERE u."deletionRequestedAt" IS NULL AND b.status <> 'revoked' AND NOT b.internal
    AND NOT COALESCE(s."optedOut",false) AND u.id NOT IN (${list([...beta.admins, ...beta.internal])})
    ${cohort ? Prisma.sql`AND b.cohort=${cohort}` : Prisma.empty}`;
  const events = Prisma.sql`SELECT e.* FROM "ProductEvent" e WHERE e."userId" IN (${users}) AND e.environment=${config.environment}`;
  return { users, events, start, config };
}
const ratio = (a: number, b: number) => b ? Math.round(10000 * a / b) / 100 : null;

export async function getActivationFunnel(adminId: string, filter: Filter = {}) {
  const { users, events, config } = await scope(adminId, filter);
  const required = [...new Set(config.activation)];
  const rows = await db().$queryRaw<{ userId: string; name: string; first: Date }[]>`SELECT "userId",name,MIN("createdAt") AS first FROM (${events}) e GROUP BY "userId",name`;
  const byUser = new Map<string, Map<string, Date>>();
  for (const row of rows) { if (!byUser.has(row.userId)) byUser.set(row.userId, new Map()); byUser.get(row.userId)!.set(row.name, row.first); }
  const [{ total }] = await db().$queryRaw<{ total: number }[]>`SELECT COUNT(*)::int AS total FROM (${users}) u`;
  const milestones = ["signup_completed", "onboarding_completed", "course_created", "document_uploaded", "ai_request_completed", "quiz_completed", "study_plan_created"];
  // Cumulative funnel requires ordered first occurrences; activation is a separate
  // configurable AND definition, so skipping documents does not block activation.
  const stages = milestones.map((name, i) => ({ event: name, users: [...byUser.values()].filter(history => {
    let previous = 0;
    return milestones.slice(0, i + 1).every(key => { const value = history.get(key)?.getTime(); if (value === undefined || value < previous) return false; previous = value; return true; });
  }).length }));
  return { total, activated: [...byUser.values()].filter(history => required.every(event => history.has(event))).length, definition: required, stages, window: `Retained events (${config.retentionDays} days); pre-instrumentation activity is unknown.` };
}

export async function getRetentionMetrics(adminId: string, filter: Filter = {}) {
  const { events, config } = await scope(adminId, filter);
  const rows = await db().$queryRaw<{ day: number; eligible: number; returned: number }[]>`
    WITH activity AS (SELECT DISTINCT "userId", ("createdAt" AT TIME ZONE 'UTC')::date AS day FROM (${events}) e WHERE name IN (${list(config.meaningful)})),
    cohorts AS (SELECT "userId", MIN(day) AS first FROM activity GROUP BY "userId")
    SELECT n.day, COUNT(c."userId")::int AS eligible,
      COUNT(c."userId") FILTER (WHERE EXISTS (SELECT 1 FROM activity a WHERE a."userId"=c."userId" AND a.day=c.first+n.day))::int AS returned
    FROM (VALUES (1),(7),(30)) n(day) LEFT JOIN cohorts c ON c.first+n.day < (NOW() AT TIME ZONE 'UTC')::date GROUP BY n.day ORDER BY n.day`;
  return { definition: "Exact UTC day return after first observed meaningful activity; only fully elapsed days enter the denominator.", events: config.meaningful, cohorts: rows.map(r => ({ ...r, percent: ratio(r.returned, r.eligible) })) };
}

export async function getWorkflowMetrics(adminId: string, filter: Filter = {}) {
  const { users, start } = await scope(adminId, filter);
  const workflows = await db().$queryRaw<{ workflowId: string; starts: number; users: number; completed: number; failed: number; waiting: number; abandoned: number; repeatUsers: number; averageDurationMs: number | null }[]>`
    WITH runs AS (SELECT * FROM "WorkflowRun" WHERE "userId" IN (${users}) AND "startedAt">=${start})
    SELECT "workflowId",COUNT(*)::int AS starts,COUNT(DISTINCT "userId")::int AS users,
      COUNT(*) FILTER (WHERE status='COMPLETED')::int AS completed,COUNT(*) FILTER (WHERE status='FAILED')::int AS failed,
      COUNT(*) FILTER (WHERE status='WAITING_FOR_INPUT')::int AS waiting,
      COUNT(*) FILTER (WHERE status='WAITING_FOR_INPUT' AND "updatedAt" < NOW()-INTERVAL '72 hours')::int AS abandoned,
      (SELECT COUNT(*)::int FROM (SELECT "userId" FROM runs r2 WHERE r2."workflowId"=r."workflowId" GROUP BY "userId" HAVING COUNT(*)>1) repeated) AS "repeatUsers",
      AVG("activeDurationMs") FILTER (WHERE status='COMPLETED')::float AS "averageDurationMs" FROM runs r GROUP BY "workflowId"`;
  const steps = await db().$queryRaw<{ workflowId: string; position: number; started: number; completed: number; failed: number; skipped: number }[]>`
    SELECT r."workflowId",s.position, COUNT(*) FILTER (WHERE s.attempts>0)::int AS started, COUNT(*) FILTER (WHERE s.status='COMPLETED')::int AS completed,
      COUNT(*) FILTER (WHERE s.status='FAILED')::int AS failed, COUNT(*) FILTER (WHERE s.status='SKIPPED')::int AS skipped
    FROM "WorkflowStepRun" s JOIN "WorkflowRun" r ON r.id=s."workflowRunId" AND r."userId"=s."userId"
    WHERE r."userId" IN (${users}) AND r."startedAt">=${start} GROUP BY r."workflowId",s.position ORDER BY r."workflowId",s.position`;
  return { workflows: workflows.map(w => ({ ...w, completionPercent: ratio(w.completed, w.starts), failurePercent: ratio(w.failed, w.starts) })), steps, abandonmentDefinition: "Waiting without activity for 72 hours is a proxy, not proof the student abandoned the workflow." };
}

export async function getFeedbackSummary(adminId: string, filter: Filter = {}) {
  const { users, start } = await scope(adminId, filter);
  const product = await db().$queryRaw<{ category: string; status: string; severity: string | null; count: number; averageRating: number | null }[]>`SELECT category,status,severity,COUNT(*)::int AS count,AVG(rating)::float AS "averageRating" FROM "ProductFeedback" WHERE "userId" IN (${users}) AND "createdAt">=${start} GROUP BY category,status,severity`;
  const ai = await db().$queryRaw<{ agentId: string | null; workflowId: string | null; model: string | null; tier: string | null; votes: number; positive: number }[]>`
    SELECT f."agentId",f."workflowId",u.model,u."selectedTier" AS tier,COUNT(*)::int AS votes,COUNT(*) FILTER (WHERE f.rating=1)::int AS positive
    FROM "AIUserFeedback" f LEFT JOIN "AIUsageRecord" u ON u.id=f."usageRecordId" AND u."userId"=f."userId"
    WHERE f."userId" IN (${users}) AND f."createdAt">=${start} GROUP BY f."agentId",f."workflowId",u.model,u."selectedTier"`;
  return { product, ai, interpretation: "Satisfaction votes are not correctness labels. Private comments are available only through the separate internal feedback endpoint." };
}

export async function getBetaOverview(adminId: string, filter: Filter = {}) {
  const { users, events, start, config } = await scope(adminId, filter);
  const [activation, retention, workflows, feedback, activity, agents, reliability, recommendations, quizzes, billing, quality, failures, integrations] = await Promise.all([
    getActivationFunnel(adminId, filter), getRetentionMetrics(adminId, filter), getWorkflowMetrics(adminId, filter), getFeedbackSummary(adminId, filter),
    db().$queryRaw<{ weeklyActive: number; aiActive: number }[]>`SELECT COUNT(DISTINCT "userId") FILTER (WHERE name IN (${list(config.meaningful)}) AND "createdAt">NOW()-INTERVAL '7 days')::int AS "weeklyActive", COUNT(DISTINCT "userId") FILTER (WHERE name='ai_request_completed' AND "createdAt">=${start})::int AS "aiActive" FROM (${events}) e`,
    // Provider attempts, cost, latency, tier and fallback remain in AIUsageRecord.
    db().$queryRaw<{ agentId: string; users: number; calls: number; successfulCalls: number; repeatUsers: number; estimatedCostUsd: number; unpricedCalls: number; averageLatencyMs: number }[]>`
      WITH calls AS (SELECT * FROM "AIUsageRecord" WHERE "userId" IN (${users}) AND "createdAt">=${start} AND "agentId" IN ('tutor','notes','quiz','study-planner','academic-manager','career') AND "operationType" IN ('text-generation','structured-output','streaming'))
      SELECT "agentId",COUNT(DISTINCT "userId")::int AS users,COUNT(*)::int AS calls,COUNT(*) FILTER (WHERE success)::int AS "successfulCalls",
        (SELECT COUNT(*)::int FROM (SELECT "userId" FROM calls c2 WHERE c2."agentId"=c."agentId" GROUP BY "userId" HAVING COUNT(DISTINCT "requestId")>1) repeated) AS "repeatUsers",
        COALESCE(SUM("estimatedCostUsd"),0)::float AS "estimatedCostUsd",COUNT(*) FILTER (WHERE "estimatedCostUsd" IS NULL)::int AS "unpricedCalls",AVG("latencyMs")::float AS "averageLatencyMs" FROM calls c GROUP BY "agentId"`,
    db().$queryRaw<{ attempts: number; failures: number; fallbacks: number; timeouts: number }[]>`SELECT COUNT(*)::int AS attempts,COUNT(*) FILTER (WHERE NOT success)::int AS failures,COUNT(*) FILTER (WHERE "fallbackUsed")::int AS fallbacks,COUNT(*) FILTER (WHERE "errorCode"='TIMEOUT')::int AS timeouts FROM "AIUsageRecord" WHERE "userId" IN (${users}) AND "createdAt">=${start}`,
    db().$queryRaw<{ shown: number; clicked: number; completed: number }[]>`
      WITH e AS (SELECT * FROM (${events}) source WHERE "createdAt">=${start}),
      impressions AS (SELECT DISTINCT "userId",properties->>'recommendationKey' AS key FROM e WHERE name='recommendation_shown' AND properties->>'recommendationKey' IS NOT NULL)
      SELECT COUNT(*)::int AS shown,
        COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM e WHERE e."userId"=i."userId" AND e.name='recommendation_clicked' AND e.properties->>'recommendationKey'=i.key))::int AS clicked,
        COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM e WHERE e."userId"=i."userId" AND e.name='recommended_action_completed' AND e.properties->>'recommendationKey'=i.key))::int AS completed FROM impressions i`,
    db().$queryRaw<{ started: number; completed: number }[]>`SELECT COUNT(*)::int AS started,COUNT(*) FILTER (WHERE "completedAt" IS NOT NULL)::int AS completed FROM "QuizAttempt" WHERE "userId" IN (${users}) AND "startedAt">=${start}`,
    db().$queryRaw<{ name: string; users: number }[]>`SELECT name,COUNT(DISTINCT "userId")::int AS users FROM (${events}) e WHERE name IN ('plans_viewed','checkout_started','checkout_completed','subscription_started','subscription_cancelled') AND "createdAt">=${start} GROUP BY name`,
    db().$queryRaw<{ agentId: string | null; evaluationType: string; samples: number; averageScore: number | null }[]>`SELECT "agentId","evaluationType",COUNT(*)::int AS samples,AVG(score)::float AS "averageScore" FROM "AIEvaluationRecord" WHERE "userId" IN (${users}) AND "createdAt">=${start} GROUP BY "agentId","evaluationType"`,
    db().$queryRaw<{ feature: string; code: string; count: number }[]>`SELECT properties->>'feature' AS feature,properties->>'errorCode' AS code,COUNT(*)::int AS count FROM (${events}) e WHERE name='feature_failed' AND "createdAt">=${start} GROUP BY properties->>'feature',properties->>'errorCode' ORDER BY count DESC LIMIT 20`,
    db().$queryRaw<{ integrationType: string; status: string; count: number }[]>`SELECT s."integrationType",s.status,COUNT(*)::int AS count FROM "IntegrationSyncState" s JOIN "ConnectedAccount" a ON a.id=s."connectedAccountId" WHERE a."userId" IN (${users}) GROUP BY s."integrationType",s.status`,
  ]);
  return { environment: config.environment, analyticsEnabled: config.enabled, activation, retention, activity: activity[0], workflows, feedback,
    agents: agents.map(a => ({ ...a, providerCallSuccessPercent: ratio(a.successfulCalls, a.calls), costPerSuccessfulCall: a.successfulCalls ? a.estimatedCostUsd / a.successfulCalls : null })), reliability: reliability[0],
    recommendations: { ...recommendations[0], clickPercent: ratio(recommendations[0].clicked, recommendations[0].shown) }, quizzes: { ...quizzes[0], completionPercent: ratio(quizzes[0].completed, quizzes[0].started) }, billing, quality, failures, integrations, delivery: deliveryHealth(),
    coverage: "Behavior events are best effort. Provider attempts differ from completed user actions; workflows/quizzes use canonical state. No historical content is copied or silently backfilled." };
}

export async function getLaunchReadiness(adminId: string) {
  await assertBetaAdmin(adminId);
  const critical = await db().productFeedback.count({ where: { status: { not: "resolved" }, severity: { in: ["P0", "P1"] } } });
  return { openCriticalIssues: critical, blocked: critical > 0, requiresOperatorReview: true,
    note: "Zero reported blockers is not launch approval. Review security, data recovery, billing integrity, core journeys, provider incidents and live deployment checklist." };
}
