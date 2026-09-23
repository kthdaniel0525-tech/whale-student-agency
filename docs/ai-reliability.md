# Provider fallback and reliability

`AgentExecutor / dispatcher / background AI → routed AIProvider → validated model chain → reliability executor → tracked provider adapter`.

The registry in `server/ai/registry.ts` constructs adapters lazily, wraps usage accounting exactly once, exposes capabilities/healthy providers, and supports disabling providers. Production registers OpenAI only. Future adapters register here and normalize outputs/errors to the existing AIProvider types; no Agent prompt forks or new execution pipeline are needed. Cross-provider behavior is exercised with mocked adapters; an actual second provider requires its adapter and server credentials.

## Selection and quality

Routing happens after existing prompt assembly/compression, including schema overhead, output budget and reasoning reserve. Ordered catalog `fallbackModels` must meet the selected primary's tier **and** the required floor, context capacity, streaming, structured output, reasoning and tool requirements. No silent downgrade. `degradationPolicy` defaults to `same-tier-only` (same or higher); `none` forbids alternate models. Warning-based lower-tier degradation is intentionally unsupported.

The preferred primary remains first. Shared open/rate-limited circuits are skipped immediately; only its validated fallback chain may take over. Historical failure/latency observations and cost remain tie-breakers within the existing quality policy. Every candidate is rechecked against shared health at admission. A larger-context fallback after a provider context error must actually have greater capacity; no repeated request to the same incapable model.

## Recovery policy

Central `AI_RELIABILITY_JSON` accepts partial overrides of the defaults in `server/ai/reliability/config.ts`:

- Interactive/background: 2 total attempts, at most 1 retry of the same model, delays 200/1000 ms. Configuration allows at most 3 attempts; the existing request/workflow/repetition/token/cost budgets remain authoritative. A fallback never opens a new budget.
- Timeouts: classification 15 s, ordinary text/stream 60 s, structured output 90 s, reasoning 180 s, embeddings 30 s, background generation 180 s. Existing guard deadlines may stop work sooner. Request cancellation reaches transports. SDK retries are disabled; no parallel hedging.
- Timeout, network/unavailable, overload or invalid structured output: prefer a healthy equivalent, otherwise retry once if budget permits. Malformed requests/unknown errors stop. Authentication skips all models sharing that provider. Unsupported features try only validated alternates. Rate limits respect normalized Retry-After and prefer another eligible endpoint; OpenAI rate limits are conservatively provider-scoped (shared quota).
- No acceptable candidate: `AI_SERVICE_TEMPORARILY_UNAVAILABLE`, safe text, HTTP 503. Workflow step policies decide whether to continue with warning or stop; saved outputs remain accessible. Exhausted provider recovery is not retried again by the workflow.
- Stream failure before content may recover. After any nonempty delta it raises `AI_STREAM_INTERRUPTED` with partial metadata, never concatenates a second answer. Consumer cancellation closes the transport and does not count as outage evidence.

OpenAI-specific status/header interpretation stays in its adapter. See [official error guidance](https://developers.openai.com/api/docs/guides/error-codes). No raw errors, prompts, credentials or headers are persisted.

## Shared passive circuit breaker

Reuses `AIGuardState` and PostgreSQL advisory locks/DB time; production has no process-local health fallback. Rolling window: 5 minutes / 20 samples. Open after 3 consecutive failures, or at least 5 observations with 60% failure. Ordinary single errors only degrade health. A single bad model does not disable sibling models; provider-wide evidence requires multiple failing models or an explicitly provider-scoped failure.

Cooldown is 30 s; Retry-After (default 60 s) and authentication cooldown (5 minutes) block earlier. After cooldown, one leased half-open request probes recovery across all instances. Success resets the circuit; failure reopens it. Epoch fencing rejects stale in-flight results. Cancelled/prohibited requests do not become provider failure evidence. Leases expire after timeout plus 5 s if a process dies. No paid synthetic health probes. New calls fail safely if shared storage cannot be read; post-response telemetry failure cannot invalidate a usable answer.

Operators can set `AI_RELIABILITY_JSON={"disabledProviders":["openai"]}` and use existing model catalog `enabled:false` switches. Settings are server-only, read on selection; changing deployment environment still requires the host's normal reload. A configured second provider can take over without a code change at the time of an outage.

## Embeddings and grounding

The same executor wraps local RAG, semantic memory/conversation embeddings, and OpenAI embeddings. An embedding mirror is eligible only when its explicit `spaceId` (weights/revision/preprocessing/pooling/normalization identity) **and** dimensions match. Dimension equality is insufficient. The canonical response model ID remains stable while usage records retain the actual endpoint. No cross-space fallback is configured by default. Ingestion/query use the existing vector-space contract; switching spaces requires an explicit migration/reindexing project.

Document retrieval propagates embedding unavailability; Context Builder/AgentExecutor do not proceed as though requested sources were retrieved. Existing optional semantic-memory enhancements retain their explicit deterministic fallbacks.

## Usage and operations

Existing AIUsageRecord now also stores primary provider/model, attempt number, fallback depth/from, final successful provider, normalized failure class, streamStarted, and estimated emitted tokens. Actual reported usage takes precedence; unknown failed usage/cost remains unknown, never invented. Every real attempt shares the parent correlation/user/agent/workflow and has its own immutable usage ID.

`getReliabilityMetrics({userId,start?,end?})` / authenticated `/api/student/usage?group=reliability` return bounded provider/model success, timeout, rate-limit, fallback and fallback-success rates, average latency, and circuit/auth event counts. AIGuardEvent carries provider/model attribution for future operations alerts. The existing authenticated ownership filter and state/event cleanup are reused; no billing, alerting dashboard or prompt logging was added. Fallback rates are attempt-based; both all-provider and per-model groups are returned.

## Verification

New reliability unit and PostgreSQL integration suites cover primary success, timeout/429/503/auth, no useless retries, quality/capability/context filtering, streaming interruption, rolling/shared/half-open circuit behavior, switches, budget/usage attribution, background execution, vector compatibility, RAG failures and workflow saved results. SDK HTTP is mocked. Also run directly affected AI/Agent/Workflow/Context/memory tests, TypeScript, lint, fresh database migrations and the production build.

## Files in this change

- Added: `server/ai/registry.ts`; `server/ai/reliability/{config,failures,health,executor,embeddings}.ts`.
- Updated AI: `server/ai/{index,types,errors}.ts`, `providers/openai.ts`, `routing/{types,router,provider,history}.ts`, `usage/{types,records,tracking,analytics}.ts`, `guardrails/events.ts`.
- Integration: `server/agents/executor/executor.ts`, `server/agents/router/router.ts`, `server/dispatcher/service.ts`, `server/workflows/{engine,errors}.ts`, `server/documents/embeddings/index.ts`, `server/api.ts`, `app/api/student/usage/route.ts`.
- Storage: `prisma/schema.prisma`, migrations `20260921000000_ai_reliability` and `20260921003000_ai_health_event_attribution`, `scripts/verify-migration.mjs`.
- Config/docs: `.env.example`, this document, `docs/model-routing.md`, `docs/ai-guardrails.md`.
- Tests: `tests/ai-reliability{,-integration}.test.ts`, `tests/ai-provider.test.ts`, `tests/agent-executor.test.ts`, `tests/ai-usage-integration.test.ts`, `tests/model-routing-provider.test.ts`, `tests/ai-guardrails.test.ts`, `tests/guard-fixture.ts`.

Previous uncommitted model-routing/guardrail work is preserved; the file list above describes the reliability increment.
