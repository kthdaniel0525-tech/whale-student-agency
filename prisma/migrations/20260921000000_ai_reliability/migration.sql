ALTER TABLE "AIUsageRecord"
  ADD COLUMN "primaryProvider" TEXT,
  ADD COLUMN "primaryModel" TEXT,
  ADD COLUMN "attemptNumber" INTEGER,
  ADD COLUMN "fallbackDepth" INTEGER,
  ADD COLUMN "fallbackFromProvider" TEXT,
  ADD COLUMN "fallbackFromModel" TEXT,
  ADD COLUMN "finalProvider" TEXT,
  ADD COLUMN "failureClass" TEXT,
  ADD COLUMN "streamStarted" BOOLEAN,
  ADD COLUMN "tokensEmitted" INTEGER;
