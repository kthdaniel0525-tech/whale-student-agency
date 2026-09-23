import { trackProductEvent } from "../../product-analytics/service";
import "server-only";
import { z } from "zod";
import { db } from "../../db/client";
import { RequestError } from "../../api";
import { saveEvaluation } from "./store";
import { PROFILE_IDS, type ProfileId } from "./types";
export const feedbackSchema = z.object({ rating: z.union([z.literal(-1), z.literal(1)]), reasonCode: z.enum(["INCORRECT", "NOT_HELPFUL", "TOO_LONG", "TOO_DIFFICULT", "WRONG_SOURCE", "USEFUL"]).nullable().optional(), comment: z.string().trim().max(1000).nullable().optional() }).strict();
export async function ownedAssistantMessage(userId: string, messageId: string) {
  const message = await db().conversationMessage.findFirst({ where: { id: messageId, userId, role: "ASSISTANT" } });
  const metadata = message?.metadata as Record<string, unknown> | null;
  if (!message || metadata?.workspaceVisible !== true) throw new RequestError("This response is unavailable.", 404);
  return message;
}
export async function getFeedback(userId: string, messageId: string) {
  await ownedAssistantMessage(userId, messageId);
  return db().aIUserFeedback.findUnique({ where: { userId_messageId: { userId, messageId } }, select: { rating: true, reasonCode: true, comment: true } });
}
export async function submitFeedback(userId: string, messageId: string, raw: unknown) {
  const input = feedbackSchema.parse(raw), message = await ownedAssistantMessage(userId, messageId);
  const usage = message.requestId ? await db().aIUsageRecord.findFirst({ where: { userId, requestId: message.requestId, conversationId: message.conversationId, success: true, operationType: { in: ["text-generation", "structured-output", "streaming"] }, agentId: message.agentId }, orderBy: { createdAt: "desc" } }) : null;
  const attribution = { requestId: message.requestId, usageRecordId: usage?.id, agentId: message.agentId, workflowId: usage?.workflowId };
  const saved = await db().aIUserFeedback.upsert({ where: { userId_messageId: { userId, messageId } }, create: { userId, messageId, ...attribution, ...input }, update: { ...attribution, ...input } });
  const profile = PROFILE_IDS.includes(message.agentId as ProfileId) ? message.agentId as ProfileId : "workflow";
  await saveEvaluation({ links: { userId, messageId, feedbackId: saved.id, ...(usage ? { usageRecordId: usage.id } : {}) }, versions: { datasetVersion: "user-feedback-v1", promptVersion: usage?.promptVersion ?? "unknown", routingVersion: usage?.routingVersion ?? "unknown", contextVersion: usage?.contextVersion ?? "unknown" }, result: { profile, evaluationType: "user-feedback", evaluatorVersion: "satisfaction-v1", score: Number(input.rating === 1), passed: null, dimensions: {}, failures: [], unmeasured: [], metrics: { positive: Number(input.rating === 1) }, checks: [] } });
  // Feedback is satisfaction evidence, never automatically a correctness label.
  if (input.rating === -1) await import("./sampling").then(m => m.maybeSampleResponse(userId, messageId, true)).catch(() => undefined);
  trackProductEvent(userId, "ai_feedback_submitted", { rating: saved.rating, ...(saved.agentId ? { agentId: saved.agentId } : {}), ...(saved.workflowId ? { workflowId: saved.workflowId } : {}), ...(z.string().uuid().safeParse(saved.requestId).success ? { requestId: saved.requestId } : {}) }, `${saved.id}:${saved.rating}`);
  return { rating: saved.rating, reasonCode: saved.reasonCode, comment: saved.comment };
}
