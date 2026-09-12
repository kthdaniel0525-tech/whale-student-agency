# Student Agency foundation — implementation handoff

Historical Phase 1–2 record. The subsequent [Documents + RAG handoff](DOCUMENTS-RAG.md) supersedes document-related limitations and setup instructions below.

Implemented scope: Phase 1 architecture foundation and Phase 2 application foundation, including the course, assignment and exam CRUD explicitly requested in the follow-up. No AI execution, document upload, RAG, vector search, quiz, study planner, recommendation generator or workflow automation is enabled.

## What is working

Email/password registration, sign-in and sign-out use Better Auth with persisted PostgreSQL sessions, password hashing, origin verification and database-backed rate limiting. A second atomic email-based limit permits 10 credential attempts per 15 minutes, independent of forwarded IP headers. Email identifiers in that limiter are HMAC hashes. Protected server pages and APIs always derive identity from the verified session; frontend userId fields are rejected by strict schemas.

New accounts enter onboarding for name, school, program, year, semester, academic goal, session length, explanation difficulty and timezone. Profile creation marks onboarding complete; subsequent settings updates preserve that timestamp. Returning users go straight to the dashboard.

The dashboard reads the database for courses, unfinished assignments, upcoming exams and earliest deadline priorities. It shows honest empty states for new accounts. Course detail supports course editing/deletion, assignment creation/editing/completion/reopening/deletion, and exam creation/editing/deletion. Course deletion cascades through its assignments and exams. Profile settings persist across reloads. There are responsive navigation, light/dark themes, validation messages, busy states, error boundaries, success notifications and deletion confirmation dialogs.

AI Assistant, Study Plan, Documents, Progress and Career have explanatory placeholders. The AI Recommendations and AI Memory sections explicitly state that those features are unavailable. No synthetic student data is seeded into normal accounts. The former code-review app remains at `/code-review`; its Gemini integration is legacy code, not part of Student Agency.

## Runtime decision

The student app now uses the existing Next.js package through its standard Node runtime. Prisma 7.10.0 uses `@prisma/adapter-pg` to connect to real PostgreSQL. Better Auth 1.7.3 provides complete email/password registration and database sessions without requiring a separate hosted identity account.

The prior Sites/Vinext configuration and scripts are retained with `:sites` names as migration history. They are **not a supported deployment path for this new PostgreSQL application**: Sites does not support the raw TCP connection used by this adapter. No changes have been published to the existing hosted site. Production requires Node hosting plus PostgreSQL, or a separately verified HTTP-compatible database transport. Do not run the old Sites publishing flow against this foundation as though it were compatible.

## File organization

- `app/student/`: authenticated layout, dashboard, courses, detail, settings and future-page placeholders.
- `app/sign-in/`, `app/sign-up/`, `app/onboarding/`: account and onboarding flows.
- `app/api/student/`: thin authenticated CRUD route adapters.
- `app/api/auth/[...all]/route.ts`: bounded credential requests and Better Auth handler.
- `features/student/components/`: reusable shell, forms, confirmation dialogs, state feedback and providers.
- `features/student/validation/schemas.ts`: shared strict Zod schemas.
- `server/auth/`: auth configuration, page session guard and atomic credential throttling.
- `server/db/client.ts`: server-only singleton Prisma client with bounded connection pool.
- `server/services/academic.ts`: ownership-scoped academic operations and transactions.
- `server/api.ts`: authentication, origin checks, bounded JSON parsing and safe API errors.
- `lib/student/`: date formatting and client request helper.
- `prisma/schema.prisma`, `prisma/migrations/`: current models and reviewed initial migration.
- `tests/`: HTTP/PostgreSQL integration, validation/date unit tests and browser journey.
- `scripts/setup-local.mjs`, `scripts/docker.mjs`, `scripts/verify-migration.mjs`: local setup and migration verification.

Future AI/context/workflow folders contain boundary documentation only. No unused service implementations or vector schema are compiled. `future-schema.prisma.txt` is an archived design sketch, not a migration source.

## Database schema

Six domain models:

- User: identity, display name, email and timestamps; shared with Better Auth.
- Profile: one per user, onboarding data, timezone and completed onboarding timestamp.
- Course: owner, code, name, professor, semester, description and timestamps.
- Assignment: owner/course, title/description, UTC deadline, status, priority, hours, completion timestamp.
- Exam: owner/course, title, UTC date, topics and notes.
- UserMemory: owner/key/value structure reserved for future explicit memory management; no memory UI writes yet.

Four authentication support models: Session, Account, Verification and RateLimit. User-owned rows cascade on account deletion; assignments/exams cascade on course deletion. Composite `(courseId, userId)` foreign keys prevent child records from referring to a different owner's course. Indexes cover owner, semester, deadline, status and authentication lookup paths. SQL CHECK constraints enforce year/session ranges, estimated hours and consistency between completion status and timestamp.

Authorization is enforced in every personal-content service query, not PostgreSQL RLS. Database credentials are server-only and must never be exposed to clients. RLS may be introduced later as defense in depth; it is not claimed as implemented.

## Routes

Public account pages: `/sign-in`, `/sign-up`. `/` redirects to `/student`.

