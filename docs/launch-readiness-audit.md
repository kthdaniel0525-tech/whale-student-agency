# Final launch readiness audit

## Decision

**NO-GO — public Student AI Agency V1.** Audited on 2026-09-23 against `1d8911f` plus the small audit fixes below. Repository checks provide strong local engineering evidence. Required live AI quality, deployed monitoring, configuration and recovery evidence is missing; this is not a claim that a new Critical vulnerability or data-loss bug was found.

Recommended next release mode **after B1–B5 are closed for that scope: invitation-only, free core beta**. Public V1 and paid rollout are not approved by this audit. No deployment, provider account, feature flag, billing state, commit or push was changed.

## Category results

PASS means verified in the stated scope; known-risk results do not override the blocking deployment/AI gates. FAIL includes a required gate for which evidence is unavailable.

- **Security: PASS WITH KNOWN RISK.** Ownership, authentication, internal/admin, entitlement and security regressions pass; no unresolved confirmed Critical/High code finding. Inline CSP and deployment isolation remain risks.
- **Privacy: PASS WITH KNOWN RISK.** Data map updated for beta analytics, feedback and Sentry. Canonical deletion now verifies all four beta tables; external retention and production erasure remain unverified.
- **Data Integrity: PASS.** Local regressions cover learning retries, plan completion, refresh/vector atomicity, workflow state, encrypted credentials and subscriptions. Fresh schema, existing-account upgrade and synthetic restore pass.
- **AI Quality: FAIL.** 52 offline cases pass, but no generated release evidence or reviewed known-good semantic baseline is available. Real API credentials were not available.
- **RAG: FAIL.** Local isolation, selected documents, refresh and controlled retrieval pass. Source faithfulness and representative retrieval quality have no live release baseline.
- **Agents: PASS WITH KNOWN RISK.** Registration, routing, context ownership, model floors, structured output and persistence pass deterministic/integration checks; actual generated quality is gated above.
- **Workflows: PASS WITH KNOWN RISK.** Five workflow integrations, waits/resumes, persisted artifacts, idempotency and loop budgets pass; external AI is mocked.
- **Billing: FAIL.** Server-owned prices, real SDK webhook signatures, idempotency, cancellation, downgrade and portal contracts pass. No actual Stripe test-mode checkout/portal/reconciliation journey was available; keep paid launch disabled.
- **Integrations: PASS WITH KNOWN RISK.** OAuth state/PKCE/encryption and Calendar/Drive import-refresh-failure contracts pass. Google consent/provider writes are mocked; no production LMS adapter is registered.
- **Automation: PASS WITH KNOWN RISK.** Job claims, retries, timeout/concurrency, reminder/notification actions, settings and persistence pass. Both local workers heartbeat; deployed workers and persisted schedules need verification.
- **Infrastructure: FAIL.** Production Docker build and 39 migrations are reproducible locally. No deployed target, verified runtime secrets, off-host backups, resource limits or policy-compatible rollback receipt is available.
- **Monitoring: FAIL.** Redaction, health, readiness and protected metrics pass. External uptime probes, real Sentry delivery and responsible alert recipients are not verified.
- **Performance: FAIL.** No production/staging latency or concurrency measurement. TTFT is not persisted. Local test durations are not user latency or capacity estimates.
- **UX: PASS WITH KNOWN RISK.** First-time onboarding, empty workspaces, forms and key dialogs pass. Duplicate main landmarks and inaccessible mobile New chat/history controls were fixed.
- **Mobile: PASS WITH KNOWN RISK.** 390px Chromium onboarding, dashboard, course, assistant, quiz, workflow resume, progress and billing/plans pass. Real-device Safari and manual screen-reader review were not performed.
- **Support: PASS WITH KNOWN RISK.** Private in-product feedback is available. Public Terms/Privacy/dedicated contact pages were not found; published policies and an accountable account/billing support process need business review.
- **Beta: PASS WITH KNOWN RISK.** Admission/cohort/revocation, analytics opt-out, safe events and feedback tests pass. No non-fixture activated beta cohort/events/feedback were observed locally; no real beta success or issue-free claim is possible.

## Launch blockers

**B1 — Core AI and RAG release evidence.** Provision a synthetic staging AI configuration; run generated/judged Tutor, Notes, Quiz, grading, Planner, Manager, Career and workflow evaluations plus representative retrieval/faithfulness checks against a reviewed compatible baseline. Complete critical AI journeys without developer repairs. Preserve existing quality floors and thresholds.

