# Release Candidate finalization

2026-09-23 · revision `66fdae145084b94fc50edb1a3b822ffdda5fbb50` · target `v1.0.0-rc.1` · **RC BLOCKED**

This is the finalization check for the frozen V1 scope. It continues the existing launch audit and remediation evidence. No Agent, Workflow, integration, billing capability, dashboard, prompt, quality floor, or model route was added or relaxed. Because required external evidence is unavailable, `v1.0.0-rc.1` is reserved but has not been written to package metadata, tagged, published, or deployed.

## Frozen release configuration

- Model catalog: `gpt-4.1-mini` for FAST/BALANCED, `gpt-4.1` for STRONG, and `o3` for REASONING. Fallbacks remain mini → strong → o3, strong → o3, and o3 → strong.
- Quality floors: FAST for SIMPLE, WORKFLOW, and BACKGROUND; BALANCED for STANDARD; STRONG for COMPLEX and HIGH_COMPLEXITY. Evaluation thresholds remain profile-specific `quality-v1` values, including 0.95 grading, 0.99 Study Planner, and 0.90 RAG generation/retrieval minimums.
- Reliability: at most two provider attempts with one same-model retry. Existing interactive/background timeouts and circuit breakers are unchanged.
- Output/context policy: global default 2,048 output tokens; task-specific bounded caps remain in the routing catalog and structured Agent services. The guardrail maximum context remains 1,000,000 tokens, with bounded execution profiles and Workflow step definitions.
- RAG: pinned local `Xenova/all-MiniLM-L6-v2` revision `751bff37182d3f1213fa05d7196b954e230abad9`, 384 dimensions, existing chunking/retrieval/source rules unchanged.
- Workflow budgets: existing bounded definitions remain: Exam Preparation up to two Agent calls, Weak Topic Recovery two, Lecture Study one, Assignment Support three, and disabled Career Preparation one. The global Workflow guard remains an emergency ceiling rather than a planned call count.
- Operational logs, metrics, Sentry, worker heartbeats, and feedback retain immutable `RELEASE_SHA` attribution. No RC semantic version is asserted while approval is blocked.

## Feature disposition

- Enable after all blocking gates pass: authentication, onboarding, Dashboard, courses and deadlines, Documents/RAG, AI Workspace, Tutor, Notes, Quiz/grading, Learning Intelligence, Study Planner, Academic Manager, core Student Workflows, Progress, memory/personalization, notifications, feedback, and required document/background processing.
- Limited: the whole initial product remains an exact-allowlist `core` closed beta with `BETA_MODE=true`.
- Disabled in the initial preset: new checkout/billing, Calendar, Drive, LMS, Career/Career Preparation, optional content-quality sampling, and product analytics. Existing cancellation/webhook handling must remain available if this preset is ever adapted to a deployment that already has paying users.

## Verification on the candidate revision

- TypeScript passed. Lint passed with zero errors and four pre-existing internal-navigation warnings.
- Unit/integration/security/authorization/billing/OAuth/Workflow/RAG suite: 71 files and 1,748 tests passed.
- Browser verification: all 21 unique desktop/mobile scenarios passed. The suite was run in bounded groups because the intentional signup limit permits ten accounts per IP per minute. A visible-locator synchronization fix prevents a transient previous mobile composer node from causing a false strict-mode failure.
- FULL offline AI evaluation: 52 cases, zero deterministic failures, with only `system` and `evaluator-fixture` evidence.
- Strict release-quality check: failed as required because reviewed generated/judged baseline and candidate evidence is absent for Tutor, Notes, Quiz, grading, Study Planner, Academic Manager, RAG retrieval/generation, and Workflow.
- Webpack production build passed. The default local Turbopack build could not bind its internal process port in this managed macOS execution environment. The existing Linux production Docker image remains verified at manifest digest `sha256:9f2470cdf6c13201a75f6e71612b49c9c5fda18bf413db5e68b87d6ba5699890` with `beta-v1` access-policy metadata.
- Dependency audit: 1,120 dependencies, zero vulnerabilities at every severity.
- Existing same-tree deployment evidence remains valid: 39 migrations, 71 tables, pgvector 0.8.2, nine authenticated local HTTPS/worker checks, bounded containers, PDF processing, and pinned embedding-model loading.
- No hosted staging smoke, real provider AI call, Stripe test journey, Google test journey, external alert receipt, or off-host restore was possible because this session has none of the required URLs, credentials, or reviewed baseline files.

