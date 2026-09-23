import "dotenv/config";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { beforeAll, beforeEach, afterEach, afterAll, describe, it, expect, vi } from "vitest";
const boundary = vi.hoisted(() => ({ fetch: vi.fn<typeof fetch>() }));
vi.mock("stripe", async importOriginal => {
  const original = await importOriginal<typeof import("stripe")>();
  return { ...original, default: class extends original.default {
    constructor(key: string, options: object = {}) { super(key, { ...options, maxNetworkRetries: 0, httpClient: original.default.createFetchHttpClient(boundary.fetch) }); }
  } };
});
import Stripe from "stripe";
import { db } from "@/server/db/client";
import { auth } from "@/server/auth/config";
import { billingConfig, planForPrice, priceFor, requireBilling } from "@/server/billing/config";
import { StripeBillingProvider } from "@/server/billing/stripe";
import { billingPrices, billingSummary, createBillingPortalSession, createCheckoutSession, createPlanChangeSession, getOrCreateBillingCustomer, reconcileBillingSubscriptions, syncSubscriptionFromProvider } from "@/server/billing/service";
import { assertModelTier, getUserEntitlements, savePlan, setEntitlementOverride, setUserPlan } from "@/server/entitlements/service";
import { DEVELOPMENT_PLANS } from "@/server/entitlements/config";
import { readUsage } from "@/server/entitlements/usage";
import { writeUsageRecord } from "@/server/ai/usage/records";
import { createCourse, listCourses } from "@/server/services/academic";
import * as checkoutRoute from "@/app/api/student/billing/checkout/route";
import * as portalRoute from "@/app/api/student/billing/portal/route";
import * as changeRoute from "@/app/api/student/billing/change/route";
import * as summaryRoute from "@/app/api/student/billing/route";
import * as webhookRoute from "@/app/api/billing/webhook/route";
import { reconcileBillingJob } from "@/server/jobs/reconcile-billing";
import { registerBillingReconciliationSchedule } from "@/server/jobs/schedule";
import { getBackgroundJob } from "@/server/jobs/registry";

