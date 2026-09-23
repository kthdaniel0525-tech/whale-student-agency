CREATE TYPE "NotificationFrequency" AS ENUM ('AS_READY', 'HOURLY');
ALTER TABLE "ReminderPreference"
  ADD COLUMN "proactiveRecommendationsEnabled" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "quietHoursEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "notificationFrequency" "NotificationFrequency" NOT NULL DEFAULT 'AS_READY';
ALTER TABLE "Reminder" ADD COLUMN "preferenceSuppressedAt" TIMESTAMP(3);
UPDATE "ReminderPreference" SET "quietHoursEnabled" = true
WHERE "quietHoursStart" IS NOT NULL AND "quietHoursEnd" IS NOT NULL AND "quietHoursStart" <> "quietHoursEnd";
-- Quiet hours now belong to the delivery boundary. Preserve intentional snoozes.
UPDATE "Reminder" SET "scheduledFor" = ("reasonData"->>'originalScheduledFor')::timestamptz,
  "status" = CASE WHEN ("reasonData"->>'originalScheduledFor')::timestamptz <= NOW()
    THEN 'READY'::"ReminderStatus" ELSE 'SCHEDULED'::"ReminderStatus" END,
  "reasonData" = "reasonData" - 'quietHoursDeferred' - 'originalScheduledFor'
WHERE "status" IN ('READY', 'SCHEDULED')
  AND "reasonData"->>'quietHoursDeferred' = 'true'
  AND "reasonData"->>'originalScheduledFor' IS NOT NULL;
