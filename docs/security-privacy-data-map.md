# Security and privacy engineering data map

Reviewed against the application schema and server configuration on 2026-09-23. This is an engineering inventory for deployment and future policy drafting, not a legal retention policy or compliance certification. A configured adapter is not evidence that a production account, cloud host, or contract has been provisioned.

## Trust boundaries

- **Browser → authenticated application server:** session cookies, validated product inputs, selected resource IDs, uploaded bytes, OAuth callback parameters, and explicit billing actions. User identity, ownership, model permissions, price IDs and workflow definitions are resolved server-side. The browser receives owned product data and safe status/errors, never provider credentials.
- **Application → PostgreSQL:** account/session data, product records, integration credentials encrypted with a server-held key, billing mappings and operational metadata. Prisma and parameterized SQL enforce queries; composite ownership keys protect important child relationships. Database access is an infrastructure privilege, not an application user capability.
- **Application → private file storage:** validated PDF/text bytes under opaque generated storage keys. Metadata remains in PostgreSQL. Files are outside public assets and delivered through authorized handlers. No object-storage cloud vendor is selected by this implementation.
- **Application → vector retrieval:** 384-dimensional document, conversation and memory vectors live in PostgreSQL/pgvector alongside their owning rows. Retrieval predicates include the authenticated user and relevant resource scope. This is not a separate managed vector service.
- **Application → AI provider:** the current request, selected academic context, bounded relevant passages, conversation history/summary and task-specific memory. Billing records, OAuth credentials and infrastructure secrets are excluded. Replies and structured data are validated; generated text does not confer permission to execute actions or manufacture trusted citation metadata.
- **Application → background jobs:** canonical user/resource IDs, versioned validated payloads, idempotency keys and operational references enter pg-boss in PostgreSQL. Workers reload resources and ownership; a queue payload is not a trusted permission grant. The separate `JobRun` table contains safe execution status rather than raw provider payloads.
- **Application/browser → Google OAuth and APIs:** requested scopes, state/PKCE, authorization codes, account identity, encrypted-at-rest access/refresh tokens, selected Calendar data and explicitly imported Drive bytes. Tokens stay server-side. Availability context excludes event descriptions/attendees; permitted Calendar writes send selected study-session details.
- **Application/browser → Stripe:** server-selected price/customer/subscription IDs, opaque platform-user metadata, redirect URLs and hosted Checkout/Portal sessions. Card details are entered at Stripe and are not stored by the application.
- **Stripe → webhook endpoint:** bounded raw bytes cross an unauthenticated HTTP boundary and are processed only after signature validation. Stored webhook receipts contain event identity/type/status, not the raw event body. Provider state is re-fetched through the authenticated adapter before local entitlement changes.
- **Academic integration adapter → institution:** the LMS foundation defines allowlisted authenticated reads and normalized imported records. The production registry currently has no institution adapter; only automated tests inject a test adapter. Adding a real institution requires extending this map and reviewing its scopes/endpoints.

## Data inventory

### Account and profile

- Storage: `User`, `Profile`, `Account`, `Session`, `Verification`, `RateLimit` in PostgreSQL. Includes email/name, password hash for credentials login, school/program/preferences, session token/expiry and optional IP/user agent. Better Auth's generic Account schema has social-token fields; production auth currently configures email/password, with external product integrations stored separately.
- Purpose/processors: login, authorization, personalized academic context and abuse prevention. Better Auth is an in-process library using this database, not a separately configured identity SaaS. Profile context selects useful educational fields; it does not send email, session tokens or password hashes to AI.
- Deletion: sessions are revoked when deletion is requested; Account/Profile/Session cascade when User is deleted. Known reset-password `Verification.value = userId` rows are explicitly removed. Verification and RateLimit lack a User foreign key; see retention exceptions below.

### Academic records and study plans

- Storage: `Course`, `Assignment`, `Exam`, `StudyPlan`, `StudyTask`, including deadlines, descriptions, task reasons, status and optional scheduled times.
- Purpose/processors: academic organization, planning, deadline prioritization and optional selected Google Calendar writes. Relevant subsets enter AI context. There is no automatic full academic database export to a provider.
- Deletion: owned records cascade on account deletion. Course-linked mandatory relations cascade; nullable independent context links may become null. Completed study history is preserved during ordinary replanning, and removed during whole-account deletion. Existing provider Calendar events are not automatically erased by account deletion.

