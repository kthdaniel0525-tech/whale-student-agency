# Release candidate operational evidence

2026-09-23 · candidate revision `5b9b9605c563bcd01803fb325827ed9e4a6706b4` · target `v1.0.0-rc.1` · **RC BLOCKED**

This record covers only the five remaining release-candidate blockers. It does not replace the earlier application, security, browser, migration, container, or local deployment evidence. No new product feature, Agent, Workflow, integration, billing behavior, or quality threshold was added.

## Hosted staging — FAIL

No production-like hosted staging target is connected to this checkout or execution session. The repository contains a self-hosted Compose release path and GitHub release workflow, but the required `agency-staging` runner, staging URL, immutable deployed image, host configuration, secrets, synthetic session, database, durable document volume, scheduler, workers, and monitoring project are not available here.

No existing hosted deployment provides this application's PostgreSQL, pgvector, private document storage, workers, schedules, monitoring, and environment-scoped OpenAI configuration. No unrelated or historical deployment is accepted as RC staging evidence.

Because no valid target exists, the required hosted core journey, restart/recovery drill, synthetic failure monitoring receipt, scheduler timing, duplicate-delivery check, and timezone check were not run. Local Docker and browser results remain useful engineering evidence but are not relabeled as hosted evidence.

## Real AI quality — FAIL

No environment-scoped OpenAI credential or reviewed real baseline report is available. A FULL live/judge attempt was made with the existing evaluation command and controlled fixtures. It completed 52 cases with **36 failed checks**: all 19 `generated` rows failed before model/provider attribution with `executionFailure`, model judging was unavailable, and no cost row was produced. Dispatcher retained nine deterministic system passes, but that is not a real provider execution. The strict release gate then failed with `FAILED_OBSERVATIONS` and insufficient measured evidence for every core release profile. Existing thresholds remain unchanged.

Required evidence remains one reviewed known-good FULL baseline and one FULL candidate report produced with real generation and judging on controlled synthetic fixtures. Each row must retain model, prompt version, routing tier, evaluator version, score/pass result, latency, token usage, and estimated cost. A core profile failure remains release-blocking.

## Real RAG quality — FAIL

No hosted controlled course document was uploaded for this candidate and no live answer was generated. Retrieval ownership and source constraints pass repository tests, but there is no hosted evidence for relevant chunk, document, page/source, cross-user isolation, answer faithfulness, fabricated-citation avoidance, or unsupported-claim avoidance. The current strict `rag-retrieval` and `rag-generation` thresholds remain in force.

## Measured AI cost — UNAVAILABLE

There are no real candidate usage records for a simple Tutor request, RAG Tutor request, Notes generation, Quiz generation, Study Planner, or Exam Preparation Workflow. The attempted FULL live run produced zero cost rows because generation never reached an attributed provider/model. Fixture rows and normalized pricing examples are not measured usage. Cost approval requires staging `AIUsageRecord` evidence for call count, input and output tokens, latency, model/fallback path, missing-price count, and estimated cost for each representative scenario.

## Notification operations — FAIL

The in-app notification path and idempotency are implemented and locally tested. Email, push, and SMS remain unimplemented and are not part of the core beta. Without a valid hosted scheduler/worker target, there is no operational receipt for scheduled Reminder → job → one delivery → Notification Center → action, or for snooze, dismiss, action navigation, timezone behavior, worker restart, and duplicate suppression.

## Backup and restore — FAIL

No provider backup configuration, encrypted off-host backup receipt, retention setting, named infrastructure owner, isolated restore target, object-storage durability evidence, or measured restore drill is available. The repository now contains the exact [backup and restore runbook](backup-restore-runbook.md), but a runbook is not a restore result.

## Privacy and public policy — EXTERNAL BLOCKER

The implementation-level data map, deletion behavior, provider boundaries, analytics behavior, and retention gaps are documented in the [engineering data map](security-privacy-data-map.md). The [public readiness checklist](privacy-public-readiness.md) records the current launch-facing gaps. There is no business/legal-reviewed Privacy Policy or Terms of Service and no named support/security contact. Billing remains disabled, so checkout and paid cancellation copy are outside the initial core beta.

## Gate re-evaluation

- AI / RAG Quality: **FAIL**
- Hosted Staging: **FAIL**
- Notification Operations: **FAIL**
- Backup / Restore: **FAIL**
- Public Policy Readiness: **EXTERNAL BLOCKER**

Final decision: **RC BLOCKED**. Package metadata remains `0.1.0`; `v1.0.0-rc.1` is not issued, tagged, deployed, or approved.

## Exact evidence needed to unblock

1. Provision a separate staging host, PostgreSQL/pgvector database, private durable document storage, OpenAI credential, synthetic OAuth account, job workers/scheduler, and monitoring recipients; deploy the immutable candidate image.
2. Complete the hosted core journey and restart/recovery tests without direct database intervention; retain redacted timestamps, release SHA, request/job IDs, and screenshots or provider receipts.
3. Produce reviewed real FULL baseline and candidate reports, then pass the existing strict release-quality gate without lowering thresholds or model floors.
4. Record staging AI usage and cost for the six representative scenarios.
5. Demonstrate scheduled in-app notification delivery once, including snooze/dismiss/action and timezone behavior.
6. Produce an encrypted off-host backup, restore it to an isolated target, validate the records and document bytes listed in the runbook, and record measured recovery time.
7. Obtain reviewed public Privacy Policy and Terms, publish a support/contact path, and assign the accountable support/security owner.
