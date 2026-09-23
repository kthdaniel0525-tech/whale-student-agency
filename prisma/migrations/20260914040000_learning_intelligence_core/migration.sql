CREATE TYPE "LearningTrend" AS ENUM ('IMPROVING', 'STABLE', 'DECLINING', 'INSUFFICIENT_DATA');
CREATE TYPE "QuizEvaluationMethod" AS ENUM ('DETERMINISTIC', 'SEMANTIC');

ALTER TABLE "QuizQuestion"
ADD COLUMN "topicNames" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

CREATE TABLE "LearningTopic" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "courseId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "normalizedName" TEXT NOT NULL,
  "description" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "LearningTopic_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "QuizQuestionTopic" (
  "questionId" TEXT NOT NULL,
  "topicId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "courseId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "QuizQuestionTopic_pkey" PRIMARY KEY ("questionId", "topicId")
);

CREATE TABLE "QuizAttempt" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "quizId" TEXT NOT NULL,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "QuizAttempt_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "QuestionAttempt" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "quizId" TEXT NOT NULL,
  "quizAttemptId" TEXT NOT NULL,
  "questionId" TEXT NOT NULL,
  "userAnswer" TEXT NOT NULL,
  "score" DOUBLE PRECISION NOT NULL,
  "isCorrect" BOOLEAN NOT NULL,
  "evaluationMethod" "QuizEvaluationMethod" NOT NULL,
  "attemptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "QuestionAttempt_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "LearningProgress" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "courseId" TEXT NOT NULL,
  "topicId" TEXT NOT NULL,
  "masteryScore" DOUBLE PRECISION NOT NULL DEFAULT 50,
  "confidenceScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "questionsAttempted" INTEGER NOT NULL DEFAULT 0,
  "correctAnswers" INTEGER NOT NULL DEFAULT 0,
  "incorrectAnswers" INTEGER NOT NULL DEFAULT 0,
  "scoreTotal" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "difficultyWeightedScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "difficultyWeightTotal" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "practiceSessions" INTEGER NOT NULL DEFAULT 0,
  "easyAttempts" INTEGER NOT NULL DEFAULT 0,
  "mediumAttempts" INTEGER NOT NULL DEFAULT 0,
  "hardAttempts" INTEGER NOT NULL DEFAULT 0,
  "recentAccuracy" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "firstPracticedAt" TIMESTAMP(3),
  "lastPracticedAt" TIMESTAMP(3),
  "trend" "LearningTrend" NOT NULL DEFAULT 'INSUFFICIENT_DATA',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "LearningProgress_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "QuizQuestion_id_userId_key" ON "QuizQuestion"("id", "userId");
CREATE UNIQUE INDEX "QuizQuestion_id_quizId_userId_key" ON "QuizQuestion"("id", "quizId", "userId");

CREATE UNIQUE INDEX "LearningTopic_userId_courseId_id_key" ON "LearningTopic"("userId", "courseId", "id");
CREATE UNIQUE INDEX "LearningTopic_userId_courseId_normalizedName_key" ON "LearningTopic"("userId", "courseId", "normalizedName");
CREATE INDEX "LearningTopic_courseId_userId_idx" ON "LearningTopic"("courseId", "userId");

CREATE INDEX "QuizQuestionTopic_topicId_userId_courseId_idx" ON "QuizQuestionTopic"("topicId", "userId", "courseId");
CREATE INDEX "QuizQuestionTopic_userId_courseId_idx" ON "QuizQuestionTopic"("userId", "courseId");

CREATE UNIQUE INDEX "QuizAttempt_id_quizId_userId_key" ON "QuizAttempt"("id", "quizId", "userId");
CREATE INDEX "QuizAttempt_userId_quizId_startedAt_idx" ON "QuizAttempt"("userId", "quizId", "startedAt");
CREATE INDEX "QuizAttempt_userId_completedAt_idx" ON "QuizAttempt"("userId", "completedAt");

CREATE UNIQUE INDEX "QuestionAttempt_quizAttemptId_questionId_key" ON "QuestionAttempt"("quizAttemptId", "questionId");
CREATE INDEX "QuestionAttempt_userId_questionId_attemptedAt_idx" ON "QuestionAttempt"("userId", "questionId", "attemptedAt");
CREATE INDEX "QuestionAttempt_quizAttemptId_attemptedAt_idx" ON "QuestionAttempt"("quizAttemptId", "attemptedAt");

CREATE UNIQUE INDEX "LearningProgress_userId_courseId_topicId_key" ON "LearningProgress"("userId", "courseId", "topicId");
CREATE INDEX "LearningProgress_userId_courseId_masteryScore_idx" ON "LearningProgress"("userId", "courseId", "masteryScore");
CREATE INDEX "LearningProgress_userId_lastPracticedAt_idx" ON "LearningProgress"("userId", "lastPracticedAt");

