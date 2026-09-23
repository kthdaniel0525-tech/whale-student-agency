CREATE TABLE "LearningProgressSnapshot" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "topicId" TEXT NOT NULL,
    "masteryScore" DOUBLE PRECISION NOT NULL,
    "confidenceScore" DOUBLE PRECISION NOT NULL,
    "recentAccuracy" DOUBLE PRECISION NOT NULL,
    "questionsAttempted" INTEGER NOT NULL,
    "trend" "LearningTrend" NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LearningProgressSnapshot_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "LearningProgressSnapshot_userId_topicId_recordedAt_idx"
ON "LearningProgressSnapshot"("userId", "topicId", "recordedAt");

CREATE INDEX "LearningProgressSnapshot_userId_courseId_recordedAt_idx"
ON "LearningProgressSnapshot"("userId", "courseId", "recordedAt");

ALTER TABLE "LearningProgressSnapshot"
ADD CONSTRAINT "LearningProgressSnapshot_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "LearningProgressSnapshot"
ADD CONSTRAINT "LearningProgressSnapshot_userId_courseId_topicId_fkey"
FOREIGN KEY ("userId", "courseId", "topicId")
REFERENCES "LearningTopic"("userId", "courseId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
