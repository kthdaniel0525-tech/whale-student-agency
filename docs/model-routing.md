# Intelligent model routing

`getAIProvider()` returns a routed facade over the existing tracked providers.
The Executor assembles owned Context Builder data and compresses conversation
history first. It extracts coarse request/workload/adaptive signals; the facade
measures the final messages (including structured reference data and schema).
`routeModel()` is synchronous selection only: it does not retrieve data, call AI,
truncate prompts. The reliability layer executes its validated fallback chain (see [reliability](ai-reliability.md)). Embeddings keep their
existing configured model and persisted vector space. Objective quiz grading and
high-confidence dispatch stay deterministic and make no routing/provider calls.

## Quality policy

Selection filters capabilities, enabled providers/models, quality floors, and
input + output capacity before comparing equivalent candidates. Defaults:

- FAST: classifier/title/basic extraction. Initially uses the existing
  `gpt-4.1-mini`, also used for BALANCED. A cheaper replacement needs quality
  evaluation before its tier qualification is changed.
- BALANCED: ordinary Tutor, Notes, Quiz, resume edits and a simple reschedule.
- STRONG: `gpt-4.1` for proofs, long/hard grading, repeated misunderstanding,
  career strategy, multi-source synthesis, Study Planner and Academic Manager.
- REASONING: `o3` for very complex combinations of constraints/reasoning.

Complexity uses ordinal rules (LOW/MEDIUM/HIGH/VERY_HIGH), not a quality score.
Proofs, long-answer grading, repeated misunderstanding, multiple sources, required
context size, actions, deadlines, courses, calendar constraints and semester plans
contribute. Request length alone cannot escalate to STRONG. Each workflow step is
assessed separately. `qualityCritical` imposes STRONG, `reasoningRequired` requires
a reasoning-capable REASONING model. No downgrade override bypasses these floors.
If no model meets the floor/capabilities, return a safe temporary-unavailability error; capacity violations return the existing context-limit error.
Fallback references are filtered by the same rules; an empty list is valid when
no safe alternate is configured. The central reliability layer executes eligible alternates after a recoverable failure.

Required capacity uses the existing multilingual token estimate, 15% safety
margin, schema overhead, 256 protocol tokens, and the full output budget. These
are conservative estimates, not exact tokenizer counts. Near a model limit,
configure more headroom or a larger model. No essential context is dropped.
Explicit task output budgets are preserved; otherwise defaults range from 128
for a title to 8192 for Notes/plans. Reasoning reserves an additional 8000/16000/
25000 tokens for low/medium/high effort. This cap includes reasoning and output,
is not a minimum spend, and prevents reasoning from taking the answer's budget.
Unsupported temperature is omitted on reasoning calls. Reasoning timeout defaults
to 180 seconds. Routed calls use `AI_RELIABILITY_JSON.timeouts.reasoning`; direct adapter calls retain `AI_REASONING_TIMEOUT_MS`.

## Configuration and operations

`server/ai/routing/catalog.ts` contains capability definitions and policy constants.
`AI_MODEL_CATALOG_JSON` completely replaces the catalog, validated at selection
time. Entries contain `provider`, `model`, `tiers`, all five capability booleans,
`reasoningEfforts`, `contextWindow`, `maxOutputTokens`, `relativeCostClass`,
`latencyClass`, `enabled`, and `fallbackModels` (`{provider, model}` references).
Set `enabled: false` to disable a model; no DB migration is needed. Reload the
deployment when changing environment variables. Only installed provider adapters
can be selected. Currently only OpenAI is installed; model access remains subject
to the deployment's OpenAI account. Unknown models are never assigned guessed
capabilities. `AI_CHAT_MODEL`, if used, must exist in the catalog and is a preferred
candidate within its qualified tier; it cannot pin all tasks to a weak model.

`AI_ROUTING_OVERRIDE_JSON={"tier":"STRONG"}` or
`{"model":{"provider":"openai","model":"gpt-4.1"}}` supports internal
evaluation. Production rejects it unless `AI_ROUTING_EVALUATION_MODE=true` is
explicitly configured. Capabilities, capacity and quality floors still apply.
No frontend model selector or request field is added.

Recent history uses the authenticated user's last 200 eligible attempts over 24
hours, cached for 30 seconds with a bounded cache. At least five samples and 25%
failure rate are needed to prefer an equivalent healthier model. Authentication,
configuration, invalid-input and cancelled failures are excluded. Unknown history
is neutral. Latency matters only when requested; pricing is a later tie-breaker
between quality-qualified models. History lookup has a 250 ms wait budget;
slow/unavailable history falls back to deterministic selection. Historical cost is already available through
usage analytics; raw cost per request is not compared across dissimilar tasks.
Pricing uses the existing versioned pricing config, never rewrites old records,
and counts reasoning tokens once. No automatic quality scores or shadow calls
exist; `ModelQualityEvidence` reserves an offline/feedback evaluation boundary.

Usage rows add selected model/tier, complexity, reason code, routing method and
`fallbackUsed` (populated by the reliability layer). No prompt or feature text is stored. Existing
ownership, correlation IDs, single-attempt tracking, and streaming cancellation
remain intact. `GET /api/student/usage?group=tier` returns user-scoped cost, token,
latency, failure and coverage aggregates; older rows have an unknown/null tier.

Capability/price references checked 2026-09-20:
[GPT-4.1 mini](https://developers.openai.com/api/docs/models/gpt-4.1-mini),
[GPT-4.1](https://developers.openai.com/api/docs/models/gpt-4.1),
[o3](https://developers.openai.com/api/docs/models/o3),
[reasoning guide](https://developers.openai.com/api/docs/guides/reasoning).
Automated fixtures verify routing/transport/integration, not educational answer
quality. No live paid-model benchmark or measured cost reduction is claimed.

## Changed files

- Routing: `server/ai/routing/types.ts`, `catalog.ts`, `complexity.ts`, `router.ts`,
  `history.ts`, `provider.ts`, `agent-signals.ts`.
- Provider: `server/ai/index.ts`, `types.ts`, `config.ts`, `providers/openai.ts`.
- Existing execution: `server/agents/executor/executor.ts`, `server/agents/quiz/service.ts`.
- Usage: `server/ai/usage/types.ts`, `records.ts`, `pricing.ts`, `analytics.ts`,
  `app/api/student/usage/route.ts`.
- Storage: `prisma/schema.prisma`,
  `prisma/migrations/20260920120000_model_routing/migration.sql`, `scripts/verify-migration.mjs`.
- Configuration/documentation: `.env.example`, `docs/model-routing.md`.
- Tests: `tests/model-routing.test.ts`, `tests/model-routing-provider.test.ts`,
  `tests/ai-usage-integration.test.ts`, `tests/agent-executor.test.ts`, `tests/quiz.test.ts`.

## Verification

Run `npm run check`, `npm run lint`, `npm run test:migration`, `npm run build`;
the relevant Vitest suites include both model-routing files, AI Provider/usage,
RAG compatibility, Context Builder, Agent Router/Executor/Core/Dispatcher, all
student agents, affected workflows, conversation compression, memory,
personalization and adaptive behavior. Provider HTTP is mocked; persistence,
authentication, ownership, compression and existing local RAG run in integration
tests. No paid AI requests are made by the test suite.
