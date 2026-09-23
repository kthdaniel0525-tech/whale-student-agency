# Integration & OAuth Foundation

External grants are separate from the existing Better Auth login `Account` model.
This phase implements Google authorization, identity, token refresh and revocation,
plus the reusable contracts for later integrations. It does not sync Calendar,
Drive or Gmail, perform external writes, or call an LLM.

## Configuration and manual verification

Normal authentication and other features do not require OAuth secrets. With missing
integration configuration, Settings → Integrations shows Google as unavailable.
To enable it, configure these server-only secrets in the deployment secret manager:

- `GOOGLE_INTEGRATION_CLIENT_ID` and `GOOGLE_INTEGRATION_CLIENT_SECRET`: a Google
  OAuth **Web application** client.
- `INTEGRATION_TOKEN_KEYS`: a JSON object mapping key IDs to random 32-byte keys,
  encoded in standard base64. Use an independent key, not the authentication secret.
- `INTEGRATION_TOKEN_ACTIVE_KEY_ID`: the ID used for new ciphertext (default `v1`).
- `INTEGRATION_OAUTH_BASE_URL`: optional; defaults to the origin of
  `BETTER_AUTH_URL` and must match it exactly. HTTPS is required except localhost.

Generate key material on your own machine, then put it in a secret manager:

```sh
node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("base64"))'
```

Do not commit the output or paste it in logs. Example environment placeholders are
in `.env.example`. Configure Google's consent screen/test users as appropriate and
register the exact callback, e.g.
`http://localhost:3000/api/student/integrations/google/callback` locally or the same
path under the deployed HTTPS origin. Apply `npm run db:migrate` before deploying.

Manual check: sign in, visit Settings → Integrations, Connect Google, approve only
account identity access, and return to Settings. Verify the account email/status,
reconnect, then disconnect. To test cancellation, deny consent and return to the
fixed settings destination. Live consent requires real Google client credentials;
automated tests use mocked provider HTTP and browser consent, never live Google.

Keep the existing `npm run jobs:worker` running for hourly expired OAuth-session
cleanup in production. Starting a new flow also prunes that user's expired sessions.
There are no integration data-sync jobs in this phase.

## Models and ownership

`ConnectedAccount` stores encrypted credentials, provider subject ID, granted scopes,
connection status, refresh metadata and non-sensitive revocation failure metadata.
Uniqueness is `(userId, provider, providerAccountId)`, allowing multiple Google
accounts and safe reconnect without duplicates. Connection status is independent
of `IntegrationSyncState` (idle/syncing/completed/failed). Sync cursors are encrypted
and exposed only to trusted server-side sync callers. No sync logic is implemented.

`OAuthConnectionSession` stores only the state hash, authenticated-session hash,
encrypted PKCE verifier, requested scopes, approved destination, optional owned
reconnect target and ten-minute expiry. Used state cannot trigger a second exchange.
Expired sessions, including completed records, are periodically deleted. All three
models cascade on user/account deletion; no local orphan credentials remain.
Remote grants are not automatically revoked by a database user deletion; removing
all local credentials immediately prevents future access through this app.

Public account DTOs explicitly allow only ID/provider/display name/email/status,
friendly capabilities, connected/refreshed timestamps and a revocation-failure flag.
Plaintext tokens, ciphertext, provider subject IDs, state hashes and sync cursors
never enter these DTOs. APIs derive identity from the existing authenticated session,
use same-origin mutation checks and private no-store responses.

## OAuth and encryption security

Node/OpenSSL AES-256-GCM provides authenticated encryption with a fresh 96-bit nonce
and 128-bit tag. Authenticated context includes user, provider, record ID and token
purpose, preventing swapping credentials between users/records/access and refresh
fields. Ciphertexts include a format version and key ID. Keys remain outside the DB.
For key rotation, retain old key IDs while re-encrypting stored access/refresh tokens,
PKCE verifiers and sync cursors with the active key; remove old keys only after the
migration and outstanding session expiry. This phase supplies versioned encryption,
not an automatic key-rotation operation. Backups require the same key management.

Each authorization uses 256-bit random state and PKCE S256. State is bound to both
the user and the exact Better Auth session that started it. Callback handling claims
state and clears the verifier durably **before** exchange. An exchange/identity/
storage failure requires a new flow. A completed browser retry returns the same
safe result without re-exchange; a concurrent in-progress retry fails safely.

Google's HTTPS token and userinfo endpoints are fixed in the adapter. The stable
userinfo `sub` establishes identity; an email is display metadata, never an account
key. Unverified email is not displayed. Explicit reconnect must return the target
account identity. Only the actually granted token-response scopes are stored; a
partial consent does not silently claim missing permissions. PKCE is passed with
code exchange; the app never accepts an ID token without verification or uses an
unverified JWT to identify an account.

Post-OAuth destinations are an exact allowlist, currently `/student/settings`.
Callback pages render no provider content, carry `Referrer-Policy: no-referrer`,
and redirect with a fixed safe result code. Next's development request logger
excludes callback paths. **Production reverse proxies, load balancers and APM must
also omit callback query strings and redact authorization headers/request bodies.**
Application errors replace upstream bodies, messages, URLs and causes with static
codes/messages. Logs contain only event, provider, account ID and safe error code.

