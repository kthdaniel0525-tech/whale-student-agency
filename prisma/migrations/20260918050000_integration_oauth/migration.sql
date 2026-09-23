CREATE TYPE "ConnectedAccountStatus" AS ENUM ('ACTIVE', 'EXPIRED', 'REVOKED', 'ERROR');
CREATE TYPE "IntegrationSyncStatus" AS ENUM ('IDLE', 'SYNCING', 'COMPLETED', 'FAILED');
CREATE TABLE "ConnectedAccount" (
  "id" TEXT NOT NULL, "userId" TEXT NOT NULL, "provider" TEXT NOT NULL, "providerAccountId" TEXT NOT NULL,
  "displayName" TEXT, "email" TEXT, "status" "ConnectedAccountStatus" NOT NULL DEFAULT 'ACTIVE', "scopes" TEXT[],
  "accessTokenEncrypted" TEXT, "refreshTokenEncrypted" TEXT, "accessTokenExpiresAt" TIMESTAMP(3),
  "connectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "lastRefreshedAt" TIMESTAMP(3), "revokedAt" TIMESTAMP(3),
  "lastErrorCode" TEXT, "refreshRetryAfter" TIMESTAMP(3), "revocationPendingUntil" TIMESTAMP(3), "revocationErrorCode" TEXT,
  "credentialVersion" INTEGER NOT NULL DEFAULT 1, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ConnectedAccount_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ConnectedAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ConnectedAccount_userId_provider_providerAccountId_key" ON "ConnectedAccount"("userId", "provider", "providerAccountId");
CREATE INDEX "ConnectedAccount_userId_status_idx" ON "ConnectedAccount"("userId", "status");
CREATE TABLE "OAuthConnectionSession" (
  "id" TEXT NOT NULL, "userId" TEXT NOT NULL, "provider" TEXT NOT NULL, "stateHash" TEXT NOT NULL,
  "authenticationSessionHash" TEXT NOT NULL, "codeVerifierEncrypted" TEXT, "requestedScopes" TEXT[], "targetAccountId" TEXT,
  "redirectPath" TEXT NOT NULL, "expiresAt" TIMESTAMP(3) NOT NULL, "usedAt" TIMESTAMP(3), "completedAt" TIMESTAMP(3), "resultAccountId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OAuthConnectionSession_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "OAuthConnectionSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "OAuthConnectionSession_stateHash_key" ON "OAuthConnectionSession"("stateHash");
CREATE INDEX "OAuthConnectionSession_userId_idx" ON "OAuthConnectionSession"("userId");
CREATE INDEX "OAuthConnectionSession_expiresAt_idx" ON "OAuthConnectionSession"("expiresAt");
CREATE TABLE "IntegrationSyncState" (
  "id" TEXT NOT NULL, "connectedAccountId" TEXT NOT NULL, "integrationType" TEXT NOT NULL, "cursorEncrypted" TEXT,
  "lastSyncStartedAt" TIMESTAMP(3), "lastSyncCompletedAt" TIMESTAMP(3), "lastSuccessfulSyncAt" TIMESTAMP(3),
  "status" "IntegrationSyncStatus" NOT NULL DEFAULT 'IDLE', "lastErrorCode" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "IntegrationSyncState_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "IntegrationSyncState_connectedAccountId_fkey" FOREIGN KEY ("connectedAccountId") REFERENCES "ConnectedAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "IntegrationSyncState_connectedAccountId_integrationType_key" ON "IntegrationSyncState"("connectedAccountId", "integrationType");
