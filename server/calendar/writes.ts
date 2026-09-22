import "server-only";
import { randomUUID } from "node:crypto";
import type { CalendarTaskOptions, CalendarTaskLink, TimeWindow } from "@/lib/student/calendar/types";
import { db } from "../db/client";
import { IntegrationError, protectIntegration } from "../integrations/errors";
import { createGoogleCalendarService, googleCalendarService, calendarSyncWindow } from "./service";
import { createAvailabilityService } from "./availability";
import { zonedInstant, overlaps } from "./time";
import { localDateKey, validTimezone } from "../time/local";
export function createCalendarWriteService(calendar: ReturnType<typeof createGoogleCalendarService> = googleCalendarService) {
    const availability = createAvailabilityService(calendar);
    async function ownedTask(userId: string, taskId: string) { const task = await db().studyTask.findFirst({ where: { id: taskId, userId, studyPlan: { userId } }, include: { course: true } }); if (!task)
        throw new IntegrationError("NOT_FOUND"); return task; }
    function publicLink(link: {
        id: string;
        connectedAccountId: string;
        externalCalendarId: string;
        externalEventId: string;
        status: string;
        taskRevision: Date | null;
        syncedStart?: Date | null;
        syncedEnd?: Date | null;
    }, task: {
        updatedAt: Date;
        scheduledStart: Date | null;
        scheduledEnd: Date | null;
    }): CalendarTaskLink {
        // Construct an allowlisted provider URL; never trust an htmlLink from upstream.
        const eid = Buffer.from(`${link.externalEventId} ${link.externalCalendarId}`).toString("base64url");
        return { id: link.id, connectedAccountId: link.connectedAccountId, calendarId: link.externalCalendarId, status: link.status, needsUpdate: link.status === "LINKED" && (link.taskRevision?.getTime() !== task.updatedAt.getTime() || link.syncedStart?.getTime() !== task.scheduledStart?.getTime() || link.syncedEnd?.getTime() !== task.scheduledEnd?.getTime()), openUrl: link.status === "LINKED" ? `https://calendar.google.com/calendar/event?eid=${eid}` : null };
    }
    const getTaskOptions = (userId: string, taskId: string): Promise<CalendarTaskOptions> => protectIntegration(async () => {
        const task = await ownedTask(userId, taskId);
        const [profile, accounts, preferences, links] = await Promise.all([db().profile.findUnique({ where: { userId }, select: { timezone: true } }), calendar.integration.listConnectedAccounts(userId), db().calendarIntegrationPreference.findMany({ where: { userId, allowStudyWrites: true, connectedAccount: { userId, status: { in: ["ACTIVE", "ERROR"] }, provider: "google" } } }), db().externalEventLink.findMany({ where: { userId, studyTaskId: taskId } })]);
        return { timezone: task.scheduledTimezone ?? validTimezone(profile?.timezone), scheduledStart: task.scheduledStart?.toISOString() ?? null, scheduledEnd: task.scheduledEnd?.toISOString() ?? null, targets: preferences.filter(p => accounts.find(a => a.id === p.connectedAccountId)?.capabilities.includes("calendar-write")).map(p => ({ connectedAccountId: p.connectedAccountId, calendarId: p.externalCalendarId, label: `${accounts.find(a => a.id === p.connectedAccountId)?.email ?? "Google"} · ${p.title}` })), links: links.map(l => publicLink(l, task)) };
    });
    async function checkTime(userId: string, task: Awaited<ReturnType<typeof ownedTask>>, start: Date, end: Date) {
        const bounds = calendarSyncWindow(new Date());
        if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || start < new Date() || end > bounds.end || end <= start)
            throw new IntegrationError("INVALID_REQUEST");
        if (task.examId) {
            const exam = await db().exam.findFirst({ where: { id: task.examId, userId } });
            if (!exam || end > exam.examDate)
                throw new IntegrationError("CALENDAR_CONFLICT");
        }
        const context = await availability({ userId, start, end, forceRefresh: true, excludeTaskId: task.id });
        if (context.status === "unavailable" || context.status === "partial")
            throw new IntegrationError("CALENDAR_UNAVAILABLE");
        if (context.status === "available" && !context.days.some(d => d.freeWindows.some(w => Date.parse(w.start) <= start.getTime() && Date.parse(w.end) >= end.getTime())))
            throw new IntegrationError("CALENDAR_CONFLICT");
        const conflict = await db().studyTask.count({ where: { userId, id: { not: task.id }, status: { in: ["PLANNED", "IN_PROGRESS"] }, scheduledStart: { lt: end }, scheduledEnd: { gt: start } } });
        if (conflict)
            throw new IntegrationError("CALENDAR_CONFLICT");
    }
    const scheduleTask = (userId: string, taskId: string, localStart: string) => protectIntegration(async () => {
        const task = await ownedTask(userId, taskId);
        if (!["PLANNED", "IN_PROGRESS"].includes(task.status))
            throw new IntegrationError("INVALID_REQUEST");
        const profile = await db().profile.findUnique({ where: { userId }, select: { timezone: true } });
        const timezone = validTimezone(profile?.timezone);
        const start = zonedInstant(localStart, timezone), end = new Date(start.getTime() + task.durationMinutes * 60000);
        await checkTime(userId, task, start, end);
        await db().$transaction(async (tx) => {
            await tx.$queryRaw `SELECT 1 FROM pg_advisory_xact_lock(hashtext(${`calendar-schedule:${userId}`}))`;
            const conflict = await tx.studyTask.count({ where: { userId, id: { not: taskId }, status: { in: ["PLANNED", "IN_PROGRESS"] }, scheduledStart: { lt: end }, scheduledEnd: { gt: start } } });
            if (conflict)
                throw new IntegrationError("CALENDAR_CONFLICT");
            const changed = await tx.studyTask.updateMany({ where: { id: taskId, userId, updatedAt: task.updatedAt, status: { in: ["PLANNED", "IN_PROGRESS"] } }, data: { scheduledStart: start, scheduledEnd: end, scheduledTimezone: timezone, date: new Date(`${localDateKey(start, timezone)}T00:00:00Z`) } });
            if (!changed.count)
                throw new IntegrationError("CONNECTION_BUSY");
        });
        return getTaskOptions(userId, taskId);
    });
    type Target = {
        userId: string;
        connectedAccountId: string;
        calendarId: string;
        studyTaskId: string;
    };
    const mutate = (input: Target, action: "create" | "update" | "remove") => protectIntegration(async () => {
        const { userId, connectedAccountId, calendarId, studyTaskId } = input;
        const task = await ownedTask(userId, studyTaskId);
        await calendar.using(userId, connectedAccountId, "calendar-write", async () => { });
        const key = { studyTaskId, connectedAccountId, externalCalendarId: calendarId };
        if (action !== "remove") {
            const selected = await db().calendarIntegrationPreference.findFirst({ where: { userId, connectedAccountId, externalCalendarId: calendarId, allowStudyWrites: true } });
            if (!selected)
                throw new IntegrationError("AUTHORIZATION_REQUIRED");
            if (!task.scheduledStart || !task.scheduledEnd || task.scheduledEnd.getTime() - task.scheduledStart.getTime() !== task.durationMinutes * 60000 || !["PLANNED", "IN_PROGRESS"].includes(task.status))
                throw new IntegrationError("TASK_NOT_SCHEDULED");
        }
        let link = await db().externalEventLink.findUnique({ where: { studyTaskId_connectedAccountId_externalCalendarId: key } });
        if (link && link.userId !== userId)
            throw new IntegrationError("NOT_FOUND");
        if (action === "create" && link?.status === "LINKED")
            return publicLink(link, task);
        if (action !== "create" && !link)
            throw new IntegrationError("NOT_FOUND");
        if (action === "remove" && link?.status === "REMOVED")
            return publicLink(link, task);
        if (action !== "remove")
            await checkTime(userId, task, task.scheduledStart!, task.scheduledEnd!);
        // Reserve a stable provider event ID before HTTP. Ambiguous POST failures retry the
        // same ID, including across processes; a lost response cannot duplicate an event.
        if (!link)
            link = await db().externalEventLink.upsert({ where: { studyTaskId_connectedAccountId_externalCalendarId: key }, create: { ...key, userId, externalEventId: randomUUID().replaceAll("-", "") }, update: {} });
        const id = link.id;
        const token = randomUUID();
        const signal = AbortSignal.timeout(55000);
        // Short database claim; all provider calls happen outside transactions.
        const claim = await db().$transaction(async (tx) => {
            await tx.$queryRaw `SELECT id FROM "ConnectedAccount" WHERE id=${connectedAccountId} AND "userId"=${userId} FOR UPDATE`;
            await calendar.integration.assertProviderAccess(userId, connectedAccountId, "calendar-write", "google", tx);
            const account = await tx.connectedAccount.findFirstOrThrow({ where: { id: connectedAccountId, userId } });
            await tx.$queryRaw `SELECT id FROM "ExternalEventLink" WHERE id=${id} AND "userId"=${userId} FOR UPDATE`;
            const current = await tx.externalEventLink.findFirstOrThrow({ where: { id, userId } });
            const fresh = await tx.studyTask.findFirst({ where: { id: studyTaskId, userId, updatedAt: task.updatedAt } });
            if (!fresh) throw new IntegrationError("CONNECTION_BUSY");
            if (action === "create" && current.status === "LINKED" || action === "remove" && current.status === "REMOVED")
                return { current, skip: true, credentialVersion: account.credentialVersion };
            if (current.writeLeaseUntil && current.writeLeaseUntil > new Date()) throw new IntegrationError("CONNECTION_BUSY");
            if (action === "create" && ["MISSING", "REMOVED"].includes(current.status)) throw new IntegrationError("RESOURCE_NOT_FOUND");
            await tx.externalEventLink.update({ where: { id }, data: { writeLeaseToken: token, writeLeaseUntil: new Date(Date.now() + 60000) } });
            return { current, skip: false, credentialVersion: account.credentialVersion };
        });
        if (claim.skip) return publicLink(claim.current, task);
        const current = claim.current;
        async function beforeWrite() {
            signal.throwIfAborted();
            await calendar.integration.assertProviderAccess(userId, connectedAccountId, "calendar-write", "google");
            const valid = await db().externalEventLink.findFirst({ where: { id, userId, writeLeaseToken: token, writeLeaseUntil: { gt: new Date() },
                connectedAccount: { credentialVersion: claim.credentialVersion, status: { in: ["ACTIVE", "ERROR"] } }, studyTask: { updatedAt: task.updatedAt } } });
            if (!valid) throw new IntegrationError("CONNECTION_BUSY");
            if (action !== "remove" && !await db().calendarIntegrationPreference.count({ where: { userId, connectedAccountId, externalCalendarId: calendarId, allowStudyWrites: true } }))
                throw new IntegrationError("AUTHORIZATION_REQUIRED");
        }
        let result;
        try {
            const status = await calendar.using(userId, connectedAccountId, "calendar-write", async (adapter) => {
                const external = await adapter.getEvent(calendarId, current.externalEventId);
                if (external && external.status !== "cancelled" && external.extendedProperties?.private?.studyLinkId !== current.id)
                    throw new IntegrationError("RESOURCE_CONFLICT");
                if (action === "remove") {
                    await beforeWrite();
                    if (external && external.status !== "cancelled") await adapter.remove(calendarId, current.externalEventId);
                    return "REMOVED";
                }
                if ((!external || external.status === "cancelled") && action === "update") return "MISSING";
                const selection = await db().calendarIntegrationPreference.findFirst({ where: { userId, connectedAccountId, externalCalendarId: calendarId, allowStudyWrites: true } });
                if (!selection) throw new IntegrationError("AUTHORIZATION_REQUIRED");
                const freshEvents = await adapter.events({ connectedAccountId, calendarId, timezone: selection.timezone, start: task.scheduledStart!, end: task.scheduledEnd!, blockAllDay: selection.blockAllDay });
                const window: TimeWindow = { start: task.scheduledStart!.toISOString(), end: task.scheduledEnd!.toISOString(), durationMinutes: task.durationMinutes };
                if (freshEvents.events.some(e => e.externalId !== current.externalEventId && e.blocksTime && e.start && e.end && overlaps(window, { start: e.start, end: e.end })))
                    throw new IntegrationError("CALENDAR_CONFLICT");
                await beforeWrite();
                const body = { summary: task.title.slice(0, 200), description: task.course ? `Study session · ${task.course.courseCode}` : "Study session", start: { dateTime: window.start, timeZone: task.scheduledTimezone ?? selection.timezone }, end: { dateTime: window.end, timeZone: task.scheduledTimezone ?? selection.timezone }, extendedProperties: { private: { studyLinkId: current.id } }, reminders: { useDefault: false } };
                if (external && external.status !== "cancelled") {
                    if (action === "update") await adapter.update(calendarId, current.externalEventId, body);
                } else {
                    try { await adapter.create(calendarId, current.externalEventId, body); }
                    catch (e) {
                        if (!(e instanceof IntegrationError && e.code === "RESOURCE_CONFLICT")) throw e;
                        const found = await adapter.getEvent(calendarId, current.externalEventId);
                        if (found?.extendedProperties?.private?.studyLinkId !== id || found.status === "cancelled") throw new IntegrationError("RESOURCE_CONFLICT");
                    }
                }
                return "LINKED";
            }, signal);
            result = await db().$transaction(async tx => {
                await tx.$queryRaw `SELECT id FROM "ConnectedAccount" WHERE id=${connectedAccountId} AND "userId"=${userId} FOR UPDATE`;
                await calendar.integration.assertProviderAccess(userId, connectedAccountId, "calendar-write", "google", tx);
                const changed = await tx.externalEventLink.updateMany({ where: { id, userId, writeLeaseToken: token, writeLeaseUntil: { gt: new Date() },
                    connectedAccount: { credentialVersion: claim.credentialVersion, status: { in: ["ACTIVE", "ERROR"] } } }, data: {
                        status, writeLeaseToken: null, writeLeaseUntil: null,
                        // Keep the exact snapshot sent, so edits during HTTP remain visibly unsynced.
                        ...(status === "LINKED" ? { syncedStart: task.scheduledStart, syncedEnd: task.scheduledEnd, taskRevision: task.updatedAt } : {}),
                    } });
                if (!changed.count) throw new IntegrationError("CONNECTION_BUSY");
                return tx.externalEventLink.findFirstOrThrow({ where: { id, userId } });
            });
        } finally {
            // A stale worker cannot clear a newer lease. Unknown external outcomes keep
            // the durable event ID, allowing the next explicit retry to reconcile it.
            await db().externalEventLink.updateMany({ where: { id, userId, writeLeaseToken: token }, data: { writeLeaseToken: null, writeLeaseUntil: null } });
        }
        await db().integrationSyncState.updateMany({ where: { connectedAccountId, integrationType: "calendar-read" }, data: { lastSuccessfulSyncAt: null } });
        return publicLink(result, task);
    });
    const createStudyCalendarEvent = (input: Target) => protectIntegration(async () => {
        // Explicit re-add after removal gets a durable new ID. An uncertain write keeps its
        // PENDING ID instead, so retry after a dropped response remains idempotent.
        await ownedTask(input.userId, input.studyTaskId);
        await calendar.using(input.userId, input.connectedAccountId, "calendar-write", async () => { });
        await db().externalEventLink.updateMany({ where: { userId: input.userId, studyTaskId: input.studyTaskId, connectedAccountId: input.connectedAccountId, externalCalendarId: input.calendarId, status: { in: ["MISSING", "REMOVED"] }, OR: [{ writeLeaseUntil: null }, { writeLeaseUntil: { lte: new Date() } }] }, data: { status: "PENDING", externalEventId: randomUUID().replaceAll("-", "") } });
        return mutate(input, "create");
    });
    return { getTaskOptions, scheduleTask, createStudyCalendarEvent, updateStudyCalendarEvent: (input: Target) => mutate(input, "update"), removeStudyCalendarEvent: (input: Target) => mutate(input, "remove") };
}
export const calendarWriteService = createCalendarWriteService();
