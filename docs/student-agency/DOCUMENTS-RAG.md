# Student Agency — Documents + RAG handoff

## Scope and foundation verification

This phase adds academic document integration and retrieval infrastructure to the existing student workspace. Authentication, profiles, onboarding, dashboard, courses, assignments, exams and settings were inspected and retained. Before document changes, TypeScript, ESLint, all 13 existing tests and the original browser journey passed against the running PostgreSQL/Next.js app. Composite ownership relations and server-side session checks were verified. No foundation rewrite was required.

Students can upload PDF, TXT and Markdown files, attach them to an owned course, see queued/processing/ready/failed status, read extracted pages, privately download originals, retry failures, delete documents and search relevant passages with source citations. Course pages automatically associate uploads. The retrieval playground generates no answer. There are no new chat, agent, summary-generation, quiz, study-plan or recommendation workflows.

## Architecture and decisions

The existing Next.js Node server and Prisma/PostgreSQL architecture is unchanged. New server-only modules under `server/documents` separate storage, extraction, chunking, embeddings, processing and retrieval. `features/documents` owns UI and shared validation. APIs use the existing authenticated `api()` wrapper and take ownership from the verified session; the browser never selects a user identity.

No object-storage provider was configured. The MVP therefore uses a private filesystem directory outside `public`, rather than requiring new cloud accounts or credentials. `DocumentStorage` exposes `put/get/remove`; an S3-compatible adapter can replace it. This is suitable for one persistent Node host with the web process and worker sharing the same volume. It is not suitable for ephemeral/serverless disks or multiple hosts without shared storage.

Embeddings run locally through Transformers.js and ONNX on CPU. The provider is the minimal `EmbeddingProvider { id, generateEmbedding(text) }` interface. Its current implementation uses the 384-dimensional q8 MiniLM model `Xenova/all-MiniLM-L6-v2`, pinned to revision `751bff37182d3f1213fa05d7196b954e230abad9`. The revision and preprocessing version are saved with the document and every vector. Normal operation opens the exact cached revision directory and disallows remote downloads. Only the explicit setup command enables model downloads. Uploaded text is not sent to a remote AI service and requires no API key.

The queue is persisted in PostgreSQL document rows. A separate worker claims one job using `FOR UPDATE SKIP LOCKED`, assigns a unique lease token and renews a two-minute lease. A two-minute attempt deadline marks asynchronous stalls failed. A separate supervising process restarts a child that produces no progress for three minutes, including a blocked parser event loop; its JavaScript heap is limited to 512 MB. Native ONNX/PDF allocations are not a strict total-memory sandbox. Crashed attempts recover after lease expiry, up to three claims; exhausted attempts become FAILED. Graceful stop gives the child five seconds before terminating it.

Heavy parsing and document embedding do not run in upload requests. Final pages/vectors/READY status publish in one transaction only if the worker still owns the valid lease. Deleted or superseded work cannot publish. Explicit retry only transitions FAILED to UPLOADED atomically. Concurrent retries cannot create duplicate jobs.

## Schema and migration

The original foundation migration is preserved. `prisma/migrations/20260910220845_documents_rag/migration.sql` enables pgvector and adds:

- **Document:** one owner, optional course, title, original filename, detected type, byte size, private unique storage key, processing status/error, page count, embedding model, timestamps and durable queue/lease fields.
- **DocumentChunk:** document/owner/course references, sequence, content, page start/end, approximate token count, required `vector(384)`, model identifier, source metadata and creation time.
- **DocumentPage:** canonical extracted page text and original page number. This lets future consumers read the whole source without repeated chunk overlap.
- **FileDeletion:** durable filesystem-cleanup outbox, with attempts and retry time. It intentionally survives parent deletion.

Composite `(courseId,userId)` and `(documentId,userId)` foreign keys enforce ownership relations. User/course/document cascades remove dependent content. A BEFORE DELETE trigger inserts a cleanup job even for course/account cascades. Constraints enforce nonempty files up to 10 MiB and positive chunk token counts. Unique document/chunk and document/page positions prevent duplicate indexing.

