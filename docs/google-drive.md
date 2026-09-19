# Google Drive course document imports

Drive is a read-only, explicitly selected source for the existing document library. It does not create a second RAG pipeline or call an LLM for listing, importing or refreshing files.

## Permission and setup

Enable Google Drive API in the existing Google OAuth project. Keep the existing server-only `GOOGLE_INTEGRATION_CLIENT_ID`, `GOOGLE_INTEGRATION_CLIENT_SECRET`, `INTEGRATION_TOKEN_KEYS` configuration and existing callback URL. In Settings → Integrations, connect Google and explicitly choose **Enable Drive**. Existing Calendar grants are retained through incremental consent; ordinary account connection does not request Drive access.

The centralized `drive-read` capability uses `drive.readonly`: the read-only scope compatible with browsing existing accessible files and downloading their contents entirely on the server. It allows broader access than the selected imports themselves. `drive.file` with Google Picker offers narrower per-file authorization, but adopting its browser token flow conflicts with this phase's requirement that Google access tokens never reach the browser. This implementation neither requests Drive writes nor silently expands permissions. Public deployment must complete the applicable Google restricted-scope verification requirements. See [Google's scope guidance](https://developers.google.com/workspace/drive/api/guides/api-specific-auth).

Apply migrations with `npm run db:migrate`. Run the existing `npm run jobs:worker` alongside the application; it registers `import-google-drive-file`. The existing document worker remains compatible and can finish any uploaded document if a job stops after file creation. Prepare the existing embedding model and mount the same private document/model volumes already used by uploads. No additional AI configuration is required.

## Architecture

- `GoogleDriveService` normalizes Google metadata into `ExternalDriveFile`. It uses `withProviderClient`, centralized scope/ownership checks, token refresh and encrypted storage; Drive feature code never reads encrypted credentials.
- Provider downloads accept only bounded, relative Drive file/export paths. Credentials remain server-side; redirects are rejected. JSON and binary response sizes are bounded, including when metadata or Content-Length is missing or wrong. Google 403 rate-limit reasons remain retryable, distinct from lost permission.
- Listing returns at most 30 files plus an opaque next-page token. Filename search escapes Drive query literals. Folder navigation reads one folder's metadata page; it does not recursively crawl files. File listings are never fed to AI.
- `ExternalFileLink` references the owning user, connected account, course and optional imported Document. Composite foreign keys enforce ownership; `(connectedAccountId, externalFileId, courseId)` prevents accidental duplicates while permitting multi-course use. Pending links reserve one selected import until its Document exists.
- Each selection creates a durable job in the same database transaction as its link. Job payload contains only account/file/course IDs plus the existing version/tracking envelope. User identity is derived from the account server-side. A versioned idempotency key and per-file/course lease prevent duplicate downloads/publication. Retries are bounded to two retries after the initial attempt, with backoff and timeouts. Missing files, unsupported content, missing permission and revoked grants are terminal.
- The API receives one request per selected file (UI batches up to 10); failures remain independent and visible. A queue insertion failure rolls back that file's request. Re-selecting a failed import can retry it. Re-selecting an imported file returns its existing Document.

## Document processing and source replacement

PDF, UTF-8 TXT and Markdown reuse existing byte/signature validation, 10 MB per-file limits, 100-document/100 MB library quotas, private storage, PDF/text extraction, chunking and embeddings. Unsupported formats, including DOCX, archives, executable files and unsupported Google Workspace types, are rejected before download where possible. Google Docs export through the official PDF endpoint, preserving useful page/source metadata. See [Google's download/export guide](https://developers.google.com/workspace/drive/api/guides/manage-downloads) and [paginated file listing](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/list).

Initial imports use `uploadDocument` and `processNextDocument`. The normal Document status is authoritative after creation: queued/processing, ready or failed. Source-link status only describes import/refresh availability. Processing failures can use the existing Document retry action.

A freshness check reads metadata only. An unchanged source is not downloaded or re-embedded. **Refresh from Google Drive** explicitly queues a changed source. Refresh downloads and validates bytes, then uses the shared `prepareDocument` function for extraction/chunking/embedding without touching active content. PDF input is copied because PDF.js transfers its buffer. Metadata is checked before and after download; a changing source is retried instead of being recorded under the wrong timestamp.

After preparation, an ownership- and lease-checked transaction locks the Document, replaces its pages/vectors, swaps the storage pointer, and updates link timestamps. All old chunks disappear atomically when new chunks become active. Document ID/title and references remain stable. Failed download, extraction, embedding, storage or publication leaves the old usable copy intact. Old source bytes enter the existing durable deletion outbox. On an uncertain commit acknowledgement, staged bytes are removed only if the database confirms they are unreferenced; ordinary orphan reconciliation remains the fallback.

Deleted/trashed/inaccessible sources are marked unavailable without removing imported copies. Disconnect immediately invalidates pending/in-flight imports and blocks future browsing, freshness checks and refresh; already copied Documents remain available. Course/Document deletion cascades external links and uses the existing file deletion trigger. There is no continuous Drive mirror.

## Product and agent integration

Settings displays Drive access, imported count, last successful access and **Browse Drive**. The browser supports filename search, pagination, folders, multi-selection, course selection and partial progress. Course → Documents preselects the course and shows **Upload document** beside **Import from Google Drive**. Copies appear in the same document list with a subtle source label. Document detail provides freshness, explicit refresh and a source link restricted to HTTPS `drive.google.com`/`docs.google.com`.

Tutor, Notes, Quiz and Lecture Study receive imported material through the existing Context Builder/retrieval APIs. No agent performs a Drive API call. Their source citations retain Document title and PDF page numbers.

Observability uses fixed import/refresh/request/failure/source-unavailable/token-scope events and existing JobRun tracking. Logs exclude OAuth tokens, download URLs, file contents and provider error bodies.

## Verification

Focused Drive tests exercise real PostgreSQL, private storage, PDF/text extraction, embeddings and vector retrieval while mocking only Google HTTP and, for agent orchestration, generation responses. Coverage includes scopes, incremental authorization, pagination/search/folders, types/export/size limits, ownership, duplicate/multi-course/partial imports, real pg-boss insertion/execution, retries, source attribution, all three agent context contracts, actual Lecture Study execution, freshness, atomic refresh, failed-refresh preservation, cancellation, concurrent workers, deletion and disconnect races. Browser tests cover separate consent and course file selection with partial results on mobile. Existing document, OAuth, Calendar, queue, Context Builder, agent and course-workspace regression suites are also run.

Verification result: 300 distinct relevant tests passed across 12 files (including 50 Drive tests), plus four browser tests across Drive, Integrations and Calendar. TypeScript, ESLint and the production build passed. A fresh database applied all 24 migrations and verified 48 tables.

Real Google consent/export testing requires valid Google OAuth credentials and an authorized test account. This workspace has no configured real Google integration credentials; tests use synthetic credentials and mocked Google HTTP. Do not treat passing fixture tests as live Google verification.

## Files in this change

34 files (existing uncommitted Calendar changes are preserved):

- `README.md`
- `app/api/student/documents/[id]/source/refresh/route.ts`
- `app/api/student/documents/[id]/source/route.ts`
- `app/api/student/drive/accounts/[id]/files/route.ts`
- `app/api/student/drive/accounts/[id]/imports/route.ts`
- `app/api/student/drive/accounts/[id]/route.ts`
- `app/api/student/drive/imports/route.ts`
- `docs/google-drive.md`
- `features/documents/components/detail.tsx`
- `features/documents/components/library.tsx`
- `features/documents/types.ts`
- `features/student/drive/browser.tsx`
- `features/student/drive/settings.tsx`
- `features/student/drive/source.tsx`
- `features/student/integrations/settings.tsx`
- `lib/student/drive/types.ts`
- `prisma/migrations/20260919120000_google_drive/migration.sql`
- `prisma/schema.prisma`
- `scripts/verify-migration.mjs`
- `server/documents/processing.ts`
- `server/documents/processor.ts`
- `server/documents/service.ts`
- `server/drive/events.ts`
- `server/drive/google.ts`
- `server/drive/http.ts`
- `server/drive/service.ts`
- `server/integrations/errors.ts`
- `server/integrations/google.ts`
- `server/integrations/service.ts`
- `server/integrations/types.ts`
- `server/jobs/import-google-drive-file.ts`
- `server/jobs/registry.ts`
- `tests/browser/drive.spec.ts`
- `tests/drive.test.ts`
