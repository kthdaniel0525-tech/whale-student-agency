import "server-only";
import { z } from "zod";
import { db } from "../../db/client";
import { resultSchema, type EvaluationResult, type EvaluationVersions } from "./types";
import { versionHash } from "./versions";
const id = z.string().min(1).max(160);
const linksSchema = z.object({ userId: id.optional(), requestId: id.optional(), usageRecordId: id.optional(), messageId: id.optional(), feedbackId: id.optional() }).strict();
const versionsSchema = z.object({ datasetVersion: id, promptVersion: id, routingVersion: id, contextVersion: id }).strict();
/** Server-only writer. IDs are verified together; model/cost attribution is never accepted from a client. */
export async function saveEvaluation(input: { result: EvaluationResult; versions: EvaluationVersions; links?: z.infer<typeof linksSchema>; judgeModel?: string; caseKey?: string }) {
  const result = resultSchema.parse(input.result), versions = versionsSchema.parse(input.versions), links = linksSchema.parse(input.links ?? {});
  const judgeModel = id.optional().parse(input.judgeModel), caseKey = id.optional().parse(input.caseKey);
  if (links.feedbackId && !links.messageId) throw new Error("EVAL_OWNERSHIP");
  if (!links.userId && Object.values(links).some(Boolean)) throw new Error("EVAL_OWNERSHIP");
  if (!links.messageId && !links.usageRecordId && !caseKey) throw new Error("EVAL_REFERENCE_REQUIRED");
  return db().$transaction(async tx => {
    const usage = links.usageRecordId ? await tx.aIUsageRecord.findFirst({ where: { id: links.usageRecordId, userId: links.userId } }) : null;
    const message = links.messageId ? await tx.conversationMessage.findFirst({ where: { id: links.messageId, userId: links.userId, role: "ASSISTANT" } }) : null;
    const feedback = links.feedbackId ? await tx.aIUserFeedback.findFirst({ where: { id: links.feedbackId, userId: links.userId, messageId: links.messageId } }) : null;
    if ((links.usageRecordId && !usage) || (links.messageId && !message) || (links.feedbackId && !feedback)) throw new Error("EVAL_OWNERSHIP");
    if (usage && message && (usage.requestId !== message.requestId || usage.conversationId !== message.conversationId)) throw new Error("EVAL_OWNERSHIP");
    const requestId = usage?.requestId ?? message?.requestId ?? links.requestId;
    if (links.requestId && requestId !== links.requestId) throw new Error("EVAL_OWNERSHIP");
    const data = { ...result, ...versions, ...links, requestId, judgeModel,
      model: usage?.model, provider: usage?.provider, selectedTier: usage?.selectedTier, fallbackUsed: usage?.fallbackUsed,
      agentId: usage?.agentId ?? message?.agentId, workflowId: usage?.workflowId,
      promptVersion: usage?.promptVersion ?? versions.promptVersion, routingVersion: usage?.routingVersion ?? versions.routingVersion, contextVersion: usage?.contextVersion ?? versions.contextVersion };
    const deduplicationKey = versionHash({ user: links.userId, ref: links.feedbackId ?? links.messageId ?? links.usageRecordId ?? caseKey, profile: result.profile, type: result.evaluationType, evaluator: result.evaluatorVersion, versions });
    return tx.aIEvaluationRecord.upsert({ where: { deduplicationKey }, create: { ...data, deduplicationKey }, update: result.evaluationType === "user-feedback" ? data : {} });
  });
}
