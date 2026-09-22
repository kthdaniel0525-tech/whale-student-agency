-- Single statement: PostgreSQL concurrent index build must run outside a transaction.
CREATE INDEX CONCURRENTLY "JobRun_status_createdAt_idx" ON "JobRun"("status", "createdAt");
