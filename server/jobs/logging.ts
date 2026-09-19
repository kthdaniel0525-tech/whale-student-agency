import "server-only";
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
    ...entry,
  }));
}
