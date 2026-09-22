-- Additive operational state. No backfill or changes to academic data.
CREATE TABLE "RuntimeHeartbeat" (
  "id" TEXT NOT NULL,
  "role" TEXT NOT NULL,
  "release" TEXT NOT NULL,
  "seenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RuntimeHeartbeat_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "RuntimeHeartbeat_role_seenAt_idx" ON "RuntimeHeartbeat"("role", "seenAt");
