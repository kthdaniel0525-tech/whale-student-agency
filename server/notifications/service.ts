import "server-only";
import { z } from "zod";
import type { Notification, Prisma } from "@/generated/prisma/client";
import { db } from "../db/client";
import { getReminderAction } from "../reminders/service";
import { reminderSourceCurrent } from "../reminders/current";
import { NotificationError } from "./errors";
import { recordNotificationMetric } from "./metrics";
import { safeActionPayload } from "./delivery";
import type { NotificationItem, NotificationPage } from "./types";

const visible = ["DELIVERED", "READ", "DISMISSED"] as const;
async function owned(userId: string, id: string, tx: Prisma.TransactionClient = db()) {
  const row = await tx.notification.findFirst({ where: { id, userId, channel: "IN_APP", status: { in: [...visible] }, deliveredAt: { not: null } } });
  if (!row) throw new NotificationError("NOT_FOUND");
  return row;
}
async function currentAction(row: Notification, now: Date) {
  if (!row.reminderId || row.status === "DISMISSED") return null;
  const reminder = await db().reminder.findFirst({ where: { id: row.reminderId, userId: row.userId } });
  if (!reminder || !await reminderSourceCurrent(reminder, now)) return null;
  try {
    const action = await getReminderAction(row.userId, reminder.id);
    return { ...action, payload: safeActionPayload(action.payload) };
  } catch (error) {
    if (error instanceof Error && "code" in error && ["NOT_FOUND", "INVALID_TARGET"].includes(String(error.code))) return null;
    throw error;
  }
}
function labelFor(target: { type: string; id: string }) {
  return ({ "exam-preparation": "Prepare for exam", "weak-topic-recovery": "Start recovery",
    "assignment-support": "Work on assignment", "lecture-study": "Study lecture", "workflow-run": "Resume workflow",
    "study-plan": "Open study plan", "study-task": "Open study task", "study-planner": "Update study plan",
    quiz: "Start diagnostic quiz", tutor: "Open Tutor", "academic-manager": "Review workload" } as Record<string, string>)[target.id] ?? "Open action";
}
export async function getUnreadNotificationCount(userId: string) {
  return db().notification.count({ where: { userId, channel: "IN_APP", status: "DELIVERED" } });
}
const listSchema = z.object({ userId: z.string().min(1).max(100), status: z.enum(["all", "unread"]).default("all"),
  cursor: z.string().max(1000).optional(), limit: z.number().int().min(1).max(50).default(20) });
