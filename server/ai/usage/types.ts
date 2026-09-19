export const AI_OPERATIONS = ["text-generation", "structured-output", "streaming", "embedding", "routing", "workflow-planning", "semantic-classification", "evaluation", "summarization"] as const;
export type AIOperation = typeof AI_OPERATIONS[number];
export const AI_SOURCES = ["rag-document", "rag-query", "memory-index", "memory-query", "conversation-index", "conversation-query", "conversation-summary"] as const;
export type AIUsageContext = {
  /** Trusted server metadata only; never accepted from request JSON. */
  userId?: string;
  requestId?: string;
  agentId?: string | null;
  workflowId?: string;
  workflowRunId?: string;
  conversationId?: string;
  operationType?: AIOperation;
  source?: typeof AI_SOURCES[number];
  estimatedContextTokens?: number;
  ragChunkCount?: number;
  retrievedTokenEstimate?: number;
  memoriesUsed?: number;
  personalizationFieldsUsed?: number;
  conversationSummaryUsed?: boolean;
  recentMessageCount?: number;
  historicalMessageCount?: number;
  estimatedConversationTokens?: number;
};
