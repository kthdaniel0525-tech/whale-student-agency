# Backup, restore, and deployment recovery runbook

Status: **procedure prepared; no hosted backup or restore has been verified**.

This runbook applies to the persistent-host deployment in `compose.production.yaml`. It assumes PostgreSQL/pgvector and private document bytes are separate durable assets. It does not claim that a provider backup, object-storage versioning, or retention policy exists.

## Required ownership and configuration

Before a hosted beta, the operator must record the infrastructure/provider, operations owner, security escalation owner, backup schedule, retention, encryption method and key owner, recovery point objective, recovery time objective, storage durability/versioning behavior, and the location of restore credentials. Backup credentials and encryption-key recovery must be separated from ordinary application credentials.

The backup set must contain a mutually consistent PostgreSQL dump, private document bytes, the schema/migration revision, the immutable application image digest and `RELEASE_SHA`, and every integration-encryption key version needed for retained ciphertext. Model assets can be recreated from the pinned revision. Runtime secrets must remain in the secret manager and must not be copied into the backup artifact or repository.

## Create and accept a backup

1. Identify the exact environment, UTC time, database revision, application release SHA, image digest, document-volume generation, and previous successful backup.
2. Create an encrypted provider snapshot or PostgreSQL custom-format dump with the provider's supported consistent-snapshot procedure. Copy private document storage using its snapshot/versioning mechanism at the matching recovery point.
3. Store the database and file backup off the application host with access logging and restricted restore credentials. Record retention and immutable/versioned protection if the provider actually supplies it.
4. Validate that the artifacts can be listed and decrypted by the recovery role. A successful upload or provider status alone is not a restore test.
5. Write a reviewed receipt containing only safe metadata: environment, UTC time, release SHA, image digest, backup IDs, encryption status, retention expiry, responsible operator, and the last isolated restore result. Never put passwords, tokens, document names, prompts, or user content in the receipt.

## Isolated restore drill

1. Create a new isolated database and document-storage target. Keep public ingress, OpenAI/provider egress, OAuth callbacks, billing, schedules, webhooks, and job/document workers disabled.
2. Restore the database snapshot/dump, apply only migrations compatible with the recorded image, and restore document bytes to the isolated private path. Do not restore over active staging.
3. Replay deletion/revocation decisions newer than the backup before enabling any worker. Expire obsolete sessions and OAuth handshakes. Do not let a restored queue reactivate a deleted account, revoked integration, expired checkout, or cancelled subscription.
4. Start one restricted web instance with the recorded release configuration. Keep external providers disabled. Run readiness and authenticated synthetic smoke checks.
5. Validate representative owned records for users, courses, document metadata, document bytes, pgvector chunks, learning topics/progress, study plans/tasks, workflows/steps, reminders/notifications, and billing entitlement metadata when present. Confirm cross-user access is still denied.
6. Check the `FileDeletion` queue, pending account deletions, billing-retention expiry, pg-boss pending/running jobs, failed/dead-letter work, and worker leases before enabling background processing.
7. Measure recovery time, record row/file counts and sampled referential checks, then destroy the isolated target according to the test-data retention policy.

The drill passes only when both database and file recovery are usable, ownership checks hold, deletion decisions are not reversed, and the evidence receipt is reviewed by the designated operator.

## Database corruption response

1. Stop writes by removing public ingress and stopping web, job, and document workers. Preserve logs and record the incident UTC interval and current release/image.
2. Identify the latest accepted backup before corruption and create an isolated restore. Never experiment on the only backup copy.
3. Validate the restored target using the isolated drill above. Reconcile deletion, billing, integration, queue, and document-storage state after the backup time.
4. Promote the restored target only after the operations and security owners approve the evidence. Rotate credentials when compromise is possible.
5. Re-enable one bounded path at a time and monitor application, database, worker, workflow, AI, and storage errors.

## Accidental deployment response

1. Stop further promotion and preserve the failed image digest, release SHA, timestamps, and safe correlated request/job IDs.
2. If the schema is forward-compatible, run `scripts/deploy-release.mjs rollback` with an immutable reviewed image and `SCHEMA_COMPATIBILITY_REVIEWED=true`. The command validates current runtime configuration before replacement.
3. If the schema or data is not backward-compatible, use the isolated restore procedure. Do not roll back the database solely to match an old image without reviewing post-backup writes and deletion decisions.
4. Run readiness, authenticated smoke, worker-heartbeat, document retrieval, ownership, notification, and queued-job checks before reopening the beta.

## Post-restore validation receipt

Record the environment, source backup IDs, isolated target, initiating and approving operators, start/end UTC times, measured recovery time, database migration, release SHA/image digest, table/file/vector checks, deletion replay result, queue/worker state, ownership result, external-provider state, final disposition, and cleanup time. A completed receipt is required release evidence; this document by itself is not.

