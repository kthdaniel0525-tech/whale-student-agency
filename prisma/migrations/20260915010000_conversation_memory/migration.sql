CREATE TYPE "ConversationMessageRole" AS ENUM ('USER', 'ASSISTANT', 'SYSTEM', 'INTERNAL');

CREATE TABLE "Conversation" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "courseId" TEXT,
  "title" TEXT,
  "messageCount" INTEGER NOT NULL DEFAULT 0,
  "nextMessageSequence" INTEGER NOT NULL DEFAULT 1,
  "lastMessageAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Conversation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ConversationMessage" (
  "id" TEXT NOT NULL,
  "conversationId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "sequence" INTEGER NOT NULL,
  "turnId" TEXT,
  "role" "ConversationMessageRole" NOT NULL,
  "content" TEXT NOT NULL,
  "agentId" TEXT,
  "metadata" JSONB,
  "tokenEstimate" INTEGER NOT NULL,
  "embedding" vector(384),
  "embeddingModel" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ConversationMessage_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ConversationMessage_embedding_metadata_check" CHECK (
    ("embedding" IS NULL AND "embeddingModel" IS NULL)
    OR ("embedding" IS NOT NULL AND "embeddingModel" IS NOT NULL)
  )
);

CREATE TABLE "ConversationSummary" (
  "id" TEXT NOT NULL,
  "conversationId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "summaryText" TEXT NOT NULL,
  "data" JSONB NOT NULL,
  "sourceMessageIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "coveredUntilMessageId" TEXT NOT NULL,
  "coveredUntilSequence" INTEGER NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ConversationSummary_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Conversation_id_userId_key" ON "Conversation"("id", "userId");
CREATE INDEX "Conversation_userId_lastMessageAt_idx" ON "Conversation"("userId", "lastMessageAt");
CREATE INDEX "Conversation_courseId_userId_idx" ON "Conversation"("courseId", "userId");

CREATE UNIQUE INDEX "ConversationMessage_conversationId_sequence_key" ON "ConversationMessage"("conversationId", "sequence");
CREATE UNIQUE INDEX "ConversationMessage_conversationId_role_turnId_key" ON "ConversationMessage"("conversationId", "role", "turnId");
CREATE INDEX "ConversationMessage_conversationId_userId_sequence_idx" ON "ConversationMessage"("conversationId", "userId", "sequence");
CREATE INDEX "ConversationMessage_userId_conversationId_createdAt_idx" ON "ConversationMessage"("userId", "conversationId", "createdAt");
CREATE INDEX "ConversationMessage_conversationId_userId_embeddingModel_idx" ON "ConversationMessage"("conversationId", "userId", "embeddingModel");
CREATE INDEX "ConversationMessage_content_search_idx" ON "ConversationMessage" USING GIN (to_tsvector('simple', "content"));
CREATE INDEX "ConversationMessage_embedding_hnsw_idx" ON "ConversationMessage" USING hnsw ("embedding" vector_cosine_ops) WHERE "embedding" IS NOT NULL;

CREATE UNIQUE INDEX "ConversationSummary_conversationId_key" ON "ConversationSummary"("conversationId");
CREATE UNIQUE INDEX "ConversationSummary_conversationId_userId_key" ON "ConversationSummary"("conversationId", "userId");
CREATE INDEX "ConversationSummary_userId_conversationId_idx" ON "ConversationSummary"("userId", "conversationId");

ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_courseId_fkey"
  FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ConversationMessage" ADD CONSTRAINT "ConversationMessage_conversationId_userId_fkey"
  FOREIGN KEY ("conversationId", "userId") REFERENCES "Conversation"("id", "userId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ConversationMessage" ADD CONSTRAINT "ConversationMessage_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ConversationSummary" ADD CONSTRAINT "ConversationSummary_conversationId_userId_fkey"
  FOREIGN KEY ("conversationId", "userId") REFERENCES "Conversation"("id", "userId") ON DELETE CASCADE ON UPDATE CASCADE;
