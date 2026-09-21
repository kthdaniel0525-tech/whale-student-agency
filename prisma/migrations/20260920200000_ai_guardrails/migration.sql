CREATE TABLE "AIGuardState" (
  "key" TEXT PRIMARY KEY,
  "data" JSONB NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL
);
CREATE INDEX "AIGuardState_expiresAt_idx" ON "AIGuardState"("expiresAt");
CREATE TABLE "AIGuardEvent" (
  "id" TEXT PRIMARY KEY,
  "userId" TEXT,
  "requestId" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "agentId" TEXT,
  "workflowId" TEXT,
  "modelTier" TEXT,
  "snapshot" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "AIGuardEvent_userId_createdAt_idx" ON "AIGuardEvent"("userId", "createdAt");
CREATE INDEX "AIGuardEvent_type_createdAt_idx" ON "AIGuardEvent"("type", "createdAt");
