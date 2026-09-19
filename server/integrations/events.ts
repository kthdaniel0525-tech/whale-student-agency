import "server-only";
import { recordIntegrationMetric } from "./metrics";
import type { IntegrationProviderId } from "@/lib/student/integrations/types";
import type { IntegrationErrorCode } from "./errors";
export const INTEGRATION_EVENTS = ["INTEGRATION_CONNECTED", "INTEGRATION_DISCONNECTED", "INTEGRATION_RECONNECTED", "INTEGRATION_TOKEN_REFRESH_FAILED", "INTEGRATION_SCOPE_REQUIRED", "INTEGRATION_PROVIDER_REQUEST_FAILED"] as const;
export type IntegrationEvent = typeof INTEGRATION_EVENTS[number];
/** Narrow metadata only. Future job consumers can use these identifiers without
 * browser cookies; no tokens, authorization URLs, codes, emails or raw errors. */
export function emitIntegrationEvent(event: IntegrationEvent, metadata: { provider: IntegrationProviderId; connectedAccountId: string; errorCode?: IntegrationErrorCode }) {
  if (event === "INTEGRATION_TOKEN_REFRESH_FAILED") recordIntegrationMetric("refreshFailures");
  if (metadata.errorCode === "PROVIDER_RATE_LIMITED") recordIntegrationMetric("rateLimits");
  console.info("Integration event", { event, provider: metadata.provider, connectedAccountId: metadata.connectedAccountId, ...(metadata.errorCode ? { errorCode: metadata.errorCode } : {}) });
}
