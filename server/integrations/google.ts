import "server-only";
import { z } from "zod";
import { INTEGRATION_CAPABILITIES, type IntegrationCapability } from "@/lib/student/integrations/types";
import { googleCredentials, PROVIDER_TIMEOUT_MS } from "./config";
import { IntegrationError } from "./errors";
import type { IntegrationProvider, IntegrationTokens, ProviderReadRequest, ProviderWriteRequest, ProviderDownloadRequest } from "./types";

export const GOOGLE_SCOPES: Record<IntegrationCapability, readonly string[]> = {
  "account-profile": ["openid", "https://www.googleapis.com/auth/userinfo.email", "https://www.googleapis.com/auth/userinfo.profile"],
  "calendar-read": ["https://www.googleapis.com/auth/calendar.events.readonly", "https://www.googleapis.com/auth/calendar.calendarlist.readonly"],
  "calendar-write": ["https://www.googleapis.com/auth/calendar.events"],
  "drive-read": ["https://www.googleapis.com/auth/drive.readonly"],
  "email-read": ["https://www.googleapis.com/auth/gmail.readonly"],
};
const normalize = (scope: string) => scope === "email" ? GOOGLE_SCOPES["account-profile"][1] : scope === "profile" ? GOOGLE_SCOPES["account-profile"][2] : scope;
const tokenSchema = z.object({
  access_token: z.string().min(1).max(65536), token_type: z.string().refine((value) => value.toLowerCase() === "bearer"),
  expires_in: z.number().int().positive().max(365 * 86400), refresh_token: z.string().min(1).max(65536).optional(), scope: z.string().max(10000).optional(),
});
const identitySchema = z.object({ sub: z.string().min(1).max(255), name: z.string().max(300).optional(), email: z.string().email().optional(), email_verified: z.boolean().optional() });
const roots: Record<IntegrationCapability, string> = {
  "account-profile": "https://openidconnect.googleapis.com/v1/",
  "calendar-read": "https://www.googleapis.com/calendar/v3/",
  "calendar-write": "https://www.googleapis.com/calendar/v3/",
  "drive-read": "https://www.googleapis.com/drive/v3/",
  "email-read": "https://gmail.googleapis.com/gmail/v1/",
};

