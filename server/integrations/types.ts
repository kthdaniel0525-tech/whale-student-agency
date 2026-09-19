import type { IntegrationCapability, IntegrationProviderId } from "@/lib/student/integrations/types";
export interface IntegrationTokens {
  accessToken: string; refreshToken?: string; expiresInSeconds: number; scopes?: string[];
}
export interface IntegrationIdentity { id: string; displayName: string | null; email: string | null; }
export interface ProviderReadRequest { capability: IntegrationCapability; path: string; query?: Record<string, string>; }
export interface IntegrationProvider {
  readonly id: IntegrationProviderId;
  readonly name: string;
  isConfigured(): boolean;
  scopesFor(capabilities: readonly IntegrationCapability[]): string[];
  capabilitiesFor(scopes: readonly string[]): IntegrationCapability[];
  validateScopes(scopes: readonly string[], capabilities: readonly IntegrationCapability[]): boolean;
  getAuthorizationUrl(input: { state: string; codeChallenge: string; scopes: string[]; redirectUri: string; loginHint?: string }): string;
  exchangeAuthorizationCode(input: { code: string; codeVerifier: string; redirectUri: string }): Promise<IntegrationTokens>;
  refreshAccessToken(refreshToken: string): Promise<IntegrationTokens>;
  getAccountIdentity(accessToken: string): Promise<IntegrationIdentity>;
  revokeAccess(token: string): Promise<void>;
  read(input: ProviderReadRequest & { accessToken: string }): Promise<unknown>;
}
export interface IntegrationClient { read(input: Omit<ProviderReadRequest, "capability">): Promise<unknown>; }
