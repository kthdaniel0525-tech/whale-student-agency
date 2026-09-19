import "server-only";
import { recordIntegrationMetric } from "../integrations/metrics";
import type { Prisma } from "@/generated/prisma/client";
import { db } from "../db/client";
import { getOwnedConnection } from "../integrations/connections";
import type { AcademicCapability } from "@/lib/student/academic-integrations/types";
import type { AcademicCall, AcademicConnection, AcademicCredentialAccess } from "./types";
import type { AcademicProviderRegistry } from "./registry";
import { AcademicIntegrationError, academicError } from "./errors";
import { academicEvent } from "./events";
export function academicAccess(registry: AcademicProviderRegistry, credentials?: (connection: AcademicConnection) => AcademicCredentialAccess) {
    const authorize = async (userId: string, accountId: string, capability: AcademicCapability, tx: Prisma.TransactionClient = db()) => {
        const account = await getOwnedConnection(userId, accountId, tx).catch(cause => { throw academicError(cause); });
        if (!["ACTIVE", "ERROR"].includes(account.status)) {
            academicEvent("AUTH_FAILURE");
            throw new AcademicIntegrationError("DISCONNECTED");
        }
        const provider = registry.get(account.provider);
        const config = provider.configurationSchema.safeParse(account.connectionConfig ?? {});
        if (!config.success)
            throw new AcademicIntegrationError("CONFIGURATION");
        const connection: AcademicConnection = { id: account.id, userId, provider: account.provider, configuration: config.data, grants: account.scopes };
        if (account.deniedCapabilities.includes(capability) || !provider.capabilities.includes(capability) || !provider.grantedCapabilities(connection).includes(capability)) {
            academicEvent("AUTH_FAILURE");
            throw new AcademicIntegrationError("AUTHORIZATION_REQUIRED");
        }
        return { provider, connection, credentialVersion: account.credentialVersion };
    };
    return { authorize, async call<T>(userId: string, accountId: string, capability: AcademicCapability, signal: AbortSignal, operation: (call: AcademicCall, provider: ReturnType<AcademicProviderRegistry["get"]>) => Promise<T>) {
            signal.throwIfAborted();
            const before = await authorize(userId, accountId, capability);
            const key = { connectedAccountId: accountId, integrationType: capability };
            const state = await db().integrationSyncState.findUnique({ where: { connectedAccountId_integrationType: key } });
            if (state?.retryAfter && state.retryAfter.getTime() > Date.now()) throw new AcademicIntegrationError("PROVIDER_RATE_LIMITED");
            let value: T;
            try {
                value = await operation({ connection: before.connection, signal, credentials: credentials?.(before.connection) ?? { async use() { throw new AcademicIntegrationError("CONFIGURATION"); } } }, before.provider);
            } catch (cause) {
                const error = academicError(cause);
                if (error.code === "PROVIDER_RATE_LIMITED") recordIntegrationMetric("rateLimits");
                await db().$transaction(async tx => {
                    await tx.$queryRaw`SELECT id FROM "ConnectedAccount" WHERE id=${accountId} AND "userId"=${userId} FOR UPDATE`;
                    const current = await getOwnedConnection(userId, accountId, tx);
                    if (current.credentialVersion !== before.credentialVersion || !["ACTIVE", "ERROR"].includes(current.status)) return;
                    if (error.code === "DISCONNECTED") await tx.connectedAccount.update({ where: { id: accountId }, data: { status: "EXPIRED", lastErrorCode: "RECONNECT_REQUIRED", accessTokenEncrypted: null, refreshTokenEncrypted: null, accessTokenExpiresAt: null } });
                    if (error.code === "AUTHORIZATION_REQUIRED") await tx.connectedAccount.update({ where: { id: accountId }, data: { deniedCapabilities: [...new Set([...current.deniedCapabilities, capability])], lastErrorCode: error.code } });
                    if (error.code === "PROVIDER_RATE_LIMITED") {
                        const data = { lastErrorCode: error.code, retryAfter: new Date(Date.now() + 60000) };
                        await tx.integrationSyncState.upsert({ where: { connectedAccountId_integrationType: key }, create: { ...key, ...data, status: "FAILED" }, update: data });
                    }
                });
                throw error;
            }
            signal.throwIfAborted();
            const after = await authorize(userId, accountId, capability);
            if (after.credentialVersion !== before.credentialVersion)
                throw new AcademicIntegrationError("DISCONNECTED");
            if (state) await db().integrationSyncState.updateMany({ where: { id: state.id, updatedAt: state.updatedAt }, data: { status: "COMPLETED", lastErrorCode: null, retryAfter: null, lastSuccessfulSyncAt: new Date() } });
            return value;
        } };
}
