import "server-only";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { fromPrisma, type PgBoss } from "pg-boss";
import { db } from "../db/client";
import { googleCalendarService } from "../calendar/service";
import { getBackgroundJobPublisher } from "./client";
import { getBackgroundJobConfig } from "./config";
import type { BackgroundJob } from "./types";
const retryPolicy = { limit: 2, delaySeconds: 30, maximumDelaySeconds: 120, exponentialBackoff: true } as const;
export const syncGoogleCalendarJob: BackgroundJob<{
    version: 1;
    connectedAccountId: string;
    trackingId?: string;
}> = {
    name: "sync-google-calendar", version: 1, payloadSchema: z.object({ version: z.literal(1), connectedAccountId: z.string().min(1).max(100), trackingId: z.string().max(100).optional() }).strict(),
    retryPolicy, timeoutSeconds: 180, priority: "normal", executionScope: "system", concurrency: { scope: "global", limit: 1 }, debounceSeconds: 30,
    async handler({ payload, signal }) {
        const account = await db().connectedAccount.findFirst({ where: { id: payload.connectedAccountId, provider: "google", status: { in: ["ACTIVE", "ERROR"] }, calendarPreferences: { some: { OR: [{ enabledForAvailability: true }, { allowStudyWrites: true }] } } }, select: { userId: true, id: true } });
        if (!account)
            return { skipped: true };
        return googleCalendarService.syncAccount(account.userId, account.id, true, signal);
    },
};
/** Only trusted scheduler code or an ownership-checked HTTP handler calls this. */
export async function enqueueGoogleCalendarSync(accountId: string, publisher?: Pick<PgBoss, "sendDebounced">, scheduled = false) {
    const now = Date.now(), key = `calendar-sync:${accountId}:${Math.floor(now / 30000)}`;
    const previous = await db().jobRun.findUnique({ where: { idempotencyKey: key } });
    if (previous)
        return { id: previous.id, deduplicated: true };
    const queue = publisher ?? await getBackgroundJobPublisher();
    const config = getBackgroundJobConfig();
    try {
        return await db().$transaction(async (tx) => {
            await tx.$queryRaw`SELECT id FROM "ConnectedAccount" WHERE id=${accountId} FOR UPDATE`;
            const owner = await tx.connectedAccount.findUnique({ where: { id: accountId }, select: { id: true } });
            if (!owner)
                return { id: null, deduplicated: false };
            const active = await tx.jobRun.findFirst({ where: { jobName: syncGoogleCalendarJob.name, resourceId: accountId, status: { in: ["PENDING", "RUNNING"] }, createdAt: { gt: new Date(now - 15 * 60000) } }, select: { id: true } });
            if (active) return { id: active.id, deduplicated: true };
            const run = await tx.jobRun.create({ data: { queueJobId: randomUUID(), idempotencyKey: key, jobName: syncGoogleCalendarJob.name, jobVersion: 1, resourceId: accountId } });
            const accepted = await queue.sendDebounced(syncGoogleCalendarJob.name, { version: 1, trackingId: run.id, connectedAccountId: accountId }, { id: run.queueJobId, group: { id: accountId }, ...(scheduled ? { startAfter: new Date(now + [...accountId].reduce((n, c) => (n * 31 + c.charCodeAt(0)) % 60000, 0)) } : {}), retryLimit: 2, retryDelay: 30, retryBackoff: true, retryDelayMax: 120, expireInSeconds: 180, deadLetter: config.deadLetterQueue, db: fromPrisma(tx) }, 30, accountId);
            if (!accepted) {
                await tx.jobRun.delete({ where: { id: run.id } });
                return { id: null, deduplicated: true };
            }
            return { id: run.id, deduplicated: false };
        });
    }
    catch (error) {
        const duplicate = await db().jobRun.findUnique({ where: { idempotencyKey: key } });
        if (duplicate)
            return { id: duplicate.id, deduplicated: true };
        throw error;
    }
}
export function createCalendarSyncSweep(enqueue = (id: string) => enqueueGoogleCalendarSync(id, undefined, true)): BackgroundJob<{
    version: 1;
    trackingId?: string;
}> { return {
    name: "schedule-google-calendar-sync", version: 1, payloadSchema: z.object({ version: z.literal(1), trackingId: z.string().max(100).optional() }).strict(), retryPolicy, timeoutSeconds: 120, priority: "low", executionScope: "system", concurrency: { scope: "global", limit: 1 }, debounceSeconds: 60,
    async handler({ signal }) {
        const due = new Date(Date.now() - 15 * 60000);
        const accounts = await db().connectedAccount.findMany({ where: { provider: "google", status: { in: ["ACTIVE", "ERROR"] }, calendarPreferences: { some: { OR: [{ enabledForAvailability: true }, { allowStudyWrites: true }] } }, NOT: { syncStates: { some: { integrationType: "calendar-read", lastSyncStartedAt: { gte: due } } } } }, select: { id: true }, orderBy: { id: "asc" }, take: 100 });
        let enqueued = 0, failed = 0;
        for (const account of accounts) {
            if (signal.aborted)
                break;
            try {
                await enqueue(account.id);
                enqueued++;
            } catch { failed++; } // One unavailable account/queue publication must not starve the batch.
        }
        return { enqueued, failed };
    },
}; }
export const scheduleGoogleCalendarSyncJob = createCalendarSyncSweep();
