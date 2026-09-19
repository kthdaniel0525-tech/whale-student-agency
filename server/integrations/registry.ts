import "server-only";
import type { IntegrationProvider } from "./types";
import { IntegrationError } from "./errors";
import { GoogleIntegrationProvider } from "./google";
export class IntegrationRegistry {
  private readonly providers = new Map<string, IntegrationProvider>();
  register(provider: IntegrationProvider): this {
    if (this.providers.has(provider.id)) throw new IntegrationError("INVALID_REQUEST");
    this.providers.set(provider.id, provider); return this;
  }
  get(id: string): IntegrationProvider { const provider = this.providers.get(id); if (!provider) throw new IntegrationError("INVALID_REQUEST"); return provider; }
  list(): IntegrationProvider[] { return [...this.providers.values()]; }
  isSupported(id: string): boolean { return this.providers.has(id); }
}
export const integrationRegistry = new IntegrationRegistry().register(new GoogleIntegrationProvider());
