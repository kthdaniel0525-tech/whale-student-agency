import "server-only";
import { z } from "zod";
import { selectActiveRecommendationUsers } from "./active-users";
import { getBackgroundJobConfig } from "./config";
import { enqueueRecommendationRefresh, enqueueReminderRefresh } from "./enqueue";
import { BackgroundJobError } from "./errors";
import { localDateKey } from "./time";
import type { BackgroundJob, JobRunReference } from "./types";

export const REFRESH_ACTIVE_USER_RECOMMENDATIONS_JOB =
  "refresh-active-user-recommendations";
export const RECOMMENDATION_SCHEDULE_KEY = "daily-active-users";
export const RECOMMENDATION_SCHEDULER_GROUP = "recommendation-scheduler";

export const scheduledRecommendationJobPayload = z.object({
  version: z.literal(1),
  trackingId: z.string().min(1).max(100).optional(),
  scheduledFor: z.string().datetime().optional(),
});

export type ScheduledRecommendationJobPayload = z.infer<
  typeof scheduledRecommendationJobPayload
>;

type SelectActivePage = typeof selectActiveRecommendationUsers;
type EnqueueUserRefresh = (
  userId: string,
  options: Parameters<typeof enqueueRecommendationRefresh>[1],
) => Promise<JobRunReference>;
type EnqueueReminderRefresh = typeof enqueueReminderRefresh;

interface ScheduledRefreshDependencies {
  readonly selectPage?: SelectActivePage;
  readonly enqueueUserRefresh?: EnqueueUserRefresh;
  readonly enqueueReminderRefresh?: EnqueueReminderRefresh;
  readonly now?: () => Date;
  readonly pageSize?: number;
  readonly fanoutConcurrency?: number;
}

async function settlePage(
  users: Awaited<ReturnType<SelectActivePage>>["users"],
  now: Date,
  concurrency: number,
  enqueueRecommendation: EnqueueUserRefresh,
  enqueueReminder: EnqueueReminderRefresh,
) {
  let enqueued = 0;
  let recommendationJobsEnqueued = 0;
  let reminderJobsEnqueued = 0;
  let skipped = 0;
  let failed = 0;
  const usersPerChunk = Math.max(1, Math.floor(concurrency / 2));
  for (let offset = 0; offset < users.length; offset += usersPerChunk) {
    const chunk = users.slice(offset, offset + usersPerChunk);
    const operations = chunk.flatMap((user) => {
      const day = localDateKey(now, user.timezone);
      const shared = { sourceEvent: "SCHEDULED_DAILY_REFRESH", now } as const;
      return [
        ...(user.proactiveRecommendationsEnabled !== false ? [enqueueRecommendation(user.userId, {
          ...shared,
          idempotencyKey: `recommendation-refresh:${user.userId}:${day}`,
          debounceKey: `scheduled-recommendation:${user.userId}:${day}`,
        }).then((reference) => ({ kind: "recommendation" as const, reference }))] : []),
        ...(user.remindersEnabled !== false ? [enqueueReminder(user.userId, {
          ...shared,
          idempotencyKey: `reminder-refresh:${user.userId}:${day}`,
          debounceKey: `scheduled-reminder:${user.userId}:${day}`,
        }).then((reference) => ({ kind: "reminder" as const, reference }))] : []),
      ];
    });
    const settled = await Promise.allSettled(operations);
    for (const result of settled) {
      if (result.status === "rejected") failed++;
      else if (result.value.reference.deduplicated) skipped++;
      else {
        enqueued++;
        if (result.value.kind === "recommendation") recommendationJobsEnqueued++;
        else reminderJobsEnqueued++;
      }
    }
  }
  return { enqueued, recommendationJobsEnqueued, reminderJobsEnqueued, skipped, failed };
}

export function createScheduledRecommendationRefreshJob(
  dependencies: ScheduledRefreshDependencies = {},
): BackgroundJob<ScheduledRecommendationJobPayload> {
  const config = getBackgroundJobConfig();
  const selectPage = dependencies.selectPage ?? selectActiveRecommendationUsers;
  const enqueueUserRefresh = dependencies.enqueueUserRefresh ?? enqueueRecommendationRefresh;
  const enqueueReminders = dependencies.enqueueReminderRefresh ?? enqueueReminderRefresh;
  const clock = dependencies.now ?? (() => new Date());
  const pageSize = dependencies.pageSize ?? config.recommendationRefreshPageSize;
  const fanoutConcurrency = dependencies.fanoutConcurrency ??
    config.recommendationRefreshFanoutConcurrency;

  return {
    name: REFRESH_ACTIVE_USER_RECOMMENDATIONS_JOB,
    version: 1,
    payloadSchema: scheduledRecommendationJobPayload,
    retryPolicy: {
      limit: 2,
      delaySeconds: 30,
      maximumDelaySeconds: 300,
      exponentialBackoff: true,
    },
    timeoutSeconds: 15 * 60,
    priority: "low",
    executionScope: "system",
    concurrency: { scope: "global", limit: 1 },
    debounceSeconds: 60,
    async handler({ payload, signal, jobRunId }) {
      const now = payload.scheduledFor ? new Date(payload.scheduledFor) : clock();
      let cursor: string | undefined;
      let discovered = 0;
      let enqueued = 0;
      let recommendationJobsEnqueued = 0;
      let reminderJobsEnqueued = 0;
      let skipped = 0;
      let failed = 0;
      let pages = 0;
      do {
        if (signal.aborted) throw new BackgroundJobError("TIMEOUT");
        const page = await selectPage({ now, limit: pageSize, ...(cursor ? { cursor } : {}) });
        pages++;
        discovered += page.users.length;
        const result = await settlePage(
          page.users,
          now,
          fanoutConcurrency,
          enqueueUserRefresh,
          enqueueReminders,
        );
        enqueued += result.enqueued;
        recommendationJobsEnqueued += result.recommendationJobsEnqueued;
        reminderJobsEnqueued += result.reminderJobsEnqueued;
        skipped += result.skipped;
        failed += result.failed;
        cursor = page.nextCursor ?? undefined;
      } while (cursor);

      return {
        scheduleRunId: jobRunId,
        activeUsersDiscovered: discovered,
        usersEvaluated: discovered,
        jobsEnqueued: enqueued,
        recommendationJobsEnqueued,
        reminderJobsEnqueued,
        duplicatesSkipped: skipped,
        failedEnqueues: failed,
        pages,
      };
    },
  };
}

export const scheduledRecommendationRefreshJob =
  createScheduledRecommendationRefreshJob();
