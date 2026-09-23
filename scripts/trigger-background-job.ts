import "dotenv/config";
import { db } from "../server/db/client";
import { createBackgroundJobBoss } from "../server/jobs/client";
import { enqueueRecommendationRefresh, enqueueReminderRefresh, enqueueNotificationDelivery } from "../server/jobs/enqueue";
import { REFRESH_USER_RECOMMENDATIONS_JOB } from "../server/jobs/refresh-recommendations";
import { REFRESH_USER_REMINDERS_JOB } from "../server/jobs/refresh-reminders";
import { ensureBackgroundJobQueues } from "../server/jobs/queue";
import {
  assertManualBackgroundJobTriggerAllowed,
  enqueueScheduledRecommendationCycle,
  enqueueNotificationDeliverySweep,
} from "../server/jobs/scheduled-enqueue";
import { REFRESH_ACTIVE_USER_RECOMMENDATIONS_JOB } from "../server/jobs/scheduled-recommendations";

assertManualBackgroundJobTriggerAllowed();

const [jobName, userId] = process.argv.slice(2);
const validUserRefresh = (
  jobName === REFRESH_USER_RECOMMENDATIONS_JOB ||
  jobName === REFRESH_USER_REMINDERS_JOB || jobName === "deliver-user-notifications"
) && Boolean(userId);
const validScheduledRefresh = [REFRESH_ACTIVE_USER_RECOMMENDATIONS_JOB, "deliver-ready-notifications"].includes(jobName) && !userId;
if (!validUserRefresh && !validScheduledRefresh) {
  throw new Error(
    "Usage: npm run jobs:trigger -- refresh-user-recommendations <userId>\n" +
    "   or: npm run jobs:trigger -- refresh-user-reminders <userId>\n" +
    "   or: npm run jobs:trigger -- deliver-user-notifications <userId>\n" +
    "   or: npm run jobs:trigger -- deliver-ready-notifications\n" +
    "   or: npm run jobs:trigger -- refresh-active-user-recommendations",
  );
}

const boss = createBackgroundJobBoss("worker");
try {
  await boss.start();
  await ensureBackgroundJobQueues(boss);
  const run = validScheduledRefresh
    ? await (jobName === "deliver-ready-notifications" ? enqueueNotificationDeliverySweep : enqueueScheduledRecommendationCycle)({
      idempotencyKey: `development:${jobName}:${Date.now()}`,
      sourceEvent: "DEVELOPMENT_TRIGGER",
    }, { publisher: boss })
    : await (jobName === "deliver-user-notifications" ? enqueueNotificationDelivery : jobName === REFRESH_USER_REMINDERS_JOB
      ? enqueueReminderRefresh
      : enqueueRecommendationRefresh)(userId!, {
      idempotencyKey: `development:${jobName}:${userId}:${Date.now()}`,
      sourceEvent: "DEVELOPMENT_TRIGGER",
    }, { publisher: boss });
  console.info(`Enqueued ${jobName} as JobRun ${run.id}.`);
} finally {
  await boss.stop({ graceful: true, timeout: 5000 });
  await db().$disconnect();
}
