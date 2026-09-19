# LMS / Course Import Foundation

## Scope and architecture

This phase provides provider-independent import and synchronization plus an in-memory **test adapter**. No real Canvas, Moodle, Brightspace or Blackboard connection is offered. Settings shows that institution connections are unavailable until an actual production adapter is installed. The test registry is dependency-injected into tests and cannot register in the default production registry.

`AcademicIntegrationProvider` isolates external payloads, permissions, pagination and downloads. Its typed capabilities cover courses, assignments, assessments, files, and a reserved future announcement capability. Unimplemented capabilities are not requested. The normalized Zod schemas contain only import data, use explicit timezone offsets, and convert timestamps to UTC. Providers must resolve institutional timezones before normalization; floating local timestamps are rejected.

The service reuses `ConnectedAccount`, the encrypted credential service, `IntegrationSyncState`, existing academic creation services, pg-boss jobs and the existing Document/RAG pipeline. No provider-specific agents, academic tables, queue infrastructure, or embedding pipeline were introduced. `replaceDocumentSource` extracts the existing Drive replacement path for shared source refresh without changing extraction or retrieval behavior.

## Mapping and field ownership

- `ExternalCourseLink` maps an account plus stable external course ID to exactly one owned Course. The user explicitly creates a course or chooses an existing one. Suggestions compare exact normalized course code, name and term; section codes are retained, with no fuzzy automatic merging. Existing course properties remain user-managed.
- `ExternalAssignmentLink` maps a course-scoped external ID to Assignment. Provider-managed fields are title, instructions/description, due date and source URL. User priority, estimated hours, completion status and completion timestamp are preserved. Newly imported assignments start TODO/MEDIUM with no assumed effort; ambiguous provider submission states do not imply local completion.
- `ExternalExamLink` maps an explicit exam, midterm, final or major assessment with a scheduled date to Exam. Ordinary quizzes, practice and undated assessments are excluded with a preview reason. Title and date follow the provider; initial topics are copied, while subsequent topic edits and personal notes remain local.
- Existing `ExternalFileLink` maps source files to Document and now optionally links to the academic course source. It retains provider, connected account, external file ID, modification time, import/check times and a safe source link. There is no duplicate LMS file-link table.

Internal Assignment/Exam dates remain required. Undated new items are skipped rather than assigned invented dates. If a previously imported assignment loses its due date, its link becomes UNSCHEDULED; an assessment no longer eligible for Exam becomes UNMAPPED. The existing internal item keeps its last known date and user data, and the course status reports skipped items. This foundation does not add a new undated-task model.

A fully traversed source snapshot can mark disappeared links MISSING (files UNAVAILABLE). Incremental reads only mark IDs explicitly reported deleted. Local records and learning/planning data survive source deletion, provider outages and account disconnect. Deliberate local course/document deletion retains the existing domain deletion and private-file cleanup behavior.

## Import and sync

Preview reads only the selected course and selected categories, showing eligible counts, exclusions, and course matches before writes. A ten-minute signed preview token binds the account, user, course, options and normalized selected metadata. Confirmation rechecks the provider snapshot; stale or tampered previews require a new review.

Import creates the Course/source link and `sync-external-course` job in one transaction. Linking an existing Course uses that same path. External IDs and owned composite foreign keys prevent duplicates. The job derives its user from the ConnectedAccount; a frontend-supplied userId is rejected.

Manual and scheduled sync use the same per-course job. Database leases and queue groups prevent concurrent workers. Request versions deduplicate queued requests. A crashed worker's expired lease can be recovered through manual sync. The job has an eight-minute service deadline, a ten-minute queue timeout and at most two retries with bounded backoff. Provider/database errors retry; permission, invalid data, unsupported limits and missing resources do not endlessly retry.

Defaults: deadline metadata every 180 minutes, file metadata every 24 hours, with a sweep at minute 23 each hour. `ACADEMIC_SYNC_MINUTES` (30–1440), `ACADEMIC_FILE_SYNC_HOURS` (6–168) and `ACADEMIC_SYNC_CRON` configure cadence. The existing scheduler enablement flag still applies. Inactive, disconnected, not-yet-due and ended courses are excluded. Manual sync includes files immediately.