ALTER TABLE "LearningTopic" ADD CONSTRAINT "LearningTopic_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LearningTopic" ADD CONSTRAINT "LearningTopic_courseId_userId_fkey"
FOREIGN KEY ("courseId", "userId") REFERENCES "Course"("id", "userId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "QuizQuestionTopic" ADD CONSTRAINT "QuizQuestionTopic_questionId_userId_fkey"
FOREIGN KEY ("questionId", "userId") REFERENCES "QuizQuestion"("id", "userId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "QuizQuestionTopic" ADD CONSTRAINT "QuizQuestionTopic_userId_courseId_topicId_fkey"
FOREIGN KEY ("userId", "courseId", "topicId") REFERENCES "LearningTopic"("userId", "courseId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "QuizAttempt" ADD CONSTRAINT "QuizAttempt_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "QuizAttempt" ADD CONSTRAINT "QuizAttempt_quizId_userId_fkey"
FOREIGN KEY ("quizId", "userId") REFERENCES "Quiz"("id", "userId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "QuestionAttempt" ADD CONSTRAINT "QuestionAttempt_quizAttemptId_quizId_userId_fkey"
FOREIGN KEY ("quizAttemptId", "quizId", "userId") REFERENCES "QuizAttempt"("id", "quizId", "userId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "QuestionAttempt" ADD CONSTRAINT "QuestionAttempt_questionId_quizId_userId_fkey"
FOREIGN KEY ("questionId", "quizId", "userId") REFERENCES "QuizQuestion"("id", "quizId", "userId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "LearningProgress" ADD CONSTRAINT "LearningProgress_userId_courseId_topicId_fkey"
FOREIGN KEY ("userId", "courseId", "topicId") REFERENCES "LearningTopic"("userId", "courseId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "QuizQuestion" ADD CONSTRAINT "QuizQuestion_topicNames_check"
CHECK (cardinality("topicNames") <= 5);
ALTER TABLE "LearningTopic" ADD CONSTRAINT "LearningTopic_name_check"
CHECK (char_length("name") BETWEEN 1 AND 120);
ALTER TABLE "LearningTopic" ADD CONSTRAINT "LearningTopic_normalizedName_check"
CHECK (char_length("normalizedName") BETWEEN 1 AND 120);
ALTER TABLE "LearningTopic" ADD CONSTRAINT "LearningTopic_description_check"
CHECK ("description" IS NULL OR char_length("description") <= 1000);
ALTER TABLE "QuizAttempt" ADD CONSTRAINT "QuizAttempt_completedAt_check"
CHECK ("completedAt" IS NULL OR "completedAt" >= "startedAt");
ALTER TABLE "QuestionAttempt" ADD CONSTRAINT "QuestionAttempt_userAnswer_check"
CHECK (char_length("userAnswer") BETWEEN 1 AND 4000);
ALTER TABLE "QuestionAttempt" ADD CONSTRAINT "QuestionAttempt_score_check"
CHECK ("score" BETWEEN 0 AND 1);
ALTER TABLE "LearningProgress" ADD CONSTRAINT "LearningProgress_scores_check"
CHECK (
  "masteryScore" BETWEEN 0 AND 100
  AND "confidenceScore" BETWEEN 0 AND 100
  AND "recentAccuracy" BETWEEN 0 AND 100
);
ALTER TABLE "LearningProgress" ADD CONSTRAINT "LearningProgress_counts_check"
CHECK (
  "questionsAttempted" >= 0
  AND "correctAnswers" >= 0
  AND "incorrectAnswers" >= 0
  AND "practiceSessions" >= 0
  AND "easyAttempts" >= 0
  AND "mediumAttempts" >= 0
  AND "hardAttempts" >= 0
  AND "correctAnswers" + "incorrectAnswers" = "questionsAttempted"
  AND "easyAttempts" + "mediumAttempts" + "hardAttempts" = "questionsAttempted"
  AND "practiceSessions" <= "questionsAttempted"
);
ALTER TABLE "LearningProgress" ADD CONSTRAINT "LearningProgress_aggregates_check"
CHECK (
  "scoreTotal" BETWEEN 0 AND "questionsAttempted"
  AND "difficultyWeightedScore" >= 0
  AND "difficultyWeightTotal" >= 0
  AND "difficultyWeightedScore" <= "difficultyWeightTotal"
);
ALTER TABLE "LearningProgress" ADD CONSTRAINT "LearningProgress_practiceDates_check"
CHECK (
  ("questionsAttempted" = 0 AND "firstPracticedAt" IS NULL AND "lastPracticedAt" IS NULL)
  OR
  ("questionsAttempted" > 0 AND "firstPracticedAt" IS NOT NULL AND "lastPracticedAt" IS NOT NULL AND "firstPracticedAt" <= "lastPracticedAt")
);