## Cost baseline

There are no non-fixture beta usage records and offline evaluation rows contain no provider cost, so observed averages per Agent, Workflow, or student session are **not available**. The release must not treat fixture calls or output caps as actual averages.

Current pricing snapshot `standard-2026-09-20` gives a normalized planning example for 10,000 uncached input plus 2,000 output tokens: approximately **$0.0072** on `gpt-4.1-mini` and **$0.0360** on `gpt-4.1`/`o3`. Under that same artificial token assumption, one/two/three-generation paths are about **$0.0072/$0.0144/$0.0216** on mini or **$0.036/$0.072/$0.108** on strong/reasoning. These are arithmetic examples, not measured session costs.

Common direct Agent paths normally make one primary generation request, with extra usage possible for fallback, judging, or long-conversation summarization. Static Workflow Agent-call ceilings are one to three for enabled definitions. The highest-cost enabled risks are long Notes/Planner/Manager outputs, Assignment Support's three-Agent path, and any fallback to strong/reasoning models. After real beta traffic exists, `AIUsageRecord` must supply calls, tokens, latency, fallback, missing-price count, and cost per successful call/run before an operational average is accepted.

## Exact remaining launch checklist

All boxes below must be closed before applying or tagging `v1.0.0-rc.1`.

- [ ] Run the FULL suite with real candidate generation and reviewed model judging for every core profile; provide a reviewed known-good baseline and exact candidate report; pass `scripts/check-release-quality.ts` without threshold or model-floor reductions.
- [ ] Add representative course-source cases and demonstrate RAG retrieval plus answer source faithfulness for the exact candidate configuration.
- [ ] Validate the exact immutable image on the intended staging/production host with real environment URLs, server-side secrets, database/pgvector, private durable document storage, shared rate-limit behavior, worker schedules, and capacity/AI latency measurements.
- [ ] Deliver and acknowledge real application request-failure, AI outage/fallback spike, Workflow failure, background-job failure, integration failure, billing-webhook failure, database, uptime, and cost-spike alerts to named operators.
- [ ] Produce encrypted off-host backup/retention evidence; restore it on an isolated target; run the authorized rollback image through schema, ownership, privacy, and queued-job checks.
- [ ] Obtain reviewed public Terms/Privacy content and assign an accountable support/security incident owner. Record the escalation and response channel.
- [ ] Review real beta P0/P1 inventory and a small set of successful core journeys. Zero local fixture feedback is not evidence of issue-free usage.
- [ ] If paid scope will be enabled, complete Stripe test-mode checkout, signed webhook, subscription synchronization, portal, upgrade/downgrade/cancellation, and entitlement evidence. Otherwise keep checkout disabled.
- [ ] If Calendar, Drive, or LMS will be enabled, complete provider staging consent, callback, refresh/revocation, least-privilege, delivery, and ownership evidence. Otherwise keep them disabled.
- [ ] After every item above passes, set package/release metadata to `1.0.0-rc.1`, build the immutable image with the exact commit, record the image digest and `RELEASE_SHA`, create the `v1.0.0-rc.1` tag, and repeat non-destructive staging smoke before any rollout.

## Decision

Recommended rollout mode: **Internal only**. The next eligible mode after the checklist passes is the existing allowlisted closed beta. Final decision: **RC BLOCKED**.
