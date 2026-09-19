import "dotenv/config";
import { randomUUID, randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, it, expect, vi } from "vitest";
import { auth } from "@/server/auth/config";
import { db } from "@/server/db/client";
import { getTokenEncryptionService, credentialContext } from "@/server/integrations/encryption";
import { createIntegrationService } from "@/server/integrations/service";
import { GOOGLE_SCOPES, GoogleIntegrationProvider } from "@/server/integrations/google";
import { googleCalendarService as calendar, cachedEvents } from "@/server/calendar/service";
import { getUserAvailability } from "@/server/calendar/availability";
import { calendarWriteService as writes } from "@/server/calendar/writes";
import { calendarHttp, createCalendarHttpHandlers } from "@/server/calendar/http";
import { zonedInstant, studyWindows, subtractBusy, mergeBusy, interval } from "@/server/calendar/time";
import { constrainPlanningBrief, placeStudyTasks } from "@/server/calendar/planning";
import { buildUserContext } from "@/server/context/builder";
import { formatContextForAI } from "@/server/context/format";
import { createPlanningBrief, createStudyPlannerAgentService } from "@/server/agents/study-planner";
import { getStudyPlannerAgentDefinition } from "@/server/agents/study-planner/definition";
import { syncGoogleCalendarJob, scheduleGoogleCalendarSyncJob, enqueueGoogleCalendarSync } from "@/server/jobs/sync-google-calendar";
import { registerCalendarSyncSchedule } from "@/server/jobs/schedule";
import { getBackgroundJob } from "@/server/jobs/registry";
import * as ai from "@/server/ai";
import type { AIProvider } from "@/server/ai/types";
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
const NOW = new Date("2026-09-20T08:00:00Z"), DAY = "2026-09-21";
const at = (time: string) => `${DAY}T${time}:00.000Z`;
type Actor = {
    id: string;
    headers: Headers;
};
let owner: Actor, other: Actor;
const fixtureAccountIds: string[] = [];
let accountId: string;
let taskId: string;
type WireEvent = {
    id: string;
    status?: string;
    start?: {
        dateTime?: string;
        date?: string;
        timeZone?: string;
    };
    end?: {
        dateTime?: string;
        date?: string;
        timeZone?: string;
    };
    transparency?: string;
    eventType?: string;
    attendees?: {
        self: boolean;
        responseStatus: string;
    }[];
    summary?: string;
    description?: string;
    extendedProperties?: {
        private: Record<string, string>;
    };
};
const timed = (id: string, start: string, end: string): WireEvent => ({ id, start: { dateTime: at(start) }, end: { dateTime: at(end) }, summary: "Dentist secret title", description: "Private diagnosis" });
let events: Map<string, WireEvent[]>;
let failures = false, invalidToken = false, losePost = false, pageSize = 250;
let readHook: (() => Promise<void>) | undefined;
let http: ReturnType<typeof vi.fn<typeof fetch>>;
const integration = createIntegrationService();
async function actor() { const response = await auth().api.signUpEmail({ body: { name: "Calendar student", email: `calendar-${randomUUID()}@example.test`, password: "Calendar-test-passphrase-2026!" }, asResponse: true }); expect(response.status).toBe(200); const { user } = await response.json() as {
    user: {
        id: string;
    };
}; await db().profile.create({ data: { userId: user.id, school: "Test", program: "CS", currentYear: 1, semester: "Fall", academicGoal: "Learn", studySessionMinutes: 45, explanationDifficulty: "INTERMEDIATE", timezone: "UTC" } }); return { id: user.id, headers: new Headers({ cookie: response.headers.getSetCookie().map(x => x.split(";")[0]).join("; "), origin: "http://localhost:3000", "content-type": "application/json" }) }; }
async function account(user = owner, scopes = [...GOOGLE_SCOPES["account-profile"], ...GOOGLE_SCOPES["calendar-read"], ...GOOGLE_SCOPES["calendar-write"]]) { const id = randomUUID(); fixtureAccountIds.push(id); return db().connectedAccount.create({ data: { id, userId: user.id, provider: "google", providerAccountId: randomUUID(), scopes, accessTokenEncrypted: getTokenEncryptionService().encrypt("calendar-test-access", credentialContext(user.id, "google", id, "access")), accessTokenExpiresAt: new Date("2026-09-25T00:00:00Z") } }); }
async function select(id = accountId, ids = ["primary"], user = owner) { return calendar.saveSelection(user.id, id, { calendars: ids.map(id => ({ id, enabledForAvailability: true, allowStudyWrites: true, blockAllDay: false })) }); }
async function task() { const plan = await db().studyPlan.create({ data: { userId: owner.id, title: "Math week", summary: "Prepare", startDate: new Date(`${DAY}T00:00Z`), endDate: new Date(`${DAY}T00:00Z`), tasks: { create: { title: "Practice induction", date: new Date(`${DAY}T00:00Z`), activityType: "PRACTICE", durationMinutes: 45, priority: 90, reason: "Review weak topic", scheduledStart: new Date(at("18:00")), scheduledEnd: new Date(at("18:45")), scheduledTimezone: "UTC" } } }, include: { tasks: true } }); return plan.tasks[0].id; }
const req = (method: string, body?: unknown, user = owner) => new Request("http://localhost:3000/api/student/calendar/tasks/test", { method, headers: user.headers, ...(body ? { body: JSON.stringify(body) } : {}) });
const target = () => ({ userId: owner.id, connectedAccountId: accountId, calendarId: "primary", studyTaskId: taskId });
beforeAll(async () => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOW); owner = await actor(); other = await actor(); vi.useRealTimers(); });
beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    vi.stubEnv("INTEGRATION_TOKEN_KEYS", JSON.stringify({ v1: randomBytes(32).toString("base64") }));
    await db().studyPlan.deleteMany({ where: { userId: owner.id } });
    await db().connectedAccount.deleteMany({ where: { userId: { in: [owner.id, other.id] } } });
    await db().reminderPreference.deleteMany({ where: { userId: owner.id } });
    await db().profile.update({ where: { userId: owner.id }, data: { timezone: "UTC" } });
    accountId = (await account()).id;
    taskId = await task();
    events = new Map([["primary", []], ["university", []], ["birthdays", []]]);
    failures = false;
    invalidToken = false;
    losePost = false;
    pageSize = 250;
    readHook = undefined;
    http = vi.fn<typeof fetch>(async (resource, init) => {
        const url = new URL(String(resource)), method = init?.method ?? "GET";
        if (url.pathname === "/revoke")
            return Response.json({});
        if (!url.href.startsWith("https://www.googleapis.com/calendar/v3/"))
            throw new Error("Unexpected non-calendar HTTP");
        if (failures)
            return Response.json({ error: "provider failure with private details" }, { status: 503 });
        await readHook?.();
        if (url.pathname.endsWith("/calendarList"))
            return Response.json({ items: [{ id: "primary", summary: "Personal", timeZone: "UTC", accessRole: "owner" }, { id: "university", summary: "University", timeZone: "America/Winnipeg", accessRole: "reader" }, { id: "birthdays", summary: "Birthdays", timeZone: "UTC", accessRole: "reader" }] });
        const match = url.pathname.match(/calendars\/([^/]+)\/events(?:\/([^/]+))?$/);
        if (!match)
            throw new Error("Unexpected calendar path");
        const cid = decodeURIComponent(match[1]), id = match[2];
        const rows = events.get(cid) ?? [];
        if (method === "GET" && !id) {
            if (invalidToken && url.searchParams.has("syncToken")) {
                invalidToken = false;
                return Response.json({ error: "gone" }, { status: 410 });
            }
            const offset = Number(url.searchParams.get("pageToken") ?? 0);
            const items = rows.slice(offset, offset + pageSize);
            return Response.json({ items, ...(offset + pageSize < rows.length ? { nextPageToken: String(offset + pageSize) } : { nextSyncToken: "sync-private-cursor" }), timeZone: "UTC" });
        }
        if (method === "GET")
            return rows.find(e => e.id === id) ? Response.json(rows.find(e => e.id === id)) : Response.json({ error: "missing" }, { status: 404 });
        if (method === "POST") {
            const body = JSON.parse(String(init?.body));
            if (rows.some(e => e.id === body.id))
                return Response.json({ error: "duplicate" }, { status: 409 });
            rows.push(body);
            events.set(cid, rows);
            if (losePost) {
                losePost = false;
                return Response.json({ error: "lost response" }, { status: 503 });
            }
            return Response.json(body);
        }
        if (method === "PATCH") {
            const index = rows.findIndex(e => e.id === id);
            if (index < 0)
                return Response.json({ error: "missing" }, { status: 404 });
            rows[index] = { ...rows[index], ...JSON.parse(String(init?.body)) };
            return Response.json(rows[index]);
        }
        if (method === "DELETE") {
            events.set(cid, rows.filter(e => e.id !== id));
            return new Response(null, { status: 204 });
        }
        throw new Error("Unexpected method");
    });
    vi.stubGlobal("fetch", http);
    vi.spyOn(console, "info").mockImplementation(() => { });
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
afterAll(async () => { await db().jobRun.deleteMany({ where: { jobName: { in: ["sync-google-calendar", "schedule-google-calendar-sync"] }, resourceId: { in: fixtureAccountIds } } }); await db().user.deleteMany({ where: { id: { in: [owner.id, other.id] } } }); await db().$disconnect(); });
describe.sequential("Google Calendar integration", () => {
    it("requests read scopes without write, with calendar-list permission", () => { const p = new GoogleIntegrationProvider(); expect(p.scopesFor(["calendar-read"])).toContain(GOOGLE_SCOPES["calendar-read"][1]); expect(p.scopesFor(["calendar-read"])).not.toContain(GOOGLE_SCOPES["calendar-write"][0]); expect(p.capabilitiesFor([GOOGLE_SCOPES["calendar-read"][0]])).not.toContain("calendar-read"); });
    it("checks read permission before any API call", async () => { await db().connectedAccount.update({ where: { id: accountId }, data: { scopes: [...GOOGLE_SCOPES["account-profile"]] } }); await expect(calendar.listCalendars(owner.id, accountId)).rejects.toMatchObject({ code: "AUTHORIZATION_REQUIRED" }); expect(http).not.toHaveBeenCalled(); });
    it("lists calendars and persists only explicit selections", async () => { expect(await calendar.listCalendars(owner.id, accountId)).toHaveLength(3); await select(); expect((await calendar.getSettings(owner.id, accountId, true)).calendars.map(c => [c.id, c.enabledForAvailability])).toEqual([["primary", true], ["university", false], ["birthdays", false]]); });
    it("validates selection ownership, ACL and unknown calendar IDs", async () => { await expect(select(accountId, ["primary"], other)).rejects.toMatchObject({ code: "NOT_FOUND" }); await expect(select(accountId, ["university"])).rejects.toMatchObject({ code: "AUTHORIZATION_REQUIRED" }); await expect(select(accountId, ["unknown"])).rejects.toMatchObject({ code: "NOT_FOUND" }); expect(await db().calendarIntegrationPreference.count({ where: { userId: owner.id } })).toBe(0); });
    it("supports multiple selected readable calendars without write scope", async () => { await db().connectedAccount.update({ where: { id: accountId }, data: { scopes: [...GOOGLE_SCOPES["calendar-read"]] } }); await calendar.saveSelection(owner.id, accountId, { calendars: ["primary", "university"].map(id => ({ id, enabledForAvailability: true, allowStudyWrites: false })) }); expect((await calendar.getSettings(owner.id, accountId)).calendars).toHaveLength(2); });
    it("reads paginated events, expands recurrence server-side and drops private details", async () => { await select(); pageSize = 1; events.set("primary", [timed("a", "10:00", "11:00"), timed("b", "13:00", "14:00")]); await calendar.syncAccount(owner.id, accountId); const row = await db().calendarIntegrationPreference.findFirstOrThrow({ where: { connectedAccountId: accountId } }); expect(cachedEvents(row)).toHaveLength(2); expect(JSON.stringify(row.busyEvents)).not.toMatch(/Dentist|diagnosis|summary|description|attendees/); expect(http.mock.calls.some(([u]) => String(u).includes("pageToken=1"))).toBe(true); });
    it("ignores cancelled, transparent, declined, working-location and ordinary all-day events", async () => { await select(); events.set("primary", [{ id: "cancelled", status: "cancelled" }, { ...timed("free", "10:00", "11:00"), transparency: "transparent" }, { ...timed("declined", "10:00", "11:00"), attendees: [{ self: true, responseStatus: "declined" }] }, { ...timed("location", "10:00", "11:00"), eventType: "workingLocation" }, { id: "all", start: { date: DAY }, end: { date: "2026-09-22" } }, timed("busy", "13:00", "14:00")]); await calendar.syncAccount(owner.id, accountId); expect(cachedEvents(await db().calendarIntegrationPreference.findFirstOrThrow({ where: { connectedAccountId: accountId } })).map(e => e.externalId)).toEqual(["busy"]); });
    it("blocks all-day out-of-office or a calendar explicitly configured to block all-day events", async () => { await select(); events.set("primary", [{ id: "ooo", eventType: "outOfOffice", start: { date: DAY }, end: { date: "2026-09-22" } }]); await calendar.syncAccount(owner.id, accountId); expect(cachedEvents(await db().calendarIntegrationPreference.findFirstOrThrow({ where: { connectedAccountId: accountId } }))[0].blocksTime).toBe(true); });
    it("performs initial then incremental sync without mixing date filters with syncToken", async () => { await select(); events.set("primary", [timed("a", "10:00", "11:00")]); await calendar.syncAccount(owner.id, accountId); events.set("primary", [{ id: "a", status: "cancelled" }, timed("b", "12:00", "13:00")]); await calendar.syncAccount(owner.id, accountId, true); const calls = http.mock.calls.map(([u]) => new URL(String(u))).filter(u => u.searchParams.has("syncToken")); expect(calls).toHaveLength(1); expect(calls[0].searchParams.has("timeMin")).toBe(false); expect(calls[0].searchParams.has("timeMax")).toBe(false); expect(cachedEvents(await db().calendarIntegrationPreference.findFirstOrThrow({ where: { connectedAccountId: accountId } })).map(e => e.externalId)).toEqual(["b"]); const state = await db().integrationSyncState.findFirstOrThrow({ where: { connectedAccountId: accountId } }); expect(state.cursorEncrypted).not.toContain("sync-private-cursor"); });
    it("recovers invalidated sync tokens with a bounded replacement read", async () => { await select(); events.set("primary", [timed("old", "10:00", "11:00")]); await calendar.syncAccount(owner.id, accountId); events.set("primary", [timed("new", "12:00", "13:00")]); invalidToken = true; await calendar.syncAccount(owner.id, accountId, true); expect(cachedEvents(await db().calendarIntegrationPreference.findFirstOrThrow({ where: { connectedAccountId: accountId } })).map(e => e.externalId)).toEqual(["new"]); expect(new URL(String(http.mock.calls.at(-1)![0])).searchParams.has("timeMax")).toBe(true); });
    it("uses fresh cached data without unnecessary network calls", async () => { await select(); await calendar.syncAccount(owner.id, accountId); http.mockClear(); expect(await calendar.syncAccount(owner.id, accountId)).toEqual({ synced: false }); expect(http).not.toHaveBeenCalled(); });
    it("refreshes stale availability before planning", async () => { await select(); await calendar.syncAccount(owner.id, accountId); vi.setSystemTime(new Date(NOW.getTime() + 6 * 60000)); http.mockClear(); await getUserAvailability({ userId: owner.id, start: new Date(at("09:00")), end: new Date(at("22:00")) }); expect(http).toHaveBeenCalled(); });
    it("fails atomically and falls back without using stale free time", async () => { await select(); await calendar.syncAccount(owner.id, accountId); const before = await db().calendarIntegrationPreference.findFirstOrThrow({ where: { connectedAccountId: accountId } }); vi.setSystemTime(new Date(NOW.getTime() + 6 * 60000)); failures = true; const result = await getUserAvailability({ userId: owner.id, start: new Date(at("09:00")), end: new Date(at("22:00")) }); expect(result.status).toBe("unavailable"); expect(result.days).toEqual([]); const after = await db().calendarIntegrationPreference.findUniqueOrThrow({ where: { id: before.id } }); expect(after.busyEvents).toEqual(before.busyEvents); expect((await db().connectedAccount.findUniqueOrThrow({ where: { id: accountId } })).status).toBe("ACTIVE"); });
    it("serializes concurrent account syncs with a fenced lease", async () => { await select(); let release!: () => void; const gate = new Promise<void>(r => release = r); let started!: () => void; const hit = new Promise<void>(r => started = r); readHook = async () => { started(); await gate; }; const first = calendar.syncAccount(owner.id, accountId, true); await hit; await expect(calendar.syncAccount(owner.id, accountId, true)).rejects.toMatchObject({ code: "CONNECTION_BUSY" }); release(); await first; });
    it("rejects unbounded event requests and foreign ownership", async () => { await select(); await expect(calendar.getCalendarEvents({ userId: other.id, connectedAccountId: accountId, calendarIds: ["primary"], start: new Date(at("09:00")), end: new Date(at("22:00")) })).rejects.toMatchObject({ code: "NOT_FOUND" }); await expect(calendar.getCalendarEvents({ userId: owner.id, connectedAccountId: accountId, calendarIds: ["primary"], start: new Date("2020-01-01"), end: new Date("2030-01-01") })).rejects.toMatchObject({ code: "INVALID_REQUEST" }); });
    it("merges multiple accounts and excludes unselected calendars", async () => { await select(); const second = await account(); await select(second.id); events.set("primary", [timed("busy", "10:00", "11:00")]); events.set("birthdays", [timed("ignored", "11:00", "21:00")]); const result = await getUserAvailability({ userId: owner.id, start: new Date(at("09:00")), end: new Date(at("12:00")) }); expect(result.days[0].freeWindows.map(w => w.durationMinutes)).toEqual([60, 60]); });
    it("applies quiet hours and drops small study windows", async () => { await select(); await db().reminderPreference.create({ data: { userId: owner.id, quietHoursEnabled: true, quietHoursStart: 20 * 60, quietHoursEnd: 10 * 60 } }); events.set("primary", [timed("a", "10:07", "11:00")]); const result = await getUserAvailability({ userId: owner.id, start: new Date(at("09:00")), end: new Date(at("22:00")) }); expect(result.days[0].freeWindows.every(w => w.durationMinutes >= 15)).toBe(true); expect(result.days[0].freeWindows[0].start).toBe(at("11:00")); expect(result.days[0].freeWindows.at(-1)?.end).toBe(at("20:00")); });
    it("Context Builder returns bounded private availability and checks user ownership", async () => { await select(); events.set("primary", [timed("a", "10:00", "11:00")]); const ctx = await buildUserContext({ request: "Plan my week", options: { availability: true, availabilityWindow: { startDate: DAY, endDate: DAY } } }, owner.headers); expect(ctx.availability?.status).toBe("available"); expect(ctx.availability?.days).toHaveLength(1); expect(formatContextForAI(ctx)).not.toMatch(/Dentist|diagnosis|primary|calendar-test-access/); const foreign = await buildUserContext({ request: "Plan my week", options: { availability: true } }, other.headers); expect(foreign.availability?.status).toBe("not-connected"); expect(getStudyPlannerAgentDefinition().contextRequirements.availability).toBe(true); });
    it("calendar computation and sync use zero AI calls", async () => { const spy = vi.spyOn(ai, "getAIProvider").mockImplementation(() => { throw new Error("AI must not run"); }); await select(); await getUserAvailability({ userId: owner.id, start: new Date(at("09:00")), end: new Date(at("22:00")) }); expect(spy).not.toHaveBeenCalled(); });
    it("requires write permission before creation", async () => { await select(); await db().connectedAccount.update({ where: { id: accountId }, data: { scopes: [...GOOGLE_SCOPES["calendar-read"]] } }); http.mockClear(); await expect(writes.createStudyCalendarEvent(target())).rejects.toMatchObject({ code: "AUTHORIZATION_REQUIRED" }); expect(http).not.toHaveBeenCalled(); });
    it("creates an owned task event with a durable link and no duplicate on retry", async () => { await select(); const first = await writes.createStudyCalendarEvent(target()); const again = await writes.createStudyCalendarEvent(target()); expect(first.id).toBe(again.id); expect(first.status).toBe("LINKED"); expect(http.mock.calls.filter(([, i]) => i?.method === "POST")).toHaveLength(1); expect(events.get("primary")![0]).toMatchObject({ summary: "Practice induction", start: { dateTime: at("18:00") }, end: { dateTime: at("18:45") } }); expect(await db().externalEventLink.count({ where: { userId: owner.id } })).toBe(1); });
    it("concurrent Add actions cannot create duplicate events", async () => { await select(); const outcomes = await Promise.allSettled([writes.createStudyCalendarEvent(target()), writes.createStudyCalendarEvent(target())]); expect(outcomes.some(o => o.status === "fulfilled")).toBe(true); await writes.createStudyCalendarEvent(target()); expect(http.mock.calls.filter(([, i]) => i?.method === "POST")).toHaveLength(1); });
    it("recovers a lost POST response using the reserved event ID", async () => { await select(); losePost = true; await expect(writes.createStudyCalendarEvent(target())).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" }); expect(events.get("primary")).toHaveLength(1); const result = await writes.createStudyCalendarEvent(target()); expect(result.status).toBe("LINKED"); expect(events.get("primary")).toHaveLength(1); });
    it("reschedules locally without external writes and updates only on explicit action", async () => { await select(); await writes.createStudyCalendarEvent(target()); http.mockClear(); await writes.scheduleTask(owner.id, taskId, `${DAY}T19:00`); expect(http.mock.calls.filter(([, i]) => ["POST", "PATCH", "DELETE"].includes(i?.method ?? ""))).toHaveLength(0); expect((await writes.getTaskOptions(owner.id, taskId)).links[0].needsUpdate).toBe(true); await writes.updateStudyCalendarEvent(target()); expect(events.get("primary")![0].start?.dateTime).toBe(at("19:00")); });
    it("rejects busy-time booking deterministically before external mutation", async () => { await select(); events.set("primary", [timed("busy", "18:00", "19:00")]); await expect(writes.createStudyCalendarEvent(target())).rejects.toMatchObject({ code: "CALENDAR_CONFLICT" }); expect(http.mock.calls.some(([, i]) => i?.method === "POST")).toBe(false); });
    it("removes an external event without deleting the study task", async () => { await select(); await writes.createStudyCalendarEvent(target()); await writes.removeStudyCalendarEvent(target()); expect(events.get("primary")).toHaveLength(0); expect(await db().studyTask.findUnique({ where: { id: taskId } })).not.toBeNull(); await writes.removeStudyCalendarEvent(target()); expect(http.mock.calls.filter(([, i]) => i?.method === "DELETE")).toHaveLength(1); });
    it("recognizes external deletion and does not recreate on sync or update", async () => { await select(); const first = await writes.createStudyCalendarEvent(target()); const row = await db().externalEventLink.findUniqueOrThrow({ where: { id: first.id } }); events.set("primary", [{ id: row.externalEventId, status: "cancelled" }]); await calendar.syncAccount(owner.id, accountId, true); expect((await db().externalEventLink.findUniqueOrThrow({ where: { id: first.id } })).status).toBe("MISSING"); http.mockClear(); await writes.updateStudyCalendarEvent(target()); expect(http.mock.calls.some(([, i]) => i?.method === "POST")).toBe(false); });
    it("explicit re-add after removal creates a new linked event", async () => { await select(); await writes.createStudyCalendarEvent(target()); await writes.removeStudyCalendarEvent(target()); expect((await writes.createStudyCalendarEvent(target())).status).toBe("LINKED"); expect(events.get("primary")).toHaveLength(1); });
    it("protects account, task and link ownership", async () => { await select(); await expect(writes.createStudyCalendarEvent({ ...target(), userId: other.id })).rejects.toMatchObject({ code: "NOT_FOUND" }); const foreignAccount = await account(other); await expect(writes.createStudyCalendarEvent({ ...target(), connectedAccountId: foreignAccount.id })).rejects.toMatchObject({ code: "NOT_FOUND" }); await expect(writes.getTaskOptions(other.id, taskId)).rejects.toMatchObject({ code: "NOT_FOUND" }); expect(http.mock.calls.some(([, i]) => i?.method === "POST")).toBe(false); });
    it("disconnect disables selections and jobs without deleting Google events", async () => { await select(); await writes.createStudyCalendarEvent(target()); await integration.disconnectConnectedAccount(owner.id, accountId); http.mockClear(); expect(await syncGoogleCalendarJob.handler({ payload: { version: 1, connectedAccountId: accountId }, signal: new AbortController().signal, attempt: 1, jobRunId: "test" })).toEqual({ skipped: true }); await expect(writes.removeStudyCalendarEvent(target())).rejects.toMatchObject({ code: "DISCONNECTED" }); expect(http).not.toHaveBeenCalled(); expect(events.get("primary")).toHaveLength(1); expect(await db().calendarIntegrationPreference.count({ where: { connectedAccountId: accountId } })).toBe(0); });
    it("background sync derives ownership from the account and registers periodic scheduling", async () => { await select(); expect(getBackgroundJob("sync-google-calendar")).toBe(syncGoogleCalendarJob); expect(getBackgroundJob("schedule-google-calendar-sync")).toBe(scheduleGoogleCalendarSyncJob); expect(await syncGoogleCalendarJob.handler({ payload: { version: 1, connectedAccountId: accountId }, signal: new AbortController().signal, attempt: 1, jobRunId: "test" })).toEqual({ synced: true }); const schedule = vi.fn().mockResolvedValue(undefined); expect(await registerCalendarSyncSchedule({ schedule }, { enabled: true })).toBe(true); expect(schedule.mock.calls[0][1]).toBe("*/15 * * * *"); });
    it("on-demand refresh uses the same ownership-checked job", async () => { await select(); const enqueue = vi.fn().mockResolvedValue({ id: "queued" }); const routes = createCalendarHttpHandlers(calendar, writes, enqueue); expect((await routes.refresh(req("POST"), accountId)).status).toBe(200); expect(enqueue).toHaveBeenCalledWith(accountId); expect((await routes.refresh(req("POST", undefined, other), accountId)).status).toBe(404); expect(enqueue).toHaveBeenCalledTimes(1); });
    it("enqueues per-account idempotent jobs without frontend user identity", async () => { await select(); const sendDebounced = vi.fn().mockImplementation(async (_name, _data, options) => options.id); const a = await enqueueGoogleCalendarSync(accountId, { sendDebounced }); const b = await enqueueGoogleCalendarSync(accountId, { sendDebounced }); expect(a.id).toBe(b.id); expect(sendDebounced).toHaveBeenCalledTimes(1); expect(sendDebounced.mock.calls[0][1]).not.toHaveProperty("userId"); expect(sendDebounced.mock.calls[0][2].group.id).toBe(accountId); });
    it("actual Planner execution uses private availability and persists conflict-free task times", async () => {
        await select();
        events.set("primary", [timed("class", "09:00", "11:00")]);
        let messages = "";
        const provider: AIProvider = {
            async generateStructuredOutput(input) { messages = JSON.stringify(input.messages); const text = input.messages[0].content; const brief = JSON.parse(text.slice(text.indexOf("Execution parameters: ") + 22)); const signal = brief.signals[0]; const data = input.schema.parse({ title: "Study day", startDate: DAY, endDate: DAY, summary: "Prepare using available time", totalPlannedMinutes: 45, days: [{ date: DAY, totalMinutes: 45, sessions: [{ signalId: signal.id, title: "Review course", topic: null, activityType: signal.suggestedActivity, durationMinutes: 45 }] }] }); return { id: "test", model: "test", text: JSON.stringify(data), data }; },
            generateText() { throw new Error("Unexpected text"); }, streamText() { throw new Error("Unexpected stream"); }, generateEmbedding() { throw new Error("Unexpected embedding"); },
        };
        const planner = createStudyPlannerAgentService({ executor: { getProvider: () => provider }, router: { getProvider: () => provider } });
        const plan = await planner.createPlan({ request: "Make me a study plan", startDate: DAY, endDate: DAY }, owner.headers);
        expect(plan.days[0].sessions[0].scheduledStart).toBe(at("11:00"));
        expect(plan.days[0].sessions[0].scheduledEnd).toBe(at("11:45"));
        expect(messages).toContain("STUDY AVAILABILITY");
        expect(messages).not.toMatch(/Dentist|diagnosis/);
        expect(plan.assumptions.join(" ")).toContain("Calendar availability considered");
        expect(http.mock.calls.some(([, i]) => i?.method === "POST")).toBe(false);
        await planner.updateTaskStatus(plan.days[0].sessions[0].id, "completed", owner.headers);
        const updated = await planner.updatePlan({ request: "Update my study plan", planId: plan.id, startDate: DAY, endDate: DAY, availability: [{ date: DAY, availableMinutes: 120 }] }, owner.headers);
        expect(updated.days[0].sessions.some(t => t.status === "completed" && t.scheduledStart === at("11:00"))).toBe(true);
        expect(updated.days[0].sessions.some(t => t.status === "planned" && t.scheduledStart === at("11:45"))).toBe(true);
    });
    it("restarts the bounded sync window when the day rolls forward", async () => { await select(); await calendar.syncAccount(owner.id, accountId); vi.setSystemTime(new Date("2026-09-21T08:00Z")); http.mockClear(); await calendar.syncAccount(owner.id, accountId); const query = new URL(String(http.mock.calls[0][0])).searchParams; expect(query.has("syncToken")).toBe(false); expect(query.get("timeMin")).toBe("2026-09-18T00:00:00.000Z"); });
    it("selection changes fence an in-flight snapshot so disabled calendars cannot return", async () => {
        await select();
        let release!: () => void;
        const gate = new Promise<void>(r => release = r);
        let entered!: () => void;
        const hit = new Promise<void>(r => entered = r);
        readHook = async () => { readHook = undefined; entered(); await gate; };
        const sync = calendar.syncAccount(owner.id, accountId, true);
        await hit;
        await calendar.saveSelection(owner.id, accountId, { calendars: [] });
        release();
        await expect(sync).rejects.toMatchObject({ code: "CONNECTION_BUSY" });
        expect(await db().calendarIntegrationPreference.count({ where: { connectedAccountId: accountId } })).toBe(0);
    });
    it("rejects invalid provider times instead of treating a malformed event as free", async () => { await select(); events.set("primary", [{ id: "bad", start: { dateTime: "invalid" }, end: { dateTime: at("11:00") } }]); await expect(calendar.syncAccount(owner.id, accountId)).rejects.toBeTruthy(); expect((await db().integrationSyncState.findFirstOrThrow({ where: { connectedAccountId: accountId } })).status).toBe("FAILED"); });
    it("normalizes timed offsets and obeys the selected all-day policy", async () => { await calendar.saveSelection(owner.id, accountId, { calendars: [{ id: "primary", enabledForAvailability: true, allowStudyWrites: true, blockAllDay: true }] }); events.set("primary", [{ id: "offset", start: { dateTime: `${DAY}T10:00:00-05:00` }, end: { dateTime: `${DAY}T11:00:00-05:00` } }, { id: "all", start: { date: DAY }, end: { date: "2026-09-22" } }]); await calendar.syncAccount(owner.id, accountId); const stored = cachedEvents(await db().calendarIntegrationPreference.findFirstOrThrow({ where: { connectedAccountId: accountId } })); expect(stored.find(e => e.externalId === "offset")?.start).toBe(at("15:00")); expect(stored.find(e => e.externalId === "all")?.blocksTime).toBe(true); });
    it("shares the exam horizon with Context Builder beyond the default week", async () => {
        await select();
        const course = await db().course.create({ data: { userId: owner.id, courseCode: "MATH", courseName: "Math", semester: "Fall" } });
        await db().exam.create({ data: { userId: owner.id, courseId: course.id, title: "Final", examDate: new Date("2026-11-05T12:00:00Z"), topics: [] } });
        const context = await buildUserContext({ request: "Plan my final exam preparation", courseId: course.id, options: { profile: true, exams: true, availability: true, deadlineWindowDays: 60, limits: { maxCharacters: 40000 } } }, owner.headers);
        expect(context.availability?.status).toBe("available");
        expect(context.availability?.days.at(-1)?.date).toBe("2026-11-04");
        expect(createPlanningBrief(context, { mode: "create", request: "Plan my final exam preparation" }).availability.at(-1)?.availableMinutes).toBeGreaterThan(0);
        await db().course.delete({ where: { id: course.id } });
    });
    it("HTTP rejects forged users, missing confirmation, and cross-origin writes", async () => { await select(); const input = { ...target(), action: "create", confirmed: true }; expect((await calendarHttp.mutate(req("POST", input), taskId)).status).toBe(400); expect((await calendarHttp.mutate(req("POST", { connectedAccountId: accountId, calendarId: "primary", action: "create" }), taskId)).status).toBe(400); const wrong = req("POST", input); wrong.headers.set("origin", "https://evil.example"); expect((await calendarHttp.mutate(wrong, taskId)).status).toBe(403); });
});
describe("deterministic availability arithmetic", () => {
    it("merges overlaps and returns the expected free windows", () => { const busy = [{ start: at("10:00"), end: at("11:15") }, { start: at("10:30"), end: at("11:00") }, { start: at("13:00"), end: at("14:15") }, { start: at("16:00"), end: at("17:00") }]; expect(mergeBusy(busy)).toHaveLength(3); expect(subtractBusy([interval(Date.parse(at("09:00")), Date.parse(at("22:00")))], busy).map(w => [w.start, w.end])).toEqual([[at("09:00"), at("10:00")], [at("11:15"), at("13:00")], [at("14:15"), at("16:00")], [at("17:00"), at("22:00")]]); });
    it("converts IANA zones and respects both DST boundaries", () => { expect(zonedInstant("2026-09-21T09:00", "America/Winnipeg").toISOString()).toBe("2026-09-21T14:00:00.000Z"); expect(() => zonedInstant("2026-03-08T02:30", "America/Winnipeg")).toThrow(); expect(zonedInstant("2026-11-01T01:30", "America/Winnipeg").toISOString()).toBe("2026-11-01T06:30:00.000Z"); expect(zonedInstant("2026-11-01T01:30", "America/Winnipeg", "end").toISOString()).toBe("2026-11-01T07:30:00.000Z"); });
    it("computes elapsed free minutes across DST without naive 24-hour days", () => { const spring = studyWindows({ start: new Date("2026-03-08T06:00Z"), end: new Date("2026-03-09T05:00Z"), timezone: "America/Winnipeg", busy: [], startMinute: 0, endMinute: 240 }); expect(spring[0].availableMinutes).toBe(180); const fall = studyWindows({ start: new Date("2026-11-01T05:00Z"), end: new Date("2026-11-02T06:00Z"), timezone: "America/Winnipeg", busy: [], startMinute: 0, endMinute: 240 }); expect(fall[0].availableMinutes).toBe(300); });
    it("discards sub-minimum windows", () => { expect(subtractBusy([interval(Date.parse(at("09:00")), Date.parse(at("09:07")))], [])).toEqual([]); });
    it("repairs sessions by splitting across free windows without changing academic priorities", () => { const base = createPlanningBrief({ metadata: { generatedAt: NOW.toISOString(), requestedCategories: [], unavailableCategories: [], truncatedCategories: [], estimatedContextSize: 0, estimatedTokens: 0, maxCharacters: 40000 } }, { mode: "create", request: "Plan my day", startDate: DAY, endDate: DAY, availability: [{ date: DAY, availableMinutes: 120 }] }); const brief = constrainPlanningBrief(base, { status: "available", timezone: "UTC", checkedAt: NOW.toISOString(), assumptions: [], days: [{ date: DAY, availableMinutes: 60, freeWindows: [interval(Date.parse(at("09:00")), Date.parse(at("09:30"))), interval(Date.parse(at("11:00")), Date.parse(at("11:30")))] }] }); expect(brief.signals).toEqual(base.signals); const placed = placeStudyTasks([{ date: new Date(`${DAY}T00:00Z`), durationMinutes: 60 }], brief); expect(placed.map(x => x.durationMinutes)).toEqual([30, 30]); expect(placed[1].scheduledStart?.toISOString()).toBe(at("11:00")); expect(() => placeStudyTasks([{ date: new Date(`${DAY}T00:00Z`), durationMinutes: 75 }], brief)).toThrow(); });
});
