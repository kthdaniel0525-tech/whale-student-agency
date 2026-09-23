# Billing & Subscription Management

Stripe is the sole billing adapter. Billing writes normalized `UserSubscription` state; the existing Entitlement Service remains the feature-access authority. There is no billing-specific AI routing, prompt trimming, model downgrade, card form, or payment credential storage.

## Architecture and policies

- `BillingCustomer` maps one authenticated user to a server-owned Stripe customer. Customer creation uses a durable idempotency key and a renewable customer lease. Short user-row transactions fence local writes; provider calls run outside transactions. After an ambiguous creation failure older than 23 hours, creation fails closed instead of reusing an expired Stripe idempotency key. An operator must recover the original customer mapping from Stripe before retrying.
- `BillingCheckout` holds one durable checkout intent per user. Retries reuse the server-selected price and session; concurrent clicks cannot create separate subscriptions. The provider is checked for an existing ongoing subscription even if its first webhook was missed. Pending sessions last two hours; users may resume the original checkout. To select a different price while it is open, finish or let that session expire. A confirmed subscription clears the intent.
- `BillingSubscription` retains provider mapping, normalized status, verified price, billing interval and any scheduled change. Historical mappings prevent old cancellation events from replacing a newer subscription.
- `BillingWebhookEvent` stores only event ID/type, processing state, timestamps and a safe failure code. It does not store raw webhook bodies, card data, invoices, customer addresses or AI content.
- Plan/price mappings resolve on the server from `BILLING_PRICES_JSON`. The public price and checkout price come from the same Stripe Price, with currency, recurring interval, fixed quantity and mode checks. Keep retired price mappings with `enabled:false` so existing subscriptions remain synchronizable.
- All enabled public plan prices must belong to **one Stripe Product**. Stripe's portal requires this for native end-of-period downgrades. The product may have Student/Pro monthly and yearly prices. This phase supports fixed recurring prices in one configured two-decimal currency: USD, CAD, EUR, GBP, AUD or NZD.
- Upgrades are confirmed and charged through Stripe's hosted update flow, with native proration (`always_invoice`). Decreasing-price and shortening-interval changes are scheduled at period end. No application code calculates proration. The portal policy is validated before creating checkout/portal sessions, including the exact allowed prices, cancellation timing and scheduled-downgrade conditions.
- Normal cancellations take effect at period end. The customer can renew a scheduled cancellation in the hosted portal before expiry. No immediate-cancellation button exists in the app.
- `active` / `trialing` / `past_due` / `canceled` map to `active` / `trialing` / `past-due` / `cancelled`; incomplete, unpaid or paused subscriptions do not grant ongoing paid access. Trial metadata is supported, but checkout does not automatically grant trials.
- Past-due grace defaults to three days from the authoritative latest invoice's creation time. Repeated webhook retries do not extend grace. Missing invoice evidence gives no grace. Trial, grace and period expiration are enforced by the Entitlement Service even if the terminal webhook is delayed.
- Existing per-capability overrides retain precedence over the paid/free plan; billing never deletes those grants. Global feature vetoes still apply. Expired/cancelled subscriptions fall back to the configured free/base plan.
- Paid allowance windows use verified subscription-item period dates. A mid-period upgrade applies the new limits immediately without clearing usage. Provider-driven interval changes use the provider's new period. Free users retain calendar-month windows. Historical `AIUsageRecord` data is never deleted.

## Webhooks and drift recovery

`POST /api/billing/webhook` verifies the Stripe signature against the unmodified raw body, bounds it to 1 MB, and validates test/live mode. It is deliberately separate from browser CSRF/session authentication. All browser billing mutations require the normal authenticated session and same-origin check; their strict input schemas accept only plan code and interval, or an empty portal request.

Subscribe to these snapshot events using the SDK's API version **2026-08-26.dahlia**:

- `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`
- `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `customer.subscription.paused`, `customer.subscription.resumed`, `customer.subscription.pending_update_applied`, `customer.subscription.pending_update_expired`
- `invoice.paid`, `invoice.payment_succeeded`, `invoice.payment_failed`, `invoice.payment_action_required`, `invoice.marked_uncollectible`, `invoice.voided`
- `subscription_schedule.created`, `subscription_schedule.updated`, `subscription_schedule.released`, `subscription_schedule.canceled`, `subscription_schedule.completed`, `subscription_schedule.aborted`

The service fetches the current subscription rather than applying event payload deltas. A renewable per-customer lease is acquired **before** that fetch. Provider calls happen outside database transactions; short fenced transactions commit normalized state only while the lease remains current. Processing state and subscription changes commit atomically; duplicate event IDs return success without repeating changes. Different old events still fetch current truth. Failed important processing returns 503 for Stripe retry; unsupported events and customers outside this product are acknowledged without granting access. Refund events alone never infer cancellation.

`syncSubscriptionFromProvider()` performs trusted recovery. The existing background worker registers a bounded reconciliation sweep every ten minutes when billing and scheduling are enabled. It checks at most ten eligible customers per run, oldest checked first, with a six-hour per-customer minimum interval. Active/trialing/past-due/recoverable expired mappings and unresolved checkouts are eligible. This also discovers subscriptions whose initial webhook was lost. Failed checks are counted in the existing job result; they keep the local state and become eligible again after six hours. No free user with no provider history is polled.

There is no cross-request entitlement cache to invalidate: the committed `UserSubscription` update is visible at the next access boundary. Existing UI access refreshes on focus / every 30 seconds. Billing confirmation polls **local** state every five seconds; it never grants access from a success URL or a frontend session ID. Academic reads never call Stripe.

Safe product event hooks reuse `EntitlementEvent` with a `billing:` prefix: `checkout_started`, `checkout_completed`, `subscription_upgraded`, `subscription_downgrade_scheduled`, `subscription_cancelled`, and `subscription_updated`. They contain only plan/status metadata, not billing payloads or AI content.

## Local setup and manual verification

Billing is disabled by default; missing Stripe credentials do not break development or the existing plans. Do not put Stripe secrets in `NEXT_PUBLIC_*` or commit `.env`.

1. Create a Stripe sandbox/test Product with Student and Pro monthly prices, optionally yearly prices, all under the same Product. Set `BILLING_ENABLED=true`, `BILLING_ENVIRONMENT=development`, `BILLING_MODE=test`, `BILLING_CURRENCY=usd`, `STRIPE_SECRET_KEY`, and `BILLING_PRICES_JSON` in the local secret environment. All mapped plan codes must already be active/public in the Plan catalog. Production prices are supplied through deployment secrets/configuration, not committed IDs.
2. Install/sign in to the official Stripe CLI. Forward verified test events:
   ```bash
   stripe listen --forward-to localhost:3000/api/billing/webhook
   ```
   Set `STRIPE_WEBHOOK_SECRET` to the signing secret printed by this listener. The Dashboard endpoint secret and local CLI secret differ.
3. Run `npm run billing:configure` to create/update the hosted portal policy. Set the returned `STRIPE_PORTAL_CONFIGURATION_ID`. This script is an explicit provider configuration operation; normal app requests do not edit your Stripe portal setup. Configure Stripe business details and invoice/tax settings in its Dashboard as needed.
4. Start the app. Open `/plans`, subscribe, and confirm payment on **Stripe's test checkout only** with test card `4242 4242 4242 4242`, any future expiry and any three-digit CVC. Never use a real card for testing. The success page waits for verified local subscription state; inspect `/student/settings/billing` and existing feature access after the webhook.
5. Check upgrade confirmation, end-of-period downgrade, cancel and renew in the portal. Use a Stripe test clock or Dashboard test subscriptions to advance billing periods, exercise trial end, failed renewal, grace expiry and recovery. `4000 0000 0000 9995` is a Stripe test card for insufficient-funds failures. Use Stripe's current test-card documentation for authentication/renewal scenarios.
6. Resend a delivered webhook in the Dashboard/CLI and confirm one event record and unchanged period dates. Stop local forwarding temporarily, then run `BACKGROUND_JOB_SCHEDULE_ENABLED=true npm run jobs:worker` and let the scheduled sweep recover drift. Provider API outages should only affect billing actions; saved courses/documents must remain readable.

For staging builds set `BILLING_ENVIRONMENT=staging`, test mode, and an HTTPS authentication origin. A production deployment requires `BILLING_ENVIRONMENT=production`, live keys, live prices and a live portal. Startup validates enabled configuration. Production-mode builds reject `development` billing configuration, and a Vercel production deployment cannot label itself staging to allow test keys. Non-Vercel deployment operators must set the environment truthfully. Disabled billing exposes comparison/status without broken checkout buttons.

## Verification and current setup limitation

Automated tests use the real Stripe SDK's signature verification and a mocked HTTP transport; database integration uses PostgreSQL. They make no real Stripe charge and no AI call. Coverage includes configuration, secure checkout, durable idempotency, concurrent duplicate events, out-of-order updates, ownership, payment/trial lifecycle, scheduled changes, allowance periods, overrides, provider outages and reconciliation.

This workspace has no Stripe test credentials, Price IDs, webhook secret or portal configuration. Hosted test checkout/portal and real webhook forwarding must be verified after those are supplied. The implementation remains disabled until configured; automated results do not claim a live/test Stripe account verification.

## Files changed

- New contracts/provider/services: `lib/billing/types.ts`, `server/billing/{config,errors,types,stripe,service}.ts`
- Database: `prisma/schema.prisma`, `prisma/migrations/20260921190000_billing_subscriptions/migration.sql`
- API: `app/api/billing/webhook/route.ts`, `app/api/student/billing/route.ts`, `app/api/student/billing/{checkout,portal,change}/route.ts`, `server/api.ts`
- UI: `features/student/billing/billing.tsx`, `app/plans/page.tsx`, `app/billing/{success,cancelled}/page.tsx`, `app/student/settings/billing/page.tsx`, `features/student/entitlements/access.tsx`
- Worker: `server/jobs/reconcile-billing.ts`, `server/jobs/{registry,schedule,worker}.ts`
- Setup/validation: `.env.example`, `instrumentation.ts`, `scripts/configure-billing.ts`, `scripts/verify-migration.mjs`, `package.json`, `package-lock.json`
- Tests/docs: `tests/billing.test.ts`, `docs/billing-subscriptions.md`

## Provider references

- [Stripe portal configuration and downgrade constraints](https://docs.stripe.com/customer-management/configure-portal)
- [Hosted subscription confirmation flows](https://docs.stripe.com/customer-management/portal-deep-links)
- [Webhook signatures, retries and ordering](https://docs.stripe.com/webhooks)
- [Stripe test cards](https://docs.stripe.com/testing)

New checkout can be paused with `BILLING_CHECKOUT_ENABLED=false` while customer portal access and signed webhook processing remain enabled. Account deletion requires an explicit `PRIVACY_BILLING_RETENTION_DAYS` decision, expires open checkout and cancels ongoing subscriptions before deleting local customer/product records; ambiguous provider identities remain disabled for operator recovery. See `security-privacy-data-map.md`.
