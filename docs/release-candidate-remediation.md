# Release candidate launch-blocker remediation

2026-09-23 · starting revision `2cb1f94` · **NO-GO** · RC version not issued. This follows the [original audit](launch-readiness-audit.md), not a new theoretical feature review. Existing package version remains `0.1.0`.

## Original blockers and disposition

**B1: OPEN; evidence validation hardened.** Fixed/reverified: Insufficient baseline comparisons and failed comparison models now exit nonzero. Added strict read-only release evidence check without relaxing thresholds; the release workflow requires it after staging smoke before production promotion. Remaining: Actual AI key, reviewed generated baseline/candidate evidence, representative source-faithfulness cases and sufficient profile coverage. Sparse profiles and real workflow/Manager observations need reviewed evidence via the existing evaluation adapter.

**B2: OPEN; container containment and local deployment verified.** Fixed/reverified: Production CPU/memory/swap/process/tmpfs limits are applied and inspected. Closed-core-beta preset and authenticated local production Compose drill pass. Remaining: Real deployment target, environment-specific secrets, durable storage/operator acceptance, target-host load/AI latency and capacity evidence. No object-storage integration was added.

**B3: OPEN; external infrastructure required.** Fixed/reverified: Existing monitoring/redaction and protected metrics were reverified locally. Remaining: Real Sentry/uptime recipients and delivered application/job/database alert receipts.

**B4: OPEN; unsafe rollback admission fixed.** Fixed/reverified: A beta deployment refuses unmarked/pre-beta images before role replacement; rollback validates runtime first. Existing schema review remains required. Remaining: Encrypted off-host backup/retention receipts, target-host restore, and a reviewed exact rollback image with authorization, privacy and queued-job drill evidence.

**B5: OPEN for public launch; paid scope disabled.** Fixed/reverified: Deployment preset disables new paid checkout and unverified integrations/Career with existing switches. Private feedback remains. Remaining: Business/legal-reviewed public policy pages and support ownership. Real Stripe verification is required only before enabling paid launch.

No previously unresolved confirmed Critical/High application finding, destructive data-corruption path, billing spoofing path or measured severe AI regression was supplied by the audit. No threshold, model floor, prompt, RAG behavior or workflow definition was changed without evidence. New work addresses actual missing containment and release-validation controls.

## Fixes and feature decisions

- OS resource containment now applies to production web/document/job roles, PostgreSQL and proxy. Application defaults: 2 CPU, 2 GiB memory, equal total memory+swap limit, 256 processes; bounded temporary/cache filesystems. Limits were inspected on running local Compose containers, and the compiled PDF parser passed. The existing pinned local embedding model also loaded with the same CPU/memory/process limits and no network.
- The immutable app image declares the current beta access policy. The release CLI rejects missing/older metadata before replacing web/workers when beta is enabled, and validates runtime configuration on rollback. Tests run the actual CLI with only Docker substituted. The marker cannot prove queued-job/schema compatibility; an approved target and real recovery drill are still required.
- AI evaluation comparisons no longer return success for insufficient baseline evidence or a failing/regressing comparison model. The release checker requires existing sample/quality thresholds, complete measured semantic dimensions and compatible paired evidence. Offline fixtures cannot certify release quality. No actual quality regression was “fixed” by changing model selection.
- **ENABLE AT LAUNCH, once blockers are closed:** existing academic data, document processing, core student AI/learning/workflows, required background indexing, in-app notifications and private feedback. Admit only the reviewed beta cohort initially.
- **LIMITED BETA:** overall core release through existing `BETA_MODE=true`, exact signup allowlist and `core` cohort. This is the proposed next scope, not an approval to invite real users now.
- **DISABLED AT INITIAL LAUNCH:** billing/new checkout, Calendar, Drive, LMS, Career/Career Preparation, optional content evaluation and product analytics in the supplied preset. Enable each only after its evidence/privacy conditions pass. Keep cancellation/webhooks available for any already-paying deployment rather than blindly applying a new-install billing-disabled preset.
- A global background-AI kill switch is an incident control, not the launch preset: it also blocks core document embeddings. The preset instead targets `evaluate-ai-response` and leaves required processing enabled.

