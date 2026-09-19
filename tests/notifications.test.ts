import "dotenv/config";
import { randomUUID } from "node:crypto";
import { beforeAll, beforeEach, afterEach, afterAll, describe, it, expect, vi } from "vitest";
import type { Reminder, Prisma } from "@/generated/prisma/client";
import { db } from "@/server/db/client";
import { auth } from "@/server/auth/config";
import * as ai from "@/server/ai";
import { evaluateReminders, updateReminderPreferences } from "@/server/reminders";
import { InAppNotificationChannel, deliverNotification, deliverUserNotifications, getNotifications, getUnreadNotificationCount,
  markNotificationRead, markAllNotificationsRead, dismissNotification, snoozeNotification, getNotificationAction } from "@/server/notifications";
import { getNotificationMetrics } from "@/server/notifications/metrics";
import { createDeliverReadyNotificationsJob, createDeliverUserNotificationsJob, selectDeliveryUsers } from "@/server/jobs/deliver-notifications";
import { enqueueNotificationDelivery } from "@/server/jobs/enqueue";
import { executeBackgroundJob } from "@/server/jobs/executor";
import { registerNotificationDeliverySchedule } from "@/server/jobs/schedule";
import { GET as listRoute } from "@/app/api/student/notifications/route";
import { PATCH as updateRoute } from "@/app/api/student/notifications/[id]/route";
import { POST as actionRoute } from "@/app/api/student/notifications/[id]/action/route";
import { getAssistantWorkflowMessage } from "@/server/assistant";

