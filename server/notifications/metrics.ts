import "server-only";
const metrics = { created: 0, delivered: 0, read: 0, dismissed: 0, snoozed: 0, failed: 0, deliveryLatencyMs: 0 };
export function recordNotificationMetric(event: Exclude<keyof typeof metrics, "deliveryLatencyMs">, count = 1, latency = 0) {
  metrics[event] += count;
  if (event === "delivered") metrics.deliveryLatencyMs += latency;
}
export function getNotificationMetrics() { return { ...metrics }; }
