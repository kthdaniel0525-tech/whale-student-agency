import "server-only";
import { z } from "zod";
import type { Prisma } from "@/generated/prisma/client";
import { db } from "../db/client";
import { validTimezone } from "../time/local";
import { REMINDER_CONFIG } from "../reminders/config";
import { notificationPreferenceSchema, type NotificationPreferences, type NotificationPreferenceInput } from "@/lib/student/notification-preferences";

export class NotificationPreferenceError extends Error {
  constructor(readonly code: "NOT_FOUND" | "STORAGE_FAILURE") {
    super(code === "NOT_FOUND" ? "Your settings are not available." : "Your settings could not be saved. Please try again.");
    this.name = "NotificationPreferenceError";
  }
}

export function notificationPreferencesFromStored(
  row: Partial<Omit<NotificationPreferences, "timezone">> | null | undefined,
  timezone?: string | null,
): NotificationPreferences {
  return {
    remindersEnabled: row?.remindersEnabled ?? true,
    inAppEnabled: row?.inAppEnabled ?? true,
    assignmentReminders: row?.assignmentReminders ?? true,
    examReminders: row?.examReminders ?? true,
    studyReminders: row?.studyReminders ?? true,
    workflowReminders: row?.workflowReminders ?? true,
    proactiveRecommendationsEnabled: row?.proactiveRecommendationsEnabled ?? true,
    leadTimeMinutes: row?.leadTimeMinutes ?? REMINDER_CONFIG.defaultLeadTimeMinutes,
    notificationFrequency: row?.notificationFrequency ?? "AS_READY",
    quietHoursEnabled: row?.quietHoursEnabled ?? false,
    quietHoursStart: row?.quietHoursStart ?? null,
    quietHoursEnd: row?.quietHoursEnd ?? null,
    timezone: validTimezone(timezone),
  };
}

export async function getNotificationPreferences(userId: string, client: Prisma.TransactionClient = db()): Promise<NotificationPreferences> {
  try {
    const user = await client.user.findUnique({ where: { id: userId }, select: { reminderPreference: true, profile: { select: { timezone: true } } } });
    if (!user) throw new NotificationPreferenceError("NOT_FOUND");
    return notificationPreferencesFromStored(user.reminderPreference, user.profile?.timezone);
  } catch (error) {
    if (error instanceof NotificationPreferenceError) throw error;
    throw new NotificationPreferenceError("STORAGE_FAILURE");
  }
}

const categories = {
  assignmentReminders: ["ASSIGNMENT_DUE", "ASSIGNMENT_OVERDUE"],
  examReminders: ["EXAM_UPCOMING", "EXAM_TOMORROW", "WEAK_TOPIC_BEFORE_EXAM", "DIAGNOSTIC_PRACTICE"],
  studyReminders: ["STUDY_SESSION", "MISSED_STUDY_TASK", "STUDY_PLAN_BEHIND"],
  workflowReminders: ["WORKFLOW_WAITING"],
} as const;
export function enabledReminderTypes(preferences: NotificationPreferences) {
  return Object.entries(categories).flatMap(([key, types]) =>
    preferences.remindersEnabled && preferences[key as keyof typeof categories] ? [...types] : []);
}
export function reminderTypeEnabled(type: string, preferences: NotificationPreferences): boolean {
  return enabledReminderTypes(preferences).some((value) => value === type.replaceAll("-", "_").toUpperCase());
}

export async function cancelDisabledReminders(client: Prisma.TransactionClient, userId: string, preferences: NotificationPreferences, now: Date) {
  const result = await client.reminder.updateMany({
    where: { userId, type: { notIn: enabledReminderTypes(preferences) }, status: { in: ["READY", "SCHEDULED", "SNOOZED"] } },
    data: { status: "CANCELLED", activeKey: null, preferenceSuppressedAt: now },
  });
  return result.count;
}

/** Preferences are persisted once in ReminderPreference; timezone stays in Profile.
 * Cancellation shares the delivery/refresh owner lock, so an old queued job cannot
 * deliver against a completed settings save. Dismissal and snooze history survive. */
export async function updateNotificationPreferences(userId: string, raw: NotificationPreferenceInput,
  options: { now?: Date; refresh?: boolean } = {}): Promise<NotificationPreferences> {
  const input = notificationPreferenceSchema.parse(raw);
  const now = options.now ?? new Date();
  try {
    const preferences = await db().$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "User" WHERE id=${userId} FOR UPDATE`;
      const current = await getNotificationPreferences(userId, tx);
      const merged = { ...current, ...input };
      if (merged.quietHoursEnabled && (merged.quietHoursStart === null || merged.quietHoursEnd === null || merged.quietHoursStart === merged.quietHoursEnd)) {
        throw new z.ZodError([{ code: "custom", path: ["quietHoursEnd"], message: "Choose a start and a different end time for quiet hours." }]);
      }
      const { timezone, ...changes } = input;
      await tx.reminderPreference.upsert({ where: { userId }, create: { userId, ...changes }, update: changes });
      if (timezone !== undefined) {
        const result = await tx.profile.updateMany({ where: { userId }, data: { timezone } });
        if (!result.count) throw new NotificationPreferenceError("NOT_FOUND");
      }
      await cancelDisabledReminders(tx, userId, merged, now);
      return merged;
    });
    if (options.refresh !== false) await refreshNotificationPreferenceEffects(userId, now);
    return preferences;
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof NotificationPreferenceError) throw error;
    throw new NotificationPreferenceError("STORAGE_FAILURE");
  }
}

export async function refreshNotificationPreferenceEffects(userId: string, now = new Date()): Promise<void> {
  try {
    const preferences = await getNotificationPreferences(userId);
    if (process.env.NODE_ENV === "test") {
      const operations: Promise<unknown>[] = [];
      if (enabledReminderTypes(preferences).length) operations.push(import("../reminders").then(({ evaluateReminders }) => evaluateReminders(userId, { now })));
      if (preferences.proactiveRecommendationsEnabled) operations.push(import("../recommendations").then(({ evaluateRecommendations }) => evaluateRecommendations(userId, { now })));
      await Promise.all(operations);
    } else {
      const { enqueueReminderRefresh, enqueueRecommendationRefresh, enqueueNotificationDelivery } = await import("../jobs/enqueue");
      // Distinct keys ensure re-enabling is not absorbed by a completed daily refresh.
      const stamp = now.toISOString();
      const options = { sourceEvent: "NOTIFICATION_PREFERENCES_UPDATED", now };
      const operations: Promise<unknown>[] = [];
      if (enabledReminderTypes(preferences).length) operations.push(enqueueReminderRefresh(userId, { ...options,
        idempotencyKey: `settings:reminders:${userId}:${stamp}`, debounceKey: `settings:reminders:${userId}` }));
      if (preferences.proactiveRecommendationsEnabled) operations.push(enqueueRecommendationRefresh(userId, { ...options,
        idempotencyKey: `settings:recommendations:${userId}:${stamp}`, debounceKey: `settings:recommendations:${userId}` }));
      if (preferences.remindersEnabled && preferences.inAppEnabled) operations.push(enqueueNotificationDelivery(userId, { ...options,
        idempotencyKey: `settings:delivery:${userId}:${stamp}`, debounceKey: `settings:delivery:${userId}` }));
      await Promise.all(operations);
    }
  } catch {
    // Durable settings and immediate cancellation remain valid; regular sweeps can recover refresh.
    console.error("Settings refresh deferred", { userId });
  }
}
