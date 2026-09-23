ALTER TABLE "ConnectedAccount"
  ADD COLUMN "refreshLeaseToken" TEXT,
  ADD COLUMN "refreshLeaseUntil" TIMESTAMP(3),
  ADD COLUMN "deniedCapabilities" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "IntegrationSyncState" ADD COLUMN "retryAfter" TIMESTAMP(3);
