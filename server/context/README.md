# Context Builder

Read-only context preparation for AI consumers. It reads the existing learning-intelligence aggregates but does not calculate or update them. No agents, routing, generation, tool execution, conversations, UI, or new HTTP endpoint is added. Existing RAG and AIProvider code is unchanged.

## Server-side entry point

```ts
import { buildUserContext, formatContextForAI } from "@/server/context";

// In an authenticated server route/service, use the incoming request headers.
const context = await buildUserContext(
  {
    request: "Explain mathematical induction from my lecture.",
    courseId,
    documentIds: [documentId],
    options: { profile: true, course: true, documents: true },
  },
  request.headers,
);
const referenceText = formatContextForAI(context);
```

The entry point verifies the existing Better Auth session and derives its user ID. It does not accept a caller-supplied `userId`; unknown fields are rejected. It requests no session refresh. Server components can pass `await headers()` from `next/headers` instead. Do not obtain headers or identity from an unverified upstream identity assertion.

Every context query is scoped to that verified owner. Supplied course/document IDs are checked even if their output categories are disabled; document/course mismatches and foreign IDs fail with the existing not-found error. No fallback to another user's or broader scope occurs. Authentication and invalid-input failures use safe `ContextError` categories. Source retrieval failures propagate instead of silently returning incomplete context as success.

## Selection and public contract

All categories default to **false**. Selected readers execute; `academicOverview` also loads its profile/deadline/learning prerequisites internally, exposing those categories only if selected. The request text guides document retrieval; it is not copied into context. There is no automatic agent or intent inference.

- `profile`: name, school, program, year, semester, goal, timezone, explanation difficulty and study-session length. No email, account ID, credentials, authentication metadata or entire ORM object.
- `course`: selected owned course metadata only. No implicit enumeration of courses or their child records.
- `assignments`: incomplete assignments, overdue by at most 30 days or due within the upcoming window; earliest deadlines first, then priority. The optional course filter applies before limiting.
- `exams`: upcoming exams within the window, chronological order, selected-course filter, topics and approximate days remaining. Private notes are excluded. Days remaining uses ceiling of elapsed 24-hour intervals, not local calendar-day arithmetic.
- `documents`: calls `retrieveAcademicContext` with the actual request, verified user ID and supplied course/document filters. Returns bounded passages with document ID/title, page start/end, course, chunk index and similarity. No full documents or duplicate vector pipeline.
- `memories`: requires `memories: true`. Agent-specific categories and keys narrow retrieval; otherwise the request determines relevant categories. Only active, owned, validated values pass.
- `learning`: bounded weak, strong and recommended topic summaries from the learning-intelligence service. Each summary contains owned course identity, mastery, confidence, recent accuracy, practice counts, status, trend and last-practiced time. Raw attempts and answers are excluded. When no learning evidence exists, the category is reported as unavailable instead of inventing progress.
- `academicOverview`: current-semester course attention, exact workload counts, academic risks, confidence-aware exam readiness and existing study-plan progress. Uses at most 20 course details, 3 active plan summaries and 8 upcoming sessions. Exact aggregate counts remain complete when detail lists are capped. In overview mode the existing deadline and learning readers share semester scope, and open overdue work has no 30-day cutoff. An explicit course overrides semester scope. Exam topic coverage is drawn from the same learning read, with missing evidence reported conservatively.

`types.ts` exposes context DTOs independent of Prisma. `categories.ts` contains independent readers; `builder.ts` handles authentication, scope, selection and budgeting; `format.ts` formats selected data. A future category can add its reader and typed selection without rewriting the other readers. Calendar and email context are not implemented.

## Limits and minimization

`options.deadlineWindowDays` defaults to 30 and allows 1–90 days. Limits are validated, not silently expanded:

- `limits.assignments`: default 6, maximum 20.
- `limits.exams`: default 4, maximum 10.
- `limits.documents`: default 5, maximum 10.
- `limits.memories`: default 5, maximum 10.
- `limits.learning`: default 5, maximum 10 per weak, strong or recommended group.
- `limits.maxCharacters`: default 24,000, range 2,048–40,000.

Individual text fields are capped, including 500-character goals, 1,000-character course descriptions, ten exam topics and 3,500-character passages. The total serialized selected-data payload is then bounded; lower-priority categories/items are removed first. Priority is profile, course, academicOverview, assignments, exams, documents, memories, learning. Within arrays the nearest deadlines and highest-ranked passages are retained first. A caller needing document-heavy context should select fewer other categories. Source metadata is kept with each retained passage.

