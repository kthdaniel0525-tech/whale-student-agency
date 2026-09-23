# Closed beta, product analytics and feedback

## Enable deliberately

Migrate first. No existing user is enrolled automatically unless their email is in
the existing exact `SIGNUP_EMAIL_ALLOWLIST`. Set `BETA_MODE=true` to enforce the
gate on pages, APIs and entitlement checks, including worker execution. With beta
mode enabled an empty allowlist allows no signups. Existing accounts can still
sign in to the invitation page; revoked accounts remain revoked even if listed.
The gate does not prevent account deletion, privacy preferences or feedback.

Use `npm run beta:access -- USER_ID invited core false` to approve an existing
account. On their next authorized product visit, invited becomes active once.
Use `revoked` to remove access. No demo users or marketing invite system is seeded.
The fourth argument marks QA/internal users. Choose `core`, `integrations` or
`paid-pilot`; assignments remain stable in BetaAccess until an operator changes
them. Core initially disables integrations and career; existing plan entitlements
and global feature flags still apply. `BETA_COHORT_FLAGS_JSON` optionally overrides
cohort vetoes using existing capability keys. A cohort can never grant access
above a plan or override a global false. New checkout/plan changes require the
paid-pilot cohort; existing customers retain cancellation/portal access.

`BETA_ADMIN_USER_IDS` is an explicit comma-separated internal authorization list.
Paid plans confer no admin rights. `BETA_INTERNAL_USER_IDS` also excludes internal
traffic without changing product access. Configure these independently per
environment. Deploying this code does not provision hosts, accounts or invite
real students.

## Collection and privacy

`PRODUCT_ANALYTICS_ENABLED=false` by default. Enable after selecting the beta
policy. The database adapter stores small behavioral events locally; no external
analytics vendor is installed. `ProductAnalytics` is the adapter boundary for
`track` and `identify`. A development-only console adapter receives a random
pseudonymous ID and environment/cohort traits, never internal IDs, email or name.
Staging/test/development events carry a distinct environment; production and
staging must still use separate databases as specified in the operations runbook.
Existing operational tables are deployment-local and have no environment column.

Names and properties are event-specific strict Zod allowlists. Prompts, answers,
documents, course names, resume content, mastery values, credentials, raw errors
and feedback text are forbidden. Opaque request IDs can correlate with existing
AI usage, which remains the source of truth for models, tiers, cost, latency and
fallback. Workflow steps, waiting state and completion use existing workflow
records; no workflow inputs/outputs are loaded into metrics.

Collection is asynchronous best effort, at most four writes in flight and 500
waiting. Delivery failures are counted, never thrown into a business operation.
Process termination can lose pending events; these metrics are directional and
must not serve as billing or audit truth. Stable hashed event keys deduplicate
retries and concurrent deliveries. Provider-attempt counts are explicitly distinct
from completed user actions. Canonical workflow and quiz tables remain available
when delivery loses events. No historical conversations are silently backfilled.

The browser only sends allowlisted interaction events. Recommendation impressions
require 50% visibility, deduplicate in browser storage and on the server for the
recommendation lifetime, and verify ownership. A server-generated hash correlates impressions and clicks without a raw recommendation ID in analytics. CTR only counts clicks on recommendations with a recorded impression in the same reporting window. Clicks use the authenticated launch
boundary. A click means the launch descriptor was accepted, not workflow completion.
Completion records use the existing recommendation completion action. Client
events are indicative, not tamper-proof business truth. Raw URLs, query strings,
browser fingerprints and generic click/DOM/session capture are not collected.

Settings → Feedback & privacy allows opt-out, which erases retained behavior
events. Explicit feedback and necessary security/AI usage/billing records have
separate purposes and remain under the existing privacy policy. No legal consent
claims are made. User deletion cascades through all new tables. The existing
maintenance job deletes up to 5,000 events older than
`PRODUCT_ANALYTICS_RETENTION_DAYS` (180 default) per run. For larger beta volumes,
run maintenance more often; monitor retention backlog and queue drops.

## Activation, retention and review

`PRODUCT_ACTIVATION_EVENTS_JSON` defaults to onboarding + course creation + a
successful AI workspace action or completed AI workflow. It is an AND milestone independent of order.
Workflow and quiz completion may be substituted through configuration. The
separate seven-stage funnel counts ordered first occurrences: signup → onboarding
→ course → upload → AI action → quiz → study plan. Missing/pre-instrumentation
events are unknown, not evidence of failed product usage.

`PRODUCT_MEANINGFUL_EVENTS_JSON` defaults to completed AI actions, quizzes, study
tasks, workflows, career tasks and academic creation/uploads. Page views alone
never count. D1/D7/D30 retention measures return on that exact UTC day after the
first retained meaningful action, with only fully elapsed days in the denominator.
It is observed-activity retention, not signup retention. Event retention limits
the historical cohort window.

Authenticated internal endpoints (private/no-store):

- `GET /api/internal/beta?days=30&cohort=integrations`: activation, retention, WAU,
  AI activity, provider attempts/cost, quality samples and satisfaction, quiz rate,
  recommendation CTR, billing funnel and workflow step drop-off. Look at sample
  counts and missing prices before interpreting costs/quality.
- `GET /api/internal/beta/feedback?cursor=...`: separate paginated private text
  review; raw text never enters aggregate analytics or console delivery.
- `PATCH /api/internal/beta/feedback/ID`: `{status, severity}`; statuses new,
  reviewed, planned, resolved; P0/P1/P2/P3 or null severity.

Workflow abandonment is an explicit proxy: WAITING_FOR_INPUT without an update
for 72 hours. Active duration excludes student wait time. Step-position counts
include skipped/failed outcomes and do not assume all workflows have identical
steps. Agent usage reuses AIUsageRecord; costs per successful provider call can
include retries and are not represented as costs per student session. Existing
AI feedback joins usage by both usage ID and owner to show model/tier/workflow.
Satisfaction is not correctness. AI quality records are grouped separately.
No automatic model changes are driven by these metrics.

## Feedback and launch review

Students can submit bugs, feature requests, usability/AI-quality reports, other
feedback or an optional survey. Text stays in private ProductFeedback; it is never
sent as event properties. Optional request/workflow references must belong to the
student. The server supplies release version; route and feature are fixed enums.
Duplicate submission IDs are idempotent. Limit: 20 submissions/user/day.
The existing thumbs-up/down system continues to collect reasons/comments.

A small dismissible prompt is eligible after a completed workflow or the first
week and disappears after submission/dismissal. It is not an interrupting modal
after every response. The survey covers usefulness, value, confusing areas,
weekly-use needs, willingness to pay and missing features; completion is optional.

Launch criteria (review and adjust before the beta):

- P0: security exposure, data loss or billing corruption — stop rollout immediately.
- P1: a core journey unusable — block public launch until verified fixed.
- P2: important feature impaired — owner, workaround and explicit disposition.
- P3: minor usability defect — prioritize using impact and qualitative evidence.
- Any unresolved P0/P1 is a readiness blocker. Zero reports never means launch
  approved; inspect auth/isolation, backup restore, billing truth and core journeys.
- Review workflow/provider failures with sample sizes and the operational alert
  thresholds. Sustained incidents or a broken critical journey block launch;
  low conversion/retention alone does not constitute a technical launch blocker.

Live enrollment, real feedback, growth/conversion conclusions and external
deployment checks require the actual beta rollout; tests do not manufacture them.
