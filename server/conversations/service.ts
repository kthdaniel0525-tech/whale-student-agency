import "server-only";
import { Prisma } from "@/generated/prisma/client";
import { auth } from "../auth/config";
import { db } from "../db/client";
import type { AIEmbeddingProvider, AIProvider } from "../ai/types";
import { CONVERSATION_CONFIG } from "./config";
import { estimateTokens } from "./tokens";
import {
  appendConversationMessageSchema,
  conversationIdSchema,
  createConversationSchema,
} from "./validation";
import { conversationSummaryDataSchema, generateIncrementalSummary } from "./summary";
import { applyConversationBudget, conversationTokenTarget } from "./budget";
import {
  retrieveOwnedConversationMessages,
  toConversationMessage,
} from "./retrieval";
import type {
  AppendConversationMessageInput,
  BuildConversationContextInput,
  ConversationContext,
  ConversationContextOptions,
  ConversationEmbeddingOptions,
  ConversationMessageRecord,
  ConversationRecord,
  ConversationSummaryData,
  ConversationSummaryRecord,
  CreateConversationInput,
  HistoricalMessageRetrievalInput,
} from "./types";

export type ConversationErrorCode =
  | "INVALID_REQUEST"
  | "UNAUTHENTICATED"
  | "CONVERSATION_NOT_FOUND"
  | "COURSE_MISMATCH"
  | "MESSAGE_NOT_FOUND"
  | "STORAGE_FAILURE";

const errorMessages: Record<ConversationErrorCode, string> = {
  INVALID_REQUEST: "Check the conversation request.",
  UNAUTHENTICATED: "Sign in to use conversations.",
  CONVERSATION_NOT_FOUND: "This conversation was not found.",
  COURSE_MISMATCH: "This conversation belongs to a different course.",
  MESSAGE_NOT_FOUND: "This conversation message was not found.",
  STORAGE_FAILURE: "Conversation data could not be saved.",
};

export class ConversationError extends Error {
  constructor(readonly code: ConversationErrorCode) {
    super(errorMessages[code]);
    this.name = "ConversationError";
  }
}

const roleToDb = {
  user: "USER",
  assistant: "ASSISTANT",
  system: "SYSTEM",
  internal: "INTERNAL",
} as const;

async function identity(requestHeaders: Headers): Promise<string> {
  if (!requestHeaders || typeof requestHeaders.get !== "function")
    throw new ConversationError("INVALID_REQUEST");
  const session = await auth().api.getSession({
    headers: new Headers(requestHeaders),
    query: { disableRefresh: true },
  });
  if (!session?.user.id) throw new ConversationError("UNAUTHENTICATED");
  return session.user.id;
}

