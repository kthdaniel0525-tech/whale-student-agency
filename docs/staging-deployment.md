# First hosted staging deployment

This runbook prepares a fresh Ubuntu host for the repository's existing single-host staging topology. It does not deploy production, enable optional providers, or place any secret in Git. Commands assume an operator account with `sudo`, a staging DNS name, and a reviewed immutable application image in GHCR.

The deployment is Caddy → Next.js web/API, with PostgreSQL 17.11 + pgvector 0.8.2, a pg-boss jobs worker, a document worker, and persistent Docker volumes. The long-running container memory ceilings total 8.25 GiB before Ubuntu, Docker, release jobs, and replacement overlap. Select and load-test a host with headroom above that amount; an 8 GB host is not sufficient for the configured worst case.

## 1. Manual prerequisites

Before running commands, obtain:

- a persistent Ubuntu host with encrypted storage and a public IP;
- a staging DNS name whose A/AAAA record points only to this host;
- an operations email for ACME certificate notices;
- a GitHub account or machine account with read access to the GHCR package;
- a reviewed `ghcr.io/OWNER/REPOSITORY@sha256:...` image digest;
- a staging-only OpenAI key with provider-side spend limits;
- a Sentry Node.js/Next.js project and its DSN;
- exact beta tester email addresses;
- an off-host backup destination and an age encryption recipient;
- a named operator who receives uptime, Sentry, disk, backup, and certificate alerts.

Google OAuth, LMS, Career, Stripe, production customer data, and optional AI response evaluation remain disabled.

## 2. Install host prerequisites

These commands use Docker's official Ubuntu repository and Node.js 24 for the checked-in release script.

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl gnupg git jq openssl acl age ufw

sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
. /etc/os-release
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${UBUNTU_CODENAME:-$VERSION_CODENAME} stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo usermod -aG docker "$USER"

curl -fsSL https://deb.nodesource.com/setup_24.x -o /tmp/nodesource-setup.sh
sudo -E bash /tmp/nodesource-setup.sh
rm -f /tmp/nodesource-setup.sh
sudo apt-get install -y nodejs

sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
```

Log out and back in so Docker group membership takes effect. Then verify:

```bash
docker version
docker compose version
node --version
npm --version
sudo ufw status verbose
```

Do not open PostgreSQL 5432, Next.js 3000, or worker ports in the host firewall or cloud security group.

## 3. Create the server layout

```text
/opt/student-ai-agency/
├── app/                         # repository checkout
├── config/
│   └── compose.env              # public deployment metadata
├── secrets/                     # never committed; restricted permissions
│   ├── runtime.env              # agency_app runtime credential
│   ├── migration.env            # agency_owner migration credential
│   ├── plans.json
│   ├── db-owner-password
│   └── db-app-password
└── backups/
    ├── work/                     # short-lived plaintext backup workspace
    ├── export/                   # encrypted archives awaiting off-host copy
    └── restore/                  # short-lived isolated restore workspace
```

Create it and clone the isolated repository. For a private repository, use a read-only SSH deploy key or an authenticated Git credential helper; never place a token in the clone URL.

```bash
sudo install -d -o "$USER" -g "$USER" -m 0750 \
  /opt/student-ai-agency \
  /opt/student-ai-agency/app \
  /opt/student-ai-agency/config \
  /opt/student-ai-agency/backups \
  /opt/student-ai-agency/backups/work \
  /opt/student-ai-agency/backups/export \
  /opt/student-ai-agency/backups/restore
sudo install -d -o "$USER" -g "$USER" -m 0700 /opt/student-ai-agency/secrets

