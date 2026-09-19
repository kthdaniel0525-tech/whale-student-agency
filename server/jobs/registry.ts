import "server-only";
import { syncExternalCourseJob, scheduleExternalCourseSyncJob } from "./sync-external-course";
import { importGoogleDriveFileJob } from "./import-google-drive-file";
import { syncGoogleCalendarJob, scheduleGoogleCalendarSyncJob } from "./sync-google-calendar";
import { cleanupOAuthSessionsJob } from "./cleanup-oauth";
import { refreshRecommendationsJob } from "./refresh-recommendations";
import { refreshRemindersJob } from "./refresh-reminders";
import { deliverUserNotificationsJob, deliverReadyNotificationsJob } from "./deliver-notifications";
import { scheduledRecommendationRefreshJob } from "./scheduled-recommendations";

export const BACKGROUND_JOBS = [
  syncExternalCourseJob, scheduleExternalCourseSyncJob,
  importGoogleDriveFileJob,
  syncGoogleCalendarJob, scheduleGoogleCalendarSyncJob,
  cleanupOAuthSessionsJob,
  refreshRecommendationsJob,
  refreshRemindersJob,
  deliverUserNotificationsJob,
  deliverReadyNotificationsJob,
  scheduledRecommendationRefreshJob,
] as const;

export function getBackgroundJob(name: string) {
  return BACKGROUND_JOBS.find((job) => job.name === name);
}