Indexes cover owner/course library queries, document/page/chunk ownership, processing status/lease expiry and cleanup retry time. Semantic search is **exact cosine search** over an explicitly materialized authorized set. There is no approximate HNSW index yet: the small per-student library and pre-ranking ownership/course filters favor predictable recall. Evaluate filtered ANN only when actual scale justifies it.

Docker builds pgvector 0.8.2 on the existing PostgreSQL 17.11 Alpine base, retaining the database volume and libc family. The migration was applied to the existing database without resetting it. A pre-migration dump is kept in the ignored private local backup directory.

## Upload and processing flow

1. Verify session, completed onboarding and same-origin mutation.
2. Bound the streamed multipart body before parsing; accept a single file, title and optional course only.
3. Validate filename, extension and bytes: `%PDF-` signature for PDFs, strict UTF-8 and rejection of binary controls for text. MIME type alone is never authoritative.
4. Lock the owner while checking quota (100 documents / 100 MiB), verify and lock the optional owned course, and write a private UUID-named file atomically. No filename becomes a path. Files use mode 0600 and the directory mode 0700 when created.
5. Commit an UPLOADED row. Failed transactions compensate by removing the file; the worker also reconciles aged unreferenced upload files after one hour.
6. The worker marks PROCESSING, reads the original and extracts text with PDF.js, preserving page boundaries. UTF-8 TXT/Markdown has one logical page. Limits: 200 PDF pages, 400,000 extracted characters, 256 chunks and 10 MiB original size.
7. Pack paragraphs and sentences toward 700 approximate tokens with roughly 100-token overlap. Oversized sentences have a lossless fallback. Metadata discloses that token estimates use Unicode characters / 4. Short documents may naturally produce one smaller chunk.
8. The embedding adapter uses the model's actual tokenizer and covers all input in 200-token windows, combining normalized window vectors by token-weighted mean. Long source chunks are not silently truncated.
9. Atomically save canonical pages, source-attributed chunks and vectors, then mark READY. Failures become FAILED with safe, actionable text and a Retry action.

Scanned/empty PDFs require OCR before upload; damaged/encrypted PDFs fail safely. TXT/Markdown is rendered as escaped text, never executed HTML. PDF originals are served as private attachments, not embedded active content.

## Retrieval and future summary interfaces

`retrieveAcademicContext(userId, { query, courseId?, documentIds?, maxResults? })` validates scope, embeds the query using the matching provider, filters READY documents and chunks by their owner and model, applies course/document filters **before ranking**, then uses cosine distance. Default result count is 5 (range 1–10). The configurable minimum similarity is 0.35; irrelevant queries can return no passages. Whitespace/case-equivalent duplicates are removed. Scores are similarity measures, not calibrated confidence.

Results include content, document ID/title, page start/end, course ID/code, chunk index and similarity. Source titles/course information come from the authoritative joined document. Source links lead to its owned detail page. `documentSections`, `fullDocumentText` and `neighboringChunks` provide reusable owner-checked page-range, full-source and adjacent-passage access. Query-ranked retrieval provides relevant passages for future agents; no automatic summary or importance scoring runs on upload.

Changing model dimensions requires a schema migration. Changing the model or preprocessing identifier requires reindexing; incompatible old vectors are excluded. The MVP UI retries failed documents only. Model replacement/reindex tooling is future work.

## APIs and pages

- `/student/documents`: private library, upload, course filter, processing states and deletion.
- `/student/documents/[id]`: metadata, status, retry, extracted page reader and original download.
- `/student/documents/playground`: course/document filters, semantic question, retrieved passages and citations.
- `/student/courses/[id]`: functional document section and automatically associated uploads.
- `GET/POST /api/student/documents`: list/upload.
- `GET/DELETE /api/student/documents/[id]`: details/deletion.
- `POST /api/student/documents/[id]/retry`: queue a failed document.
- `GET /api/student/documents/[id]/download`: verified private attachment.
- `GET /api/student/documents/[id]/sections?fromPage=1&toPage=5`: up to 20 consecutive extracted pages.
- `POST /api/student/rag/search`: scoped semantic retrieval.

