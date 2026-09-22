export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { billingConfig } = await import("./server/billing/config");
    const config = billingConfig();
    if (config.enabled && !config.portalConfigurationId) throw new Error("STRIPE_PORTAL_CONFIGURATION_ID is required when billing is enabled.");
  }
}