const secret = "whsec_billing_fixture_secret";
const priceMapping = { student: { monthly: "price_student", yearly: "price_student_year" }, pro: { monthly: "price_pro", yearly: "price_pro_year" } };
const selection = { planCode: "student", billingInterval: "monthly" as const };
const units: Record<string, number> = { price_student: 1000, price_pro: 2500, price_student_year: 10000, price_pro_year: 25000 };
let owner: { id: string; headers: Headers }, other: typeof owner;
let subscription: Stripe.Subscription;
let subscriptions: Map<string, Stripe.Subscription>;
let sessions: Map<string, Stripe.Checkout.Session>;
let customerCount: number, sessionCount: number;
let provider: StripeBillingProvider;
let outage = false;
let portalConfig: Stripe.BillingPortal.Configuration;
let requests: { path: string; method: string; data: URLSearchParams }[];
const stamp = (date = new Date()) => Math.floor(date.getTime() / 1000);
const makeSubscription = (overrides: Partial<Stripe.Subscription> = {}) => ({
  id: "sub_main", object: "subscription", customer: "cus_owner", created: stamp() - 90 * 86400, livemode: false, status: "active", cancel_at_period_end: false, cancel_at: null, trial_end: null, pause_collection: null,
  items: { object: "list", has_more: false, data: [{ id: "si_main", quantity: 1, price: { id: "price_student" }, current_period_start: stamp() - 10 * 86400, current_period_end: stamp() + 20 * 86400 }] }, latest_invoice: { id: "in_fixture", created: stamp(), status: "paid" }, schedule: null, ...overrides,
} as Stripe.Subscription);
function price(id: string) { return { id, object: "price", product: "prod_platform", active: true, livemode: false, currency: "usd", unit_amount: units[id] ?? 1000, billing_scheme: "per_unit", recurring: { interval: id.endsWith("year") ? "year" : "month", interval_count: 1, usage_type: "licensed" } }; }
function portalConfiguration() { return { id: "bpc_test", object: "billing_portal.configuration", active: true, livemode: false, features: { payment_method_update: { enabled: true }, invoice_history: { enabled: true }, subscription_cancel: { enabled: true, mode: "at_period_end" }, subscription_update: { enabled: true, default_allowed_updates: ["price"], proration_behavior: "always_invoice", products: [{ product: "prod_platform", prices: Object.keys(units) }], schedule_at_period_end: { conditions: [{ type: "decreasing_item_amount" }, { type: "shortening_interval" }] } } } } as Stripe.BillingPortal.Configuration; }
async function transport(url: string | URL | Request, init?: RequestInit) {
  const target = new URL(String(url));
  expect(target.hostname).toBe("api.stripe.com");
  const data = new URLSearchParams(String(init?.body ?? ""));
  const path = target.pathname, method = init?.method ?? "GET";
  requests.push({ path, method, data });
  if (outage) return Response.json({ error: { type: "api_error", message: "RAW SECRET PRIVATE PROVIDER FAILURE" } }, { status: 503 });
  if (path === "/v1/customers" && method === "POST") return Response.json({ id: `cus_${data.get("metadata[platformUserId]") === owner.id ? "owner" : "other"}`, object: "customer", created: ++customerCount });
  if (path.startsWith("/v1/prices/")) return Response.json(price(path.split("/").at(-1)!));
  if (path === "/v1/subscriptions") return Response.json({ object: "list", has_more: false, data: [...subscriptions.values()].filter(s => s.customer === target.searchParams.get("customer")) });
  if (path.startsWith("/v1/subscriptions/")) { const s = subscriptions.get(path.split("/").at(-1)!); return s ? Response.json(s) : Response.json({ error: { type: "invalid_request_error", message: "Missing" } }, { status: 404 }); }
  if (path === "/v1/checkout/sessions" && method === "POST") {
    const id = `cs_${++sessionCount}`;
    const s = { id, status: "open", url: `https://checkout.stripe.com/c/pay/${id}` } as Stripe.Checkout.Session;
    sessions.set(id, s); return Response.json(s);
  }
  if (path.startsWith("/v1/checkout/sessions/")) return Response.json(sessions.get(path.split("/").at(-1)!));
  if (path === "/v1/billing_portal/configurations/bpc_test") return Response.json(portalConfig);
  if (path === "/v1/billing_portal/sessions") return Response.json({ id: "bps_test", url: "https://billing.stripe.com/p/session/test" });
  throw new Error(`Unmocked Stripe boundary ${method} ${path}`);
}
async function actor() {
  const response = await auth().api.signUpEmail({ body: { name: "Billing Test", email: `billing-${randomUUID()}@example.test`, password: "Billing-test-passphrase-2026!" }, asResponse: true });
  expect(response.status).toBe(200);
  const { user } = await response.json() as { user: { id: string } };
  return { id: user.id, headers: new Headers({ cookie: response.headers.getSetCookie().map(c => c.split(";")[0]).join("; "), origin: process.env.BETTER_AUTH_URL!, "content-type": "application/json" }) };
}
beforeAll(async () => { owner = await actor(); other = await actor(); });
beforeEach(async () => {
  vi.stubEnv("BILLING_ENABLED", "true"); vi.stubEnv("BILLING_MODE", "test"); vi.stubEnv("BILLING_ENVIRONMENT", "development"); vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_billing_fixture"); vi.stubEnv("STRIPE_WEBHOOK_SECRET", secret); vi.stubEnv("BILLING_CURRENCY", "usd"); vi.stubEnv("STRIPE_PORTAL_CONFIGURATION_ID", "bpc_test"); vi.stubEnv("BILLING_PRICES_JSON", JSON.stringify(priceMapping)); vi.stubEnv("BILLING_GRACE_DAYS", "3");
  const users = [owner.id, other.id];
  await db().$transaction([db().billingCheckout.deleteMany({ where: { userId: { in: users } } }), db().billingSubscription.deleteMany({ where: { userId: { in: users } } }), db().billingCustomer.deleteMany({ where: { userId: { in: users } } }), db().billingWebhookEvent.deleteMany({ where: { providerEventId: { startsWith: "evt_test_" } } }), db().userEntitlementOverride.deleteMany({ where: { userId: { in: users } } }), db().entitlementEvent.deleteMany({ where: { userId: { in: users } } }), db().aIUsageRecord.deleteMany({ where: { userId: { in: users } } })]);
  await setUserPlan(owner.id, "free"); await setUserPlan(other.id, "free");
  subscription = makeSubscription(); subscriptions = new Map(); sessions = new Map(); requests = []; customerCount = 0; sessionCount = 0; outage = false; portalConfig = portalConfiguration();
  boundary.fetch.mockReset().mockImplementation(transport); provider = new StripeBillingProvider(requireBilling());
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
afterAll(async () => { await db().user.deleteMany({ where: { id: { in: [owner?.id, other?.id].filter(Boolean) } } }); await db().billingWebhookEvent.deleteMany({ where: { providerEventId: { startsWith: "evt_test_" } } }); await db().plan.deleteMany({ where: { code: "billing-test-limited" } }); await db().$disconnect(); });
async function attach() { await getOrCreateBillingCustomer(owner.id, provider); subscriptions.set(subscription.id, subscription); }
function event(type = "customer.subscription.updated", object: unknown = subscription, id = `evt_test_${randomUUID()}`, created = stamp()) { return { id, object: "event", type, livemode: false, created, data: { object } }; }
function signed(value: unknown, signingSecret = secret) { const body = JSON.stringify(value); return new Request("http://localhost:3000/api/billing/webhook", { method: "POST", body, headers: { "stripe-signature": provider.sdk.webhooks.generateTestHeaderString({ payload: body, secret: signingSecret }) } }); }
async function deliver(type = "customer.subscription.updated", object: unknown = subscription) { return webhookRoute.POST(signed(event(type, object))); }
const post = (path: string, body: unknown, user = owner) => new Request(`http://localhost:3000/api/student/billing/${path}`, { method: "POST", headers: user.headers, body: JSON.stringify(body) });

 describe.sequential("billing configuration and checkout", () => {
  it("pauses new checkout without disabling existing customer portal or signed webhooks", async () => {
    await attach(); vi.stubEnv("BILLING_CHECKOUT_ENABLED", "false");
    expect((await checkoutRoute.POST(post("checkout", selection))).status).toBe(503);
    expect(requests.some(r => r.path === "/v1/checkout/sessions")).toBe(false);
    expect((await portalRoute.POST(post("portal", {}))).status).toBe(200);
    expect((await deliver()).status).toBe(200);
  });
  it("is disabled without secrets and performs no provider calls", async () => { vi.stubEnv("BILLING_ENABLED", "false"); vi.stubEnv("STRIPE_SECRET_KEY", ""); expect(billingConfig()).toEqual({ enabled: false }); expect(await billingPrices()).toEqual([]); expect((await checkoutRoute.POST(post("checkout", selection))).status).toBe(503); expect(boundary.fetch).not.toHaveBeenCalled(); });
  it("validates environment, modes, duplicate prices and server-side currency", () => {
    const env = { ...process.env };
    expect(() => billingConfig({ ...env, BILLING_ENVIRONMENT: "production" })).toThrow();
    expect(() => billingConfig({ ...env, NODE_ENV: "production" })).toThrow();
    expect(() => billingConfig({ ...env, BILLING_PRICES_JSON: '{"student":{"monthly":"price_a"},"pro":{"monthly":"price_a"}}' })).toThrow();
    expect(() => billingConfig({ ...env, STRIPE_SECRET_KEY: "sk_live_wrong" })).toThrow();
    expect(() => billingConfig({ ...env, STRIPE_WEBHOOK_SECRET: "" })).toThrow();
    expect(() => billingConfig({ ...env, BILLING_ENABLED: "yes" })).toThrow();
    expect(billingConfig({ ...env, NODE_ENV: "production", BILLING_ENVIRONMENT: "staging", BETTER_AUTH_URL: "https://staging.example.test" }).enabled).toBe(true);
  });
  it("maps monthly/yearly plans centrally and retains disabled historical price mappings", () => {
    const config = requireBilling(); expect(priceFor(config, "student", "yearly")).toBe("price_student_year"); expect(planForPrice(config, "price_pro")).toEqual({ planCode: "pro", interval: "monthly" }); config.prices.pro.enabled = false; expect(() => priceFor(config, "pro", "monthly")).toThrow(); expect(planForPrice(config, "price_pro").planCode).toBe("pro");
  });
  it("requires authentication and same-origin requests", async () => {
    const request = new Request("http://localhost:3000/api/student/billing/checkout", { method: "POST", headers: { origin: process.env.BETTER_AUTH_URL!, "content-type": "application/json" }, body: JSON.stringify(selection) });
    expect((await checkoutRoute.POST(request)).status).toBe(401);
    const bad = post("checkout", selection); bad.headers.set("origin", "https://evil.test"); expect((await checkoutRoute.POST(bad)).status).toBe(403); expect(boundary.fetch).not.toHaveBeenCalled();
  });
  it("rejects frontend price/customer/status/user injection", async () => {
    for (const extra of [{ priceId: "price_pro" }, { userId: other.id }, { customerId: "cus_other" }, { status: "active" }, { amount: 1 }, { currency: "usd" }]) expect((await checkoutRoute.POST(post("checkout", { ...selection, ...extra }))).status).toBe(400);
    expect(boundary.fetch).not.toHaveBeenCalled();
  });
  it("rejects free, internal, inactive and unknown plans", async () => {
    for (const planCode of ["free", "internal-unlimited", "does-not-exist"]) await expect(createCheckoutSession(owner.id, { ...selection, planCode }, provider)).rejects.toMatchObject({ code: "BILLING_INVALID_PLAN" });
    expect(customerCount).toBe(0);
  });
  it("creates/reuses one customer under concurrent calls with a durable key", async () => {
    const rows = await Promise.all([getOrCreateBillingCustomer(owner.id, provider), getOrCreateBillingCustomer(owner.id, provider)]);
    expect(rows[0].id).toBe(rows[1].id); expect(customerCount).toBe(1);
    expect(requests.find(r => r.path === "/v1/customers")?.data.get("metadata[platformUserId]")).toBe(owner.id);
  });
  it("preserves customer idempotency after provider failure and refuses ambiguous old creation", async () => {
    outage = true; await expect(getOrCreateBillingCustomer(owner.id, provider)).rejects.toMatchObject({ code: "BILLING_UNAVAILABLE" });
    const row = await db().billingCustomer.findUniqueOrThrow({ where: { userId: owner.id } });
    outage = false; await getOrCreateBillingCustomer(owner.id, provider); expect((await db().billingCustomer.findUniqueOrThrow({ where: { userId: owner.id } })).id).toBe(row.id);
    await db().billingCustomer.update({ where: { userId: owner.id }, data: { providerCustomerId: null, createdAt: new Date(Date.now() - 2 * 86400000) } });
    await expect(getOrCreateBillingCustomer(owner.id, provider)).rejects.toMatchObject({ code: "BILLING_CONFLICT" });
  });
  it("creates hosted checkout and reuses the same session concurrently without granting a plan", async () => {
    const values = await Promise.all([createCheckoutSession(owner.id, selection, provider), createCheckoutSession(owner.id, selection, provider)]);
    expect(values[0]).toEqual(values[1]); expect(sessionCount).toBe(1); expect((await getUserEntitlements(owner.id)).plan.code).toBe("free");
    const body = requests.find(r => r.path === "/v1/checkout/sessions" && r.method === "POST")!.data;
    expect(body.get("line_items[0][price]")).toBe("price_student"); expect(body.get("customer")).toBe("cus_owner"); expect(body.get("success_url")).toBe(`${process.env.BETTER_AUTH_URL}/billing/success`); expect(body.get("mode")).toBe("subscription");
  });
  it("blocks duplicate subscription checkout even before webhook delivery", async () => { await attach(); await expect(createCheckoutSession(owner.id, selection, provider)).rejects.toMatchObject({ code: "BILLING_CONFLICT" }); expect(sessionCount).toBe(0); });
  it("retains a durable checkout intent after API failure and retries safely", async () => {
    await getOrCreateBillingCustomer(owner.id, provider);
    const base = boundary.fetch.getMockImplementation()!;
    boundary.fetch.mockImplementation(async (url, init) => String(url).includes("checkout/sessions") ? Response.json({ error: { message: "internal secret" } }, { status: 500 }) : base(url, init));
    await expect(createCheckoutSession(owner.id, selection, provider)).rejects.toMatchObject({ code: "BILLING_UNAVAILABLE" });
    const intent = await db().billingCheckout.findUniqueOrThrow({ where: { userId: owner.id } });
    boundary.fetch.mockImplementation(transport); await createCheckoutSession(owner.id, selection, provider);
    expect((await db().billingCheckout.findUniqueOrThrow({ where: { userId: owner.id } })).id).toBe(intent.id);
  });
  it("uses provider price data for display and supports yearly checkout", async () => { const values = await billingPrices(provider); expect(values).toContainEqual({ planCode: "pro", interval: "yearly", amount: 25000, currency: "usd" }); await createCheckoutSession(owner.id, { planCode: "pro", billingInterval: "yearly" }, provider); expect(requests.find(r => r.path === "/v1/checkout/sessions")?.data.get("line_items[0][price]")).toBe("price_pro_year"); });
  it("never grants subscription from success-page navigation or request query", async () => {
    const response = await summaryRoute.GET(new Request("http://localhost:3000/api/student/billing?plan=pro&session_id=cs_fake&userId=" + other.id, { headers: owner.headers }));
    expect(await response.json()).toMatchObject({ plan: { code: "free" }, confirmed: false });
    const source = await readFile("app/billing/success/page.tsx", "utf8"); expect(source).toContain("billingSummary(user.id)"); expect(source).not.toMatch(/setUserPlan|syncSubscription|searchParams/);
  });
});

describe.sequential("signed webhooks and authoritative synchronization", () => {
  it("verifies real SDK signatures using raw payload bytes", async () => { await attach(); expect((await deliver("customer.subscription.created")).status).toBe(200); expect((await getUserEntitlements(owner.id)).plan.code).toBe("student"); });
  it("rejects invalid, missing, expired, tampered and wrong-mode signatures", async () => {
    await attach(); expect((await webhookRoute.POST(signed(event(), "wrong"))).status).toBe(400);
    expect((await webhookRoute.POST(new Request("http://localhost:3000/api/billing/webhook", { method: "POST", body: "{}" }))).status).toBe(400);
    const body = JSON.stringify(event());
    const old = provider.sdk.webhooks.generateTestHeaderString({ payload: body, secret, timestamp: stamp() - 1000 });
    expect((await webhookRoute.POST(new Request("http://localhost:3000/api/billing/webhook", { method: "POST", body, headers: { "stripe-signature": old } }))).status).toBe(400);
    const wrong = { ...event(), livemode: true }; expect((await webhookRoute.POST(signed(wrong))).status).toBe(400);
    const tampered = signed(event()); const sig = tampered.headers.get("stripe-signature")!; expect((await webhookRoute.POST(new Request(tampered.url, { method: "POST", body: "{}", headers: { "stripe-signature": sig } }))).status).toBe(400);
    expect(await db().billingWebhookEvent.count({ where: { providerEventId: { startsWith: "evt_test_" } } })).toBe(0);
  });
  it("processes concurrent duplicate delivery once with one subscription", async () => {
    await attach(); const value = event("checkout.session.completed", { id: "cs_done", customer: "cus_owner", mode: "subscription", subscription: subscription.id });
    const results = await Promise.all([webhookRoute.POST(signed(value)), webhookRoute.POST(signed(value)), webhookRoute.POST(signed(value))]); expect(results.map(r => r.status)).toEqual([200, 200, 200]);
    expect(await db().billingSubscription.count({ where: { userId: owner.id } })).toBe(1); expect(await db().entitlementEvent.count({ where: { userId: owner.id, type: "billing:checkout_completed" } })).toBe(1);
    expect((await db().billingWebhookEvent.findUniqueOrThrow({ where: { providerEventId: value.id } })).status).toBe("processed");
  });
  it("ignores old event payload status and price in favor of provider truth", async () => {
    await attach(); subscription.items.data[0].price.id = "price_pro"; await deliver();
    const old = makeSubscription({ status: "canceled" }); const result = await webhookRoute.POST(signed(event("customer.subscription.deleted", old, undefined, stamp() - 86400)));
    expect(result.status).toBe(200); expect((await getUserEntitlements(owner.id)).plan.code).toBe("pro");
  });
  it("maps all provider statuses without using invoice events as status truth", async () => {
    await attach();
    for (const [raw, normalized] of [["active", "active"], ["past_due", "past-due"], ["unpaid", "expired"], ["incomplete", "expired"], ["incomplete_expired", "expired"], ["paused", "expired"], ["canceled", "cancelled"]] as const) {
      subscription.status = raw; expect((await deliver()).status).toBe(200); expect((await billingSummary(owner.id)).status).toBe(normalized);
    }
    subscription.status = "active"; expect((await deliver("invoice.payment_failed", { id: "in_failed", customer: "cus_owner", parent: { subscription_details: { subscription: subscription.id } } })).status).toBe(200);
    expect((await getUserEntitlements(owner.id)).plan.code).toBe("student");
  });
  it("does not grant paid access for incomplete checkout payment", async () => { await attach(); subscription.status = "incomplete"; expect((await deliver("checkout.session.completed", { id: "cs_complete", mode: "subscription", customer: "cus_owner", subscription: subscription.id })).status).toBe(200); expect((await getUserEntitlements(owner.id)).plan.code).toBe("free"); });
  it("records safe failures, returns retryable status and succeeds on retry", async () => {
    await attach(); const value = event(); outage = true; const failed = await webhookRoute.POST(signed(value)); expect(failed.status).toBe(503); expect(JSON.stringify(await failed.json())).not.toContain("SECRET");
    expect((await db().billingWebhookEvent.findUniqueOrThrow({ where: { providerEventId: value.id } })).status).toBe("failed"); expect((await getUserEntitlements(owner.id)).plan.code).toBe("free");
    outage = false; expect((await webhookRoute.POST(signed(value))).status).toBe(200); expect((await getUserEntitlements(owner.id)).plan.code).toBe("student");
  });
  it("ignores unrelated customers and unsupported event types", async () => { const unrelated = makeSubscription({ customer: "cus_unrelated" }); expect((await deliver("customer.subscription.updated", unrelated)).status).toBe(200); expect((await deliver("charge.refunded", {})).status).toBe(200); expect((await getUserEntitlements(owner.id)).plan.code).toBe("free"); });
  it("rejects a signed event with mismatched subscription customer and cross-user sync", async () => {
    await attach(); await getOrCreateBillingCustomer(other.id, provider);
    const foreign = makeSubscription({ customer: "cus_other" }); expect((await deliver("customer.subscription.updated", foreign)).status).toBe(503);
    await expect(syncSubscriptionFromProvider(subscription.id, provider, other.id)).rejects.toMatchObject({ code: "BILLING_OWNERSHIP" }); expect((await getUserEntitlements(other.id)).plan.code).toBe("free");
  });
  it("does not resurrect an older subscription after replacement", async () => {
    await attach(); await deliver(); subscription.status = "canceled";
    const next = makeSubscription({ id: "sub_next", created: stamp() - 1 }); next.items.data[0].price.id = "price_pro"; subscriptions.set(next.id, next);
    expect((await deliver("customer.subscription.created", next)).status).toBe(200);
    expect((await deliver("customer.subscription.deleted", subscription)).status).toBe(200); expect((await getUserEntitlements(owner.id)).plan.code).toBe("pro");
    expect((await db().billingCustomer.findUniqueOrThrow({ where: { userId: owner.id } })).currentSubscriptionId).toBe("sub_next");
  });
  it("fails closed on unknown price and can recover after config correction", async () => { await attach(); subscription.items.data[0].price.id = "price_unknown"; const value = event(); expect((await webhookRoute.POST(signed(value))).status).toBe(503); vi.stubEnv("BILLING_PRICES_JSON", JSON.stringify({ ...priceMapping, student: { monthly: "price_unknown" } })); expect((await webhookRoute.POST(signed(value))).status).toBe(200); });
  it("stores minimal metadata without raw event, payment or conversation data", async () => {
    await attach(); const value = event("customer.subscription.updated", { ...subscription, metadata: { prompt: "PRIVATE_PROMPT" }, card: { number: "PRIVATE_CARD" } }); await webhookRoute.POST(signed(value));
    const records = await db().billingWebhookEvent.findMany({ where: { providerEventId: value.id } }); expect(JSON.stringify(records)).not.toMatch(/PRIVATE_|data.object|rawPayload/);
    const publicResult = JSON.stringify(await billingSummary(owner.id)); expect(publicResult).not.toMatch(/cus_owner|sub_main|price_student|sk_test|whsec/);
    expect(await db().aIUsageRecord.count({ where: { userId: owner.id } })).toBe(0);
  });
});

describe.sequential("lifecycle, portal, entitlement quality and reconciliation", () => {
  it("uses hosted provider-native upgrade confirmation with server-owned customer and item", async () => {
    await attach(); await deliver(); const result = await createPlanChangeSession(owner.id, { planCode: "pro", billingInterval: "monthly" }, provider); expect(result.url).toContain("billing.stripe.com");
    const call = requests.find(r => r.path === "/v1/billing_portal/sessions")!.data;
    expect(call.get("customer")).toBe("cus_owner"); expect(call.get("flow_data[subscription_update_confirm][items][0][price]")).toBe("price_pro"); expect(call.get("flow_data[subscription_update_confirm][subscription]")).toBe("sub_main");
    expect((await getUserEntitlements(owner.id)).plan.code).toBe("student"); subscription.items.data[0].price.id = "price_pro"; await deliver(); expect((await getUserEntitlements(owner.id)).plan.code).toBe("pro");
    expect(await db().entitlementEvent.count({ where: { userId: owner.id, type: "billing:subscription_upgraded" } })).toBe(1);
  });
  it("keeps paid access until scheduled downgrade takes effect", async () => {
    await attach(); subscription.items.data[0].price.id = "price_pro"; await deliver();
    subscription.schedule = { phases: [{ start_date: subscription.items.data[0].current_period_end, items: [{ price: "price_student" }] }] } as Stripe.SubscriptionSchedule;
    await deliver(); expect((await getUserEntitlements(owner.id)).plan.code).toBe("pro"); expect((await billingSummary(owner.id)).pendingChange).toMatchObject({ planCode: "student", interval: "monthly" });
    expect(await db().entitlementEvent.count({ where: { userId: owner.id, type: "billing:subscription_downgrade_scheduled" } })).toBe(1);
    subscription.items.data[0].price.id = "price_student"; subscription.schedule = null; await deliver(); expect((await getUserEntitlements(owner.id)).plan.code).toBe("student");
  });
  it("cancels at period end, resumes, then expires without waiting for webhook", async () => {
    await attach(); subscription.cancel_at_period_end = true; await deliver(); expect((await billingSummary(owner.id)).cancelAtPeriodEnd).toBe(true); expect((await getUserEntitlements(owner.id)).plan.code).toBe("student");
    subscription.cancel_at_period_end = false; await deliver(); expect((await billingSummary(owner.id)).cancelAtPeriodEnd).toBe(false);
    const afterEnd = new Date((subscription.items.data[0].current_period_end + 1) * 1000); expect((await getUserEntitlements(owner.id, db(), afterEnd)).plan.code).toBe("free");
    subscription.status = "canceled"; await deliver("customer.subscription.deleted"); expect((await getUserEntitlements(owner.id)).plan.code).toBe("free");
  });
  it("allows resubscription after cancelled checkout history", async () => { await createCheckoutSession(owner.id, selection, provider); await attach(); await deliver(); expect(await db().billingCheckout.count({ where: { userId: owner.id } })).toBe(0); subscription.status = "canceled"; await deliver(); expect((await createCheckoutSession(owner.id, selection, provider)).url).toContain("cs_2"); });
  it("anchors past-due grace to provider invoice date and never extends it on retries", async () => {
    await attach(); subscription.status = "past_due"; const invoiceCreated = stamp() - 86400; subscription.latest_invoice = { id: "in_due", created: invoiceCreated } as Stripe.Invoice;
    await deliver("invoice.payment_failed", { customer: "cus_owner", parent: { subscription_details: { subscription: subscription.id } } });
    const first = await billingSummary(owner.id); await deliver(); expect((await billingSummary(owner.id)).graceUntil).toBe(first.graceUntil); expect((await getUserEntitlements(owner.id)).plan.code).toBe("student");
    expect((await getUserEntitlements(owner.id, db(), new Date((invoiceCreated + 3 * 86400 + 1) * 1000))).plan.code).toBe("free");
    subscription.status = "active"; await deliver("invoice.paid", { customer: "cus_owner", parent: { subscription_details: { subscription: subscription.id } } }); expect((await billingSummary(owner.id)).graceUntil).toBeNull();
  });
  it("maps trial metadata and expires safely without a trial-end event", async () => { await attach(); subscription.status = "trialing"; subscription.trial_end = stamp() + 86400; await deliver(); expect((await billingSummary(owner.id)).status).toBe("trialing"); expect((await getUserEntitlements(owner.id)).plan.code).toBe("student"); expect((await getUserEntitlements(owner.id, db(), new Date((subscription.trial_end + 1) * 1000))).plan.code).toBe("free"); });
  it("preserves explicit internal overrides through payment failure and cancellation", async () => { await setEntitlementOverride(owner.id, "ai.monthlyTokens", null, { reason: "Beta grant" }); await attach(); await deliver(); subscription.status = "canceled"; await deliver(); expect((await getUserEntitlements(owner.id)).values["ai.monthlyTokens"]).toBeNull(); });
  it("immediately updates model access without silently downgrading quality", async () => {
    await savePlan({ ...DEVELOPMENT_PLANS[1], code: "billing-test-limited", name: "Limited test", entitlements: { ...DEVELOPMENT_PLANS[1].entitlements, "ai.modelTier.max": "FAST" } });
    vi.stubEnv("BILLING_PRICES_JSON", JSON.stringify({ "billing-test-limited": { monthly: "price_student" }, pro: { monthly: "price_pro" } })); await attach(); await deliver();
    const before = await getUserEntitlements(owner.id); expect(() => assertModelTier(before.values, "REASONING")).toThrow();
    subscription.items.data[0].price.id = "price_pro"; await deliver(); expect(() => assertModelTier((DEVELOPMENT_PLANS[2].entitlements), "REASONING")).not.toThrow(); expect((await getUserEntitlements(owner.id)).values["ai.modelTier.max"]).toBe("REASONING");
  });
  it("aligns paid usage windows, applies upgraded limits, and retains usage history", async () => {
    await attach(); await deliver(); const s = subscription.items.data[0];
    for (const createdAt of [new Date((s.current_period_start - 1) * 1000), new Date((s.current_period_start + 1) * 1000)]) await writeUsageRecord({ id: randomUUID(), userId: owner.id, requestId: randomUUID(), provider: "fixture", model: "fixture", operationType: "text-generation", inputTokens: 10, outputTokens: 5, totalTokens: 15, usageSource: "provider", estimatedCostUsd: null, pricingVersion: null, latencyMs: 1, success: true, createdAt });
    const before = await getUserEntitlements(owner.id); expect(before.period.start).toEqual(new Date(s.current_period_start * 1000)); expect((await readUsage(before)).aiRequests).toBe(1);
    subscription.items.data[0].price.id = "price_pro"; await deliver(); const upgraded = await getUserEntitlements(owner.id); expect(upgraded.period).toEqual(before.period); expect(upgraded.values["ai.monthlyRequests"]!).toBeGreaterThan(before.values["ai.monthlyRequests"]!); expect((await readUsage(upgraded)).aiRequests).toBe(1); expect(await db().aIUsageRecord.count({ where: { userId: owner.id } })).toBe(2);
  });
  it("uses calendar-month windows for free users without creating fake subscriptions", async () => { const effective = await getUserEntitlements(owner.id); expect(effective.period.start.getUTCDate()).toBe(1); expect(await db().billingCustomer.count({ where: { userId: owner.id } })).toBe(0); expect((await billingSummary(owner.id)).canManage).toBe(false); });
  it("creates portal sessions only for authenticated owner's customer", async () => {
    await attach(); const response = await portalRoute.POST(post("portal", {})); expect(response.status).toBe(200); expect(requests.find(r => r.path === "/v1/billing_portal/sessions")?.data.get("customer")).toBe("cus_owner");
    expect((await portalRoute.POST(post("portal", { customerId: "cus_owner" }, other))).status).toBe(400); expect((await portalRoute.POST(post("portal", {}, other))).status).toBe(404);
    expect((await changeRoute.POST(post("change", { ...selection, subscriptionId: "sub_main" }, other))).status).toBe(400);
  });
  it("refuses portal policies allowing immediate cancellation or unscheduled downgrades", async () => { await attach(); portalConfig.features.subscription_cancel.mode = "immediately"; await expect(createBillingPortalSession(owner.id, provider)).rejects.toMatchObject({ code: "BILLING_CONFIGURATION" }); portalConfig = portalConfiguration(); portalConfig.features.subscription_update.schedule_at_period_end.conditions = []; await expect(createBillingPortalSession(owner.id, provider)).rejects.toMatchObject({ code: "BILLING_CONFIGURATION" }); });
  it("leaves academic reads and entitlements available during provider outage", async () => {
    await attach(); await deliver(); const course = await createCourse(owner.id, { courseCode: "BILL" + randomUUID().slice(0, 4), courseName: "Billing outage", semester: "Fall", professor: "", description: "" }); outage = true;
    const response = await portalRoute.POST(post("portal", {})); expect(response.status).toBe(503); expect(JSON.stringify(await response.json())).not.toContain("PRIVATE");
    expect((await listCourses(owner.id)).some(c => c.id === course.id)).toBe(true); expect((await getUserEntitlements(owner.id)).plan.code).toBe("student"); expect((await billingSummary(owner.id)).plan.code).toBe("student");
  });
  it("reconciles drift and missing initial webhook with bounded provider reads", async () => {
    await createCheckoutSession(owner.id, selection, provider); subscriptions.set(subscription.id, subscription);
    expect(await reconcileBillingSubscriptions(provider, 1)).toMatchObject({ checked: 1, synced: 1, failed: 0 }); expect((await getUserEntitlements(owner.id)).plan.code).toBe("student");
    subscription.items.data[0].price.id = "price_pro"; await db().billingCustomer.update({ where: { userId: owner.id }, data: { lastReconciledAt: null } }); expect((await reconcileBillingSubscriptions(provider)).synced).toBe(1); expect((await getUserEntitlements(owner.id)).plan.code).toBe("pro"); expect((await reconcileBillingSubscriptions(provider)).checked).toBe(0);
  });
  it("records reconciliation failure counts without mutating confirmed access", async () => { await attach(); await deliver(); outage = true; expect(await reconcileBillingSubscriptions(provider)).toMatchObject({ checked: 1, synced: 0, failed: 1 }); expect((await getUserEntitlements(owner.id)).plan.code).toBe("student"); });
  it("registers bounded reconciliation in the existing worker and disables it with billing", async () => {
    expect(getBackgroundJob(reconcileBillingJob.name)).toBe(reconcileBillingJob); vi.stubEnv("BILLING_ENABLED", "false"); const schedule = vi.fn(); expect(await registerBillingReconciliationSchedule({ schedule } as never)).toBe(false); expect(schedule).not.toHaveBeenCalled(); expect(await reconcileBillingJob.handler({ payload: { version: 1 }, signal: new AbortController().signal, attempt: 1, jobRunId: "fixture" })).toEqual({ skipped: true });
  });
});

describe.sequential("billing failure boundaries", () => {
  it("requires safe price currency, interval and subscription shape", async () => {
    const base = boundary.fetch.getMockImplementation()!;
    boundary.fetch.mockImplementation(async (url, init) => String(url).includes("/prices/") ? Response.json({ ...price("price_student"), currency: "eur" }) : base(url, init));
    await expect(createCheckoutSession(owner.id, selection, provider)).rejects.toMatchObject({ code: "BILLING_CONFIGURATION" });
    boundary.fetch.mockImplementation(transport); await attach(); subscription.items.data[0].quantity = 2;
    expect((await deliver()).status).toBe(503); expect((await getUserEntitlements(owner.id)).plan.code).toBe("free");
  });
  it("creates no checkout for a retired price and allows its existing subscription sync", async () => {
    vi.stubEnv("BILLING_PRICES_JSON", JSON.stringify({ ...priceMapping, student: { ...priceMapping.student, enabled: false } }));
    await expect(createCheckoutSession(owner.id, selection, provider)).rejects.toMatchObject({ code: "BILLING_INVALID_PLAN" });
    await attach(); expect((await deliver()).status).toBe(200); expect((await getUserEntitlements(owner.id)).plan.code).toBe("student");
  });
  it("resumes an open checkout but never reuses an expired session", async () => {
    const first = await createCheckoutSession(owner.id, selection, provider); sessions.get("cs_1")!.status = "expired";
    const next = await createCheckoutSession(owner.id, selection, provider); expect(next.url).not.toBe(first.url); expect(sessionCount).toBe(2);
  });
  it("rejects changing the price of an unresolved checkout", async () => { await createCheckoutSession(owner.id, selection, provider); await expect(createCheckoutSession(owner.id, { planCode: "pro", billingInterval: "monthly" }, provider)).rejects.toMatchObject({ code: "BILLING_CONFLICT" }); expect(sessionCount).toBe(1); });
  it("keeps the durable key after an ambiguous remote checkout success", async () => {
    const base = boundary.fetch.getMockImplementation()!;
    let saved: Response | null = null;
    const keys: string[] = [];
    boundary.fetch.mockImplementation(async (url, init) => {
      if (String(url).endsWith("/checkout/sessions") && init?.method === "POST") {
        keys.push(new Headers(init.headers).get("idempotency-key")!);
        if (saved) return saved.clone();
        saved = await base(url, init); throw new Error("Connection lost after remote creation");
      }
      return base(url, init);
    });
    await expect(createCheckoutSession(owner.id, selection, provider)).rejects.toMatchObject({ code: "BILLING_UNAVAILABLE" });
    const result = await createCheckoutSession(owner.id, selection, provider); expect(result.url).toContain("cs_1"); expect(sessionCount).toBe(1); expect(keys[0]).toBe(keys[1]);
  });
  it("rejects portal configuration drift and foreign redirect URLs", async () => {
    await attach(); portalConfig.features.subscription_update.products![0].prices.push("price_unconfigured");
    await expect(createBillingPortalSession(owner.id, provider)).rejects.toMatchObject({ code: "BILLING_CONFIGURATION" });
    portalConfig = portalConfiguration(); const base = boundary.fetch.getMockImplementation()!;
    boundary.fetch.mockImplementation(async (url, init) => String(url).endsWith("/billing_portal/sessions") ? Response.json({ url: "https://evil.example/billing" }) : base(url, init));
    await expect(createBillingPortalSession(owner.id, provider)).rejects.toMatchObject({ code: "BILLING_UNAVAILABLE" });
  });
  it("preserves academic data and usage when a downgrade has already exceeded lower limits", async () => {
    await attach(); subscription.items.data[0].price.id = "price_pro"; await deliver();
    const course = await createCourse(owner.id, { courseCode: randomUUID().slice(0, 6), courseName: "Retain", semester: "Fall", description: "", professor: "" });
    await writeUsageRecord({ id: randomUUID(), userId: owner.id, requestId: randomUUID(), provider: "fixture", model: "fixture", operationType: "text-generation", inputTokens: 30000000, outputTokens: 0, totalTokens: 30000000, usageSource: "provider", estimatedCostUsd: null, pricingVersion: null, latencyMs: 1, success: true, createdAt: new Date() });
    subscription.items.data[0].price.id = "price_student"; await deliver();
    const effective = await getUserEntitlements(owner.id); expect((await readUsage(effective)).aiTokens).toBeGreaterThan(effective.values["ai.monthlyTokens"]!);
    expect((await listCourses(owner.id)).some(c => c.id === course.id)).toBe(true); expect(await db().aIUsageRecord.count({ where: { userId: owner.id } })).toBe(1);
  });
  it("registers the enabled reconciliation schedule with the existing job policy", async () => {
    vi.stubEnv("BACKGROUND_JOB_SCHEDULE_ENABLED", "true"); const schedule = vi.fn();
    expect(await registerBillingReconciliationSchedule({ schedule } as never)).toBe(true);
    expect(schedule).toHaveBeenCalledWith("reconcile-billing-subscriptions", "*/10 * * * *", { version: 1 }, expect.objectContaining({ expireInSeconds: 300, group: { id: "billing-reconciliation" } }));
  });
  it("bounds raw webhook bodies before SDK parsing or persistence", async () => { const request = new Request("http://localhost:3000/api/billing/webhook", { method: "POST", body: "x".repeat(1024 * 1024 + 1), headers: { "stripe-signature": "oversize" } }); expect((await webhookRoute.POST(request)).status).toBe(413); expect(boundary.fetch).not.toHaveBeenCalled(); });
});
