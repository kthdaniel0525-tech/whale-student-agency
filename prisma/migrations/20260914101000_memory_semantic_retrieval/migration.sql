ALTER TABLE "UserMemory"
  ADD COLUMN "embedding" vector(384),
  ADD COLUMN "embeddingModel" TEXT,
  ADD COLUMN "embeddingValueHash" TEXT;

ALTER TABLE "UserMemory" ADD CONSTRAINT "UserMemory_embedding_metadata_check"
  CHECK (
    ("embedding" IS NULL AND "embeddingModel" IS NULL AND "embeddingValueHash" IS NULL)
    OR
    ("embedding" IS NOT NULL AND "embeddingModel" IS NOT NULL AND "embeddingValueHash" IS NOT NULL)
  );

CREATE INDEX "UserMemory_userId_embeddingModel_idx" ON "UserMemory"("userId", "embeddingModel");
