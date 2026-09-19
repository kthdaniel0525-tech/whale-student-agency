# Automation & Notification Settings

`/student/settings` includes Notifications & Automation, using the existing explicit
Save pattern. The server supplies initial values; the form never temporarily shows
unsaved defaults. Labels, descriptions, keyboard switches, linked errors, loading
skeleton and stacked mobile groups support accessible use. Save errors preserve the
draft and do not claim success. A separate login/device receives persisted values.

## Storage and ownership

The existing user-owned `ReminderPreference` is extended with
`proactiveRecommendationsEnabled`, `quietHoursEnabled` and `notificationFrequency`.
Timezone remains in `Profile.timezone`, edited by the existing Academic profile form.
No duplicate settings table or localStorage source of truth is introduced.

`server/preferences/notifications.ts` centralizes defaults, normalization, reads,
validated partial writes, enabled reminder types and change effects. Existing
reminder preference exports delegate to it. GET/PATCH
`/api/student/notification-preferences` use authenticated server identity, private
no-store responses, the existing origin guard, and strict input validation.

Defaults enable all reminder categories, in-app notifications and proactive cards;
study lead time is 30 minutes, frequency is `AS_READY`, and quiet hours are disabled.
The UI offers 10/15/30/60/120 minute lead times; existing valid custom values remain
supported (5–1440 minutes). Invalid zones, times, equal quiet boundaries, missing
enabled boundaries and invalid durations return field errors. UTC is the existing
fallback for missing/invalid legacy timezone values; new writes require a valid
IANA timezone.

## Reminder and delivery policy

Global and category switches gate detection before ranking/persistence. Assignments,
exams (including exam-related weak/diagnostic practice), study sessions/missed work/
behind plans, and waiting workflows are separate categories. Disabling them cancels
pending scheduled/ready/snoozed reminders in the same transaction as the preference
save. `Reminder.preferenceSuppressedAt` distinguishes these cancellations from user
dismissal. Historical delivered/dismissed records remain. Re-enabling re-evaluates
current state and restores eligible suppressed records, retaining snooze times;
completed/passed sources do not return. Lead-time changes apply to timed study
sessions and retain explicit snoozes; deadline day windows are unchanged.

Delivery rechecks current preferences under the same per-user lock, preventing a
queued delivery from ignoring a completed settings save. In-app off stops new
delivery while leaving existing history available. `HOURLY` rounds ready times up
to the next local clock hour; it is a delivery window, not a one-per-hour cap or
summary digest. The existing sweep may deliver a few minutes after the hour.

Quiet hours use local minutes after midnight and support ranges crossing midnight.
The shared helper follows actual minutes through daylight-saving transitions.
Silent in-app notifications remain eligible during quiet hours. The delivery timing
policy defers future interruptive channels, with no critical-reminder bypass.
No email, push or SMS channel is implemented. Academic refreshes continue normally.
Migration 20 preserves existing quiet-hour preferences and removes former engine
quiet-hour deferrals from pending reminders without altering intentional snoozes.

## Proactive and background behavior

Proactive off skips recommendation evaluation and returns no proactive cards from
shared Dashboard/AI/course/progress retrieval. Existing history stays stored, and
on-demand Academic Manager/Study Planner execution remains available.

Daily fan-out skips disabled features. Per-user jobs re-read current preferences
before expensive work, so already queued jobs respect later changes. Settings saves
queue fresh eligible reminder/recommendation evaluations and delivery; a timezone
profile save also refreshes affected state. Disabling reminders is immediate;
re-enable/lead-time regeneration runs through the existing worker and regular sweeps.
Run `npm run jobs:worker` alongside the web app for these automatic refreshes.
Durable saves remain valid if queuing temporarily fails, with a safe diagnostic and
regular sweep recovery. No AI calls are used by preferences, timing or refresh.

## Verification

`tests/notification-settings.test.ts` covers defaults, category/global/channel gates,
re-enable/history/snooze, lead time, proactive visibility and on-demand compatibility,
validation, timezones/DST, frequency, background gates, ownership, safe failure and
zero AI calls. `tests/browser/notification-settings.spec.ts` covers save/reload,
separate devices, keyboard and associated labels/errors, failure feedback, timezone
editing and mobile layout. Existing reminder, notification, scheduled/background,
recommendation, Dashboard, assistant and foundation tests remain relevant.

## Files changed in this phase

- Settings: `app/student/settings/page.tsx`, `app/student/settings/loading.tsx`,
  `features/student/notifications/settings.tsx`,
  `app/api/student/notification-preferences/route.ts`.
- Preference and time logic: `server/preferences/notifications.ts`,
  `lib/student/notification-preferences.ts`, `lib/student/timezone.ts`,
  `features/student/validation/schemas.ts`, `server/time/local.ts`.
- Persistence: `prisma/schema.prisma`,
  `prisma/migrations/20260918040000_automation_settings/migration.sql`,
  `scripts/verify-migration.mjs`.
- Existing service integration: `server/reminders/service.ts`,
  `server/notifications/delivery.ts`, `server/notifications/channel.ts`,
  `server/notifications/timing.ts`, `server/recommendations/service.ts`,
  `server/services/academic.ts`.
- Background integration: `server/jobs/refresh-recommendations.ts`,
  `server/jobs/refresh-reminders.ts`, `server/jobs/active-users.ts`,
  `server/jobs/scheduled-recommendations.ts`, `server/jobs/errors.ts`.
- Tests: `tests/notification-settings.test.ts`, `tests/reminders.test.ts`,
  `tests/browser/notification-settings.spec.ts`.
- Documentation: `README.md`, `docs/notification-settings.md`,
  `docs/reminders.md`, `docs/notifications.md`.
