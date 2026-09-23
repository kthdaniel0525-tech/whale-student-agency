# Technical release notes

## Unreleased — target v1.0.0-rc.1

Release candidate status: **RC BLOCKED**. `v1.0.0-rc.1` is reserved but not issued; package version remains `0.1.0`. See the [exact finalization checklist](release-candidate-finalization.md) and [remediation evidence](release-candidate-remediation.md).

### Existing core capabilities retained

Authentication/onboarding, academic data, private Documents/RAG, Tutor/Notes/Quiz, grading and learning progress, Study Planner/Academic Manager, bounded student workflows, memory/personalization, notifications and feedback. No new agent, workflow, integration, tier or analytics product was added.

### Initial rollout preset

Closed, allowlisted `core` beta after remaining gates pass. Existing integration switches disable Calendar, Drive and LMS; **no external integration is enabled in the initial preset**. Billing/new checkout, Career/Career Preparation, optional content evaluation and product analytics remain disabled. Required document/background indexing stays enabled. These are checked-in example settings, not changes to an existing deployed account or provider configuration.

### Fixed release-control gaps

- Add CPU, memory, swap, process and temporary-filesystem containment to production containers.
- Refuse beta deployments/rollbacks to images lacking the reviewed beta access policy; validate current runtime before rollback.
- Make insufficient/regressed model comparisons and failed comparison candidates fail the evaluation command.
- Require a release evidence check before production promotion; reject fixture-only, unmeasured, incomplete or incompatible quality reports.
- Add focused release security/evaluation regressions and clarify rollout/recovery procedures.

### Verification and limitations

1,748 full tests pass; TypeScript, production image/PDF/model smoke, 39 migrations and dependency audit pass. Local production Compose passes 9 authenticated HTTPS/worker checks. FULL offline evaluation passes 52 cases, but real generated quality and representative RAG faithfulness remain unverified. No externally hosted staging target, alert-delivery receipt, operational off-host restore/rollback proof or published policy/support decision is available. Paid and Google provider journeys require actual provider test evidence before enabling them.

The system remains a persistent-host/private-volume deployment. No object-storage adapter, calendar provider expansion, HA topology or claimed public user capacity was introduced. Do not interpret the local single-user timing measurements as a production performance commitment.
