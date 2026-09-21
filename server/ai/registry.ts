import "server-only";
import { AIError } from "./errors";
import type { AIProvider } from "./types";
import { trackAIProvider, isTrackedProvider, type UsageTrackingOptions } from "./usage/tracking";
import { getModelCatalog } from "./routing/catalog";
import type { AIModelDefinition } from "./routing/types";
import { getReliabilityConfig } from "./reliability/config";
import { providerHealth, type ProviderHealthService } from "./reliability/health";

type Registration = { id: string; create: () => AIProvider; enabled?: boolean; tracking?: Omit<UsageTrackingOptions, "provider"> };
/** Lazy construction is centralized. Registering an adapter does not call it or
 * require credentials; disabled providers are never instantiated. */
export class AIProviderRegistry {
  private entries = new Map<string, Registration & { instance?: AIProvider }>();
  constructor(readonly catalog: () => AIModelDefinition[] = getModelCatalog, readonly health: ProviderHealthService = providerHealth) {}
  register(entry: Registration) {
    if (!/^[A-Za-z0-9_.-]{1,100}$/.test(entry.id) || this.entries.has(entry.id)) throw new AIError("CONFIGURATION");
    this.entries.set(entry.id, { ...entry }); return this;
  }
  setEnabled(id: string, enabled: boolean) { const entry = this.entries.get(id); if (!entry) throw new AIError("CONFIGURATION"); entry.enabled = enabled; }
  isEnabled(id: string) { return this.entries.has(id) && this.entries.get(id)!.enabled !== false && !getReliabilityConfig().disabledProviders.includes(id); }
  listEnabled() { return [...this.entries.keys()].filter(id => this.isEnabled(id)); }
  get(id: string): AIProvider {
    const entry = this.entries.get(id);
    if (!entry || !this.isEnabled(id)) throw new AIError("AI_SERVICE_TEMPORARILY_UNAVAILABLE");
    if (!entry.instance) {
      const transport = entry.create();
      entry.instance = isTrackedProvider(transport) ? transport : trackAIProvider(transport, { embeddingModel: "unknown", ...entry.tracking, provider: id });
    }
    return entry.instance;
  }
  capabilities(provider: string, model: string) { return this.catalog().find(m => m.provider === provider && m.model === model && m.enabled && this.isEnabled(provider)); }
  async listHealthyProviders() {
    const refs = this.catalog().filter(m => m.enabled && this.isEnabled(m.provider));
    const health = await this.health.list(refs);
    return health.filter(h => !h.model && h.selectable && refs.some(m => m.provider === h.providerId && health.some(s => s.providerId === m.provider && s.model === m.model && s.selectable)));
  }
}
