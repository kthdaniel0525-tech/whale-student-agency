import { hasEntitlement } from "../entitlements/service";
import "server-only";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { fromPrisma, type SendOptions } from "pg-boss";
import type { Prisma, ExternalCourseLink } from "@/generated/prisma/client";
import { db } from "../db/client";
import { academicIntegrationService } from "../academic-integrations/service";
import { academicProviderRegistry, type AcademicProviderRegistry } from "../academic-integrations/registry";
import { getBackgroundJobPublisher } from "./client";
import { getBackgroundJobConfig } from "./config";
import type { BackgroundJob, BackgroundJobResult } from "./types";
const retryPolicy = { limit: 2, delaySeconds: 60, maximumDelaySeconds: 300, exponentialBackoff: true } as const;
const payloadSchema = z.object({ version: z.literal(1), trackingId: z.string().max(100).optional(), connectedAccountId: z.string().min(1).max(100), externalCourseId: z.string().min(1).max(200) }).strict();
export function createExternalCourseSyncJob(service = academicIntegrationService): BackgroundJob<z.infer<typeof payloadSchema>> {
    return { name: "sync-external-course", version: 1, payloadSchema, retryPolicy, timeoutSeconds: 600, priority: "normal", executionScope: "system", concurrency: { scope: "global", limit: 1 }, debounceSeconds: 30,
        async handler({ payload, signal }): Promise<BackgroundJobResult> {
            const account = await db().connectedAccount.findUnique({ where: { id: payload.connectedAccountId }, select: { userId: true } });
            if (!account)
                return { skipped: true };
            if (!await hasEntitlement(account.userId, "integration.lms")) return { skipped: true, reason: "ENTITLEMENT_REQUIRED" };
            return service.syncExternalCourse(account.userId, payload.connectedAccountId, payload.externalCourseId, signal);
        }
    };
}
export const syncExternalCourseJob = createExternalCourseSyncJob();
export async function enqueueExternalCourseSync(tx: Prisma.TransactionClient, link: ExternalCourseLink, publisher?: {
    send(name: string, data?: object | null, options?: SendOptions): Promise<string | null>;
}) {
    const queue = publisher ?? await getBackgroundJobPublisher();
    const run = await tx.jobRun.create({ data: { queueJobId: randomUUID(), idempotencyKey: `academic-sync:${link.id}:${link.requestVersion}`, jobName: syncExternalCourseJob.name, jobVersion: 1, resourceId: link.id } });
    const accepted = await queue.send(syncExternalCourseJob.name, { version: 1, trackingId: run.id, connectedAccountId: link.connectedAccountId, externalCourseId: link.externalId }, { id: run.queueJobId, group: { id: link.id }, retryLimit: 2, retryDelay: 60, retryBackoff: true, retryDelayMax: 300, expireInSeconds: 600, deadLetter: getBackgroundJobConfig().deadLetterQueue, db: fromPrisma(tx) });
    if (!accepted)
        throw Error("Course sync queue unavailable");
}
export function createAcademicSyncSweep(service = academicIntegrationService, registry: AcademicProviderRegistry = academicProviderRegistry): BackgroundJob<{
    version: 1;
    trackingId?: string;
}> {
    return { name: "schedule-external-course-sync", version: 1, payloadSchema: z.object({ version: z.literal(1), trackingId: z.string().max(100).optional() }).strict(), retryPolicy, timeoutSeconds: 120, priority: "low", executionScope: "system", concurrency: { scope: "global", limit: 1 }, debounceSeconds: 60,
        async handler({ signal }) {
            const due = await db().externalCourseLink.findMany({ where: { active: true, AND: [{ OR: [{ externalEndsAt: null }, { externalEndsAt: { gte: new Date() } }] }], provider: { in: registry.list().map(p => p.id) }, nextSyncAt: { lte: new Date() }, connectedAccount: { status: { in: ["ACTIVE", "ERROR"] } }, OR: [{ requestQueuedAt: null }, { requestQueuedAt: { lt: new Date(Date.now() - 600000) } }] }, orderBy: [{ nextSyncAt: "asc" }, { id: "asc" }], take: 50, select: { userId: true, courseId: true } });
            let enqueued = 0, failed = 0;
            for (const row of due) {
                if (signal.aborted)
                    break;
                try {
                    if (!await hasEntitlement(row.userId, "integration.lms")) continue;
                    await service.requestSync(row.userId, row.courseId, true);
                    enqueued++;
                }
                catch {
                    failed++;
                }
            }
            return { enqueued, failed };
        }
    };
}
export const scheduleExternalCourseSyncJob = createAcademicSyncSweep();
