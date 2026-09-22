import "server-only";
import { z } from "zod";
import { billingConfig } from "../billing/config";
import { billingProvider, reconcileBillingSubscriptions } from "../billing/service";
import type { BackgroundJob } from "./types";
export const reconcileBillingJob: BackgroundJob<{ version: 1 }> = {
  name: "reconcile-billing-subscriptions", version: 1,
  payloadSchema: z.object({ version: z.literal(1) }).strict(),
  executionScope: "system", priority: "normal", timeoutSeconds: 300,
  concurrency: { scope: "global", limit: 1 }, debounceSeconds: 300,
  retryPolicy: { limit: 2, delaySeconds: 60, maximumDelaySeconds: 300, exponentialBackoff: true },
  handler: async ({ signal }) => !billingConfig().enabled ? { skipped: true } : reconcileBillingSubscriptions(billingProvider(), 10, signal),
};
