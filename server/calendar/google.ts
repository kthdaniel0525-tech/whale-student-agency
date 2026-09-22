import "server-only";
import { z } from "zod";
import type { ExternalCalendarEvent } from "@/lib/student/calendar/types";
import type { IntegrationClient } from "../integrations/types";
import { IntegrationError } from "../integrations/errors";
import { isValidTimezone } from "@/lib/student/timezone";
import { CALENDAR_CONFIG } from "./config";
import { zonedInstant } from "./time";
const opaque = z.string().min(1).max(1024);
const calendarSchema = z.object({ id: opaque, summary: z.string().max(1000).optional(), timeZone: z.string().refine(isValidTimezone), accessRole: z.string(), deleted: z.boolean().optional() });
const eventTime = z.object({ date: z.string().optional(), dateTime: z.string().optional(), timeZone: z.string().optional() });
const eventSchema = z.object({ id: opaque, status: z.enum(["confirmed", "tentative", "cancelled"]).default("confirmed"), start: eventTime.optional(), end: eventTime.optional(), transparency: z.enum(["opaque", "transparent"]).optional(), eventType: z.string().optional(), attendees: z.array(z.object({ self: z.boolean().optional(), responseStatus: z.string().optional() })).optional(), extendedProperties: z.object({ private: z.record(z.string()).optional() }).optional() });
const pageSchema = z.object({ items: z.array(z.unknown()).max(CALENDAR_CONFIG.pageSize).default([]), nextPageToken: opaque.optional(), nextSyncToken: z.string().min(1).max(4096).optional(), timeZone: z.string().optional() });
function parse<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, value: unknown): T { const result = schema.safeParse(value); if (!result.success)
    throw new IntegrationError("INVALID_RESPONSE"); return result.data; }
