import "server-only";
import { z } from "zod";
import { getEnv } from "../env";

const jobEnvironmentSchema = z.object({
  BACKGROUND_JOB_SCHEMA: z
    .string()
    .regex(/^[a-z][a-z0-9_]{0,47}$/)
    .default("student_jobs"),
  BACKGROUND_JOB_WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(20).default(4),
  BACKGROUND_JOB_SCHEDULE_ENABLED: z.enum(["true", "false"]).optional(),
  RECOMMENDATION_REFRESH_CRON: z.string().trim().min(1).max(120).default("0 5 * * *"),
  NOTIFICATION_DELIVERY_CRON: z.string().trim().min(1).max(120).default("*/5 * * * *"),
  RECOMMENDATION_REFRESH_PAGE_SIZE: z.coerce.number().int().min(100).max(500).default(200),
  RECOMMENDATION_REFRESH_FANOUT_CONCURRENCY: z.coerce.number().int().min(1).max(50).default(10),
});

export function getBackgroundJobConfig() {
  const parsed = jobEnvironmentSchema.parse(process.env);
  return {
    connectionString: getEnv().DATABASE_URL,
    schema: parsed.BACKGROUND_JOB_SCHEMA,
    workerConcurrency: parsed.BACKGROUND_JOB_WORKER_CONCURRENCY,
    scheduleEnabled: parsed.BACKGROUND_JOB_SCHEDULE_ENABLED
      ? parsed.BACKGROUND_JOB_SCHEDULE_ENABLED === "true"
      : process.env.NODE_ENV === "production",
    recommendationRefreshCron: parsed.RECOMMENDATION_REFRESH_CRON,
    notificationDeliveryCron: parsed.NOTIFICATION_DELIVERY_CRON,
    recommendationRefreshPageSize: parsed.RECOMMENDATION_REFRESH_PAGE_SIZE,
    recommendationRefreshFanoutConcurrency: parsed.RECOMMENDATION_REFRESH_FANOUT_CONCURRENCY,
    deadLetterQueue: "background-dead-letter",
    completedRetentionSeconds: 30 * 24 * 60 * 60,
    pendingRetentionSeconds: 14 * 24 * 60 * 60,
  } as const;
}
