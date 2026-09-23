CREATE TYPE "MemoryCategory" AS ENUM (
  'PREFERENCE',
  'ACADEMIC_GOAL',
  'CAREER_GOAL',
  'LEARNING_PATTERN',
  'SUCCESSFUL_STRATEGY',
  'USER_DEFINED'
);

CREATE TYPE "MemorySourceType" AS ENUM ('EXPLICIT', 'INFERRED', 'SYSTEM_DERIVED');
CREATE TYPE "MemoryStatus" AS ENUM ('CANDIDATE', 'ACTIVE', 'ARCHIVED');
CREATE TYPE "MemoryEvidenceType" AS ENUM ('DECLARATION', 'BEHAVIOR', 'OUTCOME', 'CONFIRMATION', 'CORRECTION');

ALTER TABLE "UserMemory"
  ADD COLUMN "category" "MemoryCategory" NOT NULL DEFAULT 'PREFERENCE',
  ADD COLUMN "sourceType" "MemorySourceType" NOT NULL DEFAULT 'EXPLICIT',
  ADD COLUMN "confidence" INTEGER NOT NULL DEFAULT 95,
  ADD COLUMN "importance" INTEGER NOT NULL DEFAULT 60,
  ADD COLUMN "status" "MemoryStatus" NOT NULL DEFAULT 'ACTIVE',
  ADD COLUMN "evidenceSummary" TEXT,
  ADD COLUMN "firstObservedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "lastObservedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "lastUsedAt" TIMESTAMP(3);

DROP INDEX "UserMemory_userId_key_key";
CREATE UNIQUE INDEX "UserMemory_id_userId_key" ON "UserMemory"("id", "userId");
CREATE UNIQUE INDEX "UserMemory_userId_category_key_key" ON "UserMemory"("userId", "category", "key");
CREATE INDEX "UserMemory_userId_status_category_importance_idx" ON "UserMemory"("userId", "status", "category", "importance");
CREATE INDEX "UserMemory_userId_lastObservedAt_idx" ON "UserMemory"("userId", "lastObservedAt");

ALTER TABLE "UserMemory"
  ADD CONSTRAINT "UserMemory_confidence_check" CHECK ("confidence" BETWEEN 0 AND 100),
  ADD CONSTRAINT "UserMemory_importance_check" CHECK ("importance" BETWEEN 0 AND 100),
  ADD CONSTRAINT "UserMemory_key_length_check" CHECK (char_length("key") BETWEEN 1 AND 80),
  ADD CONSTRAINT "UserMemory_value_length_check" CHECK (char_length("value") BETWEEN 1 AND 2000);

CREATE TABLE "MemoryObservation" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "memoryId" TEXT NOT NULL,
  "observedValue" TEXT NOT NULL,
  "source" TEXT NOT NULL,
  "evidenceKey" TEXT NOT NULL,
  "evidenceType" "MemoryEvidenceType" NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MemoryObservation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "MemoryObservation_source_length_check" CHECK (char_length("source") BETWEEN 1 AND 200),
  CONSTRAINT "MemoryObservation_evidence_key_length_check" CHECK (char_length("evidenceKey") BETWEEN 1 AND 200),
  CONSTRAINT "MemoryObservation_value_length_check" CHECK (char_length("observedValue") BETWEEN 1 AND 2000)
);

CREATE UNIQUE INDEX "MemoryObservation_memoryId_evidenceKey_key" ON "MemoryObservation"("memoryId", "evidenceKey");
CREATE INDEX "MemoryObservation_userId_memoryId_createdAt_idx" ON "MemoryObservation"("userId", "memoryId", "createdAt");

ALTER TABLE "MemoryObservation" ADD CONSTRAINT "MemoryObservation_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MemoryObservation" ADD CONSTRAINT "MemoryObservation_memoryId_userId_fkey"
  FOREIGN KEY ("memoryId", "userId") REFERENCES "UserMemory"("id", "userId") ON DELETE CASCADE ON UPDATE CASCADE;
