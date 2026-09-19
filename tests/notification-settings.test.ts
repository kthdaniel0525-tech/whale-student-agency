import "dotenv/config";
import { randomUUID } from "node:crypto";
import { beforeAll, beforeEach, afterEach, afterAll, describe, it, expect, vi } from "vitest";
import { db } from "@/server/db/client";
import { auth } from "@/server/auth/config";
import * as ai from "@/server/ai";
import * as enqueue from "@/server/jobs/enqueue";
import type { AIProvider, AIStructuredRequest } from "@/server/ai/types";
import { getNotificationPreferences, updateNotificationPreferences, notificationPreferencesFromStored } from "@/server/preferences/notifications";
import type { NotificationPreferenceInput } from "@/lib/student/notification-preferences";
import { notificationPreferenceSchema } from "@/lib/student/notification-preferences";
import { evaluateReminders, snoozeReminder, dismissReminder } from "@/server/reminders";
import { deliverNotification, deliverUserNotifications, getNotifications } from "@/server/notifications";
import { evaluateRecommendations, getTopRecommendations } from "@/server/recommendations";
import { dashboard } from "@/server/services/academic";
import { getAssistantBootstrap } from "@/server/assistant";
import { createStudentAgentService } from "@/server/agents/student-service";
import { deferPastQuietHours, localDateKey } from "@/server/time/local";
import { notificationDeliveryTime } from "@/server/notifications/timing";
import { createRefreshRecommendationsJob } from "@/server/jobs/refresh-recommendations";
import { createRefreshRemindersJob } from "@/server/jobs/refresh-reminders";
import { createScheduledRecommendationRefreshJob } from "@/server/jobs/scheduled-recommendations";
import { selectActiveRecommendationUsers } from "@/server/jobs/active-users";
import { GET, PATCH } from "@/app/api/student/notification-preferences/route";
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const NOW = new Date("2026-09-19T12:00:00Z");
const at = (minutes: number) => new Date(NOW.getTime() + minutes * 60000);
type Actor = { id: string; headers: Headers };
let owner: Actor, other: Actor;
async function actor(): Promise<Actor> {
  const response = await auth().api.signUpEmail({ body: { name: "Settings student", email: `settings-${randomUUID()}@example.test`, password: "Settings-test-passphrase-2026!" }, asResponse: true });
  expect(response.status).toBe(200);
  const { user } = await response.json() as { user: { id: string } };
  await db().profile.create({ data: { userId: user.id, school: "Test", program: "Math", currentYear: 1, semester: "Fall", academicGoal: "Learn", studySessionMinutes: 45, explanationDifficulty: "INTERMEDIATE", timezone: "UTC" } });
  return { id: user.id, headers: new Headers({ cookie: response.headers.getSetCookie().map((value) => value.split(";")[0]).join("; "), origin: "http://localhost:3000", "content-type": "application/json" }) };
}
const save = (input: NotificationPreferenceInput) => updateNotificationPreferences(owner.id, input, { now: NOW, refresh: false });
async function fixture(userId = owner.id) {
  const course = await db().course.create({ data: { userId, courseCode: `MATH ${randomUUID().slice(0, 4)}`, courseName: "Math", semester: "Fall" } });
  const assignment = await db().assignment.create({ data: { userId, courseId: course.id, title: "Proof assignment", dueDate: at(1440), priority: "HIGH", estimatedHours: 4 } });
  const exam = await db().exam.create({ data: { userId, courseId: course.id, title: "Midterm", examDate: at(3 * 1440), topics: [] } });
  const plan = await db().studyPlan.create({ data: { userId, title: "Plan", startDate: at(-1440), endDate: at(7 * 1440), summary: "Study", totalPlannedMinutes: 45,
    tasks: { create: { title: "Proof practice", date: at(120), activityType: "PRACTICE", durationMinutes: 45, priority: 80, reason: "Prepare" } } }, include: { tasks: true } });
  const workflow = await db().workflowRun.create({ data: { userId, workflowId: "assignment-support", status: "WAITING_FOR_INPUT", input: {}, context: {}, updatedAt: at(-1500) } });
  return { course, assignment, exam, plan, workflow };
}
const evaluate = () => evaluateReminders(owner.id, { now: NOW });
const request = (actor: Actor, body: unknown) => new Request("http://localhost:3000/api/student/notification-preferences", { method: "PATCH", headers: actor.headers, body: JSON.stringify(body) });
const jobContext = () => ({ payload: { version: 1 as const, trackingId: "settings-test", userId: owner.id }, signal: new AbortController().signal, attempt: 1, jobRunId: "settings-test" });
beforeAll(async () => { owner = await actor(); other = await actor(); });
beforeEach(async () => {
  for (const actor of [owner, other]) {
    const where = { userId: actor.id };
    await db().reminder.deleteMany({ where });
    await db().reminderPreference.deleteMany({ where });
    await db().recommendation.deleteMany({ where });
    await db().jobRun.deleteMany({ where });
    await db().workflowRun.deleteMany({ where });
    await db().studyPlan.deleteMany({ where });
    await db().course.deleteMany({ where });
    await db().profile.update({ where: { userId: actor.id }, data: { timezone: "UTC" } });
  }
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOW);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
afterAll(async () => { await db().user.deleteMany({ where: { id: { in: [owner.id, other.id] } } }); await db().$disconnect(); });

describe.sequential("Automation and notification settings", () => {
  it("uses consistent defaults without creating duplicate preference storage", async () => {
    expect(await getNotificationPreferences(owner.id)).toEqual({ remindersEnabled: true, inAppEnabled: true, assignmentReminders: true, examReminders: true, studyReminders: true, workflowReminders: true, proactiveRecommendationsEnabled: true, leadTimeMinutes: 30, quietHoursEnabled: false, quietHoursStart: null, quietHoursEnd: null, timezone: "UTC", notificationFrequency: "AS_READY" });
    expect(await db().reminderPreference.count({ where: { userId: owner.id } })).toBe(0);
  });
  it("global off cancels queued reminders and skips all detection and delivery", async () => {
    await fixture(); const before = await evaluate(); expect(before.reminders.length).toBeGreaterThan(0);
    await save({ remindersEnabled: false });
    expect((await evaluate()).candidatesDetected).toBe(0);
    expect(await db().reminder.count({ where: { userId: owner.id, status: "CANCELLED", preferenceSuppressedAt: NOW } })).toBe(before.reminders.length);
    expect((await deliverUserNotifications(owner.id)).attempted).toBe(0);
    expect((await deliverNotification(owner.id, before.reminders[0].id)).delivered).toBe(false);
  });
  it.each([
    ["assignmentReminders", ["assignment-due", "assignment-overdue"]],
    ["examReminders", ["exam-upcoming", "exam-tomorrow", "weak-topic-before-exam", "diagnostic-practice"]],
    ["studyReminders", ["study-session", "missed-study-task", "study-plan-behind"]],
    ["workflowReminders", ["workflow-waiting"]],
  ] as const)("%s prevents persistence and cancels already scheduled category reminders", async (key, types) => {
    const data = await fixture(); const first = await evaluate();
    const matching = first.reminders.filter((r) => (types as readonly string[]).includes(r.type)); expect(matching.length).toBeGreaterThan(0);
    await save({ [key]: false });
    for (const reminder of matching) {
      expect(await db().reminder.findUnique({ where: { id: reminder.id } })).toMatchObject({ status: "CANCELLED", preferenceSuppressedAt: NOW });
      expect((await deliverNotification(owner.id, reminder.id)).delivered).toBe(false);
    }
    await db().reminder.deleteMany({ where: { userId: owner.id } });
    const result = await evaluate(); expect(result.reminders.every((r) => !(types as readonly string[]).includes(r.type))).toBe(true);
    expect(result.reminders.length).toBeGreaterThan(0);
    expect(await db().workflowRun.findUnique({ where: { id: data.workflow.id } })).toMatchObject({ status: "WAITING_FOR_INPUT" });
    expect((await evaluateRecommendations(owner.id, { now: NOW })).recommendations.length).toBeGreaterThan(0);
  });
  it("turns off in-app delivery while leaving reminder intelligence and history intact", async () => {
    await fixture(); const first = await evaluate(); const row = first.reminders.find((r) => r.type === "assignment-due")!;
    await save({ inAppEnabled: false }); expect((await deliverNotification(owner.id, row.id)).delivered).toBe(false);
    expect((await evaluate()).reminders.length).toBeGreaterThan(0);
    await save({ inAppEnabled: true }); expect((await deliverNotification(owner.id, row.id)).delivered).toBe(true);
    await save({ inAppEnabled: false }); expect((await getNotifications({ userId: owner.id })).notifications).toHaveLength(1);
  });
  it("restores only current settings-suppressed candidates, retaining dismissal, delivered history and snooze", async () => {
    await fixture(); const first = await evaluate();
    const assignment = first.reminders.find((r) => r.type === "assignment-due")!;
    const exam = first.reminders.find((r) => r.type === "exam-upcoming")!;
    const study = first.reminders.find((r) => r.type === "study-session")!;
    await deliverNotification(owner.id, assignment.id);
    await dismissReminder(owner.id, exam.id, NOW);
    await snoozeReminder(owner.id, study.id, at(150), NOW);
    await save({ remindersEnabled: false });
    await save({ remindersEnabled: true });
    const refreshed = await evaluate();
    expect(refreshed.reminders.find((r) => r.id === study.id)).toMatchObject({ status: "snoozed", snoozedUntil: at(150).toISOString() });
    expect(await db().reminder.findUnique({ where: { id: assignment.id } })).toMatchObject({ status: "DELIVERED" });
    expect(await db().reminder.findUnique({ where: { id: exam.id } })).toMatchObject({ status: "DISMISSED" });
    expect(await db().reminder.count({ where: { userId: owner.id } })).toBe(first.reminders.length);
    expect((await deliverNotification(owner.id, study.id)).delivered).toBe(false);
  });
  it("does not resurrect completed or passed sources when reminders are re-enabled", async () => {
    const data = await fixture(); const first = await evaluate();
    await save({ remindersEnabled: false });
    await db().assignment.update({ where: { id: data.assignment.id }, data: { status: "COMPLETED", completedAt: NOW } });
    await db().exam.update({ where: { id: data.exam.id }, data: { examDate: at(-60) } });
    await save({ remindersEnabled: true }); await evaluate();
    for (const r of first.reminders.filter((r) => ["assignment-due", "exam-upcoming"].includes(r.type)))
      expect(await db().reminder.findUnique({ where: { id: r.id } })).toMatchObject({ status: "CANCELLED" });
  });
  it("refreshes current candidates on a normal settings save without manual refresh", async () => {
    await fixture(); await save({ studyReminders: false }); await evaluate();
    await updateNotificationPreferences(owner.id, { studyReminders: true }, { now: NOW });
    expect(await db().reminder.count({ where: { userId: owner.id, type: "STUDY_SESSION", status: "SCHEDULED" } })).toBe(1);
  });
  it("changes timed study lead time without changing assignment deadline windows", async () => {
    await fixture(); const before = await evaluate(); await save({ leadTimeMinutes: 60 }); const after = await evaluate();
    expect(before.reminders.find((r) => r.type === "study-session")?.scheduledFor).toBe(at(90).toISOString());
    expect(after.reminders.find((r) => r.type === "study-session")?.scheduledFor).toBe(at(60).toISOString());
    expect(after.reminders.find((r) => r.type === "assignment-due")?.reasonCode).toBe(before.reminders.find((r) => r.type === "assignment-due")?.reasonCode);
  });
  it("preserves a snooze through lead-time changes and restores a future session on a lead-time round trip", async () => {
    await fixture(); const first = (await evaluate()).reminders.find((r) => r.type === "study-session")!;
    await snoozeReminder(owner.id, first.id, at(150), NOW);
    await save({ leadTimeMinutes: 60 });
    const changed = (await evaluate()).reminders.find((r) => r.type === "study-session")!;
    expect(changed).toMatchObject({ status: "snoozed", snoozedUntil: at(150).toISOString() });
    await save({ leadTimeMinutes: 30 });
    const restored = (await evaluate()).reminders.find((r) => r.type === "study-session")!;
    expect(restored).toMatchObject({ id: first.id, status: "snoozed", snoozedUntil: at(150).toISOString() });
    expect(await db().reminder.count({ where: { userId: owner.id, type: "STUDY_SESSION", status: { in: ["SNOOZED", "SCHEDULED", "READY"] } } })).toBe(1);
  });
  it("updates the reminder's local clock wording after a timezone edit", async () => {
    await fixture(); const first = (await evaluate()).reminders.find((r) => r.type === "study-session")!;
    await save({ timezone: "America/Winnipeg" });
    const changed = (await evaluate()).reminders.find((r) => r.type === "study-session")!;
    expect(changed.id).toBe(first.id); expect(changed.scheduledFor).toBe(first.scheduledFor);
    expect(changed.title).not.toBe(first.title);
  });
  it("hides proactive cards in dashboard and AI, skips generation, but retains normal on-demand AI", async () => {
    await fixture(); await evaluateRecommendations(owner.id, { now: NOW });
    const count = await db().recommendation.count({ where: { userId: owner.id } }); expect(count).toBeGreaterThan(0);
    await save({ proactiveRecommendationsEnabled: false });
    expect(await getTopRecommendations({ userId: owner.id, refresh: false })).toEqual([]);
    expect((await evaluateRecommendations(owner.id)).created).toBe(0);
    expect((await dashboard(owner.id)).recommendations).toEqual([]);
    expect((await getAssistantBootstrap(owner.id)).recommendations).toEqual([]);
    expect(await db().recommendation.count({ where: { userId: owner.id } })).toBe(count);
    const generate = vi.fn();
    async function generateStructuredOutput<T>(request: AIStructuredRequest<T>) {
      generate();
      const parameters = JSON.parse(request.messages[0].content.split("\n").at(-1)!) as { candidates: unknown[] };
      const data = { summary: "Start with the assignment due tomorrow.", recommendedActions: parameters.candidates.slice(0, 1) };
      return { id: "manager", model: "fixture", text: JSON.stringify(data), data: data as T };
    }
    const provider: AIProvider = { generateStructuredOutput, generateText() { throw new Error("Unexpected text"); }, streamText() { throw new Error("Unexpected stream"); }, generateEmbedding() { throw new Error("Unexpected embedding"); } };
    const service = createStudentAgentService({ executor: { getProvider: () => provider }, router: { getProvider: () => provider } });
    expect((await service.handleAgentRequest({ request: "What should I do right now?" }, owner.headers)).ok).toBe(true);
    expect(generate).toHaveBeenCalledOnce();
  });
  it.each(["America/Winnipeg", "America/Toronto", "Asia/Seoul"])("stores valid %s in the existing canonical Profile timezone", async (timezone) => {
    await save({ timezone }); expect((await getNotificationPreferences(owner.id)).timezone).toBe(timezone);
    expect(await db().profile.findUnique({ where: { userId: owner.id } })).toMatchObject({ timezone });
  });
  it.each(["Mars/Olympus", "anything", "+05:00", ""])("rejects invalid timezone %s without changing persisted settings", async (timezone) => {
    await expect(save({ timezone, remindersEnabled: false })).rejects.toThrow(); expect((await getNotificationPreferences(owner.id)).remindersEnabled).toBe(true);
  });
  it.each([{ leadTimeMinutes: 0 }, { leadTimeMinutes: 1.5 }, { leadTimeMinutes: 1441 }, { quietHoursStart: "25:00" }, { quietHoursEnd: "9am" }, { quietHoursEnabled: true }, { quietHoursEnabled: true, quietHoursStart: "08:00", quietHoursEnd: "08:00" }])("rejects malformed timing %j", async (input) => {
    await expect(save(input)).rejects.toThrow(); expect(await db().reminderPreference.count({ where: { userId: owner.id } })).toBe(0);
  });
  it("merges partial updates and stores HH:MM ranges as minute values", async () => {
    await save({ quietHoursEnabled: true, quietHoursStart: "22:00", quietHoursEnd: "08:00", leadTimeMinutes: 15 });
    await save({ assignmentReminders: false });
    expect(await getNotificationPreferences(owner.id)).toMatchObject({ quietHoursEnabled: true, quietHoursStart: 1320, quietHoursEnd: 480, leadTimeMinutes: 15, assignmentReminders: false });
  });
  it("keeps academic detection and silent in-app delivery running during quiet hours", async () => {
    await fixture(); await save({ quietHoursEnabled: true, quietHoursStart: "11:00", quietHoursEnd: "14:00" });
    const reminders = await evaluate(); const row = reminders.reminders.find((r) => r.type === "assignment-due")!;
    expect(row.scheduledFor).toBe(NOW.toISOString());
    expect((await deliverNotification(owner.id, row.id)).delivered).toBe(true);
    expect((await evaluateRecommendations(owner.id)).recommendations.length).toBeGreaterThan(0);
  });
  it("checks current frequency before delivery and delivers once at the next hour", async () => {
    await fixture(); const row = (await evaluate()).reminders.find((r) => r.type === "assignment-due")!;
    await db().reminder.update({ where: { id: row.id }, data: { scheduledFor: at(10) } });
    await save({ notificationFrequency: "HOURLY" });
    expect((await deliverNotification(owner.id, row.id, { now: at(20) })).delivered).toBe(false);
    expect((await deliverNotification(owner.id, row.id, { now: at(60) })).delivered).toBe(true);
    expect((await deliverNotification(owner.id, row.id, { now: at(60) })).delivered).toBe(false);
  });
  it("reads current feature toggles at execution and avoids costly evaluators", async () => {
    await save({ remindersEnabled: false, proactiveRecommendationsEnabled: false });
    const recommendations = vi.fn(), reminders = vi.fn();
    expect(await createRefreshRecommendationsJob(recommendations).handler(jobContext())).toMatchObject({ skipped: true });
    expect(await createRefreshRemindersJob(reminders).handler(jobContext())).toMatchObject({ skipped: true });
    expect(recommendations).not.toHaveBeenCalled(); expect(reminders).not.toHaveBeenCalled();
  });
  it("skips disabled fan-out only, keeps enabled reminders and uses canonical timezone", async () => {
    await fixture(); await save({ proactiveRecommendationsEnabled: false, timezone: "Asia/Seoul" });
    const page = await selectActiveRecommendationUsers({ now: NOW, limit: 1000 });
    const row = page.users.find((r) => r.userId === owner.id)!;
    expect(row).toMatchObject({ timezone: "Asia/Seoul", proactiveRecommendationsEnabled: false });
    const recommendation = vi.fn(); const reminder = vi.fn(async (userId: string) => ({ id: userId, queueJobId: "test", status: "PENDING" as const, deduplicated: false }));
    const job = createScheduledRecommendationRefreshJob({ selectPage: async () => ({ users: [row], nextCursor: null }), enqueueUserRefresh: recommendation, enqueueReminderRefresh: reminder });
    expect(await job.handler({ ...jobContext(), payload: { version: 1, scheduledFor: NOW.toISOString() } })).toMatchObject({ recommendationJobsEnqueued: 0, reminderJobsEnqueued: 1 });
    expect(recommendation).not.toHaveBeenCalled(); expect(reminder).toHaveBeenCalledOnce();
    expect(reminder.mock.calls[0]?.[0]).toBe(owner.id);
  });
  it("queues only enabled refresh effects in the application runtime", async () => {
    const reference = { id: "queued", queueJobId: "queued", status: "PENDING" as const, deduplicated: false };
    const recommendations = vi.spyOn(enqueue, "enqueueRecommendationRefresh").mockResolvedValue(reference);
    const reminders = vi.spyOn(enqueue, "enqueueReminderRefresh").mockResolvedValue(reference);
    const delivery = vi.spyOn(enqueue, "enqueueNotificationDelivery").mockResolvedValue(reference);
    vi.stubEnv("NODE_ENV", "production");
    await updateNotificationPreferences(owner.id, { proactiveRecommendationsEnabled: false }, { now: NOW });
    expect(recommendations).not.toHaveBeenCalled();
    expect(reminders).toHaveBeenCalledWith(owner.id, expect.objectContaining({ sourceEvent: "NOTIFICATION_PREFERENCES_UPDATED", idempotencyKey: expect.stringContaining("settings:reminders:") }));
    expect(delivery).toHaveBeenCalledOnce();
    reminders.mockClear(); delivery.mockClear();
    await updateNotificationPreferences(owner.id, { remindersEnabled: false, proactiveRecommendationsEnabled: true }, { now: at(1) });
    expect(recommendations).toHaveBeenCalledOnce(); expect(reminders).not.toHaveBeenCalled(); expect(delivery).not.toHaveBeenCalled();
  });
  it("keeps the saved preference effective if background enqueue temporarily fails", async () => {
    vi.spyOn(enqueue, "enqueueRecommendationRefresh").mockRejectedValue(new Error("queue unavailable"));
    vi.spyOn(enqueue, "enqueueReminderRefresh").mockRejectedValue(new Error("queue unavailable"));
    vi.spyOn(enqueue, "enqueueNotificationDelivery").mockRejectedValue(new Error("queue unavailable"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubEnv("NODE_ENV", "production");
    await expect(updateNotificationPreferences(owner.id, { inAppEnabled: false }, { now: NOW })).resolves.toMatchObject({ inAppEnabled: false });
    expect((await getNotificationPreferences(owner.id)).inAppEnabled).toBe(false);
    expect(logged).toHaveBeenCalledWith("Settings refresh deferred", { userId: owner.id });
  });
  it("serializes saves with delivery and prevents any later delivery after disabling", async () => {
    await fixture(); const row = (await evaluate()).reminders.find((r) => r.type === "assignment-due")!;
    await Promise.all([deliverNotification(owner.id, row.id), save({ remindersEnabled: false })]);
    const before = await db().notification.count({ where: { userId: owner.id } });
    expect((await deliverNotification(owner.id, row.id)).delivered).toBe(false);
    expect(await db().notification.count({ where: { userId: owner.id } })).toBe(before);
  });
  it("authenticates API identity, rejects supplied user IDs and foreign origins, isolates settings", async () => {
    expect((await GET(new Request("http://localhost:3000/api/student/notification-preferences"))).status).toBe(401);
    expect((await PATCH(request(other, { userId: owner.id, remindersEnabled: false }))).status).toBe(400);
    const badOrigin = new Headers(owner.headers); badOrigin.set("origin", "https://untrusted.test");
    expect((await PATCH(new Request("http://localhost:3000/api/student/notification-preferences", { method: "PATCH", headers: badOrigin, body: "{}" }))).status).toBe(403);
    expect((await PATCH(request(other, { remindersEnabled: false }))).status).toBe(200);
    expect((await getNotificationPreferences(owner.id)).remindersEnabled).toBe(true);
    const result = await GET(new Request(`http://localhost:3000/api/student/notification-preferences?userId=${owner.id}`, { headers: other.headers }));
    expect(await result.json()).toMatchObject({ remindersEnabled: false });
    expect(result.headers.get("cache-control")).toBe("private, no-store");
  });
  it("returns field validation errors and never exposes raw storage failures", async () => {
    const response = await PATCH(request(owner, { timezone: "fake" }));
    expect(response.status).toBe(400); expect(await response.json()).toMatchObject({ fields: { timezone: expect.any(Array) } });
    // Simulate a storage failure at the transaction boundary.
    vi.spyOn(db(), "$transaction").mockRejectedValue(new Error("private database detail"));
    const failed = await PATCH(request(owner, { leadTimeMinutes: 15 }));
    expect(failed.status).toBe(503); expect(JSON.stringify(await failed.json())).not.toContain("private database detail");
  });
  it("settings, previews and refresh effects require zero AI calls", async () => {
    const provider = vi.spyOn(ai, "getAIProvider").mockImplementation(() => { throw new Error("Unexpected AI"); });
    await fixture(); await getNotificationPreferences(owner.id);
    expect((await PATCH(request(owner, { leadTimeMinutes: 15, quietHoursEnabled: true, quietHoursStart: "22:00", quietHoursEnd: "08:00" }))).status).toBe(200);
    await deliverUserNotifications(owner.id);
    expect(provider).not.toHaveBeenCalled();
  });
});

describe("Timezone-aware delivery policy", () => {
  it.each([
    ["2026-09-19T12:30:00Z", "UTC", 720, 780, "2026-09-19T13:00:00Z"],
    ["2026-09-19T23:30:00Z", "UTC", 1320, 480, "2026-09-20T08:00:00Z"],
    ["2026-09-20T07:59:42Z", "UTC", 1320, 480, "2026-09-20T08:00:00Z"],
    ["2026-03-08T04:00:00Z", "America/Winnipeg", 1320, 480, "2026-03-08T13:00:00Z"],
    ["2026-11-01T03:00:00Z", "America/Winnipeg", 1320, 480, "2026-11-01T14:00:00Z"],
  ])("defers %s through quiet hours including DST", (date, timezone, start, end, expected) => {
    expect(deferPastQuietHours(new Date(date), timezone, Number(start), Number(end))).toEqual({ scheduledFor: new Date(expected), deferred: true });
  });
  it("uses an inclusive start and exclusive end", () => {
    expect(deferPastQuietHours(new Date("2026-09-19T08:00:00Z"), "UTC", 1320, 480).deferred).toBe(false);
    expect(deferPastQuietHours(new Date("2026-09-19T22:00:00Z"), "UTC", 1320, 480).deferred).toBe(true);
  });
  it("never bypasses quiet hours for an interruptive channel and leaves silent in-app unchanged", () => {
    const preferences = notificationPreferencesFromStored({ quietHoursEnabled: true, quietHoursStart: 1320, quietHoursEnd: 480 }, "UTC");
    const late = new Date("2026-09-19T23:00:00Z");
    expect(notificationDeliveryTime(late, late, preferences, { interruptive: true, supportsQuietHours: true })).toEqual(new Date("2026-09-20T08:00:00Z"));
    expect(notificationDeliveryTime(late, late, preferences, { interruptive: false, supportsQuietHours: false })).toEqual(late);
  });
  it("keeps hourly delivery on a local hour through half-hour DST rollback", () => {
    const preferences = notificationPreferencesFromStored({ notificationFrequency: "HOURLY" }, "Australia/Lord_Howe");
    const time = new Date("2026-04-04T14:50:00Z");
    expect(notificationDeliveryTime(time, time, preferences, { interruptive: false, supportsQuietHours: false })).toEqual(new Date("2026-04-04T15:30:00Z"));
  });
  it("rounds frequency to the student's local hour including half-hour timezone offsets", () => {
    const preferences = notificationPreferencesFromStored({ notificationFrequency: "HOURLY" }, "Asia/Kolkata");
    expect(notificationDeliveryTime(new Date("2026-09-19T12:10:45Z"), NOW, preferences, { interruptive: false, supportsQuietHours: false })).toEqual(new Date("2026-09-19T12:30:00Z"));
    expect(localDateKey(new Date("2026-09-19T23:00:00Z"), "Asia/Seoul")).toBe("2026-09-20");
    expect(notificationPreferenceSchema.safeParse({ userId: "someone" }).success).toBe(false);
  });
});
