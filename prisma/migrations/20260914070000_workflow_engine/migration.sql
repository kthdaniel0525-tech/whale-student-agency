CREATE TYPE "WorkflowRunStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED');
CREATE TYPE "WorkflowStepStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'SKIPPED', 'FAILED');
CREATE TABLE "WorkflowRun" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "workflowId" TEXT NOT NULL,
  "status" "WorkflowRunStatus" NOT NULL DEFAULT 'PENDING',
  "activeKey" TEXT,
  "currentStep" TEXT,
  "input" JSONB NOT NULL,
  "context" JSONB NOT NULL,
  "warnings" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "errorCode" TEXT,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  "failedAt" TIMESTAMP(3),
  "cancelledAt" TIMESTAMP(3),
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "WorkflowRun_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "WorkflowStepRun" (
  "id" TEXT NOT NULL,
  "workflowRunId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "stepId" TEXT NOT NULL,
  "position" INTEGER NOT NULL,
  "agentId" TEXT NOT NULL,
  "status" "WorkflowStepStatus" NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "inputSummary" TEXT,
  "outputSummary" TEXT,
  "output" JSONB,
  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "errorCode" TEXT,
  CONSTRAINT "WorkflowStepRun_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "WorkflowRun_activeKey_key" ON "WorkflowRun"("activeKey");
CREATE UNIQUE INDEX "WorkflowRun_id_userId_key" ON "WorkflowRun"("id", "userId");
CREATE INDEX "WorkflowRun_userId_startedAt_idx" ON "WorkflowRun"("userId", "startedAt");
CREATE UNIQUE INDEX "WorkflowStepRun_workflowRunId_stepId_key" ON "WorkflowStepRun"("workflowRunId", "stepId");
CREATE INDEX "WorkflowStepRun_userId_workflowRunId_idx" ON "WorkflowStepRun"("userId", "workflowRunId");
ALTER TABLE "WorkflowRun" ADD CONSTRAINT "WorkflowRun_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WorkflowStepRun" ADD CONSTRAINT "WorkflowStepRun_workflowRunId_userId_fkey" FOREIGN KEY ("workflowRunId", "userId") REFERENCES "WorkflowRun"("id", "userId") ON DELETE CASCADE ON UPDATE CASCADE;
