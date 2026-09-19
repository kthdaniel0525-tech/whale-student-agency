export const INTEGRATION_HEALTH_LABELS = {
  available: "Connected", syncing: "Syncing", delayed: "Connected — Sync delayed",
  unavailable: "Temporarily unavailable", "missing-permission": "Needs permission",
  "needs-reconnect": "Needs reconnect", disconnected: "Disconnected",
} as const;
export interface IntegrationHealth {
  state: keyof typeof INTEGRATION_HEALTH_LABELS;
  auth: "healthy" | "missing-permission" | "needs-reconnect" | "disconnected";
  sync: "healthy" | "syncing" | "delayed" | "unavailable";
  lastSuccessfulSync: string | null;
  retryAt: string | null;
}