Only the checked-in deployment example was changed; no existing operator secrets or live feature settings were overwritten. Labels and report metadata are trusted build/operator declarations, not substitutes for external evidence.

## Complete release verification

- Targeted final checks: **4 files / 93 tests passed**; earlier security/startup/beta-targeted run also passed.
- Full unit/integration suite: **71 files / 1,748 tests passed**, including security/authorization, billing/entitlements, OAuth/integrations, five workflows, RAG/learning, guardrails/reliability and new release-boundary tests.
- TypeScript passed; lint **0 errors / 4 existing warnings**; dependency audit **0 reported vulnerabilities**.
- FULL deterministic evaluation: **52 cases, 0 failed checks**. The separate release evidence checker correctly **failed** the available offline reports; the workflow now requires this gate before production promotion (YAML and dependency verified). Live generation/judging was **not run**: usable provider credentials and reviewed baseline were unavailable. Some existing profile datasets also need representative reviewed cases/real observations to reach current sample minima.
- Production Docker build passed. Compiled PDF smoke passed under actual Compose resource limits. Fresh database verification passed **39 migrations / 71 tables / pgvector 0.8.2**.
- An isolated local deployment of the production image passed **9 authenticated HTTPS smoke checks**, ordinary signup/onboarding/course creation, restricted runtime DB access, private storage/readiness and both worker heartbeats. Running container HostConfig values confirmed all configured resource ceilings and app access-policy metadata.
- Local warm-page p95 from ten serial reads each: Dashboard **24 ms**, Course **16 ms**, Progress **16 ms**, AI Workspace **15 ms**. One synthetic user/course, local host, external AI/monitoring disabled: **not public capacity, hosted-staging performance, AI TTFT or generated-quality evidence**. Career was disabled; real AI and paid journeys were not timed.
- The first local deployment drill stopped because its temporary harness passed an unsupported `compose create --no-deps` option. Correcting the harness produced the successful run above; temporary projects/volumes were cleaned after both attempts. Existing development data was preserved.
- Prior **21 browser cases** are retained evidence from the original audited commit; no UI code changed and the browser suite was not rerun. All requested code/service regression categories and the new local production smoke were rerun.

Exact sanitized receipts, image digest and limitations: [release evidence](release-candidate-evidence.json). Raw local logs remain in `/private/tmp/rc-*` and are not uploaded.

## Final category status

