import "server-only";
import { randomUUID } from "node:crypto";
import { AIError, type AIErrorCode } from "../errors";
import { MODEL_TIERS } from "../routing/types";
import type { AIUsage } from "../types";
import type { AIUsageContext } from "../usage/types";
import { getGuardrailConfig, type AIExecutionBudget, type BudgetProfile, type GuardrailConfig } from "./config";
import { guardKey, postgresGuardStore, type GuardStore, type GuardTransaction } from "./store";
import { recordGuardEvent, type GuardEvent } from "./events";
import { db } from "../../db/client";

type Counters = { calls: number; embeddings: number; input: number; output: number; total: number; steps: number; cost: number;
  started: number; profile: BudgetProfile; callLimit?: number; stepLimit?: number; agents: Record<string, number>; fingerprints: Record<string, number>; stepIds: string[]; softNotified: boolean };
type Reservation = { context: AIUsageContext; provider: string; model: string; inputTokens: number; outputTokens: number; embedding: boolean; fingerprint: string };
type BudgetScope = { key: string; workflow: boolean };
const lifetime = 30 * 86400000;
const reported = new WeakSet<Error>();
const isBackground = (c: AIUsageContext) => Boolean(c.backgroundJobId || c.source === "rag-document" || c.guardProfile === "BACKGROUND");
const empty = (now: number, profile: BudgetProfile): Counters => ({ calls: 0, embeddings: 0, input: 0, output: 0, total: 0, steps: 0, cost: 0, started: now, profile, agents: {}, fingerprints: {}, stepIds: [], softNotified: false });
function profileFor(c: AIUsageContext): BudgetProfile {
  if (isBackground(c)) return "BACKGROUND";
  if (c.workflowRunId || c.workflowId) return "WORKFLOW";
  if (c.guardProfile) return c.guardProfile;
  if (c.selectedTier === "REASONING") return "HIGH_COMPLEXITY";
  if (c.selectedTier === "STRONG") return "COMPLEX";
  if (c.selectedTier === "FAST") return "SIMPLE";
  return "STANDARD";
}
const scopes = (c: AIUsageContext): BudgetScope[] => [
  { key: guardKey("request", c.userId, c.requestId), workflow: false },
  ...(c.workflowRunId ? [{ key: guardKey("workflow", c.userId, c.workflowRunId), workflow: true }] : []),
];
const snapshot = (s: Counters) => ({ aiCalls: s.calls, embeddingCalls: s.embeddings, inputTokens: s.input, outputTokens: s.output, totalTokens: s.total, workflowSteps: s.steps });
function takeToken(tx: GuardTransaction, key: string, capacity: number, period: number, now: number, code: AIErrorCode) {
  const old = tx.get(key)?.data as { tokens?: number; at?: number } | undefined;
  const tokens = Math.min(capacity, (old?.tokens ?? capacity) + Math.max(0, now - (old?.at ?? now)) * capacity / period);
  if (tokens < 1) throw new AIError(code);
  tx.set(key, { data: { tokens: tokens - 1, at: now }, expiresAt: now + period * 2 });
}
function lease(tx: GuardTransaction, key: string, id: string, max: number, until: number, now: number) {
  const active = ((tx.get(key)?.data.leases ?? []) as Array<{ id: string; until: number }>).filter(v => v.until > now);
  if (active.length >= max) throw new AIError("AI_CONCURRENCY_LIMIT");
  tx.set(key, { data: { leases: [...active, { id, until }] }, expiresAt: Math.max(until, ...active.map(l => l.until)) });
}
function release(tx: GuardTransaction, key: string, id: string, now: number) {
  const active = ((tx.get(key)?.data.leases ?? []) as Array<{ id: string; until: number }>).filter(v => v.id !== id && v.until > now);
  tx.set(key, { data: { leases: active }, expiresAt: Math.max(now + 1000, ...active.map(l => l.until)) });
}