## Security and deletion

Every public route requires a verified session and every personal query includes ownership. Foreign IDs yield 404; anonymous callers receive 401. Strict schemas reject forged frontend `userId` fields. SQL values are parameterized, including the query vector and filters; no string-concatenated SQL values are used. Composite foreign keys add database-level relationship protection; PostgreSQL RLS is not claimed.

Storage keys, leases and server filesystem paths are excluded from public DTOs. Private downloads recheck ownership, use no-store cache headers, attachment disposition, nosniff and a restrictive CSP. Storage rejects arbitrary keys and symlink reads. Secrets and local originals/models/backups are ignored by Git.

Deletion commits cascades and enqueues physical cleanup together. Immediate file cleanup is best effort; failures return successful deletion with `cleanupPending`, and the worker retries the durable outbox. Even if disk cleanup is pending, the deleted document has no downloadable API reference and its vectors are gone. Course deletion warns that its documents will also be removed. An in-flight processor cannot recreate a deleted record.

The worker is a trusted system process and therefore claims jobs across users; callers never expose that function as a browser API. It is separate from user-facing owner-checked services. Infrastructure operators still have access to local disk/database backups; this is not end-to-end encrypted storage.

## Files changed

- `prisma/schema.prisma`, the new documents migration, `compose.yaml`, `docker/postgres.Dockerfile`, and `scripts/verify-migration.mjs` define and verify database support.
- `server/documents/{config,service,upload,processor,cleanup}.ts`, `storage/local.ts`, and `extraction/`, `chunking/`, `embeddings/`, `retrieval/` contain the new backend.
- `app/api/student/documents/**`, `app/api/student/rag/search/route.ts`, and the existing `server/api.ts` expose authenticated operations and private responses.
- `features/documents/{components,validation,types.ts}`, `app/student/documents/**`, course detail and `features/student/components/item-actions.tsx` implement the user flow.
- `server/services/academic.ts` integrates course cascade cleanup.
- `scripts/document-worker.{mjs,ts}`, `scripts/prepare-embeddings.ts`, `next.config.ts`, package manifests, `.gitignore` and `.env.example` configure runtime/dependencies.
- `tests/documents-unit.test.ts`, `tests/documents.test.ts`, `tests/browser/documents.spec.ts`, `tests/fixtures/documents.ts`, `tests/server-only.ts` and `vitest.config.ts` add real extraction, model, DB, HTTP and browser verification.
- README and this handoff document setup and operation. The historical foundation handoff remains linked.

New direct runtime dependencies: `@huggingface/transformers@4.2.0` and `pdfjs-dist@6.3.289`. New development dependency: `tsx@4.23.13` for TypeScript worker/setup scripts. ONNX Runtime is the model library's transitive native dependency. The DB image adds pgvector 0.8.2. No paid provider or external job queue was added.

## Environment and exact local setup

Use Node 22.13+ (Node 24 verified), npm and Docker Desktop. Use localhost consistently with Better Auth; default ports are 3000 and 5439. From the project root:

```sh
npm ci
npm run setup:local
npm run db:up
npm run db:generate
npm run db:migrate
npm run embeddings:prepare
npm run dev
```

In another terminal in the same directory:

```sh
npm run documents:worker
```

Open `http://localhost:3000`, create/sign into an account, finish onboarding, create a course and upload your document. Open Documents or the course, wait for Ready, then choose Search this document. `npm run documents:worker -- --once` performs a single maintenance/claim cycle.

Existing `.env` values (DATABASE_URL, POSTGRES_PASSWORD, BETTER_AUTH_SECRET, BETTER_AUTH_URL) are retained. `setup:local` does not overwrite them. New optional settings:

- `DOCUMENT_STORAGE_PATH`: defaults to `.local/documents`; must be a persistent private path shared by web and worker, never `public`.
- `EMBEDDING_CACHE_PATH`: defaults to `.local/models`; web/worker must use the same prepared model directory.
- `RAG_MIN_SIMILARITY`: defaults to `0.35`, allowed range 0–1.
- `EMBEDDING_ALLOW_DOWNLOAD`: leave unset during normal operation; the prepare script sets it to `true` in its own process only.

The initial Docker build and model preparation need network access. Normal indexing/search uses the cached model. Keep both database and private originals backed up together. `npm run db:down` preserves the Docker volume. Stop the dev server before `npm run build` followed by `npm start` on the same port, and continue running the worker separately.

## Verification

Validated with real PostgreSQL, actual multi-page PDF extraction and the real local MiniLM model. Only failure/race tests substitute the `EmbeddingProvider` boundary; application services, storage, chunking, authorization and SQL are not mocked. The `server-only` test alias bypasses only the framework's client-import guard in Node tests.

Commands:

```sh
npm run check
npm run lint
# Keep app + DB running; stop the background worker while tests control job claims.
npm test
npm run test:migration
npm run db:status
# Start the worker for browser verification.
npx playwright install chromium
npm run test:e2e
npm run build
```

Vitest: 28 passing tests across the original foundation and new document suites. New coverage includes real embeddings, PDF page extraction, lossless punctuation/long-text chunking, finite vector validation, upload/auth/course/file limits, 384-dimensional persisted vectors, semantic paraphrase and irrelevant queries, two-user isolation, course/document prefilters, private original downloads, source sections, safe failure/retry, duplicate claims, lease recovery, never-resolving providers, stale-worker fencing, in-flight deletion, course cascades and retried physical cleanup.

Clean-database verification confirms 14 tables, 2 applied migrations, pgvector 0.8.2 and the deletion trigger. It creates/drops only a uniquely named temporary database. Regular student data is not reset. Tests create uniquely named disposable accounts and clean up their own records.

Playwright: both full browser journeys pass — the existing signup/onboarding/academic CRUD/settings flow, plus course PDF upload through the actual worker, READY status, page reading, original download, semantic search, citations, irrelevant query and deletion. Desktop and 390 px mobile screenshots were visually inspected; no horizontal overflow was found. The induction query returned its source passage with similarity 0.661 and page range 1–2. TypeScript, ESLint and the optimized Next.js build pass; the installed database migration status is current. Browser screenshots are local-only under `.local/verification` and show disposable test data.

## Known limits and next phase

- Local persistent-host MVP, not a deployed production service. No cloud storage, managed queue, OCR, antivirus service, DOCX parser or encrypted-PDF support.
- The current MiniLM model is primarily English. Korean/multilingual and math-heavy formula/layout retrieval require further evaluation and potentially a different model. PDF columns, tables and equations can extract imperfectly.
- Character-based chunk token counts are approximate. Pooling 200-token model windows covers all text but can dilute fine-grained meaning; no reranker, semantic segmentation model or broad retrieval benchmark is claimed. The irrelevant-query tests are smoke tests, not proof that all off-topic queries will be rejected.
- Library quota is deliberately small. Exact vector ranking should be benchmarked before increasing it. No per-user scheduling fairness or comprehensive public-service rate limits are implemented for document/search APIs.
- The worker must run for queued documents and deferred cleanup to progress. Runtime/provider failures remain visible and require Retry; crash recovery is automatic. The watchdog is process isolation for reliability, not a complete hostile-file OS sandbox.
- No automatic summaries, LLM generation or agent orchestration is implemented. The original foundation's production limitations (email recovery, ingress limits, backups/monitoring) still apply.

Recommended next phase, only when separately requested: establish a retrieval quality evaluation set using real course material, choose production persistent storage/runtime and complete account recovery, then build one citation-grounded Tutor interaction using these owner-scoped services. Do not automatically proceed to the full agent system.
