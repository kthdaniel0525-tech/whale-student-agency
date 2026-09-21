import "server-only";
import { z } from "zod";
import { db } from "../db/client";
import { parseSources } from "../assistant/presentation";
import { evaluateDeterministic } from "../ai/evaluation/deterministic";
import { evaluateWithJudge, JUDGE_VERSION } from "../ai/evaluation/judge";
import { hasEvaluationConsent, samplingConfig } from "../ai/evaluation/sampling";
import { saveEvaluation } from "../ai/evaluation/store";
import type { AIProvider } from "../ai/types";
import type { EvaluationContext } from "../ai/evaluation/types";
import type { BackgroundJob, BackgroundJobResult } from "./types";
const id = z.string().min(1).max(160);
export const evaluationJobPayload = z.object({ version: z.literal(1), trackingId: id, userId: id, messageId: id, requestId: id, usageRecordId: id, policyVersion: id }).strict();
export type EvaluationJobPayload = z.infer<typeof evaluationJobPayload>;
export async function loadEvaluationContext(payload: EvaluationJobPayload): Promise<EvaluationContext | null> {
  const message = await db().conversationMessage.findFirst({ where: { id: payload.messageId, userId: payload.userId, requestId: payload.requestId, role: "ASSISTANT" } });
  const metadata = message?.metadata as Record<string, unknown> | null;
  if (!message || metadata?.workspaceVisible !== true || !["tutor", "notes"].includes(message.agentId ?? "")) return null;
  const usage = await db().aIUsageRecord.findFirst({ where: { id: payload.usageRecordId, userId: payload.userId, requestId: payload.requestId, conversationId: message.conversationId, agentId: message.agentId, success: true } });
  if (!usage || !["text-generation", "streaming"].includes(usage.operationType)) return null;
  const request = await db().conversationMessage.findFirst({ where: { userId: payload.userId, conversationId: message.conversationId, role: "USER", ...(message.turnId ? { turnId: message.turnId } : { requestId: payload.requestId }), sequence: { lt: message.sequence } }, orderBy: { sequence: "desc" } });
  if (!request) return null;
  const refs = parseSources(metadata?.sourceRefs);
  // Existing source references only; edited/deleted documents cannot stand in for historical evidence.
  const chunks = refs.length ? await db().documentChunk.findMany({ where: { userId: payload.userId, OR: refs.map(r => ({ documentId: r.documentId, chunkIndex: r.chunkIndex })), document: { userId: payload.userId, updatedAt: { lte: message.createdAt } } }, take: 20 }) : [];
  if (refs.some(r => !chunks.some(c => c.documentId === r.documentId && c.chunkIndex === r.chunkIndex))) return null;
  return { profile: message.agentId as "tutor" | "notes", request: request.content, output: message.content,
    sources: chunks.map(c => ({ id: `${c.documentId}:${c.chunkIndex}`, documentId: c.documentId, chunkIndex: c.chunkIndex, content: c.content })), citedSourceIds: refs.map(r => `${r.documentId}:${r.chunkIndex}`), requiresGrounding: refs.length > 0 };
}
export function createEvaluateAIResponseJob(getProvider: () => AIProvider | Promise<AIProvider> = () => import("../ai").then(m => m.getAIProvider())): BackgroundJob<EvaluationJobPayload> {
  return { name: "evaluate-ai-response", version: 1, payloadSchema: evaluationJobPayload,
    retryPolicy: { limit: 0, delaySeconds: 5, maximumDelaySeconds: 30, exponentialBackoff: true }, timeoutSeconds: 120, priority: "low", executionScope: "user", concurrency: { scope: "user", limit: 1 }, debounceSeconds: 60,
    async handler({ payload, signal }): Promise<BackgroundJobResult> {
      const config = samplingConfig();
      if (!config.enabled || config.policyVersion !== payload.policyVersion || !await hasEvaluationConsent(payload.userId, payload.policyVersion)) return { skipped: true, reason: "NO_CONSENT" };
      const context = await loadEvaluationContext(payload);
      if (!context) return { skipped: true, reason: "MISSING_OWNED_DATA" };
      if (signal.aborted) throw new Error("EVAL_CANCELLED");
      const links = { userId: payload.userId, messageId: payload.messageId, requestId: payload.requestId, usageRecordId: payload.usageRecordId };
      const versions = { datasetVersion: `opt-in:${payload.policyVersion}`, promptVersion: "unknown", routingVersion: "unknown", contextVersion: "unknown" };
      await saveEvaluation({ links, versions, result: evaluateDeterministic(context) });
      const existing = await db().aIEvaluationRecord.findFirst({ where: { userId: payload.userId, messageId: payload.messageId, evaluationType: "model-based", datasetVersion: versions.datasetVersion, evaluatorVersion: { endsWith: JUDGE_VERSION } }, select: { id: true } });
      if (existing) return { skipped: true, reason: "ALREADY_EVALUATED" };
      // Recheck consent immediately before any paid/content-sharing boundary.
      if (!await hasEvaluationConsent(payload.userId, payload.policyVersion)) return { skipped: true, reason: "CONSENT_REVOKED" };
      const { result, judgeModel } = await evaluateWithJudge(context, { provider: await getProvider(), userId: payload.userId, signal });
      await saveEvaluation({ links, versions, result, judgeModel });
      return { evaluated: true, passed: result.passed, score: result.score };
    } };
}
export const evaluateAIResponseJob = createEvaluateAIResponseJob();
