import "server-only";
import type { Prisma } from "@/generated/prisma/client";
import { db } from "../db/client";
import { getReminderAction } from "../reminders/service";
import { getNotificationPreferences, reminderTypeEnabled } from "../preferences/notifications";
import { notificationDeliveryTime } from "./timing";
import { reminderSourceCurrent } from "../reminders/current";
import { InAppNotificationChannel, type NotificationChannel } from "./channel";
import { NotificationError } from "./errors";
import { recordNotificationMetric } from "./metrics";

export const MAX_DELIVERY_ATTEMPTS = 3;
export function dueRemindersWhere(now: Date): Prisma.ReminderWhereInput {
  return { status: { in: ["READY", "SCHEDULED", "SNOOZED"] }, scheduledFor: { lte: now },
    AND: [{ OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
      { OR: [{ snoozedUntil: null }, { snoozedUntil: { lte: now } }] }],
    notifications: { none: { channel: "IN_APP", failedAttempts: { gte: MAX_DELIVERY_ATTEMPTS } } },
  };
}

// Only approved resource IDs are copied; prompts, URLs and arbitrary metadata never enter delivery artifacts.
export function safeActionPayload(value: Record<string, unknown>): Record<string, string> {
  const allowed = ["courseId", "examId", "assignmentId", "topicId", "studyPlanId", "studyTaskId", "workflowRunId"];
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] =>
    allowed.includes(entry[0]) && typeof entry[1] === "string" && entry[1].length > 0 && entry[1].length <= 100));
}

export async function deliverNotification(userId: string, reminderId: string,
  options: { now?: Date; channel?: NotificationChannel } = {}) {
  const now = options.now ?? new Date();
  const channel = options.channel ?? new InAppNotificationChannel();
  if (channel.id !== "in-app") throw new NotificationError("INVALID_REQUEST");
  try {
    const result = await db().$transaction(async (tx) => {
      // Shared owner lock serializes refresh, delivery, dismissal and snooze.
      await tx.$queryRaw`SELECT id FROM "User" WHERE id=${userId} FOR UPDATE`;
      const row = await tx.reminder.findFirst({ where: { id: reminderId, userId } });
      if (!row) throw new NotificationError("NOT_FOUND");
      const existing = await tx.notification.findUnique({ where: { reminderId_channel: { reminderId, channel: "IN_APP" } } });
      if (row.status === "DELIVERED" || (existing && ["DELIVERED", "READ"].includes(existing.status)))
        return { delivered: false, deduplicated: true, failed: false };
      if (!["READY", "SCHEDULED", "SNOOZED"].includes(row.status) || row.scheduledFor > now ||
        (row.snoozedUntil && row.snoozedUntil > now) || (row.expiresAt && row.expiresAt <= now) ||
        (existing?.failedAttempts ?? 0) >= MAX_DELIVERY_ATTEMPTS)
        return { delivered: false, deduplicated: false, failed: false };
      const preferences = await getNotificationPreferences(userId, tx);
      if (!preferences.inAppEnabled || !reminderTypeEnabled(row.type, preferences) ||
        notificationDeliveryTime(new Date(Math.max(row.scheduledFor.getTime(), row.snoozedUntil?.getTime() ?? 0)), now, preferences, channel) > now)
        return { delivered: false, deduplicated: false, failed: false };
      if (!await reminderSourceCurrent(row, now)) {
        await tx.reminder.update({ where: { id: row.id }, data: { status: "EXPIRED", activeKey: null } });
        return { delivered: false, deduplicated: false, failed: false };
      }
      let action;
      try { action = await getReminderAction(userId, row.id); }
      catch (error) {
        if (error instanceof Error && "code" in error && error.code === "INVALID_TARGET") {
          await tx.reminder.update({ where: { id: row.id }, data: { status: "EXPIRED", activeKey: null } });
          return { delivered: false, deduplicated: false, failed: false };
        }
        throw error;
      }
      const latency = Math.min(2_147_483_647, Math.max(0, now.getTime() - row.scheduledFor.getTime()));
      const data = { userId, type: row.type, title: row.title, message: row.message, priority: row.priority,
        status: "PENDING" as const, actionTargetType: row.actionTargetType, actionTargetId: row.actionTargetId,
        actionPayload: safeActionPayload(action.payload), scheduledFor: row.scheduledFor, deliveryLatencyMs: latency };
      const notification = await tx.notification.upsert({
        where: { reminderId_channel: { reminderId, channel: "IN_APP" } },
        create: { ...data, reminderId, channel: "IN_APP" }, update: data,
      });
      await channel.deliver({ userId, notification, now }, tx);
      await tx.reminder.update({ where: { id: row.id }, data: { status: "DELIVERED", deliveredAt: now, snoozedUntil: null } });
      return { delivered: true, deduplicated: false, failed: false, created: !existing, latency };
    }, { timeout: 15_000 });
    if (result.delivered) {
      if (result.created) recordNotificationMetric("created");
      recordNotificationMetric("delivered", 1, result.latency);
    }
    return result;
  } catch (error) {
    if (error instanceof NotificationError) throw error;
    recordNotificationMetric("failed");
    // The transaction rolls back both delivery and reminder state on failure.
    // Persist only a safe failure code; a database outage is also captured in JobRun.
    await db().$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "User" WHERE id=${userId} FOR UPDATE`;
      const row = await tx.reminder.findFirst({ where: { id: reminderId, userId, status: { in: ["READY", "SCHEDULED", "SNOOZED"] } } });
      if (!row) return;
      const existing = await tx.notification.findUnique({ where: { reminderId_channel: { reminderId, channel: "IN_APP" } } });
      if (existing && ["DELIVERED", "READ"].includes(existing.status)) return;
      if (row.scheduledFor > now || (row.snoozedUntil && row.snoozedUntil > now)) return;
      await tx.notification.upsert({ where: { reminderId_channel: { reminderId, channel: "IN_APP" } },
        create: { userId, reminderId, type: row.type, title: row.title, message: row.message, priority: row.priority,
          status: "FAILED", scheduledFor: row.scheduledFor, failedAttempts: 1, lastErrorCode: "DELIVERY_FAILED" },
        update: { status: "FAILED", failedAttempts: { increment: 1 }, lastErrorCode: "DELIVERY_FAILED" },
      });
    }).catch(() => undefined);
    throw new NotificationError("STORAGE_FAILURE");
  }
}

export async function deliverUserNotifications(userId: string, options: { now?: Date; channel?: NotificationChannel } = {}) {
  const now = options.now ?? new Date();
  const preferences = await getNotificationPreferences(userId);
  if (!preferences.inAppEnabled || !preferences.remindersEnabled)
    return { attempted: 0, delivered: 0, deduplicated: 0, failed: 0 };
  const rows = await db().reminder.findMany({ where: { userId, ...dueRemindersWhere(now) },
    orderBy: [{ priorityScore: "desc" }, { id: "asc" }], take: 50, select: { id: true } });
  let delivered = 0, deduplicated = 0, failed = 0;
  for (const row of rows) {
    try {
      const result = await deliverNotification(userId, row.id, { ...options, now });
      delivered += Number(result.delivered); deduplicated += Number(result.deduplicated);
    } catch { failed++; }
  }
  return { attempted: rows.length, delivered, deduplicated, failed };
}