git clone https://github.com/kthdaniel0525-tech/student-personal-ai-agency.git /opt/student-ai-agency/app
cd /opt/student-ai-agency/app
git switch main
git pull --ff-only origin main
npm run install:ci
```

Record the reviewed checkout before deployment:

```bash
git status --short --branch
git rev-parse HEAD
```

## 4. Create staging configuration and secrets

Copy the tracked templates and plan catalog outside the checkout:

```bash
cd /opt/student-ai-agency/app
cp deploy/staging/compose.env.example /opt/student-ai-agency/config/compose.env
cp deploy/staging/runtime.env.example /opt/student-ai-agency/secrets/runtime.env
cp deploy/plans.example.json /opt/student-ai-agency/secrets/plans.json
chmod 0600 /opt/student-ai-agency/config/compose.env /opt/student-ai-agency/secrets/runtime.env
chmod 0640 /opt/student-ai-agency/secrets/plans.json
```

Generate independent database credentials without printing them:

```bash
umask 077
openssl rand -hex 32 > /opt/student-ai-agency/secrets/db-owner-password
openssl rand -hex 32 > /opt/student-ai-agency/secrets/db-app-password
```

Generate Better Auth and operations secrets into shell variables, collect provider values without echo, and replace the exact placeholders in `runtime.env`. The generated database passwords are hexadecimal and therefore safe inside a PostgreSQL URL.

```bash
BETTER_AUTH_SECRET="$(openssl rand -base64 48 | tr -d '\n')"
OPERATIONS_TOKEN="$(openssl rand -hex 32)"
read -rsp 'Staging OpenAI key: ' OPENAI_API_KEY; echo
read -rsp 'Sentry DSN: ' SENTRY_DSN; echo
export BETTER_AUTH_SECRET OPERATIONS_TOKEN OPENAI_API_KEY SENTRY_DSN

python3 - <<'PY'
import os
from pathlib import Path

root = Path('/opt/student-ai-agency/secrets')
path = root / 'runtime.env'
text = path.read_text()
replacements = {
    'REPLACE_WITH_RANDOM_48_BYTE_SECRET': os.environ['BETTER_AUTH_SECRET'],
    'REPLACE_WITH_APP_DATABASE_PASSWORD': (root / 'db-app-password').read_text().strip(),
    'REPLACE_WITH_RANDOM_32_BYTE_TOKEN': os.environ['OPERATIONS_TOKEN'],
    'REPLACE_WITH_STAGING_OPENAI_API_KEY': os.environ['OPENAI_API_KEY'],
    'https://REPLACE_PUBLIC_KEY@REPLACE_INGEST_HOST/REPLACE_PROJECT_ID': os.environ['SENTRY_DSN'],
}
for old, new in replacements.items():
    if old not in text:
        raise SystemExit(f'Missing expected placeholder: {old}')
    text = text.replace(old, new)
path.write_text(text)
PY

unset BETTER_AUTH_SECRET OPERATIONS_TOKEN OPENAI_API_KEY SENTRY_DSN
chmod 0600 /opt/student-ai-agency/secrets/runtime.env
```

Edit only the non-generated placeholders in these two files:

```bash
nano /opt/student-ai-agency/config/compose.env
nano /opt/student-ai-agency/secrets/runtime.env
```

Required edits:

- set the same staging hostname in `APP_DOMAIN`, `APP_URL`, and `BETTER_AUTH_URL`;
- set `ACME_EMAIL`;
- set the immutable `APP_IMAGE` digest;
- replace `SIGNUP_EMAIL_ALLOWLIST` with exact beta emails;
- optionally set beta administrator/internal user IDs after those users exist;
- review `plans.json` allowances; do not enable disabled provider features.

Create `migration.env` from the completed runtime file and change only its database role/password without printing the password:

```bash
cp /opt/student-ai-agency/secrets/runtime.env /opt/student-ai-agency/secrets/migration.env
export DB_OWNER_PASSWORD="$(cat /opt/student-ai-agency/secrets/db-owner-password)"
python3 - <<'PY'
import os, re
from pathlib import Path
path = Path('/opt/student-ai-agency/secrets/migration.env')
text = path.read_text()
text, count = re.subn(
    r'^DATABASE_URL=.*$',
    f'DATABASE_URL=postgresql://agency_owner:{os.environ["DB_OWNER_PASSWORD"]}@postgres:5432/agency',
    text,
    count=1,
    flags=re.MULTILINE,
)
if count != 1:
    raise SystemExit('DATABASE_URL was not found exactly once')
