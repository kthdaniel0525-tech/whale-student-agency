import "server-only";
import type { NotificationPreferences } from "@/lib/student/notification-preferences";
import { deferPastQuietHours, localMinuteOfDay } from "../time/local";

/** Frequency controls delivery windows, never academic detection. The channel's
 * interruptive capability decides quiet-hour enforcement. Critical is deliberately
 * not an input: it cannot bypass a user's quiet hours. */
export function notificationDeliveryTime(
  scheduledFor: Date,
  now: Date,
  preferences: NotificationPreferences,
  channel: { interruptive: boolean; supportsQuietHours: boolean },
): Date {
  let due = scheduledFor;
  if (preferences.notificationFrequency === "HOURLY") {
    const minute = localMinuteOfDay(due, preferences.timezone) % 60;
    const remainderMs = due.getTime() % 60000;
    if (minute || remainderMs) {
      due = new Date(due.getTime() + (60 - minute) * 60000 - remainderMs);
      // Half-hour DST transitions (for example Lord Howe) can make the first
      // candidate land at :30. Continue to an actual local clock-hour boundary.
      for (let offset = 0; offset < 60 && localMinuteOfDay(due, preferences.timezone) % 60; offset++)
        due = new Date(due.getTime() + 60000);
    }
  }
  if (preferences.quietHoursEnabled && channel.interruptive && channel.supportsQuietHours) {
    due = deferPastQuietHours(new Date(Math.max(due.getTime(), now.getTime())), preferences.timezone,
      preferences.quietHoursStart, preferences.quietHoursEnd).scheduledFor;
  }
  return due;
}
