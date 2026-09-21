ALTER TABLE "AIUsageRecord"
  ADD COLUMN "selectedModel" TEXT,
  ADD COLUMN "selectedTier" TEXT,
  ADD COLUMN "routingComplexity" TEXT,
  ADD COLUMN "routingReasonCode" TEXT,
  ADD COLUMN "routingMethod" TEXT,
  ADD COLUMN "fallbackUsed" BOOLEAN;

CREATE INDEX "AIUsageRecord_userId_selectedTier_createdAt_idx" ON "AIUsageRecord"("userId", "selectedTier", "createdAt");