path.write_text(text)
PY
unset DB_OWNER_PASSWORD
chmod 0600 /opt/student-ai-agency/secrets/migration.env
```

The app image runs as UID 1000. Give that UID read access only to the three mounted application secret files; database password files remain readable by the PostgreSQL entrypoint through Docker.

```bash
setfacl -m u:1000:--x /opt/student-ai-agency/secrets
setfacl -m u:1000:r-- /opt/student-ai-agency/secrets/runtime.env
setfacl -m u:1000:r-- /opt/student-ai-agency/secrets/migration.env
setfacl -m u:1000:r-- /opt/student-ai-agency/secrets/plans.json
```

Check for unresolved placeholders by reporting only file names and line numbers, never values:

```bash
grep -nE 'REPLACE_|example\.com|OWNER/REPOSITORY' \
  /opt/student-ai-agency/config/compose.env \
  /opt/student-ai-agency/secrets/runtime.env \
  /opt/student-ai-agency/secrets/migration.env
```

This command must return no lines. Do not print the completed environment files.

No application integration-encryption secret is required while Google integrations are disabled. If Google is enabled later, create an independent AES key without printing it and configure the documented key ring:

```bash
INTEGRATION_KEY_V1="$(openssl rand -base64 32 | tr -d '\n')"
# Store as INTEGRATION_TOKEN_KEYS={"v1":"<value>"} in the secret manager.
unset INTEGRATION_KEY_V1
```

Do not reuse the Better Auth secret for integration encryption.

## 5. Database roles

The repository defines exactly two roles:

- `agency_owner`: PostgreSQL initialization, schema owner, Prisma migration role. `migration.env` uses this credential.
- `agency_app`: restricted runtime role created by `docker/init-runtime-role.sql` with `NOSUPERUSER`, `NOCREATEDB`, and `NOCREATEROLE`. `runtime.env` uses this credential. It receives CRUD/sequence access to application tables and can own the separate pg-boss schema.

`docker/init-runtime-role.sql` runs only when the PostgreSQL volume is empty. Restarting the container does not recreate or rotate either role.

## 6. Authenticate to GHCR and pin the image

Create a dedicated GitHub machine account or token with package read access only. Grant that identity read access to the package. Do not grant package write/delete permissions.

Log in without placing the token in shell history:

```bash
read -rsp 'GHCR read-only token: ' GHCR_TOKEN; echo
printf '%s' "$GHCR_TOKEN" | docker login ghcr.io -u GITHUB_USERNAME --password-stdin
unset GHCR_TOKEN
```

Use the full commit SHA tag produced by `.github/workflows/release.yml`, pull it, and read its immutable repository digest:

```bash
IMAGE_TAG=ghcr.io/OWNER/REPOSITORY:FULL_GIT_SHA
docker pull "$IMAGE_TAG"
docker image inspect "$IMAGE_TAG" --format '{{index .RepoDigests 0}}'
```

Copy the returned `ghcr.io/OWNER/REPOSITORY@sha256:...` value into `APP_IMAGE` in `config/compose.env`. Confirm it contains a 64-character lowercase SHA-256 digest. Never deploy `latest` or a branch tag.

## 7. Validate and perform the first deployment

The existing release script performs the repository-supported order: validate configuration, run deterministic fast AI checks, start PostgreSQL, initialize volume permissions, run Prisma migrations, bootstrap plans/queues, preload the pinned embedding model, and start web/jobs/documents/Caddy.

```bash
cd /opt/student-ai-agency/app
IMAGE="$(sed -n 's/^APP_IMAGE=//p' /opt/student-ai-agency/config/compose.env)"
node scripts/deploy-release.mjs check /opt/student-ai-agency/config/compose.env "$IMAGE"
```

Review the check output. When the operator deliberately starts the first staging deployment, run:

```bash
node scripts/deploy-release.mjs deploy /opt/student-ai-agency/config/compose.env "$IMAGE"
unset IMAGE
```

Do not use the GitHub `Release containers` workflow for a staging-only trial unless the production GitHub Environment has an effective required-reviewer gate: that workflow proceeds from staging toward production.

For reference, the migration container executes `scripts/production-migrate.ts`, which runs `prisma migrate deploy` under `agency_owner` and then grants the restricted `agency_app` role its runtime permissions. Do not substitute `prisma migrate dev` on the server.

## 8. Verify health and workers

Set two non-secret helpers:

```bash
cd /opt/student-ai-agency/app
COMPOSE='docker compose --env-file /opt/student-ai-agency/config/compose.env -f compose.production.yaml'
STAGING_ORIGIN="https://$(sed -n 's/^APP_DOMAIN=//p' /opt/student-ai-agency/config/compose.env)"
```

Container state:

```bash
$COMPOSE ps
$COMPOSE ps --format json | jq -r '[.Service,.State,.Health] | @tsv'
```

The repository does not expose `/health`; its exact endpoints are:

```bash
curl -fsS "$STAGING_ORIGIN/api/health/live" | jq -e '.status == "alive"'
curl -fsS "$STAGING_ORIGIN/api/health/ready" | jq -e '.status == "ready"'
```

Database and pgvector:

```bash
$COMPOSE exec -T postgres pg_isready -U agency_owner -d agency
$COMPOSE exec -T postgres psql -U agency_owner -d agency -Atc \
  "SELECT current_database(), extversion FROM pg_extension WHERE extname='vector';"
