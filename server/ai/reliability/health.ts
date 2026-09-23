import "server-only";
import { randomUUID } from "node:crypto";
import { AIError } from "../errors";
import type { ModelReference } from "../routing/types";
import type { AIUsageContext } from "../usage/types";
import { guardKey, postgresGuardStore, type GuardStore } from "../guardrails/store";
import { recordGuardEvent, type GuardEvent } from "../guardrails/events";
import { getReliabilityConfig, type ReliabilityConfig } from "./config";
import type { FailureInfo } from "./failures";

export type ProviderHealth = { providerId: string; model?: string; status: "healthy" | "degraded" | "rate-limited" | "unavailable" | "disabled";
  circuit: "closed" | "open" | "half-open"; selectable: boolean; recentFailureRate: number; recentLatency: number | null;
  rateLimitedUntil?: number; lastSuccessAt?: number; lastFailureAt?: number };
type Sample = { at: number; failed: boolean; latency: number; model: string; broad: boolean };
type State = { circuit: ProviderHealth["circuit"]; epoch: number; samples: Sample[]; consecutive: number; openUntil: number;
  rateUntil: number; probe?: { id: string; until: number }; lastSuccess?: number; lastFailure?: number };
const empty = (): State => ({ circuit: "closed", epoch: 0, samples: [], consecutive: 0, openUntil: 0, rateUntil: 0 });
const keys = (ref: ModelReference) => [guardKey("ai-health-provider", ref.provider), guardKey("ai-health-model", ref.provider, ref.model)];
const read = (data?: Record<string, unknown>) => data as unknown as State | undefined;
const retention = 7 * 86400000;

/** Shared passive circuit breaker. Only real request outcomes contribute evidence.
 * Epochs fence late results and one leased half-open probe prevents recovery herds. */