**B2 — A verified deployment and capacity boundary.** Provision the actual staging/production host, HTTPS origin, secrets, database roles/pools, private durable storage and OS/container limits. Run authenticated smoke, core journeys, worker/schedule checks and representative latency/concurrency measurements. Object storage/signed URLs are not implemented; explicitly accept the persistent-volume topology with private server downloads or treat object storage as an unmet requirement.

**B3 — Monitoring that reaches an operator.** Configure the external readiness probe, protected metrics collection, Sentry/redacted logs and recipients; trigger and receive application, worker and database alerts in the target environment.

**B4 — Proven recovery with unchanged authorization.** Produce encrypted off-host database/document backup receipts with retention and latest success; restore and time them in isolation. Approve and drill an exact rollback image that retains beta revocation/cohort controls. e1f5239 lacks these checks and is not an approved beta rollback target.

**B5 — Public launch policy and support decision.** Publish business/legal-reviewed Terms and Privacy information for the actual processors/retention, and establish who handles account/feedback issues. For paid launch, additionally verify actual Stripe test checkout, mapped prices, signed webhooks, portal, cancellation/downgrade and billing support before enabling checkout.

Calendar/Drive/LMS verification gaps do not independently block a free core launch if those features remain disabled. Stripe verification blocks paid launch; it must not be presented as a reason that a deliberately free, billing-disabled product cannot run.

## Critical journey evidence

These are complementary browser and service tests, not ten completed live-provider end-to-end journeys. Synthetic fixtures seed state in some tests; the new mobile onboarding test uses the actual UI and requires no manual database repair.

- **A — New student — Local UI + service integration.** UI signup/onboarding/course/exam/upload/processing tested; Tutor → grading → learning → plan integration passes with external AI mocked. No single live-model, zero-intervention staging journey.
- **B — Exam preparation — Local workflow + UI.** Dashboard/deep links, exam workflow, persisted plan/quiz, answers and learning state pass in split tests. Live-model staging journey pending.
- **C — Lecture study — Local workflow + UI.** Real PDF/local RAG and Notes/Tutor/Quiz wait-resume integration pass; AI outputs use fixtures.
- **D — Weak topic recovery — Local workflow + UI.** Diagnostic/recovery, mastery-confidence refresh and loop limits pass; mobile progress links tested.
- **E — Assignment support — Local workflow + UI.** Draft wait/review/resume persistence and desktop/mobile controls pass with mocked model responses.
- **F — Career — Local services + UI.** Profile/project evidence, skill-gap/resume/plan controls pass; real generated claim quality pending.
- **G — Automation — Local jobs + UI.** Recommendation/reminder/notification state, actions, quiet hours, stale links and cross-session settings pass; deployed schedules unverified.
- **H — Calendar — Provider-mocked integration + mobile UI.** State/consent, free-busy conflict constraints and explicit event writes pass. Actual Google consent, project quotas and provider calendar write unverified.
- **I — Drive — Provider-mocked integration + UI.** Incremental consent, selective import, processing and refresh/version safety pass. Actual remote file change → fresh live Tutor answer unverified.
- **J — Billing — Provider-mocked service integration.** Actual SDK signature validation and persisted entitlement/cancellation/downgrade behavior pass. Real provider checkout/webhook/portal end-to-end journey not run.

Anchors: `tests/full-student-journey.test.ts`, the five workflow suites (`workflows`, `lecture-study`, `weak-topic-recovery`, `assignment-support`, `career-preparation`), `tests/{calendar,drive,billing,background-jobs,notifications,learning,study-planner}.test.ts`, and `tests/browser/`.

## Test / build / eval results

