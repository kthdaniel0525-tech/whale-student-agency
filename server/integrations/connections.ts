import "server-only";
import type { Prisma } from "@/generated/prisma/client";
import { db } from "../db/client";
import { IntegrationError } from "./errors";
/** Provider-neutral, secret-free account metadata for non-OAuth-only integrations. */
export async function getOwnedConnection(userId: string, id: string, tx: Prisma.TransactionClient = db()) {
    const account = await tx.connectedAccount.findFirst({ where: { id, userId }, select: { id: true, userId: true, provider: true, displayName: true, email: true, status: true, scopes: true, deniedCapabilities: true, connectionConfig: true, credentialVersion: true } });
    if (!account)
        throw new IntegrationError("NOT_FOUND");
    return account;
}
/** Local denial commits even when a provider has no remote revocation mechanism. */
export async function revokeImportedConnection(userId: string, id: string, expectedProvider: string) {
    return db().$transaction(async (tx) => {
        await tx.$queryRaw `SELECT id FROM "User" WHERE id=${userId} FOR UPDATE`;
        await tx.$queryRaw `SELECT id FROM "ConnectedAccount" WHERE id=${id} AND "userId"=${userId} FOR UPDATE`;
        const account = await getOwnedConnection(userId, id, tx);
        if (account.provider !== expectedProvider)
            throw new IntegrationError("NOT_FOUND");
        await tx.connectedAccount.update({ where: { id }, data: { status: "REVOKED", accessTokenEncrypted: null, refreshTokenEncrypted: null, accessTokenExpiresAt: null, revokedAt: new Date(), credentialVersion: { increment: 1 } } });
        await tx.integrationSyncState.updateMany({ where: { connectedAccountId: id }, data: { status: "IDLE", leaseToken: null, leaseUntil: null, cursorEncrypted: null } });
        await tx.externalCourseLink.updateMany({ where: { connectedAccountId: id, userId }, data: { active: false, requestQueuedAt: null } });
    });
}
