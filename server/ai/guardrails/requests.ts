import "server-only";
import { randomUUID } from "node:crypto";
import { AIError } from "../errors";
import type { AIUsageContext } from "../usage/types";
import { guardKey } from "./store";
import { guardrails, type GuardrailService } from "./service";

/** One shared claim across JSON/stream endpoints. Persist only a hash and result
 * reference. Completed content is replayed from owned ConversationMessage rows. */
export async function claimAIRequest(context: AIUsageContext, turnId: string, normalizedInput: unknown, service: GuardrailService = guardrails) {
  const key = guardKey("dedupe", context.userId, turnId), fingerprint = guardKey(JSON.stringify(normalizedInput)), token = randomUUID();
  const concurrencyKey = guardKey("request-concurrency", context.userId);
  return service.checked(context, async () => {
    const prior = await service.store.transaction([key, concurrencyKey], (tx, now) => {
      const state = tx.get(key)?.data;
      if (state) {
        if (state.fingerprint !== fingerprint || state.status !== "completed") throw new AIError("AI_DUPLICATE_REQUEST");
        return typeof state.conversationId === "string" ? state.conversationId : null;
      }
      const config = service.config();
      const leases = ((tx.get(concurrencyKey)?.data.leases ?? []) as Array<{ token: string; until: number }>).filter(l => l.until > now);
      if (leases.length >= config.concurrency.user) throw new AIError("AI_CONCURRENCY_LIMIT");
      const until = now + Math.max(...Object.values(config.profiles).map(p => p.deadlineMs)) + 60000;
      tx.set(concurrencyKey, { data: { leases: [...leases, { token, until }] }, expiresAt: until });
      tx.set(key, { data: { fingerprint, token, status: "running" }, expiresAt: now + 30 * 86400000 });
      return undefined;
    });
    return {
      replay: prior !== undefined, conversationId: prior,
      async complete(conversationId?: string) {
        await service.store.transaction([key, concurrencyKey], (tx, now) => {
          const current = tx.get(key)?.data;
          if (current?.token !== token) return;
          const leases = ((tx.get(concurrencyKey)?.data.leases ?? []) as Array<{ token: string; until: number }>).filter(l => l.token !== token && l.until > now);
          tx.set(concurrencyKey, { data: { leases }, expiresAt: now + 900000 });
          tx.set(key, { data: { ...current, status: conversationId ? "completed" : "stopped", ...(conversationId ? { conversationId } : {}) }, expiresAt: now + 30 * 86400000 });
        });
      },
    };
  });
}
