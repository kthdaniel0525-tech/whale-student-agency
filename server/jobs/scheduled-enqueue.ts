import "server-only";
import { randomUUID } from "node:crypto";
import { fromPrisma } from "pg-boss";
import type { PgBoss } from "pg-boss";
import { db } from "../db/client";
import { getBackgroundJobPublisher } from "./client";
import { getBackgroundJobConfig } from "./config";
import { normalizeBackgroundJobError } from "./errors";
import {
  RECOMMENDATION_SCHEDULER_GROUP,
  scheduledRecommendationRefreshJob,
} from "./scheduled-recommendations";
import { BACKGROUND_JOB_PRIORITIES, type JobRunReference } from "./types";
import { deliverReadyNotificationsJob } from "./deliver-notifications";

type SchedulePublisher = Pick<PgBoss, "send">;

export function assertManualBackgroundJobTriggerAllowed(
  environment = process.env.NODE_ENV,
): void {
  if (environment === "production") {
    throw new Error("The manual background-job trigger is disabled in production.");
  }
}

export async function enqueueScheduledRecommendationCycle(
  input: {
    idempotencyKey?: string;
    now?: Date;
    sourceEvent?: string;
  } = {},
  dependencies: { publisher?: SchedulePublisher } = {},
): Promise<JobRunReference> {
  return enqueueScheduledCycle(scheduledRecommendationRefreshJob, RECOMMENDATION_SCHEDULER_GROUP, input, dependencies);
}

export async function enqueueNotificationDeliverySweep(
  input: { idempotencyKey?: string; now?: Date; sourceEvent?: string } = {},
  dependencies: { publisher?: SchedulePublisher } = {},
) {
  return enqueueScheduledCycle(deliverReadyNotificationsJob, "notification-sweep", input, dependencies);
}

async function enqueueScheduledCycle(
  definition: typeof scheduledRecommendationRefreshJob | typeof deliverReadyNotificationsJob,
  groupId: string,
  input: { idempotencyKey?: string; now?: Date; sourceEvent?: string },
  dependencies: { publisher?: SchedulePublisher },
): Promise<JobRunReference> {
  const now = input.now ?? new Date();
  const idempotencyKey = input.idempotencyKey ??
    `manual:${definition.name}:${now.toISOString()}`;
  const existing = await db().jobRun.findUnique({ where: { idempotencyKey } });
  if (existing) return { ...existing, deduplicated: true };
  const publisher = dependencies.publisher ?? await getBackgroundJobPublisher();
  try {
    return await db().$transaction(async (transaction) => {
      const duplicate = await transaction.jobRun.findUnique({
        where: { idempotencyKey },
      });
      if (duplicate) return { ...duplicate, deduplicated: true };
      const queueJobId = randomUUID();
      const run = await transaction.jobRun.create({
        data: {
          queueJobId,
          idempotencyKey,
          jobName: definition.name,
          jobVersion: definition.version,
          metadata: input.sourceEvent
            ? { sourceEvent: input.sourceEvent }
            : undefined,
        },
      });
      const config = getBackgroundJobConfig();
      const acceptedId = await publisher.send(
        definition.name,
        {
          version: definition.version,
          trackingId: run.id,
          scheduledFor: now.toISOString(),
        },
        {
          id: queueJobId,
          priority: BACKGROUND_JOB_PRIORITIES[definition.priority],
          retryLimit: definition.retryPolicy.limit,
          retryDelay: definition.retryPolicy.delaySeconds,
          retryBackoff: definition.retryPolicy.exponentialBackoff,
          retryDelayMax: definition.retryPolicy.maximumDelaySeconds,
          expireInSeconds: definition.timeoutSeconds,
          retentionSeconds: config.pendingRetentionSeconds,
          deleteAfterSeconds: config.completedRetentionSeconds,
          group: { id: groupId },
          deadLetter: config.deadLetterQueue,
          db: fromPrisma(transaction),
        },
      );
      if (!acceptedId) throw new Error("Scheduled refresh was not accepted.");
      return { ...run, deduplicated: false };
    });
  } catch (cause) {
    const duplicate = await db().jobRun.findUnique({ where: { idempotencyKey } });
    if (duplicate) return { ...duplicate, deduplicated: true };
    throw normalizeBackgroundJobError(cause);
  }
}
