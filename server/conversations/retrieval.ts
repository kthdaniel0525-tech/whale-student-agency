import "server-only";
import { Prisma } from "@/generated/prisma/client";
import { db } from "../db/client";
import { CONVERSATION_CONFIG } from "./config";
import type {
  ConversationEmbeddingOptions,
  ConversationMessageRecord,
  HistoricalMessageRetrievalInput,
} from "./types";

const roleFromDb = {
  USER: "user",
  ASSISTANT: "assistant",
  SYSTEM: "system",
  INTERNAL: "internal",
} as const;

function words(value: string): Set<string> {
  return new Set(
    value
      .normalize("NFKC")
      .toLocaleLowerCase()
      .match(/[\p{L}\p{N}]{3,}/gu) ?? [],
  );
}

function lexicalScore(query: string, content: string): number {
  const left = words(query);
  const right = words(content);
  if (!left.size || !right.size) return 0;
  const overlap = [...left].filter((word) => right.has(word)).length;
  return overlap / Math.max(1, Math.min(left.size, right.size));
}

function publicMessage(row: {
  id: string;
  conversationId: string;
  sequence: number;
  turnId: string | null;
  role: keyof typeof roleFromDb;
  content: string;
  agentId: string | null;
  metadata: unknown;
  tokenEstimate: number;
  createdAt: Date;
}): ConversationMessageRecord {
  return {
    id: row.id,
    conversationId: row.conversationId,
    sequence: row.sequence,
    turnId: row.turnId,
    role: roleFromDb[row.role],
    content: row.content,
    agentId: row.agentId,
    metadata: (row.metadata as ConversationMessageRecord["metadata"]) ?? null,
    tokenEstimate: row.tokenEstimate,
    createdAt: row.createdAt.toISOString(),
  };
}

async function embeddingProvider(options: ConversationEmbeddingOptions) {
  if (options.embeddingProvider === null) return null;
  if (options.embeddingProvider) return options.embeddingProvider;
  return import("../documents/embeddings").then(
    ({ localEmbeddingProvider }) => localEmbeddingProvider,
  );
}

export async function retrieveOwnedConversationMessages(
  userId: string,
  input: HistoricalMessageRetrievalInput,
  options: ConversationEmbeddingOptions = {},
): Promise<ConversationMessageRecord[]> {
  const limit = Math.max(
    1,
    Math.min(
      input.limit ?? CONVERSATION_CONFIG.historicalRetrievalLimit,
      CONVERSATION_CONFIG.maximumHistoricalRetrievalLimit,
    ),
  );
  const excluded = [...new Set(input.excludeMessageIds ?? [])];
  const queryWords = [...words(input.query)].slice(0, 8);
  const exclusion = excluded.length
    ? Prisma.sql`AND id NOT IN (${Prisma.join(excluded)})`
    : Prisma.empty;
  const lexicalHits = queryWords.length
    ? await db().$queryRaw<{ id: string }[]>(Prisma.sql`
        SELECT id
        FROM "ConversationMessage"
        WHERE "userId"=${userId} AND "conversationId"=${input.conversationId}
        AND role IN ('USER','ASSISTANT') ${exclusion}
        AND to_tsvector('simple', content) @@ to_tsquery('simple', ${queryWords.join(" | ")})
        ORDER BY ts_rank(to_tsvector('simple', content), to_tsquery('simple', ${queryWords.join(" | ")})) DESC,
                 sequence DESC
        LIMIT ${limit * 6}
      `)
    : [];
  const lexicalIds = lexicalHits.map((row) => row.id);
  const lexical = lexicalIds.length
    ? await db().conversationMessage.findMany({
        where: {
          id: { in: lexicalIds },
          userId,
          conversationId: input.conversationId,
          role: { in: ["USER", "ASSISTANT"] },
        },
      })
    : [];

  const semanticScores = new Map<string, number>();
  try {
    const provider = await embeddingProvider(options);
    if (provider) {
      const response = await provider.generateEmbedding({
        usageContext: { userId, conversationId: input.conversationId, source: "conversation-query" },
        input: input.query,
        dimensions: 384,
      });
      const { validateEmbedding } = await import("../documents/embeddings");
      const vector = JSON.stringify(validateEmbedding(response.vector));
      const rows = await db().$queryRaw<{ id: string; similarity: number }[]>(
        Prisma.sql`
          SELECT id, 1-(embedding <=> ${vector}::vector) AS similarity
          FROM "ConversationMessage"
          WHERE "userId"=${userId} AND "conversationId"=${input.conversationId}
          AND role IN ('USER','ASSISTANT') AND "embeddingModel"=${response.model}
          AND embedding IS NOT NULL ${exclusion}
          ORDER BY embedding <=> ${vector}::vector, sequence DESC
          LIMIT ${limit * 4}
        `,
      );
      for (const row of rows) semanticScores.set(row.id, Number(row.similarity));
    }
  } catch {
    // Lexical retrieval remains available when semantic infrastructure is absent.
  }

  const semanticIds = [...semanticScores.keys()];
  const missingIds = semanticIds.filter((id) => !lexical.some((row) => row.id === id));
  const semanticRows = missingIds.length
    ? await db().conversationMessage.findMany({
        where: {
          id: { in: missingIds },
          userId,
          conversationId: input.conversationId,
          role: { in: ["USER", "ASSISTANT"] },
        },
      })
    : [];
  const candidates = [...lexical, ...semanticRows];
  const summary = input.summaryText?.normalize("NFKC").toLocaleLowerCase() ?? "";
  return candidates
    .map((row) => {
      const lexicalRelevance = lexicalScore(input.query, row.content);
      const semanticRelevance = semanticScores.get(row.id) ?? 0;
      return {
        row,
        score: Math.max(lexicalRelevance, semanticRelevance),
      };
    })
    .filter(({ row, score }) => {
      const normalized = row.content.normalize("NFKC").toLocaleLowerCase().trim();
      return score >= 0.38 && !(normalized.length > 20 && summary.includes(normalized));
    })
    .sort((a, b) => b.score - a.score || b.row.sequence - a.row.sequence)
    .filter(
      (candidate, index, all) =>
        all.findIndex(
          (other) =>
            other.row.content.normalize("NFKC").trim().toLocaleLowerCase() ===
            candidate.row.content.normalize("NFKC").trim().toLocaleLowerCase(),
        ) === index,
    )
    .slice(0, limit)
    .map(({ row }) => publicMessage(row));
}

export { publicMessage as toConversationMessage };
