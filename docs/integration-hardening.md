# Integration hardening and verification

This change hardens the existing OAuth, Calendar, Drive and Test LMS paths. It adds
no provider, agent, calendar system or alternate RAG/execution pipeline.

## Defects corrected

- Token refresh held an account lock across HTTP, delaying disconnect. A durable
  short lease now coalesces concurrent refreshes while allowing disconnect to commit.
  Lease and credential-version checks reject stale refresh results and stale errors.
- Provider-rejected tokens and missing scopes were not reflected in local access
  gates. A 401 retries once through centralized refresh; repeated rejection requires
  reconnect. Explicit scope loss denies only the affected capability. A resource-level
  403 leaves the rest of the account usable. Renewed consent clears denied capabilities.
- Google throttling looked like an outage. Google 429 and quota 403 responses now
  become `PROVIDER_RATE_LIMITED`, with bounded Retry-After and persistent per-capability
  cooldowns. Test LMS errors use the same code and a 60-second shared cooldown.
- Corrupt credentials could be retried repeatedly. Invalid ciphertext now enters
  Needs reconnect. A temporary encryption configuration failure preserves stored
  ciphertext rather than destroying recoverable credentials.
- Calendar task exclusion omitted account identity, potentially hiding another
  account's event with the same calendar/event ID. Exclusions now use all three IDs.
- Corrupt Calendar/LMS checkpoints could prevent recovery. Both can recover using
  bounded full snapshots while retaining stable source mappings and local copies.
- Calendar writes and snapshot publication recheck capability ownership after
  network reads. Metadata success never advances the freshness of a cached snapshot.
- Disconnect discarded Calendar selection. Selection now survives, with cached
  availability cleared and old workers fenced; reconnect uses existing event links.
- Drive import listings fetched each Document separately. A single relation read
  loads status for up to 100 entries. Abandoned pending imports can be requeued.
- Drive workers can resume already-committed local downloads without a second
  download. Local processing failures are recorded as failed jobs; the existing
  Document retry action remains responsible for retrying failed parsing/embedding.
- Academic Assignment/Exam creation loaded the course's full collections for each
  imported item. It now checks ownership using only the course ID.
- Calendar scheduling stopped its batch on one publication failure. Failures are
  now isolated, pending/running jobs coalesce manual/scheduled requests, and scheduled
  starts receive deterministic jitter within one minute.
- The general agent contract test omitted Planner's existing availability category.
  Its expected context now matches the implemented Calendar integration.

## Storage, health and freshness

Migration `20260919190000_integration_hardening` adds only
`ConnectedAccount.refreshLeaseToken`, `refreshLeaseUntil`, `deniedCapabilities`, and
`IntegrationSyncState.retryAfter`. No source-performance, document, or planning
tables are duplicated. Apply all 26 migrations before starting the updated app/workers.

`integrationHealth()` exposes a secret-free state, authentication state, sync state,
last successful sync and retry time. Settings share friendly labels: Connected,
Syncing, Connected — Sync delayed, Temporarily unavailable, Needs permission,
Needs reconnect and Disconnected. Temporary provider errors do not imply reconnect.

`server/integrations/freshness.ts` centralizes default freshness: Calendar 5 minutes,
Drive source access 24 hours, academic sync 3 hours, academic files 24 hours. Academic
polling cadence can still be configured using the existing environment options.
Freshness is a health signal, not permission to reuse stale Calendar availability.
Planner refreshes when necessary and clearly falls back to academic/time-budget
planning when current availability cannot be established.

`getIntegrationRuntimeMetrics()` returns process-local sync success/failure counts,
refresh failures, rate limits, processed imports and average sync duration. Existing
structured events contain only safe IDs, codes and counts; centralized production
log collection can aggregate across workers/restarts. `getIntegrationInventory(userId)`
returns ownership-scoped connected/reconnect/disconnected counts. These are trusted
server APIs, not public administrative endpoints.

## Verification coverage

- OAuth: invalid/expired/reused/wrong-session state; duplicate callback; disconnect
  during callback/refresh/read; incremental consent; omitted/rotated refresh tokens;
  concurrent refresh; rejected access tokens; scope loss; throttling; configuration
  and ciphertext failure; reconnect races; account ownership; redacted errors/logs.
- Calendar: multiple pages and 750 events in exactly three listing requests; maximum
  pages/results; fresh cache reuse; stale outage fallback; corrupt checkpoints;
  canceled pagination; active leases; final conflict checks; duplicate/lost-response
  writes; multi-account event-ID collisions; DST 23/25-hour all-day events;
  cross-midnight offset events; user/provider timezones; privacy-minimized context.
- Drive: 300 files in ten explicit listing pages, looping-token rejection, no eager
  downloads; concurrent import/refresh; atomic chunk replacement with retained old
  READY content on failure; source deletion/permission loss; disconnect during work;
  account isolation; constant status-query count; pending-job and processing recovery.
- LMS: repeated syncs, stable mappings, 100 assignments in four listing pages,
  partial files/category failures, source deletion, personal-field preservation,
  checkpoints, cancellation, rate limits/auth failures, scheduling and ownership.
