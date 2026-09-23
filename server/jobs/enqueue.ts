import "server-only";
import { captureUsageContext } from "../ai/usage/context";
import { randomUUID } from "node:crypto";
import { fromPrisma } from "pg-boss";
import { z } from "zod";
import { db } from "../db/client";
import { getBackgroundJobPublisher, type BackgroundJobPublisher } from "./client";
import { getBackgroundJobConfig } from "./config";
import { BackgroundJobError, normalizeBackgroundJobError } from "./errors";
import { refreshRecommendationsJob } from "./refresh-recommendations";
import { refreshRemindersJob } from "./refresh-reminders";
import { deliverUserNotificationsJob } from "./deliver-notifications";
import {
  BACKGROUND_JOB_PRIORITIES,
  type BackgroundJob,
  type JobRunReference,
} from "./types";

const enqueueOptionsSchema = z.object({
  idempotencyKey: z.string().min(1).max(240).optional(),
  resourceId: z.string().min(1).max(100).optional(),
  sourceEvent: z.string().min(1).max(80).optional(),
  priority: z.enum(["low", "normal", "high"]).optional(),
  debounceKey: z.string().min(1).max(180).optional(),
  now: z.date().optional(),
});

export type RecommendationRefreshEnqueueOptions = z.infer<
  typeof enqueueOptionsSchema
>;
export type ReminderRefreshEnqueueOptions = RecommendationRefreshEnqueueOptions;

type EnqueueDependencies = {
  publisher?: BackgroundJobPublisher;
  payload?: Record<string, string>;
};

function reference(
  run: {
    id: string;
    queueJobId: string;
    status: "PENDING" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED";
  },
  deduplicated: boolean,
): JobRunReference {
  return { id: run.id, queueJobId: run.queueJobId, status: run.status, deduplicated };
}

export async function enqueueRecommendationRefresh(
  userId: string,
  rawOptions: RecommendationRefreshEnqueueOptions = {},
  dependencies: EnqueueDependencies = {},
): Promise<JobRunReference> {
  return enqueueTrackedUserJob(
    refreshRecommendationsJob,
    userId,
    rawOptions,
    dependencies,
  );
}

export async function enqueueReminderRefresh(
  userId: string,
  rawOptions: ReminderRefreshEnqueueOptions = {},
  dependencies: EnqueueDependencies = {},
): Promise<JobRunReference> {
  return enqueueTrackedUserJob(
    refreshRemindersJob,
    userId,
    rawOptions,
    dependencies,
  );
}

export async function enqueueNotificationDelivery(userId: string, options: RecommendationRefreshEnqueueOptions = {}, dependencies: EnqueueDependencies = {}) {
  return enqueueTrackedUserJob(deliverUserNotificationsJob, userId, options, dependencies);
}

export async function enqueueTrackedUserJob<Payload extends {
  version: number;
  trackingId: string;
  userId: string;
}>(
  definition: BackgroundJob<Payload>,
  userId: string,
  rawOptions: RecommendationRefreshEnqueueOptions,
  dependencies: EnqueueDependencies,
): Promise<JobRunReference> {
  if (!userId || userId.length > 100 || definition.executionScope !== "user")
    throw new BackgroundJobError("INVALID_PAYLOAD");
  const options = enqueueOptionsSchema.parse(rawOptions);
  const now = options.now ?? new Date();
  const window = Math.floor(
    now.getTime() / (definition.debounceSeconds * 1000),
  );
  const idempotencyKey = options.idempotencyKey ??
    `${definition.name}:v${definition.version}:${userId}:${window}`;
  const compatible = (run: { userId: string | null; jobName: string; jobVersion: number; resourceId: string | null }) => {
    if (run.userId !== userId || run.jobName !== definition.name || run.jobVersion !== definition.version || run.resourceId !== (options.resourceId ?? null))
      throw new BackgroundJobError("AUTHORIZATION_ERROR");
  };
  const activeOwner = await db().user.findUnique({ where: { id: userId }, select: { deletionRequestedAt: true } });
  if (!activeOwner) throw new BackgroundJobError("RESOURCE_NOT_FOUND");
  if (activeOwner.deletionRequestedAt) throw new BackgroundJobError("AUTHORIZATION_ERROR");
  const existing = await db().jobRun.findUnique({ where: { idempotencyKey } });
  if (existing) { compatible(existing); return reference(existing, true); }

  const publisher = dependencies.publisher ?? await getBackgroundJobPublisher();
  try {
    const config = getBackgroundJobConfig();
    return await db().$transaction(async (transaction) => {
      await transaction.$queryRaw`SELECT id FROM "User" WHERE id=${userId} FOR UPDATE`;
      const owner = await transaction.user.findUnique({
        where: { id: userId },
        select: { id: true, deletionRequestedAt: true },
      });
      if (!owner) throw new BackgroundJobError("RESOURCE_NOT_FOUND");
      if (owner.deletionRequestedAt) throw new BackgroundJobError("AUTHORIZATION_ERROR");
      const duplicate = await transaction.jobRun.findUnique({
        where: { idempotencyKey },
      });
      if (duplicate) { compatible(duplicate); return reference(duplicate, true); }

      const queueJobId = randomUUID();
      const run = await transaction.jobRun.create({
        data: {
          queueJobId,
          idempotencyKey,
          jobName: definition.name,
          jobVersion: definition.version,
          userId,
          resourceId: options.resourceId,
          metadata: { ...(options.sourceEvent ? { sourceEvent: options.sourceEvent } : {}), requestId: captureUsageContext().requestId! },
        },
      });
      const acceptedId = await publisher.sendDebounced(
        definition.name,
        definition.payloadSchema.parse({ ...dependencies.payload, version: definition.version, trackingId: run.id, userId }),
        {
          id: queueJobId,
          priority: BACKGROUND_JOB_PRIORITIES[options.priority ?? definition.priority],
          retryLimit: definition.retryPolicy.limit,
          retryDelay: definition.retryPolicy.delaySeconds,
          retryBackoff: definition.retryPolicy.exponentialBackoff,
          retryDelayMax: definition.retryPolicy.maximumDelaySeconds,
          expireInSeconds: definition.timeoutSeconds,
          retentionSeconds: config.pendingRetentionSeconds,
          deleteAfterSeconds: config.completedRetentionSeconds,
          group: { id: userId },
          deadLetter: config.deadLetterQueue,
          db: fromPrisma(transaction),
        },
        definition.debounceSeconds,
        options.debounceKey ?? userId,
      );
      if (acceptedId) return reference(run, false);

      await transaction.jobRun.delete({ where: { id: run.id } });
      const coalesced = await transaction.jobRun.findFirst({
        where: {
          userId,
          jobName: definition.name,
          jobVersion: definition.version,
          status: { in: ["PENDING", "RUNNING"] },
        },
        orderBy: { createdAt: "desc" },
      });
      if (coalesced) return reference(coalesced, true);
      throw new BackgroundJobError("CONFLICT");
    });
  } catch (cause) {
    const duplicate = await db().jobRun.findUnique({ where: { idempotencyKey } });
    if (duplicate) {
      compatible(duplicate);
      const owner = await db().user.findUnique({ where: { id: userId }, select: { deletionRequestedAt: true } });
      if (!owner || owner.deletionRequestedAt) throw new BackgroundJobError("AUTHORIZATION_ERROR");
      return reference(duplicate, true);
    }
    throw normalizeBackgroundJobError(cause);
  }
}