const NOW = new Date("2026-09-19T12:00:00Z");
const later = (minutes: number) => new Date(NOW.getTime() + minutes * 60000);
type Actor = { id: string; headers: Headers };
let owner: Actor, other: Actor;
async function actor(): Promise<Actor> {
  const response = await auth().api.signUpEmail({ body: { name: "Notification student", email: `notification-${randomUUID()}@example.test`, password: "Notification-test-passphrase-2026!" }, asResponse: true });
  expect(response.status).toBe(200);
  const body = await response.json() as { user: { id: string } };
  const headers = new Headers({ cookie: response.headers.getSetCookie().map((value) => value.split(";")[0]).join("; "), origin: "http://localhost:3000", "content-type": "application/json" });
  await db().profile.create({ data: { userId: body.user.id, school: "Test", program: "Math", currentYear: 1, semester: "Fall", academicGoal: "Learn", studySessionMinutes: 45, explanationDifficulty: "INTERMEDIATE", timezone: "UTC" } });
  return { id: body.user.id, headers };
}
async function fixture(userId = owner.id, overrides: Partial<Prisma.ReminderUncheckedCreateInput> = {}) {
  const course = await db().course.create({ data: { userId, courseCode: `MATH ${randomUUID().slice(0,4)}`, courseName: "Mathematics", semester: "Fall" } });
  const assignment = await db().assignment.create({ data: { userId, courseId: course.id, title: "Proof assignment", dueDate: later(1440), priority: "HIGH", estimatedHours: 4 } });
  const row = await db().reminder.create({ data: {
    userId, type: "ASSIGNMENT_DUE", title: "Assignment tomorrow", message: "Your proof assignment is due tomorrow.",
    priority: "HIGH", priorityScore: 80, status: "READY", sourceType: "ASSIGNMENT", sourceId: assignment.id,
    scheduledFor: NOW, expiresAt: later(2880), reasonCode: "ASSIGNMENT_DUE_TOMORROW", reasonData: {},
    actionTargetType: "WORKFLOW", actionTargetId: "assignment-support", actionPayload: { assignmentId: assignment.id, courseId: course.id },
    dedupeKey: randomUUID(), supersessionKey: `assignment:${assignment.id}`, stateFingerprint: "fixture", activeKey: `${userId}:${assignment.id}`,
    ...overrides,
  } });
  return { row, assignment, course };
}
async function deliverFixture(overrides: Partial<Prisma.ReminderUncheckedCreateInput> = {}) {
  const fixtureData = await fixture(owner.id, overrides);
  await deliverNotification(owner.id, fixtureData.row.id, { now: NOW });
  const notification = await db().notification.findFirstOrThrow({ where: { reminderId: fixtureData.row.id } });
  return { ...fixtureData, notification };
}
const context = () => ({ payload: { version: 1 as const }, signal: new AbortController().signal, attempt: 1, jobRunId: "sweep-test" });
async function state(row: Reminder) { return db().reminder.findUniqueOrThrow({ where: { id: row.id } }); }
beforeAll(async () => { owner = await actor(); other = await actor(); });
beforeEach(async () => {
  for (const user of [owner, other]) {
    await db().notification.deleteMany({ where: { userId: user.id } });
    await db().reminder.deleteMany({ where: { userId: user.id } });
    await db().reminderPreference.deleteMany({ where: { userId: user.id } });
    await db().jobRun.deleteMany({ where: { userId: user.id } });
    await db().course.deleteMany({ where: { userId: user.id } });
    await db().workflowRun.deleteMany({ where: { userId: user.id } });
  }
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOW);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
afterAll(async () => { await db().user.deleteMany({ where: { id: { in: [owner.id, other.id] } } }); await db().$disconnect(); });

describe.sequential("Proactive in-app notifications", () => {
  it("delivers ready reminders with unchanged text, priority and safe action IDs", async () => {
    const { row, notification } = await deliverFixture();
    expect(notification).toMatchObject({ title: row.title, message: row.message, priority: "HIGH", status: "DELIVERED", deliveredAt: NOW, deliveryCount: 1 });
    expect(await state(row)).toMatchObject({ status: "DELIVERED", deliveredAt: NOW });
    expect(notification.actionPayload).toEqual(row.actionPayload);
  });
  it("does not deliver future reminders early", async () => {
    const { row } = await fixture(owner.id, { status: "SCHEDULED", scheduledFor: later(60) });
    expect((await deliverNotification(owner.id, row.id)).delivered).toBe(false);
    expect(await db().notification.count({ where: { reminderId: row.id } })).toBe(0);
    expect((await deliverNotification(owner.id, row.id, { now: later(60) })).delivered).toBe(true);
  });
  it.each(["EXPIRED", "DISMISSED", "CANCELLED"] as const)("ignores %s reminders", async (status) => {
    const { row } = await fixture(owner.id, { status });
    expect((await deliverNotification(owner.id, row.id)).delivered).toBe(false);
  });
  it("ignores reminders past their expiry even if marked ready", async () => {
    const { row } = await fixture(owner.id, { expiresAt: later(-1) });
    expect((await deliverNotification(owner.id, row.id)).delivered).toBe(false);
  });
  it("ignores snoozed reminders until the requested time", async () => {
    const { row } = await fixture(owner.id, { status: "SNOOZED", snoozedUntil: later(60) });
    expect((await deliverNotification(owner.id, row.id)).delivered).toBe(false);
  });
  it("provides non-interruptive, rich-action in-app channel capabilities", () => {
    expect(new InAppNotificationChannel()).toMatchObject({ id: "in-app", interruptive: false, supportsQuietHours: false, supportsRichActions: true });
  });
  it("is idempotent across concurrent retries and preserves read state", async () => {
    const { row } = await fixture();
    await Promise.all(Array.from({ length: 5 }, () => deliverNotification(owner.id, row.id)));
    const notification = await db().notification.findFirstOrThrow({ where: { reminderId: row.id } });
    await markNotificationRead(owner.id, notification.id);
    await deliverNotification(owner.id, row.id);
    expect(await db().notification.count({ where: { reminderId: row.id } })).toBe(1);
    expect(await db().notification.findUnique({ where: { id: notification.id } })).toMatchObject({ status: "READ", deliveryCount: 1 });
  });
  it("delivers once when the same tracked background job is retried", async () => {
    const { row } = await fixture();
    let queued: { name: string; data: object | null; id: string } | undefined;
    const run = await enqueueNotificationDelivery(owner.id, { idempotencyKey: randomUUID() }, { publisher: { async sendDebounced(name, data, options) {
      queued = { name, data, id: options!.id! }; return options!.id!;
    } } });
    const job = { ...queued!, retryCount: 0, retryLimit: 2, signal: new AbortController().signal };
    const logger = { info: vi.fn(), error: vi.fn() };
    expect((await executeBackgroundJob(createDeliverUserNotificationsJob(), job, { logger })).status).toBe("completed");
    expect((await executeBackgroundJob(createDeliverUserNotificationsJob(), { ...job, retryCount: 1 }, { logger })).status).toBe("completed");
    expect(await db().jobRun.findUnique({ where: { id: run.id } })).toMatchObject({ status: "COMPLETED" });
    expect(await db().notification.findFirst({ where: { reminderId: row.id } })).toMatchObject({ deliveryCount: 1 });
  });
  it("paginates stable recent notification history without leaking another user's items", async () => {
    for (let i = 0; i < 3; i++) await deliverFixture();
    const foreign = await fixture(other.id); await deliverNotification(other.id, foreign.row.id);
    const first = await getNotifications({ userId: owner.id, limit: 2 });
    const second = await getNotifications({ userId: owner.id, limit: 2, cursor: first.nextCursor! });
    expect(first.notifications).toHaveLength(2); expect(second.notifications).toHaveLength(1);
    expect(new Set([...first.notifications, ...second.notifications].map((item) => item.id)).size).toBe(3);
    expect(second.nextCursor).toBeNull();
  });
  it("counts unread with persisted state and filters the unread list", async () => {
    const { notification } = await deliverFixture(); await deliverFixture();
    expect(await getUnreadNotificationCount(owner.id)).toBe(2);
    await markNotificationRead(owner.id, notification.id);
    expect(await getUnreadNotificationCount(owner.id)).toBe(1);
    expect((await getNotifications({ userId: owner.id, status: "unread" })).notifications).toHaveLength(1);
  });
  it("mark read is persistent and idempotent", async () => {
    const { notification } = await deliverFixture();
    await markNotificationRead(owner.id, notification.id); await markNotificationRead(owner.id, notification.id, later(60));
    expect(await db().notification.findUnique({ where: { id: notification.id } })).toMatchObject({ status: "READ", readAt: NOW });
  });
  it("marks all read only for the authenticated owner", async () => {
    await deliverFixture(); const foreign = await fixture(other.id); await deliverNotification(other.id, foreign.row.id);
    expect((await markAllNotificationsRead(owner.id)).count).toBe(1);
    expect(await getUnreadNotificationCount(other.id)).toBe(1);
  });
  it("dismisses the notification and reminder without regeneration", async () => {
    const { row, notification } = await deliverFixture();
    await dismissNotification(owner.id, notification.id);
    expect((await state(row)).status).toBe("DISMISSED");
    expect((await deliverNotification(owner.id, row.id)).delivered).toBe(false);
    expect((await getNotifications({ userId: owner.id })).notifications[0]).toMatchObject({ status: "dismissed", actionLabel: null });
  });
  it("snoozes and redelivers the same notification once after the snooze", async () => {
    const { row, notification } = await deliverFixture();
    await snoozeNotification(owner.id, notification.id, later(60));
    expect((await state(row)).status).toBe("SNOOZED");
    expect(await getUnreadNotificationCount(owner.id)).toBe(0);
    await deliverNotification(owner.id, row.id); expect(await getUnreadNotificationCount(owner.id)).toBe(0);
    await deliverNotification(owner.id, row.id, { now: later(60) });
    expect(await db().notification.count({ where: { reminderId: row.id } })).toBe(1);
    expect(await db().notification.findUnique({ where: { id: notification.id } })).toMatchObject({ status: "DELIVERED", deliveryCount: 2, readAt: null, dismissedAt: null });
  });
  it("rejects a snooze that would outlive the reminder", async () => {
    const { notification } = await deliverFixture();
    await expect(snoozeNotification(owner.id, notification.id, later(3000))).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });
  it("preserves assignment support context and marks action clicks read", async () => {
    const { notification, assignment, course } = await deliverFixture();
    const action = await getNotificationAction(owner.id, notification.id);
    const url = new URL(action.href, "http://localhost:3000");
    expect(url.searchParams.get("workflow")).toBe("assignment-support");
    expect(url.searchParams.get("assignmentId")).toBe(assignment.id);
    expect(url.searchParams.get("courseId")).toBe(course.id);
    expect(await getUnreadNotificationCount(owner.id)).toBe(0);
  });
  it("hides stale completed-assignment actions while retaining history", async () => {
    const { notification, assignment } = await deliverFixture();
    await db().assignment.update({ where: { id: assignment.id }, data: { status: "COMPLETED", completedAt: NOW } });
    await expect(getNotificationAction(owner.id, notification.id)).rejects.toMatchObject({ code: "INVALID_TARGET" });
    expect((await getNotifications({ userId: owner.id })).notifications[0].actionLabel).toBeNull();
  });
  it("opens the existing workflow run without starting a new workflow", async () => {
    const run = await db().workflowRun.create({ data: { userId: owner.id, workflowId: "assignment-support", status: "WAITING_FOR_INPUT", input: {}, context: {}, updatedAt: later(-1500) } });
    const { row, notification } = await deliverFixture({ type: "WORKFLOW_WAITING", sourceType: "WORKFLOW_RUN", sourceId: run.id,
      actionTargetType: "RESOURCE", actionTargetId: "workflow-run", actionPayload: { workflowRunId: run.id } });
    expect((await getNotificationAction(owner.id, notification.id)).href).toBe(`/student/assistant/workflows/${run.id}`);
    expect((await getAssistantWorkflowMessage(run.id, owner.headers)).presentation?.workflow?.runId).toBe(run.id);
    expect(await db().workflowRun.count({ where: { userId: owner.id } })).toBe(1);
    await db().workflowRun.update({ where: { id: run.id }, data: { status: "COMPLETED", completedAt: NOW } });
    expect((await getNotifications({ userId: owner.id })).notifications[0].actionLabel).toBeNull();
    expect((await state(row)).status).toBe("DELIVERED");
  });
  it("preserves exam-preparation context and disables passed-exam actions", async () => {
    const base = await fixture();
    const exam = await db().exam.create({ data: { userId: owner.id, courseId: base.course.id, title: "Midterm", examDate: later(60), topics: [] } });
    await db().reminder.update({ where: { id: base.row.id }, data: { type: "EXAM_UPCOMING", sourceType: "EXAM", sourceId: exam.id,
      actionTargetId: "exam-preparation", actionPayload: { courseId: base.course.id, examId: exam.id } } });
    await deliverNotification(owner.id, base.row.id);
    const notification = await db().notification.findFirstOrThrow({ where: { reminderId: base.row.id } });
    expect((await getNotificationAction(owner.id, notification.id)).payload.examId).toBe(exam.id);
    await expect(getNotificationAction(owner.id, notification.id, later(61))).rejects.toMatchObject({ code: "INVALID_TARGET" });
  });
  it("sweeps scheduled reminders that become due without domain events", async () => {
    const { row } = await fixture(owner.id, { status: "SCHEDULED", scheduledFor: later(10) });
    expect(await selectDeliveryUsers(NOW)).not.toContain(owner.id);
    const enqueue = vi.fn(async (userId: string) => deliverUserNotifications(userId, { now: later(10) }));
    const job = createDeliverReadyNotificationsJob({ now: () => later(10), enqueue,
      selectPage: async (now, cursor) => cursor ? [] : (await selectDeliveryUsers(now)).filter((id) => id === owner.id) });
    await job.handler(context());
    expect(enqueue).toHaveBeenCalledWith(owner.id);
    expect((await state(row)).status).toBe("DELIVERED");
  });
  it("enqueues delivery immediately after reminder evaluation", async () => {
    await fixture(); await db().reminder.deleteMany({ where: { userId: owner.id } });
    const enqueue = vi.fn(async () => undefined);
    await evaluateReminders(owner.id, { now: NOW, enqueueDelivery: enqueue });
    expect(enqueue).toHaveBeenCalledWith(owner.id);
  });
  it("continues fan-out after one user enqueue fails and bounds concurrency", async () => {
    let active = 0, maximum = 0;
    const users = Array.from({ length: 12 }, (_, i) => `user-${i}`);
    const job = createDeliverReadyNotificationsJob({ selectPage: async (_now, cursor) => cursor ? [] : users,
      enqueue: async (id) => { active++; maximum = Math.max(active, maximum); await Promise.resolve(); active--; if (id === "user-2") throw new Error("unavailable"); } });
    expect(await job.handler(context())).toMatchObject({ enqueued: 11, failed: 1 });
    expect(maximum).toBeLessThanOrEqual(5);
  });
  it("blocks every cross-user read, mutation, delivery and action", async () => {
    const { row, notification } = await deliverFixture();
    for (const operation of [() => markNotificationRead(other.id, notification.id), () => dismissNotification(other.id, notification.id),
      () => snoozeNotification(other.id, notification.id, later(60)), () => getNotificationAction(other.id, notification.id), () => deliverNotification(other.id, row.id)]) {
      await expect(operation()).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
    expect((await getNotifications({ userId: other.id })).notifications).toHaveLength(0);
  });
  it("rejects cross-user action payloads before delivery", async () => {
    const foreign = await fixture(other.id);
    const { row } = await fixture(owner.id, { actionPayload: { assignmentId: foreign.assignment.id } });
    expect((await deliverNotification(owner.id, row.id)).delivered).toBe(false);
    expect((await state(row)).status).toBe("EXPIRED");
  });
  it("strips arbitrary payload metadata and rejects arbitrary URL targets", async () => {
    const { row, assignment } = await fixture();
    await db().reminder.update({ where: { id: row.id }, data: { actionPayload: { assignmentId: assignment.id, prompt: "hidden", apiKey: "secret", url: "https://untrusted.test" } } });
    await deliverNotification(owner.id, row.id);
    expect((await db().notification.findFirstOrThrow({ where: { reminderId: row.id } })).actionPayload).toEqual({ assignmentId: assignment.id });
    const malicious = await fixture(owner.id, { actionTargetId: "https://untrusted.test" });
    expect((await deliverNotification(owner.id, malicious.row.id)).delivered).toBe(false);
  });
  it("honors channel and reminder preferences", async () => {
    const { row } = await fixture();
    await updateReminderPreferences(owner.id, { inAppEnabled: false });
    expect((await deliverNotification(owner.id, row.id)).delivered).toBe(false);
    await updateReminderPreferences(owner.id, { inAppEnabled: true, assignmentReminders: false });
    expect((await deliverNotification(owner.id, row.id)).delivered).toBe(false);
  });
  it("does not advance quiet-hours deferred schedules", async () => {
    const { row } = await fixture(owner.id, { status: "SCHEDULED", scheduledFor: later(480), reasonData: { quietHoursDeferred: true, originalScheduledFor: NOW.toISOString() } });
    expect((await deliverNotification(owner.id, row.id)).delivered).toBe(false);
  });
  it("records bounded delivery failure without falsely delivering the reminder", async () => {
    const { row } = await fixture();
    const channel = new InAppNotificationChannel(); vi.spyOn(channel, "deliver").mockRejectedValue(new Error("private failure detail"));
    for (let i = 0; i < 3; i++) await expect(deliverNotification(owner.id, row.id, { channel })).rejects.toMatchObject({ code: "STORAGE_FAILURE" });
    expect((await state(row)).status).toBe("READY");
    expect(await db().notification.findFirst({ where: { reminderId: row.id } })).toMatchObject({ status: "FAILED", failedAttempts: 3, lastErrorCode: "DELIVERY_FAILED" });
    expect((await deliverUserNotifications(owner.id)).attempted).toBe(0);
    expect(getNotificationMetrics().failed).toBeGreaterThanOrEqual(3);
  });
  it("bounds failures when a previously delivered notification is redelivered after snooze", async () => {
    const { row, notification } = await deliverFixture();
    await snoozeNotification(owner.id, notification.id, later(60));
    const channel = new InAppNotificationChannel();
    vi.spyOn(channel, "deliver").mockRejectedValue(new Error("transient"));
    for (let i = 0; i < 3; i++) await expect(deliverNotification(owner.id, row.id, { now: later(60), channel })).rejects.toThrow();
    expect(await db().notification.findUnique({ where: { id: notification.id } })).toMatchObject({ status: "FAILED", failedAttempts: 3, deliveryCount: 1 });
    expect((await deliverUserNotifications(owner.id, { now: later(60) })).attempted).toBe(0);
  });
  it("retains history after source deletion but removes its action", async () => {
    const { notification, assignment } = await deliverFixture();
    await db().assignment.delete({ where: { id: assignment.id } });
    expect((await getNotifications({ userId: owner.id })).notifications[0]).toMatchObject({ id: notification.id, actionLabel: null, canSnooze: false });
    await expect(getNotificationAction(owner.id, notification.id)).rejects.toMatchObject({ code: "INVALID_TARGET" });
  });
  it("isolates a failed channel operation from other reminders in the same user batch", async () => {
    const first = await fixture(); const second = await fixture();
    const channel = new InAppNotificationChannel(); const deliver = channel.deliver.bind(channel);
    vi.spyOn(channel, "deliver").mockImplementation(async (input, tx) => {
      const notification = await tx.notification.findUniqueOrThrow({ where: { id: input.notification.id } });
      if (notification.reminderId === first.row.id) throw new Error("transient");
      return deliver(input, tx);
    });
    expect(await deliverUserNotifications(owner.id, { channel })).toMatchObject({ delivered: 1, failed: 1 });
    expect((await state(second.row)).status).toBe("DELIVERED");
  });
  it("recovers from a transient failure without duplicating the artifact", async () => {
    const { row } = await fixture(); const channel = new InAppNotificationChannel();
    vi.spyOn(channel, "deliver").mockRejectedValueOnce(new Error("transient"));
    await expect(deliverNotification(owner.id, row.id, { channel })).rejects.toThrow();
    await deliverNotification(owner.id, row.id);
    expect(await db().notification.count({ where: { reminderId: row.id } })).toBe(1);
    expect(await db().notification.findFirst({ where: { reminderId: row.id } })).toMatchObject({ status: "DELIVERED", failedAttempts: 0 });
  });
  it("registers the configurable five-minute sweep through the existing scheduler", async () => {
    const schedule = vi.fn(async () => undefined);
    await registerNotificationDeliverySchedule({ schedule } as never, { enabled: true });
    expect(schedule).toHaveBeenCalledWith("deliver-ready-notifications", "*/5 * * * *", { version: 1 }, expect.objectContaining({ key: "ready-notifications", missed: "once" }));
  });
  it("expires delivered reminders on refresh and retains notification history", async () => {
    await fixture(); await db().reminder.deleteMany({ where: { userId: owner.id } });
    const result = await evaluateReminders(owner.id, { now: NOW });
    const row = await db().reminder.findUniqueOrThrow({ where: { id: result.reminders[0].id } });
    await deliverNotification(owner.id, row.id);
    await evaluateReminders(owner.id, { now: NOW });
    expect((await state(row)).status).toBe("DELIVERED");
    await db().assignment.updateMany({ where: { userId: owner.id }, data: { status: "COMPLETED", completedAt: NOW } });
    await evaluateReminders(owner.id, { now: NOW });
    expect((await state(row)).status).toBe("EXPIRED");
    expect((await getNotifications({ userId: owner.id })).notifications).toHaveLength(1);
  });
  it("uses authenticated API identity and origin protection", async () => {
    const { notification } = await deliverFixture();
    const ctx = { params: Promise.resolve({ id: notification.id }) };
    expect((await listRoute(new Request("http://localhost:3000/api/student/notifications"))).status).toBe(401);
    expect((await listRoute(new Request(`http://localhost:3000/api/student/notifications?userId=${owner.id}`, { headers: other.headers }))).status).toBe(400);
    expect((await updateRoute(new Request("http://localhost:3000/api/student/notifications/x", { method: "PATCH", headers: other.headers, body: JSON.stringify({ operation: "read" }) }), ctx)).status).toBe(404);
    expect((await actionRoute(new Request("http://localhost:3000/api/student/notifications/x/action", { method: "POST", headers: other.headers }), ctx)).status).toBe(404);
    const badOrigin = new Headers(owner.headers); badOrigin.set("origin", "https://untrusted.test");
    expect((await updateRoute(new Request("http://localhost:3000/api/student/notifications/x", { method: "PATCH", headers: badOrigin, body: JSON.stringify({ operation: "dismiss" }) }), ctx)).status).toBe(403);
  });
  it("requires zero extra AI calls", async () => {
    const provider = vi.spyOn(ai, "getAIProvider").mockImplementation(() => { throw new Error("Unexpected AI call"); });
    const { notification } = await deliverFixture();
    await getNotifications({ userId: owner.id }); await getNotificationAction(owner.id, notification.id);
    expect(provider).not.toHaveBeenCalled();
  });
});