Protected pages: `/onboarding`, `/student`, `/student/courses`, `/student/courses/[id]`, `/student/settings`, `/student/assistant`, `/student/study-plan`, `/student/documents`, `/student/progress`, `/student/career`.

Protected APIs:

- `GET, PUT /api/student/profile`
- `GET /api/student/dashboard`
- `GET, POST /api/student/courses`
- `GET, PUT, DELETE /api/student/courses/[id]`
- `POST /api/student/courses/[id]/assignments`
- `POST /api/student/courses/[id]/exams`
- `GET, PUT, PATCH, DELETE /api/student/assignments/[id]` (PATCH changes status)
- `GET, PUT, DELETE /api/student/exams/[id]`

`/api/auth/*` contains Better Auth endpoints. GET is read-oriented; credential/sign-out mutations use POST. Student writes require the configured origin and JSON. Anonymous API calls return 401; inaccessible personal resource IDs return 404 after onboarding. Unfinished accounts cannot use academic APIs. Next.js page redirects can be streamed after a loading boundary; API authorization remains server-side regardless of page rendering.

## Local run instructions

Requirements: Node 22.13+ (Node 24 used for verification), npm and running Docker Desktop. Ports 3000 and 5439 must be available. Run from the repository root:

```sh
npm ci
npm run setup:local
npm run db:up
npm run db:generate
npm run db:migrate
npm run dev
```

Open `http://localhost:3000`. Create your own account, complete onboarding, then add courses. No default password or seeded student account is supplied. `setup:local` creates a mode-0600 ignored `.env` with random secrets only if `.env` does not exist. It never overwrites existing configuration. The Docker helper also locates Docker Desktop on macOS when `docker` is not on PATH.

The PostgreSQL container binds only to `127.0.0.1:5439` and persists data in the Compose named volume. `npm run db:down` stops the container and preserves data. Do not delete the volume unless intentionally resetting all local data. If the volume already exists, do not regenerate a different database password in `.env` without rotating the database password too.

Stop the development server before running production preview on the same port:

```sh
npm run build
npm start
```

Localhost HTTP is permitted for a local production preview. Remote production `BETTER_AUTH_URL` must use HTTPS. Keep the URL consistent with the browser origin; use `localhost`, not `127.0.0.1`, with the default configuration.

## Validation

Verified on 2026-09-10: TypeScript passed; ESLint passed; Vitest 13/13 passed; Playwright 1/1 full journey passed; clean-database migration passed; installed migration status is up to date; optimized Next.js production build passed. The app is running on the local development server. A production service has not been deployed.

With PostgreSQL and the application running:

```sh
npm run check
npm run lint
npm test
npx playwright install chromium
npm run test:e2e
npm run test:migration
npm run db:status
npm run build
```

Vitest covers 13 tests: strict input and date handling, anonymous/tampered authentication, onboarding, persisted CRUD, two-user isolation, forged ownership, composite foreign keys, origin rejection, completion consistency, deletion cascades, password hashing/session revocation and atomic account throttling against rotating forwarded IPs.

The Playwright journey covers signup, onboarding, empty dashboard, course creation/detail/edit/delete, assignment creation/edit/completion/delete, exam creation/edit/delete, settings persistence, mobile overflow/navigation and sign-out. Test users are uniquely named and deleted by their exact IDs/emails afterward; regular users are untouched.

The migration verification script creates a randomly named PostgreSQL database, deploys the migration from zero, verifies all 10 tables and the migration record, then drops only that temporary database. It requires a local database role with CREATEDB privilege and does not reset the application database.

## Known limits and deployment preparation

- This is a working local foundation, not a deployed production service. Production hosting, managed database provisioning, TLS, backups/restore drills and operational monitoring are not configured.
- Email verification and password-reset delivery are not enabled. Account registration/sign-in/sign-out are implemented; add an email provider before a public launch if those account-recovery features are required.
- Better Auth's IP-based rate limit assumes a trusted ingress that sanitizes forwarded headers. The additional account limiter cannot be bypassed by changing those headers. Apply ingress-wide signup limits before opening a public service; each new email is a separate account bucket.
- Rate-limit rows are not automatically purged in this phase. Operations should periodically remove expired RateLimit and Verification records; no workflow automation has been introduced.
- Deadline inputs use device-local time and convert to UTC; dashboard/detail display uses the profile timezone. The forms disclose this. Timezone selection is editable as an IANA identifier.
- There is no calendar integration, notification delivery, email verification UI, document storage or AI configuration in this phase.

Next recommended work: review the working foundation with a real semester, then choose production hosting and complete account recovery/operational setup before adding the next AI/document slice. Do not implement the original Phase 3 automatically; the current follow-up already included its academic CRUD scope.

## Reference decisions

Prisma's official [Next.js/Better Auth guide](https://docs.prisma.io/docs/guides/authentication/better-auth/nextjs) and [Prisma 7 client setup](https://www.prisma.io/docs/orm/v7/prisma-client/setup-and-configuration/introduction) informed the adapter integration. Better Auth documents its [database-backed rate limiting and proxy trust requirements](https://better-auth.com/docs/concepts/rate-limit). Installed package types and runtime tests were used to verify the actual pinned APIs.
