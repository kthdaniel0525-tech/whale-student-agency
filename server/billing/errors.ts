import "server-only";
const messages = {
  BILLING_DISABLED: "Billing is not available yet.",
  BILLING_CONFIGURATION: "Billing is temporarily unavailable. Please try again later.",
  BILLING_UNAVAILABLE: "The payment service is temporarily unavailable. Please try again.",
  BILLING_INVALID_PLAN: "This plan or billing interval is not available.",
  BILLING_NOT_FOUND: "No billing account was found for your account.",
  BILLING_CONFLICT: "An existing checkout or subscription needs attention. Open billing settings to continue.",
  BILLING_SIGNATURE: "Invalid billing notification.",
  BILLING_OWNERSHIP: "This billing record is not available for your account.",
} as const;
export class BillingError extends Error {
  constructor(readonly code: keyof typeof messages, readonly status = 503) { super(messages[code]); this.name = "BillingError"; }
}
