-- Single statement: PostgreSQL concurrent index build must run outside a transaction.
CREATE INDEX CONCURRENTLY "AIUsageRecord_createdAt_idx" ON "AIUsageRecord"("createdAt");
