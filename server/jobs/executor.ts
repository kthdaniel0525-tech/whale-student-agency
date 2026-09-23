import { reportError } from "../operations/monitoring";
import { assertActiveUser } from "../privacy/account-state";
import { canRunBackgroundFeature } from "../entitlements/resources";
import "server-only";
import { withAIUsageContext } from "../ai/usage/context";
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
  const existing = await db().jobRun.findUnique({ where: { queueJobId: job.id } });
  if (existing) return existing;
  // User jobs require a server-created, owner-bound tracking row. Only registered
  // system schedules can materialize an untracked delivery.
  if (definition.executionScope !== "system") throw new BackgroundJobError("AUTHORIZATION_ERROR");
  try {
    return await db().jobRun.create({ data: { queueJobId: job.id, idempotencyKey: `external:${job.id}`,
      jobName: definition.name, jobVersion: definition.version } });
  } catch (error) {
    // Simultaneous schedule delivery can race on the unique queue ID. Re-read
    // that ID only; an unrelated idempotency-key collision never grants access.
    if (error instanceof Error && "code" in error && error.code === "P2002") {
      const concurrent = await db().jobRun.findUnique({ where: { queueJobId: job.id } });
      if (concurrent) return concurrent;
    }
    throw error;
  }
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
  let run: Awaited<ReturnType<typeof ensureJobRun>>;
  try { run = await ensureJobRun(job, definition); }
  catch (cause) { const error = normalizeBackgroundJobError(cause); return { id: job.id, status: "deadletter", output: { errorCode: error.code, retryable: error.retryable, attempt } }; }
  const identity = safeIdentity(job.data);
  const priorMetadata = safeMetadata(run.metadata);
  let ownsClaim = false;
  const claimTime = new Date(started);
  const claimIdentity = { id: run.id, queueJobId: job.id, status: "RUNNING" as const, attempt, startedAt: claimTime };

  try {
    const invalidRun = job.name !== definition.name || run.jobName !== definition.name ||
      run.jobVersion !== definition.version || !Number.isSafeInteger(job.retryCount) || job.retryCount < 0 || job.retryCount > job.retryLimit ||
      !Number.isSafeInteger(job.retryLimit) || job.retryLimit < 0 || job.retryLimit > definition.retryPolicy.limit;
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
    if (["COMPLETED", "CANCELLED", "FAILED"].includes(run.status)) return { id: job.id, status: "completed", output: { skipped: true } };
    if (run.userId) await assertActiveUser(run.userId);
    const claimed = await db().jobRun.updateMany({
      where: { id: run.id, queueJobId: job.id,
        ...(run.userId ? { user: { deletionRequestedAt: null } } : {}),
        OR: [
          { status: "PENDING", attempt: { lt: attempt } },
          // Recover a crashed/expired delivery only after its execution budget.
          { status: "RUNNING", attempt: { lte: attempt }, startedAt: { lte: new Date(started - definition.timeoutSeconds * 1000) } },
        ],
      },
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
    if (!claimed.count) return { id: job.id, status: "completed", output: { skipped: true } };
    ownsClaim = true;
    const payload = definition.payloadSchema.parse(job.data);
    job.signal.throwIfAborted();
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

    const allowed = !run.userId || await canRunBackgroundFeature(run.userId, definition.name);
    const result = !allowed ? { skipped: true, reason: "ENTITLEMENT_REQUIRED" } : await withAIUsageContext({ ...(run.userId ? { userId: run.userId } : {}), requestId: `job:${run.id}`, parentRequestId: typeof priorMetadata.requestId === "string" ? priorMetadata.requestId : undefined, backgroundJobId: run.id, guardFeature: definition.name, guardProfile: "BACKGROUND" }, () => definition.handler({
      payload,
      signal: job.signal,
      attempt,
      jobRunId: run.id,
    }));
    const durationMs = Date.now() - started;
    const published = await db().jobRun.updateMany({
      where: claimIdentity,
      data: {
        status: "COMPLETED",
        completedAt: new Date(),
        failedAt: null,
        errorCode: null,
        metadata: { ...priorMetadata, queue: job.name, durationMs, ...result },
      },
    });
    if (!published.count) return { id: job.id, status: "completed", output: { skipped: true } };
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
    reportError(cause, { backgroundJobId: run.id, jobName: definition.name, requestId: typeof priorMetadata.requestId === "string" ? priorMetadata.requestId : `job:${run.id}`, errorCode: error.code });
    const exhausted = !error.retryable || job.retryCount >= job.retryLimit;
    const durationMs = Date.now() - started;
    // Invalid identity/payload replays and stale workers must not rewrite another
    // worker's tracking row or revive a cancelled/deleted account's job.
    const published = ownsClaim ? await db().jobRun.updateMany({
      where: claimIdentity,
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
    }) : null;
    if (ownsClaim && !published?.count) return { id: job.id, status: "completed", output: { skipped: true } };
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