### Uploaded documents and derived retrieval data

- Storage: original bytes under `DOCUMENT_STORAGE_PATH` (default `.local/documents`), with `Document`, `DocumentPage`, `DocumentChunk` text/provenance and pgvector embeddings in PostgreSQL. `ExternalFileLink` records the imported origin. Model weights/cache are not user documents.
- Purpose/processors: authorized previews and source-grounded learning. Parsing and MiniLM embeddings execute locally; relevant retrieved excerpts may enter an OpenAI generation request. Drive downloads enter the same private document validation/processing pipeline as uploads.
- Deletion: Document deletion cascades pages/chunks/vectors. A database trigger inserts a `FileDeletion` row before deleting each Document, including course/account cascades. That queue intentionally survives the owner and retains only user ID, storage key, attempts and retry timestamps until bytes are removed. Immediate cleanup is best-effort; workers retry and reconcile aged orphan files.
- Important distinction: deleting a source file does not automatically erase independent notes, generated quizzes or conversation messages already saved by the user. Those are separate product records and are included in whole-account deletion.

### Conversations and feedback

- Storage: `Conversation`, `ConversationMessage`, `ConversationSummary`; messages contain text, minimal artifact metadata and optional in-row embeddings. `AIUserFeedback` may contain an explicit private comment.
- Purpose/processors: continuity, owned conversation search and response feedback. Bounded summaries/relevant turns may enter AI prompts. Raw feedback comments are not used as numerical quality-evaluation labels.
- Deletion: deleting a conversation cascades messages, summaries, feedback and their vectors. Individual message deletion invalidates affected summaries; summary persistence revalidates source messages/version to prevent in-flight generation from restoring deleted text. Account deletion removes all conversations. Numeric evaluation/usage records can retain message/conversation reference IDs after individual message deletion, but contain no message body; they cascade on account deletion.

### Learning analytics

- Storage: `Quiz`, `QuizQuestion`, `QuizAttempt`, `QuestionAttempt`, `LearningTopic`, `QuizQuestionTopic`, `LearningProgress`, `LearningProgressSnapshot`.
- Purpose/processors: grading, mastery/confidence, practice recency and trends. Objective grading and progress calculations are local deterministic code. Semantic grading sends the owned question, expected answer and submitted answer to the AI provider. Context Builder sends bounded aggregate topic summaries, not entire attempt history.
- Deletion: direct or inherited owner relationships cascade from User. Deleting a quiz attempt through the service rebuilds only affected learning aggregates. Normal answer retries reuse an owned attempt; explicit retakes create new evidence.

### Memory and personalization

- Storage: `UserMemory`, `MemoryObservation`, `AdaptiveOutcome`, including typed preferences/goals, concise product-behavior evidence, confidence and optional local semantic vectors.
- Purpose/processors: task-relevant personalized explanations and planning. Automatic observations are academic/product signals, not unrestricted sensitive-trait inference. Users can inspect, edit, archive or delete their memory. Relevant selected memory may enter AI context.
- Deletion: account deletion cascades all records/vectors. Memory deletion cascades its observations. Archived memory is excluded from active retrieval but remains stored until explicitly deleted or whole-account deletion.

### Career data

- Storage: `CareerProfile`, `Project`, `Skill`, `CareerPlan`, `CareerTask`; this includes user-supplied resume text, experience, portfolio/repository links and goals.
- Purpose/processors: grounded career planning and resume assistance. Only requested bounded career evidence enters AI prompts. Saved external links are data, not a request for unrestricted server fetching.
- Deletion: account cascades remove the full local career record. Deleting a local portfolio link does not delete the externally hosted portfolio/repository.

### Recommendations, reminders and notifications

- Storage: `Recommendation`, `Reminder`, `ReminderPreference`, `Notification`, with safe internal action references, timestamps and status.
- Purpose/processors: study recommendations and in-app delivery. The implemented notification adapter is in-app persistence; no external email/SMS/push processor is configured. Notification text may name an academic item, but does not include full source-document content.
- Deletion: User cascade removes records. Dismissal/archive affects visibility rather than immediate deletion. Some source links are deliberately nullable so prior notification history survives individual source deletion; action handling revalidates current ownership/existence.

### Integrations

