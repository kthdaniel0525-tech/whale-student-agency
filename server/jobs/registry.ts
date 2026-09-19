import "server-only";
import { cleanupOAuthSessionsJob } from "./cleanup-oauth";
import { refreshRecommendationsJob } from "./refresh-recommendations";
import { refreshRemindersJob } from "./refresh-reminders";
import { deliverUserNotificationsJob, deliverReadyNotificationsJob } from "./deliver-notifications";
import { scheduledRecommendationRefreshJob } from "./scheduled-recommendations";

export const BACKGROUND_JOBS = [
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
