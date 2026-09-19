import "server-only";
import type { JobResult, JobWithMetadata } from "pg-boss";
import { db } from "../db/client";
import {
  BackgroundJobError,
  normalizeBackgroundJobError,
} from "./errors";
import {
  logBackgroundJob,
  type BackgroundJobLogger,
} from "./logging";
import { recordBackgroundJobMetric } from "./metrics";
import type { BackgroundJob } from "./types";

type QueueJob = Pick<
  JobWithMetadata<unknown>,
  "id" | "name" | "data" | "retryCount" | "retryLimit" | "signal"
>;

async function ensureJobRun<Payload extends object>(
  job: QueueJob,
  definition: BackgroundJob<Payload>,
) {
  return db().jobRun.upsert({
    where: { queueJobId: job.id },
    create: {
      queueJobId: job.id,
      idempotencyKey: `external:${job.id}`,
      jobName: definition.name,
      jobVersion: definition.version,
    },
    update: {},
  });
}

function safeIdentity(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  return {
    trackingId: typeof input.trackingId === "string" ? input.trackingId : null,
    userId: typeof input.userId === "string" ? input.userId : null,
  };
}

function safeMetadata(value: unknown): Record<string, string | number | boolean | null> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string | number | boolean | null] =>
    entry[1] === null || ["string", "number", "boolean"].includes(typeof entry[1]),
  ));
}

export async function executeBackgroundJob<Payload extends object>(
  definition: BackgroundJob<Payload>,
  job: QueueJob,
  options: { logger?: BackgroundJobLogger } = {},
): Promise<JobResult> {
  const logger = options.logger ?? console;
  const started = Date.now();
  const attempt = job.retryCount + 1;
  const run = await ensureJobRun(job, definition);
  const identity = safeIdentity(job.data);
  const priorMetadata = safeMetadata(run.metadata);

  await db().jobRun.updateMany({
    where: { id: run.id, queueJobId: job.id },
    data: {
      status: "RUNNING",
      attempt,
      startedAt: new Date(started),
      completedAt: null,
      failedAt: null,
      errorCode: null,
      metadata: { ...priorMetadata, queue: job.name },
    },
  });
  recordBackgroundJobMetric("started");
  logBackgroundJob({
    event: "started",
    jobName: definition.name,
    jobRunId: run.id,
    userId: run.userId,
    resourceId: run.resourceId,
    attempt,
    status: "running",
  }, logger);

  try {
    const payload = definition.payloadSchema.parse(job.data);
    const invalidRun = run.jobName !== definition.name ||
      run.jobVersion !== definition.version;
    const invalidUserIdentity = definition.executionScope === "user" && (
      identity?.trackingId !== run.id || identity.userId !== run.userId
    );
    const invalidSystemIdentity = definition.executionScope === "system" && (
      run.userId !== null ||
      (identity?.trackingId !== null && identity?.trackingId !== run.id)
    );
    if (invalidRun || invalidUserIdentity || invalidSystemIdentity) {
      throw new BackgroundJobError("AUTHORIZATION_ERROR");
    }
    const result = await definition.handler({
      payload,
      signal: job.signal,
      attempt,
      jobRunId: run.id,
    });
    const durationMs = Date.now() - started;
    await db().jobRun.updateMany({
      where: { id: run.id, queueJobId: job.id },
      data: {
        status: "COMPLETED",
        completedAt: new Date(),
        failedAt: null,
        errorCode: null,
        metadata: { ...priorMetadata, queue: job.name, durationMs, ...result },
      },
    });
    recordBackgroundJobMetric("completed", durationMs);
    logBackgroundJob({
      event: "completed",
      jobName: definition.name,
      jobRunId: run.id,
      userId: run.userId,
      resourceId: run.resourceId,
      attempt,
      durationMs,
      status: "completed",
    }, logger);
    return { id: job.id, status: "completed", output: result };
  } catch (cause) {
    const error = normalizeBackgroundJobError(cause, job.signal);
    const exhausted = !error.retryable || job.retryCount >= job.retryLimit;
    const durationMs = Date.now() - started;
    await db().jobRun.updateMany({
      where: { id: run.id, queueJobId: job.id },
      data: {
        status: exhausted ? "FAILED" : "PENDING",
        failedAt: exhausted ? new Date() : null,
        errorCode: error.code,
        metadata: {
          ...priorMetadata,
          queue: job.name,
          durationMs,
          retryable: error.retryable,
          exhausted,
        },
      },
    });
    recordBackgroundJobMetric("failed", durationMs);
    if (!exhausted) recordBackgroundJobMetric("retry");
    logBackgroundJob({
      event: exhausted ? "failed" : "retry-scheduled",
      jobName: definition.name,
      jobRunId: run.id,
      userId: run.userId,
      resourceId: run.resourceId,
      attempt,
      durationMs,
      status: exhausted ? "failed" : "pending",
      errorCode: error.code,
    }, logger);
    return {
      id: job.id,
      status: exhausted ? "deadletter" : "failed",
      output: {
        errorCode: error.code,
        retryable: error.retryable,
        attempt,
      },
    };
  }
}
