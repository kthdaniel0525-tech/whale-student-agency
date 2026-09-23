# Background jobs

The application uses **pg-boss** as its only general background job system. It
runs on the existing PostgreSQL database, so local and production environments
do not need Redis or a queue SaaS. pg-boss provides durable delivery, bounded
retries with exponential backoff, expiration, dead-letter storage, priority,
debouncing and distributed per-user concurrency.

The Workflow Engine remains separate. Workflows represent visible student goals;
background jobs perform server-side deferred evaluation and maintenance. The
existing document processor remains unchanged and can be migrated later without
risking the working RAG pipeline.

## Local development

After the normal local setup and database migration, run the application and the
background worker in separate terminals:

```bash
npm run dev
npm run jobs:worker
```

The worker creates and migrates the `student_jobs` pg-boss schema, registers the
queues, and shuts down gracefully on SIGINT or SIGTERM. The document processor
still runs separately with `npm run documents:worker` when document indexing is
needed.

Trigger the current job manually in development:

```bash
npm run jobs:trigger -- refresh-user-recommendations <userId>
npm run jobs:trigger -- refresh-user-reminders <userId>
npm run jobs:trigger -- refresh-active-user-recommendations
npm run jobs:trigger -- deliver-user-notifications <userId>
npm run jobs:trigger -- deliver-ready-notifications
```

The trigger refuses to run when `NODE_ENV=production`; no public development
endpoint is exposed.

## Production

Run `npm run db:migrate` during deployment, then run one or more long-lived
`npm run jobs:worker` processes beside the web application. The database role
in `DATABASE_URL` must be able to create and migrate the configured pg-boss
schema. Set these server-only variables:

```text
DATABASE_URL=postgresql://...
BACKGROUND_JOB_SCHEMA=student_jobs
BACKGROUND_JOB_WORKER_CONCURRENCY=4
RECOMMENDATION_REFRESH_CRON=0 5 * * *
NOTIFICATION_DELIVERY_CRON=*/5 * * * *
RECOMMENDATION_REFRESH_PAGE_SIZE=200
RECOMMENDATION_REFRESH_FANOUT_CONCURRENCY=10
```

Deployments may increase worker concurrency, while pg-boss still limits a given
user to one recommendation refresh at a time across worker instances. The worker
registers one pg-boss daily schedule in production. Development and tests keep
automatic scheduling off unless `BACKGROUND_JOB_SCHEDULE_ENABLED=true` is set.

The worker also registers the five-minute notification sweep, which queues bounded
per-user delivery jobs. See [notification delivery](notifications.md) for
idempotency, snooze redelivery, retry limits and channel behavior.

## Scheduled recommendation freshness

`refresh-active-user-recommendations` is a system-scoped academic-freshness dispatcher. It selects
users in bounded pages when they have a recent session, a current assignment or
exam, an active study/career plan, or an active recommendation. It never evaluates
recommendations or reminders itself. Each eligible user receives the existing
`refresh-user-recommendations` job and the `refresh-user-reminders` job, with
enqueue work limited to a configurable number of concurrent calls.

The daily idempotency key includes the user's local calendar date, using the
stored profile timezone and falling back to UTC for missing or invalid values.
Event jobs retain their own event keys, so meaningful state changes can still
refresh immediately. Dispatcher metrics record only the schedule run ID, page
and user counts, enqueued jobs, duplicate skips, failures, and duration.

## Behavior

`refresh-user-recommendations` validates a versioned payload containing only a
tracking ID and user ID, reloads trusted state through the existing Recommendation
Engine, and records safe aggregate results in `JobRun`. Ten-second per-user
debouncing coalesces bursts of domain events. Retries are limited to three with
exponential backoff, execution expires after 30 seconds, and exhausted or
non-retryable jobs enter the dead-letter queue. Logs and `JobRun` contain IDs,
status, attempt, error category and duration, never prompts, documents, API keys,
or conversation content.
