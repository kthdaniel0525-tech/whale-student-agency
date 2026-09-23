import "server-only";
import { z } from "zod";
import type { BillingInterval } from "@/lib/billing/types";
import { BillingError } from "./errors";
const priceId = z.string().regex(/^price_[a-zA-Z0-9_]+$/);
const mapping = z.record(z.string().regex(/^[a-z][a-z0-9-]{1,63}$/), z.object({ monthly: priceId.optional(), yearly: priceId.optional(), enabled: z.boolean().default(true) }).strict());
export function billingConfig(env: NodeJS.ProcessEnv = process.env) {
  if (!env.BILLING_ENABLED || env.BILLING_ENABLED === "false") return { enabled: false as const };
  try {
    if (env.BILLING_ENABLED !== "true") throw new Error();
    const mode = z.enum(["test", "live"]).parse(env.BILLING_MODE);
    // Deployment environment, rather than NODE_ENV, permits production builds in staging.
    const environment = z.enum(["development", "staging", "production"]).parse(env.BILLING_ENVIRONMENT);
    if (env.NODE_ENV === "production" && environment === "development" || environment === "production" && mode !== "live" || env.VERCEL_ENV === "production" && (environment !== "production" || mode !== "live")) throw new Error();
    const key = z.string().regex(mode === "live" ? /^sk_live_.+/ : /^sk_test_.+/).parse(env.STRIPE_SECRET_KEY);
    const webhookSecret = z.string().regex(/^whsec_.+/).parse(env.STRIPE_WEBHOOK_SECRET);
    const prices = mapping.parse(JSON.parse(env.BILLING_PRICES_JSON ?? "{}"));
    const ids = Object.values(prices).flatMap(p => [p.monthly, p.yearly].filter((id): id is string => !!id));
    if (!ids.length || new Set(ids).size !== ids.length) throw new Error();
    const currency = z.enum(["usd", "cad", "eur", "gbp", "aud", "nzd"]).parse(env.BILLING_CURRENCY ?? "usd");
    const origin = new URL(z.string().url().parse(env.BETTER_AUTH_URL)).origin;
    if (environment !== "development" && !origin.startsWith("https://")) throw new Error();
    const portalConfigurationId = z.string().regex(/^bpc_[a-zA-Z0-9_]+$/).optional().parse(env.STRIPE_PORTAL_CONFIGURATION_ID || undefined);
    const graceDays = z.coerce.number().int().min(0).max(14).parse(env.BILLING_GRACE_DAYS ?? "3");
    const checkoutEnabled = z.enum(["true", "false"]).parse(env.BILLING_CHECKOUT_ENABLED ?? "true") === "true";
    return { enabled: true as const, mode, environment, key, webhookSecret, prices, currency, origin, portalConfigurationId, graceDays, checkoutEnabled };
  } catch { throw new BillingError("BILLING_CONFIGURATION"); }
}
export type EnabledBillingConfig = Extract<ReturnType<typeof billingConfig>, { enabled: true }>;
export function requireBilling() { const config = billingConfig(); if (!config.enabled) throw new BillingError("BILLING_DISABLED"); return config; }
export function priceFor(config: EnabledBillingConfig, planCode: string, interval: BillingInterval) {
  const value = config.prices[planCode];
  if (!value?.enabled || !value[interval]) throw new BillingError("BILLING_INVALID_PLAN", 400);
  return value[interval];
}
export function planForPrice(config: EnabledBillingConfig, id: string) {
  for (const [planCode, prices] of Object.entries(config.prices)) for (const interval of ["monthly", "yearly"] as const) if (prices[interval] === id) return { planCode, interval };
  throw new BillingError("BILLING_CONFIGURATION");
}