- **Security: PASS WITH KNOWN RISK.** No confirmed unresolved Critical/High finding from the original audit. Security and authorization suites pass; native process limits and beta rollback denial added. Inline CSP and external deployment controls remain risks.
- **Privacy: PASS WITH KNOWN RISK.** Deletion, analytics opt-out and redaction regressions pass. Actual external retention, published policy and target-host recovery remain unverified.
- **Data Integrity: PASS.** Full data-integrity regressions and fresh 39-migration checks pass; no reset of existing user data or data-model changes.
- **AI Quality: FAIL.** Offline FULL checks pass. Release evidence checker correctly rejects fixtures/insufficient paired evidence; real generated baseline and candidate observations are unavailable.
- **RAG: FAIL.** Isolation, filters, refresh and retrieval integration tests pass. Pinned model/PDF load under OS limits passes. Representative live source faithfulness remains unproven.
- **Agents: PASS WITH KNOWN RISK.** Existing full unit/integration suite passes; actual generator/judge release quality remains blocked. No model floors or prompts were weakened.
- **Workflows: PASS WITH KNOWN RISK.** Existing five workflow integration suites pass pause/resume, retries, ownership, learning refresh and bounded loops. Provider responses are mocked.
- **Billing: PASS WITH KNOWN RISK.** DISABLED AT INITIAL LAUNCH in the deployment preset. Billing/signature/entitlement tests pass; enabling paid access still requires actual Stripe test-mode checkout, portal and lifecycle evidence.
- **Integrations: PASS WITH KNOWN RISK.** Calendar/Drive/LMS are DISABLED AT INITIAL LAUNCH. OAuth/integration regressions pass, with external boundaries mocked; real provider verification is still required before enabling.
- **Automation: PASS WITH KNOWN RISK.** Local production-image workers and heartbeats pass; targeted flags keep required document embeddings available. Target-host schedules and operational alert delivery remain unverified.
- **Infrastructure: FAIL.** Resource ceilings, private read-only app roles, production image, HTTPS, restricted runtime DB role, migrations and authenticated local smoke pass. Actual host/storage acceptance, backups and approved rollback drill are missing.
- **Monitoring: FAIL.** Redaction and metrics tests plus local worker/health checks pass. No externally delivered Sentry/uptime/operator alert receipt is available.
- **Performance: PASS WITH KNOWN RISK.** Bounded local production-image single-user page reads measured without severe delay; no public-load/capacity or real AI latency/TTFT evidence. Target-host performance remains part of B2.
- **UX: PASS WITH KNOWN RISK.** No new core UX failure in the full regression suite. Prior 21 browser cases remain the UI evidence; UI code was unchanged and that browser suite was not rerun in this remediation.
- **Mobile: PASS WITH KNOWN RISK.** Retains prior mobile Quiz/workflow/onboarding coverage. Real-device and screen-reader checks remain; no mobile UI changes in this remediation.
- **Support: PASS WITH KNOWN RISK.** Existing private feedback remains available. Business-reviewed public policies and an accountable support owner are still required for public launch.
- **Beta Feedback: PASS WITH KNOWN RISK.** Local non-fixture beta users/events/feedback remain absent. No real P0/P1 inventory or successful activation/retention claim can be inferred.

## Remaining risks

**Unresolved launch blockers:** real AI/RAG baseline and quality coverage; actual deployment/secret/storage/capacity validation; external alert delivery; encrypted off-host backup/restore and approved rollback drill; business-reviewed public policy/support decisions. No production/staging URL or credentials were supplied during remediation. These cannot be replaced with synthetic receipts, invented legal text or fixture model scores.

**Launch-safe known risks after those blockers close:** single-host restart windows, existing inline CSP, external features disabled, limited Chromium/device coverage, sparse beta evidence, and containment limits that require workload-specific sizing. Local queries found no non-fixture activated beta users/events/feedback, so there is no basis for real activation rates or an issue-free P0/P1 claim.

**Post-launch improvements:** four existing navigation lint warnings, broader real-device/screen-reader coverage, measured tuning after the cohort has actual usage, and operational retention reviews. Do not add agents/integrations or chase cosmetic changes in this phase.

## Files changed

- `.github/workflows/release.yml`
- `compose.production.yaml`
- `deploy/compose.env.example`
- `deploy/runtime.env.example`
- `docker/app.Dockerfile`
- `docs/ai-quality-evaluation.md`
- `docs/launch-readiness-audit.md`
- `docs/production-operations.md`
- `docs/release-candidate-evidence.json`
- `docs/release-candidate-remediation.md`
- `docs/release-notes.md`
- `docs/security-privacy-audit.md`
- `scripts/check-release-quality.ts`
- `scripts/deploy-release.mjs`
- `scripts/run-evals.ts`
- `server/ai/evaluation/release-gate.ts`
- `tests/production-operations.test.ts`
- `tests/release-deployment.test.ts`
- `tests/release-quality.test.ts`

## Final decision and version

**NO-GO.** Repository-level remediation and local regression verification are complete, but the original evidence-dependent launch blockers are only partially closed. No RC version/tag is issued and no public deployment is authorized by this result. [Technical release notes](release-notes.md) remain an unreleased draft for the eventual candidate.