## Provider and capability contracts

`IntegrationProvider` owns authorization URL creation, code exchange, refresh,
identity, revoke, scope translation/validation and a bounded HTTP read boundary.
`IntegrationRegistry` holds adapters; only Google is registered. Microsoft is a
reserved provider identifier, not a functioning integration.

Capability mappings are centralized: account-profile, calendar-read, calendar-write,
drive-read and email-read. New connections in Settings request account identity
only. Future features can explicitly request an additional capability through the
same start flow. Reconnect retains known prior capabilities and includes the newly
requested ones in provider consent; permissions never expand in the background.
The Google events-read scope is used for calendar-read. No Drive/Gmail permissions
are requested for a calendar-only grant.

`withProviderClient({ userId, connectedAccountId, provider, capability }, operation)`
checks ownership, provider, connection state and permission before creating a read
client. Every read revalidates the token/capability and rechecks connection state
before returning a result. It permits only relative paths beneath fixed,
capability-specific HTTPS endpoints; no arbitrary URLs, headers or redirects.
Future write features require their own deliberate method/API implementation.

## Refresh, disconnect and races

`getValidAccessToken(userId, connectedAccountId, capability?, provider?)` is a
server-only entry point for trusted services and background jobs. It needs no
browser cookies; the job executor validates the owning user before dispatch.
Tokens refresh within 60 seconds of expiration. A short account transaction claims
a durable 15-second refresh lease, then releases its lock before the bounded
8-second HTTP request. Other processes wait at most 20 seconds and reuse the result.
Publishing requires the same lease and credential version; a reconnect or disconnect
fences a late result. Rotated refresh tokens are stored; omitted ones retain the latest value.

`invalid_grant` clears credentials and marks Needs Reconnect, with no indefinite
retry. Temporary failures mark Error with a one-minute retry cooldown. Refresh
state is committed before a safe error is raised. Missing capabilities fail before
feature HTTP calls. Scope loss during refresh is persisted and detected.

Disconnect can commit while a refresh is awaiting the provider. It atomically marks the
account revoked, clears both tokens and sync cursor, and invalidates pending OAuth
sessions. This commit happens **before** remote revocation. All later token access
is denied even if remote revocation fails. Already-issued external requests cannot
be undone; the client helper refuses to return their results after disconnect.
A brief revocation-in-progress guard prevents immediate reconnect/revoke races.
Repeated disconnect is harmless. Remote failure is recorded without retaining
usable tokens for retry; users can verify/revoke access in their provider account.

Provider 401 responses force one centralized refresh/retry; a second rejection stops
future calls until reconnect. Explicit missing-scope responses deny only that capability
until consent is renewed. Resource-level 403 responses do not invalidate unrelated
permissions. Google 429/quota errors retain a bounded Retry-After (30–3,600 seconds);
the capability cooldown is durable and applies to jobs and manual requests.
Malformed ciphertext requires reconnect. Missing key-store configuration preserves
encrypted credentials and cools down instead of destroying recoverable values.

See [integration hardening verification](integration-hardening.md) for health states,
failure coverage, client-boundary checks and production limitations.

Integration events are typed, allowlisted metadata notifications, not a new event
bus. The existing background error normalization handles reconnect/scope errors as
non-retryable and transient provider/database errors as retryable. OAuth cleanup
uses the existing queue registry, worker and scheduler.

## Verification and changed files

`tests/integrations.test.ts` exercises real database services with only the provider
HTTP boundary mocked: state/PKCE, encryption and key versions, callbacks and races,
multiple accounts/reconnect, refresh rotation/concurrency, scope gates, revocation,
cascade cleanup, sync metadata, job execution, redirect protection and zero AI calls.
`tests/browser/integrations.spec.ts` checks safe permission/status rendering,
connect/deny/reconnect, disconnect confirmation/persistence and mobile behavior.
The browser's consent endpoint is intercepted; no real Google account is used.
Existing background, scheduled refresh, notification settings and foundation tests
are directly affected and should remain green.

Files added or changed for this phase:

- `server/integrations/{config,encryption,errors,events,google,http,registry,service,types}.ts` and its `README.md`
- `lib/student/integrations/types.ts`
- `features/student/integrations/settings.tsx`, `app/student/settings/page.tsx`
- `app/api/student/integrations/route.ts`, `connect/route.ts`,
  `[provider]/callback/route.ts`, `accounts/[id]/route.ts` below that directory
- `prisma/schema.prisma`, `prisma/migrations/20260918050000_integration_oauth/migration.sql`
- `server/jobs/{cleanup-oauth,registry,schedule,worker,errors}.ts`
- `.env.example`, `next.config.ts`, `scripts/verify-migration.mjs`
- `tests/integrations.test.ts`, `tests/browser/integrations.spec.ts`
- `README.md`, `docs/integrations-oauth.md`

Protocol references: [Google web-server OAuth](https://developers.google.com/identity/protocols/oauth2/web-server),
[Google OpenID Connect reference](https://developers.google.com/identity/openid-connect/reference),
[OAuth security best current practice (RFC 9700)](https://www.rfc-editor.org/rfc/rfc9700.html).
