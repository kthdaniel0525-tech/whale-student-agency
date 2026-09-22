# Google Calendar integration

Calendar is an optional time constraint for the existing Study Planner. It does not change academic priorities, run agents, or automatically create external events. Calendar arithmetic, sync and writes use zero LLM calls.

## Setup and operation

1. Apply the new Prisma migration (`npm run db:migrate`).
2. Configure the existing Google OAuth client and encryption keys as described in [OAuth setup](integrations-oauth.md), and enable Google Calendar API in that Google Cloud project. Use the existing integration callback URI. Keep all secrets server-side.
3. Run `npm run jobs:worker` with scheduled jobs enabled in production. The existing queue must be initialized by its worker before Settings can enqueue refreshes.
4. In Settings → Integrations, connect Google, then **Enable Calendar reading**. This requests event read and calendar-list read permission only. Select calendars in **Manage calendars**, and save. Selection schedules the initial bounded read.
5. Optionally approve **Enable Calendar write access**, then explicitly allow study events in a writable calendar. Each task's **Calendar options** exposes separate Add, Update and Remove actions. Saving a study time never writes Google Calendar.

Existing connections with only the earlier event-read scope must approve the new calendar-list permission before using Calendar features. No permission is silently expanded. Missing OAuth setup disables connection controls, without disabling academic planning.

## Architecture and storage

- `GoogleCalendarAdapter` uses the existing `IntegrationClient`; only the integration provider receives tokens. Google response schemas stay in the adapter.
- `CalendarIntegrationPreference` stores per-user/account/calendar selection and a bounded cache of blocking event IDs and UTC start/end instants. No event titles, descriptions, locations or attendees are persisted or passed to AI. Calendar display names are retained for Settings only.
- `IntegrationSyncState` holds encrypted per-calendar sync tokens, health and a fenced account lease. OAuth and sync health remain separate.
- `ExternalEventLink` maps a StudyTask to an owned Google event, with PENDING/LINKED/MISSING/REMOVED status. Composite foreign keys enforce task/account ownership. Deleting an app task or disconnecting does not delete an external event.
- StudyTask gains provider-neutral `scheduledStart`, `scheduledEnd`, `scheduledTimezone`. Old tasks without times still work; users can assign a time before adding them to Calendar. Existing reminder detection prefers the scheduled time and rejects reminders for a superseded start time.

## Time and planning policy

All internal intervals are half-open UTC instants. Google offset timestamps are respected; offset-free timestamps are resolved with the event/calendar IANA timezone. All-day end dates are exclusive. Nonexistent DST wall times are rejected; ambiguous local booking times choose the first occurrence (event end boundaries conservatively choose the last).

Cancelled, transparent, declined, working-location and birthday events do not block time. Ordinary all-day events do not block by default; users can opt in per calendar. Out-of-office events block. Overlaps across calendars/accounts merge without double-counting.

The default study envelope is 09:00–22:00 in the application timezone, excluding enabled quiet hours, with a 15-minute minimum. Planner session preferences, preferred morning/afternoon/evening and maximum continuous duration further constrain scheduling; daily budgets are still respected. A five-minute gap separates maximum-length continuous blocks. Free calendar time is not a mandate to study all day.

Context Builder's optional `availability` category returns only dated free windows, timezone, freshness and explicit limitations. Study Planner places sessions deterministically inside these windows, splits longer sessions into useful blocks, and rejects an impossible schedule. A final stale-data refresh and local schedule lock protect persistence; completed work survives replanning. Existing externally linked sessions remain busy until explicitly removed or updated. No document retrieval is added.

Context and Planner share horizon inference, including the selected exam date and explicit availability dates; planning ranges remain bounded by the configured sync window. Dates outside the verified window have no calendar-backed slots. Provider failure uses the existing academic/time-budget planning path with a visible availability warning. Partial multi-account availability is labeled; external event writes require all selected availability to be verified.

## Sync and concurrency

Configurable constants in `server/calendar/config.ts` default to 3 past days and 61 future days, 5-minute freshness, 15-minute polling, 10 selected calendars and 5,000 events per calendar. Bounds are enforced and pagination overflow fails closed rather than suggesting false free time.

Initial reads use bounded timeMin/timeMax and expanded recurring occurrences. Later same-window reads use nextSyncToken, omitting incompatible time filters; pagination carries the identical sync token. A 410 response resets that calendar with a bounded full read. The rolling window gets a new bounded snapshot each UTC day, so moved/new recurring events cannot disappear at the horizon edge. Only in-window busy events survive caching. Cursor and cache commit atomically; lease and selection-revision checks reject stale workers. Refresh, scheduled jobs and planning freshness share this implementation.

A system sweep enqueues at most 100 due accounts per cycle; recently attempted accounts are excluded so later accounts can advance. Jobs derive ownership from ConnectedAccount, debounce per account, retry twice and use the existing job executor. Pending/running jobs coalesce manual and scheduled requests; scheduled starts receive up to one minute of deterministic jitter. Publication failures are isolated per account. No OAuth cookies or frontend user IDs are used by workers. Disconnect preserves calendar selection, clears cache/cursors/leases, and prevents queued work from calling Google. Reconnect restores access to the same selection and authoritative event links.