function publicConversation(row: {
  id: string;
  title: string | null;
  courseId: string | null;
  messageCount: number;
  lastMessageAt: Date;
  createdAt: Date;
  updatedAt: Date;
}): ConversationRecord {
  return {
    id: row.id,
    title: row.title,
    courseId: row.courseId,
    messageCount: row.messageCount,
    lastMessageAt: row.lastMessageAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function deterministicTitle(content: string): string {
  const line = content.normalize("NFKC").trim().replace(/\s+/g, " ");
  return (line.length <= 80 ? line : line.slice(0, 79) + "…") || "New conversation";
}

function publicSummary(row: {
  id: string;
  data: unknown;
  summaryText: string;
  coveredUntilMessageId: string;
  coveredUntilSequence: number;
  version: number;
  updatedAt: Date;
}): ConversationSummaryRecord | undefined {
  const parsed = conversationSummaryDataSchema.safeParse(row.data);
  if (!parsed.success) return undefined;
  return {
    id: row.id,
    ...parsed.data,
    summaryText: row.summaryText,
    coveredUntilMessageId: row.coveredUntilMessageId,
    coveredUntilSequence: row.coveredUntilSequence,
    version: row.version,
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function ownedConversation(userId: string, id: string) {
  const conversation = await db().conversation.findFirst({
    where: { id, userId },
  });
  if (!conversation) throw new ConversationError("CONVERSATION_NOT_FOUND");
  return conversation;
}

async function embeddingProvider(options: ConversationEmbeddingOptions) {
  if (options.embeddingProvider === null) return null;
  if (options.embeddingProvider) return options.embeddingProvider;
  return import("../documents/embeddings").then(
    ({ localEmbeddingProvider }) => localEmbeddingProvider,
  );
}

async function persistMessageEmbedding(
  message: ConversationMessageRecord,
  options: ConversationEmbeddingOptions,
): Promise<void> {
  try {
    const provider = await embeddingProvider(options);
    if (!provider) return;
    const response = await provider.generateEmbedding({
      input: message.content,
      dimensions: 384,
    });
    const { validateEmbedding } = await import("../documents/embeddings");
    const vector = JSON.stringify(validateEmbedding(response.vector));
    await db().$executeRaw`
      UPDATE "ConversationMessage"
      SET embedding=${vector}::vector, "embeddingModel"=${response.model}
      WHERE id=${message.id} AND "conversationId"=${message.conversationId}
      AND embedding IS NULL
    `;
  } catch {
    // Conversation persistence and lexical retrieval remain available.
  }
}

export async function createConversation(
  raw: CreateConversationInput,
  requestHeaders: Headers,
): Promise<ConversationRecord> {
  const parsed = createConversationSchema.safeParse(raw);
  if (!parsed.success) throw new ConversationError("INVALID_REQUEST");
  const userId = await identity(requestHeaders);
  if (parsed.data.courseId) {
    const course = await db().course.findFirst({
      where: { id: parsed.data.courseId, userId },
      select: { id: true },
    });
    if (!course) throw new ConversationError("CONVERSATION_NOT_FOUND");
  }
  try {
    return publicConversation(
      await db().conversation.create({
        data: {
          userId,
          ...(parsed.data.title ? { title: parsed.data.title } : {}),
          ...(parsed.data.courseId ? { courseId: parsed.data.courseId } : {}),
        },
      }),
    );
  } catch (error) {
    if (error instanceof ConversationError) throw error;
    throw new ConversationError("STORAGE_FAILURE");
  }
}

export async function listConversations(
  requestHeaders: Headers,
  limit = 20,
): Promise<ConversationRecord[]> {
  const userId = await identity(requestHeaders);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new ConversationError("INVALID_REQUEST");
  return (
    await db().conversation.findMany({
      where: { userId },
      orderBy: [{ lastMessageAt: "desc" }, { id: "asc" }],
      take: limit,
    })
  ).map(publicConversation);
}

export async function getConversation(
  id: string,
  requestHeaders: Headers,
  messageLimit: number = CONVERSATION_CONFIG.recentMessageCount,
) {
  const parsed = conversationIdSchema.safeParse(id);
  if (!parsed.success || !Number.isInteger(messageLimit) || messageLimit < 0 || messageLimit > 100)
    throw new ConversationError("INVALID_REQUEST");
  const userId = await identity(requestHeaders);
  const conversation = await ownedConversation(userId, parsed.data);
  const messages = messageLimit
    ? (
        await db().conversationMessage.findMany({
          where: { conversationId: conversation.id, userId },
          orderBy: { sequence: "desc" },
          take: messageLimit,
        })
      )
        .reverse()
        .map(toConversationMessage)
    : [];
  const summaryRow = await db().conversationSummary.findFirst({
    where: { conversationId: conversation.id, userId },
  });
  return {
    ...publicConversation(conversation),
    messages,
    summary: summaryRow ? publicSummary(summaryRow) : undefined,
  };
}

export async function appendConversationMessage(
  raw: AppendConversationMessageInput,
  requestHeaders: Headers,
  options: ConversationEmbeddingOptions = {},
): Promise<ConversationMessageRecord> {
  const parsed = appendConversationMessageSchema.safeParse(raw);
  if (!parsed.success) throw new ConversationError("INVALID_REQUEST");
  const userId = await identity(requestHeaders);
  try {
    const existing = parsed.data.turnId
      ? await db().conversationMessage.findFirst({
          where: {
            conversationId: parsed.data.conversationId,
            userId,
            turnId: parsed.data.turnId,
            role: roleToDb[parsed.data.role],
          },
        })
      : null;
    if (existing) {
      if (
        existing.content !== parsed.data.content ||
        existing.agentId !== (parsed.data.agentId ?? null)
      )
        throw new ConversationError("INVALID_REQUEST");
      return toConversationMessage(existing);
    }
    const conversation = await ownedConversation(userId, parsed.data.conversationId);
    const now = new Date();
    const row = await db().$transaction(async (transaction) => {
      const updated = await transaction.conversation.update({
        where: { id_userId: { id: conversation.id, userId } },
        data: {
          nextMessageSequence: { increment: 1 },
          messageCount: { increment: 1 },
          lastMessageAt: now,
          ...(!conversation.title && parsed.data.role === "user"
            ? { title: deterministicTitle(parsed.data.content) }
            : {}),
        },
        select: { nextMessageSequence: true },
      });
      return transaction.conversationMessage.create({
        data: {
          conversationId: conversation.id,
          userId,
          sequence: updated.nextMessageSequence - 1,
          role: roleToDb[parsed.data.role],
          content: parsed.data.content,
          tokenEstimate: estimateTokens(parsed.data.content),
          ...(parsed.data.turnId ? { turnId: parsed.data.turnId } : {}),
          ...(parsed.data.agentId ? { agentId: parsed.data.agentId } : {}),
          ...(parsed.data.metadata ? { metadata: parsed.data.metadata } : {}),
        },
      });
    });
    const message = toConversationMessage(row);
    await persistMessageEmbedding(message, options);
    return message;
  } catch (error) {
    if (error instanceof ConversationError) throw error;
    // Concurrent retries can both miss the preflight read. The unique
    // (conversation, role, turn) key makes the write safe; return the winner
    // only when its visible payload is exactly the same.
    if (parsed.data.turnId) {
      const existing = await db().conversationMessage.findFirst({
        where: {
          conversationId: parsed.data.conversationId,
          userId,
          turnId: parsed.data.turnId,
          role: roleToDb[parsed.data.role],
        },
      }).catch(() => null);
      if (
        existing &&
        existing.content === parsed.data.content &&
        existing.agentId === (parsed.data.agentId ?? null)
      )
        return toConversationMessage(existing);
      if (existing) throw new ConversationError("INVALID_REQUEST");
    }
    throw new ConversationError("STORAGE_FAILURE");
  }
}

export async function deleteConversation(
  id: string,
  requestHeaders: Headers,
): Promise<void> {
  if (!conversationIdSchema.safeParse(id).success)
    throw new ConversationError("INVALID_REQUEST");
  const userId = await identity(requestHeaders);
  const result = await db().conversation.deleteMany({ where: { id, userId } });
  if (!result.count) throw new ConversationError("CONVERSATION_NOT_FOUND");
}

export async function deleteConversationMessage(
  conversationId: string,
  messageId: string,
  requestHeaders: Headers,
): Promise<void> {
  if (
    !conversationIdSchema.safeParse(conversationId).success ||
    !conversationIdSchema.safeParse(messageId).success
  )
    throw new ConversationError("INVALID_REQUEST");
  const userId = await identity(requestHeaders);
  const message = await db().conversationMessage.findFirst({
    where: { id: messageId, conversationId, userId },
    select: { id: true, sequence: true },
  });
  if (!message) throw new ConversationError("MESSAGE_NOT_FOUND");
  await db().$transaction(async (transaction) => {
    await transaction.conversationMessage.delete({ where: { id: message.id } });
    await transaction.conversation.update({
      where: { id_userId: { id: conversationId, userId } },
      data: { messageCount: { decrement: 1 } },
    });
    await transaction.conversationSummary.deleteMany({
      where: {
        conversationId,
        userId,
        OR: [
          { coveredUntilSequence: { gte: message.sequence } },
          { sourceMessageIds: { has: message.id } },
        ],
      },
    });
  });
}

async function compressOwnedConversation(input: {
  userId: string;
  conversation: Awaited<ReturnType<typeof ownedConversation>>;
  recentMessages: readonly ConversationMessageRecord[];
  force: boolean;
  getProvider?: () => AIProvider | Promise<AIProvider>;
}): Promise<boolean> {
  const summaryRow = await db().conversationSummary.findFirst({
    where: { conversationId: input.conversation.id, userId: input.userId },
  });
  const previous = summaryRow ? publicSummary(summaryRow) : undefined;
  const aggregate = await db().conversationMessage.aggregate({
    where: {
      conversationId: input.conversation.id,
      userId: input.userId,
      role: { in: ["USER", "ASSISTANT"] },
    },
    _sum: { tokenEstimate: true },
  });
  const triggered =
    input.force ||
    input.conversation.messageCount > CONVERSATION_CONFIG.compressionMessageThreshold ||
    (aggregate._sum.tokenEstimate ?? 0) > CONVERSATION_CONFIG.compressionTokenThreshold;
  if (!triggered) return false;
  const recentFirst = input.recentMessages[0]?.sequence ?? Number.MAX_SAFE_INTEGER;
  const rows = await db().conversationMessage.findMany({
    where: {
      conversationId: input.conversation.id,
      userId: input.userId,
      role: { in: ["USER", "ASSISTANT"] },
      sequence: {
        gt: previous?.coveredUntilSequence ?? 0,
        lt: recentFirst,
      },
    },
    orderBy: { sequence: "asc" },
    take: CONVERSATION_CONFIG.compressionBatchMessages,
  });
  const selected: ConversationMessageRecord[] = [];
  let tokens = 0;
  for (const row of rows) {
    if (
      selected.length &&
      tokens + row.tokenEstimate > CONVERSATION_CONFIG.compressionBatchTokens
    )
      break;
    selected.push(toConversationMessage(row));
    tokens += row.tokenEstimate;
  }
  if (!selected.length) return false;
  let provider: AIProvider | undefined;
  try {
    provider = input.getProvider ? await input.getProvider() : undefined;
  } catch {
    provider = undefined;
  }
  const previousData: ConversationSummaryData | undefined = previous
    ? {
        activeGoals: previous.activeGoals,
        importantFacts: previous.importantFacts,
        decisions: previous.decisions,
        unresolvedItems: previous.unresolvedItems,
        activeResources: previous.activeResources,
        recentProgress: previous.recentProgress,
        corrections: previous.corrections,
        summaryText: previous.summaryText,
      }
    : undefined;
  const generated = await generateIncrementalSummary({
    provider,
    previous: previousData,
    messages: selected,
  });
  const last = selected.at(-1)!;
  const sourceMessageIds = [
    ...new Set(
      Object.values(generated)
        .filter(Array.isArray)
        .flatMap((items) =>
          (items as { sourceMessageIds: readonly string[] }[]).flatMap(
            (item) => item.sourceMessageIds,
          ),
        ),
    ),
  ];
  await db().conversationSummary.upsert({
    where: { conversationId: input.conversation.id },
    create: {
      conversationId: input.conversation.id,
      userId: input.userId,
      summaryText: generated.summaryText,
      data: generated as unknown as Prisma.InputJsonValue,
      sourceMessageIds,
      coveredUntilMessageId: last.id,
      coveredUntilSequence: last.sequence,
    },
    update: {
      summaryText: generated.summaryText,
      data: generated as unknown as Prisma.InputJsonValue,
      sourceMessageIds,
      coveredUntilMessageId: last.id,
      coveredUntilSequence: last.sequence,
      version: { increment: 1 },
    },
  });
  return true;
}

export async function compressConversation(
  conversationId: string,
  requestHeaders: Headers,
  options: ConversationContextOptions = {},
): Promise<ConversationSummaryRecord | undefined> {
  const userId = await identity(requestHeaders);
  const conversation = await ownedConversation(userId, conversationId);
  const recentMessages = (
    await db().conversationMessage.findMany({
      where: {
        conversationId,
        userId,
        role: { in: ["USER", "ASSISTANT"] },
      },
      orderBy: { sequence: "desc" },
      take: CONVERSATION_CONFIG.recentMessageCount,
    })
  )
    .reverse()
    .map(toConversationMessage);
  await compressOwnedConversation({
    userId,
    conversation,
    recentMessages,
    force: options.forceCompression ?? true,
    getProvider: options.getProvider,
  });
  const row = await db().conversationSummary.findFirst({
    where: { conversationId, userId },
  });
  return row ? publicSummary(row) : undefined;
}

export async function retrieveRelevantConversationMessages(
  input: HistoricalMessageRetrievalInput,
  requestHeaders: Headers,
  options: ConversationEmbeddingOptions = {},
): Promise<ConversationMessageRecord[]> {
  const userId = await identity(requestHeaders);
  await ownedConversation(userId, input.conversationId);
  return retrieveOwnedConversationMessages(userId, input, options);
}

export async function getConversationScope(
  conversationId: string,
  requestHeaders: Headers,
): Promise<Pick<ConversationRecord, "id" | "courseId">> {
  const userId = await identity(requestHeaders);
  const conversation = await ownedConversation(userId, conversationId);
  return { id: conversation.id, courseId: conversation.courseId };
}

export async function buildConversationContext(
  input: BuildConversationContextInput,
  requestHeaders: Headers,
  options: ConversationContextOptions = {},
): Promise<ConversationContext> {
  const parsedId = conversationIdSchema.safeParse(input.conversationId);
  if (!parsedId.success || !input.query.trim())
    throw new ConversationError("INVALID_REQUEST");
  const userId = await identity(requestHeaders);
  const conversation = await ownedConversation(userId, parsedId.data);
  if (
    input.expectedCourseId &&
    conversation.courseId &&
    input.expectedCourseId !== conversation.courseId
  )
    throw new ConversationError("COURSE_MISMATCH");
  let recentMessages = (
    await db().conversationMessage.findMany({
      where: {
        conversationId: conversation.id,
        userId,
        role: { in: ["USER", "ASSISTANT"] },
      },
      orderBy: { sequence: "desc" },
      take: CONVERSATION_CONFIG.recentMessageCount,
    })
  )
    .reverse()
    .map(toConversationMessage);
  const compressionTriggered = await compressOwnedConversation({
    userId,
    conversation,
    recentMessages,
    force: options.forceCompression ?? false,
    getProvider: options.getProvider,
  });
  // Compression never changes raw messages, but a concurrent append may have.
  recentMessages = (
    await db().conversationMessage.findMany({
      where: {
        conversationId: conversation.id,
        userId,
        role: { in: ["USER", "ASSISTANT"] },
      },
      orderBy: { sequence: "desc" },
      take: CONVERSATION_CONFIG.recentMessageCount,
    })
  )
    .reverse()
    .map(toConversationMessage);
  const summaryRow = await db().conversationSummary.findFirst({
    where: { conversationId: conversation.id, userId },
  });
  const summary = summaryRow ? publicSummary(summaryRow) : undefined;
  const historical = await retrieveOwnedConversationMessages(
    userId,
    {
      conversationId: conversation.id,
      query: input.query,
      limit: CONVERSATION_CONFIG.historicalRetrievalLimit,
      excludeMessageIds: recentMessages.map((message) => message.id),
      summaryText: summary?.summaryText,
    },
    options,
  );
  const domainEstimatedTokens = options.domainEstimatedTokens ?? 0;
  const targetTokens = conversationTokenTarget({
    agentId: options.agentId,
    request: input.query,
    domainEstimatedTokens,
  });
  return applyConversationBudget({
    conversationId: conversation.id,
    courseId: conversation.courseId,
    summary,
    recentMessages,
    historicalMessages: historical,
    targetTokens,
    compressionTriggered,
    domainEstimatedTokens,
  });
}

export type { AIEmbeddingProvider };
