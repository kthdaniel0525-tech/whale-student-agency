import "server-only";

type JobMetrics = {
  started: number;
  completed: number;
  failed: number;
  retries: number;
  totalDurationMs: number;
};

const metrics: JobMetrics = {
  started: 0,
  completed: 0,
  failed: 0,
  retries: 0,
  totalDurationMs: 0,
};

export function recordBackgroundJobMetric(
  event: "started" | "completed" | "failed" | "retry",
  durationMs = 0,
): void {
  if (event === "started") metrics.started++;
  if (event === "completed") metrics.completed++;
  if (event === "failed") metrics.failed++;
  if (event === "retry") metrics.retries++;
  if (event === "completed" || event === "failed")
    metrics.totalDurationMs += Math.max(0, durationMs);
}

export function getBackgroundJobMetrics() {
  const finished = metrics.completed + metrics.failed;
  return {
    ...metrics,
    averageDurationMs: finished
      ? Math.round(metrics.totalDurationMs / finished)
      : 0,
  };
}

export function resetBackgroundJobMetricsForTests(): void {
  metrics.started = 0;
  metrics.completed = 0;
  metrics.failed = 0;
  metrics.retries = 0;
  metrics.totalDurationMs = 0;
}
