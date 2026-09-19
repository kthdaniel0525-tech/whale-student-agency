import "server-only";
import { cleanupOAuthSessionsJob } from "./cleanup-oauth";
import type { PgBoss } from "pg-boss";
import { getBackgroundJobConfig } from "./config";
import {
  RECOMMENDATION_SCHEDULE_KEY,
  RECOMMENDATION_SCHEDULER_GROUP,
  scheduledRecommendationRefreshJob,
} from "./scheduled-recommendations";
import { BACKGROUND_JOB_PRIORITIES } from "./types";
import { deliverReadyNotificationsJob } from "./deliver-notifications";

type ScheduleBoundary = Pick<PgBoss, "schedule">;

export async function registerNotificationDeliverySchedule(boss: ScheduleBoundary,
  overrides: { enabled?: boolean; cron?: string } = {}) {
  const config = getBackgroundJobConfig();
  if (!(overrides.enabled ?? config.scheduleEnabled)) return false;
  const definition = deliverReadyNotificationsJob;
  await boss.schedule(definition.name, overrides.cron ?? config.notificationDeliveryCron,
    { version: definition.version }, {
      key: "ready-notifications", tz: "UTC", missed: "once", group: { id: "notification-sweep" },
      retryLimit: definition.retryPolicy.limit, retryDelay: definition.retryPolicy.delaySeconds,
      retryBackoff: true, expireInSeconds: definition.timeoutSeconds, deadLetter: config.deadLetterQueue,
    });
  return true;
}

export async function registerRecommendationRefreshSchedule(
  boss: ScheduleBoundary,
  overrides: { enabled?: boolean; cron?: string } = {},
): Promise<boolean> {
  const config = getBackgroundJobConfig();
  const enabled = overrides.enabled ?? config.scheduleEnabled;
  if (!enabled) return false;
  const definition = scheduledRecommendationRefreshJob;
  await boss.schedule(
    definition.name,
    overrides.cron ?? config.recommendationRefreshCron,
    { version: definition.version },
    {
      key: RECOMMENDATION_SCHEDULE_KEY,
      tz: "UTC",
      missed: "once",
      priority: BACKGROUND_JOB_PRIORITIES[definition.priority],
      retryLimit: definition.retryPolicy.limit,
      retryDelay: definition.retryPolicy.delaySeconds,
      retryBackoff: definition.retryPolicy.exponentialBackoff,
      retryDelayMax: definition.retryPolicy.maximumDelaySeconds,
      expireInSeconds: definition.timeoutSeconds,
      group: { id: RECOMMENDATION_SCHEDULER_GROUP },
      deadLetter: config.deadLetterQueue,
    },
  );
  return true;
}

export async function registerOAuthCleanupSchedule(boss: ScheduleBoundary, overrides: { enabled?: boolean } = {}) {
  const config = getBackgroundJobConfig();
  if (!(overrides.enabled ?? config.scheduleEnabled)) return false;
  await boss.schedule(cleanupOAuthSessionsJob.name, "17 * * * *", { version: 1 }, {
    key: "oauth-session-cleanup", tz: "UTC", missed: "once", retryLimit: 2, retryDelay: 30,
    expireInSeconds: 60, deadLetter: config.deadLetterQueue,
  });
  return true;
}

export async function registerCalendarSyncSchedule(boss: ScheduleBoundary, overrides: { enabled?: boolean } = {}) {
  const config = getBackgroundJobConfig();
  if (!(overrides.enabled ?? config.scheduleEnabled)) return false;
  const { scheduleGoogleCalendarSyncJob } = await import("./sync-google-calendar");
  const { CALENDAR_CONFIG } = await import("../calendar/config");
  await boss.schedule(scheduleGoogleCalendarSyncJob.name, CALENDAR_CONFIG.pollCron, { version: 1 }, {
    key: "calendar-sync-sweep", tz: "UTC", missed: "once", group: { id: "calendar-sync-sweep" },
    retryLimit: 2, retryDelay: 30, retryBackoff: true, expireInSeconds: 120, deadLetter: config.deadLetterQueue,
  });
  return true;
}

export async function registerAcademicSyncSchedule(boss: ScheduleBoundary, overrides: { enabled?: boolean } = {}) {
  const config = getBackgroundJobConfig();
  if (!(overrides.enabled ?? config.scheduleEnabled)) return false;
  const { academicSyncConfig } = await import("../academic-integrations/config");
  const { scheduleExternalCourseSyncJob } = await import("./sync-external-course");
  await boss.schedule(scheduleExternalCourseSyncJob.name, academicSyncConfig().cron, { version: 1 }, { key: "academic-sync-sweep", tz: "UTC", missed: "once", group: { id: "academic-sync-sweep" }, retryLimit: 2, retryDelay: 60, expireInSeconds: 120, deadLetter: config.deadLetterQueue });
  return true;
}
