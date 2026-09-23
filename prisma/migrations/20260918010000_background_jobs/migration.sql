CREATE TYPE "JobRunStatus" AS ENUM (
  'PENDING',
  'RUNNING',
  'COMPLETED',
  'FAILED',
  'CANCELLED'
);

CREATE TABLE "JobRun" (
  "id" TEXT NOT NULL,
  "queueJobId" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "jobName" TEXT NOT NULL,
  "jobVersion" INTEGER NOT NULL,
  "userId" TEXT,
  "resourceId" TEXT,
  "status" "JobRunStatus" NOT NULL DEFAULT 'PENDING',
  "attempt" INTEGER NOT NULL DEFAULT 0,
  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "failedAt" TIMESTAMP(3),
  "errorCode" TEXT,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "JobRun_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "JobRun_jobVersion_check" CHECK ("jobVersion" > 0),
  CONSTRAINT "JobRun_attempt_check" CHECK ("attempt" >= 0),
  CONSTRAINT "JobRun_jobName_length_check" CHECK (char_length("jobName") BETWEEN 1 AND 100),
  CONSTRAINT "JobRun_idempotencyKey_length_check" CHECK (char_length("idempotencyKey") BETWEEN 1 AND 240)
);

CREATE UNIQUE INDEX "JobRun_queueJobId_key" ON "JobRun"("queueJobId");
CREATE UNIQUE INDEX "JobRun_idempotencyKey_key" ON "JobRun"("idempotencyKey");
CREATE INDEX "JobRun_jobName_status_createdAt_idx" ON "JobRun"("jobName", "status", "createdAt");
CREATE INDEX "JobRun_userId_jobName_status_createdAt_idx" ON "JobRun"("userId", "jobName", "status", "createdAt");

ALTER TABLE "JobRun" ADD CONSTRAINT "JobRun_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
