CREATE TYPE "RecommendationType" AS ENUM (
  'EXAM_PREPARATION',
  'ASSIGNMENT_DEADLINE',
  'WEAK_TOPIC',
  'DIAGNOSTIC_PRACTICE',
  'STUDY_PLAN',
  'MISSED_STUDY_TASK',
  'COURSE_INACTIVITY',
  'LECTURE_STUDY',
  'CAREER_PREPARATION'
);

CREATE TYPE "RecommendationPriority" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');
CREATE TYPE "RecommendationStatus" AS ENUM ('ACTIVE', 'COMPLETED', 'DISMISSED', 'EXPIRED');
CREATE TYPE "RecommendationSourceType" AS ENUM (
  'EXAM',
  'ASSIGNMENT',
  'LEARNING_TOPIC',
  'STUDY_PLAN',
  'STUDY_TASK',
  'COURSE',
  'DOCUMENT',
  'CAREER_PLAN'
);

CREATE TABLE "Recommendation" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "type" "RecommendationType" NOT NULL,
  "title" TEXT NOT NULL,
  "message" TEXT NOT NULL,
  "priority" "RecommendationPriority" NOT NULL,
  "priorityScore" INTEGER NOT NULL,
  "status" "RecommendationStatus" NOT NULL DEFAULT 'ACTIVE',
  "sourceType" "RecommendationSourceType" NOT NULL,
  "sourceId" TEXT,
  "recommendedAgentId" TEXT,
  "recommendedWorkflowId" TEXT,
  "actionPayload" JSONB,
  "reasonCode" TEXT NOT NULL,
  "reasonData" JSONB NOT NULL,
  "dedupeKey" TEXT NOT NULL,
  "supersessionKey" TEXT NOT NULL,
  "stateFingerprint" TEXT NOT NULL,
  "activeKey" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "expiresAt" TIMESTAMP(3),
  "dismissedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  CONSTRAINT "Recommendation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Recommendation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "Recommendation_activeKey_key" ON "Recommendation"("activeKey");
CREATE INDEX "Recommendation_userId_status_priorityScore_updatedAt_idx" ON "Recommendation"("userId", "status", "priorityScore", "updatedAt");
CREATE INDEX "Recommendation_userId_supersessionKey_status_idx" ON "Recommendation"("userId", "supersessionKey", "status");
CREATE INDEX "Recommendation_userId_sourceType_sourceId_idx" ON "Recommendation"("userId", "sourceType", "sourceId");
CREATE INDEX "Recommendation_userId_dedupeKey_createdAt_idx" ON "Recommendation"("userId", "dedupeKey", "createdAt");
