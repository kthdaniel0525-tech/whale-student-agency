# Student Agency

External account connection setup, encrypted token storage, OAuth security and manual
Google verification are documented in [`docs/integrations-oauth.md`](docs/integrations-oauth.md).

Background worker setup, scheduled recommendation refresh, and manual development triggering are documented in
[`docs/background-jobs.md`](docs/background-jobs.md).

Deadline and study reminder detection, persistence, timing, quiet hours, and
user controls are documented in [`docs/reminders.md`](docs/reminders.md).

In-app notification delivery, the notification center, and delivery worker setup
are documented in [`docs/notifications.md`](docs/notifications.md).

User-facing reminder, notification, quiet-hour and proactive recommendation controls
are documented in [`docs/notification-settings.md`](docs/notification-settings.md).

A student workspace with authentication, onboarding, courses, assignments, exams, private document retrieval, AI tutoring, quizzes, learning intelligence, study planning, academic workflows, career support, personalization, proactive recommendations and operational AI controls. Built with Next.js, PostgreSQL + pgvector, Prisma and Better Auth. Documents use local neural embeddings, while provider-backed features run through the server-side AI provider and model-routing layers.

## Run locally

Start Docker Desktop, then run with Node 22.13+:

```sh
npm ci
npm run setup:local
npm run db:up
npm run db:generate
npm run db:migrate
npm run embeddings:prepare
npm run dev
```

Open [Student Agency](http://localhost:3000), create an account and complete onboarding. `.env` is generated with random local secrets and never overwritten automatically. The database persists in a Docker volume.

In a second terminal, start the document processor:

```sh
npm run documents:worker
```

Upload a PDF, TXT or Markdown file from a course or Documents. When it becomes Ready, use the retrieval playground to search its passages. Files remain private under `.local/documents`; the pinned model is downloaded once to `.local/models`. Both directories are ignored by Git. No AI API key is needed.

See the [Documents + RAG handoff](docs/student-agency/DOCUMENTS-RAG.md) for architecture, schema, APIs, changed files, security, setup and limitations; the [foundation handoff](docs/student-agency/FOUNDATION.md) describes the prior phase. Run `npm run check`, `npm run lint`, `npm test`, `npm run test:e2e` and `npm run test:migration` for verification. Tests need the app and PostgreSQL running and the model prepared. Stop the worker for `npm test` (tests control job claims); start it for `npm run test:e2e`. Install the browser once with `npx playwright install chromium`.

Google Calendar setup and behavior: [Google Calendar integration](docs/google-calendar.md).

Google Drive course imports: [setup, permissions, refresh safety and tests](docs/google-drive.md).

LMS / Course Import Foundation: [provider contract, mapping policy, sync and verification](docs/academic-integrations.md).

Integration hardening: [failure handling, security, health, verification and operational limits](docs/integration-hardening.md).

AI usage: [token tracking, estimated pricing, attribution, aggregation and privacy](docs/ai-usage.md).
## Production deployment

The persistent container deployment, secret templates, health checks, staging/release pipeline and operational runbook are documented in [Production operations](docs/production-operations.md). Production requires a configured host/domain, separate secrets, monitoring and verified off-host backups; local development is not a deployed environment.

Closed beta access, privacy controls, event definitions and internal review: [Beta analytics runbook](docs/beta-analytics.md).