```

Expected database is `agency` and expected vector version is `0.8.2`.

Worker health uses durable database heartbeats. Query the protected metrics endpoint without exposing the operations token:

```bash
read -rsp 'Operations token: ' OPERATIONS_TOKEN; echo
curl -fsS -H "Authorization: Bearer $OPERATIONS_TOKEN" \
  "$STAGING_ORIGIN/api/operations/metrics" \
  | jq '{workers, queues}'
unset OPERATIONS_TOKEN
```

Both `jobs` and `documents` must have at least one healthy instance, and at least one queue must be present. Missing authorization intentionally returns 404.

Inspect only bounded recent logs when a check fails:

```bash
$COMPOSE logs --tail=100 web
$COMPOSE logs --tail=100 jobs
$COMPOSE logs --tail=100 documents
$COMPOSE logs --tail=100 postgres
```

Run the repository's read-only deployment smoke:

```bash
read -rsp 'Operations token: ' OPERATIONS_TOKEN; echo
SMOKE_ORIGIN="$STAGING_ORIGIN" OPERATIONS_TOKEN="$OPERATIONS_TOKEN" npm run ops:smoke
unset OPERATIONS_TOKEN
```

Configure an external uptime monitor to send `GET https://STAGING_DOMAIN/api/health/ready` every 1–5 minutes, accept only HTTP 200, use a 10-second timeout, and alert the named operator after consecutive failures. Optionally monitor `/api/health/live` separately to distinguish process health from database/storage readiness.

## 9. Hosted functional smoke checklist

Use one synthetic allowlisted staging account. Never copy production users, courses, documents, prompts, or billing data.

1. Visit `/sign-up`, create the synthetic account, and confirm a non-allowlisted address is rejected.
2. Complete `/onboarding`; sign out and back in to confirm secure session persistence.
3. Create one synthetic course and verify it remains after refresh.
4. Create one assignment and one exam with a near-future date.
5. Upload a non-sensitive test PDF under `/student/documents`; confirm processing reaches the completed state.
6. Open the processed document and perform a RAG query; verify the answer cites/reuses the test document rather than unrelated data.
7. Ask Tutor for an explanation grounded in the synthetic course/document.
8. Generate and complete a Quiz; verify answers and score persist.
9. Open `/student/progress`; verify the quiz updated topic mastery/confidence/trend.
10. Create a Study Plan; mark one task complete and verify it stays complete after refresh.
11. Create or update the exam/course state that emits an academic event; verify a recommendation appears. The manual trigger script is intentionally disabled in deployed `NODE_ENV=production`, including staging.
12. Configure reminder preferences and a due-soon synthetic exam/assignment; verify the jobs worker creates a Reminder.
13. Wait for the notification sweep (default every five minutes); verify an In-App Notification appears and can be marked read.
14. Re-run protected operations metrics; verify worker heartbeats, queue activity, and no growing failed/dead-letter count.
15. Check Sentry for the `staging` environment and confirm no unexpected server error was recorded during the journey.

Record UTC timestamps, image digest, release SHA, synthetic account ID, passed steps, safe failure codes, and reviewer. Do not record prompts, document contents, cookies, API keys, or raw provider responses.

## 10. Minimal Sentry setup

1. Create a Sentry project for Node.js or Next.js dedicated to staging.
2. Copy its HTTPS DSN into `SENTRY_DSN` in `runtime.env` and `migration.env`.
3. Keep `ERROR_MONITORING_ENABLED=true`.
4. Route new staging error alerts to the named operator.
5. Do not enable session replay, request bodies, PII, tracing, or advanced integrations for the first deployment. The application already defaults to no PII, no breadcrumbs, no tracing, and a redacted exception boundary.