- Full unit/integration run: **69 files, 1,724 passed**, including security, ownership, billing, OAuth, model routing/reliability, guardrails, workflows, entitlements and beta analytics. The extended account-deletion suite separately passed all 9 tests; the final affected regression run passed 6 files / 93 tests.
- Browser: **21 distinct cases passed across batches**, including the added first-time mobile/empty-product test and full mobile interactive Quiz/workflow case. Initial failures came from missing OAuth test configuration/document worker, then the legitimate shared 10-signups/minute limit. A disposable database, private storage and synthetic OAuth setup resolved the prerequisites; tests were batched without reducing production limits. Extra mobile checks discovered the accessibility issues fixed below. The final mobile reruns passed. This is not a claim that the original monolithic browser command passed.
- TypeScript passed. Lint: **0 errors, 4 existing navigation warnings**. Dependency audit: **0 reported vulnerabilities**, for the installed graph/advisory snapshot at execution time.
- **FULL offline evaluation: 52 cases, 0 failed checks.** Evidence is `system` or `evaluator-fixture`; there are **no generated cases**. Selected live generation/judging and release-to-known-good comparison were **not run** because no usable AI key or reviewed generated baseline was available. Source faithfulness, semantic correctness and cost-quality equivalence remain unproven.
- Fresh database: **71 tables, 39 migrations, pgvector 0.8.2**. A separate **38 → 39** upgrade preserved pre-existing synthetic User/Course/Exam rows exactly and created no automatic beta grants. This is representative upgrade evidence, not a production-volume migration rehearsal.
- Production Docker image builds using the repository's Webpack Dockerfile. Compiled PDF extraction, malformed input, page limits and deployment dependencies pass inside the Linux image. Final artifact details and post-fix check receipts are in [the evidence summary](launch-readiness-evidence.json).
- Local smoke: **6 checks**, covering liveness/readiness, security headers, unauthenticated denial, protected metrics and both document/job worker heartbeats. The smoke command had no authenticated cookie; browser tests separately exercised authenticated flows. No remote staging smoke was possible without a supplied target.
- Local synthetic PostgreSQL dump/restore preserved ownership, 384-dimensional vectors and a private file checksum. Replaying a later account deletion removed data and produced the durable file-deletion record. This **1.552-second tiny fixture drill is not a production RTO** or proof of encrypted off-host backups. Temporary databases/files were removed and the original development server restored.

### Quality thresholds and reliability

Existing `server/ai/evaluation/profiles.ts` policy was retained: defaults minimum 0.80/allowed drop 0.05; grading and Dispatcher 0.95/0.02; Planner 0.99/0.01; model router 1.00/0; RAG retrieval 0.90/0.05; RAG generation 0.90/0.03; minimum five compatible paired samples per profile. These are existing acceptance policy, **not empirically established release baselines**. Missing/unmeasured dimensions and insufficient samples cannot be counted as passed. One controlled Tutor retrieval fixture reaches recall@5/hit@5 = 1; it does not establish representative retrieval or source faithfulness.

Timeout/rate-limit/outage, equivalent fallback, no-valid-fallback, stream-start/cancellation, shared circuit health, capability/context/entitlement floors and embedding-space compatibility pass deterministic and integration tests. Legitimate complex workflows and abuse cases cover budgets, duplicate requests, concurrency and entitlement exhaustion. Exhaustion returns an explicit failure rather than a silently cheaper inadequate model. No routing thresholds or model policy were relaxed.

### Operational controls and recovery

