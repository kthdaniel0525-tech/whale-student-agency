import "dotenv/config";
import { createHash } from "node:crypto";
import { requireBilling } from "../server/billing/config";
import { StripeBillingProvider } from "../server/billing/stripe";
import { publicPlanCatalog } from "../server/entitlements/service";
import { db } from "../server/db/client";
async function main() {
  const config = requireBilling();
  const provider = new StripeBillingProvider(config);
  const plans = await publicPlanCatalog();
  const ids = Object.entries(config.prices).filter(([code, p]) => p.enabled && plans.some(plan => plan.code === code)).flatMap(([, p]) => [p.monthly, p.yearly].filter((v): v is string => !!v)).sort();
  const prices = await Promise.all(ids.map(id => provider.price(id)));
  if (!prices.length || prices.some(p => !p.active) || new Set(prices.map(p => p.productId)).size !== 1) throw new Error("All enabled prices must be active prices on one Stripe Product for native scheduled downgrades.");
  const params = { business_profile: { headline: "Manage your learning subscription" }, default_return_url: `${config.origin}/student/settings/billing`, features: { invoice_history: { enabled: true }, payment_method_update: { enabled: true }, subscription_cancel: { enabled: true, mode: "at_period_end" as const, proration_behavior: "none" as const }, subscription_update: { enabled: true, default_allowed_updates: ["price" as const], products: [{ product: prices[0].productId, prices: ids }], proration_behavior: "always_invoice" as const, schedule_at_period_end: { conditions: [{ type: "decreasing_item_amount" as const }, { type: "shortening_interval" as const }] } } } };
  const result = config.portalConfigurationId ? await provider.sdk.billingPortal.configurations.update(config.portalConfigurationId, params) : await provider.sdk.billingPortal.configurations.create(params, { idempotencyKey: `portal-config:${createHash("sha256").update(JSON.stringify(params)).digest("hex")}` });
  console.log(`Portal configured. Set STRIPE_PORTAL_CONFIGURATION_ID=${result.id}`);
}
main().catch(() => { console.error("Billing configuration failed. Check enabled plan prices, product, mode and Stripe access."); process.exitCode = 1; }).finally(() => db().$disconnect());
