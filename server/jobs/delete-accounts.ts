import "server-only";
import { z } from "zod";
import { sweepAccountDeletions } from "../privacy/deletion";
import type { BackgroundJob } from "./types";
export const deleteAccountsJob: BackgroundJob<{ version: 1 }> = {
  name: "delete-requested-accounts", version: 1, payloadSchema: z.object({ version: z.literal(1) }).strict(),
  executionScope: "system", timeoutSeconds: 300, priority: "normal", concurrency: { scope: "global", limit: 1 }, debounceSeconds: 300,
  retryPolicy: { limit: 2, delaySeconds: 60, maximumDelaySeconds: 300, exponentialBackoff: true },
  handler: ({ signal }) => sweepAccountDeletions(signal),
};
