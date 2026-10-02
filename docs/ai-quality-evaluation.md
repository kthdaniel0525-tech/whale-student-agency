# AI Observability & Quality Evaluation

The shared evaluator accepts an ephemeral request/output/reference context and emits normalized **0–1** scores, explicit unmeasured dimensions, observable checks and standard failure codes. `quality-v1` profiles cover Tutor, Notes, Quiz, grading, Planner, Manager, Career, Dispatcher, model routing, RAG retrieval/generation, workflows, continuity, personalization and adaptation.

## Evidence and limits

Reports distinguish `evaluator-fixture` (tests an evaluator against a synthetic artifact), `system` (executes existing deterministic behavior or an injected application integration), and `generated` (opt-in generation with AIProvider). **Fixture schema scores do not measure model correctness.** Offline Dispatcher cases exercise the actual classifier with paid fallback unavailable; ambiguous inputs permit several legitimate targets, including safe Academic Manager triage. These are not claims about model-based routing accuracy.

Quiz checks reuse production schemas and the exact objective grading helper. Semantic grading uses the production structured schema/prompt and curated accepted score ranges. Planner checks cover totals, dates, availability, modest session lengths, relative weak/strong allocation, deadlines and preserved completed IDs. Exact-time conflict checks require observed scheduled sessions; date-only plans explicitly report zero calendar coverage. Manager uses trusted urgent/allowed action IDs. Career numeric allowlists are explicit reference constraints, not a semantic truth oracle. Profiles provide rubrics for the remaining semantic judgments.

RAG recall/hit/precision are separate from generation faithfulness. Real local retrieval is exercised in Tutor integration tests with controlled source chunks. Citation IDs validate provenance only. The judge compares actual passages with attributed claims. Edited/deleted historical sources are unavailable, never reconstructed as if they were the original evidence.

Workflow observation adapters evaluate the existing five WorkflowService integrations (including saved plans/quizzes and actual answer evaluation). Recovery reports expose mastery, confidence and loop counts; mastery gains alone do not establish user value. Long-conversation corrections, current preference precedence and failed-explanation adaptation run the existing deterministic engines. Existing conversation/personalization/adaptive suites provide broader integration coverage.

## Commands

No paid calls:

```sh
npm run test:evals
npm run evals -- --mode FAST_SMOKE
npm run evals -- --mode STANDARD --suite tutor --out /tmp/tutor-contracts.json
npm run evals -- --mode FULL --out /tmp/quality-contracts.json
npm run evals -- --mode FULL --baseline /tmp/quality-contracts.json --out /tmp/current.json
```

FAST_SMOKE covers routing, schemas, a small golden set and behavior invariants. STANDARD adds representative Agent and workflow fixtures. FULL runs all versioned cases, including repeated Quiz and Planner failure scenarios; new release cases can be assigned only to FULL. Normal CI runs deterministic evaluations without external credentials or model downloads. The integration tests additionally require the normal local database and prepared local RAG model.

Explicit, paid **synthetic-only** generation/judging (configured AIProvider required):

```sh
npm run evals -- --mode STANDARD --suite tutor --live --judge --out /tmp/tutor-baseline.json
npm run evals -- --mode STANDARD --suite tutor --live --judge --baseline /tmp/tutor-baseline.json --out /tmp/tutor-current.json
npm run evals -- --mode STANDARD --suite tutor --live --judge --model MODEL_A --compare-model MODEL_B --out /tmp/model-comparison.json
```

Model names must be enabled in the existing registry/catalog and respect its quality floors. `--tier STRONG` supplies a minimum routing tier. A cheaper unsupported override remains rejected. The programmatic `runEvals` also accepts injected execution observations, a separate judge AIProvider and provider IDs, enabling independent provider/fallback comparisons. CLI generation reuses the production prompt builder and Quiz/Planner/grading schemas with controlled references; it does not create real student plans or workflow runs. Full persistence/orchestration is covered by the affected integration suites. It does not claim a full production benchmark from these prompt-only probes.

The judge uses a minimum STRONG tier (reasoning escalation for proof grading), coarse scores 0/.25/.5/.75/1 and null when evidence is insufficient. Only numeric scores and taxonomy survive; brief rationales are not stored. The same provider family is currently the default; use a separately supplied capable provider for independent comparisons. No private reasoning is requested or stored.

