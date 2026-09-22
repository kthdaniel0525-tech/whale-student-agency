import "server-only";
import Stripe from "stripe";
import type { EnabledBillingConfig } from "./config";
import { BillingError } from "./errors";
import type { BillingEvent, BillingProvider, ProviderPrice, ProviderSubscription } from "./types";

const reference = (value: string | { id: string } | null | undefined) => typeof value === "string" ? value : value?.id ?? null;
const date = (seconds: number) => {
  if (!Number.isFinite(seconds) || seconds <= 0) throw new BillingError("BILLING_CONFIGURATION");
  return new Date(seconds * 1000);
};
const hostedUrl = (value: string | null, host: string) => {
  if (!value) throw new BillingError("BILLING_UNAVAILABLE");
  const url = new URL(value);
  if (url.protocol !== "https:" || url.hostname !== host) throw new BillingError("BILLING_UNAVAILABLE");
  return value;
};
export class StripeBillingProvider implements BillingProvider {
  readonly sdk: Stripe;
  constructor(readonly config: EnabledBillingConfig, sdk?: Stripe) {
    this.sdk = sdk ?? new Stripe(config.key, { maxNetworkRetries: 1, timeout: 8000 });
  }
  private async call<T>(operation: () => Promise<T>): Promise<T> {
    try { return await operation(); } catch (error) { if (error instanceof BillingError) throw error; throw new BillingError("BILLING_UNAVAILABLE"); }
  }
  createCustomer(userId: string, key: string) {
    return this.call(async () => (await this.sdk.customers.create({ metadata: { platformUserId: userId } }, { idempotencyKey: key })).id);
  }
  price(id: string): Promise<ProviderPrice> {
    return this.call(async () => {
      const p = await this.sdk.prices.retrieve(id);
      if (!p.recurring || p.recurring.interval_count !== 1 || !["month", "year"].includes(p.recurring.interval) || p.unit_amount === null || p.unit_amount <= 0 || p.billing_scheme !== "per_unit" || p.recurring.usage_type !== "licensed" || p.currency !== this.config.currency || p.livemode !== (this.config.mode === "live")) throw new BillingError("BILLING_CONFIGURATION");
      return { id: p.id, productId: reference(p.product)!, active: p.active, amount: p.unit_amount, currency: p.currency, interval: p.recurring.interval === "month" ? "monthly" : "yearly", live: p.livemode };
    });
  }
  subscription(id: string): Promise<ProviderSubscription> {
    return this.call(async () => {
      const s = await this.sdk.subscriptions.retrieve(id, { expand: ["latest_invoice", "schedule"] });
      if (s.items.data.length !== 1 || s.items.has_more || s.items.data[0].quantity !== 1 || !reference(s.customer) || s.livemode !== (this.config.mode === "live")) throw new BillingError("BILLING_CONFIGURATION");
      const item = s.items.data[0];
      const invoice = typeof s.latest_invoice === "object" ? s.latest_invoice : null;
      const schedule = typeof s.schedule === "object" ? s.schedule : null;
      const future = schedule?.phases.find(phase => phase.start_date >= item.current_period_end && phase.items.length === 1);
      const pendingPrice = future ? reference(future.items[0].price) : null;
      const statuses: Record<string, ProviderSubscription["status"]> = { active: "active", trialing: "trialing", past_due: "past-due", canceled: "cancelled", unpaid: "expired", incomplete: "expired", incomplete_expired: "expired", paused: "expired" };
      const status = s.pause_collection ? "expired" : statuses[s.status];
      if (!status || item.current_period_start >= item.current_period_end) throw new BillingError("BILLING_CONFIGURATION");
      return { id: s.id, customerId: reference(s.customer)!, priceId: item.price.id, itemId: item.id, createdAt: date(s.created), status,
        periodStart: date(item.current_period_start), periodEnd: date(s.cancel_at ? Math.min(s.cancel_at, item.current_period_end) : item.current_period_end), cancelAtPeriodEnd: s.cancel_at_period_end || !!s.cancel_at,
        trialEnd: s.trial_end ? date(s.trial_end) : null, delinquentSince: status === "past-due" && invoice ? date(invoice.created) : null, live: s.livemode,
        pending: pendingPrice && future ? { priceId: pendingPrice, effectiveAt: date(future.start_date) } : null };
    });
  }
  subscriptionIds(customerId: string) {
    return this.call(async () => {
      // Bound the product to one ongoing subscription. Unknown history fails closed.
      const values = await this.sdk.subscriptions.list({ customer: customerId, status: "all", limit: 100 });
      if (values.has_more) throw new BillingError("BILLING_CONFLICT", 409);
      return values.data.filter(s => !["canceled", "incomplete_expired"].includes(s.status)).map(s => s.id);
    });
  }
  async portalConfiguration() {
    if (!this.config.portalConfigurationId) throw new BillingError("BILLING_CONFIGURATION");
    return this.call(async () => {
      const p = await this.sdk.billingPortal.configurations.retrieve(this.config.portalConfigurationId!);
      const update = p.features.subscription_update;
      const conditions = update.schedule_at_period_end.conditions.map(c => c.type);
      const expected = Object.values(this.config.prices).filter(p => p.enabled).flatMap(p => [p.monthly, p.yearly].filter((id): id is string => !!id)).sort();
      const actual = (update.products ?? []).flatMap(p => p.prices).sort();
      // Same Stripe Product is required for native end-of-period price downgrades.
      if (!p.active || p.livemode !== (this.config.mode === "live") || !p.features.payment_method_update.enabled || !p.features.invoice_history.enabled || !p.features.subscription_cancel.enabled || p.features.subscription_cancel.mode !== "at_period_end" || !update.enabled || update.default_allowed_updates.length !== 1 || update.default_allowed_updates[0] !== "price" || update.proration_behavior !== "always_invoice" || !conditions.includes("decreasing_item_amount") || !conditions.includes("shortening_interval") || update.products?.length !== 1 || JSON.stringify(expected) !== JSON.stringify(actual)) throw new BillingError("BILLING_CONFIGURATION");
      return p.id;
    });
  }
  checkout(input: { customerId: string; priceId: string; key: string; expiresAt: Date }) {
    return this.call(async () => {
      await this.portalConfiguration();
      const s = await this.sdk.checkout.sessions.create({ mode: "subscription", customer: input.customerId, line_items: [{ price: input.priceId, quantity: 1 }], payment_method_types: ["card"], success_url: `${this.config.origin}/billing/success`, cancel_url: `${this.config.origin}/billing/cancelled`, expires_at: Math.floor(input.expiresAt.getTime() / 1000) }, { idempotencyKey: input.key });
      return { id: s.id, url: hostedUrl(s.url, "checkout.stripe.com") };
    });
  }
  checkoutState(id: string) {
    return this.call(async () => {
      const s = await this.sdk.checkout.sessions.retrieve(id);
      if (!["open", "complete", "expired"].includes(s.status ?? "")) throw new BillingError("BILLING_UNAVAILABLE");
      return { status: s.status as "open" | "complete" | "expired", url: s.status === "open" ? hostedUrl(s.url, "checkout.stripe.com") : null };
    });
  }
  portal(customerId: string, change?: { subscriptionId: string; itemId: string; priceId: string }) {
    return this.call(async () => {
      const configuration = await this.portalConfiguration();
      const s = await this.sdk.billingPortal.sessions.create({ customer: customerId, configuration, return_url: `${this.config.origin}/student/settings/billing`, ...(change ? { flow_data: { type: "subscription_update_confirm" as const, subscription_update_confirm: { subscription: change.subscriptionId, items: [{ id: change.itemId, price: change.priceId, quantity: 1 }] }, after_completion: { type: "redirect" as const, redirect: { return_url: `${this.config.origin}/student/settings/billing` } } } } : {}) });
      return hostedUrl(s.url, "billing.stripe.com");
    });
  }
  verify(body: string, signature: string): BillingEvent {
    let event: Stripe.Event;
    try { event = this.sdk.webhooks.constructEvent(body, signature, this.config.webhookSecret); } catch { throw new BillingError("BILLING_SIGNATURE", 400); }
    if (event.livemode !== (this.config.mode === "live")) throw new BillingError("BILLING_SIGNATURE", 400);
    const value = { id: event.id, type: event.type, live: event.livemode, subscriptionId: null, customerId: null, checkoutId: null, supported: false } as BillingEvent;
    if (["customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted", "customer.subscription.paused", "customer.subscription.resumed", "customer.subscription.pending_update_applied", "customer.subscription.pending_update_expired"].includes(event.type)) {
      const s = event.data.object as Stripe.Subscription;
      return { ...value, supported: true, subscriptionId: s.id, customerId: reference(s.customer) };
    }
    if (["checkout.session.completed", "checkout.session.async_payment_succeeded", "checkout.session.async_payment_failed"].includes(event.type)) {
      const s = event.data.object as Stripe.Checkout.Session;
      return { ...value, supported: s.mode === "subscription", subscriptionId: reference(s.subscription), customerId: reference(s.customer), checkoutId: s.id };
    }
    if (["invoice.paid", "invoice.payment_succeeded", "invoice.payment_failed", "invoice.payment_action_required", "invoice.marked_uncollectible", "invoice.voided"].includes(event.type)) {
      const invoice = event.data.object as Stripe.Invoice;
      return { ...value, supported: true, subscriptionId: reference(invoice.parent?.subscription_details?.subscription), customerId: reference(invoice.customer) };
    }
    // Schedule events give early visibility into pending downgrades.
    if (event.type.startsWith("subscription_schedule.")) {
      const schedule = event.data.object as Stripe.SubscriptionSchedule;
      return { ...value, supported: true, subscriptionId: reference(schedule.subscription) ?? reference(schedule.released_subscription), customerId: reference(schedule.customer) };
    }
    return value;
  }
}
