import "server-only";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import type { ConnectedAccount, Prisma } from "@/generated/prisma/client";
import { startConnectionSchema, INTEGRATION_CAPABILITIES, type StartConnectionInput, type ConnectedAccountView, type IntegrationCapability, type IntegrationProviderId, type IntegrationSettingsView } from "@/lib/student/integrations/types";
import { auth } from "../auth/config";
import { db } from "../db/client";
import { callbackUri, OAUTH_SESSION_TTL_MS } from "./config";
import { credentialContext, getTokenEncryptionService, type TokenEncryptionService } from "./encryption";
import { IntegrationError, protectIntegration, safeIntegrationError, type IntegrationErrorCode } from "./errors";
import { emitIntegrationEvent } from "./events";
import { integrationRegistry, type IntegrationRegistry } from "./registry";
import type { IntegrationClient } from "./types";

const hash = (value: string) => createHash("sha256").update(value).digest("base64url");
const idSchema = z.string().min(1).max(100);
const databaseStatus = { ACTIVE: "connected", EXPIRED: "needs-reconnect", REVOKED: "disconnected", ERROR: "error" } as const;
const transactionOptions = { maxWait: 10000, timeout: 25000 };
export async function cleanupOAuthSessions(now = new Date()): Promise<number> {
  return protectIntegration(async () => (await db().oAuthConnectionSession.deleteMany({ where: { expiresAt: { lte: now } } })).count);
}