Corrupt or retired-key checkpoints fall back to a fresh bounded snapshot. Metadata reads
never advance snapshot freshness. Missing linked events receive at most 25 individual
verification reads per calendar per full sync, oldest checks first; unchecked links are
preserved rather than falsely labeled deleted. Provider paging respects job cancellation.
Task exclusion matches account, calendar and event together, including when two accounts
use `primary` and the same external event ID.

## Explicit write safety

Add reads title, course, start and duration from the owned StudyTask. It checks selected writable calendar, scope, local tasks and live Google conflicts before sending a minimal event with no attendees or invitations. A durable random event ID and unique link are reserved before HTTP; retries of ambiguous POST failures use the same ID and verify a private link marker. Duplicate clicks cannot insert a second event.

Task edits never automatically patch Google. Update explicitly checks the current link, permissions and conflicts. Remove deletes only that linked event, not the task. Missing/cancelled Google events mark the link missing; sync never recreates them. A later explicit Add reserves a new ID. A short transaction reserves a 60-second write lease; bounded provider HTTP runs outside database transactions. Publishing requires the same lease and credential version. Task revisions sent to Google are retained so edits during HTTP remain visibly unsynced.

Disconnect immediately clears credentials and active write leases without waiting for network writes. Further requests and late publication fail. A mutation already accepted by Google cannot be recalled; disconnect never removes external events. The durable event ID permits reconciliation after a lost response or interrupted write.

No external service can make local and Google transactions atomic, nor prevent another calendar client from adding a conflicting event after the final check. Idempotent IDs recover ambiguous creates; updates/removes are repeatable and future sync detects deletions. Users should review shared calendars for subsequent changes. Cache/lease fencing prevents cancelled local work from resurrecting availability.

## Verification

Focused Calendar tests cover permissions, selection, pagination, privacy, cancellation, timezones/DST, free windows, real Context Builder/Planner persistence and replanning, scoped writes, retry recovery, links, sync tokens, stale refresh, fallback, disconnect, multiple accounts and ownership. Google HTTP is mocked; deterministic calendar arithmetic is not. Browser coverage verifies explicit controls, consent escalation, selection payloads and mobile layout. Existing OAuth, Planner, Context Builder, Agent Executor and background-job tests are run for compatibility.

Real Google consent and an actual remote event round trip require operator-provided OAuth credentials and encryption keys; these are not generated or embedded in the repository.

## Provider references

Implementation follows Google's [event listing constraints](https://developers.google.com/workspace/calendar/api/v3/reference/events/list), [incremental synchronization](https://developers.google.com/workspace/calendar/api/guides/sync), [calendar-list scopes](https://developers.google.com/workspace/calendar/api/v3/reference/calendarList/list), and [event ID and time semantics](https://developers.google.com/workspace/calendar/api/v3/reference/events/insert).

## Changed files

- `README.md`
- `app/api/student/calendar/accounts/[id]/refresh/route.ts`
- `app/api/student/calendar/accounts/[id]/route.ts`
- `app/api/student/calendar/tasks/[id]/route.ts`
- `docs/google-calendar.md`
- `features/student/assistant/study-plan-card.tsx`
- `features/student/assistant/types.ts`
- `features/student/calendar/settings.tsx`
- `features/student/calendar/task-actions.tsx`
- `features/student/integrations/settings.tsx`
- `lib/student/calendar/types.ts`
- `prisma/migrations/20260919010000_google_calendar/migration.sql`
- `prisma/migrations/20260919011000_calendar_schedule_index/migration.sql`
- `prisma/schema.prisma`
- `scripts/verify-migration.mjs`
- `server/agents/study-planner/definition.ts`
- `server/agents/study-planner/instructions.ts`
- `server/agents/study-planner/priority.ts`
- `server/agents/study-planner/service.ts`
- `server/agents/study-planner/types.ts`
- `server/calendar/availability.ts`
- `server/calendar/config.ts`
- `server/calendar/google.ts`
- `server/calendar/http.ts`
- `server/calendar/planner-persistence.ts`
- `server/calendar/planning.ts`
- `server/calendar/service.ts`
- `server/calendar/time.ts`
- `server/calendar/writes.ts`
- `server/context/availability.ts`
- `server/context/builder.ts`
- `server/context/cache.ts`
- `server/context/format.ts`
- `server/context/types.ts`
- `server/context/validation.ts`
- `server/integrations/errors.ts`
- `server/integrations/google.ts`
- `server/integrations/service.ts`
- `server/integrations/types.ts`
- `server/jobs/registry.ts`
- `server/jobs/schedule.ts`
- `server/jobs/sync-google-calendar.ts`
- `server/jobs/worker.ts`
- `server/reminders/current.ts`
- `server/reminders/detection.ts`
- `server/reminders/service.ts`
- `server/reminders/types.ts`
- `server/time/planning-horizon.ts`
- `tests/browser/calendar.spec.ts`
- `tests/browser/integrations.spec.ts`
- `tests/calendar.test.ts`
- `tests/reminders.test.ts`