- Journey A: OAuth read consent → selected Calendar → Planner Context Builder
  availability → incremental write consent → linked StudyTask → disconnect →
  reconnect without duplicate events; existing tests also execute the full Planner.
- Journey B: imported PDF → real local extraction/embedding/RAG → actual Tutor
  Executor with a mocked generation boundary → source refresh → new Tutor source
  content → disconnect with the local source still usable.
- Journey C: Test LMS import → Planner context/recommendations/reminders → changed
  source deadline → updated internal deadline with personal priority/effort preserved
  → offline/disconnected operation → stable mappings after connection restoration.

Generative AI is mocked at its existing boundary. Deterministic integration code,
ownership transactions, local PDF processing and embeddings are exercised directly.
No real external account or LLM request is used in these integration fixtures.

Run `npm run check`, `npm run lint`, `npm test`, `npm run build`,
`npm run test:migration`, and `node scripts/verify-integration-boundaries.mjs`.
The full Vitest suite includes HTTP tests and requires a stable server on port 3000.
Do not restart that server during the suite. Browser tests also exercise real
sign-up rate limits: run their files in small batches separated by the one-minute
auth window instead of disabling production security. The documents browser test
needs a document processor; verification used a worker scoped to its fixture users.

The bundle audit checks client import reachability, server-action boundaries,
provider-independent Agent imports, and compiled client assets for credential
implementation markers and configured secret values. It never prints secret values.

## Operational limits

Google OAuth client credentials and production encryption keys are not configured
in this workspace. Live Google consent/refresh/revocation still requires the real
deployment's authorized account and configured callback/scopes. The LMS registry
intentionally has no production adapter; Test LMS verification cannot certify an
institution's future API behavior. No new provider was introduced to bypass this.

External Calendar mutation and the local DB cannot be one atomic transaction. A
different Calendar client may add a conflict after the last check. Stable event IDs
recover ambiguous creates; later verification detects deletion without blind recreation.
Missing-link reconciliation is capped at 25 absent events per calendar/full sync,
oldest checks first; unchecked links are retained and checked later or upon explicit
mutation. Job retries are bounded; a long provider cooldown can outlast a job's retry
budget, with subsequent scheduled/manual work retrying after the cooldown.

Encryption envelopes already include format version and key ID. For rotation, deploy
old and new keys together, choose the new active key, re-encrypt token/PKCE/cursor
fields with their original authenticated contexts, verify coverage, then retire old
keys only after outstanding sessions and backup-retention requirements are handled.
This change prepares and tests that path; it does not rotate production keys.

## Changed files

Verified locally on 2026-09-19: TypeScript and lint passed; all 1,213 Vitest tests
across 51 files passed against a stable server; all 18 browser scenarios passed
across rate-limit-aware batches. Production build passed. A fresh PostgreSQL install
passed 26 migrations / 51 tables including the four new fields. The boundary audit
passed for 85 client entrypoints, 108 reachable modules and 43 production bundles.

- `README.md`
- `docs/google-calendar.md`
- `docs/integration-hardening.md`
- `docs/integrations-oauth.md`
- `features/student/academic-integrations/course-status.tsx`
- `features/student/academic-integrations/settings.tsx`
- `features/student/calendar/settings.tsx`
- `features/student/drive/settings.tsx`
- `features/student/integrations/settings.tsx`
- `lib/student/academic-integrations/types.ts`
- `lib/student/calendar/types.ts`
- `lib/student/drive/types.ts`
- `lib/student/integrations/health.ts`
- `lib/student/integrations/types.ts`
- `prisma/migrations/20260919190000_integration_hardening/migration.sql`
- `prisma/schema.prisma`
- `scripts/verify-integration-boundaries.mjs`
- `scripts/verify-migration.mjs`
- `server/academic-integrations/access.ts`
- `server/academic-integrations/config.ts`
- `server/academic-integrations/errors.ts`
- `server/academic-integrations/http.ts`
- `server/academic-integrations/service.ts`
- `server/calendar/availability.ts`
- `server/calendar/config.ts`
- `server/calendar/google.ts`
- `server/calendar/http.ts`
- `server/calendar/service.ts`
- `server/drive/events.ts`
- `server/drive/google.ts`
- `server/drive/http.ts`
- `server/drive/service.ts`
- `server/integrations/connections.ts`
- `server/integrations/errors.ts`
- `server/integrations/events.ts`
- `server/integrations/freshness.ts`
- `server/integrations/google.ts`
- `server/integrations/health.ts`
- `server/integrations/http.ts`
- `server/integrations/metrics.ts`
- `server/integrations/service.ts`
- `server/integrations/types.ts`
- `server/jobs/errors.ts`
- `server/jobs/import-google-drive-file.ts`
- `server/jobs/sync-google-calendar.ts`
- `server/services/academic.ts`
- `tests/academic-integrations.test.ts`
- `tests/agents.test.ts`
- `tests/browser/drive.spec.ts`
- `tests/browser/integrations.spec.ts`
- `tests/calendar.test.ts`
- `tests/drive.test.ts`
- `tests/integration-health.test.ts`
- `tests/integrations.test.ts`
