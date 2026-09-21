import { hasEntitlement } from "../entitlements/service";
import "server-only";
import type { AvailabilityContext, ExternalCalendarEvent } from "@/lib/student/calendar/types";
import { db } from "../db/client";
import { validTimezone } from "../time/local";
import { createGoogleCalendarService, googleCalendarService, cachedEvents } from "./service";
import { CALENDAR_CONFIG } from "./config";
import { studyWindows } from "./time";
/** Future providers supply the same private busy blocks. Planner never knows Google. */
export interface AvailabilitySource {
    provider: string;
    refresh(userId: string, accountId: string, force: boolean): Promise<unknown>;
}
export function createAvailabilityService(calendar: ReturnType<typeof createGoogleCalendarService> = googleCalendarService, additionalSources: AvailabilitySource[] = []) {
    const sources: AvailabilitySource[] = [{ provider: "google", refresh: (u, a, f) => calendar.syncAccount(u, a, f) }, ...additionalSources];
    return async function getUserAvailability(input: {
        userId: string;
        start: Date;
        end: Date;
        forceRefresh?: boolean;
        excludeTaskId?: string;
        excludePlanId?: string;
        now?: Date;
    }): Promise<AvailabilityContext> {
        if (input.excludePlanId && !await db().studyPlan.findFirst({ where: { id: input.excludePlanId, userId: input.userId }, select: { id: true } }))
            throw new Error("Study plan not found");
        const now = input.now ?? new Date();
        const [profile, quiet, selected] = await Promise.all([
            db().profile.findUnique({ where: { userId: input.userId }, select: { timezone: true } }), db().reminderPreference.findUnique({ where: { userId: input.userId } }),
            db().calendarIntegrationPreference.findMany({ where: { userId: input.userId, enabledForAvailability: true, connectedAccount: { userId: input.userId, status: { not: "REVOKED" } } }, include: { connectedAccount: { select: { provider: true, status: true } } } }),
        ]);
        const timezone = validTimezone(profile?.timezone);
        if (!await hasEntitlement(input.userId, "integration.calendar")) return { status: "unavailable", timezone, days: [], checkedAt: now.toISOString(), assumptions: ["Calendar access is unavailable with your current access. Stated study time and academic deadlines remain available; view plans to enable calendar scheduling."] };
        const assumptions = ["Study hours are 09:00–22:00 in your application timezone, excluding enabled quiet hours; daily study budgets still apply.", "Ordinary all-day events do not block study unless enabled for that calendar; out-of-office events do."];
        if (!selected.length)
            return { status: "not-connected", timezone, days: [], checkedAt: now.toISOString(), assumptions: [] };
        const accounts = [...new Map(selected.map(p => [p.connectedAccountId, p.connectedAccount])).entries()];
        let failures = 0;
        const events: (ExternalCalendarEvent & { connectedAccountId: string })[] = [];
        for (const [id, account] of accounts) {
            try {
                const source = sources.find(s => s.provider === account.provider);
                if (!source)
                    throw new Error();
                await source.refresh(input.userId, id, Boolean(input.forceRefresh));
                const [state, rows] = await Promise.all([db().integrationSyncState.findUnique({ where: { connectedAccountId_integrationType: { connectedAccountId: id, integrationType: "calendar-read" } } }), db().calendarIntegrationPreference.findMany({ where: { userId: input.userId, connectedAccountId: id, enabledForAvailability: true, connectedAccount: { status: { in: ["ACTIVE", "ERROR"] }, userId: input.userId } } })]);
                if (!state?.lastSuccessfulSyncAt || state.status !== "COMPLETED" || now.getTime() - state.lastSuccessfulSyncAt.getTime() > CALENDAR_CONFIG.freshMs || !rows.length || rows.some(r => !r.windowStart || !r.windowEnd || r.windowStart > input.start || r.windowEnd < input.end))
                    throw new Error();
                events.push(...rows.flatMap(cachedEvents).map(event => ({ ...event, connectedAccountId: id })));
            }
            catch {
                failures++;
            }
        }
        const localTasks = await db().studyTask.findMany({ where: { userId: input.userId, id: input.excludeTaskId ? { not: input.excludeTaskId } : undefined, status: { in: ["PLANNED", "IN_PROGRESS", "COMPLETED"] }, ...(input.excludePlanId ? { OR: [{ studyPlanId: { not: input.excludePlanId } }, { status: "COMPLETED" as const }] } : {}), scheduledStart: { lt: input.end }, scheduledEnd: { gt: input.start } }, select: { scheduledStart: true, scheduledEnd: true } });
        const excluded = input.excludeTaskId ? await db().externalEventLink.findMany({ where: { userId: input.userId, studyTaskId: input.excludeTaskId, status: { in: ["LINKED", "PENDING"] } }, select: { connectedAccountId: true, externalCalendarId: true, externalEventId: true } }) : [];
        const busy = events.filter(e => e.blocksTime && e.start && e.end && !excluded.some(l => l.connectedAccountId === e.connectedAccountId && l.externalCalendarId === e.calendarId && l.externalEventId === e.externalId)).map(e => ({ start: e.start!, end: e.end! }));
        busy.push(...localTasks.filter(t => t.scheduledStart && t.scheduledEnd).map(t => ({ start: t.scheduledStart!.toISOString(), end: t.scheduledEnd!.toISOString() })));
        if (failures)
            assumptions.push("Calendar availability may be unavailable for one or more accounts. Review your calendar before committing to these times.");
        return { status: failures === accounts.length ? "unavailable" : failures ? "partial" : "available", timezone, checkedAt: now.toISOString(), assumptions,
            days: failures === accounts.length ? [] : studyWindows({ start: input.start > now ? input.start : now, end: input.end, timezone, busy, quietStart: quiet?.quietHoursEnabled ? quiet.quietHoursStart : null, quietEnd: quiet?.quietHoursEnabled ? quiet.quietHoursEnd : null }) };
    };
}
export const getUserAvailability = createAvailabilityService();
