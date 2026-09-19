import "server-only";
import type { PgBoss } from "pg-boss";
import { getBackgroundJobConfig } from "./config";
import { executeBackgroundJob } from "./executor";
import { logBackgroundJob } from "./logging";
import { BACKGROUND_JOBS } from "./registry";
import type { BackgroundJob, BackgroundJobRetryPolicy } from "./types";

type QueueDefinition = {
  readonly retryPolicy: BackgroundJobRetryPolicy;
  readonly timeoutSeconds: number;
};

function queueOptions(definition: QueueDefinition) {
  const config = getBackgroundJobConfig();
  return {
    retryLimit: definition.retryPolicy.limit,
    retryDelay: definition.retryPolicy.delaySeconds,
    retryBackoff: definition.retryPolicy.exponentialBackoff,
    retryDelayMax: definition.retryPolicy.maximumDelaySeconds,
    expireInSeconds: definition.timeoutSeconds,
    retentionSeconds: config.pendingRetentionSeconds,
    deleteAfterSeconds: config.completedRetentionSeconds,
    deadLetter: config.deadLetterQueue,
    warningQueueSize: 500,
    notify: true,
  } as const;
}

export async function ensureBackgroundJobQueues(
  boss: PgBoss,
): Promise<void> {
  const config = getBackgroundJobConfig();
  if (!(await boss.getQueue(config.deadLetterQueue))) {
    await boss.createQueue(config.deadLetterQueue, {
      retryLimit: 0,
      expireInSeconds: 30,
      retentionSeconds: config.pendingRetentionSeconds,
      deleteAfterSeconds: config.completedRetentionSeconds,
      warningQueueSize: 100,
    });
  }
  for (const definition of BACKGROUND_JOBS) {
    const options = queueOptions(definition);
    if (await boss.getQueue(definition.name))
      await boss.updateQueue(definition.name, options);
    else await boss.createQueue(definition.name, options);
  }
}

export async function registerBackgroundJobWorkers(
  boss: PgBoss,
): Promise<void> {
  const config = getBackgroundJobConfig();
  for (const definition of BACKGROUND_JOBS) {
    await boss.work(
      definition.name,
      {
        includeMetadata: true,
        perJobResults: true,
        batchSize: 1,
        pollingIntervalSeconds: 2,
        notifyPollingIntervalSeconds: 30,
        localConcurrency: config.workerConcurrency,
        groupConcurrency: definition.concurrency.limit,
      },
      async (jobs) => Promise.all(
        jobs.map((job) => executeBackgroundJob(
          definition as unknown as BackgroundJob<Record<string, unknown>>,
          job,
        )),
      ),
    );
  }
}

export function observeBackgroundJobBoss(boss: PgBoss): void {
  boss.on("error", (error) => logBackgroundJob({
    event: "worker-error",
    status: error.name,
  }));
  boss.on("warning", (warning) => logBackgroundJob({
    event: "worker-warning",
    status: warning.message,
  }));
}
