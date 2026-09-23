import "server-only";
import { operationsConfig } from "../operations/config";
import { safeFields } from "../operations/monitoring";
import type { BackgroundJobErrorCode } from "./errors";

export interface BackgroundJobLogEntry {
  readonly event:
    | "started"
    | "completed"
    | "retry-scheduled"
    | "failed"
    | "worker-error"
    | "worker-warning";
  readonly jobName?: string;
  readonly jobRunId?: string;
  readonly userId?: string | null;
  readonly resourceId?: string | null;
  readonly attempt?: number;
  readonly durationMs?: number;
  readonly status?: string;
  readonly errorCode?: BackgroundJobErrorCode;
}

export type BackgroundJobLogger = Pick<Console, "info" | "error">;

export function logBackgroundJob(
  entry: BackgroundJobLogEntry,
  logger: BackgroundJobLogger = console,
): void {
  const method = ["failed", "worker-error"].includes(entry.event)
    ? "error"
    : "info";
  logger[method](JSON.stringify({
    scope: "background-job",
    timestamp: new Date().toISOString(),
    release: operationsConfig().RELEASE_SHA,
    ...safeFields({ ...entry, backgroundJobId: entry.jobRunId }),
    jobRunId: entry.jobRunId,
    ...(entry.userId && /^[A-Za-z0-9_-]{1,100}$/.test(entry.userId) ? { userId: entry.userId } : {}),
    attempt: entry.attempt,
  }));
}