## 11. Manual encrypted backup

This section defines a manual staging backup procedure; it does not create a scheduled backup service. Choose an off-host SSH destination and an age recipient before relying on it. Back up before upgrades and at least daily until automation is configured.

Use a short maintenance window so database rows and document bytes share a recovery point:

```bash
cd /opt/student-ai-agency/app
COMPOSE='docker compose --env-file /opt/student-ai-agency/config/compose.env -f compose.production.yaml'
BACKUP_ID="$(date -u +%Y%m%dT%H%M%SZ)"
PROJECT="$(sed -n 's/^COMPOSE_PROJECT_NAME=//p' /opt/student-ai-agency/config/compose.env)"
mkdir -p "/opt/student-ai-agency/backups/work/$BACKUP_ID"

$COMPOSE stop proxy web jobs documents
$COMPOSE exec -T postgres pg_dump -U agency_owner -d agency \
  --format=custom --no-owner --no-acl \
  > "/opt/student-ai-agency/backups/work/$BACKUP_ID/agency.dump"

docker run --rm \
  -v "${PROJECT}_documents:/source:ro" \
  -v "/opt/student-ai-agency/backups/work/$BACKUP_ID:/backup" \
  alpine:3.21 sh -c 'tar -C /source -czf /backup/documents.tar.gz .'

git -C /opt/student-ai-agency/app rev-parse HEAD \
  > "/opt/student-ai-agency/backups/work/$BACKUP_ID/release-sha.txt"
sed -n 's/^APP_IMAGE=//p' /opt/student-ai-agency/config/compose.env \
  > "/opt/student-ai-agency/backups/work/$BACKUP_ID/image-digest.txt"
(cd "/opt/student-ai-agency/backups/work/$BACKUP_ID" && \
  sha256sum agency.dump documents.tar.gz release-sha.txt image-digest.txt > SHA256SUMS)

$COMPOSE up -d --wait --wait-timeout 180 web jobs documents proxy
```

If any backup step fails before the final `up`, immediately run that final `up` command to restore staging service, then investigate the incomplete backup. Verify the two plaintext artifacts before encryption:

```bash
pg_restore --list "/opt/student-ai-agency/backups/work/$BACKUP_ID/agency.dump" >/dev/null
tar -tzf "/opt/student-ai-agency/backups/work/$BACKUP_ID/documents.tar.gz" >/dev/null
```

Encrypt the complete set. `BACKUP_AGE_RECIPIENT` is the public age recipient and is safe to pass as an environment variable:

```bash
read -rp 'age recipient (age1...): ' BACKUP_AGE_RECIPIENT
tar -C /opt/student-ai-agency/backups/work -cf - "$BACKUP_ID" \
  | age -r "$BACKUP_AGE_RECIPIENT" \
      -o "/opt/student-ai-agency/backups/export/staging-$BACKUP_ID.tar.age"
unset BACKUP_AGE_RECIPIENT
(cd /opt/student-ai-agency/backups/export && \
  sha256sum "staging-$BACKUP_ID.tar.age" > "staging-$BACKUP_ID.tar.age.sha256")
rm -rf "/opt/student-ai-agency/backups/work/$BACKUP_ID"
```

Copy the encrypted file off-host using the approved backup identity, then verify the remote checksum/listing. Replace the destination placeholder:

```bash
scp "/opt/student-ai-agency/backups/export/staging-$BACKUP_ID.tar.age" \
  "/opt/student-ai-agency/backups/export/staging-$BACKUP_ID.tar.age.sha256" \
  backup-user@backup.example:/encrypted/student-ai-agency/staging/
ssh backup-user@backup.example \
  "cd /encrypted/student-ai-agency/staging && sha256sum -c staging-$BACKUP_ID.tar.age.sha256"
unset BACKUP_ID PROJECT COMPOSE
```

A local Docker volume and a local encrypted file are not backups until the artifact is verified off-host.

## 12. Isolated restore drill

Never restore over active staging. On an isolated host or isolated Compose project with outbound AI/OAuth/billing disabled:

