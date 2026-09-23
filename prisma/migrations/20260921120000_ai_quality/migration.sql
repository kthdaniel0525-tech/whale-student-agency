-- AlterTable
ALTER TABLE "AIUsageRecord" ADD COLUMN     "contextVersion" TEXT,
ADD COLUMN     "promptVersion" TEXT,
ADD COLUMN     "routingVersion" TEXT;

-- AlterTable
ALTER TABLE "ConversationMessage" ADD COLUMN     "requestId" TEXT;

-- AlterTable
ALTER TABLE "Profile" ADD COLUMN     "aiEvaluationConsentAt" TIMESTAMP(3),
ADD COLUMN     "aiEvaluationConsentVersion" TEXT;

-- CreateTable
CREATE TABLE "AIEvaluationRecord" (
    "id" TEXT NOT NULL,
    "deduplicationKey" TEXT NOT NULL,
    "userId" TEXT,
    "requestId" TEXT,
    "usageRecordId" TEXT,
    "messageId" TEXT,
    "feedbackId" TEXT,
    "agentId" TEXT,
    "workflowId" TEXT,
    "profile" TEXT NOT NULL,
    "evaluationType" TEXT NOT NULL,
    "evaluatorVersion" TEXT NOT NULL,
    "datasetVersion" TEXT NOT NULL,
    "promptVersion" TEXT NOT NULL,
    "routingVersion" TEXT NOT NULL,
    "contextVersion" TEXT NOT NULL,
    "model" TEXT,
    "provider" TEXT,
    "selectedTier" TEXT,
    "fallbackUsed" BOOLEAN,
    "judgeModel" TEXT,
    "score" DOUBLE PRECISION,
    "passed" BOOLEAN,
    "dimensions" JSONB NOT NULL,
    "failures" TEXT[],
    "unmeasured" TEXT[],
    "metrics" JSONB NOT NULL,
    "checks" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AIEvaluationRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AIUserFeedback" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "requestId" TEXT,
    "usageRecordId" TEXT,
    "agentId" TEXT,
    "workflowId" TEXT,
    "rating" INTEGER NOT NULL,
    "reasonCode" TEXT,
    "comment" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AIUserFeedback_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AIEvaluationRecord_deduplicationKey_key" ON "AIEvaluationRecord"("deduplicationKey");

-- CreateIndex
CREATE INDEX "AIEvaluationRecord_userId_createdAt_idx" ON "AIEvaluationRecord"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "AIEvaluationRecord_profile_evaluationType_createdAt_idx" ON "AIEvaluationRecord"("profile", "evaluationType", "createdAt");

-- CreateIndex
CREATE INDEX "AIEvaluationRecord_usageRecordId_idx" ON "AIEvaluationRecord"("usageRecordId");

-- CreateIndex
CREATE INDEX "AIEvaluationRecord_userId_requestId_idx" ON "AIEvaluationRecord"("userId", "requestId");

-- CreateIndex
CREATE INDEX "AIEvaluationRecord_feedbackId_idx" ON "AIEvaluationRecord"("feedbackId");

-- CreateIndex
CREATE INDEX "AIUserFeedback_userId_createdAt_idx" ON "AIUserFeedback"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "AIUserFeedback_usageRecordId_idx" ON "AIUserFeedback"("usageRecordId");

-- CreateIndex
CREATE UNIQUE INDEX "AIUserFeedback_userId_messageId_key" ON "AIUserFeedback"("userId", "messageId");

-- AddForeignKey
ALTER TABLE "AIEvaluationRecord" ADD CONSTRAINT "AIEvaluationRecord_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AIUserFeedback" ADD CONSTRAINT "AIUserFeedback_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AIUserFeedback" ADD CONSTRAINT "AIUserFeedback_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "ConversationMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AIEvaluationRecord" ADD CONSTRAINT "evaluation_score_range" CHECK ("score" IS NULL OR ("score" >= 0 AND "score" <= 1));
ALTER TABLE "AIUserFeedback" ADD CONSTRAINT "feedback_rating" CHECK ("rating" IN (-1, 1));
