CREATE EXTENSION IF NOT EXISTS vector;

-- CreateEnum
CREATE TYPE "DocumentStatus" AS ENUM ('UPLOADED', 'PROCESSING', 'READY', 'FAILED');

-- CreateTable
CREATE TABLE "Document" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "courseId" TEXT,
    "title" TEXT NOT NULL,
    "originalFileName" TEXT NOT NULL,
    "fileType" TEXT NOT NULL,
    "fileSize" INTEGER NOT NULL,
    "storageKey" TEXT NOT NULL,
    "processingStatus" "DocumentStatus" NOT NULL DEFAULT 'UPLOADED',
    "processingError" TEXT,
    "pageCount" INTEGER,
    "embeddingModel" TEXT,
    "uploadedAt" TIMESTAMP(3),
    "leaseToken" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentChunk" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "courseId" TEXT,
    "chunkIndex" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "pageNumber" INTEGER,
    "pageEnd" INTEGER,
    "tokenCount" INTEGER NOT NULL,
    "embedding" vector(384) NOT NULL,
    "embeddingModel" TEXT NOT NULL,
    "metadata" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DocumentChunk_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentPage" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "pageNumber" INTEGER NOT NULL,
    "content" TEXT NOT NULL,

    CONSTRAINT "DocumentPage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FileDeletion" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "retryAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FileDeletion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Document_storageKey_key" ON "Document"("storageKey");

-- CreateIndex
CREATE INDEX "Document_userId_courseId_createdAt_idx" ON "Document"("userId", "courseId", "createdAt");

-- CreateIndex
CREATE INDEX "Document_processingStatus_leaseExpiresAt_idx" ON "Document"("processingStatus", "leaseExpiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "Document_id_userId_key" ON "Document"("id", "userId");

-- CreateIndex
CREATE INDEX "DocumentChunk_userId_courseId_idx" ON "DocumentChunk"("userId", "courseId");

-- CreateIndex
CREATE INDEX "DocumentChunk_documentId_userId_idx" ON "DocumentChunk"("documentId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentChunk_documentId_chunkIndex_key" ON "DocumentChunk"("documentId", "chunkIndex");

-- CreateIndex
CREATE INDEX "DocumentPage_userId_documentId_idx" ON "DocumentPage"("userId", "documentId");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentPage_documentId_pageNumber_key" ON "DocumentPage"("documentId", "pageNumber");

-- CreateIndex
CREATE UNIQUE INDEX "FileDeletion_storageKey_key" ON "FileDeletion"("storageKey");

-- CreateIndex
CREATE INDEX "FileDeletion_retryAt_idx" ON "FileDeletion"("retryAt");

-- CreateIndex
CREATE INDEX "FileDeletion_userId_idx" ON "FileDeletion"("userId");

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_courseId_userId_fkey" FOREIGN KEY ("courseId", "userId") REFERENCES "Course"("id", "userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentChunk" ADD CONSTRAINT "DocumentChunk_documentId_userId_fkey" FOREIGN KEY ("documentId", "userId") REFERENCES "Document"("id", "userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentChunk" ADD CONSTRAINT "DocumentChunk_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentPage" ADD CONSTRAINT "DocumentPage_documentId_userId_fkey" FOREIGN KEY ("documentId", "userId") REFERENCES "Document"("id", "userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentPage" ADD CONSTRAINT "DocumentPage_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A durable outbox survives every cascade, including course and account deletion.
CREATE FUNCTION enqueue_document_file_deletion() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO "FileDeletion" (id,"userId","storageKey")
  VALUES (gen_random_uuid()::text,OLD."userId",OLD."storageKey")
  ON CONFLICT ("storageKey") DO NOTHING;
  RETURN OLD;
END;
$$;
CREATE TRIGGER document_file_cleanup BEFORE DELETE ON "Document"
FOR EACH ROW EXECUTE FUNCTION enqueue_document_file_deletion();
ALTER TABLE "Document" ADD CONSTRAINT "Document_fileSize_check" CHECK ("fileSize" > 0 AND "fileSize" <= 10485760);
ALTER TABLE "DocumentChunk" ADD CONSTRAINT "DocumentChunk_tokenCount_check" CHECK ("tokenCount" > 0);