## Versions and regression

Datasets are synthetic JSON under `evals/`, each versioned with a content hash. Agent prompt versions hash source instructions and the shared system frame. AIUsageRecord records actual prompt/routing/context versions; routing hashes the catalog and policy. Bump `CONTEXT_VERSION` when context selection, compression or formatting semantics change; bump profile/JUDGE versions for rubric/algorithm changes. Grading has a dedicated source-controlled prompt version. Older usage remains `unknown`; do not infer historical prompt versions from current code.

Reports contain no output text. Save a reviewed report using `--out`, then load it with `--baseline`. Paired comparison requires matching case IDs, dataset hashes, evaluator versions, evidence category, judge and measured dimensions. Each profile has a minimum score, allowed drop and minimum sample size (default five). Tiny samples report `insufficient-data`; deterministic invalid schedules/schemas fail immediately. Dimension declines are reported alongside overall quality. Missing cases remain explicit, not silently successful; incomplete paired coverage prevents a stable quality verdict. Generation failures are recorded safely and the suite continues. Judge failures remain unmeasured and fail the run instead of producing invented scores. Threshold overrides use `AI_EVAL_THRESHOLDS_JSON`. No router settings are automatically changed.

Cost/latency deltas use the same paired cases. Unknown prices stay null. Generator cost estimates cover the reported successful response; failed-attempt costs require supplied usage observations. Judge cost is separate. Fallback/tier fields remain unknown when the provider response does not expose them; injected observations or stored usage supply actual attribution. `getQualityAnalytics` joins owned evaluation/usage IDs, separates evaluator types and versions, counts feedback independently, and flags positive evaluations paired with negative satisfaction. Its bounded (5,000 row) result reports truncation. Observational model/fallback cohorts do not establish causal equivalence; use paired synthetic comparisons before changing routing.

## Release evidence check

Ordinary `--baseline` and `--compare-model` commands now exit nonzero for **insufficient-data** as well as regressions, failed candidate generation and judge failures. A successful fixture-only run without a comparison still means only that its deterministic checks passed. Comparing the current FULL offline dataset to itself is insufficient for several profiles; do not lower sample requirements to make that command green.

After collecting and reviewing real release observations, run this read-only check (no provider calls):

```sh
node --conditions=react-server --import tsx scripts/check-release-quality.ts \
  --baseline /secure/quality/known-good.json --report /secure/quality/candidate.json
```

The release workflow invokes this check on the trusted staging runner before production promotion. It expects `/etc/agency/quality/known-good.json` and `/etc/agency/quality/<full-git-sha>.json`; prepare reviewed, release-matched evidence outside the checkout. The existing offline dataset intentionally cannot satisfy this gate.

Add `--include-career` if Career will be enabled for any release cohort. The check requires FULL reports, all core profiles, existing minimum paired sample counts and thresholds, measured semantic dimensions, generator/provider/judge attribution, no unjudged executions and compatible baseline comparisons. It rejects offline evaluator fixtures, missing evidence, failed observations even with a misleading summary count, mismatched datasets/judges, and duplicate observations. No model routing policy or threshold changes are made.

### First reviewed baseline

The ordinary release check never compares a candidate with itself. Before the first known-good report exists, a trusted staging operator may run the separate bootstrap command once. It applies the same FULL-report, core-profile, minimum-sample, quality-floor, attribution and complete-judgment requirements as the baseline side of the release gate. It does not perform or claim a regression comparison.

Prepare a review file outside the checkout with this metadata:

```json
{
  "version": 1,
  "reviewStatus": "reviewed",
  "reviewedAt": "2026-10-02T20:00:00Z",
  "reviewer": "REVIEWER_ID",
  "commitSha": "FULL_GIT_SHA",
  "immutableImage": "ghcr.io/OWNER/REPOSITORY@sha256:FULL_DIGEST",
  "environment": "staging"
}
```

Then write the first baseline and its provenance sidecar into an existing protected directory:

```bash
node --conditions=react-server --import tsx scripts/bootstrap-release-quality.ts \
  --report /secure/quality/reviewed-first-release.json \
  --review /secure/quality/review.json \
  --out-baseline /etc/agency/quality/known-good.json \
  --out-provenance /etc/agency/quality/known-good.provenance.json
```

