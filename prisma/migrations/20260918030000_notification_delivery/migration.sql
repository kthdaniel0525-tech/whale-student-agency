CREATE TYPE "NotificationChannelType" AS ENUM ('IN_APP', 'EMAIL', 'PUSH', 'SMS');
CREATE TYPE "NotificationStatus" AS ENUM ('PENDING', 'DELIVERED', 'READ', 'DISMISSED', 'FAILED');
ALTER TABLE "ReminderPreference" ADD COLUMN "inAppEnabled" BOOLEAN NOT NULL DEFAULT true;
CREATE TABLE "Notification" (
 "id" TEXT NOT NULL PRIMARY KEY, "userId" TEXT NOT NULL, "reminderId" TEXT,
 "channel" "NotificationChannelType" NOT NULL DEFAULT 'IN_APP', "type" "ReminderType" NOT NULL,
 "title" TEXT NOT NULL, "message" TEXT NOT NULL, "priority" "RecommendationPriority" NOT NULL,
 "status" "NotificationStatus" NOT NULL DEFAULT 'PENDING',
 "actionTargetType" "ReminderActionTargetType", "actionTargetId" TEXT, "actionPayload" JSONB,
 "scheduledFor" TIMESTAMP(3) NOT NULL, "deliveredAt" TIMESTAMP(3), "readAt" TIMESTAMP(3), "dismissedAt" TIMESTAMP(3),
 "deliveryCount" INTEGER NOT NULL DEFAULT 0, "failedAttempts" INTEGER NOT NULL DEFAULT 0,
 "lastErrorCode" TEXT, "deliveryLatencyMs" INTEGER,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
 CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
 CONSTRAINT "Notification_reminderId_fkey" FOREIGN KEY ("reminderId") REFERENCES "Reminder"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "Notification_reminderId_channel_key" ON "Notification"("reminderId", "channel");
CREATE INDEX "Notification_userId_channel_status_deliveredAt_id_idx" ON "Notification"("userId", "channel", "status", "deliveredAt", "id");
CREATE INDEX "Notification_userId_channel_deliveredAt_id_idx" ON "Notification"("userId", "channel", "deliveredAt", "id");
CREATE INDEX "Reminder_status_scheduledFor_userId_idx" ON "Reminder"("status", "scheduledFor", "userId");
