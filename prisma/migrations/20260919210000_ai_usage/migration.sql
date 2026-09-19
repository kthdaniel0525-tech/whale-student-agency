CREATE TABLE "AIUsageRecord" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "userId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "provider" TEXT NOT NULL,
  "model" TEXT NOT NULL,
  "operationType" TEXT NOT NULL,
  "agentId" TEXT,
  "workflowId" TEXT,
  "workflowRunId" TEXT,
  "conversationId" TEXT,
  "requestId" TEXT NOT NULL,
  "inputTokens" INTEGER,
  "outputTokens" INTEGER,
  "totalTokens" INTEGER,
  "cachedInputTokens" INTEGER,
  "reasoningTokens" INTEGER,
  "usageSource" TEXT NOT NULL,
  "estimatedCostUsd" DECIMAL(20,10),
  "pricingVersion" TEXT,
  "latencyMs" INTEGER NOT NULL,
  "success" BOOLEAN NOT NULL,
  "errorCode" TEXT,
  "source" TEXT,
  "batchSize" INTEGER,
  "estimatedContextTokens" INTEGER,
  "ragChunkCount" INTEGER,
  "retrievedTokenEstimate" INTEGER,
  "memoriesUsed" INTEGER,
  "personalizationFieldsUsed" INTEGER,
  "conversationSummaryUsed" BOOLEAN,
  "recentMessageCount" INTEGER,
  "historicalMessageCount" INTEGER,
  "estimatedConversationTokens" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "AIUsageRecord_userId_createdAt_idx" ON "AIUsageRecord"("userId", "createdAt");
CREATE INDEX "AIUsageRecord_userId_agentId_createdAt_idx" ON "AIUsageRecord"("userId", "agentId", "createdAt");
CREATE INDEX "AIUsageRecord_userId_workflowId_createdAt_idx" ON "AIUsageRecord"("userId", "workflowId", "createdAt");
CREATE INDEX "AIUsageRecord_userId_provider_model_createdAt_idx" ON "AIUsageRecord"("userId", "provider", "model", "createdAt");
CREATE INDEX "AIUsageRecord_userId_requestId_idx" ON "AIUsageRecord"("userId", "requestId");
CREATE INDEX "AIUsageRecord_userId_operationType_createdAt_idx" ON "AIUsageRecord"("userId", "operationType", "createdAt");
