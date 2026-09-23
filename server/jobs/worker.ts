import "server-only";
import type { PgBoss } from "pg-boss";
import { createBackgroundJobBoss } from "./client";
import {
  ensureBackgroundJobQueues,
  observeBackgroundJobBoss,
  registerBackgroundJobWorkers,
} from "./queue";
import { registerAccountDeletionSchedule, registerBillingReconciliationSchedule, registerRecommendationRefreshSchedule, registerNotificationDeliverySchedule, registerOAuthCleanupSchedule, registerCalendarSyncSchedule, registerAcademicSyncSchedule } from "./schedule";

export async function startBackgroundJobWorker(
  boss: PgBoss = createBackgroundJobBoss("worker"),
): Promise<PgBoss> {
  observeBackgroundJobBoss(boss);
  await boss.start();
  await ensureBackgroundJobQueues(boss);
  await registerBackgroundJobWorkers(boss);
  await registerRecommendationRefreshSchedule(boss);
  await registerNotificationDeliverySchedule(boss);
  await registerOAuthCleanupSchedule(boss);
  await registerCalendarSyncSchedule(boss);
  await registerAcademicSyncSchedule(boss);
  await registerBillingReconciliationSchedule(boss);
  await registerAccountDeletionSchedule(boss);
  return boss;
}

export function stopBackgroundJobWorker(boss: PgBoss): Promise<void> {
  return boss.stop({ graceful: true, timeout: 25_000 });
}
