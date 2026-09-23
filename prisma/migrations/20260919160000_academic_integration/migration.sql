-- AlterTable
ALTER TABLE "ConnectedAccount" ADD COLUMN     "connectionConfig" JSONB;

-- AlterTable
ALTER TABLE "ExternalFileLink" ADD COLUMN     "externalCourseLinkId" TEXT;

-- CreateTable
CREATE TABLE "ExternalCourseLink" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "connectedAccountId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "options" JSONB NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "requestVersion" INTEGER NOT NULL DEFAULT 1,
    "requestQueuedAt" TIMESTAMP(3),
    "nextSyncAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "filesLastSyncedAt" TIMESTAMP(3),
    "filesRequested" BOOLEAN NOT NULL DEFAULT true,
    "externalEndsAt" TIMESTAMP(3),
    "lastResult" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExternalCourseLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExternalAssignmentLink" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "externalCourseLinkId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "assignmentId" TEXT NOT NULL,
    "lastExternalUpdatedAt" TIMESTAMP(3),
    "lastSyncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "externalUrl" TEXT,
    "syncStatus" TEXT NOT NULL DEFAULT 'SYNCED',

    CONSTRAINT "ExternalAssignmentLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExternalExamLink" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "externalCourseLinkId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "examId" TEXT NOT NULL,
    "lastExternalUpdatedAt" TIMESTAMP(3),
    "lastSyncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "externalUrl" TEXT,
    "syncStatus" TEXT NOT NULL DEFAULT 'SYNCED',

    CONSTRAINT "ExternalExamLink_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ExternalCourseLink_courseId_key" ON "ExternalCourseLink"("courseId");

-- CreateIndex
CREATE INDEX "ExternalCourseLink_active_nextSyncAt_idx" ON "ExternalCourseLink"("active", "nextSyncAt");

-- CreateIndex
CREATE INDEX "ExternalCourseLink_userId_idx" ON "ExternalCourseLink"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "ExternalCourseLink_id_userId_key" ON "ExternalCourseLink"("id", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "ExternalCourseLink_connectedAccountId_externalId_key" ON "ExternalCourseLink"("connectedAccountId", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "ExternalCourseLink_courseId_userId_key" ON "ExternalCourseLink"("courseId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "ExternalAssignmentLink_assignmentId_key" ON "ExternalAssignmentLink"("assignmentId");

-- CreateIndex
CREATE INDEX "ExternalAssignmentLink_userId_idx" ON "ExternalAssignmentLink"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "ExternalAssignmentLink_externalCourseLinkId_externalId_key" ON "ExternalAssignmentLink"("externalCourseLinkId", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "ExternalAssignmentLink_assignmentId_userId_key" ON "ExternalAssignmentLink"("assignmentId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "ExternalExamLink_examId_key" ON "ExternalExamLink"("examId");

-- CreateIndex
CREATE INDEX "ExternalExamLink_userId_idx" ON "ExternalExamLink"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "ExternalExamLink_externalCourseLinkId_externalId_key" ON "ExternalExamLink"("externalCourseLinkId", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "ExternalExamLink_examId_userId_key" ON "ExternalExamLink"("examId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "Assignment_id_userId_key" ON "Assignment"("id", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "Exam_id_userId_key" ON "Exam"("id", "userId");

-- CreateIndex
CREATE INDEX "ExternalFileLink_externalCourseLinkId_idx" ON "ExternalFileLink"("externalCourseLinkId");

-- AddForeignKey
ALTER TABLE "ExternalFileLink" ADD CONSTRAINT "ExternalFileLink_externalCourseLinkId_userId_fkey" FOREIGN KEY ("externalCourseLinkId", "userId") REFERENCES "ExternalCourseLink"("id", "userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExternalCourseLink" ADD CONSTRAINT "ExternalCourseLink_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExternalCourseLink" ADD CONSTRAINT "ExternalCourseLink_connectedAccountId_userId_fkey" FOREIGN KEY ("connectedAccountId", "userId") REFERENCES "ConnectedAccount"("id", "userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExternalCourseLink" ADD CONSTRAINT "ExternalCourseLink_courseId_userId_fkey" FOREIGN KEY ("courseId", "userId") REFERENCES "Course"("id", "userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExternalAssignmentLink" ADD CONSTRAINT "ExternalAssignmentLink_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExternalAssignmentLink" ADD CONSTRAINT "ExternalAssignmentLink_externalCourseLinkId_userId_fkey" FOREIGN KEY ("externalCourseLinkId", "userId") REFERENCES "ExternalCourseLink"("id", "userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExternalAssignmentLink" ADD CONSTRAINT "ExternalAssignmentLink_assignmentId_userId_fkey" FOREIGN KEY ("assignmentId", "userId") REFERENCES "Assignment"("id", "userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExternalExamLink" ADD CONSTRAINT "ExternalExamLink_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExternalExamLink" ADD CONSTRAINT "ExternalExamLink_externalCourseLinkId_userId_fkey" FOREIGN KEY ("externalCourseLinkId", "userId") REFERENCES "ExternalCourseLink"("id", "userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExternalExamLink" ADD CONSTRAINT "ExternalExamLink_examId_userId_fkey" FOREIGN KEY ("examId", "userId") REFERENCES "Exam"("id", "userId") ON DELETE CASCADE ON UPDATE CASCADE;

