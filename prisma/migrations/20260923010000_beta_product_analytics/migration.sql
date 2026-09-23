-- CreateTable
CREATE TABLE "BetaAccess" (
    "userId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'invited',
    "cohort" TEXT NOT NULL DEFAULT 'core',
    "source" TEXT NOT NULL DEFAULT 'operator',
    "internal" BOOLEAN NOT NULL DEFAULT false,
    "invitedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "activatedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BetaAccess_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "ProductAnalyticsState" (
    "userId" TEXT NOT NULL,
    "anonymousId" TEXT NOT NULL,
    "optedOut" BOOLEAN NOT NULL DEFAULT false,
    "feedbackPromptDismissedAt" TIMESTAMP(3),

    CONSTRAINT "ProductAnalyticsState_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "ProductEvent" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "environment" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "cohort" TEXT,
    "properties" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductFeedback" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "rating" INTEGER,
    "message" TEXT NOT NULL,
    "page" TEXT,
    "feature" TEXT,
    "requestId" TEXT,
    "workflowRunId" TEXT,
    "appVersion" TEXT NOT NULL,
    "survey" JSONB,
    "status" TEXT NOT NULL DEFAULT 'new',
    "severity" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductFeedback_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BetaAccess_status_cohort_idx" ON "BetaAccess"("status", "cohort");

-- CreateIndex
CREATE UNIQUE INDEX "ProductAnalyticsState_anonymousId_key" ON "ProductAnalyticsState"("anonymousId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductEvent_dedupeKey_key" ON "ProductEvent"("dedupeKey");

-- CreateIndex
CREATE INDEX "ProductEvent_environment_name_createdAt_idx" ON "ProductEvent"("environment", "name", "createdAt");

-- CreateIndex
CREATE INDEX "ProductEvent_userId_environment_createdAt_idx" ON "ProductEvent"("userId", "environment", "createdAt");

-- CreateIndex
CREATE INDEX "ProductEvent_createdAt_idx" ON "ProductEvent"("createdAt");

-- CreateIndex
CREATE INDEX "ProductFeedback_status_createdAt_idx" ON "ProductFeedback"("status", "createdAt");

-- CreateIndex
CREATE INDEX "ProductFeedback_userId_createdAt_idx" ON "ProductFeedback"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ProductFeedback_userId_submissionId_key" ON "ProductFeedback"("userId", "submissionId");

-- AddForeignKey
ALTER TABLE "BetaAccess" ADD CONSTRAINT "BetaAccess_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductAnalyticsState" ADD CONSTRAINT "ProductAnalyticsState_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductEvent" ADD CONSTRAINT "ProductEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductFeedback" ADD CONSTRAINT "ProductFeedback_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

