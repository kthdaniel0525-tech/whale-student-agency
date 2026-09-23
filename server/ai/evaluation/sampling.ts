import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import { db } from "../../db/client";
import { RequestError } from "../../api";
const configSchema = z.object({ enabled: z.boolean(), policyVersion: z.string().max(100), policyUrl: z.string(), rate: z.number().min(0).max(.05) });
export function samplingConfig() {
  const config = configSchema.parse({ enabled: process.env.AI_EVAL_SAMPLING_ENABLED === "true", policyVersion: process.env.AI_EVAL_POLICY_VERSION ?? "", policyUrl: process.env.AI_EVAL_POLICY_URL ?? "", rate: Number(process.env.AI_EVAL_SAMPLE_RATE ?? .01) });
  if (config.enabled && (!config.policyVersion || !z.string().url().safeParse(config.policyUrl).success)) throw new Error("EVAL_POLICY_REQUIRED");
  return config;
}
export async function hasEvaluationConsent(userId: string, policyVersion: string) {
  if (!policyVersion) return false;
  const profile = await db().profile.findUnique({ where: { userId }, select: { aiEvaluationConsentVersion: true } });
  return profile?.aiEvaluationConsentVersion === policyVersion;
}
export async function setEvaluationConsent(userId: string, input: { enabled: boolean; policyVersion?: string }) {
  if (!input.enabled) {
    await db().profile.update({ where: { userId }, data: { aiEvaluationConsentVersion: null, aiEvaluationConsentAt: null } });
    return { enabled: false, policyVersion: null };
  }
  const config = samplingConfig();
  if (input.enabled && (!config.enabled || input.policyVersion !== config.policyVersion)) throw new RequestError("Evaluation sampling is not available under this policy.", 400);
  await db().profile.update({ where: { userId }, data: { aiEvaluationConsentVersion: input.enabled ? config.policyVersion : null, aiEvaluationConsentAt: input.enabled ? new Date() : null } });
  return { enabled: input.enabled, policyVersion: input.enabled ? config.policyVersion : null };
}
export function selectedForSampling(key: string, rate: number, highValue = false) {
  const fraction = createHash("sha256").update(key).digest().readUInt32BE(0) / 2 ** 32;
  return fraction < Math.min(.05, rate * (highValue ? 3 : 1));
}
export async function maybeSampleResponse(userId: string, messageId: string, lowRating = false) {
  const config = samplingConfig();
  if (!config.enabled || !await hasEvaluationConsent(userId, config.policyVersion)) return { queued: false };
  const message = await db().conversationMessage.findFirst({ where: { id: messageId, userId, role: "ASSISTANT", agentId: { in: ["tutor", "notes"] } } });
  const metadata = message?.metadata as Record<string, unknown> | null;
  if (!message?.requestId || metadata?.workspaceVisible !== true) return { queued: false };
  const usage = await db().aIUsageRecord.findFirst({ where: { userId, requestId: message.requestId, conversationId: message.conversationId, agentId: message.agentId, success: true, operationType: { in: ["text-generation", "streaming"] } }, orderBy: { createdAt: "desc" } });
  if (!usage || !selectedForSampling(`${config.policyVersion}:${messageId}`, config.rate, lowRating || usage.fallbackUsed === true)) return { queued: false };
  const { enqueueTrackedUserJob } = await import("../../jobs/enqueue");
  const { evaluateAIResponseJob } = await import("../../jobs/evaluate-ai-response");
  await enqueueTrackedUserJob(evaluateAIResponseJob, userId, { resourceId: messageId, idempotencyKey: `eval:${config.policyVersion}:${messageId}`, debounceKey: messageId }, { payload: { messageId, requestId: message.requestId, usageRecordId: usage.id, policyVersion: config.policyVersion } });
  return { queued: true };
}
