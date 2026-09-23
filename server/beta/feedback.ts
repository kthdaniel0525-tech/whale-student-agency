import "server-only";
import { db } from "../db/client";
import { RequestError } from "../api";
import { assertActiveUser } from "../privacy/account-state";
import { productFeedbackSchema, triageSchema } from "@/lib/product-analytics/feedback";
import { trackProductEvent } from "../product-analytics/service";
import { operationsConfig } from "../operations/config";
import { assertBetaAdmin } from "./access";

export async function createProductFeedback(userId: string, raw: unknown) {
  const input = productFeedbackSchema.parse(raw);
  await assertActiveUser(userId);
  if (input.requestId && !await db().aIUsageRecord.findFirst({ where: { userId, requestId: input.requestId }, select: { id: true } })) throw new RequestError("This request was not found.", 404);
  if (input.workflowRunId && !await db().workflowRun.findFirst({ where: { id: input.workflowRunId, userId }, select: { id: true } })) throw new RequestError("This workflow was not found.", 404);
  const existing = await db().productFeedback.findUnique({ where: { userId_submissionId: { userId, submissionId: input.submissionId } }, select: { id: true, status: true } });
  if (existing) return existing;
  // A private per-user limit prevents the feedback endpoint becoming a content sink.
  const result = await db().$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "User" WHERE id=${userId} FOR UPDATE`;
    if (await tx.productFeedback.count({ where: { userId, createdAt: { gte: new Date(Date.now() - 86400000) } } }) >= 20) throw new RequestError("Please try sending more feedback tomorrow.", 429);
    return tx.productFeedback.upsert({ where: { userId_submissionId: { userId, submissionId: input.submissionId } }, create: { ...input, rating: input.survey?.usefulness ?? input.rating, userId, appVersion: operationsConfig().RELEASE_SHA }, update: {}, select: { id: true, status: true } });
  });
  trackProductEvent(userId, input.survey ? "beta_survey_submitted" : "product_feedback_submitted", input.survey ? {} : { ...(input.feature ? { feature: input.feature } : {}) }, result.id);
  return result;
}
export async function feedbackPrompt(userId: string) {
  const [user, state, sent, completed] = await Promise.all([
    db().user.findUniqueOrThrow({ where: { id: userId }, select: { createdAt: true } }),
    db().productAnalyticsState.findUnique({ where: { userId } }),
    db().productFeedback.count({ where: { userId } }),
    db().workflowRun.count({ where: { userId, status: "COMPLETED" } }),
  ]);
  return { eligible: !sent && !state?.feedbackPromptDismissedAt && (completed > 0 || user.createdAt.getTime() < Date.now() - 7 * 86400000) };
}
export async function dismissFeedbackPrompt(userId: string) {
  await db().productAnalyticsState.upsert({ where: { userId }, create: { userId, feedbackPromptDismissedAt: new Date() }, update: { feedbackPromptDismissedAt: new Date() } });
}
export async function triageFeedback(adminId: string, id: string, raw: unknown) {
  await assertBetaAdmin(adminId);
  return db().productFeedback.update({ where: { id }, data: triageSchema.parse(raw), select: { id: true, status: true, severity: true } });
}
export async function listPrivateFeedback(adminId: string, cursor?: string) {
  await assertBetaAdmin(adminId);
  return db().productFeedback.findMany({ ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}), orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 50 });
}
