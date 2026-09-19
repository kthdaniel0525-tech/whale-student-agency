CREATE TYPE "ReminderType" AS ENUM (
  'ASSIGNMENT_DUE',
  'ASSIGNMENT_OVERDUE',
  'EXAM_UPCOMING',
  'EXAM_TOMORROW',
  'STUDY_SESSION',
  'MISSED_STUDY_TASK',
  'STUDY_PLAN_BEHIND',
  'WEAK_TOPIC_BEFORE_EXAM',
  'DIAGNOSTIC_PRACTICE',
  'WORKFLOW_WAITING'
);

CREATE TYPE "ReminderStatus" AS ENUM (
  'SCHEDULED',
  'READY',
  'DELIVERED',
  'DISMISSED',
  'SNOOZED',
  'EXPIRED',
  'CANCELLED'
);

CREATE TYPE "ReminderSourceType" AS ENUM (
  'ASSIGNMENT',
  'EXAM',
  'STUDY_TASK',
  'STUDY_PLAN',
  'LEARNING_TOPIC',
  'WORKFLOW_RUN'
);

CREATE TYPE "ReminderActionTargetType" AS ENUM ('AGENT', 'WORKFLOW', 'RESOURCE');

CREATE TABLE "Reminder" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "type" "ReminderType" NOT NULL,
  "title" TEXT NOT NULL,
  "message" TEXT NOT NULL,
  "priority" "RecommendationPriority" NOT NULL,
  "priorityScore" INTEGER NOT NULL,
  "status" "ReminderStatus" NOT NULL DEFAULT 'SCHEDULED',
  "sourceType" "ReminderSourceType" NOT NULL,
  "sourceId" TEXT,
  "scheduledFor" TIMESTAMP(3) NOT NULL,
  "expiresAt" TIMESTAMP(3),
  "deliveredAt" TIMESTAMP(3),
  "dismissedAt" TIMESTAMP(3),
  "snoozedUntil" TIMESTAMP(3),
  "reasonCode" TEXT NOT NULL,
  "reasonData" JSONB NOT NULL,
  "actionTargetType" "ReminderActionTargetType",
  "actionTargetId" TEXT,
  "actionPayload" JSONB,
  "dedupeKey" TEXT NOT NULL,
  "supersessionKey" TEXT NOT NULL,
  "stateFingerprint" TEXT NOT NULL,
  "activeKey" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Reminder_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Reminder_priorityScore_check" CHECK ("priorityScore" BETWEEN 0 AND 100),
  CONSTRAINT "Reminder_action_target_pair_check" CHECK (
    ("actionTargetType" IS NULL AND "actionTargetId" IS NULL) OR
    ("actionTargetType" IS NOT NULL AND "actionTargetId" IS NOT NULL)
  ),
  CONSTRAINT "Reminder_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "Reminder_activeKey_key" ON "Reminder"("activeKey");
CREATE UNIQUE INDEX "Reminder_userId_dedupeKey_key" ON "Reminder"("userId", "dedupeKey");
CREATE INDEX "Reminder_userId_status_scheduledFor_priorityScore_idx" ON "Reminder"("userId", "status", "scheduledFor", "priorityScore");
CREATE INDEX "Reminder_userId_supersessionKey_status_idx" ON "Reminder"("userId", "supersessionKey", "status");
CREATE INDEX "Reminder_userId_sourceType_sourceId_idx" ON "Reminder"("userId", "sourceType", "sourceId");

CREATE TABLE "ReminderPreference" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "remindersEnabled" BOOLEAN NOT NULL DEFAULT true,
  "assignmentReminders" BOOLEAN NOT NULL DEFAULT true,
  "examReminders" BOOLEAN NOT NULL DEFAULT true,
  "studyReminders" BOOLEAN NOT NULL DEFAULT true,
  "workflowReminders" BOOLEAN NOT NULL DEFAULT true,
  "leadTimeMinutes" INTEGER NOT NULL DEFAULT 30,
  "quietHoursStart" INTEGER,
  "quietHoursEnd" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ReminderPreference_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ReminderPreference_leadTimeMinutes_check" CHECK ("leadTimeMinutes" BETWEEN 5 AND 1440),
  CONSTRAINT "ReminderPreference_quietHoursStart_check" CHECK ("quietHoursStart" IS NULL OR "quietHoursStart" BETWEEN 0 AND 1439),
  CONSTRAINT "ReminderPreference_quietHoursEnd_check" CHECK ("quietHoursEnd" IS NULL OR "quietHoursEnd" BETWEEN 0 AND 1439),
  CONSTRAINT "ReminderPreference_quiet_pair_check" CHECK (("quietHoursStart" IS NULL) = ("quietHoursEnd" IS NULL)),
  CONSTRAINT "ReminderPreference_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "ReminderPreference_userId_key" ON "ReminderPreference"("userId");
