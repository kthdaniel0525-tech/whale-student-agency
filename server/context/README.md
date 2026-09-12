# Context Builder

Read-only context preparation for future AI consumers. No agents, routing, generation, tool execution, conversations, learning database, UI, or new HTTP endpoint is added. Existing RAG and AIProvider code is unchanged.

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

All categories default to **false**. Only selected category loaders execute. The request text guides document retrieval; it is not copied into context. There is no automatic agent or intent inference.

- `profile`: name, school, program, year, semester, goal, explanation difficulty and study-session length. No email, account ID, credentials, authentication metadata or entire ORM object.
- `course`: selected owned course metadata only. No implicit enumeration of courses or their child records.
- `assignments`: incomplete assignments, overdue by at most 30 days or due within the upcoming window; earliest deadlines first, then priority. The optional course filter applies before limiting.
- `exams`: upcoming exams within the window, chronological order, selected-course filter, topics and approximate days remaining. Private notes are excluded. Days remaining uses ceiling of elapsed 24-hour intervals, not local calendar-day arithmetic.
- `documents`: calls `retrieveAcademicContext` with the actual request, verified user ID and supplied course/document filters. Returns bounded passages with document ID/title, page start/end, course, chunk index and similarity. No full documents or duplicate vector pipeline.
- `memories`: requires both `memories: true` and explicit `memoryKeys`. No memory query runs when no keys are requested. Only owned allowlisted preference values pass validation.
- `learning`: currently unavailable; selecting it records that fact in metadata without inventing data. `LearningContext` and `LearningContextSource` are interfaces for future integration only.

`types.ts` exposes context DTOs independent of Prisma. `categories.ts` contains independent readers; `builder.ts` handles authentication, scope, selection and budgeting; `format.ts` formats selected data. A future category can add its reader and typed selection without rewriting the other readers. Calendar, email, projects and other domains are not implemented.

## Limits and minimization

`options.deadlineWindowDays` defaults to 30 and allows 1–90 days. Limits are validated, not silently expanded:

- `limits.assignments`: default 6, maximum 20.
- `limits.exams`: default 4, maximum 10.
- `limits.documents`: default 5, maximum 10.
- `limits.memories`: default 3, maximum 3.
- `limits.maxCharacters`: default 24,000, range 2,048–40,000.

Individual text fields are capped, including 500-character goals, 1,000-character course descriptions, ten exam topics and 3,500-character passages. The total serialized selected-data payload is then bounded; lower-priority categories/items are removed first. Priority is profile, course, assignments, exams, documents, memories, learning. Within arrays the nearest deadlines and highest-ranked passages are retained first. A caller needing document-heavy context should select fewer other categories. Source metadata is kept with each retained passage.

Metadata includes requested/unavailable categories, field/budget truncation categories, generation time, serialized context character count and a rough character-count/4 token estimate. Counts exclude metadata and formatting labels and are **not** a tokenizer-based LLM budget. SQL row limits/time windows can omit more records without a count query; truncation metadata is not an exhaustive count of omitted database rows. No unlimited historical tasks or conversation history is fetched.

Document-enabled requests must match existing RAG's 3–1,000-character query limit; they are rejected if oversized rather than silently searching a truncated request. Other requests allow up to 10,000 characters. Selected document filters are capped at 20 IDs.

## Conservative memory support

`UserMemory` has no sensitivity or consent classification. Arbitrary text under an apparently safe key is therefore not automatically treated as non-sensitive. Only these exact keys and values are supported:

- `explanationStyle`: `concise`, `detailed`, `step-by-step`, `socratic`.
- `studySessionMinutes`: a numeric string representing 15–180 whole minutes.
- `academicGoal`: `understand_concepts`, `prepare_for_exams`, `improve_grades`.

Unknown keys, free-form secrets, invalid values and unrequested memories are excluded. The existing profile goal is separately opt-in with the profile category. No memory is created, updated, inferred or classified by an AI model.

## Formatting

`formatContextForAI(context)` returns compact labeled JSON sections and omits empty sections. No content returns an empty string. JSON escaping prevents literal newlines in stored values from creating new section boundaries. A reference-data notice warns against treating embedded instructions as commands. This is not a complete prompt-injection defense: future executors must keep authoritative instructions separate from untrusted user/document content. The structured DTO remains available independently.

## Focused verification

```sh
npm run check
npm run test -- tests/context.test.ts
```

The focused suite uses real Better Auth sessions, PostgreSQL and the existing local RAG model. It creates two disposable test accounts, verifies ownership and selection, compares document results to the existing retrieval service, and deletes its own fixture records afterward. No OpenAI request or AI answer generation occurs. It requires the existing DB and prepared embedding cache, but no running web server. Call-through spies verify disabled categories do not execute queries or embeddings; the Context Builder itself is not mocked.

Coverage includes profile minimization, default-empty selection, course authorization, forged identity rejection, overdue/upcoming limits, exam filtering, actual-query RAG/citations, memory allowlists, absent learning data, character budgets, malformed inputs, formatting and read-only academic/session behavior.

Changed files are confined to `server/context/{types,validation,categories,builder,format,index}.ts`, this README and `tests/context.test.ts`. No dependencies, environment settings, database migrations, UI, AIProvider or existing RAG behavior changed.
