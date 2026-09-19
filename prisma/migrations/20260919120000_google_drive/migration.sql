-- CreateTable
CREATE TABLE "ExternalFileLink" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "documentId" TEXT,
    "provider" TEXT NOT NULL,
    "connectedAccountId" TEXT NOT NULL,
    "externalFileId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "externalMimeType" TEXT NOT NULL,
    "externalModifiedAt" TIMESTAMP(3),
    "importedAt" TIMESTAMP(3),
    "lastCheckedAt" TIMESTAMP(3),
    "webViewLink" TEXT,
    "syncStatus" TEXT NOT NULL DEFAULT 'PENDING',
    "errorCode" TEXT,
    "requestVersion" INTEGER NOT NULL DEFAULT 1,
    "leaseToken" TEXT,
    "leaseUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExternalFileLink_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ExternalFileLink_documentId_key" ON "ExternalFileLink"("documentId");

-- CreateIndex
CREATE INDEX "ExternalFileLink_userId_courseId_createdAt_idx" ON "ExternalFileLink"("userId", "courseId", "createdAt");

-- CreateIndex
CREATE INDEX "ExternalFileLink_syncStatus_leaseUntil_idx" ON "ExternalFileLink"("syncStatus", "leaseUntil");

-- CreateIndex
CREATE UNIQUE INDEX "ExternalFileLink_connectedAccountId_externalFileId_courseId_key" ON "ExternalFileLink"("connectedAccountId", "externalFileId", "courseId");

-- CreateIndex
CREATE UNIQUE INDEX "ExternalFileLink_documentId_userId_key" ON "ExternalFileLink"("documentId", "userId");

-- AddForeignKey
ALTER TABLE "ExternalFileLink" ADD CONSTRAINT "ExternalFileLink_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExternalFileLink" ADD CONSTRAINT "ExternalFileLink_courseId_userId_fkey" FOREIGN KEY ("courseId", "userId") REFERENCES "Course"("id", "userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExternalFileLink" ADD CONSTRAINT "ExternalFileLink_documentId_userId_fkey" FOREIGN KEY ("documentId", "userId") REFERENCES "Document"("id", "userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExternalFileLink" ADD CONSTRAINT "ExternalFileLink_connectedAccountId_userId_fkey" FOREIGN KEY ("connectedAccountId", "userId") REFERENCES "ConnectedAccount"("id", "userId") ON DELETE CASCADE ON UPDATE CASCADE;