export class GuardrailService {
  constructor(readonly store: GuardStore = postgresGuardStore, readonly config: () => GuardrailConfig = getGuardrailConfig,
    readonly emit: (event: GuardEvent) => Promise<void> = recordGuardEvent,
    readonly userCost: (userId: string) => Promise<number | null> = async () => null) {}
  async checked<T>(context: AIUsageContext, work: () => Promise<T>): Promise<T> {
    try { return await work(); }
    catch (cause) {
      const error = cause instanceof AIError ? cause : new AIError("AI_GUARD_STORAGE_UNAVAILABLE");
      if (!reported.has(error)) { reported.add(error); await this.emit({ context, type: error.code }).catch(() => {}); }
      throw error;
    }
  }
  assertEnabled(context: AIUsageContext) {
    const config = this.config();
    if (config.disableAllAI || (config.disableBackgroundAI && isBackground(context))
      || [context.guardFeature, context.workflowId, context.source].some(f => f && config.disabledFeatures.includes(f))) throw new AIError("AI_FEATURE_DISABLED");
  }
  async admit(context: AIUsageContext, workflowStart = false) {
    return this.checked(context, async () => {
      this.assertEnabled(context);
      const config = this.config(), key = guardKey("admitted", context.userId, context.requestId);
      const category = isBackground(context) ? "background" : "interactive";
      const minute = guardKey("rate", context.userId, category, "minute"), hour = guardKey("rate", context.userId, category, "hour");
      const workflow = guardKey("rate", context.userId, "workflow");
      const costKey = guardKey("cost-observation", context.userId);
      const checkCost = await this.store.transaction([key, minute, hour, workflow, costKey], (tx, now) => {
        const saved = tx.get(key)?.data;
        if (!saved) {
          if (category === "interactive") takeToken(tx, minute, config.rates.interactiveMinute, 60000, now, "AI_REQUEST_RATE_LIMITED");
          takeToken(tx, hour, category === "background" ? config.rates.backgroundHour : config.rates.interactiveHour, 3600000, now, "AI_REQUEST_RATE_LIMITED");
        }
        if (workflowStart && !saved?.workflow) takeToken(tx, workflow, config.rates.workflowHour, 3600000, now, "AI_REQUEST_RATE_LIMITED");
        tx.set(key, { data: { workflow: !!saved?.workflow || workflowStart }, expiresAt: now + lifetime });
        if (context.userId && !tx.get(costKey)) {
          tx.set(costKey, { data: {}, expiresAt: now + 300000 }); return true;
        }
        return false;
      });
      if (checkCost && context.userId) {
        const cost = await this.userCost(context.userId).catch(() => null);
        if (cost !== null && cost >= config.userSoftCostUsd) await this.emit({ context, type: "AI_USER_SOFT_COST_THRESHOLD" }).catch(() => {});
      }
    });
  }
  async reserve(input: Reservation) {
    const c = input.context;
    return this.checked(c, async () => {
      this.assertEnabled(c);
      const config = this.config();
      if (input.inputTokens > (input.embedding ? config.maxEmbeddingInputTokens : config.maxContextTokens)) throw new AIError(input.embedding ? "AI_EMBEDDING_LIMIT" : "AI_CONTEXT_LIMIT");
      await this.admit(c);
      const id = randomUUID(), budgetScopes = scopes(c), requestedProfile = profileFor(c);
      const leaseKeys = [guardKey("concurrency-user", c.userId), guardKey("concurrency-provider", input.provider), guardKey("concurrency-model", input.provider, input.model)];
      if (requestedProfile === "BACKGROUND") leaseKeys.push(guardKey("concurrency-background"));
      const embeddingKeys = [guardKey("embedding-minute", c.userId), guardKey("embedding-hour", c.userId)];
      const result = await this.store.transaction([...budgetScopes.map(s => s.key), ...leaseKeys, ...embeddingKeys], (tx, now) => {
        let remaining = config.profiles[requestedProfile].deadlineMs;
        for (const scope of budgetScopes) {
          const saved = tx.get(scope.key)?.data as unknown as Counters | undefined;
          const state = saved ?? empty(now, scope.workflow ? "WORKFLOW" : requestedProfile);
          // A trusted workflow/model escalation expands the existing accounting;
          // child calls never reset spent counters or start a new unlimited scope.
          const budget = this.budget(state.profile, scope.workflow ? "WORKFLOW" : requestedProfile, config);
          if (config.profiles[requestedProfile].maxTotalTokens > config.profiles[state.profile].maxTotalTokens) state.profile = requestedProfile;
          if (!scope.workflow) remaining = Math.min(remaining, budget.deadlineMs - (now - state.started));
          if (remaining <= 0) throw new AIError("AI_REQUEST_BUDGET_EXCEEDED");
          if (scope.workflow && c.guardWorkflowCalls) state.callLimit = Math.min(state.callLimit ?? budget.maxAICalls, c.guardWorkflowCalls);
          const maxCalls = Math.min(budget.maxAICalls, state.callLimit ?? budget.maxAICalls);
          if ((!input.embedding && state.calls >= maxCalls) || state.input + input.inputTokens > budget.maxInputTokens
            || state.output + input.outputTokens > budget.maxOutputTokens || state.total + input.inputTokens + input.outputTokens > budget.maxTotalTokens) throw new AIError("AI_REQUEST_BUDGET_EXCEEDED");
          if (input.embedding && state.embeddings >= budget.maxEmbeddingCalls) throw new AIError("AI_EMBEDDING_LIMIT");
          const purpose = guardKey(c.agentId, c.workflowStepId, c.operationType, c.source);
          if (!input.embedding && (state.agents[purpose] ?? 0) >= budget.maxAgentCalls) throw new AIError("AI_REQUEST_BUDGET_EXCEEDED");
          if (!input.embedding && (state.fingerprints[input.fingerprint] ?? 0) >= budget.maxRepeatedCalls) throw new AIError("AI_REQUEST_BUDGET_EXCEEDED");
          const floorRank = Math.max(MODEL_TIERS.indexOf(config.profiles[requestedProfile].qualityFloorTier), MODEL_TIERS.indexOf(c.guardQualityFloorTier ?? "FAST"));
          if (c.selectedTier && !input.embedding && !["routing", "summarization", "semantic-classification"].includes(c.operationType ?? "")
            && MODEL_TIERS.indexOf(c.selectedTier) < floorRank) throw new AIError("AI_REQUEST_BUDGET_EXCEEDED");
          state.calls += input.embedding ? 0 : 1; state.embeddings += input.embedding ? 1 : 0;
          state.input += input.inputTokens; state.output += input.outputTokens; state.total += input.inputTokens + input.outputTokens;
          if (!input.embedding) { state.agents[purpose] = (state.agents[purpose] ?? 0) + 1; state.fingerprints[input.fingerprint] = (state.fingerprints[input.fingerprint] ?? 0) + 1; }
          tx.set(scope.key, { data: { ...state }, expiresAt: now + lifetime });
        }
        if (input.embedding) {
          takeToken(tx, embeddingKeys[0], config.rates.embeddingMinute, 60000, now, "AI_EMBEDDING_LIMIT");
          takeToken(tx, embeddingKeys[1], config.rates.embeddingHour, 3600000, now, "AI_EMBEDDING_LIMIT");
        }
        const until = now + remaining + 60000;
        const background = requestedProfile === "BACKGROUND";
        // Leave capacity for foreground work even when one student's jobs fan out.
        const userLimit = background ? Math.max(1, config.concurrency.user - 1) : config.concurrency.user;
        const backgroundLimit = Math.min(config.concurrency.background, Math.max(1, config.concurrency.provider - 1), Math.max(1, config.concurrency.model - 1));
        leaseKeys.forEach((key, index) => lease(tx, key, id, [userLimit, config.concurrency.provider, config.concurrency.model, backgroundLimit][index], until, now));
        return remaining;
      });
      let settled = false;
      const signal = AbortSignal.timeout(result);
      return { signal,
        finish: async (usage?: AIUsage, cost?: number | null) => {
          if (settled) return; settled = true;
          // Caller uses the same provider usage as AIUsageRecord. This is only a
          // live safety counter, never another billing ledger.
          const soft = await this.store.transaction([...budgetScopes.map(s => s.key), ...leaseKeys], (tx, now) => {
            let warning: Record<string, number> | undefined;
            for (const scope of budgetScopes) {
              const state = tx.get(scope.key)?.data as unknown as Counters | undefined;
              if (!state) continue;
              if (usage) { state.input += usage.inputTokens - input.inputTokens; state.output += usage.outputTokens - input.outputTokens; state.total += usage.totalTokens - input.inputTokens - input.outputTokens; }
              state.cost += cost ?? 0;
              if (!state.softNotified && state.cost >= config.profiles[state.profile].softCostUsd) { state.softNotified = true; warning = snapshot(state); }
              tx.set(scope.key, { data: { ...state }, expiresAt: now + lifetime });
            }
            for (const key of leaseKeys) release(tx, key, id, now);
            return warning;
          }).catch(() => undefined); // Reservations remain conservative; leases expire.
          if (soft) await this.emit({ context: c, type: "AI_SOFT_COST_THRESHOLD", snapshot: soft }).catch(() => {});
        },
      };
    });
  }
  private budget(a: BudgetProfile, b: BudgetProfile, config: GuardrailConfig): AIExecutionBudget {
    return Object.fromEntries(Object.keys(config.profiles[a]).map(key => {
      const field = key as keyof AIExecutionBudget;
      return [field, field === "qualityFloorTier" ? config.profiles[b][field] : Math.max(Number(config.profiles[a][field]), Number(config.profiles[b][field]))];
    })) as AIExecutionBudget;
  }
  async step(context: AIUsageContext, stepId: string, maxSteps: number) {
    return this.checked(context, async () => {
      this.assertEnabled(context);
      const list = scopes(context);
      await this.store.transaction(list.map(s => s.key), (tx, now) => {
        for (const scope of list) {
          const s = (tx.get(scope.key)?.data as unknown as Counters | undefined) ?? empty(now, "WORKFLOW");
          s.stepLimit = Math.min(s.stepLimit ?? maxSteps, maxSteps, this.config().profiles.WORKFLOW.maxWorkflowSteps);
          if (!s.stepIds.includes(stepId)) {
            if (s.steps >= s.stepLimit) throw new AIError("AI_WORKFLOW_STEP_LIMIT");
            s.steps++; s.stepIds.push(stepId);
          }
          tx.set(scope.key, { data: { ...s }, expiresAt: now + lifetime });
        }
      });
    });
  }
}
export const guardrails = new GuardrailService(postgresGuardStore, getGuardrailConfig, recordGuardEvent, async userId => {
  const result = await db().aIUsageRecord.aggregate({ where: { userId, createdAt: { gte: new Date(Date.now() - 86400000) } }, _sum: { estimatedCostUsd: true } });
  return result._sum.estimatedCostUsd === null ? null : Number(result._sum.estimatedCostUsd);
});
