# Privacy and public policy readiness

2026-09-23 · engineering evidence prepared · **external/legal blocker remains**

This checklist reports the implementation as it exists. It is policy-drafting input, not legal text, legal advice, or approval.

## Launch-facing status

- **Privacy Policy:** missing; no reviewed public page or approved URL is present.
- **Terms of Service:** missing; no reviewed public page or approved URL is present.
- **Support/contact path:** authenticated product feedback exists, but no named accountable support/security owner or public contact path is configured.
- **Billing cancellation information:** paid checkout is disabled for the initial core beta. Existing cancellation/webhook code remains available, but paid access must stay disabled until test-mode lifecycle evidence and reviewed customer-facing terms exist.
- **Account deletion:** the authenticated API requires password reauthentication and the literal confirmation `DELETE`, rate-limits attempts, disables the account, removes sessions/OAuth handshakes, and cancels active jobs/workflows. A retryable background process handles provider checkout/subscription cleanup, integration revocation, local cascades, and queued physical-file deletion. The current Settings UI does not expose a deletion control, so the beta needs a documented support-assisted path or a separately reviewed UI before inviting users.
- **Data handling summary:** engineering behavior is documented in `security-privacy-data-map.md`; deployment vendors, regions, contractual retention, backups, external logs, and final policy periods are not selected by the codebase.

## Actual engineering data flow

- Account/session and profile data, academic records, courses, assignments, exams, learning state, study plans, workflows, reminders, notifications, conversations, memory, feedback, entitlements, and operational job metadata are stored in PostgreSQL.
- Uploaded PDF/TXT/Markdown bytes are validated and stored under private opaque paths; metadata, extracted text/chunks, and 384-dimensional local embedding vectors are stored with owned PostgreSQL records. The repository selects no cloud object-storage vendor.
- OpenAI receives the current request plus bounded task-relevant profile/academic context, selected retrieval passages, conversation context/summary, and relevant memory. Provider requests set `store: false`; this does not establish the provider's contractual retention or deployment-region terms. Billing records, OAuth credentials, and infrastructure secrets are excluded from AI context.
- Memory stores explicit preferences and supported inferred learning/product-use observations. Users can remove memory through the implemented memory service; full account deletion cascades local memory.
- Google Calendar/Drive are feature-flagged off for the initial core beta. If enabled later, access/refresh tokens are encrypted server-side; Calendar context exposes availability rather than event descriptions, and Drive import is an explicit user-selected copy into the private document pipeline.
- Billing is feature-flagged off. If enabled later, Stripe receives server-selected customer/product/price/subscription metadata and hosts card entry; the application stores provider IDs and signed webhook receipts, not card details.
- Product analytics is disabled in the initial preset. When deliberately enabled, it stores bounded event identifiers and dimensions in PostgreSQL; it excludes prompts, AI outputs, document bodies, and feedback text, and supports user opt-out. Operational/security/AI-usage records are separate purposes.

## Deletion and retention limits that policy must disclose

Local account deletion does not erase prior AI-provider requests, Stripe financial records, source files still held by Google, external Calendar events, provider logs, infrastructure logs, or backup copies. Physical document deletion is asynchronous and retried through `FileDeletion`. Restored backups must replay deletion/revocation decisions. PostgreSQL queues, webhook receipts, rate-limit records, security records, external logs, and backups require operator-approved retention; the repository does not establish final legal periods.

## External decisions required before RC approval

1. Business/legal review and publication of Privacy Policy and Terms for the actual hosting region, vendors, retention, AI processing, beta terms, and user rights.
2. A named support/security owner, public contact path, incident escalation path, and expected response process.
3. Approved retention/deletion periods for backups, external logs, pg-boss history/dead letters, webhook receipts, security events, AI usage/evaluation records, and any billing mappings.
4. Hosted backup/restore evidence and confirmation of every actual processor/vendor and data region.
5. A usable account-deletion path communicated to beta users; verify the complete hosted deletion and file-cleanup flow with a synthetic account.

Until these decisions are completed, Public Policy Readiness remains **EXTERNAL BLOCKER** and the RC remains blocked.