Adapters may support updatedSince or opaque sync tokens. Checkpoints are encrypted with existing user/provider-bound encryption. Updated-since uses the read's start time, preventing changes during a read from falling through a time gap. Expired checkpoints allow one bounded fresh snapshot fallback. Snapshot-only adapters need no checkpoint or OAuth encryption configuration. Partial reads do not advance checkpoints or infer missing records.

Bounds: 25 records per page, at most eight pages, 100 assignments/assessments and 20 files per selected category. Overflow or invalid pagination is reported instead of importing a truncated course and falsely marking sources deleted. Failures are isolated per category/item; successful deadlines remain committed when a file fails. Course status stores bounded counts/errors, last sync and last complete success.

## Documents and intelligence

PDF, TXT and Markdown files up to 10 MB pass the existing file validation, library quotas, private storage, extraction, chunking, local embeddings and vector indexing. Unsupported files are excluded in preview. Download adapters must honor cancellation, enforce a byte limit while streaming, and fetch the requested source version or reject a version mismatch. They must never forward account credentials to arbitrary download URLs.

Changed source files retain Document identity and the user's title. A staged replacement publishes all new chunks/vectors and source metadata atomically, then removes old private bytes through the existing deletion outbox. Failed replacements retain the previous ready copy. Failed initial processing can recover without creating duplicate documents. Unchanged ready files are not downloaded again.

The existing Context Builder, Tutor, Notes, Quiz, Lecture Study and Assignment Support consume imported documents normally, including owned document/page citations. Imported assignments and exams flow through existing Study Planner, Recommendation and Reminder logic. Sync invokes the established best-effort recommendation/reminder refresh after committing domain data. Import/sync performs no generative LLM calls; local document embeddings use the existing provider.

## Connection and security extension points

`ConnectedAccount.connectionConfig` is **non-secret** provider configuration only (for example, a validated institution URL). Each adapter supplies its own strict schema. Authentication can be OAuth2, API-token, institution-managed, or test. `AcademicCredentialAccess` is a server-only callback boundary to the existing OAuth token service/encryption or a secret vault; do not store tokens in connectionConfig or expose them in normalized payloads. A future production provider must supply actual connection/authentication routes and a credential resolver before registry registration. This phase does not claim real institutional authorization was tested.

All HTTP routes use existing authentication, onboarding and origin checks, plus private no-store responses. The service checks account/course ownership, capability grants and owned mappings. Account authorization is rechecked after external calls and inside publication transactions. Disconnect clears stored tokens, increments credentialVersion, invalidates leases/cursors and disables course sync, while retaining imported academic data. Logs contain event names, internal source-link IDs and counts only; upstream response bodies, descriptions, file contents and credentials are not logged.

## Routes and operation

- `GET /api/student/academic-integrations`: available provider/account summaries.
- `GET /api/student/academic-integrations/accounts/[id]/courses`: bounded provider course browser.
- `POST /api/student/academic-integrations/preview`: selected import preview.
- `POST /api/student/academic-integrations/import`: confirmed create/link and queue.
- `DELETE /api/student/academic-integrations/accounts/[id]`: disconnect, preserve copies.
- `GET /api/student/courses/[id]/integration`: source status (JSON null for unlinked courses).
- `POST /api/student/courses/[id]/integration/sync`: same queued sync used by the scheduler.

Apply `npm run db:migrate` and regenerate with `npm run db:generate`. Run the existing `npm run jobs:worker` to process import jobs; existing document processing code is reused by the import worker. Prepare the local embedding model using the existing setup instructions. No production LMS credentials are required for the automated fixture suite.

## Verification

