> Historical Phase 1 proposal. For the implemented stack, six-model domain schema, runtime decision and current limits, see [FOUNDATION.md](FOUNDATION.md). The proposal below is not a claim that future features or Supabase integration are implemented.

# Student AI Agency — Phase 1

Status: architecture and schema scaffold only. No student runtime, database migration, authentication integration, or AI execution is implemented yet.

## Existing repository

The working tree was clean at inspection. `app/page.tsx` implements a Korean code-review workspace. `lib/analysis.ts` performs local rule-based analysis; `app/api/analyze` and `app/api/connection` call Gemini using a key supplied by the browser. React 19, Next.js 16, TypeScript strict mode, Tailwind 4, Zod and shadcn components are installed. The actual development/build runtime is Vinext/Vite and Cloudflare Workers, not the standard Next.js Node server. `db/schema.ts` is empty; Drizzle is installed, but the Sites manifest declares no D1/R2 bindings. `app/chatgpt-auth.ts` provides optional platform authentication helpers. There is no student persistence, RAG, orchestration, or learning system.

Preserve the existing application during Phase 1. Do not reuse its browser-supplied API key pattern for student features. Introduce student routes under `/student` in Phase 2; decide the final root route during product migration.

## Proposed architecture

Use a modular monolith: Next.js routes and React components call authenticated application services, which depend on repositories and provider interfaces. Only the student module is registered. Add future verticals through module registrations, not duplicated infrastructure.

Request flow: authenticated user → validated request → ownership-scoped repositories → ContextBuilder → AgentRouter → AgentExecutor → AIProvider / ToolRegistry → persisted run and result. Durable workflow steps invoke these same services. UI must never import database clients or AI credentials.

Preferred production stack: Next.js, React, TypeScript, Tailwind/shadcn, PostgreSQL with pgvector, Prisma, Supabase Auth and private Supabase Storage, OpenAI behind AIProvider, Zod, Vitest and Playwright. Keep the present runtime untouched until the Phase 2 compatibility spike. Sites disallows raw TCP; a Prisma deployment here needs an HTTP-compatible database transport, such as a verified Prisma Accelerate integration, or a separate Node backend. Conventional Next.js Node hosting is the fallback for the preferred direct PostgreSQL architecture. Do not silently substitute D1 for vector-capable PostgreSQL or replace the existing hosting manifest.

## Folder structure

```text
app/                         Existing application; future student routes/API adapters
components/ui/               Existing shared accessible primitives
features/student/            Student UI composition and form schemas
server/
  ai/                        Provider and agent contracts, registry/router/executor
  context/                   Scoped context assembly and token budgeting
  repositories/              Authenticated ownership-scoped persistence
  workflows/                 Durable, retryable predefined workflows
  integrations/              Auth, private storage, extraction, external adapters
prisma/schema.prisma         Proposed PostgreSQL data model
prisma/                      Future reviewed SQL migrations and vector/RLS SQL
docs/student-agency/          Architecture, delivery checklist, configuration
```

## Data design

The executable-format Prisma design contains all requested major entities. Agent is a global versioned catalog; other entities belong to a user. Profile stores school, semester, timezone and weekly capacity. Course owns assignments, exams, documents, quizzes and topics. DocumentChunk stores ordinal, page, metadata, model identifier and a 1536-dimensional vector. Conversations contain messages with citations and optional agent attribution; runs store status, usage and failure metadata.

Quiz contains typed questions; QuizAttempt and QuestionAnswer preserve individual answers and grading. LearningProgress aggregates attempts and correct answers by topic. Incorrect answers and mastery are derived, avoiding inconsistent redundant counters: incorrect = attempted − correct; mastery = round(100 × correct / attempted), with no attempts displayed as unassessed. Bands: weak below 40, developing below 70, good below 85, strong otherwise. Confidence is separately user-reported, not falsely inferred certainty.

StudyPlan has versioned daily StudyTasks and an optional exam. UserMemory contains explicitly editable/deletable preferences; conversation content never becomes memory automatically. Recommendation supports deduplication and expiry. WorkflowRun adds durable progress/retry state; CareerProject stores lightweight projects, skills and resume bullets. Notes initially persist as attributed conversation outputs; a dedicated saved-note entity can be added when editing/export becomes necessary.

Every personal model has userId. Composite foreign keys bind personal child references to the same owner. All service queries still require authenticated userId; database relations do not replace authorization. Quiz submission must additionally verify the question belongs to the attempt's quiz and topic belongs to its course. Document/conversation/plan cross-course references require service validation. Database CHECK constraints must enforce nonnegative counts, correct ≤ attempted, valid confidence, positive durations/sizes and ordered plan dates in Phase 2 SQL. Review deletion ordering because personal parent links use NoAction; account deletion must remove descendants transactionally and clean storage asynchronously. Vectors need extension/index SQL outside Prisma and must match the chosen embedding dimension.

## Authentication and privacy

Map the verified Supabase subject to User.authSubject. Never trust a userId supplied in request bodies or unverified incoming identity headers. Verify sessions on each protected route and operation. Use secure cookies, origin/CSRF checks for cookie-authenticated writes, request-size limits and Zod validation. Return 404 for absent or foreign resources. Add PostgreSQL RLS as defense in depth with transaction-local verified identity; privileged service connections must retain explicit tenant filters. Test RLS with the actual application database role.

