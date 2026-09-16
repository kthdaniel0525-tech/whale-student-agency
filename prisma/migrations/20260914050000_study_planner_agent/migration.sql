CREATE TYPE "StudyPlanStatus" AS ENUM ('ACTIVE', 'COMPLETED', 'ARCHIVED');
CREATE TYPE "StudyTaskStatus" AS ENUM ('PLANNED', 'IN_PROGRESS', 'COMPLETED', 'SKIPPED');
CREATE TYPE "StudyActivityType" AS ENUM ('LEARN', 'REVIEW', 'PRACTICE', 'QUIZ', 'ASSIGNMENT', 'EXAM_REVIEW', 'NOTES_REVIEW', 'MIXED_PRACTICE');

CREATE TABLE "StudyPlan" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "startDate" TIMESTAMP(3) NOT NULL,
  "endDate" TIMESTAMP(3) NOT NULL,
  "summary" TEXT NOT NULL,
  "assumptions" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "totalPlannedMinutes" INTEGER NOT NULL DEFAULT 0,
  "status" "StudyPlanStatus" NOT NULL DEFAULT 'ACTIVE',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "StudyPlan_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "StudyTask" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "studyPlanId" TEXT NOT NULL,
  "courseId" TEXT,
  "topicId" TEXT,
  "examId" TEXT,
  "assignmentId" TEXT,
  "date" TIMESTAMP(3) NOT NULL,
  "title" TEXT NOT NULL,
  "topic" TEXT,
  "activityType" "StudyActivityType" NOT NULL,
  "durationMinutes" INTEGER NOT NULL,
  "priority" INTEGER NOT NULL,
  "status" "StudyTaskStatus" NOT NULL DEFAULT 'PLANNED',
  "reason" TEXT NOT NULL,
  "sourceDueDate" TIMESTAMP(3),
  "sourceMasteryScore" DOUBLE PRECISION,
  "sourceConfidenceScore" DOUBLE PRECISION,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "StudyTask_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "StudyPlan_id_userId_key" ON "StudyPlan"("id", "userId");
CREATE INDEX "StudyPlan_userId_status_startDate_endDate_idx" ON "StudyPlan"("userId", "status", "startDate", "endDate");
CREATE INDEX "StudyTask_studyPlanId_userId_date_status_idx" ON "StudyTask"("studyPlanId", "userId", "date", "status");
CREATE INDEX "StudyTask_userId_date_status_idx" ON "StudyTask"("userId", "date", "status");
CREATE INDEX "StudyTask_courseId_date_idx" ON "StudyTask"("courseId", "date");
CREATE INDEX "StudyTask_topicId_idx" ON "StudyTask"("topicId");
CREATE INDEX "StudyTask_examId_idx" ON "StudyTask"("examId");
CREATE INDEX "StudyTask_assignmentId_idx" ON "StudyTask"("assignmentId");

ALTER TABLE "StudyPlan" ADD CONSTRAINT "StudyPlan_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "StudyTask" ADD CONSTRAINT "StudyTask_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StudyTask" ADD CONSTRAINT "StudyTask_studyPlanId_userId_fkey"
FOREIGN KEY ("studyPlanId", "userId") REFERENCES "StudyPlan"("id", "userId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StudyTask" ADD CONSTRAINT "StudyTask_courseId_fkey"
FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "StudyTask" ADD CONSTRAINT "StudyTask_topicId_fkey"
FOREIGN KEY ("topicId") REFERENCES "LearningTopic"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "StudyTask" ADD CONSTRAINT "StudyTask_examId_fkey"
FOREIGN KEY ("examId") REFERENCES "Exam"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "StudyTask" ADD CONSTRAINT "StudyTask_assignmentId_fkey"
FOREIGN KEY ("assignmentId") REFERENCES "Assignment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "StudyPlan" ADD CONSTRAINT "StudyPlan_title_check"
CHECK (char_length("title") BETWEEN 1 AND 200);
ALTER TABLE "StudyPlan" ADD CONSTRAINT "StudyPlan_summary_check"
CHECK (char_length("summary") BETWEEN 1 AND 2000);
ALTER TABLE "StudyPlan" ADD CONSTRAINT "StudyPlan_assumptions_check"
CHECK (cardinality("assumptions") <= 10);
ALTER TABLE "StudyPlan" ADD CONSTRAINT "StudyPlan_dates_check"
CHECK ("startDate" <= "endDate");
ALTER TABLE "StudyPlan" ADD CONSTRAINT "StudyPlan_minutes_check"
CHECK ("totalPlannedMinutes" >= 0);

ALTER TABLE "StudyTask" ADD CONSTRAINT "StudyTask_title_check"
CHECK (char_length("title") BETWEEN 1 AND 200);
ALTER TABLE "StudyTask" ADD CONSTRAINT "StudyTask_topic_check"
CHECK ("topic" IS NULL OR char_length("topic") BETWEEN 1 AND 160);
ALTER TABLE "StudyTask" ADD CONSTRAINT "StudyTask_duration_check"
CHECK ("durationMinutes" BETWEEN 15 AND 180);
ALTER TABLE "StudyTask" ADD CONSTRAINT "StudyTask_priority_check"
CHECK ("priority" BETWEEN 0 AND 100);
ALTER TABLE "StudyTask" ADD CONSTRAINT "StudyTask_reason_check"
CHECK (char_length("reason") BETWEEN 1 AND 500);
ALTER TABLE "StudyTask" ADD CONSTRAINT "StudyTask_source_scores_check"
CHECK (
  ("sourceMasteryScore" IS NULL OR "sourceMasteryScore" BETWEEN 0 AND 100)
  AND
  ("sourceConfidenceScore" IS NULL OR "sourceConfidenceScore" BETWEEN 0 AND 100)
);
