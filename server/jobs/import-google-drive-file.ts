import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { fromPrisma, type SendOptions } from "pg-boss";
import type { ExternalFileLink, Prisma } from "@/generated/prisma/client";
import { driveResourceSchema, type DriveResource } from "@/lib/student/drive/types";
import { db } from "../db/client";
import { importDriveFile } from "../drive/service";
import { processNextDocument } from "../documents/processor";
import { getBackgroundJobPublisher } from "./client";
import { getBackgroundJobConfig } from "./config";
import type { BackgroundJob } from "./types";
import { BackgroundJobError } from "./errors";
const payloadSchema = driveResourceSchema.extend({ version: z.literal(1), trackingId: z.string().max(100).optional() }).strict();
export const importGoogleDriveFileJob: BackgroundJob<DriveResource & {
    version: 1;
    trackingId?: string;
}> = {
    name: "import-google-drive-file", version: 1, payloadSchema,
    retryPolicy: { limit: 2, delaySeconds: 30, maximumDelaySeconds: 120, exponentialBackoff: true },
    timeoutSeconds: 300, priority: "normal", executionScope: "system", concurrency: { scope: "global", limit: 1 }, debounceSeconds: 1,
    async handler({ payload, signal }) {
        const account = await db().connectedAccount.findFirst({ where: { id: payload.connectedAccountId, provider: "google" }, select: { userId: true } });
        if (!account)
            return { skipped: true };
        const result = await importDriveFile({ ...payload, userId: account.userId }, { signal });
        // Resume local processing after a worker crash without re-downloading a committed copy.
        const local = result.documentId ?? (await db().externalFileLink.findFirst({ where: { connectedAccountId: payload.connectedAccountId, externalFileId: payload.externalFileId, courseId: payload.courseId, userId: account.userId, syncStatus: "IDLE", document: { userId: account.userId } }, select: { documentId: true } }))?.documentId;
        if (local && !signal.aborted) {
            await processNextDocument(undefined, local, 120000);
            const document = await db().document.findFirst({ where: { id: local, userId: account.userId }, select: { processingStatus: true } });
            if (document?.processingStatus === "FAILED") throw new BackgroundJobError("PROCESSING_FAILED");
        }
        return result;
    },
};
/** Resource IDs only. Queue insertion uses the same transaction as the import request. */
export async function enqueueDriveImport(tx: Prisma.TransactionClient, link: ExternalFileLink, publisher?: {
    send(name: string, data?: object | null, options?: SendOptions): Promise<string | null>;
}) {
    const queue = publisher ?? await getBackgroundJobPublisher();
    const run = await tx.jobRun.create({ data: { queueJobId: randomUUID(), idempotencyKey: `drive-import:${link.id}:${link.requestVersion}`, jobName: importGoogleDriveFileJob.name, jobVersion: 1, resourceId: link.id } });
    const id = await queue.send(importGoogleDriveFileJob.name, { version: 1, trackingId: run.id, connectedAccountId: link.connectedAccountId, externalFileId: link.externalFileId, courseId: link.courseId }, { id: run.queueJobId, group: { id: link.id }, retryLimit: 2, retryDelay: 30, retryBackoff: true, retryDelayMax: 120, expireInSeconds: 300, deadLetter: getBackgroundJobConfig().deadLetterQueue, db: fromPrisma(tx) });
    if (!id)
        throw new Error("Import queue unavailable");
}
