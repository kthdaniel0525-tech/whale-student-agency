# AI rate limits and safety budgets

The model router selects a capable model at the required quality floor. The
existing usage-tracking boundary then reserves capacity **before** calling either
the generation or embedding implementation. All checks are deterministic; no
classification/evaluation AI calls are added.

## Shared state and identity

`server/ai/guardrails` uses PostgreSQL `AIGuardState` for token buckets, budget
counters, request claims and expiring concurrency leases. Transactions acquire
hashed advisory locks in sorted order, making simultaneous reservations atomic
across app/worker instances. Transactions never span provider calls or stream
chunks. Authenticated server context supplies `userId` and `requestId`; frontend
identity/budget injection is rejected by existing strict request schemas.

Counters are safety reservations, not a second usage/billing ledger. The same
validated provider usage written to `AIUsageRecord` reconciles reserved tokens.
Successful responses lacking usage use the existing estimator; failures with
unknown usage retain their reservation. Failed attempts count, SDK automatic
retries remain disabled, and reliability fallback attempts pass through this
same boundary. Stream completion, error and consumer exit release capacity once.
Abandoned leases expire after the execution deadline plus a short grace period.

## Policy and quality

`config.ts` is the source of defaults; `AI_GUARDRAILS_JSON` accepts validated,
partial server-side overrides. Development uses identical defaults. Profiles:

- SIMPLE: 4 generation calls, FAST minimum for simple operations.
- STANDARD: 8 generation calls, BALANCED minimum.
- COMPLEX: 12 generation calls, STRONG minimum.
- HIGH_COMPLEXITY: 24 generation calls, STRONG minimum.
- WORKFLOW: up to 40 generation calls, 256 embeddings, 8 steps.
- BACKGROUND: 12 generation calls, 512 embeddings.

Workflow helper calls may be FAST; each actual agent's existing router floor
still applies (for example, strategic planning remains STRONG). Trusted task
escalation expands an existing allowance while retaining spent counters. Router
helpers keep their own appropriate quality requirements. Main generation never
downgrades below its floor due to token/cost pressure. Per-task output budgets,
reasoning reserve, retrieval relevance and conversation compression remain intact.
Routing can select a larger-context capable model, and returns `AI_CONTEXT_LIMIT`
if no quality-safe candidate fits; it never silently truncates constraints.

Request counters include generation/embedding calls, input/output/total tokens,
agent-purpose counts, exact hashed call fingerprints and active deadlines.
Workflow definitions determine a tighter call allowance beneath the configured
ceiling. Persistent run counters survive new request IDs and human pauses; each
step is counted once and retries still consume AI calls. Existing runtime active
duration, step/agent limits, resource conflict locks and atomic resume claims are
retained. Budget stops preserve completed outputs and never report false success.

## Rates, concurrency and imports

Token buckets default to 60 interactive requests/minute and 600/hour, 60 workflow
starts/hour, 120 background jobs/hour, and 1,200 embeddings/minute and 6,000/hour
per user. Background admission is independent of interactive admission. Defaults
allow 4 expensive operations per user, 24 per provider, 12 per model, and 4
background operations globally. Background concurrency leaves at least one user,
provider/model slot for interactive work when configured capacity exceeds one.
Top-level assistant requests also have their own whole-request concurrency lease.

Background jobs inherit a stable persisted job ID for budgets across retries and
use the existing queue's bounded concurrency/backoff. Local document processing
uses its fenced claim ID; explicit retries still use existing document retry
limits. Existing document bounds remain 10 MB, 200 pages, 400,000 extracted
characters and 256 chunks. Embedding input is independently bounded; chunk quality
and coverage are unchanged. Drive queues selected files individually and bounds
per-user links to 200; LMS file batches remain capped at 20 before processing.

## Idempotency, operations and failure policy

Assistant JSON and streaming endpoints share an authenticated-user + `turnId`
claim, including the first turn before a conversation exists. Only a secure input
hash and owned conversation reference are stored. A simultaneous request cannot
generate again. Completed requests replay saved messages; stopped/abandoned
claims require a new user request rather than silently repeating uncertain work.
Existing workflow compare-and-set claims prevent duplicate resumes.

`disableAllAI`, `disableBackgroundAI`, and `disabledFeatures` stop new operations.
Feature IDs match trusted `guardFeature`, workflow ID or usage source (for example
`career-preparation` or `memory-index`). Model disabling uses the existing
catalog's `enabled: false`; remaining choices must still satisfy quality floors.
These switches do not terminate an already completed operation or change billing.

Soft request/workflow cost thresholds and a cached 24-hour user cost observation
reuse `AIUsageRecord`; they emit events without lowering quality or imposing paid
quotas. `AIGuardEvent` stores safe identifiers, codes, optional numeric snapshots
and timestamps, never prompts or output. `getGuardrailMetrics(userId)` exposes
owner-filtered counts for internal diagnostics. Events do not label users abusive.

Analytics failures fail open. Shared admission/reservation storage failures fail
closed for **new** expensive operations: process-local fallback would defeat
distributed runaway protection. Already completed provider results can still be
returned if reconciliation/event writes fail; conservative reservations remain
and leases expire. Read-only/saved-result paths remain available. Errors expose
generic retry/progress guidance, not internal thresholds or model prices.

Budget/claim state and event retention is 30 days. The existing daily OAuth
maintenance job also removes expired state/old events in bounded 10,000-row
batches. No new scheduler or operations dashboard is introduced. Apply migration
`20260920200000_ai_guardrails` before deploying, then restart app and workers so
their generated Prisma clients include the two new models.
