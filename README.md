# Student Agency

A student workspace with authentication, onboarding, courses, assignments, exams, settings, private document uploads and semantic search with document/page citations. Built with Next.js, PostgreSQL + pgvector, Prisma and Better Auth. Documents use local neural embeddings; AI chat and agents are deferred.

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

The former code-review app is retained at `/code-review`. The [original Sites starter instructions](docs/SITES-STARTER.md) are historical; the current PostgreSQL adapter requires Node hosting and cannot be published with the retained Sites scripts unchanged.