- Storage: `ConnectedAccount`, `OAuthConnectionSession`, `IntegrationSyncState`, `CalendarIntegrationPreference`, `ExternalEventLink`, `ExternalFileLink`, `ExternalCourseLink`, `ExternalAssignmentLink`, `ExternalExamLink`.
- Purpose/processors: provider authorization, explicitly selected imports and opt-in Calendar availability/writes. Stores provider identifiers, scopes/status, encrypted token/cursor material, bounded busy intervals, and sync provenance. It does not mirror all Drive files or Calendar event descriptions into AI context.
- Deletion: disconnect blocks API access and clears active local credentials/sync access; imported local academic/document copies intentionally remain usable. Account deletion attempts remote revocation, then removes local accounts/tokens/sync links through cascades even if best-effort revocation fails. Provider originals and previously created external Calendar events remain on that provider unless separately removed there.

### Plans, entitlements and billing

- Storage: shared `Plan` catalog; owned `UserSubscription`, `UserEntitlementOverride`, `EntitlementEvent`, `EntitlementUsageAdmission`; `BillingCustomer`, `BillingSubscription`, `BillingCheckout`; global `BillingWebhookEvent`; optional `BillingRetentionRecord`.
- Purpose/processors: access control, quota reservation, server-verified subscription synchronization and reconciliation. Stripe receives an opaque `platformUserId` customer metadata value and payment/subscription operations. Local tables store amounts/currency/status and provider mappings, not card numbers or raw webhook bodies. Billing data is excluded from AI prompts.
- Deletion: pending Checkout sessions are expired and provider subscriptions canceled before local content deletion. Provider failure leaves the account disabled/pending for retry instead of losing the identity needed to stop charges. Owned local subscription/entitlement/customer rows then cascade.
- `PRIVACY_BILLING_RETENTION_DAYS` must be explicitly configured for accounts with billing records. It accepts 0–3650 days; 0 means no retained local mapping. Positive values retain only provider customer/subscription IDs and deletion/expiry timestamps in `BillingRetentionRecord`, without user content, email or a User foreign key. The deletion sweep purges expired rows in bounded batches. The chosen period must come from product/operator policy, not this document.
- Stripe's own customer metadata, invoices, payment history and other financial records are not deleted by this application flow. Subscription cancellation does not imply erasure of provider financial history; provider/customer deletion and applicable retention require separate documented operations.

### Operational analytics and background work

- Storage: `AIUsageRecord`, `AIEvaluationRecord`, `AIGuardState`, `AIGuardEvent`, `JobRun`, pg-boss tables in the configured `BACKGROUND_JOB_SCHEMA` (default `student_jobs`), minimal webhook receipts and operational logs.
- Purpose/processors: usage/cost measurement, guarded execution, reliability, quality statistics, job retries and incident diagnosis. Usage/evaluation rows allowlist numeric/taxonomy metadata and versions. They exclude full prompts, source passages, credentials, raw provider errors and judge rationale. Production semantic evaluation requires enabled sampling plus current explicit policy consent; offline datasets are synthetic fixtures.
- Deletion: user-linked usage/evaluation/JobRun records cascade. Guard events are explicitly removed because they have no User FK. Queue payloads, hashed guard state, global webhook receipts and external runtime logs have distinct retention lifecycles below; they must not be described as immediately erased by the User cascade.

### Beta access, product analytics and product feedback

- Storage: `BetaAccess` holds invitation/activation/revocation, cohort and internal-account metadata. `ProductAnalyticsState` holds a random analytics identifier, opt-out and feedback-prompt dismissal. `ProductEvent` holds allowlisted behavioral names/properties, environment and hashed deduplication/correlation keys. `ProductFeedback` holds explicitly submitted private messages, ratings, optional survey answers, owned request/workflow references and triage status/severity.
- Purpose/processors: closed-beta admission, bounded product usage metrics and private feedback review. The current analytics adapter writes to the application database. The development-only console adapter receives a pseudonymous identifier and safe properties; no external analytics vendor is configured. Prompt/response/document/resume contents, email/name, OAuth secrets and feedback messages are excluded from analytics properties. Existing AI usage/quality/billing/workflow records remain canonical rather than being copied into a second telemetry store.
- Access: analytics identity comes from the authenticated server session. Internal aggregate and private-feedback endpoints require the explicit `BETA_ADMIN_USER_IDS` configuration; a paid plan is not admin authorization. Internal accounts, opted-out users and deletion-pending users are excluded from beta metrics. Environment labels separate behavioral events; canonical operational tables still require separate deployment databases.
- Deletion/retention: all four models cascade on account deletion. Opt-out deletes retained `ProductEvent` rows and fences concurrent delivery; it does not erase explicit feedback or necessary operational records. The existing maintenance job removes up to 5,000 behavior events older than `PRODUCT_ANALYTICS_RETENTION_DAYS` (default 180 days) per run. Feedback and beta metadata otherwise remain until account deletion or an explicit approved retention policy. Console-log retention belongs to the deployment log policy and is not erased by a database deletion.
- Collection is disabled by default and best effort. In-flight events can be lost on process shutdown. These settings and opt-out do not establish legal consent or a complete data-erasure claim. See [beta operations](beta-analytics.md).

