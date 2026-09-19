import "server-only";
import { getNotificationPreferences } from "../preferences/notifications";
import { z } from "zod";
import { evaluateRecommendations } from "../recommendations";
import { BackgroundJobError } from "./errors";
import type { BackgroundJob, BackgroundJobResult } from "./types";

export const REFRESH_USER_RECOMMENDATIONS_JOB =
  "refresh-user-recommendations" as const;

export const refreshRecommendationJobPayload = z.object({
  version: z.literal(1),
  trackingId: z.string().min(1).max(100),
  userId: z.string().min(1).max(100),
});

export type RefreshRecommendationJobPayload = z.infer<
  typeof refreshRecommendationJobPayload
>;

type RecommendationEvaluator = typeof evaluateRecommendations;

export function createRefreshRecommendationsJob(
  evaluate: RecommendationEvaluator = evaluateRecommendations,
): BackgroundJob<RefreshRecommendationJobPayload> {
  return {
    name: REFRESH_USER_RECOMMENDATIONS_JOB,
    version: 1,
    payloadSchema: refreshRecommendationJobPayload,
    retryPolicy: {
      limit: 3,
      delaySeconds: 5,
      maximumDelaySeconds: 60,
      exponentialBackoff: true,
    },
    timeoutSeconds: 30,
    priority: "normal",
    executionScope: "user",
    concurrency: { scope: "user", limit: 1 },
    debounceSeconds: 10,
    async handler({ payload, signal }): Promise<BackgroundJobResult> {
      if (signal.aborted) throw new BackgroundJobError("TIMEOUT");
      const preferences = await getNotificationPreferences(payload.userId);
      if (!preferences.proactiveRecommendationsEnabled) return { skipped: true, reason: "FEATURE_DISABLED" };
      const result = await evaluate(payload.userId);
      if (signal.aborted) throw new BackgroundJobError("TIMEOUT");
      return {
        created: result.created,
        updated: result.updated,
        expired: result.expired,
        suppressed: result.suppressed,
        active: result.recommendations.length,
      };
    },
  };
}

export const refreshRecommendationsJob = createRefreshRecommendationsJob();
