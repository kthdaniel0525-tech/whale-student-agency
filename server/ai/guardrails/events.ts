import "server-only";
import { db } from "../../db/client";
import type { AIUsageContext } from "../usage/types";
export type GuardEvent = { context: AIUsageContext; type: string; provider?: string; model?: string; snapshot?: Record<string, number> };
export async function recordGuardEvent(event: GuardEvent) {
  try {
    const data = { userId: event.context.userId, requestId: event.context.requestId ?? "system",
      type: event.type, provider: event.provider, model: event.model, agentId: event.context.agentId, workflowId: event.context.workflowId,
      modelTier: event.context.selectedTier, snapshot: event.snapshot ?? {} };
    if (event.context.userId === undefined) {
      await db().aIGuardEvent.create({ data });
      return;
    }
    await db().$transaction(async tx => {
      // Account deletion locks the same owner before purging telemetry. A late
      // provider completion must not recreate orphan identifiers after deletion.
      const owners = await tx.$queryRaw<{ deletionRequestedAt: Date | null }[]>`
        SELECT "deletionRequestedAt" FROM "User" WHERE id=${event.context.userId} FOR UPDATE
      `;
      if (!owners.length || owners[0].deletionRequestedAt) return;
      await tx.aIGuardEvent.create({ data });
    }, { timeout: 2000, maxWait: 1000 });
  } catch { console.warn("AI guardrail event unavailable", { code: "GUARD_EVENT_WRITE_FAILED" }); }
}
export async function getGuardrailMetrics(userId: string, start = new Date(Date.now() - 86400000)) {
  if (!userId) throw new Error("GUARD_OWNER_REQUIRED");
  return db().aIGuardEvent.groupBy({ by: ["type"], where: { userId, createdAt: { gte: start } }, _count: { _all: true } });
}