function rateLimited(body: unknown) {
  const parsed = z.object({ error: z.object({ errors: z.array(z.object({ reason: z.string() })).max(20).optional() }) }).safeParse(body);
  return parsed.success && parsed.data.error.errors?.some(error => ["rateLimitExceeded", "userRateLimitExceeded", "downloadQuotaExceeded"].includes(error.reason));
}
async function readBounded(response: Response, limit: number, overflow: "INVALID_RESPONSE" | "FILE_TOO_LARGE") {
  if (Number(response.headers.get("content-length")) > limit) { await response.body?.cancel(); throw new IntegrationError(overflow); }
  const reader = response.body?.getReader(), chunks: Uint8Array[] = []; let size = 0;
  if (reader) while (true) {
    const { value, done } = await reader.read(); if (done) break;
    size += value.length; if (size > limit) { await reader.cancel(); throw new IntegrationError(overflow); }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/** Only this adapter knows Google URLs and wire types. HTTP never follows redirects
 * with credentials and upstream bodies/errors are never logged or rethrown. */
export class GoogleIntegrationProvider implements IntegrationProvider {
  readonly id = "google" as const;
  readonly name = "Google";
  constructor(private readonly http: typeof fetch = (...args) => fetch(...args), private readonly credentials = googleCredentials) {}
  isConfigured(): boolean { try { this.credentials(); return true; } catch { return false; } }
  scopesFor(capabilities: readonly IntegrationCapability[]) {
    if (!capabilities.length || capabilities.some((value) => !INTEGRATION_CAPABILITIES.includes(value))) throw new IntegrationError("INVALID_REQUEST");
    return [...new Set(["account-profile" as const, ...capabilities].flatMap((capability) => GOOGLE_SCOPES[capability]))];
  }
  capabilitiesFor(scopes: readonly string[]) {
    const granted = new Set(scopes.map(normalize));
    return INTEGRATION_CAPABILITIES.filter((capability) => GOOGLE_SCOPES[capability].every((scope) => granted.has(scope)) ||
      (capability === "calendar-read" && granted.has(GOOGLE_SCOPES["calendar-write"][0]) && granted.has(GOOGLE_SCOPES["calendar-read"][1])));
  }
  validateScopes(scopes: readonly string[], capabilities: readonly IntegrationCapability[]) {
    const granted = this.capabilitiesFor(scopes); return capabilities.every((capability) => granted.includes(capability));
  }
  getAuthorizationUrl(input: Parameters<IntegrationProvider["getAuthorizationUrl"]>[0]) {
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.search = new URLSearchParams({ client_id: this.credentials().clientId, response_type: "code", redirect_uri: input.redirectUri,
      scope: input.scopes.join(" "), state: input.state, code_challenge: input.codeChallenge, code_challenge_method: "S256",
      access_type: "offline", include_granted_scopes: "true", prompt: "consent select_account", ...(input.loginHint ? { login_hint: input.loginHint } : {}) }).toString();
    return url.toString();
  }
  private async send(url: string, init: RequestInit, revoke = false): Promise<unknown> {
    try {
      const response = await this.http(url, { ...init, redirect: "error", cache: "no-store", signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS) });
      // Read only a bounded response. No response text is included in exceptions.
      const text = (await readBounded(response, 128 * 1024, "INVALID_RESPONSE")).toString("utf8");
      let body: unknown;
      try { body = text ? JSON.parse(text) : {}; } catch { throw new IntegrationError(response.ok ? "INVALID_RESPONSE" : "PROVIDER_UNAVAILABLE"); }
      const code = body && typeof body === "object" && "error" in body ? body.error : undefined;
      if (revoke && response.status === 400 && code === "invalid_token") return {};
      if (!response.ok) {
        if (code === "invalid_grant") throw new IntegrationError("INVALID_GRANT");
        if (code === "invalid_client" || code === "unauthorized_client") throw new IntegrationError("CONFIGURATION");
        if (response.status === 404) throw new IntegrationError("RESOURCE_NOT_FOUND");
        if (response.status === 410) throw new IntegrationError("SYNC_TOKEN_EXPIRED");
        if (response.status === 409) throw new IntegrationError("RESOURCE_CONFLICT");
        if (response.status === 401) throw new IntegrationError("RECONNECT_REQUIRED");
        if (response.status === 403) throw new IntegrationError(rateLimited(body) ? "PROVIDER_UNAVAILABLE" : "AUTHORIZATION_REQUIRED");
        throw new IntegrationError("PROVIDER_UNAVAILABLE");
      }
      return body;
    } catch (error) { throw error instanceof IntegrationError ? new IntegrationError(error.code) : new IntegrationError("PROVIDER_UNAVAILABLE"); }
  }
  private async tokens(parameters: Record<string, string>, requireScopes: boolean): Promise<IntegrationTokens> {
    const { clientId, clientSecret } = this.credentials();
    const raw = await this.send("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, ...parameters }) });
    const parsed = tokenSchema.safeParse(raw);
    if (!parsed.success || (requireScopes && !parsed.data.scope)) throw new IntegrationError("INVALID_RESPONSE");
    const row = parsed.data;
    return { accessToken: row.access_token, expiresInSeconds: row.expires_in,
      ...(row.refresh_token ? { refreshToken: row.refresh_token } : {}),
      ...(row.scope !== undefined ? { scopes: [...new Set(row.scope.split(/\s+/).filter(Boolean).map(normalize))] } : {}) };
  }
  exchangeAuthorizationCode(input: Parameters<IntegrationProvider["exchangeAuthorizationCode"]>[0]) {
    return this.tokens({ grant_type: "authorization_code", code: input.code, code_verifier: input.codeVerifier, redirect_uri: input.redirectUri }, true);
  }
  refreshAccessToken(refreshToken: string) { return this.tokens({ grant_type: "refresh_token", refresh_token: refreshToken }, false); }
  async getAccountIdentity(accessToken: string) {
    const raw = await this.send("https://openidconnect.googleapis.com/v1/userinfo", { headers: { Authorization: `Bearer ${accessToken}` } });
    const parsed = identitySchema.safeParse(raw); if (!parsed.success) throw new IntegrationError("INVALID_RESPONSE");
    return { id: parsed.data.sub, displayName: parsed.data.name ?? null, email: parsed.data.email_verified ? parsed.data.email ?? null : null };
  }
  async revokeAccess(token: string) {
    await this.send("https://oauth2.googleapis.com/revoke", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token }) }, true);
  }
  private resourceUrl(input: ProviderReadRequest) {
    // Future features supply relative resource paths, never arbitrary URLs or headers.
    if (!input.path || !/^[A-Za-z0-9_~!$&'()*+,;=:@%./-]+$/.test(input.path) || input.path.startsWith("/") || input.path.includes(":") ||
      input.path.split("/").some((part) => { try { return decodeURIComponent(part).includes("..") || /[\\/\x00-\x20]/.test(decodeURIComponent(part)); } catch { return true; } }))
      throw new IntegrationError("INVALID_REQUEST");
    const root = roots[input.capability]; if (!root) throw new IntegrationError("INVALID_REQUEST");
    const url = new URL(input.path, root); if (!url.href.startsWith(root)) throw new IntegrationError("INVALID_REQUEST");
    url.search = new URLSearchParams(input.query).toString();
    return url.toString();
  }
  async read(input: ProviderReadRequest & { accessToken: string }) {
    return this.send(this.resourceUrl(input), { headers: { Authorization: `Bearer ${input.accessToken}` } });
  }
  async download(input: ProviderDownloadRequest & { accessToken: string }) {
    if (input.capability !== "drive-read" || !/^files\/[A-Za-z0-9_-]+(?:\/export)?$/.test(input.path) ||
        !Number.isInteger(input.maxBytes) || input.maxBytes < 1 || input.maxBytes > 10 * 1024 * 1024 ||
        (input.path.endsWith("/export") ? input.query?.mimeType !== "application/pdf" : input.query?.alt !== "media"))
      throw new IntegrationError("INVALID_REQUEST");
    try {
      const response = await this.http(this.resourceUrl(input), { headers: { Authorization: `Bearer ${input.accessToken}` },
        redirect: "error", cache: "no-store", signal: AbortSignal.timeout(60000) });
      if (!response.ok) {
        let limited = false;
        if (response.status === 403) {
          const body = await readBounded(response, 16384, "INVALID_RESPONSE");
          try { limited = Boolean(rateLimited(JSON.parse(body.toString("utf8")))); } catch { /* No raw provider errors leave the adapter. */ }
        } else await response.body?.cancel();
        throw new IntegrationError(response.status === 404 ? "RESOURCE_NOT_FOUND" : response.status === 401 ? "RECONNECT_REQUIRED" : response.status === 403 && !limited ? "AUTHORIZATION_REQUIRED" : "PROVIDER_UNAVAILABLE");
      }
      const bytes = await readBounded(response, input.maxBytes, "FILE_TOO_LARGE");
      if (!bytes.length) throw new IntegrationError("INVALID_RESPONSE");
      return new Uint8Array(bytes);
    } catch (error) { throw error instanceof IntegrationError ? error : new IntegrationError("PROVIDER_UNAVAILABLE"); }
  }
  async write(input: ProviderWriteRequest & { accessToken: string }) {
    // This foundation permits only explicit Calendar event mutations, never arbitrary Google writes.
    if (input.capability !== "calendar-write" || !/^calendars\/[^/]+\/events(?:\/[a-v0-9]+)?$/.test(input.path) ||
      !["POST", "PATCH", "DELETE"].includes(input.method)) throw new IntegrationError("INVALID_REQUEST");
    return this.send(this.resourceUrl(input), { method: input.method,
      headers: { Authorization: `Bearer ${input.accessToken}`, "Content-Type": "application/json" },
      ...(input.body ? { body: JSON.stringify(input.body) } : {}) });
  }
}
