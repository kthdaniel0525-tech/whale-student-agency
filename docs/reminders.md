# Deadline and study reminders

The reminder engine turns existing academic, study-plan, learning, and workflow
state into deterministic reminder records. It does not send email, push, SMS, or
in-app notifications itself. The [notification delivery layer](notifications.md)
consumes ready reminders without reimplementing detection or user controls.

## Data model

`Reminder` stores the user-owned reminder, source reference, priority score,
schedule and expiration, reason metadata, validated action target, and stable
deduplication keys. `ReminderPreference` stores per-user category toggles, study
session lead time, and optional quiet hours as local minutes after midnight.

Reminder states are `scheduled`, `ready`, `delivered`, `dismissed`, `snoozed`,
`expired`, and `cancelled`. Dismissal and snooze are preserved while the same
reminder window remains active. A later urgency window can create a new reminder.

## Detection and priority

The engine detects:

- assignments due in configured windows or overdue and incomplete;
- upcoming exams, including a distinct tomorrow window;
- high-confidence weak topics and low-confidence diagnostic practice before exams;
- precisely timed study sessions, important missed study tasks, and study plans
  that have fallen behind;
- workflows that have waited for student input for at least 24 hours.

Completed assignments and study tasks are ignored. Date-only study tasks do not
produce a made-up clock-time reminder. Old or missing metadata uses safe defaults.

Priority is the bounded sum of deterministic signals: urgency, academic impact,
source priority, readiness, weakness, missed work, and whether user input is
required. Scores map to low, medium, high, and critical bands. Detection keeps
the highest-value active reminders within a bounded result set.

All calendar-day comparisons use the student's profile timezone and fall back to
UTC for missing or invalid timezones. Quiet hours are applied at the delivery
boundary, never during academic detection. Settings are normalized by the shared
[notification preferences service](notification-settings.md).

## Refresh and user controls

Domain changes enqueue both recommendation and reminder refresh work through the
shared pg-boss infrastructure. The daily active-user dispatcher also fans out a
per-user `refresh-user-reminders` job. Each job reloads trusted server-side state,
uses per-user concurrency and debouncing, and records aggregate `JobRun` metadata.

The service supports listing upcoming reminders, changing preferences, snoozing,
dismissing, and resolving an action. Disabling a category immediately cancels its
pending reminders, marks that cancellation as settings-driven, and retains
history. Re-enabling evaluates current candidates; dismissed or delivered rows
remain historical, and individual snoozes survive. Action resolution revalidates the reminder,
its source, and referenced resource ownership before returning a target.

For local verification, run:

```bash
npm run jobs:worker
npm run jobs:trigger -- refresh-user-reminders <userId>
```
