import "server-only";
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
        if (!provider.capabilities.includes(capability) || !provider.grantedCapabilities(connection).includes(capability)) {
            academicEvent("AUTH_FAILURE");
            throw new AcademicIntegrationError("AUTHORIZATION_REQUIRED");
        }
        return { provider, connection, credentialVersion: account.credentialVersion };
    };
    return { authorize, async call<T>(userId: string, accountId: string, capability: AcademicCapability, signal: AbortSignal, operation: (call: AcademicCall, provider: ReturnType<AcademicProviderRegistry["get"]>) => Promise<T>) {
            signal.throwIfAborted();
            const before = await authorize(userId, accountId, capability);
            const value = await operation({ connection: before.connection, signal, credentials: credentials?.(before.connection) ?? { async use() { throw new AcademicIntegrationError("CONFIGURATION"); } } }, before.provider);
            signal.throwIfAborted();
            const after = await authorize(userId, accountId, capability);
            if (after.credentialVersion !== before.credentialVersion)
                throw new AcademicIntegrationError("DISCONNECTED");
            return value;
        } };
}
