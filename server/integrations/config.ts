import "server-only";
import { getEnv } from "../env";
import { IntegrationError } from "./errors";
export const OAUTH_SESSION_TTL_MS = 10 * 60_000;
export const PROVIDER_TIMEOUT_MS = 8000;
export function integrationOrigin(): string {
  try {
    const trusted = new URL(getEnv().BETTER_AUTH_URL);
    const value = new URL(process.env.INTEGRATION_OAUTH_BASE_URL ?? trusted.origin);
    if (value.origin !== trusted.origin || value.pathname !== "/" || value.search || value.hash || value.username || value.password ||
      (value.protocol !== "https:" && !(process.env.NODE_ENV !== "production" && value.protocol === "http:" && ["localhost", "127.0.0.1"].includes(value.hostname)))) throw new Error();
    return value.origin;
  } catch { throw new IntegrationError("CONFIGURATION"); }
}
export function callbackUri(provider: string): string { return `${integrationOrigin()}/api/student/integrations/${encodeURIComponent(provider)}/callback`; }
export function googleCredentials() {
  const clientId = process.env.GOOGLE_INTEGRATION_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_INTEGRATION_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) throw new IntegrationError("CONFIGURATION");
  integrationOrigin();
  return { clientId, clientSecret };
}
