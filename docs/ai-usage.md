# AI usage, tokens and estimated costs

Every OpenAI provider instance is wrapped once by `trackAIProvider`. The existing
local RAG embedding provider uses the same embedding accounting boundary. Text,
structured output, a complete stream, and an embedding invocation each create one
`AIUsageRecord`. No models, generation limits, prompts, retrieval limits, or agent
decisions were changed to reduce usage. This is observation, not billing.

## Attribution and privacy

The authenticated API boundary creates a server-generated request ID and returns
`X-Request-ID`. AsyncLocalStorage carries that ID across routing, agent calls,
workflow steps/retries, embeddings, and conversation compression. The dispatcher,
core service, executor, workflow engine, and workflow resume/answer submissions
also establish scopes when invoked directly. Each workflow continuation is a new
request linked to the same run. Context preparation before a workflow run is
created has a workflow ID but no run ID yet.
Concurrent requests are isolated. Changing authenticated owners drops inherited
attribution. Frontend request schemas never accept accounting user IDs.

Call-specific `usageContext` is separate from model messages and is never sent to
OpenAI. Context Builder binds the verified owner through a WeakMap, outside its
serialized context. Executor records counts of RAG chunks, retrieved token
estimates, memories, personalization signals, and conversation summary/recent/
historical message use. Embedding sources distinguish document indexing, query
retrieval, memory, and conversation use. Embedding batch size is currently one,
matching the existing single-input provider contract.

Records contain only allowlisted scalar metadata: no prompts, response bodies,
document excerpts, memory values, credentials, or raw error messages. The writer
checks optional conversation and workflow-run ownership. Attribution IDs are
historical references, retained after resource deletion; deleting the user
cascades usage deletion. Future quality evaluation can reference the record ID.

## Tokens, cost and latency

Provider usage wins, including authoritative zeroes, cached input, and reasoning
tokens. Local embeddings report their tokenizer count. Successful responses with
missing usage use the existing multilingual character estimator and are labeled
`estimated`. This is approximate, including message framing; structured schema
overhead is not precisely tokenized. Failed/cancelled requests without usage have
null counts/cost and source `unavailable`, rather than invented charges. A billed
response rejected by local structured-output validation retains its token usage.

Estimated USD = ((input − cached) × input rate + cached × cached rate +
(output − reasoning) × output rate + reasoning × reasoning rate) / 1,000,000.
Reasoning is an output subset; it is not charged twice. When no separate rate
exists, cached/reasoning tokens use the input/output rate respectively.

