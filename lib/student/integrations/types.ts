import { z } from "zod";
import type { IntegrationHealth } from "./health";
export const INTEGRATION_PROVIDER_IDS = ["google", "microsoft"] as const;
export type IntegrationProviderId = typeof INTEGRATION_PROVIDER_IDS[number];
export const INTEGRATION_CAPABILITIES = ["account-profile", "calendar-read", "calendar-write", "drive-read", "email-read"] as const;
export type IntegrationCapability = typeof INTEGRATION_CAPABILITIES[number];
export const CAPABILITY_LABELS: Record<IntegrationCapability, { title: string; description: string }> = {
  "account-profile": { title: "Account identity", description: "Identify your connected account using your name and email." },
  "calendar-read": { title: "Read calendar events", description: "Permission to read calendar events when a calendar feature is available." },
  "calendar-write": { title: "Manage calendar events", description: "Permission to manage calendar events when a calendar feature is available." },
  "drive-read": { title: "Read Drive files", description: "Permission to read Drive files when a Drive feature is available." },
  "email-read": { title: "Read email", description: "Permission to read email when an email feature is available." },
};
export const startConnectionSchema = z.object({
  provider: z.enum(INTEGRATION_PROVIDER_IDS),
  capabilities: z.array(z.enum(INTEGRATION_CAPABILITIES)).min(1).max(5).default(["account-profile"]),
  redirectPath: z.enum(["/student/settings"]).default("/student/settings"),
  connectedAccountId: z.string().min(1).max(100).optional(),
}).strict();
export type StartConnectionInput = z.input<typeof startConnectionSchema>;
export interface ConnectedAccountView {
  health?: IntegrationHealth;
  id: string; provider: IntegrationProviderId; displayName: string | null; email: string | null;
  status: "connected" | "needs-reconnect" | "disconnected" | "error";
  capabilities: IntegrationCapability[]; connectedAt: string; lastRefreshedAt: string | null;
  revocationFailed: boolean;
}
export interface IntegrationProviderView { id: IntegrationProviderId; name: string; available: boolean; }
export interface IntegrationSettingsView { providers: IntegrationProviderView[]; accounts: ConnectedAccountView[]; }