Metadata includes requested/unavailable categories, field/budget truncation categories, generation time, serialized context character count and a rough character-count/4 token estimate. Counts exclude metadata and formatting labels and are **not** a tokenizer-based LLM budget. SQL row limits/time windows can omit more records without a count query; truncation metadata is not an exhaustive count of omitted database rows. No unlimited historical tasks or conversation history is fetched.

Document-enabled requests must match existing RAG's 3–1,000-character query limit; they are rejected if oversized rather than silently searching a truncated request. Other requests allow up to 10,000 characters. Selected document filters are capped at 20 IDs.

## Relevant long-term memory

Context Builder delegates memory selection to `server/memory`. Agent definitions
declare task-specific categories and structured keys; retrieval ranks only active,
owned records using relevance, confidence, importance, recency and staleness.
Returned items include source type and confidence so inferred patterns are not
presented as facts. Unknown legacy keys, sensitive key names, candidate records,
archived records and invalid values are excluded. See `server/memory/README.md`.

## Formatting

`formatContextForAI(context)` returns compact labeled JSON sections and omits empty sections. No content returns an empty string. JSON escaping prevents literal newlines in stored values from creating new section boundaries. A reference-data notice warns against treating embedded instructions as commands. This is not a complete prompt-injection defense: future executors must keep authoritative instructions separate from untrusted user/document content. The structured DTO remains available independently.

## Focused verification

```sh
npm run check
npm run test -- tests/context.test.ts
```

The focused suite uses real Better Auth sessions, PostgreSQL and the existing local RAG model. It creates two disposable test accounts, verifies ownership and selection, compares document results to the existing retrieval service, and deletes its own fixture records afterward. No OpenAI request or AI answer generation occurs. It requires the existing DB and prepared embedding cache, but no running web server. Call-through spies verify disabled categories do not execute queries or embeddings; the Context Builder itself is not mocked.

Coverage includes profile minimization, default-empty selection, course authorization, forged identity rejection, overdue/upcoming limits, exam filtering, actual-query RAG/citations, memory allowlists, bounded owned learning summaries, absent learning data, character budgets, malformed inputs, formatting and read-only academic/session behavior.

Memory retrieval remains bounded and does not change document RAG behavior or use document retrieval slots.
## Career context

The opt-in `career: true` category loads the authenticated user's CareerProfile, Projects, Skills, and at most eight concise recent course references through `server/context/career.ts`. Career Agent requests it with profile data; it does not require assignments, exams or document retrieval. Optional course scope filters projects using the same authorized course ID. Optional `projectIds` selects up to ten exact owned projects and rejects missing or foreign IDs before generation. Career evidence is bounded, reports omissions, and labels skill proficiency as self-reported. See `server/agents/career/README.md` for persistence and grounding details.

## Workflow scope and reuse

Optional `examId` authorizes the selected exam, derives its course and rejects a conflicting course scope. Exam context then returns that specific upcoming exam instead of losing it behind unrelated earlier exams or the default deadline window. Its topic names also guide exact learning-evidence coverage.

Trusted server orchestration may supply `ContextReadCache` as the third `buildUserContext` argument, or through `AgentExecutorOptions.contextCache`. It is never a public request field. Authentication and selected resource authorization still run on every request; compatible cached category values are owner-scoped, cloned and expire after 60 seconds. Call `invalidate` after relevant writes, including operations whose persistence outcome is uncertain. Ordinary single-agent calls do not use a cache unless explicitly configured by server code.


`selectedDocumentCoverage: true` is an opt-in for explicitly selected materials. It requires `documents: true`, document IDs, and at least one retrieval slot per document. The document loader reserves those slots using the existing scoped retrieval service; it never expands to unselected course materials. Default retrieval and embeddings are unchanged. A study workflow can require actual retrieved evidence from every selected material before generating notes.

## Selected assignment context

Optional `assignmentId` authorizes through `getAssignment`, derives its owned course and rejects mismatched course/document scope even when output categories are disabled. With `assignments: true`, it returns just that assignment, including exact `description` and `updatedAt`; explicit selection bypasses the generic active/deadline filter so completed or old work can be reviewed. Broad assignment lists retain their existing bounded summaries. Cache keys include the selected ID and current revision, avoiding reuse across assignments or edits. AgentExecutor and AgentService forward this scope. Assignment Support checks for a complete description before semantic analysis and never treats a student draft as official instructions.
