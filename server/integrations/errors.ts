import "server-only";
export const INTEGRATION_ERROR_MESSAGES = {
  UNAUTHENTICATED: "Sign in again before connecting an account.",
  NOT_FOUND: "This connected account is not available.",
  INVALID_REQUEST: "Check the connection request and try again.",
  CONFIGURATION: "This connection is not configured yet.",
  INVALID_STATE: "This connection request is invalid, expired, or already used. Start again from Settings.",
  ACCESS_DENIED: "You cancelled the connection. No new access was saved.",
  ACCOUNT_MISMATCH: "Choose the same account when reconnecting, or connect it as a new account.",
  AUTHORIZATION_REQUIRED: "Additional permission is needed. Reconnect and approve the requested access.",
  RECONNECT_REQUIRED: "This account needs to be reconnected.",
  DISCONNECTED: "This account has been disconnected.",
  CONNECTION_BUSY: "A connection change is still finishing. Please try again shortly.",
  INVALID_GRANT: "Authorization has expired or been revoked. Reconnect this account.",
  PROVIDER_UNAVAILABLE: "The service is temporarily unavailable. Please try again later.",
  INVALID_RESPONSE: "The service returned an invalid response. Start the connection again.",
  ENCRYPTION_FAILURE: "Secure credentials could not be read or saved.",
  STORAGE_FAILURE: "Connection details could not be saved or loaded. Please try again.",
} as const;
export type IntegrationErrorCode = keyof typeof INTEGRATION_ERROR_MESSAGES;
/** Never retain an upstream message, response body, URL, or cause: all can contain credentials. */
export class IntegrationError extends Error {
  readonly status: number;
  constructor(readonly code: IntegrationErrorCode) {
    super(INTEGRATION_ERROR_MESSAGES[code]); this.name = "IntegrationError";
    this.status = code === "UNAUTHENTICATED" ? 401 : code === "NOT_FOUND" ? 404 :
      ["AUTHORIZATION_REQUIRED", "RECONNECT_REQUIRED", "DISCONNECTED"].includes(code) ? 403 :
      code === "CONNECTION_BUSY" ? 409 : ["CONFIGURATION", "PROVIDER_UNAVAILABLE", "ENCRYPTION_FAILURE", "STORAGE_FAILURE"].includes(code) ? 503 : 400;
  }
}
export function safeIntegrationError(error: unknown): IntegrationError {
  return error instanceof IntegrationError ? new IntegrationError(error.code) : new IntegrationError("STORAGE_FAILURE");
}
export async function protectIntegration<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); } catch (error) { throw safeIntegrationError(error); }
}