```bash
mkdir -p /opt/student-ai-agency/backups/restore
age -d -i /secure/path/to/age-identity.txt \
  -o /opt/student-ai-agency/backups/restore/backup.tar \
  /path/to/staging-TIMESTAMP.tar.age
tar -C /opt/student-ai-agency/backups/restore -xf \
  /opt/student-ai-agency/backups/restore/backup.tar
(cd /opt/student-ai-agency/backups/restore/TIMESTAMP && sha256sum -c SHA256SUMS)
```

Create an isolated compose file by copying `config/compose.env`, then change at least `COMPOSE_PROJECT_NAME`, `APP_DOMAIN`, and `DEPLOY_SECRETS_DIR`. Restore credentials from the separately controlled secret store; secrets are intentionally absent from backup archives. Use fresh isolated database passwords. In the isolated `runtime.env` and `migration.env`, set `BACKGROUND_JOB_SCHEDULE_ENABLED=false`, `BILLING_ENABLED=false`, keep all integrations disabled, and set `AI_GUARDRAILS_JSON={"disableAllAI":true}`.

Start only the isolated database and restore the dump:

```bash
cd /opt/student-ai-agency/app
RESTORE_CONFIG=/opt/student-ai-agency/restore/config/compose.env
RESTORE_COMPOSE="docker compose --env-file $RESTORE_CONFIG -f compose.production.yaml"
RESTORE_PROJECT="$(sed -n 's/^COMPOSE_PROJECT_NAME=//p' "$RESTORE_CONFIG")"
$RESTORE_COMPOSE up -d --wait postgres
$RESTORE_COMPOSE exec -T postgres pg_restore -U agency_owner -d agency \
  --clean --if-exists --no-owner --no-acl \
  < /opt/student-ai-agency/backups/restore/TIMESTAMP/agency.dump

docker run --rm -i \
  -v "${RESTORE_PROJECT}_documents:/target" \
  alpine:3.21 sh -c 'tar -C /target -xzf -' \
  < /opt/student-ai-agency/backups/restore/TIMESTAMP/documents.tar.gz
```

Apply volume ownership and the recorded compatible image's release jobs, then start only web. Do not start Caddy or either worker:

```bash
$RESTORE_COMPOSE run --rm volumes-init
$RESTORE_COMPOSE run --rm migrate
$RESTORE_COMPOSE run --rm bootstrap
$RESTORE_COMPOSE run --rm embeddings
$RESTORE_COMPOSE up -d --wait --wait-timeout 180 web
$RESTORE_COMPOSE exec -T web node -e \
  "fetch('http://127.0.0.1:3000/api/health/ready').then(async r=>{console.log(await r.text());process.exit(r.ok?0:1)})"
```

Keep workers stopped until deletion/revocation decisions newer than the backup have been reconciled. Verify database rows, pgvector version, representative private documents and vectors, ownership enforcement, and cross-user denial through an isolated test path. Record measured restore time; then destroy the isolated restore project and decrypted work area under the approved retention policy.

## 13. Restart and persistence test

After the functional smoke test, record one course ID, document ID, completed study task, and workflow ID. Restart by removing containers without volumes:

```bash
cd /opt/student-ai-agency/app
COMPOSE='docker compose --env-file /opt/student-ai-agency/config/compose.env -f compose.production.yaml'
$COMPOSE down
$COMPOSE up -d --wait --wait-timeout 180 postgres web jobs documents proxy
```

Never add `-v`. Verify:

- the same user can sign in;
- the course, exam, quiz progress, study task, and workflow state remain;
- the uploaded document downloads and RAG retrieval still work;
- both worker heartbeats become healthy again within 90 seconds;
- pg-boss schedules are not duplicated and pending/retry jobs resume;
- `/api/health/ready` returns 200.

## 14. Safety boundaries

- Never enable production billing or production Google credentials in staging.
- Never copy production customer data into staging.
- Never expose PostgreSQL, Next.js, or workers directly to the internet.
- Never commit `config/compose.env`, runtime/migration files, password files, API keys, cookies, backup identities, or decrypted backups.
- Never run `docker compose down -v` on a retained environment.
- Never deploy a mutable image tag.
- Never use `prisma migrate dev` on the hosted database.
- Never run the production stage of the release workflow as part of a staging-only trial.