The command refuses existing outputs and writes `known-good.json` only after its sidecar is installed. The baseline remains the exact strict `reportSchema` consumed by `check-release-quality.ts`. The sidecar binds its SHA-256 hash to the reviewed commit, immutable staging image, dataset versions, evaluator versions, judge and generator models, providers, profile sample counts and average scores. A successful bootstrap reports `BASELINE_ESTABLISHED` with `comparisonStatus: NOT_PERFORMED_FIRST_RELEASE`. Later candidates must still pass the ordinary paired baseline comparison, which reports `BASELINE_COMPARISON_PASS`; bootstrap success never reports that status.

The current CLI dataset has sparse profiles and does not execute every live agent/workflow path. Use the existing `runEvals` execution-observation adapter with actual application execution plus the judge, and curate reviewed representative cases where coverage is below the existing five-sample minimum. Do not relabel static fixtures as generated observations. Baseline provenance, human review, target image/configuration binding and actual provider execution are operator responsibilities; a valid JSON file cannot prove them. Archive reviewed reports with the exact immutable release image and reviewer. This checker is a required release-review step, not automatic proof that live quality passed or a replacement for the broader launch checklist.

## Feedback and optional sampling

Assistant responses have optional thumbs-up/down and optional reason/comment. Authenticated GET/PUT `/api/student/assistant/messages/[messageId]/feedback` verifies visible assistant-message ownership, rejects client identity fields and checks request origin. Feedback links to trusted message request IDs and matching owned usage where available. Workflow summaries without a generating provider attempt are not falsely attributed to the last specialist. Satisfaction scores are not automatic correctness labels. Comments are private user content and excluded from analytics and evaluation records.

Production sampling is **off by default**. Enabling it requires all of:

1. A product/privacy-reviewed `AI_EVAL_POLICY_VERSION` and URL configured by the operator.
2. `AI_EVAL_SAMPLING_ENABLED=true` with rate at most 5% (default 1%).
3. Explicit authenticated opt-in to that exact version via `/api/student/evaluation-consent`.

A URL/version is an operator assertion, not an automated privacy approval. Changing policy invalidates prior consent. Consent revocation is checked again in the worker before the model call. Negative feedback does not grant consent. Default sampling is stable by message ID, with bounded priority for fallback/negative-feedback samples. Only persisted successful Tutor/Notes answers are eligible initially; unavailable context and other artifact types are skipped. Existing background guardrails and low concurrency control expense. There is no production benchmarking without consent and no extra prompt archive.

`evaluate-ai-response` reuses JobRun, pg-boss, transactional publication, deduplication and the existing AIProvider/usage/reliability stack. Queue payloads contain only user/request/usage/message/tracking/policy IDs. Workers reload authorized persisted text and source passages; disabled policies, revoked consent, missing records and already evaluated results are skipped. Judge attempts have their own job request correlation and `evaluation` operation, avoiding recursive sampling. Evaluation records store scalar/structured scores and versions only; deleting an account cascades feedback/evaluations.

## Files in this phase

- `server/ai/evaluation/`: contracts, profiles, versions, deterministic/judge evaluators, storage, feedback, policy sampling, runner, datasets, comparisons, analytics, workflow observations.
- `evals/*/cases.json`, `scripts/run-evals.ts`, `.github/workflows/ai-quality.yml`, package scripts.
- Prisma schema and `20260921120000_ai_quality`; migration verifier.
- Agent metadata/executor/shared prompt frame; extracted objective/semantic Quiz grading helpers; Dispatcher offline classification entry point; usage version fields; routed-provider version attribution.
- Conversation request correlation; `server/jobs/evaluate-ai-response.ts`, existing registry/enqueue extension.
- Feedback/consent API routes; Assistant message feedback component and renderer.
- Focused evaluation/unit/integration tests plus evaluator assertions in existing Tutor and five workflow integration suites; `.env.example`, this document.

## Verification (2026-09-21)

- 34 directly affected test files: 870 tests passed, including focused reruns after fixing queue compatibility and expected prompt metadata.
- 52 FULL offline cases; FAST_SMOKE/STANDARD/FULL covered in deterministic tests; saved-baseline comparison exercised.
- TypeScript, lint, production build and fresh migration verification passed (56 tables, 32 migrations).
- No live paid generator/judge calls. Production sampling remains disabled.