AI/provider/model/feature/background kill switches, integration vetoes, checkout-only pause and beta cohort vetoes have automated boundary coverage. They govern new admissions; they do not recall in-flight requests. Legacy AI routes require separate ingress containment. `BACKGROUND_JOB_SCHEDULE_ENABLED=false` does not remove persisted schedules or stop queued work; stop affected workers and manage schedules explicitly. See [exact controls and incident runbooks](security-privacy-audit.md#exact-emergency-controls).

The rollback runbook now calls out that pre-beta `e1f5239` lacks beta authorization/cohort checks. Additive schema compatibility alone does not make it safe. No actual staging rollback was executed. Require an exact approved image/configuration, revoked/non-invited/paid-pilot access tests, privacy settings and old-job compatibility before approval.

The repository documents auth, database, provider/cost, billing, OAuth, exposure and deployment incident handling across [security/privacy](security-privacy-audit.md) and [production operations](production-operations.md). A named operational owner, actual alert delivery and backup receipts remain deployment tasks. No latest production backup, actual retention enforcement or live restore target was available.

### Environment, storage, cost and capacity

Only local configuration presence was inspected; no secret values were printed. Local database/auth configuration exists. Actual AI generation, Google integration credentials/encryption ring, Stripe, deployed origin/operations token and Sentry configuration were not present for this audit. Synthetic OAuth keys used by browser fixtures were temporary and removed. Local configuration absence is not proof that another deployment is misconfigured; no such deployment was supplied.

Storage is private filesystem storage with persistent Docker volumes and owner-authorized server downloads. **An object-storage adapter and signed bucket URLs do not exist.** This topology requires a persistent host, private permissions and matching off-host file/database backups; ephemeral/serverless deployment is unsafe. Production Compose does not currently set CPU/memory quotas: enforce reviewed limits before accepting untrusted public uploads. The PDF worker's JS heap/deadline limits do not bound all native allocations.

No actual production/staging dashboard/course/progress/career/conversation/Quiz latency measurements, Tutor total latency or TTFT are available. Test execution times are not substituted. No validated cost per active user/core agent/workflow/heavy user or safe user count can be derived from synthetic/local usage. Boundaries in code include an 8-connection default DB pool per process, job concurrency 4, guarded AI concurrency 4/user, 24/provider, 12/model and 4/background. These are admission ceilings, **not a throughput forecast**. Sum pools across all roles and record actual host disk/CPU/memory, provider quotas and representative load before choosing a cohort ceiling. Preserve unpriced usage as unknown and compare measured cost together with generated quality.

## Non-blocking issues

- Inline-script/style CSP remains a documented defense-in-depth limitation; no reachable user/model HTML execution sink was found in the reviewed scope. Continue nonce/hash CSP work separately.
- Four existing lint navigation warnings; browser fixtures need rate-aware batching and explicit worker/OAuth prerequisites in repeatable CI.
- Chromium viewport coverage is not a complete accessibility audit or physical iOS/Android test. Manual screen-reader, focus-order and real-device checks remain worthwhile.
- Local beta queries found no non-fixture activated cohort, behavioral events or feedback to analyze. There is no supported activation/repeat-use/completion/drop-off/provider-failure rate, and no basis to claim zero real P0/P1 reports. Start controlled beta measurement and triage actual feedback before expanding.
- Published business/legal pages and support ownership are B5 for public scope; do not treat invented legal text or a feedback form alone as evidence of reviewed policies or staffed paid support.

## Features recommended enabled at launch

After the relevant blockers are closed: invitation-only core academic data, Documents/RAG, Tutor, Notes, Quiz, Learning/Progress, Study Planner, Academic Manager and validated core workflows. Enable in-app notifications/recommendations only with verified workers. Keep private feedback available. Configure allowlisted beta admission and record the explicit operator owner; this audit did not enable anything.

## Features recommended feature-flagged

Keep new paid checkout disabled until the Stripe test journey and billing support pass; retain cancellation/webhooks for any existing subscribers. Keep Calendar/Drive disabled until real Google consent/write/refresh tests pass; LMS remains off because no production adapter is registered. Limit Career/experimental features to reviewed cohorts until their generated quality is evidenced. Keep background AI and production quality sampling off until budget/privacy/consent and worker checks pass. Analytics is a separate operator choice with opt-out and retention, never a prerequisite for core product availability.

## Immediate post-launch monitoring priorities

Use the existing runbook's initial thresholds, tune to a measured baseline, and prove recipient delivery first:

1. Auth/ownership incidents, readiness (3 consecutive minute failures), database locks/connections/disk and account/file-deletion backlog.
2. Worker heartbeat missing >90 seconds for 3 probes; retries, dead letters, reminder/notification duplicates and workflow wait/resume failures.
3. AI failure >10% with at least 20 calls/10 minutes, fallback/circuit-open events, unpriced calls, quality regressions and a reviewed provider/daily spend cap; do not infer price reductions prove quality retention.
4. If enabled: webhook failure persisting >10 minutes, subscription/entitlement mismatch, OAuth reconnect growth and Calendar/Drive sync failures.
5. Request 5xx >2% with at least 20 requests/5 minutes, latency vs actual baseline, first activation/core journey failures and P0/P1 feedback. Pause cohort expansion on unresolved core failures.

## Changes made by this audit

- Corrected nested main landmarks in the shared student shell, course overview and billing page.
- Gave mobile New chat an accessible name and removed closed mobile conversation history from navigation/accessibility exposure; added expanded/control semantics.
- Added mobile first-time/empty-workspace keyboard/dialog coverage and desktop/mobile interactive Quiz/workflow regression coverage.
- Extended canonical deletion regression to BetaAccess, ProductAnalyticsState, ProductEvent and ProductFeedback.
- Updated privacy processor/data inventory and the rollback authorization warning. Added this report and a sanitized machine-readable evidence summary. No major feature was added.