export class ProviderHealthService {
  constructor(readonly store: GuardStore = postgresGuardStore, readonly config: () => ReliabilityConfig = getReliabilityConfig,
    readonly emit: (e: GuardEvent) => Promise<void> = recordGuardEvent) {}
  async list(refs: ModelReference[]): Promise<ProviderHealth[]> {
    const all = [...new Set(refs.flatMap(keys))];
    return this.store.transaction(all, (tx, now) => {
      const providers = [...new Set(refs.map(r => r.provider))];
      return [...providers.map(provider => this.view({ provider, model: "" }, read(tx.get(guardKey("ai-health-provider", provider))?.data), now, true)),
        ...refs.map(ref => this.view(ref, read(tx.get(keys(ref)[1])?.data), now, false))];
    }).catch(() => { throw new AIError("AI_SERVICE_TEMPORARILY_UNAVAILABLE"); });
  }
  private view(ref: ModelReference, data: State | undefined, now: number, provider: boolean): ProviderHealth {
    const s = data ?? empty(), samples = s.samples.filter(v => v.at > now - this.config().breaker.windowMs);
    const failures = samples.filter(v => v.failed).length;
    const disabled = this.config().disabledProviders.includes(ref.provider);
    const blocked = Math.max(s.openUntil, s.rateUntil) > now || (s.probe?.until ?? 0) > now;
    return { providerId: ref.provider, ...(provider ? {} : { model: ref.model }), status: disabled ? "disabled" : s.rateUntil > now ? "rate-limited" : blocked ? "unavailable" : failures ? "degraded" : "healthy",
      circuit: s.circuit === "open" && !blocked ? "half-open" : s.circuit, selectable: !disabled && !blocked,
      recentFailureRate: samples.length ? failures / samples.length : 0, recentLatency: samples.length ? Math.round(samples.reduce((n, v) => n + v.latency, 0) / samples.length) : null,
      ...(s.rateUntil ? { rateLimitedUntil: s.rateUntil } : {}), ...(s.lastSuccess ? { lastSuccessAt: s.lastSuccess } : {}), ...(s.lastFailure ? { lastFailureAt: s.lastFailure } : {}) };
  }
  async claim(ref: ModelReference, timeoutMs: number, context: AIUsageContext) {
    const all = keys(ref), id = randomUUID(), cfg = this.config().breaker;
    if (this.config().disabledProviders.includes(ref.provider)) throw new AIError("AI_SERVICE_TEMPORARILY_UNAVAILABLE");
    const epochs = await this.store.transaction(all, (tx, now) => all.map(key => {
      const s = read(tx.get(key)?.data) ?? empty();
      if (Math.max(s.openUntil, s.rateUntil) > now || (s.probe?.until ?? 0) > now) throw new AIError("AI_SERVICE_TEMPORARILY_UNAVAILABLE");
      if (s.circuit !== "closed") { s.circuit = "half-open"; s.probe = { id, until: now + timeoutMs + 5000 }; tx.set(key, { data: { ...s }, expiresAt: now + retention }); }
      return s.epoch;
    })).catch(error => { throw error instanceof AIError ? error : new AIError("AI_SERVICE_TEMPORARILY_UNAVAILABLE"); });
    let done = false;
    return { finish: async (outcome: "success" | "neutral" | FailureInfo, latency: number) => {
      if (done) return; done = true;
      const events = await this.store.transaction(all, (tx, now) => {
        const events: string[] = [];
        all.forEach((key, index) => {
          const s = read(tx.get(key)?.data) ?? empty();
          if (s.epoch !== epochs[index] || s.probe && s.probe.id !== id) return;
          const probing = s.probe?.id === id;
          if (probing) delete s.probe;
          const f = typeof outcome === "string" ? undefined : outcome;
          const evidence = outcome === "success" || f && ["timeout", "rate-limit", "provider-unavailable", "overloaded", "authentication", "content-schema"].includes(f.kind);
          if (evidence) {
            s.samples = [...s.samples.filter(v => v.at > now - cfg.windowMs), { at: now, failed: !!f, latency, model: ref.model, broad: f?.scope === "provider" }].slice(-cfg.samples);
            s.consecutive = f ? ((s.lastFailure ?? 0) > now - cfg.windowMs ? s.consecutive : 0) + 1 : 0;
            if (f) s.lastFailure = now; else s.lastSuccess = now;
          }
          const failures = s.samples.filter(v => v.failed), distinctModels = new Set(failures.map(v => v.model)).size;
          // One bad model must not disable all other models on its provider.
          const broad = index === 1 || distinctModels >= 2 || f?.scope === "provider";
          const throttled = f && (f.kind === "rate-limit" || !!f.retryAfterMs) && broad;
          const auth = f?.kind === "authentication" && broad;
          const open = evidence && broad && f && (probing || auth || throttled || s.consecutive >= cfg.consecutiveFailures
            || s.samples.length >= cfg.minimumSamples && failures.length / s.samples.length >= cfg.failureRate);
          if (open) {
            s.circuit = "open"; s.epoch++;
            s.openUntil = now + (auth ? cfg.authCooldownMs : cfg.cooldownMs);
            if (throttled) s.rateUntil = now + (f.retryAfterMs ?? cfg.rateLimitMs);
            events.push(auth ? "AI_AUTH_FAILURE" : "AI_CIRCUIT_OPEN");
          } else if (probing) {
            s.circuit = outcome !== "success" ? "open" : "closed"; s.epoch++; s.openUntil = 0; s.rateUntil = 0;
            if (outcome === "success") { s.samples = []; s.consecutive = 0; events.push("AI_CIRCUIT_RECOVERED"); }
          }
          tx.set(key, { data: { ...s }, expiresAt: Math.max(now + retention, s.rateUntil) });
        });
        return events;
      }).catch(() => []); // Completion/analytics cannot invalidate a usable result.
      for (const type of new Set(events)) await this.emit({ context, type, provider: ref.provider, model: ref.model }).catch(() => {});
    } };
  }
}
export const providerHealth = new ProviderHealthService();
