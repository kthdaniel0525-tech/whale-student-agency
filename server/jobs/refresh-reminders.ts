import "server-only";
import { getNotificationPreferences, enabledReminderTypes } from "../preferences/notifications";
import { z } from "zod";
import { evaluateReminders } from "../reminders";
import { BackgroundJobError } from "./errors";
import type { BackgroundJob, BackgroundJobResult } from "./types";

export const REFRESH_USER_REMINDERS_JOB = "refresh-user-reminders";

export const refreshReminderJobPayload = z.object({
  version: z.literal(1),
  trackingId: z.string().min(1).max(100),
  userId: z.string().min(1).max(100),
});

export type RefreshReminderJobPayload = z.infer<typeof refreshReminderJobPayload>;
type ReminderEvaluator = typeof evaluateReminders;

export function createRefreshRemindersJob(
  evaluate: ReminderEvaluator = evaluateReminders,
): BackgroundJob<RefreshReminderJobPayload> {
  return {
    name: REFRESH_USER_REMINDERS_JOB,
    version: 1,
    payloadSchema: refreshReminderJobPayload,
    retryPolicy: {
      limit: 3,
      delaySeconds: 5,
      maximumDelaySeconds: 60,
      exponentialBackoff: true,
    },
    timeoutSeconds: 30,
    priority: "normal",
    executionScope: "user",
    concurrency: { scope: "user", limit: 1 },
    debounceSeconds: 10,
    async handler({ payload, signal }): Promise<BackgroundJobResult> {
      if (signal.aborted) throw new BackgroundJobError("TIMEOUT");
      const preferences = await getNotificationPreferences(payload.userId);
      if (!enabledReminderTypes(preferences).length) return { skipped: true, reason: "FEATURE_DISABLED" };
      const result = await evaluate(payload.userId);
      if (signal.aborted) throw new BackgroundJobError("TIMEOUT");
      return {
        candidatesDetected: result.candidatesDetected,
        created: result.created,
        updated: result.updated,
        deduplicated: result.deduplicated,
        expired: result.expired,
        snoozed: result.snoozed,
        dismissed: result.dismissed,
        active: result.reminders.length,
      };
    },
  };
}

export const refreshRemindersJob = createRefreshRemindersJob();
