# Plans & Entitlements

This phase adds product access and allowances only. It does not add checkout, a billing provider, invoices, overages, payment webhooks, or an administration UI.

## Architecture and configuration

- `Plan` is an extensible, versioned catalog with a validated entitlement map. Codes are strings, not a closed marketing-plan enum. `lib/entitlements/types.ts` is the shared, secret-free contract for boolean capabilities, nullable numeric limits, and maximum model tier.
- `UserSubscription` belongs to exactly one user and references a plan. The resolver understands active, trialing, past-due, cancelled, and expired states; period dates, trial end, cancellation at period end, and optional grace are independent of any payment provider.
- `UserEntitlementOverride` supplies a typed value with optional expiry and operator reason. `EntitlementEvent` records plan/trial changes and override additions/removals without prompts or student content.
- `EntitlementUsageAdmission` reserves in-flight AI capacity and records accepted document-processing requests. It is not a second completed-token ledger. `AIUsageRecord` remains authoritative for recorded provider usage.
- Resolution order is plan → unexpired user override → global feature veto. `DEFAULT_PLAN_CODE` defaults to `free`; an internal or inactive plan cannot be the base/default. Invalid configuration fails closed.
- New signups receive a subscription through the existing authentication hook. Existing users are lazily and idempotently assigned the configured default on first access. No product code needs to interpret a missing subscription.
- There is deliberately no cross-request entitlement cache. Plan, override and flag changes take effect at the next boundary. The UI refreshes on focus and every 30 seconds; UI state never authorizes server work.

`server/entitlements/config.ts` contains generous beta/development defaults for Free, Student, Pro and internal-unlimited. All currently working features and quality tiers remain enabled by default. Public tiers vary monthly usage/courses/accounts; document/file and active-memory defaults stay within existing safety limits. These are not final commercial offers. Null means no **product** limit; safety guardrails always remain in force.

Defaults seed missing plans only. Use `npm run plans:sync` explicitly to apply edited development definitions to existing catalog rows; normal reads never overwrite operator-managed plans. `savePlan()` supports additional catalog entries and immediate updates. Global switches use the separate server-only `ENTITLEMENT_FEATURE_FLAGS_JSON`, for example `{"integration.calendar":false}`. A true flag cannot grant a capability denied by the plan or override.

## Internal operations and security

Server-only methods include `getUserEntitlements`, `hasEntitlement`, `getEntitlementLimit`, `assertEntitlement`, `setUserPlan`, `setEntitlementOverride`, `removeEntitlementOverride`, and `ensureDefaultSubscription` (which also returns subscription state). Plan changes accept validated period/trial/grace options. These mutation methods have no user-facing API route. The internal-unlimited plan is omitted from the public catalog and cannot be selected through normal user actions.

`GET /api/student/entitlements` derives identity from the authenticated session, works before onboarding, ignores frontend identity suggestions, and exposes only effective access, public plan identity, allowance/window information and request/workflow/document counts. It does not expose subscription IDs, override reasons, provider credentials, internal costs or raw token usage. `GET /api/plans` exposes the public comparison projection. Both are non-cacheable. The existing ownership checks remain in resource services.

## Allowance semantics

- A valid subscription window containing the current instant is used; otherwise the period is the UTC calendar month. Expired subscriptions fall back to the configured public base plan and calendar period.
- Monthly AI requests count distinct server-generated request IDs across provider attempts, including embeddings/background work. Retries, fallback attempts and helper calls sharing a request ID count once. All actual/estimated provider tokens still count, including every retry. Reads and deterministic entitlement decisions make no LLM calls.
- Admission reserves the estimated input plus the full requested output allowance. It never trims context, reduces output tokens, changes reasoning effort or lowers a model tier to fit the remaining allowance. User-row locking serializes checks plus reservations across processes. Reservations are released after durable usage persistence; the aggregate excludes a matching persisted known-usage record even if release is delayed.
- Unknown provider usage, interrupted work or failed usage persistence retains conservative reserved capacity until period end. This is pending capacity, not invented actual usage or a charge. An accepted provider request can finish after a plan change; subsequent calls recheck access. There is no overage billing.
- Workflow usage counts existing `WorkflowRun.startedAt` in the period, including failed/cancelled starts. The count check and run creation share a user lock/transaction. Resuming an existing run does not consume another run, but rechecks feature access; the engine rechecks between steps and preserves completed output. Duplicate active engine admissions return the existing run without rerunning steps. The public start preflight may reject at exhaustion; existing runs remain available through their read/resume paths.
- Document processing counts accepted upload, explicit retry and source replacement requests from this phase onward. Repeated worker leases for one accepted submission do not consume another processing unit. Deletion does not reset this allowance. Existing queued submissions are grandfathered but feature access is rechecked by the worker. Replacement checks access/size/processing allowance before embeddings and rechecks before publication.
- Document count and file-size caps are independent of existing file validation, storage, extraction and embedding safety limits. Course limits count all stored courses (there is no archived-course state). Account limits count non-revoked accounts; reconnect excludes the account being replaced. Memory caps count active memories, including reactivation/promotion. Atomic resource checks share the caller's transaction with the write.

## Enforcement and quality