const segment = (value: string) => encodeURIComponent(opaque.parse(value));
export const calendarEventPath = (calendarId: string, eventId?: string) => `calendars/${segment(calendarId)}/events${eventId ? `/${segment(eventId)}` : ""}`;
export class GoogleCalendarAdapter {
    constructor(private client: IntegrationClient, signal?: AbortSignal) {
        this.client = { ...client, read(input) {
            if (signal?.aborted) throw new IntegrationError("PROVIDER_UNAVAILABLE");
            return client.read({ ...input, signal });
        }, write(input) {
            if (signal?.aborted) throw new IntegrationError("PROVIDER_UNAVAILABLE");
            return client.write({ ...input, signal });
        } };
    }
    async listCalendars() {
        const result: {
            id: string;
            title: string;
            timezone: string;
            canWrite: boolean;
        }[] = [];
        let pageToken: string | undefined;
        const seen = new Set<string>();
        for (let page = 0; page < CALENDAR_CONFIG.maxPages; page++) {
            const data = parse(pageSchema, await this.client.read({ path: "users/me/calendarList", query: { maxResults: "250", fields: "items(id,summary,timeZone,accessRole,deleted),nextPageToken", ...(pageToken ? { pageToken } : {}) } }));
            for (const raw of data.items) {
                const c = parse(calendarSchema, raw);
                if (!c.deleted && ["reader", "writer", "owner", "writerWithoutPrivateAccess"].includes(c.accessRole))
                    result.push({ id: c.id, title: (c.summary ?? "Calendar").slice(0, 200), timezone: c.timeZone, canWrite: ["writer", "owner", "writerWithoutPrivateAccess"].includes(c.accessRole) });
            }
            if (!data.nextPageToken)
                return result;
            if (seen.has(data.nextPageToken))
                throw new IntegrationError("INVALID_RESPONSE");
            seen.add(data.nextPageToken);
            pageToken = data.nextPageToken;
        }
        throw new IntegrationError("CALENDAR_LIMIT");
    }
    async events(input: {
        connectedAccountId: string;
        calendarId: string;
        timezone: string;
        start: Date;
        end: Date;
        syncToken?: string;
        blockAllDay: boolean;
    }) {
        const events: ExternalCalendarEvent[] = [];
        let pageToken: string | undefined;
        const seen = new Set<string>();
        for (let page = 0; page < CALENDAR_CONFIG.maxPages; page++) {
            const data = parse(pageSchema, await this.client.read({ path: calendarEventPath(input.calendarId), query: { singleEvents: "true", showDeleted: "true", maxResults: String(CALENDAR_CONFIG.pageSize), fields: "items(id,status,start,end,transparency,eventType,attendees(self,responseStatus)),nextPageToken,nextSyncToken,timeZone", ...(input.syncToken ? { syncToken: input.syncToken } : { timeMin: input.start.toISOString(), timeMax: input.end.toISOString() }), ...(pageToken ? { pageToken } : {}) } }));
            for (const raw of data.items) {
                const e = parse(eventSchema, raw);
                const allDay = Boolean(e.start?.date);
                let start: string | null = null, end: string | null = null;
                if (e.status !== "cancelled") {
                    const instant = (v: z.infer<typeof eventTime> | undefined, edge: "start" | "end") => {
                        if (!v)
                            throw new IntegrationError("INVALID_RESPONSE");
                        if (v.date)
                            return zonedInstant(`${v.date}T00:00:00`, v.timeZone ?? data.timeZone ?? input.timezone, edge).toISOString();
                        if (!v.dateTime)
                            throw new IntegrationError("INVALID_RESPONSE");
                        if (/(?:Z|[+-]\d{2}:\d{2})$/i.test(v.dateTime)) {
                            const d = new Date(v.dateTime);
                            if (!Number.isFinite(d.getTime()))
                                throw new IntegrationError("INVALID_RESPONSE");
                            return d.toISOString();
                        }
                        return zonedInstant(v.dateTime, v.timeZone ?? data.timeZone ?? input.timezone, edge).toISOString();
                    };
                    start = instant(e.start, "start");
                    end = instant(e.end, "end");
                    if (end <= start)
                        throw new IntegrationError("INVALID_RESPONSE");
                }
                events.push({ externalId: e.id, calendarId: input.calendarId, connectedAccountId: input.connectedAccountId, sourceProvider: "google", start, end, allDay, status: e.status,
                    blocksTime: e.status !== "cancelled" && e.transparency !== "transparent" && !e.attendees?.some(a => a.self && a.responseStatus === "declined") && e.eventType !== "workingLocation" && e.eventType !== "birthday" && (!allDay || input.blockAllDay || e.eventType === "outOfOffice") });
            }
            if (events.length > CALENDAR_CONFIG.maxEvents)
                throw new IntegrationError("CALENDAR_LIMIT");
            if (!data.nextPageToken) {
                if (!data.nextSyncToken)
                    throw new IntegrationError("INVALID_RESPONSE");
                return { events, syncToken: data.nextSyncToken };
            }
            if (seen.has(data.nextPageToken))
                throw new IntegrationError("INVALID_RESPONSE");
            seen.add(data.nextPageToken);
            pageToken = data.nextPageToken;
        }
        throw new IntegrationError("CALENDAR_LIMIT");
    }
    async getEvent(calendarId: string, eventId: string) {
        try {
            return parse(eventSchema, await this.client.read({ path: calendarEventPath(calendarId, eventId), query: { fields: "id,status,start,end,extendedProperties" } }));
        }
        catch (e) {
            if (e instanceof IntegrationError && ["RESOURCE_NOT_FOUND", "SYNC_TOKEN_EXPIRED"].includes(e.code))
                return null;
            throw e;
        }
    }
    async create(calendarId: string, eventId: string, body: Record<string, unknown>) { return parse(eventSchema, await this.client.write({ path: calendarEventPath(calendarId), method: "POST", query: { sendUpdates: "none" }, body: { ...body, id: eventId } })); }
    async update(calendarId: string, eventId: string, body: Record<string, unknown>) { return parse(eventSchema, await this.client.write({ path: calendarEventPath(calendarId, eventId), method: "PATCH", query: { sendUpdates: "none" }, body })); }
    async remove(calendarId: string, eventId: string) { try {
        await this.client.write({ path: calendarEventPath(calendarId, eventId), method: "DELETE", query: { sendUpdates: "none" } });
    }
    catch (e) {
        if (!(e instanceof IntegrationError && ["RESOURCE_NOT_FOUND", "SYNC_TOKEN_EXPIRED"].includes(e.code)))
            throw e;
    } }
}
