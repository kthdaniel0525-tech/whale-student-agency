-- AlterTable
ALTER TABLE "StudyTask" ADD COLUMN     "scheduledEnd" TIMESTAMP(3),
ADD COLUMN     "scheduledStart" TIMESTAMP(3),
ADD COLUMN     "scheduledTimezone" TEXT;

-- AlterTable
ALTER TABLE "IntegrationSyncState" ADD COLUMN     "leaseToken" TEXT,
ADD COLUMN     "leaseUntil" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "CalendarIntegrationPreference" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "connectedAccountId" TEXT NOT NULL,
    "externalCalendarId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "timezone" TEXT NOT NULL,
    "enabledForAvailability" BOOLEAN NOT NULL DEFAULT false,
    "allowStudyWrites" BOOLEAN NOT NULL DEFAULT false,
    "blockAllDay" BOOLEAN NOT NULL DEFAULT false,
    "busyEvents" JSONB NOT NULL DEFAULT '[]',
    "windowStart" TIMESTAMP(3),
    "windowEnd" TIMESTAMP(3),
    "revision" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CalendarIntegrationPreference_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExternalEventLink" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'google',
    "connectedAccountId" TEXT NOT NULL,
    "externalCalendarId" TEXT NOT NULL,
    "externalEventId" TEXT NOT NULL,
    "studyTaskId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "syncedStart" TIMESTAMP(3),
    "syncedEnd" TIMESTAMP(3),
    "taskRevision" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExternalEventLink_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CalendarIntegrationPreference_userId_enabledForAvailability_idx" ON "CalendarIntegrationPreference"("userId", "enabledForAvailability");

-- CreateIndex
CREATE UNIQUE INDEX "CalendarIntegrationPreference_connectedAccountId_externalCa_key" ON "CalendarIntegrationPreference"("connectedAccountId", "externalCalendarId");

-- CreateIndex
CREATE INDEX "ExternalEventLink_userId_studyTaskId_idx" ON "ExternalEventLink"("userId", "studyTaskId");

-- CreateIndex
CREATE UNIQUE INDEX "ExternalEventLink_studyTaskId_connectedAccountId_externalCa_key" ON "ExternalEventLink"("studyTaskId", "connectedAccountId", "externalCalendarId");

-- CreateIndex
CREATE UNIQUE INDEX "ExternalEventLink_connectedAccountId_externalCalendarId_ext_key" ON "ExternalEventLink"("connectedAccountId", "externalCalendarId", "externalEventId");

-- CreateIndex
CREATE UNIQUE INDEX "StudyTask_id_userId_key" ON "StudyTask"("id", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "ConnectedAccount_id_userId_key" ON "ConnectedAccount"("id", "userId");

-- AddForeignKey
ALTER TABLE "CalendarIntegrationPreference" ADD CONSTRAINT "CalendarIntegrationPreference_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CalendarIntegrationPreference" ADD CONSTRAINT "CalendarIntegrationPreference_connectedAccountId_userId_fkey" FOREIGN KEY ("connectedAccountId", "userId") REFERENCES "ConnectedAccount"("id", "userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExternalEventLink" ADD CONSTRAINT "ExternalEventLink_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExternalEventLink" ADD CONSTRAINT "ExternalEventLink_connectedAccountId_userId_fkey" FOREIGN KEY ("connectedAccountId", "userId") REFERENCES "ConnectedAccount"("id", "userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExternalEventLink" ADD CONSTRAINT "ExternalEventLink_studyTaskId_userId_fkey" FOREIGN KEY ("studyTaskId", "userId") REFERENCES "StudyTask"("id", "userId") ON DELETE CASCADE ON UPDATE CASCADE;

