import { assertIntegrationAccess, assertResourceCreation } from "../entitlements/resources";
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
import { integrationHealth } from "./health";

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
  function view(account: ConnectedAccount & { syncStates?: Parameters<typeof integrationHealth>[1] }, capability?: IntegrationCapability): ConnectedAccountView {
    const provider = registry.get(account.provider);
    return { id: account.id, provider: provider.id, displayName: account.displayName, email: account.email, status: databaseStatus[account.status], health: integrationHealth({ ...account, deniedCapabilities: account.deniedCapabilities.filter(c => !capability || c === capability) }, account.syncStates?.filter(s => !capability || s.integrationType === capability), now()),
      capabilities: provider.capabilitiesFor(account.scopes).filter(capability => !account.deniedCapabilities.includes(capability)), connectedAt: account.connectedAt.toISOString(), lastRefreshedAt: account.lastRefreshedAt?.toISOString() ?? null,
      revocationFailed: Boolean(account.revocationErrorCode) };
  }
  function usable(account: ConnectedAccount, capability?: IntegrationCapability, providerId?: IntegrationProviderId) {
    const provider = registry.get(account.provider);
    if (providerId && provider.id !== providerId) throw new IntegrationError("INVALID_REQUEST");
    if (account.status === "REVOKED") throw new IntegrationError("DISCONNECTED");
    if (account.status === "EXPIRED") throw new IntegrationError("RECONNECT_REQUIRED");
    if (capability && (!INTEGRATION_CAPABILITIES.includes(capability) || account.deniedCapabilities.includes(capability) || !provider.validateScopes(account.scopes, [capability]))) {
      emitIntegrationEvent("INTEGRATION_SCOPE_REQUIRED", { provider: provider.id, connectedAccountId: account.id, errorCode: "AUTHORIZATION_REQUIRED" });
      throw new IntegrationError("AUTHORIZATION_REQUIRED");
    }
    return provider;
  }
  const listConnectedAccounts = (userId: string) => protectIntegration(async () => (await db().connectedAccount.findMany({ where: { userId, provider: { in: registry.list().map(provider => provider.id) } }, include: { syncStates: true }, orderBy: { connectedAt: "desc" } })).map(account => view(account)));
  const getConnectedAccount = (userId: string, id: string, capability?: IntegrationCapability) => protectIntegration(async () => view({ ...await owned(userId, id), syncStates: await db().integrationSyncState.findMany({ where: { connectedAccountId: id, connectedAccount: { userId } } }) }, capability));
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
      for (const capability of capabilities) await assertIntegrationAccess(identity.userId, capability, tx);
      await assertResourceCreation(identity.userId, "account", tx, target?.id);
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
    for (const capability of provider.capabilitiesFor(claim.row.requestedScopes)) await assertIntegrationAccess(identity.userId, capability);
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
      for (const capability of provider.capabilitiesFor(tokens.scopes!)) await assertIntegrationAccess(identity.userId, capability, tx);
      await assertResourceCreation(identity.userId, "account", tx, current?.id);
      const id = current?.id ?? randomUUID();
      const refreshTokenEncrypted = tokens.refreshToken ? crypto.encrypt(tokens.refreshToken, credentialContext(identity.userId, provider.id, id, "refresh"))
        : current?.status !== "REVOKED" ? current?.refreshTokenEncrypted ?? null : null;
      const data = { displayName: external.displayName, email: external.email, scopes: tokens.scopes!, status: "ACTIVE" as const,
        accessTokenEncrypted: crypto.encrypt(tokens.accessToken, credentialContext(identity.userId, provider.id, id, "access")), refreshTokenEncrypted,
        accessTokenExpiresAt: new Date(now().getTime() + tokens.expiresInSeconds * 1000), revokedAt: null, lastErrorCode: null, refreshRetryAfter: null,
        revocationErrorCode: null, revocationPendingUntil: null, refreshLeaseToken: null, refreshLeaseUntil: null, deniedCapabilities: [] };
      const account = current ? await tx.connectedAccount.update({ where: { id }, data: { ...data, credentialVersion: { increment: 1 } } })
        : await tx.connectedAccount.create({ data: { id, userId: identity.userId, provider: provider.id, providerAccountId: external.id, ...data } });
      await tx.integrationSyncState.updateMany({ where: { connectedAccountId: id }, data: { retryAfter: null, lastErrorCode: null } });
      await tx.oAuthConnectionSession.update({ where: { id: session.id }, data: { completedAt: now(), resultAccountId: id } });
      return { account, reconnected: Boolean(current) };
    }, transactionOptions);
    emitIntegrationEvent(persisted.reconnected ? "INTEGRATION_RECONNECTED" : "INTEGRATION_CONNECTED", { provider: provider.id, connectedAccountId: persisted.account.id });
    return { account: view(persisted.account), redirectPath: claim.row.redirectPath, replayed: false };
  });

  /** A durable short lease coalesces refresh across workers without holding a DB
   * lock during HTTP. Disconnect can commit immediately; version + lease checks
   * prevent a late refresh from resurrecting or overwriting credentials. */
  const getValidAccessToken = (userId: string, connectedAccountId: string, capability?: IntegrationCapability, providerId?: IntegrationProviderId): Promise<string> => protectIntegration(async () => {
    await assertIntegrationAccess(userId, capability);
    const deadline = performance.now() + 20000;
    while (performance.now() < deadline) {
      const lease = randomUUID();
      const claim = await db().$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "ConnectedAccount" WHERE id=${connectedAccountId} AND "userId"=${userId} FOR UPDATE`;
        const account = await owned(userId, connectedAccountId, tx); usable(account, capability, providerId);
        if (account.refreshRetryAfter && account.refreshRetryAfter > now()) return { error: new IntegrationError(account.lastErrorCode === "PROVIDER_RATE_LIMITED" ? "PROVIDER_RATE_LIMITED" : "PROVIDER_UNAVAILABLE", (account.refreshRetryAfter.getTime() - now().getTime()) / 1000) };
        try {
          const crypto = encryption();
          if (account.accessTokenEncrypted && account.accessTokenExpiresAt && account.accessTokenExpiresAt.getTime() > now().getTime() + 60000)
            return { token: crypto.decrypt(account.accessTokenEncrypted, credentialContext(userId, account.provider, account.id, "access")) };
          if (account.refreshLeaseUntil && account.refreshLeaseUntil > now()) return { waiting: true };
          if (!account.refreshTokenEncrypted) throw new IntegrationError("RECONNECT_REQUIRED");
          const refresh = crypto.decrypt(account.refreshTokenEncrypted, credentialContext(userId, account.provider, account.id, "refresh"));
          await tx.connectedAccount.update({ where: { id: account.id }, data: { refreshLeaseToken: lease, refreshLeaseUntil: new Date(now().getTime() + 15000) } });
          return { account, refresh };
        } catch (cause) {
          const error = safeIntegrationError(cause);
          const expired = ["ENCRYPTION_FAILURE", "RECONNECT_REQUIRED"].includes(error.code);
          await tx.connectedAccount.update({ where: { id: account.id }, data: { status: expired ? "EXPIRED" : "ERROR", ...(expired ? { accessTokenEncrypted: null, refreshTokenEncrypted: null, accessTokenExpiresAt: null } : {}), lastErrorCode: error.code, refreshRetryAfter: expired ? null : new Date(now().getTime() + 60000), refreshLeaseToken: null, refreshLeaseUntil: null } });
          emitIntegrationEvent("INTEGRATION_TOKEN_REFRESH_FAILED", { provider: registry.get(account.provider).id, connectedAccountId: account.id, errorCode: error.code });
          return { error };
        }
      }, transactionOptions);
      if (claim.error) throw claim.error;
      if (claim.token) return claim.token;
      if (!claim.account) { await new Promise(resolve => setTimeout(resolve, 100)); continue; }
      const account = claim.account, provider = registry.get(account.provider);
      try {
        const tokens = await provider.refreshAccessToken(claim.refresh);
        const crypto = encryption();
        const published = await db().connectedAccount.updateMany({ where: { id: account.id, userId, credentialVersion: account.credentialVersion, refreshLeaseToken: lease, status: { in: ["ACTIVE", "ERROR"] } }, data: {
          accessTokenEncrypted: crypto.encrypt(tokens.accessToken, credentialContext(userId, account.provider, account.id, "access")),
          ...(tokens.refreshToken ? { refreshTokenEncrypted: crypto.encrypt(tokens.refreshToken, credentialContext(userId, account.provider, account.id, "refresh")) } : {}),
          accessTokenExpiresAt: new Date(now().getTime() + tokens.expiresInSeconds * 1000), scopes: tokens.scopes ?? account.scopes,
          status: "ACTIVE", lastRefreshedAt: now(), refreshRetryAfter: null, lastErrorCode: null, refreshLeaseToken: null, refreshLeaseUntil: null, credentialVersion: { increment: 1 },
        } });
        const current = await owned(userId, account.id); usable(current, capability, providerId);
        if (published.count) return tokens.accessToken;
        // A reconnect superseded this refresh. Re-read its credential, never publish the old result.
      } catch (cause) {
        const error = safeIntegrationError(cause), expired = ["INVALID_GRANT", "RECONNECT_REQUIRED", "ENCRYPTION_FAILURE"].includes(error.code);
        const changed = await db().connectedAccount.updateMany({ where: { id: account.id, userId, credentialVersion: account.credentialVersion, refreshLeaseToken: lease, status: { in: ["ACTIVE", "ERROR"] } }, data: {
          status: expired ? "EXPIRED" : "ERROR", lastErrorCode: error.code, refreshLeaseToken: null, refreshLeaseUntil: null,
          ...(expired ? { accessTokenEncrypted: null, refreshTokenEncrypted: null, accessTokenExpiresAt: null } : {}),
          refreshRetryAfter: expired ? null : new Date(now().getTime() + (error.retryAfterSeconds ?? 60) * 1000),
        } });
        if (changed.count) {
          emitIntegrationEvent("INTEGRATION_TOKEN_REFRESH_FAILED", { provider: provider.id, connectedAccountId: account.id, errorCode: error.code });
          throw new IntegrationError(expired && error.code !== "ENCRYPTION_FAILURE" ? "RECONNECT_REQUIRED" : error.code, error.retryAfterSeconds);
        }
        usable(await owned(userId, account.id), capability, providerId);
        if (error.code === "AUTHORIZATION_REQUIRED") throw error;
      }
    }
    throw new IntegrationError("CONNECTION_BUSY");
  });

  const disconnectConnectedAccount = (userId: string, id: string) => protectIntegration(async () => {
    const result = await db().$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "User" WHERE id=${userId} FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM "ConnectedAccount" WHERE id=${id} AND "userId"=${userId} FOR UPDATE`;
      const account = await owned(userId, id, tx);
      if (account.status === "REVOKED") return { account, changed: false };
      await tx.oAuthConnectionSession.deleteMany({ where: { userId } });
      await tx.connectedAccount.update({ where: { id }, data: { status: "REVOKED", accessTokenEncrypted: null, refreshTokenEncrypted: null,
        accessTokenExpiresAt: null, revokedAt: now(), lastErrorCode: null, refreshRetryAfter: null, refreshLeaseToken: null, refreshLeaseUntil: null, credentialVersion: { increment: 1 },
        revocationPendingUntil: new Date(now().getTime() + 15000) } });
      await tx.integrationSyncState.updateMany({ where: { connectedAccountId: id }, data: { status: "IDLE", cursorEncrypted: null, leaseToken: null, leaseUntil: null } });
      await tx.externalFileLink.updateMany({ where: { connectedAccountId: id, userId, syncStatus: { in: ["PENDING", "IMPORTING"] } }, data: { syncStatus: "FAILED", errorCode: "DISCONNECTED", leaseToken: null, leaseUntil: null, requestVersion: { increment: 1 } } });
      // Retain the user's selection for reconnect; the revoked account gate stops
      // all access immediately. Erase cached availability and fence active snapshots.
      await tx.calendarIntegrationPreference.updateMany({ where: { connectedAccountId: id, userId }, data: { busyEvents: [], windowStart: null, windowEnd: null, revision: { increment: 1 } } });
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

  const assertProviderAccess = async (userId: string, id: string, capability: IntegrationCapability, provider: IntegrationProviderId, tx: Prisma.TransactionClient = db()) => {
    await assertIntegrationAccess(userId, capability, tx);
    usable(await owned(userId, id, tx), capability, provider);
  };
  const withProviderClient = <T>(input: { userId: string; connectedAccountId: string; provider: IntegrationProviderId; capability: IntegrationCapability }, operation: (client: IntegrationClient) => Promise<T>): Promise<T> => protectIntegration(async () => {
    await assertIntegrationAccess(input.userId, input.capability);
    usable(await owned(input.userId, input.connectedAccountId), input.capability, input.provider);
    async function runRequest<R>(send: (token: string) => Promise<R>): Promise<R> {
      const key = { connectedAccountId: input.connectedAccountId, integrationType: input.capability };
      for (let attempt = 0; attempt < 2; attempt++) {
        const state = await db().integrationSyncState.findUnique({ where: { connectedAccountId_integrationType: key }, select: { id: true, updatedAt: true, retryAfter: true, lastErrorCode: true, leaseToken: true } });
        if (state?.retryAfter && state.retryAfter > now()) throw new IntegrationError("PROVIDER_RATE_LIMITED", (state.retryAfter.getTime() - now().getTime()) / 1000);
        const token = await getValidAccessToken(input.userId, input.connectedAccountId, input.capability, input.provider);
        const used = await owned(input.userId, input.connectedAccountId);
        usable(used, input.capability, input.provider);
        if (!used.accessTokenEncrypted || encryption().decrypt(used.accessTokenEncrypted, credentialContext(input.userId, used.provider, used.id, "access")) !== token) continue;
        try {
          const result = await send(token);
          await assertIntegrationAccess(input.userId, input.capability);
          usable(await owned(input.userId, input.connectedAccountId), input.capability, input.provider);
          // Provider access does not mean a complete snapshot was synced. Only
          // the feature's successful commit may advance freshness timestamps.
          if (state?.lastErrorCode && !state.leaseToken) await db().integrationSyncState.updateMany({ where: { id: state.id, updatedAt: state.updatedAt }, data: { lastErrorCode: null, retryAfter: null } });
          return result;
        } catch (cause) {
          const error = safeIntegrationError(cause);
          if (!["RECONNECT_REQUIRED", "INVALID_GRANT", "AUTHORIZATION_REQUIRED", "PROVIDER_RATE_LIMITED", "PROVIDER_UNAVAILABLE"].includes(error.code)) throw error;
          await db().$transaction(async tx => {
            await tx.$queryRaw`SELECT id FROM "ConnectedAccount" WHERE id=${input.connectedAccountId} AND "userId"=${input.userId} FOR UPDATE`;
            const account = await owned(input.userId, input.connectedAccountId, tx);
            if (!["ACTIVE", "ERROR"].includes(account.status) || !account.accessTokenEncrypted || account.credentialVersion !== used.credentialVersion) return;
            // Ignore stale failures from a token superseded by reconnect/another refresh.
            if (encryption().decrypt(account.accessTokenEncrypted, credentialContext(input.userId, account.provider, account.id, "access")) !== token) return;
            if (error.code === "RECONNECT_REQUIRED" || error.code === "INVALID_GRANT") {
              const expired = attempt > 0 || !account.refreshTokenEncrypted || error.code === "INVALID_GRANT";
              await tx.connectedAccount.update({ where: { id: account.id }, data: { accessTokenExpiresAt: null,
                ...(expired ? { status: "EXPIRED", accessTokenEncrypted: null, refreshTokenEncrypted: null, lastErrorCode: "RECONNECT_REQUIRED" } : {}) } });
            } else {
              if (error.code === "AUTHORIZATION_REQUIRED") await tx.connectedAccount.update({ where: { id: account.id }, data: { deniedCapabilities: [...new Set([...account.deniedCapabilities, input.capability])], lastErrorCode: error.code } });
              const data = { lastErrorCode: error.code, ...(error.code === "PROVIDER_RATE_LIMITED" ? { retryAfter: new Date(now().getTime() + error.retryAfterSeconds! * 1000) } : {}) };
              await tx.integrationSyncState.upsert({ where: { connectedAccountId_integrationType: key }, create: { ...key, ...data, status: "FAILED" }, update: data });
            }
          });
          emitIntegrationEvent("INTEGRATION_PROVIDER_REQUEST_FAILED", { provider: input.provider, connectedAccountId: input.connectedAccountId, errorCode: error.code });
          // A 401 is safe to retry once. Unknown outcomes of writes are NOT retried here.
          if (error.code === "RECONNECT_REQUIRED" && attempt === 0) continue;
          throw error;
        }
      }
      throw new IntegrationError("RECONNECT_REQUIRED");
    }
    const client: IntegrationClient = { async read(request) {
      return runRequest(token => registry.get(input.provider).read({ ...request, capability: input.capability, accessToken: token }));
    }, async download(request) {
      const provider = registry.get(input.provider);
      if (!provider.download) throw new IntegrationError("INVALID_REQUEST");
      return runRequest(token => provider.download!({ ...request, capability: input.capability, accessToken: token }));
    }, async write(request) {
      if (input.capability !== "calendar-write") throw new IntegrationError("AUTHORIZATION_REQUIRED");
      // Serialize an already-authorized write with disconnect. Once revocation commits,
      // no new network mutation can begin. Feature code never receives the token.
      return runRequest(token => db().$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "ConnectedAccount" WHERE id=${input.connectedAccountId} AND "userId"=${input.userId} FOR UPDATE`;
        const provider = usable(await owned(input.userId, input.connectedAccountId, tx), input.capability, input.provider);
        if (!provider.write) throw new IntegrationError("INVALID_REQUEST");
        return provider.write({ ...request, capability: input.capability, accessToken: token });
      }, transactionOptions));
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
    assertProviderAccess, getValidAccessToken, disconnectConnectedAccount, withProviderClient, getIntegrationSyncState, updateIntegrationSyncState };
}
export const { startIntegrationConnection, handleIntegrationCallback, listConnectedAccounts, getConnectedAccount, getIntegrationSettings,
  assertProviderAccess, getValidAccessToken, disconnectConnectedAccount, withProviderClient, getIntegrationSyncState, updateIntegrationSyncState } = createIntegrationService();
