import type { AIEmbeddingProvider, AIProvider } from "../ai/types";

export type ConversationRole = "user" | "assistant" | "system" | "internal";

export interface ConversationRecord {
  readonly id: string;
  readonly title: string | null;
  readonly courseId: string | null;
  readonly messageCount: number;
  readonly lastMessageAt: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ConversationMessageRecord {
  readonly id: string;
  readonly conversationId: string;
  readonly sequence: number;
  readonly turnId: string | null;
  readonly role: ConversationRole;
  readonly content: string;
  readonly agentId: string | null;
  readonly metadata: Readonly<Record<string, string | number | boolean | null>> | null;
  readonly tokenEstimate: number;
  readonly createdAt: string;
}

export interface ConversationSummaryItem {
  readonly text: string;
  readonly sourceMessageIds: readonly string[];
}

export interface ConversationSummaryData {
  readonly activeGoals: readonly ConversationSummaryItem[];
  readonly importantFacts: readonly ConversationSummaryItem[];
  readonly decisions: readonly ConversationSummaryItem[];
  readonly unresolvedItems: readonly ConversationSummaryItem[];
  readonly activeResources: readonly ConversationSummaryItem[];
  readonly recentProgress: readonly ConversationSummaryItem[];
  readonly corrections: readonly ConversationSummaryItem[];
  readonly summaryText: string;
}

export interface ConversationSummaryRecord extends ConversationSummaryData {
  readonly id: string;
  readonly coveredUntilMessageId: string;
  readonly coveredUntilSequence: number;
  readonly version: number;
  readonly updatedAt: string;
}

export interface ConversationContext {
  readonly conversationId: string;
  readonly courseId: string | null;
  readonly summary?: ConversationSummaryRecord;
  readonly recentMessages: readonly ConversationMessageRecord[];
  readonly relevantHistoricalMessages: readonly ConversationMessageRecord[];
  readonly metadata: {
    readonly recentMessagesUsed: number;
    readonly historicalMessagesUsed: number;
    readonly summaryUsed: boolean;
    readonly estimatedConversationTokens: number;
    readonly compressionTriggered: boolean;
    readonly targetConversationTokens: number;
    readonly totalAssembledContextEstimate: number;
  };
}

export interface ConversationEmbeddingOptions {
  /** null disables semantic embeddings; omitted reuses the existing RAG provider. */
  readonly embeddingProvider?: AIEmbeddingProvider | null;
}

export interface ConversationContextOptions extends ConversationEmbeddingOptions {
  readonly agentId?: string;
  readonly domainEstimatedTokens?: number;
  readonly getProvider?: () => AIProvider | Promise<AIProvider>;
  readonly forceCompression?: boolean;
}

export interface CreateConversationInput {
  readonly title?: string;
  readonly courseId?: string;
}

export interface AppendConversationMessageInput {
  readonly conversationId: string;
  readonly role: ConversationRole;
  readonly content: string;
  readonly turnId?: string;
  readonly agentId?: string;
  readonly metadata?: Readonly<Record<string, string | number | boolean | null>>;
}

export interface HistoricalMessageRetrievalInput {
  readonly conversationId: string;
  readonly query: string;
  readonly limit?: number;
  readonly excludeMessageIds?: readonly string[];
  readonly summaryText?: string;
}

export interface BuildConversationContextInput {
  readonly conversationId: string;
  readonly query: string;
  readonly expectedCourseId?: string;
}
