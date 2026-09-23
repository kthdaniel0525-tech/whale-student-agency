ALTER TYPE "WorkflowRunStatus" ADD VALUE 'WAITING_FOR_INPUT';
ALTER TABLE "WorkflowRun" ADD COLUMN "activeDurationMs" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "WorkflowRun" ADD CONSTRAINT "WorkflowRun_activeDurationMs_check" CHECK ("activeDurationMs" >= 0);