Authenticated Assistant/Dispatcher/Agent entry points check access and allowance before AI routing or context retrieval. Context Builder receives trusted agent metadata from AgentExecutor. The routed provider preflights the complete assembled request; the tracked provider boundary rechecks and reserves before safety guards and external execution. Thus direct provider calls, embeddings, retries and fallback attempts also have a commercial boundary.

The existing model router still determines the required quality. A selection above `ai.modelTier.max` returns `PLAN_MODEL_QUALITY_CONFLICT`; fallback candidates above the maximum are excluded. Quality floors remain authoritative and prompts/schemas are passed unchanged. Plan names never map to model IDs.

Workflows use the shared entitlement service. Document upload/processing/replacement, course creation, OAuth start/callback/account persistence, provider reads/writes, Drive/LMS/calendar sync, memory creation/promotion/retrieval, adaptive evidence, recommendation/reminder generation and notification delivery enforce their respective access. Queued user jobs and system jobs that resolve an owned integration resource skip disabled features. Core cleanup remains available.

The `academic.progress` capability controls the dedicated progress experience, not the underlying learning evidence required by entitled Tutor/Quiz/Planner features. Disabling advanced memory stops future memory consumption and marks it unavailable in Context Builder, including reused read caches; basic profile preferences remain. Calendar restriction reports unavailable calendar access explicitly rather than treating the calendar as empty/free.

## Lifecycle and UI

Downgrades never delete courses, assignments, exams, quiz history, documents, saved plans, memories, connected credentials or notification history. They restrict new resource creation/execution and advanced consumption. Original-file reads, stored work and notification history remain accessible under existing ownership checks. Integrations stay connected with sync disabled; users can still disconnect. Upgrades apply without recreating data.

A trial is effective until `trialEndsAt`. Past-due access lasts only through `graceUntil`. Cancelled/expired subscriptions use the base plan immediately; cancellation at period end is represented by an active subscription with `cancelAtPeriodEnd` until its current period ends. Period/trial expiry is resolved on read and does not need a billing scheduler.

`EntitlementProvider` / `useEntitlements()` expose frontend capabilities. Settings links to `/plans`; Calendar/Drive/LMS panels show a clear locked state and View plans link. The progress page has a corresponding locked state. `/plans` provides a concise public comparison and clearly states that billing and self-service upgrades are not implemented.

## Changed files in this phase

New foundation:
- `lib/entitlements/types.ts`
- `server/entitlements/{config,errors,service,usage,resources}.ts`
- `prisma/migrations/20260921170000_plans_entitlements/migration.sql`
- `scripts/configure-plans.ts`
- `app/api/student/entitlements/route.ts`, `app/api/plans/route.ts`, `app/plans/page.tsx`
- `features/student/entitlements/access.tsx`
- `tests/entitlements.test.ts`, `tests/entitlement-fixture.ts`
- `docs/plans-entitlements.md`

Existing integration points:
- `.env.example`, `package.json`, `prisma/schema.prisma`, `scripts/verify-migration.mjs`
- `server/auth/config.ts`, `server/api.ts`
- `server/ai/errors.ts`, `server/ai/providers/openai.ts`, `server/ai/routing/provider.ts`, `server/ai/usage/tracking.ts`
- `server/agents/core/service.ts`, `server/agents/executor/executor.ts`, `server/agents/quiz/service.ts`, `server/assistant/service.ts`, `server/dispatcher/service.ts`, `server/context/builder.ts`
- `server/workflows/engine.ts`, `server/workflows/service.ts`, `server/services/academic.ts`
- `server/documents/{service,processor,replacement}.ts`
- `server/integrations/{service,errors}.ts`, `server/academic-integrations/{access,errors}.ts`, `server/calendar/availability.ts`
- `server/memory/service.ts`, `server/adaptive/service.ts`, `server/progress/service.ts`
- `server/recommendations/service.ts`, `server/reminders/service.ts`, `server/notifications/delivery.ts`
- `server/jobs/{executor,cleanup-oauth,sync-external-course,sync-google-calendar,import-google-drive-file}.ts`
- `app/student/layout.tsx`, `app/student/settings/page.tsx`, `app/student/progress/page.tsx`, `features/student/integrations/settings.tsx`
- `tests/{ai-usage,model-routing-provider,ai-guardrails,ai-reliability,agent-executor,student-progress}.test.ts` (explicit standalone transport fixtures, new trusted context parameter, deterministic progress clock)

Prior uncommitted Model Routing, Guardrails, Reliability and Quality Evaluation work is preserved; it is not rebuilt by this phase.

## Verification

47 focused entitlement cases cover defaults, public/custom/internal plans, typed limits, override expiry, feature vetoes, lifecycle/periods, server/client ownership, zero LLM calls, atomic concurrent requests/tokens/resources, durable accounting failures, model quality conflicts and fallback caps, workflow quotas/replay/resume/in-flight downgrade, document creation/size/retry/replacement, preserved data/connections/notifications, memory cache invalidation, and user/system background policy.

Directly affected transport, RAG, Agent, Workflow, Context Builder, memory/adaptive, academic, integration, background, notification and user-flow tests also run with mocked external provider boundaries. TypeScript, ESLint, production build and fresh-database migrations are checked. The public plans page is inspected in the local browser. No paid provider call is needed for this phase.