`server/ai/usage/pricing.ts` holds versioned standard API rates verified on
2026-09-19 against the official [GPT-4.1 mini](https://developers.openai.com/api/docs/models/gpt-4.1-mini)
and [embedding model](https://developers.openai.com/api/docs/models/text-embedding-3-small)
pages. `AI_MODEL_PRICING_JSON` replaces the complete configuration without a DB
migration. Unknown models or invalid pricing still record usage with null cost.
The calculated cost and pricing version are immutable, even after prices change.
Local embedding cost means zero external API token charges, not free hardware.
No batch discounts, subscriptions, billing reconciliation, or quality scores are
inferred. Latency covers the provider call/stream and local response validation,
excluding context assembly, subsequent application work, and the analytics write.
Streaming duration includes time waiting for the stream consumer.

## Reliability and observation

A stable random record ID identifies one provider invocation. The SDK continues
to have automatic retries disabled; every application retry creates a new record
under the same request ID. A single finish guard records streaming completion,
failure, or consumer cancellation once. No per-chunk records are written.

A lightweight awaited DB transaction provides deterministic persistence without
an in-memory fire-and-forget queue. It uses a 1-second transaction acquisition
budget and 2-second transaction budget (DB connection establishment uses the
existing pool timeout). Normal writes add only DB latency. Re-delivery uses
`createMany(skipDuplicates)` and cannot overwrite historical prices. Failures
log a safe code and attempt ID and preserve the AI response; failed writes are
not silently ignored and are not automatically replayed. Missing ownership and
missing/invalid pricing produce safe diagnostic warnings. Process termination
before persistence can leave a gap; this is operational analytics, not a billing
ledger. Configuration rejected before provider construction makes no API request.

Installed OpenAI SDK strict-schema conversion rejects custom Zod refinements and
string normalization. The transport now sends the underlying JSON-compatible
shape while retaining the original full Zod validation/normalization on every
response. This fixes real dispatcher schema compatibility exposed by the new
HTTP-boundary integration test. Arbitrary Zod transform effects remain rejected.

## Backend APIs

All functions below require a trusted, session-derived `userId`; none supports an
unfiltered cross-user query or implicit admin mode.

- `getUserAIUsage({ userId, start?, end? })`
- `getAgentUsage`, `getWorkflowUsage`, `getModelUsage`, `getOperationUsage`
- `getDailyUsage` (UTC, at most 366 days, default last 30 days)
- `getUserUsageSummary(userId)` (UTC today, month, lifetime)
- `getRequestUsage(userId, requestId)` (call count and suspicious repetition)

`GET /api/student/usage` defaults to the user's summary. Optional `group` values
are `agent`, `workflow`, `model`, `operation`, `day`, and `request`. Date filters
are ISO timestamps with an inclusive start and exclusive end. The request group
requires `requestId`. Responses are private/no-store; arbitrary `userId` query
parameters are rejected. No dashboard or admin route was added.

Aggregation runs indexed SQL over raw records, not full histories loaded into
application memory. Generation and embedding groups remain separate. Results
include provider attempts, successful/failed attempts, distinct requests,
requests with a successful provider call, tokens, estimated cost, latency,
failure rate, and unknown/estimated coverage counts. Aggregates also expose RAG-backed
attempts/tokens/cost, average context size, and summary-use counts. Distinct counts in
different groups overlap and must not be added. A successful routing call is not
proof the user's whole task succeeded. Workflow averages use distinct run IDs
within the selected period; summed provider time is not end-to-end wall time.
Partial known costs always include an `unpricedAttempts` count; all-unknown costs
remain null. Group lists are bounded to 1,000 and expose truncation explicitly.

Request diagnostics flag 20+ calls, multiple routing calls, and repeated
successful non-embedding operation metadata. They do not compare prompt contents,
prove duplication, block calls, or throttle execution; legitimate workflows and
retries can trigger these heuristics. No automatic cost optimization is applied.

## Verification

Focused tests use the real OpenAI SDK with a mocked HTTP boundary, plus real local
PostgreSQL/authentication for persistence and orchestration. They cover all four
operations, usage/fallback, cache/reasoning pricing, failures/cancellation/retries,
privacy, immutable idempotent writes, aggregation, UTC dates, cross-user isolation,
dispatcher/executor correlation, workflow retry attribution, and real conversation
compression. Existing directly affected AI, RAG, workflow, conversation, document,
and background-job suites are also run. No live paid LLM calls are required.

Verification completed: 850 distinct tests across 34 directly affected test files
(845 in the broad run, followed by 5 additional tests); affected subsets passed
272 tests and 182 workflow/resume tests after the final changes. TypeScript, lint,
production build, and a fresh PostgreSQL
migration check passed (27 migrations / 52 tables, including usage indexes).

## Files changed in this phase

Earlier integration-hardening changes in the working tree are preserved separately.
The following 36 files were added or updated for AI usage:

```text
.env.example
README.md
prisma/schema.prisma
scripts/verify-migration.mjs
prisma/migrations/20260919210000_ai_usage/migration.sql
docs/ai-usage.md
app/api/student/usage/route.ts
server/ai/types.ts
server/ai/errors.ts
server/ai/providers/openai.ts
server/ai/usage/types.ts
server/ai/usage/context.ts
server/ai/usage/pricing.ts
server/ai/usage/records.ts
server/ai/usage/tracking.ts
server/ai/usage/analytics.ts
server/api.ts
server/context/builder.ts
server/agents/core/service.ts
server/agents/executor/executor.ts
server/agents/router/router.ts
server/agents/quiz/service.ts
server/dispatcher/service.ts
server/conversations/service.ts
server/conversations/retrieval.ts
server/conversations/summary.ts
server/documents/embeddings/index.ts
server/documents/processor.ts
server/documents/replacement.ts
server/documents/retrieval/index.ts
server/memory/service.ts
server/workflows/engine.ts
server/workflows/service.ts
tests/ai-usage.test.ts
tests/ai-usage-integration.test.ts
tests/agent-executor.test.ts
```
