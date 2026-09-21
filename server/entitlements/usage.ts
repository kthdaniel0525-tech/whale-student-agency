import "server-only";
import { randomUUID } from "node:crypto";
import { CAPABILITIES, LIMITS, type Capability, type PublicEntitlements } from "@/lib/entitlements/types";
import type { AIUsageContext } from "../ai/usage/types";
import { db } from "../db/client";
import { assertEffectiveAccess, assertModelTier, assertWithinLimit, getUserEntitlements, lockEntitlementUser, type EffectiveEntitlements, type EntitlementClient } from "./service";

export function aiCapabilities(context: AIUsageContext): Capability[] {
  const keys: Capability[] = [];
  if (context.source?.startsWith("memory-")) keys.push("personalization.memory");
  else if (context.source === "rag-document") keys.push("academic.documents");
  else keys.push("ai.chat");
  const agent = `ai.${context.agentId}` as Capability;
  const workflow = `workflow.${context.workflowId}` as Capability;
  if (CAPABILITIES.includes(agent)) keys.push(agent);
  if (CAPABILITIES.includes(workflow)) keys.push(workflow);
  return keys;
}
export async function readUsage(effective: EffectiveEntitlements, tx: EntitlementClient = db(), now = new Date()) {
  const { start, end } = effective.period, userId = effective.userId;
  const [counts, workflowRuns, documentsProcessed] = await Promise.all([
    tx.$queryRaw<{ requests: bigint; tokens: bigint }[]>`
      WITH actual AS (SELECT id, "requestId", "totalTokens" FROM "AIUsageRecord" WHERE "userId"=${userId} AND "createdAt">=${start} AND "createdAt"<${end}),
      pending AS (SELECT a.id, a."requestId", a."reservedTokens" FROM "EntitlementUsageAdmission" a WHERE a."userId"=${userId} AND a.kind='ai' AND a."createdAt">=${start} AND a."createdAt"<${end} AND a."periodEnd">${now} AND NOT EXISTS (SELECT 1 FROM actual r WHERE r.id=a.id AND r."totalTokens" IS NOT NULL))
      SELECT (SELECT count(*) FROM (SELECT "requestId" FROM actual UNION SELECT "requestId" FROM pending) requests) AS requests,
      (COALESCE((SELECT sum("totalTokens") FROM actual),0)+COALESCE((SELECT sum("reservedTokens") FROM pending),0))::bigint AS tokens`,
    tx.workflowRun.count({ where: { userId, startedAt: { gte: start, lt: end } } }),
    tx.entitlementUsageAdmission.count({ where: { userId, kind: "document", createdAt: { gte: start, lt: end } } }),
  ]);
  return { aiRequests: Number(counts[0]?.requests ?? 0), aiTokens: Number(counts[0]?.tokens ?? 0), workflowRuns, documentsProcessed };
}
async function checkAI(context: AIUsageContext & { userId: string }, tokens: number, tx: EntitlementClient) {
  const effective = await getUserEntitlements(context.userId, tx);
  for (const key of aiCapabilities(context)) assertEffectiveAccess(effective, key);
  if (context.selectedTier) assertModelTier(effective.values, context.selectedTier);
  const usage = await readUsage(effective, tx);
  const existing = context.requestId && (await tx.aIUsageRecord.findFirst({ where: { userId: context.userId, requestId: context.requestId, createdAt: { gte: effective.period.start, lt: effective.period.end } }, select: { id: true } }) || await tx.entitlementUsageAdmission.findFirst({ where: { userId: context.userId, kind: "ai", requestId: context.requestId, createdAt: { gte: effective.period.start, lt: effective.period.end }, periodEnd: { gt: new Date() } }, select: { id: true } }));
  assertWithinLimit(effective.values, "ai.monthlyRequests", usage.aiRequests, existing ? 0 : 1);
  assertWithinLimit(effective.values, "ai.monthlyTokens", usage.aiTokens, Math.max(1, tokens));
  return effective;
}
export async function checkAIUsageAllowance(userId: string, context: AIUsageContext = {}, projectedTokens = 0) {
  return checkAI({ ...context, userId }, projectedTokens, db());
}
export type AIAllowanceService = { reserve(context: AIUsageContext, tokens: number, attemptId: string): Promise<{ release(): Promise<void> }> };
export const aiAllowances: AIAllowanceService = {
  async reserve(context, tokens, attemptId) {
    if (!context.userId) return { release: async () => {} }; // internal/offline, no authenticated owner
    const userId = context.userId;
    await db().$transaction(async tx => {
      await lockEntitlementUser(tx, userId);
      const effective = await checkAI({ ...context, userId }, tokens, tx);
      await tx.entitlementUsageAdmission.create({ data: { id: attemptId, userId, kind: "ai", requestId: context.requestId ?? randomUUID(), reservedTokens: Math.ceil(tokens), periodEnd: effective.period.end } });
    }, { timeout: 10000 });
    return { release: async () => { await db().entitlementUsageAdmission.deleteMany({ where: { id: attemptId, userId, kind: "ai" } }); } };
  },
};
export async function publicUserEntitlements(userId: string): Promise<PublicEntitlements> {
  const effective = await getUserEntitlements(userId);
  const usage = await readUsage(effective);
  return { plan: { code: effective.plan.code, name: effective.plan.name }, capabilities: Object.fromEntries(CAPABILITIES.map(key => [key, effective.values[key]])) as PublicEntitlements["capabilities"], limits: Object.fromEntries(LIMITS.map(key => [key, effective.values[key]])) as PublicEntitlements["limits"], maxModelTier: effective.values["ai.modelTier.max"], period: { start: effective.period.start.toISOString(), end: effective.period.end.toISOString() }, usage: { aiRequests: usage.aiRequests, workflowRuns: usage.workflowRuns, documentsProcessed: usage.documentsProcessed }, plansUrl: "/plans" };
}