export async function getNotifications(input: { userId: string; status?: "all" | "unread"; cursor?: string; limit?: number }, now = new Date()): Promise<NotificationPage> {
  const parsed = listSchema.parse(input);
  let position: { date: string; id: string } | undefined;
  if (parsed.cursor) {
    try { position = z.object({ date: z.string().datetime(), id: z.string().min(1).max(100) }).parse(JSON.parse(Buffer.from(parsed.cursor, "base64url").toString())); }
    catch { throw new NotificationError("INVALID_REQUEST"); }
  }
  const [rows, unreadCount] = await Promise.all([
    db().notification.findMany({ where: { userId: parsed.userId, channel: "IN_APP",
      status: parsed.status === "unread" ? "DELIVERED" : { in: [...visible] }, deliveredAt: { not: null },
      ...(position ? { OR: [{ deliveredAt: { lt: new Date(position.date) } }, { deliveredAt: new Date(position.date), id: { lt: position.id } }] } : {}),
    }, orderBy: [{ deliveredAt: "desc" }, { id: "desc" }], take: parsed.limit + 1 }),
    getUnreadNotificationCount(parsed.userId),
  ]);
  const page = rows.slice(0, parsed.limit);
  const notifications = await Promise.all(page.map(async (row): Promise<NotificationItem> => {
    const action = await currentAction(row, now);
    return { id: row.id, title: row.title, message: row.message, priority: row.priority.toLowerCase() as NotificationItem["priority"],
      status: row.status.toLowerCase() as NotificationItem["status"], deliveredAt: row.deliveredAt!.toISOString(), readAt: row.readAt?.toISOString() ?? null,
      actionLabel: action ? labelFor(action.target) : null, canSnooze: Boolean(action),
    };
  }));
  const last = page.at(-1);
  return { notifications, unreadCount, nextCursor: rows.length > parsed.limit && last
    ? Buffer.from(JSON.stringify({ date: last.deliveredAt!.toISOString(), id: last.id })).toString("base64url") : null };
}
export async function markNotificationRead(userId: string, id: string, now = new Date()) {
  await owned(userId, id);
  const result = await db().notification.updateMany({ where: { id, userId, status: "DELIVERED" }, data: { status: "READ", readAt: now } });
  recordNotificationMetric("read", result.count);
  return { success: true };
}
export async function markAllNotificationsRead(userId: string, now = new Date()) {
  const result = await db().notification.updateMany({ where: { userId, channel: "IN_APP", status: "DELIVERED" }, data: { status: "READ", readAt: now } });
  recordNotificationMetric("read", result.count);
  return { count: result.count };
}
export async function dismissNotification(userId: string, id: string, now = new Date()) {
  const result = await db().$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "User" WHERE id=${userId} FOR UPDATE`;
    const row = await owned(userId, id, tx);
    if (row.status === "DISMISSED") return { success: true, changed: false };
    await tx.notification.update({ where: { id }, data: { status: "DISMISSED", dismissedAt: now } });
    if (row.reminderId) await tx.reminder.updateMany({ where: { id: row.reminderId, userId,
      status: { in: ["READY", "SCHEDULED", "SNOOZED", "DELIVERED"] } },
      data: { status: "DISMISSED", dismissedAt: now, activeKey: null } });
    return { success: true, changed: true };
  });
  recordNotificationMetric("dismissed", Number(result.changed));
  return result;
}
export async function snoozeNotification(userId: string, id: string, until: Date, now = new Date()) {
  if (!Number.isFinite(until.getTime()) || until <= now || until.getTime() > now.getTime() + 30 * 86400000)
    throw new NotificationError("INVALID_REQUEST");
  await db().$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "User" WHERE id=${userId} FOR UPDATE`;
    const row = await owned(userId, id, tx);
    if (!await currentAction(row, now) || !row.reminderId) throw new NotificationError("INVALID_TARGET");
    const reminder = await tx.reminder.findFirst({ where: { id: row.reminderId, userId, status: "DELIVERED" } });
    if (!reminder || (reminder.expiresAt && until >= reminder.expiresAt)) throw new NotificationError("INVALID_REQUEST");
    await tx.reminder.update({ where: { id: reminder.id }, data: { status: "SNOOZED", snoozedUntil: until, scheduledFor: until } });
    await tx.notification.update({ where: { id }, data: { status: "DISMISSED", dismissedAt: now, failedAttempts: 0 } });
  });
  recordNotificationMetric("snoozed");
  return { success: true };
}
export async function getNotificationAction(userId: string, id: string, now = new Date()) {
  const row = await owned(userId, id);
  const action = await currentAction(row, now);
  if (!action) throw new NotificationError("INVALID_TARGET");
  let href: string;
  if (action.target.type === "resource") {
    if (action.target.id === "workflow-run") href = `/student/assistant/workflows/${encodeURIComponent(action.payload.workflowRunId)}`;
    else if (["study-task", "study-plan"].includes(action.target.id)) href = `/student/study-plan?planId=${encodeURIComponent(action.payload.studyPlanId)}${action.payload.studyTaskId ? `#task-${encodeURIComponent(action.payload.studyTaskId)}` : ""}`;
    else if (action.target.id === "assignment") href = `/student/courses/${encodeURIComponent(action.payload.courseId)}?tab=assignments`;
    else throw new NotificationError("INVALID_TARGET");
  } else {
    // The existing AI Workspace launch contract preserves IDs and asks for no extra classification.
    const prompt = action.target.id === "quiz" ? "Create a short diagnostic quiz for this topic."
      : action.target.id === "study-planner" ? "Update my study plan for the missed work."
        : `Help me with this reminder: ${row.title}. ${row.message}`;
    const query = new URLSearchParams({ prompt, [action.target.type]: action.target.id, ...action.payload });
    href = `/student/assistant?${query.toString()}`;
  }
  await markNotificationRead(userId, id, now);
  return { href, target: action.target, payload: action.payload };
}
