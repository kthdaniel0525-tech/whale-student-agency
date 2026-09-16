CREATE TABLE "AdaptiveOutcome" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "agentId" TEXT NOT NULL,
  "courseId" TEXT,
  "topicId" TEXT,
  "strategyKey" TEXT NOT NULL,
  "strategy" JSONB NOT NULL,
  "outcomeType" TEXT NOT NULL,
  "score" DOUBLE PRECISION,
  "successful" BOOLEAN,
  "action" TEXT,
  "evidenceKey" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AdaptiveOutcome_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AdaptiveOutcome_userId_evidenceKey_key"
  ON "AdaptiveOutcome"("userId", "evidenceKey");
CREATE INDEX "AdaptiveOutcome_userId_agentId_createdAt_idx"
  ON "AdaptiveOutcome"("userId", "agentId", "createdAt");
CREATE INDEX "AdaptiveOutcome_userId_agentId_topicId_createdAt_idx"
  ON "AdaptiveOutcome"("userId", "agentId", "topicId", "createdAt");
CREATE INDEX "AdaptiveOutcome_userId_courseId_createdAt_idx"
  ON "AdaptiveOutcome"("userId", "courseId", "createdAt");

ALTER TABLE "AdaptiveOutcome" ADD CONSTRAINT "AdaptiveOutcome_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
