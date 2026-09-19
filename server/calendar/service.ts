import "server-only";
import { recordIntegrationMetric } from "../integrations/metrics";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ExternalCalendarEvent, CalendarSettings } from "@/lib/student/calendar/types";
import type { CalendarIntegrationPreference, Prisma } from "@/generated/prisma/client";
import { db } from "../db/client";
import { createIntegrationService } from "../integrations/service";
import { getTokenEncryptionService, credentialContext, type TokenEncryptionService } from "../integrations/encryption";
import { IntegrationError, protectIntegration, safeIntegrationError } from "../integrations/errors";
import { GoogleCalendarAdapter } from "./google";
import { CALENDAR_CONFIG } from "./config";
export const calendarSelectionSchema = z.object({ calendars: z.array(z.object({ id: z.string().min(1).max(1024), enabledForAvailability: z.boolean(), allowStudyWrites: z.boolean(), blockAllDay: z.boolean().default(false) }).strict()).max(CALENDAR_CONFIG.maxCalendars) }).strict().refine(x => new Set(x.calendars.map(c => c.id)).size === x.calendars.length);
const cursorSchema = z.record(z.object({ token: z.string().max(4096), start: z.string(), end: z.string(), revision: z.number() }));
export type CalendarCursor = z.infer<typeof cursorSchema>;
export function calendarSyncWindow(now: Date) { const day = Date.parse(`${now.toISOString().slice(0, 10)}T00:00:00Z`); return { start: new Date(day - CALENDAR_CONFIG.pastDays * 86400000), end: new Date(day + CALENDAR_CONFIG.futureDays * 86400000) }; }
export function cachedEvents(row: Pick<CalendarIntegrationPreference, "busyEvents">): ExternalCalendarEvent[] {
    const result = z.array(z.object({ externalId: z.string(), calendarId: z.string(), connectedAccountId: z.string(), sourceProvider: z.string(), start: z.string().nullable(), end: z.string().nullable(), allDay: z.boolean(), status: z.enum(["confirmed", "tentative", "cancelled"]), blocksTime: z.boolean() })).safeParse(row.busyEvents);
    if (!result.success)
        throw new IntegrationError("INVALID_RESPONSE");
    return result.data;
}
export function createGoogleCalendarService(options: {
    integration?: ReturnType<typeof createIntegrationService>;
    encryption?: () => TokenEncryptionService;
    now?: () => Date;
} = {}) {
    const integration = options.integration ?? createIntegrationService();
    const encryption = options.encryption ?? getTokenEncryptionService;
    const now = options.now ?? (() => new Date());
    const using = <T>(userId: string, accountId: string, capability: "calendar-read" | "calendar-write", fn: (adapter: GoogleCalendarAdapter) => Promise<T>, signal?: AbortSignal) => integration.withProviderClient({ userId, connectedAccountId: accountId, provider: "google", capability }, client => fn(new GoogleCalendarAdapter(client, signal)));
    async function assertRead(userId: string, accountId: string) { await using(userId, accountId, "calendar-read", async () => { }); }
    const listCalendars = (userId: string, accountId: string) => protectIntegration(() => using(userId, accountId, "calendar-read", adapter => adapter.listCalendars()));
    const getSettings = (userId: string, accountId: string, discover = false): Promise<CalendarSettings> => protectIntegration(async () => {
        const account = await integration.getConnectedAccount(userId, accountId, "calendar-read");
        const [stored, state] = await Promise.all([db().calendarIntegrationPreference.findMany({ where: { userId, connectedAccountId: accountId } }), db().integrationSyncState.findUnique({ where: { connectedAccountId_integrationType: { connectedAccountId: accountId, integrationType: "calendar-read" } } })]);
        const calendars = discover ? await listCalendars(userId, accountId) : stored.map(c => ({ id: c.externalCalendarId, title: c.title, timezone: c.timezone, canWrite: c.allowStudyWrites }));
        return { health: account.health, calendars: calendars.map(c => { const p = stored.find(p => p.externalCalendarId === c.id); return { ...c, canWrite: c.canWrite && account.capabilities.includes("calendar-write"), enabledForAvailability: p?.enabledForAvailability ?? false, allowStudyWrites: p?.allowStudyWrites ?? false, blockAllDay: p?.blockAllDay ?? false }; }), sync: state ? { status: state.status, lastSuccessfulSyncAt: state.lastSuccessfulSyncAt?.toISOString() ?? null, lastErrorCode: state.lastErrorCode } : null };
    });
    const saveSelection = (userId: string, accountId: string, raw: z.input<typeof calendarSelectionSchema>) => protectIntegration(async () => {
        const input = calendarSelectionSchema.safeParse(raw);
        if (!input.success)
            throw new IntegrationError("INVALID_REQUEST");
        const calendars = await listCalendars(userId, accountId);
        const account = await integration.getConnectedAccount(userId, accountId, "calendar-read");
        for (const item of input.data.calendars) {
            const calendar = calendars.find(c => c.id === item.id);
            if (!calendar)
                throw new IntegrationError("NOT_FOUND");
            if (item.allowStudyWrites && (!calendar.canWrite || !account.capabilities.includes("calendar-write")))
                throw new IntegrationError("AUTHORIZATION_REQUIRED");
        }
        await db().$transaction(async (tx) => {
            await tx.$queryRaw `SELECT id FROM "ConnectedAccount" WHERE id=${accountId} AND "userId"=${userId} FOR UPDATE`;
            const current = await tx.connectedAccount.findFirst({ where: { id: accountId, userId, status: { in: ["ACTIVE", "ERROR"] } } });
            if (!current)
                throw new IntegrationError("DISCONNECTED");
            await integration.assertProviderAccess(userId, accountId, "calendar-read", "google", tx);
            if (input.data.calendars.some(c => c.allowStudyWrites)) await integration.assertProviderAccess(userId, accountId, "calendar-write", "google", tx);
            await tx.calendarIntegrationPreference.deleteMany({ where: { userId, connectedAccountId: accountId, externalCalendarId: { notIn: input.data.calendars.map(c => c.id) } } });
            for (const item of input.data.calendars) {
                const c = calendars.find(c => c.id === item.id)!;
                const data = { title: c.title, timezone: c.timezone, enabledForAvailability: item.enabledForAvailability, allowStudyWrites: item.allowStudyWrites, blockAllDay: item.blockAllDay, busyEvents: [], windowStart: null, windowEnd: null };
                await tx.calendarIntegrationPreference.upsert({ where: { connectedAccountId_externalCalendarId: { connectedAccountId: accountId, externalCalendarId: item.id } }, create: { userId, connectedAccountId: accountId, externalCalendarId: item.id, ...data }, update: { ...data, revision: { increment: 1 } } });
            }
            await tx.integrationSyncState.upsert({ where: { connectedAccountId_integrationType: { connectedAccountId: accountId, integrationType: "calendar-read" } }, create: { connectedAccountId: accountId, integrationType: "calendar-read" }, update: { cursorEncrypted: null, leaseToken: null, leaseUntil: null, status: "IDLE", lastSuccessfulSyncAt: null } });
        });
        return getSettings(userId, accountId);
    });
    const syncAccount = (userId: string, accountId: string, force = false, signal?: AbortSignal) => protectIntegration(async () => {
        const started = performance.now();
        await assertRead(userId, accountId);
        const timestamp = now();
        const window = calendarSyncWindow(timestamp);
        const lease = randomUUID();
        const claim = await db().$transaction(async (tx) => {
            await tx.$queryRaw `SELECT id FROM "ConnectedAccount" WHERE id=${accountId} AND "userId"=${userId} FOR UPDATE`;
            const account = await tx.connectedAccount.findFirst({ where: { id: accountId, userId, status: { in: ["ACTIVE", "ERROR"] } } });
            if (!account)
                throw new IntegrationError("DISCONNECTED");
            const selections = await tx.calendarIntegrationPreference.findMany({ where: { userId, connectedAccountId: accountId, OR: [{ enabledForAvailability: true }, { allowStudyWrites: true }] }, orderBy: { id: "asc" } });
            if (!selections.length)
                return null;
            const key = { connectedAccountId: accountId, integrationType: "calendar-read" };
            const previous = await tx.integrationSyncState.findUnique({ where: { connectedAccountId_integrationType: key } });
            if (previous?.leaseUntil && previous.leaseUntil > timestamp)
                throw new IntegrationError("CONNECTION_BUSY");
            if (!force && previous?.status === "COMPLETED" && previous.lastSuccessfulSyncAt && timestamp.getTime() - previous.lastSuccessfulSyncAt.getTime() < CALENDAR_CONFIG.freshMs && selections.every(p => p.windowEnd && p.windowEnd >= window.end && p.windowStart && p.windowStart <= window.start))
                return null;
            const id = previous?.id ?? randomUUID();
            let cursors: CalendarCursor = {};
            // Checkpoints are disposable; retain the last good cache until the fresh snapshot commits.
            if (previous?.cursorEncrypted) {
                try { cursors = cursorSchema.parse(JSON.parse(encryption().decrypt(previous.cursorEncrypted, credentialContext(userId, "google", id, "sync-cursor")))); }
                catch { cursors = {}; }
            }
            await tx.integrationSyncState.upsert({ where: { connectedAccountId_integrationType: key }, create: { id, ...key, status: "SYNCING", lastSyncStartedAt: timestamp, leaseToken: lease, leaseUntil: new Date(timestamp.getTime() + CALENDAR_CONFIG.leaseMs) }, update: { status: "SYNCING", lastSyncStartedAt: timestamp, leaseToken: lease, leaseUntil: new Date(timestamp.getTime() + CALENDAR_CONFIG.leaseMs), lastErrorCode: null } });
            return { id, cursors, selections };
        });
        if (!claim)
            return { synced: false };
        try {
            const cursors: CalendarCursor = {};
            const results: {
                selection: CalendarIntegrationPreference;
                events: ExternalCalendarEvent[];
                missingIds: string[];
            }[] = [];
            for (const selection of claim.selections) {
                if (signal?.aborted || now().getTime() - timestamp.getTime() > CALENDAR_CONFIG.leaseMs - 10000)
                    throw new IntegrationError("PROVIDER_UNAVAILABLE");
                const prior = claim.cursors[selection.id];
                const incremental = prior?.revision === selection.revision && prior.start === window.start.toISOString() && prior.end === window.end.toISOString();
                let full = !incremental;
                const read = (token?: string) => using(userId, accountId, "calendar-read", adapter => adapter.events({ connectedAccountId: accountId, calendarId: selection.externalCalendarId, timezone: selection.timezone, ...window, blockAllDay: selection.blockAllDay, syncToken: token }), signal);
                let batch;
                try {
                    batch = await read(incremental ? prior.token : undefined);
                }
                catch (error) {
                    if (!(error instanceof IntegrationError && error.code === "SYNC_TOKEN_EXPIRED"))
                        throw error;
                    full = true;
                    batch = await read();
                }
                const merged = new Map((full ? [] : cachedEvents(selection)).map(e => [e.externalId, e]));
                for (const event of batch.events) {
                    merged.delete(event.externalId);
                    if (event.blocksTime && event.start && event.end && event.start < window.end.toISOString() && event.end > window.start.toISOString())
                        merged.set(event.externalId, event);
                }
                if (merged.size > CALENDAR_CONFIG.maxEvents)
                    throw new IntegrationError("CALENDAR_LIMIT");
                const missingIds = batch.events.filter(e => e.status === "cancelled").map(e => e.externalId);
                // Bounded link checks distinguish deletion from a moved, transparent or out-of-window event.
                const returnedIds = new Set(batch.events.map(event => event.externalId));
                const links = full ? await db().externalEventLink.findMany({ where: { userId, connectedAccountId: accountId, externalCalendarId: selection.externalCalendarId, externalEventId: { notIn: [...returnedIds] }, status: { in: ["LINKED", "PENDING"] }, OR: [{ syncedStart: { lt: window.end }, syncedEnd: { gt: window.start } }, { status: "PENDING", createdAt: { gte: window.start } }] }, orderBy: { updatedAt: "asc" }, take: 25 }) : [];
                for (const link of links)
                    if (full) {
                        if (signal?.aborted || now().getTime() - timestamp.getTime() > CALENDAR_CONFIG.leaseMs - 10000) throw new IntegrationError("PROVIDER_UNAVAILABLE");
                        const event = await using(userId, accountId, "calendar-read", a => a.getEvent(selection.externalCalendarId, link.externalEventId), signal);
                        if (!event || event.status === "cancelled")
                            missingIds.push(link.externalEventId);
                        else await db().externalEventLink.updateMany({ where: { id: link.id, userId, updatedAt: link.updatedAt }, data: { updatedAt: now() } });
                    }
                results.push({ selection, events: [...merged.values()], missingIds });
                cursors[selection.id] = { token: batch.syncToken, start: window.start.toISOString(), end: window.end.toISOString(), revision: selection.revision };
            }
            await db().$transaction(async (tx) => {
                await tx.$queryRaw `SELECT id FROM "ConnectedAccount" WHERE id=${accountId} AND "userId"=${userId} FOR UPDATE`;
                const active = await tx.connectedAccount.findFirst({ where: { id: accountId, userId, status: { in: ["ACTIVE", "ERROR"] } } });
                const state = await tx.integrationSyncState.findFirst({ where: { id: claim.id, leaseToken: lease, leaseUntil: { gt: now() } } });
                if (!active || !state)
                    throw new IntegrationError("CONNECTION_BUSY");
                await integration.assertProviderAccess(userId, accountId, "calendar-read", "google", tx);
                for (const result of results) {
                    const updated = await tx.calendarIntegrationPreference.updateMany({ where: { id: result.selection.id, userId, revision: result.selection.revision }, data: { busyEvents: result.events as unknown as Prisma.InputJsonValue, windowStart: window.start, windowEnd: window.end } });
                    if (updated.count !== 1)
                        throw new IntegrationError("CONNECTION_BUSY");
                }
                await tx.integrationSyncState.update({ where: { id: claim.id }, data: { cursorEncrypted: encryption().encrypt(JSON.stringify(cursors), credentialContext(userId, "google", claim.id, "sync-cursor")), status: "COMPLETED", lastSuccessfulSyncAt: now(), lastSyncCompletedAt: now(), lastErrorCode: null, leaseToken: null, leaseUntil: null } });
            });
            for (const result of results)
                await db().externalEventLink.updateMany({ where: { userId, connectedAccountId: accountId, externalCalendarId: result.selection.externalCalendarId, externalEventId: { in: result.missingIds }, status: "LINKED", updatedAt: { lte: timestamp } }, data: { status: "MISSING" } });
            recordIntegrationMetric("syncSuccesses", performance.now() - started);
            return { synced: true };
        }
        catch (error) {
            recordIntegrationMetric("syncFailures", performance.now() - started);
            await db().integrationSyncState.updateMany({ where: { id: claim.id, leaseToken: lease }, data: { status: "FAILED", lastErrorCode: safeIntegrationError(error).code, lastSyncCompletedAt: now(), leaseToken: null, leaseUntil: null } });
            throw error;
        }
    });
    const getCalendarEvents = (input: {
        userId: string;
        connectedAccountId: string;
        calendarIds: string[];
        start: Date;
        end: Date;
    }) => protectIntegration(async () => {
        const { start, end, userId, connectedAccountId } = input;
        const window = calendarSyncWindow(now());
        if (!input.calendarIds.length || input.calendarIds.length > CALENDAR_CONFIG.maxCalendars || !Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || start >= end || start < window.start || end > window.end)
            throw new IntegrationError("INVALID_REQUEST");
        await assertRead(userId, connectedAccountId);
        await syncAccount(userId, connectedAccountId);
        const rows = await db().calendarIntegrationPreference.findMany({ where: { userId, connectedAccountId, externalCalendarId: { in: input.calendarIds }, enabledForAvailability: true } });
        if (rows.length !== new Set(input.calendarIds).size)
            throw new IntegrationError("NOT_FOUND");
        return rows.flatMap(cachedEvents).filter(e => e.start && e.end && Date.parse(e.start) < end.getTime() && Date.parse(e.end) > start.getTime());
    });
    return { integration, using, listCalendars, getSettings, saveSelection, syncAccount, getCalendarEvents };
}
export const googleCalendarService = createGoogleCalendarService();