export function createIntegrationService(options: { registry?: IntegrationRegistry; encryption?: () => TokenEncryptionService; now?: () => Date } = {}) {
  const registry = options.registry ?? integrationRegistry;
  const encryption = options.encryption ?? getTokenEncryptionService;
  const now = options.now ?? (() => new Date());
  async function authenticated(headers: Headers) {
    const session = await auth().api.getSession({ headers });
    if (!session) throw new IntegrationError("UNAUTHENTICATED");
    return { userId: session.user.id, sessionHash: hash(session.session.id) };
  }
  async function owned(userId: string, id: string, tx: Prisma.TransactionClient = db()) {
    if (!idSchema.safeParse(userId).success || !idSchema.safeParse(id).success) throw new IntegrationError("INVALID_REQUEST");
    const account = await tx.connectedAccount.findFirst({ where: { id, userId } });
    if (!account) throw new IntegrationError("NOT_FOUND"); return account;
  }
  function view(account: ConnectedAccount): ConnectedAccountView {
    const provider = registry.get(account.provider);
    return { id: account.id, provider: provider.id, displayName: account.displayName, email: account.email, status: databaseStatus[account.status],
      capabilities: provider.capabilitiesFor(account.scopes), connectedAt: account.connectedAt.toISOString(), lastRefreshedAt: account.lastRefreshedAt?.toISOString() ?? null,
      revocationFailed: Boolean(account.revocationErrorCode) };
  }
  function usable(account: ConnectedAccount, capability?: IntegrationCapability, providerId?: IntegrationProviderId) {
    const provider = registry.get(account.provider);
    if (providerId && provider.id !== providerId) throw new IntegrationError("INVALID_REQUEST");
    if (account.status === "REVOKED") throw new IntegrationError("DISCONNECTED");
    if (account.status === "EXPIRED") throw new IntegrationError("RECONNECT_REQUIRED");
    if (capability && (!INTEGRATION_CAPABILITIES.includes(capability) || !provider.validateScopes(account.scopes, [capability]))) {
      emitIntegrationEvent("INTEGRATION_SCOPE_REQUIRED", { provider: provider.id, connectedAccountId: account.id, errorCode: "AUTHORIZATION_REQUIRED" });
      throw new IntegrationError("AUTHORIZATION_REQUIRED");
    }
    return provider;
  }
  const listConnectedAccounts = (userId: string) => protectIntegration(async () => (await db().connectedAccount.findMany({ where: { userId }, orderBy: { connectedAt: "desc" } })).map(view));
  const getConnectedAccount = (userId: string, id: string) => protectIntegration(async () => view(await owned(userId, id)));
  const getIntegrationSettings = (userId: string): Promise<IntegrationSettingsView> => protectIntegration(async () => {
    let secureStorageReady = false; try { encryption(); secureStorageReady = true; } catch { /* No secret/config details in the UI. */ }
    return { providers: registry.list().map((provider) => ({ id: provider.id, name: provider.name, available: secureStorageReady && provider.isConfigured() })), accounts: await listConnectedAccounts(userId) };
  });

  const startIntegrationConnection = (raw: StartConnectionInput, headers: Headers) => protectIntegration(async () => {
    const identity = await authenticated(headers);
    const parsed = startConnectionSchema.safeParse(raw); if (!parsed.success) throw new IntegrationError("INVALID_REQUEST");
    const input = parsed.data; const provider = registry.get(input.provider);
    if (!provider.isConfigured()) throw new IntegrationError("CONFIGURATION");
    const crypto = encryption(); const timestamp = now();
    const state = randomBytes(32).toString("base64url"), verifier = randomBytes(32).toString("base64url"), id = randomUUID();
    const result = await db().$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "User" WHERE id=${identity.userId} FOR UPDATE`;
      await tx.oAuthConnectionSession.deleteMany({ where: { userId: identity.userId, expiresAt: { lte: timestamp } } });
      if (await tx.oAuthConnectionSession.count({ where: { userId: identity.userId, usedAt: null } }) >= 10) throw new IntegrationError("CONNECTION_BUSY");
      if (await tx.connectedAccount.count({ where: { userId: identity.userId, provider: provider.id, revocationPendingUntil: { gt: timestamp } } })) throw new IntegrationError("CONNECTION_BUSY");
      const target = input.connectedAccountId ? await owned(identity.userId, input.connectedAccountId, tx) : null;
      if (target && target.provider !== provider.id) throw new IntegrationError("INVALID_REQUEST");
      const capabilities = [...new Set([...input.capabilities, ...(target ? provider.capabilitiesFor(target.scopes) : [])])];
      const scopes = provider.scopesFor(capabilities);
      await tx.oAuthConnectionSession.create({ data: { id, userId: identity.userId, provider: provider.id, stateHash: hash(state), authenticationSessionHash: identity.sessionHash,
        codeVerifierEncrypted: crypto.encrypt(verifier, credentialContext(identity.userId, provider.id, id, "pkce")), requestedScopes: scopes,
        targetAccountId: target?.id, redirectPath: input.redirectPath, expiresAt: new Date(timestamp.getTime() + OAUTH_SESSION_TTL_MS), createdAt: timestamp } });
      return { scopes, ...(target?.email ? { loginHint: target.email } : {}) };
    });
    return { authorizationUrl: provider.getAuthorizationUrl({ state, codeChallenge: hash(verifier), redirectUri: callbackUri(provider.id), ...result }) };
  });

  const handleIntegrationCallback = (providerId: string, parameters: { state?: string; code?: string; error?: string }, headers: Headers) => protectIntegration(async () => {
    const identity = await authenticated(headers); const provider = registry.get(providerId); const timestamp = now();
    if (!parameters.state || !/^[A-Za-z0-9_-]{43}$/.test(parameters.state)) throw new IntegrationError("INVALID_STATE");
    // Claim and erase PKCE durably BEFORE the external exchange. A duplicate or
    // failed callback can never exchange again, even if the provider call fails.
    const claim = await db().$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "User" WHERE id=${identity.userId} FOR UPDATE`;
      const row = await tx.oAuthConnectionSession.findUnique({ where: { stateHash: hash(parameters.state!) } });
      if (!row || row.userId !== identity.userId || row.provider !== provider.id || row.authenticationSessionHash !== identity.sessionHash || row.expiresAt <= timestamp)
        throw new IntegrationError("INVALID_STATE");
      if (row.usedAt) {
        if (row.completedAt && row.resultAccountId) return { row, replayed: true as const, verifier: null };
        throw new IntegrationError("INVALID_STATE");
      }
      await tx.oAuthConnectionSession.update({ where: { id: row.id }, data: { usedAt: timestamp, codeVerifierEncrypted: null } });
      return { row, replayed: false as const, verifier: row.codeVerifierEncrypted };
    });
    if (claim.replayed) return { account: await getConnectedAccount(identity.userId, claim.row.resultAccountId!), redirectPath: claim.row.redirectPath, replayed: true };
    if (parameters.error) throw new IntegrationError(parameters.error === "access_denied" ? "ACCESS_DENIED" : "INVALID_RESPONSE");
    if (!parameters.code || parameters.code.length > 4096 || !claim.verifier) throw new IntegrationError("INVALID_REQUEST");
    const crypto = encryption();
    const verifier = crypto.decrypt(claim.verifier, credentialContext(identity.userId, provider.id, claim.row.id, "pkce"));
    const tokens = await provider.exchangeAuthorizationCode({ code: parameters.code, codeVerifier: verifier, redirectUri: callbackUri(provider.id) });
    if (!tokens.scopes || !provider.validateScopes(tokens.scopes, provider.capabilitiesFor(claim.row.requestedScopes))) throw new IntegrationError("AUTHORIZATION_REQUIRED");
    const external = await provider.getAccountIdentity(tokens.accessToken);
    const persisted = await db().$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "User" WHERE id=${identity.userId} FOR UPDATE`;
      // Disconnect deletes outstanding connection sessions: in-flight exchanges
      // cannot resurrect credentials after it commits.
      const session = await tx.oAuthConnectionSession.findFirst({ where: { id: claim.row.id, userId: identity.userId, expiresAt: { gt: now() } } });
      if (!session) throw new IntegrationError("INVALID_STATE");
      const existing = await tx.connectedAccount.findUnique({ where: { userId_provider_providerAccountId: { userId: identity.userId, provider: provider.id, providerAccountId: external.id } } });
      if (claim.row.targetAccountId && existing?.id !== claim.row.targetAccountId) throw new IntegrationError("ACCOUNT_MISMATCH");
      if (existing) await tx.$queryRaw`SELECT id FROM "ConnectedAccount" WHERE id=${existing.id} AND "userId"=${identity.userId} FOR UPDATE`;
      // Re-read after a concurrent refresh, preserving the latest rotated refresh token.
      const current = existing ? await owned(identity.userId, existing.id, tx) : null;
      if (current?.revocationPendingUntil && current.revocationPendingUntil > now()) throw new IntegrationError("CONNECTION_BUSY");
      if (current?.revokedAt && current.revokedAt > claim.row.createdAt) throw new IntegrationError("INVALID_STATE");
      const id = current?.id ?? randomUUID();
      const refreshTokenEncrypted = tokens.refreshToken ? crypto.encrypt(tokens.refreshToken, credentialContext(identity.userId, provider.id, id, "refresh"))
        : current?.status !== "REVOKED" ? current?.refreshTokenEncrypted ?? null : null;
      const data = { displayName: external.displayName, email: external.email, scopes: tokens.scopes!, status: "ACTIVE" as const,
        accessTokenEncrypted: crypto.encrypt(tokens.accessToken, credentialContext(identity.userId, provider.id, id, "access")), refreshTokenEncrypted,
        accessTokenExpiresAt: new Date(now().getTime() + tokens.expiresInSeconds * 1000), revokedAt: null, lastErrorCode: null, refreshRetryAfter: null,
        revocationErrorCode: null, revocationPendingUntil: null };
      const account = current ? await tx.connectedAccount.update({ where: { id }, data: { ...data, credentialVersion: { increment: 1 } } })
        : await tx.connectedAccount.create({ data: { id, userId: identity.userId, provider: provider.id, providerAccountId: external.id, ...data } });
      await tx.oAuthConnectionSession.update({ where: { id: session.id }, data: { completedAt: now(), resultAccountId: id } });
      return { account, reconnected: Boolean(current) };
    }, transactionOptions);
    emitIntegrationEvent(persisted.reconnected ? "INTEGRATION_RECONNECTED" : "INTEGRATION_CONNECTED", { provider: provider.id, connectedAccountId: persisted.account.id });
    return { account: view(persisted.account), redirectPath: claim.row.redirectPath, replayed: false };
  });

  /** For trusted server/job callers only. The account lock spans refresh with a
   * bounded HTTP timeout; other processes re-read the refreshed credentials.
   * Failure state must commit, so throw the safe error after the transaction. */
  const getValidAccessToken = (userId: string, connectedAccountId: string, capability?: IntegrationCapability, providerId?: IntegrationProviderId): Promise<string> => protectIntegration(async () => {
    const outcome = await db().$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "ConnectedAccount" WHERE id=${connectedAccountId} AND "userId"=${userId} FOR UPDATE`;
      const account = await owned(userId, connectedAccountId, tx); const provider = usable(account, capability, providerId); const timestamp = now();
      if (account.refreshRetryAfter && account.refreshRetryAfter > timestamp) return { error: "PROVIDER_UNAVAILABLE" as IntegrationErrorCode };
      try {
        const crypto = encryption();
        if (account.accessTokenEncrypted && account.accessTokenExpiresAt && account.accessTokenExpiresAt.getTime() > timestamp.getTime() + 60000)
          return { token: crypto.decrypt(account.accessTokenEncrypted, credentialContext(userId, provider.id, account.id, "access")) };
        if (!account.refreshTokenEncrypted) {
          await tx.connectedAccount.update({ where: { id: account.id }, data: { status: "EXPIRED", accessTokenEncrypted: null, lastErrorCode: "RECONNECT_REQUIRED" } });
          return { error: "RECONNECT_REQUIRED" as IntegrationErrorCode };
        }
        const refresh = crypto.decrypt(account.refreshTokenEncrypted, credentialContext(userId, provider.id, account.id, "refresh"));
        const tokens = await provider.refreshAccessToken(refresh);
        await tx.connectedAccount.update({ where: { id: account.id }, data: {
          accessTokenEncrypted: crypto.encrypt(tokens.accessToken, credentialContext(userId, provider.id, account.id, "access")),
          ...(tokens.refreshToken ? { refreshTokenEncrypted: crypto.encrypt(tokens.refreshToken, credentialContext(userId, provider.id, account.id, "refresh")) } : {}),
          accessTokenExpiresAt: new Date(now().getTime() + tokens.expiresInSeconds * 1000),
          scopes: tokens.scopes ?? account.scopes, status: "ACTIVE", lastRefreshedAt: now(), refreshRetryAfter: null, lastErrorCode: null, credentialVersion: { increment: 1 },
        } });
        if (capability && !provider.validateScopes(tokens.scopes ?? account.scopes, [capability])) return { error: "AUTHORIZATION_REQUIRED" as IntegrationErrorCode };
        return { token: tokens.accessToken };
      } catch (cause) {
        const error = safeIntegrationError(cause); const expired = ["INVALID_GRANT", "RECONNECT_REQUIRED"].includes(error.code);
        await tx.connectedAccount.update({ where: { id: account.id }, data: { status: expired ? "EXPIRED" : "ERROR", lastErrorCode: error.code,
          ...(expired ? { accessTokenEncrypted: null, refreshTokenEncrypted: null, accessTokenExpiresAt: null } : {}),
          refreshRetryAfter: expired ? null : new Date(timestamp.getTime() + 60000) } });
        emitIntegrationEvent("INTEGRATION_TOKEN_REFRESH_FAILED", { provider: provider.id, connectedAccountId: account.id, errorCode: error.code });
        return { error: (expired ? "RECONNECT_REQUIRED" : error.code) as IntegrationErrorCode };
      }
    }, transactionOptions);
    if (outcome.error) throw new IntegrationError(outcome.error);
    return outcome.token!;
  });

  const disconnectConnectedAccount = (userId: string, id: string) => protectIntegration(async () => {
    const result = await db().$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "User" WHERE id=${userId} FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM "ConnectedAccount" WHERE id=${id} AND "userId"=${userId} FOR UPDATE`;
      const account = await owned(userId, id, tx);
      if (account.status === "REVOKED") return { account, changed: false };
      await tx.oAuthConnectionSession.deleteMany({ where: { userId } });
      await tx.connectedAccount.update({ where: { id }, data: { status: "REVOKED", accessTokenEncrypted: null, refreshTokenEncrypted: null,
        accessTokenExpiresAt: null, revokedAt: now(), lastErrorCode: null, refreshRetryAfter: null, credentialVersion: { increment: 1 },
        revocationPendingUntil: new Date(now().getTime() + 15000) } });
      await tx.integrationSyncState.updateMany({ where: { connectedAccountId: id }, data: { status: "IDLE", cursorEncrypted: null } });
      return { account, changed: true };
    }, transactionOptions);
    if (result.changed) {
      let revocationErrorCode: IntegrationErrorCode | null = null;
      try {
        const encrypted = result.account.refreshTokenEncrypted ?? result.account.accessTokenEncrypted;
        if (encrypted) {
          const purpose = result.account.refreshTokenEncrypted ? "refresh" : "access";
          const token = encryption().decrypt(encrypted, credentialContext(userId, result.account.provider, id, purpose));
          await registry.get(result.account.provider).revokeAccess(token);
        }
      } catch (error) { revocationErrorCode = safeIntegrationError(error).code; }
      await db().connectedAccount.updateMany({ where: { id, userId, status: "REVOKED", credentialVersion: result.account.credentialVersion + 1 }, data: { revocationErrorCode, revocationPendingUntil: null } });
      emitIntegrationEvent("INTEGRATION_DISCONNECTED", { provider: registry.get(result.account.provider).id, connectedAccountId: id, ...(revocationErrorCode ? { errorCode: revocationErrorCode } : {}) });
    }
    return getConnectedAccount(userId, id);
  });

  const withProviderClient = <T>(input: { userId: string; connectedAccountId: string; provider: IntegrationProviderId; capability: IntegrationCapability }, operation: (client: IntegrationClient) => Promise<T>): Promise<T> => protectIntegration(async () => {
    usable(await owned(input.userId, input.connectedAccountId), input.capability, input.provider);
    const client: IntegrationClient = { async read(request) {
      const token = await getValidAccessToken(input.userId, input.connectedAccountId, input.capability, input.provider);
      const result = await registry.get(input.provider).read({ ...request, capability: input.capability, accessToken: token });
      // In-flight calls cannot expose results after local disconnect or permission loss.
      usable(await owned(input.userId, input.connectedAccountId), input.capability, input.provider);
      return result;
    } };
    return operation(client);
  });

  // Internal sync callers can resume using a decrypted cursor; this method is
  // deliberately not exposed by the public Settings/API account DTO.
  const getIntegrationSyncState = (userId: string, accountId: string, capability: IntegrationCapability) => protectIntegration(async () => {
    const account = await owned(userId, accountId); usable(account, capability);
    const row = await db().integrationSyncState.findUnique({ where: { connectedAccountId_integrationType: { connectedAccountId: accountId, integrationType: capability } } });
    if (!row) return null;
    const { cursorEncrypted, ...state } = row;
    return { ...state, cursor: cursorEncrypted ? encryption().decrypt(cursorEncrypted, credentialContext(userId, account.provider, row.id, "sync-cursor")) : null };
  });

  const updateIntegrationSyncState = (userId: string, accountId: string, capability: IntegrationCapability,
    input: { status: "IDLE" | "SYNCING" | "COMPLETED" | "FAILED"; cursor?: string | null; errorCode?: "PROVIDER_UNAVAILABLE" | "INVALID_RESPONSE" }): Promise<void> => protectIntegration(async () => {
    const parsed = z.object({ status: z.enum(["IDLE", "SYNCING", "COMPLETED", "FAILED"]), cursor: z.string().max(10000).nullable().optional(), errorCode: z.enum(["PROVIDER_UNAVAILABLE", "INVALID_RESPONSE"]).optional() }).strict().safeParse(input);
    if (!parsed.success) throw new IntegrationError("INVALID_REQUEST");
    await db().$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "ConnectedAccount" WHERE id=${accountId} AND "userId"=${userId} FOR UPDATE`;
      const account = await owned(userId, accountId, tx); usable(account, capability);
      const key = { connectedAccountId: accountId, integrationType: capability };
      const previous = await tx.integrationSyncState.findUnique({ where: { connectedAccountId_integrationType: key } });
      const id = previous?.id ?? randomUUID();
      const data = { status: input.status, lastErrorCode: input.status === "FAILED" ? input.errorCode ?? "PROVIDER_UNAVAILABLE" : null,
        ...(input.cursor !== undefined ? { cursorEncrypted: input.cursor === null ? null : encryption().encrypt(input.cursor, credentialContext(userId, account.provider, id, "sync-cursor")) } : {}),
        ...(input.status === "SYNCING" ? { lastSyncStartedAt: now() } : {}),
        ...(["COMPLETED", "FAILED"].includes(input.status) ? { lastSyncCompletedAt: now() } : {}),
        ...(input.status === "COMPLETED" ? { lastSuccessfulSyncAt: now() } : {}) };
      await tx.integrationSyncState.upsert({ where: { connectedAccountId_integrationType: key }, create: { id, ...key, ...data }, update: data });
    });
  });
  return { startIntegrationConnection, handleIntegrationCallback, listConnectedAccounts, getConnectedAccount, getIntegrationSettings,
    getValidAccessToken, disconnectConnectedAccount, withProviderClient, getIntegrationSyncState, updateIntegrationSyncState };
}
export const { startIntegrationConnection, handleIntegrationCallback, listConnectedAccounts, getConnectedAccount, getIntegrationSettings,
  getValidAccessToken, disconnectConnectedAccount, withProviderClient, getIntegrationSyncState, updateIntegrationSyncState } = createIntegrationService();