The focused suite uses real PostgreSQL, owned academic models, private file storage, extraction, local embeddings, vector search and a real isolated pg-boss queue. Only the LMS adapter/network and downstream generation boundaries are fixtures. Tests cover preview confirmation, options, capability/configuration validation, exact matching, transactional queue rollback, timezone normalization, duplicate/concurrent sync, personal-field preservation, source deletion, partial failures, encrypted/incremental checkpoint fallback, expired lease recovery, cancellation and disconnect races, cross-user database constraints, file replacement/recovery, real agent workflows and Planner/recommendation/reminder compatibility.

Browser tests cover honest production unavailability, selected-category preview, explicit course linking, no controls on unlinked courses, manual sync state, navigation and mobile layout. Directly affected Drive, OAuth, Calendar, document, background job, Context Builder, course workspace, learning workflow and planning/reminder tests are run alongside TypeScript, lint, production build and fresh-database migration verification.

Verification completed on 2026-09-19: **437 distinct relevant tests** across 14 files, including **59 LMS tests**, plus **six browser tests** across LMS, Drive, OAuth settings and Calendar. The 13-file regression run passed 424 tests; the final LMS run added three recovery/authorization cases, and the document HTTP suite added ten tests. TypeScript, full ESLint and final affected-file lint, production build, and a fresh database migration passed (25 migrations, 51 tables).

Commands used:

```sh
npx vitest run tests/academic-integrations.test.ts tests/drive.test.ts tests/integrations.test.ts tests/calendar.test.ts tests/background-jobs.test.ts tests/course-workspace.test.ts tests/context.test.ts tests/assignment-support.test.ts tests/lecture-study.test.ts tests/study-planner.test.ts tests/recommendations.test.ts tests/reminders.test.ts tests/documents-unit.test.ts
npx vitest run tests/documents.test.ts
npx vitest run tests/academic-integrations.test.ts
npx playwright test tests/browser/academic-integrations.spec.ts tests/browser/drive.spec.ts tests/browser/integrations.spec.ts tests/browser/calendar.spec.ts
npm run check
npm run lint
npm run build
npm run test:migration
```

No implementation blockers remain. Live institutional access is intentionally outside this phase; only the provider-independent contract and test adapter have been verified.

## Files in this phase

41 files (earlier Calendar/Drive changes are preserved):

- `.env.example`
- `README.md`
- `app/api/student/academic-integrations/accounts/[id]/courses/route.ts`
- `app/api/student/academic-integrations/accounts/[id]/route.ts`
- `app/api/student/academic-integrations/import/route.ts`
- `app/api/student/academic-integrations/preview/route.ts`
- `app/api/student/academic-integrations/route.ts`
- `app/api/student/courses/[id]/integration/route.ts`
- `app/api/student/courses/[id]/integration/sync/route.ts`
- `docs/academic-integrations.md`
- `features/documents/components/detail.tsx`
- `features/student/academic-integrations/course-status.tsx`
- `features/student/academic-integrations/settings.tsx`
- `features/student/courses/course-workspace.tsx`
- `features/student/integrations/settings.tsx`
- `lib/student/academic-integrations/types.ts`
- `prisma/migrations/20260919160000_academic_integration/migration.sql`
- `prisma/schema.prisma`
- `scripts/verify-migration.mjs`
- `server/academic-integrations/access.ts`
- `server/academic-integrations/config.ts`
- `server/academic-integrations/errors.ts`
- `server/academic-integrations/events.ts`
- `server/academic-integrations/http.ts`
- `server/academic-integrations/normalize.ts`
- `server/academic-integrations/registry.ts`
- `server/academic-integrations/service.ts`
- `server/academic-integrations/test-provider.ts`
- `server/academic-integrations/types.ts`
- `server/documents/replacement.ts`
- `server/drive/service.ts`
- `server/integrations/connections.ts`
- `server/integrations/service.ts`
- `server/jobs/errors.ts`
- `server/jobs/registry.ts`
- `server/jobs/schedule.ts`
- `server/jobs/sync-external-course.ts`
- `server/jobs/worker.ts`
- `server/services/academic.ts`
- `tests/academic-integrations.test.ts`
- `tests/browser/academic-integrations.spec.ts`
