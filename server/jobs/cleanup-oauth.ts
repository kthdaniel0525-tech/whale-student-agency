import { db } from "../db/client";
import "server-only";
import { z } from "zod";
import { cleanupOAuthSessions } from "../integrations/service";
import type { BackgroundJob } from "./types";
import { cleanupGuardrails } from "../ai/guardrails/maintenance";
export const cleanupOAuthSessionsJob: BackgroundJob<{ version: 1; trackingId?: string }> = {
  name: "cleanup-oauth-sessions", version: 1, payloadSchema: z.object({ version: z.literal(1), trackingId: z.string().max(100).optional() }),
  retryPolicy: { limit: 2, delaySeconds: 30, maximumDelaySeconds: 120, exponentialBackoff: true },
  timeoutSeconds: 60, priority: "low", executionScope: "system", concurrency: { scope: "global", limit: 1 }, debounceSeconds: 60,
  async handler() { return { entitlementReservationsDeleted: (await db().entitlementUsageAdmission.deleteMany({ where: { periodEnd: { lt: new Date(Date.now() - 90 * 86400000) } } })).count, deleted: await cleanupOAuthSessions(), guardrailRecordsDeleted: await cleanupGuardrails() }; },
};
