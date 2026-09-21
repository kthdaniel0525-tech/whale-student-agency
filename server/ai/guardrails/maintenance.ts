import "server-only";
import { db } from "../../db/client";
/** Reuse the existing daily maintenance job. Bounded batches keep cleanup from
 * holding locks over an unbounded telemetry history. */
export async function cleanupGuardrails() {
  const states = await db().$executeRaw`DELETE FROM "AIGuardState" WHERE key IN (SELECT key FROM "AIGuardState" WHERE "expiresAt" < NOW() ORDER BY "expiresAt" LIMIT 10000 FOR UPDATE SKIP LOCKED)`;
  const events = await db().$executeRaw`DELETE FROM "AIGuardEvent" WHERE id IN (SELECT id FROM "AIGuardEvent" WHERE "createdAt" < NOW() - INTERVAL '30 days' ORDER BY "createdAt" LIMIT 10000 FOR UPDATE SKIP LOCKED)`;
  return states + events;
}