Private uploads receive short-lived signed URLs only after ownership checks. Validate extension, MIME signature, size (initially 20 MB) and parser limits; use opaque server-generated object keys. Never expose service-role or provider credentials to the browser. Logs contain run IDs, timings and error codes, not document text, credentials or conversation bodies. Support memory deletion, document deletion including chunks/objects, conversation deletion and eventual full account export/deletion.

## Context and retrieval

buildUserContext(userId, request) resolves authorized selected course/document IDs, relevant upcoming deadlines, weak topics, preferences and the most recent bounded conversation history. Default caps: 8 history messages, 8 retrieved chunks, 10 deadlines, 5 weak topics, and an 8,000-token context budget. Truncate safely and reserve generation capacity. Explicit selection wins over inferred course; ambiguous requests ask the student. No whole-database prompt construction.

Upload → private object → durable ingestion job → page-aware extraction → overlapping chunks → batched embeddings → owner/course-linked vectors → READY. Implement TXT/Markdown first, then PDF with page references; DOCX is optional. Scanned PDFs should report OCR required rather than index empty content. Hash uploads for retry deduplication; retries must not duplicate chunks. Retrieval SQL filters userId and authorized course/document before ranking; use parameterized vector SQL, top-k cosine similarity and a relevance threshold. Do not fabricate an answer when evidence is insufficient. Citations resolve only to authorized document IDs and page/chunk locations. Treat all retrieved text as untrusted data, never tool instructions.

## Agents and workflows

AIProvider exposes generateText, generateStructuredOutput, generateEmbedding and streamText. Structured results must pass Zod validation. Registry metadata specifies agent key, module, version and allowed tools; executable prompts remain in version-controlled server code. Router uses explicit selection first and deterministic intent rules initially; manager handles ambiguous coordination. Executor enforces tool allowlists, budgets, timeouts, cancellation and run logging.

Academic Manager prioritizes deadlines and coordinates; Tutor explains using retrieval; Notes generates summaries/key concepts/formula sheets; Quiz generates typed questions and grades with explanations; Study Planner schedules around capacity, deadlines and weak topics; Career drafts bullets from user-supplied project evidence. Never invent career accomplishments.

Exam preparation: snapshot authorized exam/context → generate and validate plan → persist tasks transactionally → offer quiz → grade only submitted answers → update progress. New lecture: ingest → summarize → identify linked concepts → suggest questions. WorkflowRun records a unique idempotency key, current step, attempts and errors; a worker resumes failed steps with bounded backoff. Do not run long PDF jobs inside a streaming chat request. Generated plans require valid local dates, no past sessions and capacity checks. Completing quiz grading and updating counters must be one idempotent transaction.

## UI direction

Desktop-first neutral surfaces with a restrained blue accent, legible typography, generous spacing, and matching dark mode. Sidebar: Dashboard, AI Assistant, Courses, Study Plan, Documents, Progress, Career, Settings. Dashboard emphasizes today's tasks and approaching deadlines, then recommendations, course progress, documents and conversations. Each surface needs loading, empty, error and successful action states. Chat exposes course/document/agent selection and actual handling agent plus citations. No fabricated student records masquerading as a live account.

## Packages and configuration

Already installed: React, Next.js, TypeScript, Tailwind, shadcn primitives, Zod. Add in Phase 2 after runtime spike: matching pinned `prisma` and `@prisma/client`, `@supabase/supabase-js`, `@supabase/ssr`, `server-only`, `vitest`, `@playwright/test`. If retaining Sites, add the verified HTTP Prisma adapter/extension; use a PostgreSQL Node adapter only on Node hosting. Phase 4: `pdfjs-dist` in a compatible extraction worker, optionally `mammoth` for DOCX. Phase 5: `openai`. Do not install all future-phase packages now. The current schema deliberately uses Prisma 6 configuration syntax; verify and migrate configuration if selecting a newer major rather than installing an unpinned latest version.

See `environment.example` for placeholder variables. No real credentials were read or created. Only Supabase URL and publishable key may be public. Provider names, embedding model and dimensions must be explicitly configured and validated server-side.

## Major risks and acceptance gates

1. Hosting/database/extraction compatibility: prove authenticated persistence, vector query and PDF extraction on the chosen runtime before UI expansion.
2. Tenant isolation: adversarial two-user CRUD, vector retrieval, citations and signed URL tests are release blockers.
3. Hallucination and prompt injection: evidence thresholds, citations, constrained tools and grounded-answer evaluation fixtures are required.
4. Ingestion cost/time: byte/page/token limits, background jobs, bounded retries and per-user quotas; display actionable failed-ingestion state.
5. Grading reliability: deterministic MCQ grading; structured rubric-based text grading with visible uncertainty. Never treat generated grading as authoritative academic assessment.
6. Scheduling: store UTC instants plus profile timezone; test DST boundaries, overdue work, insufficient capacity and plan regeneration.
7. Deletion and retention: coordinate relational deletion, vectors, private objects and workflow retries; do not resurrect deleted content.
8. Operational readiness: API limits, request cancellation, usage ceilings, backup/restore rehearsal, migration rollback and secret management remain future work, not Phase 1 claims.
