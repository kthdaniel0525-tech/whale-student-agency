import "server-only";
import type { Prisma } from "@/generated/prisma/client";
import { billingSelection, type BillingSelection, type BillingStatus, type BillingSummary, type PublicPrice } from "@/lib/billing/types";
import { db } from "../db/client";
import { basePlanCode } from "../entitlements/config";
import { ensureDefaultSubscription, getUserEntitlements, lockEntitlementUser, publicPlanCatalog } from "../entitlements/service";
import { billingConfig, planForPrice, priceFor, requireBilling } from "./config";
import { BillingError } from "./errors";
import { StripeBillingProvider } from "./stripe";
import type { BillingEvent, BillingProvider } from "./types";
type Tx = Prisma.TransactionClient;
const transactionOptions = { timeout: 45000, maxWait: 10000 };
const terminal = (status: string) => ["cancelled", "expired"].includes(status);
export const billingProvider = () => new StripeBillingProvider(requireBilling());
async function purchasable(input: BillingSelection, provider: BillingProvider) {
  const selection = billingSelection.parse(input);
  await publicPlanCatalog();
  const plan = await db().plan.findUnique({ where: { code: selection.planCode } });
  if (!plan?.active || plan.internal || plan.code === basePlanCode()) throw new BillingError("BILLING_INVALID_PLAN", 400);
  const id = priceFor(requireBilling(), selection.planCode, selection.billingInterval);
  const price = await provider.price(id);
  if (!price.active || price.interval !== selection.billingInterval) throw new BillingError("BILLING_INVALID_PLAN", 400);
  return { plan, price };
}
export async function getOrCreateBillingCustomer(userId: string, provider: BillingProvider = billingProvider()) {
  // Persist identity before the remote operation. A retry after a DB failure keeps
  // the same Stripe idempotency key, including across processes and restarts.
  await ensureDefaultSubscription(userId);
  await db().billingCustomer.createMany({ data: [{ userId }], skipDuplicates: true });
  return db().$transaction(async tx => {
    await lockEntitlementUser(tx, userId);
    const row = await tx.billingCustomer.findUniqueOrThrow({ where: { userId } });
    if (row.providerCustomerId) return row;
    // Stripe only retains idempotency keys for at least 24h. Do not create a
    // second customer after an ambiguous old failure; operator reconciliation is required.
    if (Date.now() - row.createdAt.getTime() > 23 * 3600000) throw new BillingError("BILLING_CONFLICT", 409);
    const customerId = await provider.createCustomer(userId, `customer:${row.id}`);
    return tx.billingCustomer.update({ where: { id: row.id }, data: { providerCustomerId: customerId } });
  }, transactionOptions);
}
export async function createCheckoutSession(userId: string, input: BillingSelection, provider: BillingProvider = billingProvider()) {
  const { price } = await purchasable(input, provider);
  const customer = await getOrCreateBillingCustomer(userId, provider);
  const intent = await db().$transaction(async tx => {
    await lockEntitlementUser(tx, userId);
    // Also catches a successful checkout whose webhook has not reached us yet.
    if ((await provider.subscriptionIds(customer.providerCustomerId!)).length) throw new BillingError("BILLING_CONFLICT", 409);
    let pending = await tx.billingCheckout.findUnique({ where: { userId } });
    if (pending?.providerSessionId) {
      const state = await provider.checkoutState(pending.providerSessionId);
      if (state.status === "complete") throw new BillingError("BILLING_CONFLICT", 409);
      if (state.status === "expired") { await tx.billingCheckout.delete({ where: { id: pending.id } }); pending = null; }
    } else if (pending && pending.expiresAt <= new Date()) {
      // Any remotely created session for this durable key has also expired.
      await tx.billingCheckout.delete({ where: { id: pending.id } }); pending = null;
    }
    if (pending && pending.priceId !== price.id) throw new BillingError("BILLING_CONFLICT", 409);
    return pending ?? tx.billingCheckout.create({ data: { userId, priceId: price.id, expiresAt: new Date(Math.floor(Date.now() / 1000) * 1000 + 2 * 3600000) } });
  }, transactionOptions);
  return db().$transaction(async tx => {
    await lockEntitlementUser(tx, userId);
    const current = await tx.billingCheckout.findUnique({ where: { userId } });
    if (!current || current.id !== intent.id) throw new BillingError("BILLING_CONFLICT", 409);
    if (current.providerSessionId) {
      const state = await provider.checkoutState(current.providerSessionId);
      if (state.status !== "open" || !state.url) throw new BillingError("BILLING_CONFLICT", 409);
      return { url: state.url };
    }
    const session = await provider.checkout({ customerId: customer.providerCustomerId!, priceId: current.priceId, key: `checkout:${current.id}`, expiresAt: current.expiresAt });
    await tx.billingCheckout.update({ where: { id: current.id }, data: { providerSessionId: session.id } });
    await audit(tx, userId, "checkout_started", { planCode: input.planCode, interval: input.billingInterval });
    return { url: session.url };
  }, transactionOptions);
}
export async function createBillingPortalSession(userId: string, provider: BillingProvider = billingProvider()) {
  const customer = await db().billingCustomer.findUnique({ where: { userId } });
  if (!customer?.providerCustomerId) throw new BillingError("BILLING_NOT_FOUND", 404);
  return { url: await provider.portal(customer.providerCustomerId) };
}
export async function createPlanChangeSession(userId: string, input: BillingSelection, provider: BillingProvider = billingProvider()) {
  const { price } = await purchasable(input, provider);
  const customer = await db().billingCustomer.findUnique({ where: { userId } });
  if (!customer?.providerCustomerId || !customer.currentSubscriptionId) throw new BillingError("BILLING_NOT_FOUND", 404);
  const current = await provider.subscription(customer.currentSubscriptionId);
  if (current.customerId !== customer.providerCustomerId) throw new BillingError("BILLING_OWNERSHIP", 403);
  if (terminal(current.status)) throw new BillingError("BILLING_CONFLICT", 409);
  // Stripe owns confirmation, proration, payment authentication and scheduling.
  return { url: await provider.portal(customer.providerCustomerId, { subscriptionId: current.id, itemId: current.itemId, priceId: price.id }) };
}
async function audit(tx: Tx, userId: string, type: string, details: Prisma.InputJsonValue) {
  await tx.entitlementEvent.create({ data: { userId, type: `billing:${type}`, details } });
}
async function applySubscription(tx: Tx, userId: string, id: string, provider: BillingProvider) {
  // Caller holds the user's lock BEFORE fetching provider truth. Concurrent,
  // late and out-of-order events therefore cannot overwrite a newer local fetch.
  const customer = await tx.billingCustomer.findUniqueOrThrow({ where: { userId } });
  const s = await provider.subscription(id);
  if (s.id !== id || s.customerId !== customer.providerCustomerId) throw new BillingError("BILLING_OWNERSHIP", 403);
  const owner = await tx.billingSubscription.findUnique({ where: { providerSubscriptionId: id } });
  if (owner && owner.userId !== userId) throw new BillingError("BILLING_OWNERSHIP", 403);
  const config = requireBilling();
  const mapping = planForPrice(config, s.priceId);
  const price = await provider.price(s.priceId);
  if (price.interval !== mapping.interval) throw new BillingError("BILLING_CONFIGURATION");
  const plan = await tx.plan.findUnique({ where: { code: mapping.planCode } });
  if (!plan?.active || plan.internal || plan.code === basePlanCode()) throw new BillingError("BILLING_CONFIGURATION");
  const pending = s.pending ? planForPrice(config, s.pending.priceId) : null;
  let before = await tx.billingSubscription.findUnique({ where: { providerSubscriptionId: customer.currentSubscriptionId ?? "" } });
  if (before && before.providerSubscriptionId !== id && !terminal(before.status)) {
    await applySubscription(tx, userId, before.providerSubscriptionId, provider);
    before = await tx.billingSubscription.findUnique({ where: { providerSubscriptionId: before.providerSubscriptionId } });
  }
  // Historical cancellation events must never demote a replacement subscription.
  const replaces = !before || before.providerSubscriptionId === id || terminal(before.status) && s.createdAt > before.providerCreatedAt;
  if (before && before.providerSubscriptionId !== id && !terminal(before.status) && !terminal(s.status)) throw new BillingError("BILLING_CONFLICT", 409);
  await tx.billingSubscription.upsert({ where: { providerSubscriptionId: id }, create: { userId, providerSubscriptionId: id, providerCreatedAt: s.createdAt, providerPriceId: s.priceId, billingInterval: mapping.interval, amount: price.amount, currency: price.currency, status: s.status, lastSyncedAt: new Date(), pendingPlanCode: pending?.planCode, pendingInterval: pending?.interval, pendingChangeAt: s.pending?.effectiveAt }, update: { providerPriceId: s.priceId, billingInterval: mapping.interval, amount: price.amount, currency: price.currency, status: s.status, lastSyncedAt: new Date(), pendingPlanCode: pending?.planCode ?? null, pendingInterval: pending?.interval ?? null, pendingChangeAt: s.pending?.effectiveAt ?? null } });
  if (!replaces) return;
  await ensureDefaultSubscription(userId, tx);
  const previous = await tx.userSubscription.findUniqueOrThrow({ where: { userId } });
  const graceUntil = s.status === "past-due" && s.delinquentSince ? new Date(s.delinquentSince.getTime() + config.graceDays * 86400000) : null;
  await tx.userSubscription.update({ where: { userId }, data: { planId: plan.id, status: s.status, currentPeriodStart: s.periodStart, currentPeriodEnd: s.periodEnd, cancelAtPeriodEnd: s.cancelAtPeriodEnd, trialEndsAt: s.trialEnd, graceUntil } });
  await tx.billingCustomer.update({ where: { userId }, data: { currentSubscriptionId: id } });
  if (!terminal(s.status)) await tx.billingCheckout.deleteMany({ where: { userId } });
  if (!before || before.providerPriceId !== s.priceId || previous.status !== s.status || previous.cancelAtPeriodEnd !== s.cancelAtPeriodEnd || before.pendingPlanCode !== (pending?.planCode ?? null)) {
    let event = "subscription_updated";
    if (s.status === "cancelled" || s.cancelAtPeriodEnd && !previous.cancelAtPeriodEnd) event = "subscription_cancelled";
    else if (pending && before?.pendingPlanCode !== pending.planCode) event = "subscription_downgrade_scheduled";
    else if (before && price.amount / (mapping.interval === "yearly" ? 12 : 1) > before.amount / (before.billingInterval === "yearly" ? 12 : 1)) event = "subscription_upgraded";
    await audit(tx, userId, event, { planCode: mapping.planCode, status: s.status, pendingPlanCode: pending?.planCode ?? null });
  }
  // Entitlement resolution deliberately has no cross-request cache. Updating
  // UserSubscription atomically is the invalidation; overrides are untouched.
}
export async function syncSubscriptionFromProvider(id: string, provider: BillingProvider = billingProvider(), expectedUserId?: string) {
  const known = await db().billingSubscription.findUnique({ where: { providerSubscriptionId: id } });
  const customer = known ? await db().billingCustomer.findUnique({ where: { userId: known.userId } }) : await db().billingCustomer.findUnique({ where: { providerCustomerId: (await provider.subscription(id)).customerId } });
  if (!customer || expectedUserId && customer.userId !== expectedUserId) throw new BillingError("BILLING_OWNERSHIP", 403);
  await db().$transaction(async tx => { await lockEntitlementUser(tx, customer.userId); await applySubscription(tx, customer.userId, id, provider); }, transactionOptions);
}
export async function processBillingEvent(event: BillingEvent, provider: BillingProvider) {
  await db().billingWebhookEvent.createMany({ data: [{ providerEventId: event.id, eventType: event.type }], skipDuplicates: true });
  try {
    return await db().$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "BillingWebhookEvent" WHERE "providerEventId"=${event.id} FOR UPDATE`;
      const record = await tx.billingWebhookEvent.findUniqueOrThrow({ where: { providerEventId: event.id } });
      if (record.status === "processed" || record.status === "ignored") return { received: true };
      const customer = event.customerId ? await tx.billingCustomer.findUnique({ where: { providerCustomerId: event.customerId } }) : null;
      if (event.supported && event.subscriptionId && customer) {
        await lockEntitlementUser(tx, customer.userId);
        await applySubscription(tx, customer.userId, event.subscriptionId, provider);
        if (event.checkoutId && event.type === "checkout.session.completed") {
          // Analytics only. This event alone never grants an entitlement.
          await audit(tx, customer.userId, "checkout_completed", {});
        }
      }
      await tx.billingWebhookEvent.update({ where: { id: record.id }, data: { status: event.supported && event.subscriptionId && customer ? "processed" : "ignored", processedAt: new Date(), failureCode: null } });
      return { received: true };
    }, transactionOptions);
  } catch (error) {
    const code = error instanceof BillingError ? error.code : "BILLING_STORAGE_FAILURE";
    await db().billingWebhookEvent.updateMany({ where: { providerEventId: event.id, status: { notIn: ["processed", "ignored"] } }, data: { status: "failed", failureCode: code } }).catch(() => {});
    throw error instanceof BillingError ? error : new BillingError("BILLING_UNAVAILABLE");
  }
}
export async function billingSummary(userId: string): Promise<BillingSummary> {
  const access = await getUserEntitlements(userId);
  const customer = await db().billingCustomer.findUnique({ where: { userId } });
  const mapping = customer?.currentSubscriptionId ? await db().billingSubscription.findUnique({ where: { providerSubscriptionId: customer.currentSubscriptionId } }) : null;
  const { subscription: s } = access;
  return { enabled: (() => { const config = billingConfig(); return config.enabled && !!config.portalConfigurationId; })(), plan: { code: access.plan.code, name: access.plan.name }, status: s.status as BillingStatus, renewsAt: s.currentPeriodEnd?.toISOString() ?? null, cancelAtPeriodEnd: s.cancelAtPeriodEnd, trialEndsAt: s.trialEndsAt?.toISOString() ?? null, graceUntil: s.graceUntil?.toISOString() ?? null,
    price: mapping ? { planCode: s.plan.code, interval: mapping.billingInterval as BillingSelection["billingInterval"], amount: mapping.amount, currency: mapping.currency } : null,
    canManage: !!customer?.providerCustomerId, pendingChange: mapping?.pendingPlanCode && mapping.pendingInterval && mapping.pendingChangeAt ? { planCode: mapping.pendingPlanCode, interval: mapping.pendingInterval as BillingSelection["billingInterval"], effectiveAt: mapping.pendingChangeAt.toISOString() } : null,
    confirmed: !!mapping && ["active", "trialing"].includes(s.status) && access.plan.id === s.planId };
}
export async function billingPrices(provider?: BillingProvider): Promise<PublicPrice[]> {
  const config = billingConfig();
  if (!config.enabled || !config.portalConfigurationId) return [];
  const boundary = provider ?? billingProvider();
  const plans = await publicPlanCatalog();
  const result: PublicPrice[] = [];
  for (const plan of plans) for (const interval of ["monthly", "yearly"] as const) {
    if (!config.prices[plan.code]?.enabled || !config.prices[plan.code][interval] || plan.code === basePlanCode()) continue;
    const { price } = await purchasable({ planCode: plan.code, billingInterval: interval }, boundary);
    result.push({ planCode: plan.code, interval, amount: price.amount, currency: price.currency });
  }
  return result;
}
export async function reconcileBillingSubscriptions(provider: BillingProvider = billingProvider(), limit = 25, signal?: AbortSignal) {
  const rows = await db().billingCustomer.findMany({ where: { providerCustomerId: { not: null }, OR: [{ lastReconciledAt: null }, { lastReconciledAt: { lt: new Date(Date.now() - 6 * 3600000) } }], user: { OR: [{ billingSubscriptions: { some: { status: { in: ["active", "trialing", "past-due", "expired"] } } } }, { billingCheckout: { isNot: null } }] } }, orderBy: [{ lastReconciledAt: { sort: "asc", nulls: "first" } }, { id: "asc" }], take: Math.min(Math.max(limit, 1), 50) });
  let synced = 0, failed = 0;
  for (const customer of rows) {
    if (signal?.aborted) break;
    try {
      // Discover subscriptions even when the initial checkout webhook was lost.
      const ids = new Set(customer.currentSubscriptionId ? [customer.currentSubscriptionId] : []);
      for (const id of await provider.subscriptionIds(customer.providerCustomerId!)) ids.add(id);
      for (const id of ids) await syncSubscriptionFromProvider(id, provider, customer.userId);
      if (!ids.size) await db().billingCheckout.deleteMany({ where: { userId: customer.userId, expiresAt: { lt: new Date() } } });
      synced++;
    } catch { failed++; }
    await db().billingCustomer.update({ where: { id: customer.id }, data: { lastReconciledAt: new Date() } });
  }
  return { checked: rows.length, synced, failed };
}
