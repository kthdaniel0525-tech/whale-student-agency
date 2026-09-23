-- Minimal persisted quiz state. Attempts and learning progress remain out of scope.
CREATE TYPE "QuizDifficulty" AS ENUM ('EASY', 'MEDIUM', 'HARD');
CREATE TYPE "QuizQuestionType" AS ENUM ('MULTIPLE_CHOICE', 'TRUE_FALSE', 'SHORT_ANSWER', 'LONG_ANSWER');

CREATE TABLE "Quiz" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "courseId" TEXT,
  "title" TEXT NOT NULL,
  "topic" TEXT,
  "difficulty" "QuizDifficulty" NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Quiz_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "QuizQuestion" (
  "id" TEXT NOT NULL,
  "quizId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "position" INTEGER NOT NULL,
  "type" "QuizQuestionType" NOT NULL,
  "prompt" TEXT NOT NULL,
  "choices" JSONB,
  "correctAnswer" TEXT NOT NULL,
  "explanation" TEXT NOT NULL,
  "sourceMetadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "QuizQuestion_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Quiz_id_userId_key" ON "Quiz"("id", "userId");
CREATE INDEX "Quiz_userId_createdAt_idx" ON "Quiz"("userId", "createdAt");
CREATE INDEX "Quiz_courseId_userId_idx" ON "Quiz"("courseId", "userId");
CREATE UNIQUE INDEX "QuizQuestion_quizId_position_key" ON "QuizQuestion"("quizId", "position");
CREATE INDEX "QuizQuestion_userId_quizId_idx" ON "QuizQuestion"("userId", "quizId");

ALTER TABLE "Quiz" ADD CONSTRAINT "Quiz_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Quiz" ADD CONSTRAINT "Quiz_courseId_userId_fkey" FOREIGN KEY ("courseId", "userId") REFERENCES "Course"("id", "userId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "QuizQuestion" ADD CONSTRAINT "QuizQuestion_quizId_userId_fkey" FOREIGN KEY ("quizId", "userId") REFERENCES "Quiz"("id", "userId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "QuizQuestion" ADD CONSTRAINT "QuizQuestion_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Quiz" ADD CONSTRAINT "Quiz_title_check" CHECK (char_length("title") BETWEEN 1 AND 200);
ALTER TABLE "Quiz" ADD CONSTRAINT "Quiz_topic_check" CHECK ("topic" IS NULL OR char_length("topic") BETWEEN 1 AND 200);
ALTER TABLE "QuizQuestion" ADD CONSTRAINT "QuizQuestion_position_check" CHECK ("position" BETWEEN 0 AND 19);
ALTER TABLE "QuizQuestion" ADD CONSTRAINT "QuizQuestion_prompt_check" CHECK (char_length("prompt") BETWEEN 1 AND 2000);
ALTER TABLE "QuizQuestion" ADD CONSTRAINT "QuizQuestion_answer_check" CHECK (char_length("correctAnswer") BETWEEN 1 AND 2000);
ALTER TABLE "QuizQuestion" ADD CONSTRAINT "QuizQuestion_explanation_check" CHECK (char_length("explanation") BETWEEN 1 AND 2000);
