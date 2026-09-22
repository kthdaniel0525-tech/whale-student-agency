import "server-only";
import { getEnv } from "../env";
import { googleCredentials, integrationOrigin } from "../integrations/config";
import { getTokenEncryptionService } from "../integrations/encryption";
import { billingConfig } from "../billing/config";

/** Validate enabled security boundaries before the server accepts requests.
 * A disabled integration needs no credentials; a partially configured one must
 * fail closed rather than start using development defaults. No network calls. */
export function validateSecurityConfiguration() {
  getEnv();
  if (process.env.INTEGRATION_OAUTH_BASE_URL) integrationOrigin();
  const googleConfigured = !!(process.env.GOOGLE_INTEGRATION_CLIENT_ID?.trim() || process.env.GOOGLE_INTEGRATION_CLIENT_SECRET?.trim());
  if (googleConfigured) googleCredentials();
  if (googleConfigured || process.env.INTEGRATION_TOKEN_KEYS || process.env.INTEGRATION_TOKEN_ACTIVE_KEY_ID) getTokenEncryptionService();
  const billing = billingConfig();
  if (billing.enabled && !billing.portalConfigurationId) throw new Error("STRIPE_PORTAL_CONFIGURATION_ID is required when billing is enabled.");
}