## Actual processor and deployment map

- **OpenAI:** implemented remote generation/structured-output/streaming adapter, plus an optional general embedding operation. Responses requests set `store: false`. That request flag is not a claim about all provider-side logs, retention or contractual settings. Persisted RAG/conversation/memory vectors use the separate local 384-dimensional implementation.
- **Google:** implemented OAuth identity/consent, Calendar and Drive APIs. Product flows use Calendar read/write or Drive read as needed. The shared provider capability type retains `email-read` only to recognize historical grants. Public connection admission and Google scope construction reject new email permission requests; reconnect filters historical email grants out of requested scopes. No Gmail product feature is implemented. Previously granted Google permissions may still require provider-side revocation; omitting a scope is not a claim that Google removed an old grant.
- **Stripe:** implemented hosted Checkout, Billing Portal, subscription reconciliation and signed webhooks. Billing remains conditional on server configuration.
- **Sentry (when configured):** server error metadata only, filtered by `server/operations/monitoring.ts`; request objects, user identity, cookies, headers, raw messages, prompts, source text and arbitrary contexts are removed. Deployment operators must provision the project, access controls, retention and alert recipients. No live Sentry delivery is established by the repository tests.
- **Hugging Face model distribution:** pinned `Xenova/all-MiniLM-L6-v2` model assets may be downloaded only when `EMBEDDING_ALLOW_DOWNLOAD=true`; default inference uses the local cache. This asset download is not a hosted embedding request and does not send user text to a Hugging Face inference endpoint.
- **PostgreSQL 17 / pgvector and pg-boss:** local Compose configuration is present. Database hosting, disk storage, backups, log aggregation and production region/vendor are deployment choices not established by repository defaults. Better Auth, Prisma, pg-boss and document parsers execute in the application/worker environment.
- **No production LMS institution, external notification vendor or additional AI provider is registered.** Only providers configured for the deployed Student Agency environment are processors; repository examples do not establish a production connection.

## Deletion and retention review

1. The authenticated deletion endpoint reauthenticates the password and never accepts a target user ID. `requestAccountDeletion` marks the account pending, removes sessions/OAuth handshakes and cancels active tracked jobs/workflows. Authentication, entitlement and worker boundaries reject pending accounts.
2. `completeAccountDeletion` performs provider calls outside transactions, fences billing cancellation, attempts integration revocation, retains only explicitly configured billing mappings and then deletes User in a short transaction. Failed financial cleanup keeps the disabled account available for retry/operator recovery.
3. Direct and inherited cascades cover product records, password credentials, owned operational records, encrypted integration material and every in-row vector. `QuestionAttempt`, `QuizQuestionTopic`, `LearningProgress`, `WorkflowStepRun` and `ConversationSummary` inherit ownership through composite parents even where no direct User relation appears. `FileDeletion` is the intentional disk-cleanup exception.
4. Remote content previously sent to an AI provider, provider financial records, original Drive/LMS files and external Calendar events are outside local database cascades. Backups and external log stores also require deployment retention/deletion procedures.

Retention behavior requiring operator awareness:

- **FileDeletion:** retry until physical removal succeeds. Do not expire these rows before cleanup; alert on persistent failures/backlog. Deleted content becomes inaccessible through normal app lookups before disk cleanup completes.
- **OAuth handshakes:** short configured expiry, one-time consumption and scheduled expired-row cleanup; all user-owned rows are removed when deletion starts.
- **Verification:** known password-reset rows are explicitly deleted by value=userId. Better Auth lazily cleans expired verification rows on lookup. Future auth plugins must inventory their identifier/value formats and add deletion support; the schema has no owner FK.
- **RateLimit:** database-backed credential/IP counters are not user-content records and have no owner FK. The credential limiter HMACs action+email; deleting an account does not currently purge all historical rate-limit keys. Establish periodic pruning using `lastRequest` without weakening active abuse controls.
- **AIGuardState:** hashed keys, counters/leases and some response-reference IDs expire; the daily cleanup removes expired state in bounded batches. Request dedupe may last 30 days. There is no owner FK or direct per-user purge; no message/prompt body is stored here.
- **AIGuardEvent:** currently explicitly purged during account deletion and independently pruned after 30 days. The event writer locks and verifies the active User row in the same transaction as insertion, serializing with deletion; late events for missing/deletion-pending owners are dropped. Ownerless internal/system events retain their independent operational lifecycle.
- **pg-boss:** queues currently configure 14-day pending retention and 30-day completed retention. Payloads are minimal references and schema-validated, but do not cascade with `JobRun`. Deleted/pending owners cannot regain authority from stale work. Review dead-letter retention and purge procedures as part of production operations.
- **Entitlement admissions:** cascade with User; expired billing-period reservations also receive a 90-day cleanup buffer in daily maintenance.
- **BillingRetentionRecord:** explicit configured policy, with bounded expiry cleanup by the deletion worker. **BillingWebhookEvent:** minimal global event receipts persist independently; define a reconciliation/replay-safe pruning period before long-term operation.
- **Other telemetry, notifications, JobRun history and logs:** core per-user database records cascade on account deletion; automatic age-based retention is not universally implemented. Set approved retention for operational history, external logs and backups before launch. Do not add blanket expiry for useful academic/conversation content without a product policy.

Maintenance requires running scheduled workers. A TTL or `retainUntil` marks eligibility for deletion; it does not delete a row by itself while workers are stopped.

## Export preparation

The schema supports an owned export without proprietary content formats: scalar fields, ISO timestamps, arrays and JSON can be serialized as versioned JSON, with original document files included separately through authorized storage reads. A future export must:

- derive the user from a fresh authenticated/reauthenticated server identity;
- paginate and scope every root and child query by owner/composite parent;
- include profile, academic data, conversations, quiz attempts/results, topic summaries, study plans, user memory, career records and relevant user-visible preferences/history;
- resolve opaque IDs into consistent manifest references and preserve dates/timezones;
- exclude session tokens, password hashes, OAuth tokens/PKCE, encryption keys, billing secrets and internal operational control records;
- distinguish user-provided content from regenerable vectors, summaries and aggregates; include originals and explain derived fields rather than treating model vectors as the only retained content;
- deliver a private short-lived artifact, with an explicit cleanup deadline, never a permanent public export URL.

No full export/compliance portal is implemented by this audit. Database/file backups must preserve matching schema, pgvector data, private file bytes and encryption-key recovery under separate access controls. Restore procedures must replay deletion/retention decisions so backups do not silently reactivate deleted accounts or revoked integrations.

## Source anchors

- `prisma/schema.prisma`, migrations for document-file cleanup and composite ownership relations.
- `server/privacy/deletion.ts`, `server/privacy/account-state.ts`, `server/jobs/delete-accounts.ts`.
- `server/documents/cleanup.ts`, `server/documents/storage/local.ts`, `server/documents/embeddings/index.ts`.
- `server/context/categories.ts`, `server/conversations/service.ts`, `server/memory/service.ts`.
- `server/ai/providers/openai.ts`, `server/ai/usage/records.ts`, `server/ai/evaluation/sampling.ts`, `server/ai/guardrails/maintenance.ts`.
- `server/integrations/{google,service}.ts`, `server/academic-integrations/registry.ts`, `server/notifications/channel.ts`.
- `server/billing/{stripe,service}.ts`, `server/jobs/{config,queue,cleanup-oauth}.ts`, `server/auth/{config,rate-limit}.ts`, `compose.yaml`.
- `server/beta/`, `server/product-analytics/`, `lib/product-analytics/`, `server/operations/monitoring.ts`, `docs/beta-analytics.md`, `compose.production.yaml`.
