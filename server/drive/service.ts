import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ExternalFileLink, Document, Prisma } from "@/generated/prisma/client";
import { db } from "../db/client";
import { assertCourse, uploadDocument } from "../documents/service";
import { DocumentError } from "../documents/config";
import { validateFile } from "../documents/extraction";
import { replaceDocumentSource } from "../documents/replacement";
import { type EmbeddingProvider } from "../documents/embeddings";
import { NotFoundError } from "../services/academic";
import { assertProviderAccess, getConnectedAccount, updateIntegrationSyncState } from "../integrations/service";
import { IntegrationError, safeIntegrationError } from "../integrations/errors";
import { driveResourceSchema, type DriveResource, type DriveImportView, type DriveSettings } from "@/lib/student/drive/types";
import { googleDriveService, driveDownloadName } from "./google";
import { driveEvent } from "./events";
const identity = (input: DriveResource) => ({ connectedAccountId: input.connectedAccountId, externalFileId: input.externalFileId, courseId: input.courseId });
const key = (input: DriveResource) => ({ connectedAccountId_externalFileId_courseId: identity(input) });
const active = (link: ExternalFileLink) => (link.syncStatus === "PENDING" && link.updatedAt.getTime() > Date.now() - 15 * 60000) || (link.syncStatus === "IMPORTING" && (link.leaseUntil?.getTime() ?? 0) > Date.now());
const errorText = (code: string | null) => code === "SOURCE_UNAVAILABLE" ? "The Drive source is unavailable. Your imported copy is preserved." : code === "INVALID_FILE" ? "This file could not be read. Use a valid PDF, TXT, Markdown or Google Doc up to 10 MB." : code ? "Import or refresh failed. Check the connection and try again; any existing copy is preserved." : null;
async function protect<T>(operation: () => Promise<T>): Promise<T> {
    try {
        return await operation();
    }
    catch (error) {
        if (error instanceof DocumentError || error instanceof NotFoundError || error instanceof z.ZodError)
            throw error;
        throw safeIntegrationError(error);
    }
}
async function lockAccess(tx: Prisma.TransactionClient, userId: string, accountId: string, courseId: string) {
    // Same lock order as uploads/disconnect, then the external-source lease.
    await tx.$queryRaw `SELECT id FROM "User" WHERE id=${userId} FOR UPDATE`;
    await tx.$queryRaw `SELECT id FROM "ConnectedAccount" WHERE id=${accountId} AND "userId"=${userId} FOR UPDATE`;
    await assertProviderAccess(userId, accountId, "drive-read", "google", tx);
    const course = await tx.$queryRaw<{
        id: string;
    }[]> `SELECT id FROM "Course" WHERE id=${courseId} AND "userId"=${userId} FOR KEY SHARE`;
    if (!course.length)
        throw new NotFoundError();
}
async function ownedLink(userId: string, documentId: string) {
    const link = await db().externalFileLink.findFirst({ where: { documentId, userId, document: { userId }, course: { userId }, connectedAccount: { userId } } });
    if (!link)
        throw new NotFoundError();
    return link;
}
async function view(link: ExternalFileLink, loaded?: Pick<Document, "processingStatus" | "processingError"> | null): Promise<DriveImportView> {
    const document = loaded !== undefined ? loaded : link.documentId ? await db().document.findFirst({ where: { id: link.documentId, userId: link.userId }, select: { processingStatus: true, processingError: true } }) : null;
    return { id: link.id, name: link.name, documentId: link.documentId, courseId: link.courseId,
        status: document ? document.processingStatus === "READY" ? "Ready" : document.processingStatus === "FAILED" ? "Failed" : "Processing" : ["FAILED", "UNAVAILABLE"].includes(link.syncStatus) ? "Failed" : "Importing",
        syncStatus: link.syncStatus, error: errorText(link.errorCode) ?? document?.processingError ?? null };
}
export async function listDriveImports(userId: string, accountId: string, courseId?: string) {
    await getConnectedAccount(userId, accountId); // Local copies/status can still be viewed after disconnect.
    if (courseId)
        await assertCourse(userId, courseId);
    const links = await db().externalFileLink.findMany({ where: { userId, connectedAccountId: accountId, ...(courseId ? { courseId } : {}) }, include: { document: { where: { userId }, select: { processingStatus: true, processingError: true } } }, orderBy: { createdAt: "desc" }, take: 100 });
    return Promise.all(links.map(link => view(link, link.document)));
}
export async function getDriveSettings(userId: string, accountId: string): Promise<DriveSettings> {
    const account = await getConnectedAccount(userId, accountId, "drive-read");
    if (account.provider !== "google")
        throw new IntegrationError("INVALID_REQUEST");
    const state = await db().integrationSyncState.findUnique({ where: { connectedAccountId_integrationType: { connectedAccountId: accountId, integrationType: "drive-read" } }, select: { lastSuccessfulSyncAt: true } });
    return { health: account.health, enabled: account.status !== "disconnected" && account.capabilities.includes("drive-read"), needsReconnect: ["needs-reconnect", "disconnected"].includes(account.status),
        importedCount: await db().externalFileLink.count({ where: { userId, connectedAccountId: accountId, documentId: { not: null } } }), lastSuccessfulAccess: state?.lastSuccessfulSyncAt?.toISOString() ?? null };
}
export type DriveEnqueue = (tx: Prisma.TransactionClient, link: ExternalFileLink) => Promise<void>;
async function enqueue(tx: Prisma.TransactionClient, link: ExternalFileLink) {
    const { enqueueDriveImport } = await import("../jobs/import-google-drive-file");
    await enqueueDriveImport(tx, link);
}
/** Fast request path. DB link and durable job commit together, including each independent batch item. */
export async function requestDriveImport(userId: string, raw: DriveResource, publish: DriveEnqueue = enqueue) {
    return protect(async () => {
        const input = driveResourceSchema.parse(raw);
        await assertCourse(userId, input.courseId);
        await googleDriveService.authorize(userId, input.connectedAccountId);
        const previous = await db().externalFileLink.findUnique({ where: key(input) });
        if (previous?.userId === userId && (previous.documentId || active(previous)))
            return view(previous);
        const file = await googleDriveService.metadata(userId, input.connectedAccountId, input.externalFileId);
        if (!file.importable)
            throw new DocumentError(file.unavailableReason ?? "This file cannot be imported.");
        const link = await db().$transaction(async (tx) => {
            await lockAccess(tx, userId, input.connectedAccountId, input.courseId);
            const current = await tx.externalFileLink.findUnique({ where: key(input) });
            if (current && (current.documentId || active(current)))
                return current;
            if (!current && await tx.externalFileLink.count({ where: { userId } }) >= 200)
                throw new DocumentError("Your import limit is reached. Remove unused course documents before importing more.");
            const data = { name: file.name, externalMimeType: file.mimeType, webViewLink: file.webViewLink, syncStatus: "PENDING", errorCode: null, leaseToken: null, leaseUntil: null };
            const result = current ? await tx.externalFileLink.update({ where: { id: current.id }, data: { ...data, requestVersion: { increment: 1 } } }) :
                await tx.externalFileLink.create({ data: { ...identity(input), userId, provider: "google", ...data } });
            await publish(tx, result);
            return result;
        }, { timeout: 15000 });
        driveEvent("IMPORT_REQUESTED", link.id);
        return view(link);
    });
}
export async function checkExternalFileFreshness(userId: string, documentId: string) {
    return protect(async () => {
        const link = await ownedLink(userId, documentId);
        await googleDriveService.authorize(userId, link.connectedAccountId);
        try {
            const file = await googleDriveService.metadata(userId, link.connectedAccountId, link.externalFileId);
            const changed = link.externalModifiedAt?.toISOString() !== file.modifiedAt;
            await db().externalFileLink.updateMany({ where: { id: link.id, userId, requestVersion: link.requestVersion, syncStatus: { notIn: ["PENDING", "IMPORTING"] } },
                data: { lastCheckedAt: new Date(), syncStatus: changed ? "CHANGED" : "IDLE", errorCode: null, webViewLink: file.webViewLink } });
            await updateIntegrationSyncState(userId, link.connectedAccountId, "drive-read", { status: "COMPLETED" });
            return { changed, available: true };
        }
        catch (error) {
            if (error instanceof IntegrationError && ["RESOURCE_NOT_FOUND", "RESOURCE_ACCESS_DENIED"].includes(error.code)) {
                await db().externalFileLink.updateMany({ where: { id: link.id, userId, syncStatus: { notIn: ["PENDING", "IMPORTING"] } }, data: { syncStatus: "UNAVAILABLE", errorCode: "SOURCE_UNAVAILABLE", lastCheckedAt: new Date() } });
                driveEvent("SOURCE_UNAVAILABLE", link.id);
                return { changed: false, available: false };
            }
            throw error;
        }
    });
}
export async function requestDriveRefresh(userId: string, documentId: string, publish: DriveEnqueue = enqueue) {
    return protect(async () => {
        const link = await ownedLink(userId, documentId);
        await googleDriveService.authorize(userId, link.connectedAccountId);
        if (active(link))
            return view(link);
        const freshness = await checkExternalFileFreshness(userId, documentId);
        if (!freshness.available || !freshness.changed)
            return view((await db().externalFileLink.findUniqueOrThrow({ where: { id: link.id } })));
        const updated = await db().$transaction(async (tx) => {
            await lockAccess(tx, userId, link.connectedAccountId, link.courseId);
            const current = await tx.externalFileLink.findUnique({ where: { id: link.id } });
            if (!current || current.userId !== userId)
                throw new NotFoundError();
            if (active(current))
                return current;
            const result = await tx.externalFileLink.update({ where: { id: link.id }, data: { syncStatus: "PENDING", errorCode: null, requestVersion: { increment: 1 }, leaseToken: null, leaseUntil: null } });
            await publish(tx, result);
            return result;
        });
        return view(updated);
    });
}
/** Worker path. Lease serializes the file/course across retries and multiple workers. */
export async function importDriveFile(input: DriveResource & {
    userId: string;
}, options: {
    provider?: EmbeddingProvider;
    signal?: AbortSignal;
} = {}) {
    const { userId } = input;
    driveResourceSchema.parse(identity(input));
    const token = randomUUID(), deadline = Date.now() + 160000;
    const check = () => { if (options.signal?.aborted || Date.now() > deadline)
        throw new IntegrationError("PROVIDER_UNAVAILABLE"); };
    let link: ExternalFileLink | null = null;
    try {
        await assertCourse(userId, input.courseId);
        await googleDriveService.authorize(userId, input.connectedAccountId);
        link = await db().$transaction(async (tx) => {
            await lockAccess(tx, userId, input.connectedAccountId, input.courseId);
            const row = await tx.externalFileLink.findUnique({ where: key(input) });
            if (!row || row.userId !== userId)
                throw new NotFoundError();
            if (!["PENDING", "FAILED", "IMPORTING"].includes(row.syncStatus) || (row.leaseUntil && row.leaseUntil.getTime() > Date.now()))
                return null;
            return tx.externalFileLink.update({ where: { id: row.id }, data: { syncStatus: "IMPORTING", errorCode: null, leaseToken: token, leaseUntil: new Date(Date.now() + 180000) } });
        });
        if (!link)
            return { skipped: true, documentId: null };
        check();
        const file = await googleDriveService.metadata(userId, input.connectedAccountId, input.externalFileId, options.signal);
        const bytes = await googleDriveService.download(userId, file, options.signal);
        const fileName = driveDownloadName(file);
        validateFile(fileName, bytes);
        check();
        // Metadata after download prevents recording an old timestamp for a newer/mixed source.
        const after = await googleDriveService.metadata(userId, input.connectedAccountId, input.externalFileId, options.signal);
        if (after.modifiedAt !== file.modifiedAt)
            throw new IntegrationError("PROVIDER_UNAVAILABLE");
        const claimed = link;
        const lockClaim = async (tx: Prisma.TransactionClient) => {
            await lockAccess(tx, userId, input.connectedAccountId, input.courseId);
            const rows = await tx.$queryRaw<{
                id: string;
            }[]> `SELECT id FROM "ExternalFileLink" WHERE id=${claimed.id} AND "userId"=${userId} AND "leaseToken"=${token} AND "leaseUntil">NOW() FOR UPDATE`;
            if (!rows.length)
                throw new IntegrationError("CONNECTION_BUSY");
            check();
        };
        const complete = async (tx: Prisma.TransactionClient, documentId: string) => {
            await tx.externalFileLink.update({ where: { id: claimed.id }, data: { documentId, name: file.name, externalMimeType: file.mimeType, externalModifiedAt: new Date(file.modifiedAt), importedAt: new Date(), lastCheckedAt: new Date(), webViewLink: file.webViewLink,
                    syncStatus: "IDLE", errorCode: null, leaseToken: null, leaseUntil: null } });
        };
        let documentId = link.documentId;
        if (!documentId) {
            const document = await uploadDocument(userId, { title: file.name.slice(0, 200), courseId: input.courseId }, fileName, bytes, async (tx, doc) => {
                await lockClaim(tx);
                await complete(tx, doc.id);
            });
            documentId = document.id;
        }
        else {
            const targetId = documentId;
            await replaceDocumentSource({ userId, documentId: targetId, courseId: input.courseId, fileName, bytes }, {
                guard: lockClaim, complete: tx => complete(tx, targetId), check, provider: options.provider,
            });
        }
        driveEvent(link.documentId ? "REFRESH_SUCCESS" : "IMPORT_SUCCESS", link.id);
        // An access-health write must not turn an already-committed import into a failed replacement.
        await updateIntegrationSyncState(userId, input.connectedAccountId, "drive-read", { status: "COMPLETED" }).catch(() => { });
        return { skipped: false, documentId };
    }
    catch (cause) {
        const error = cause instanceof DocumentError ? cause : cause instanceof NotFoundError ? new IntegrationError("NOT_FOUND") : safeIntegrationError(cause);
        const unavailable = error instanceof IntegrationError && ["RESOURCE_NOT_FOUND", "RESOURCE_ACCESS_DENIED"].includes(error.code);
        if (!link) {
            await db().externalFileLink.updateMany({ where: { ...identity(input), userId, syncStatus: "PENDING" }, data: { syncStatus: "FAILED", errorCode: error instanceof IntegrationError ? error.code : "INVALID_FILE", leaseToken: null, leaseUntil: null } });
        }
        if (link) {
            await db().externalFileLink.updateMany({ where: { id: link.id, userId, leaseToken: token }, data: { syncStatus: unavailable ? "UNAVAILABLE" : "FAILED", errorCode: unavailable ? "SOURCE_UNAVAILABLE" : cause instanceof DocumentError ? "INVALID_FILE" : error instanceof IntegrationError ? error.code : "STORAGE_FAILURE", leaseToken: null, leaseUntil: null } });
            driveEvent(unavailable ? "SOURCE_UNAVAILABLE" : link.documentId ? "REFRESH_FAILURE" : "IMPORT_FAILURE", link.id);
        }
        if (error instanceof IntegrationError && ["DISCONNECTED", "RECONNECT_REQUIRED", "AUTHORIZATION_REQUIRED", "INVALID_GRANT"].includes(error.code))
            driveEvent("TOKEN_SCOPE_ERROR", link?.id);
        throw error;
    }
}
