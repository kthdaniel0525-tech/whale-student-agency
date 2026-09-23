# In-app notification delivery

Reminders decide what matters and when; notifications record delivery and read
state. Notification delivery makes no AI calls and never executes a workflow
without a user action.

## Architecture and persistence

`server/notifications` exposes the channel contract, `InAppNotificationChannel`,
delivery, bounded notification lists, count queries, read/dismiss/snooze, and
validated actions. The Notification model supports in-app, email, push and SMS
channel identifiers; only the in-app adapter is implemented.

The unique `(reminderId, channel)` key is the delivery identity. In-app delivery
and the reminder's delivered state commit in one transaction. An owner lock
serializes delivery with reminder refresh and notification controls. Retries
cannot create duplicates or reset read state. A user-requested snooze reuses the
same reminder and notification, resets read state only when redelivered, and
increments `deliveryCount`.

Notification payloads contain only approved resource IDs. Lists and actions
check the current reminder and source state. Completed assignments, passed exams,
finished workflows and expired reminders keep their notification history but
lose the primary action. The action endpoint checks ownership again and returns
an application-controlled destination. Workflow waiting actions reopen the
existing run and its interactive controls in the AI workspace.

## Background delivery

The existing pg-boss worker registers two additional jobs:

- `deliver-ready-notifications`: paginates eligible reminder owners in batches of
  100 and enqueues at most five user jobs concurrently. A failed user enqueue
  does not interrupt other users.
- `deliver-user-notifications`: delivers up to 50 eligible reminders for one
  owner, with a five-second debounce and per-user concurrency of one.

Reminder evaluation immediately enqueues delivery when it finds ready reminders.
A durable scheduled sweep also handles schedules and snoozes becoming due without
new domain events. The default sweep is every five minutes, configurable with
`NOTIFICATION_DELIVERY_CRON`. Scheduling follows `BACKGROUND_JOB_SCHEDULE_ENABLED`
and defaults on in production, off in development/test.

Delivery retries are bounded: two job retries and at most three failed attempts
per reminder/channel. A failed transaction never marks the reminder delivered.
`Notification.failedAttempts` and `lastErrorCode`, plus existing `JobRun` records,
make exhausted failures inspectable. Database failures are retried through the
job framework. Process metrics track created/delivered/read/dismissed/snoozed/failed
counts and delivery latency without message bodies.

Local verification:

```sh
npm run db:migrate
npm run dev
npm run jobs:worker
npm run jobs:trigger -- deliver-user-notifications <userId>
npm run jobs:trigger -- deliver-ready-notifications
```

The background worker must run beside the web app for automatic delivery.

## Preferences and quiet hours

`ReminderPreference.inAppEnabled` defaults true; global and category reminder
preferences are reloaded through the central settings service at delivery time.
The Settings page exposes these controls (see [Automation settings](notification-settings.md)).
In-app is non-interruptive (`interruptive: false`, `supportsQuietHours: false`)
and can be created silently during quiet hours. The shared delivery timing policy
defers future interruptive channels until quiet hours end, including critical
reminders. It never delays academic intelligence. Optional hourly delivery rounds
the ready time up to the next hour in the user's profile timezone.

## Notification center

The header bell uses an unread count query. `/student/notifications` provides
All/Unread views, cursor pagination, priority labels, primary actions, read state,
dismissal and one-hour snooze. Opening the page does not mark anything read.
Read/dismiss updates are optimistic and revert on server rejection. State is
stored on the server and refreshed on navigation/focus; the bell also refreshes
once per minute while visible. No browser permission, email, push or SMS is used.
