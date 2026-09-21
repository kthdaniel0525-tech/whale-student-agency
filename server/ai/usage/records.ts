import "server-only";
import { z } from "zod";
import { db } from "../../db/client";
import { AI_OPERATIONS, AI_SOURCES } from "./types";
import { MODEL_TIERS, COMPLEXITY_LEVELS, ROUTING_METHODS } from "../routing/types";
import { FAILURE_CLASSES } from "../reliability/failures";
import { AI_GUARD_CODES } from "../errors";

const count = z.number().int().nonnegative().max(2_147_483_647);
const id = z.string().min(1).max(200).regex(/^[A-Za-z0-9_.:/@+-]+$/);
export const usageRecordSchema = z.object({
  id, userId: id, provider: id, model: id, requestId: id,
  promptVersion: id.optional(), routingVersion: id.optional(), contextVersion: id.optional(),
  selectedModel: id.optional(), selectedTier: z.enum(MODEL_TIERS).optional(),
  routingComplexity: z.enum(COMPLEXITY_LEVELS).optional(), routingReasonCode: id.optional(),
  routingMethod: z.enum(ROUTING_METHODS).optional(), fallbackUsed: z.boolean().optional(),
  primaryProvider: id.optional(), primaryModel: id.optional(), attemptNumber: count.optional(), fallbackDepth: count.optional(),
  fallbackFromProvider: id.optional(), fallbackFromModel: id.optional(), finalProvider: id.optional(),
  failureClass: z.enum(FAILURE_CLASSES).optional(), streamStarted: z.boolean().optional(), tokensEmitted: count.optional(),
  operationType: z.enum(AI_OPERATIONS),
  agentId: id.nullish(), workflowId: id.optional(), workflowRunId: id.optional(), conversationId: id.optional(),
  inputTokens: count.nullable(), outputTokens: count.nullable(), totalTokens: count.nullable(),
  cachedInputTokens: count.optional(), reasoningTokens: count.optional(),
  usageSource: z.enum(["provider", "estimated", "unavailable"]),
  estimatedCostUsd: z.number().finite().nonnegative().nullable(), pricingVersion: id.nullable(),
  latencyMs: count, success: z.boolean(),
  errorCode: z.enum(["CONFIGURATION", "AUTHENTICATION", "RATE_LIMIT", "PROVIDER_FAILURE", "INVALID_REQUEST", "INVALID_RESPONSE", "CANCELLED", "TIMEOUT", "UNSUPPORTED_CAPABILITY", "CONTEXT_TOO_LARGE", "AI_SERVICE_TEMPORARILY_UNAVAILABLE", "AI_STREAM_INTERRUPTED", ...AI_GUARD_CODES]).optional(),
  source: z.enum(AI_SOURCES).optional(), batchSize: count.optional(),
  estimatedContextTokens: count.optional(), ragChunkCount: count.optional(), retrievedTokenEstimate: count.optional(),
  memoriesUsed: count.optional(), personalizationFieldsUsed: count.optional(),
  conversationSummaryUsed: z.boolean().optional(), recentMessageCount: count.optional(), historicalMessageCount: count.optional(), estimatedConversationTokens: count.optional(),
  createdAt: z.date(),
});
export type UsageRecordInput = z.infer<typeof usageRecordSchema>;

/** Server-internal write. The allowlist strips unknown keys; no prompt/error body
 * can enter storage. Stable attempt IDs make repeat delivery a no-op. */
export async function writeUsageRecord(input: UsageRecordInput) {
  const data = usageRecordSchema.parse(input);
  await db().$transaction(async tx => {
    if (data.workflowRunId && !await tx.workflowRun.findFirst({ where: { id: data.workflowRunId, userId: data.userId, workflowId: data.workflowId }, select: { id: true } }))
      throw new Error("USAGE_OWNERSHIP");
    if (data.conversationId && !await tx.conversation.findFirst({ where: { id: data.conversationId, userId: data.userId }, select: { id: true } }))
      throw new Error("USAGE_OWNERSHIP");
    // No update path: changing prices or retrying persistence cannot rewrite history.
    await tx.aIUsageRecord.createMany({ data: [data], skipDuplicates: true });
  }, { timeout: 2000, maxWait: 1000 });
}
