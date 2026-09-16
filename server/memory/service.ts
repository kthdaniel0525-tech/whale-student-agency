import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { Prisma } from "@/generated/prisma/client";
import { auth } from "../auth/config";
import { db } from "../db/client";
import { MEMORY_CONFIG, MEMORY_DEFAULT_IMPORTANCE } from "./config";
import { inferMemoryCategories, memoryIsStale, rankMemory } from "./ranking";
import type {
  ExplicitMemoryInput,
  MemoryCategory,
  MemoryEmbeddingOptions,
  MemoryListOptions,
  MemoryObservationInput,
  MemoryRecord,
  MemoryRetrievalInput,
  MemorySourceType,
  MemoryUpdateInput,
} from "./types";
import {
  deserializeMemoryValue,
  memoryCategorySchema,
  memoryStatusSchema,
  normalizeMemoryKey,
  serializeMemoryValue,
  validateMemoryValue,
} from "./validation";

export type MemoryErrorCode =
  | "INVALID_REQUEST"
  | "UNAUTHENTICATED"
  | "MEMORY_NOT_FOUND"
  | "LIMIT_REACHED"
  | "STORAGE_FAILURE";

const errorMessage: Record<MemoryErrorCode, string> = {
  INVALID_REQUEST: "Check the memory category, key, and value.",
  UNAUTHENTICATED: "Sign in to manage memory.",
  MEMORY_NOT_FOUND: "This memory was not found.",
  LIMIT_REACHED: "Memory is full. Archive an older memory before adding another.",
  STORAGE_FAILURE: "Memory could not be saved.",
};

export class MemoryError extends Error {
  constructor(readonly code: MemoryErrorCode) {
    super(errorMessage[code]);
    this.name = "MemoryError";
  }
}

const categoryToDb = {
  preference: "PREFERENCE",
  "academic-goal": "ACADEMIC_GOAL",
  "career-goal": "CAREER_GOAL",
  "learning-pattern": "LEARNING_PATTERN",
  "successful-strategy": "SUCCESSFUL_STRATEGY",
  "user-defined": "USER_DEFINED",
} as const;
const categoryFromDb = Object.fromEntries(
  Object.entries(categoryToDb).map(([key, value]) => [value, key]),
) as Record<(typeof categoryToDb)[MemoryCategory], MemoryCategory>;
const sourceToDb = { explicit: "EXPLICIT", inferred: "INFERRED", "system-derived": "SYSTEM_DERIVED" } as const;
const sourceFromDb = { EXPLICIT: "explicit", INFERRED: "inferred", SYSTEM_DERIVED: "system-derived" } as const;
const statusToDb = { candidate: "CANDIDATE", active: "ACTIVE", archived: "ARCHIVED" } as const;
const statusFromDb = { CANDIDATE: "candidate", ACTIVE: "active", ARCHIVED: "archived" } as const;
const evidenceToDb = { declaration: "DECLARATION", behavior: "BEHAVIOR", outcome: "OUTCOME", confirmation: "CONFIRMATION", correction: "CORRECTION" } as const;

type MemoryRow = Awaited<ReturnType<ReturnType<typeof db>["userMemory"]["findFirst"]>>;
const semanticCategories = new Set<MemoryCategory>([
  "learning-pattern",
  "successful-strategy",
  "user-defined",
]);

async function embeddingProvider(options: MemoryEmbeddingOptions) {
  if (options.embeddingProvider === null) return null;
  if (options.embeddingProvider) return options.embeddingProvider;
  return import("../documents/embeddings").then(({ localEmbeddingProvider }) => localEmbeddingProvider);
}

async function persistSemanticEmbedding(
  row: NonNullable<MemoryRow>,
  options: MemoryEmbeddingOptions,
): Promise<void> {
  const category = categoryFromDb[row.category];
  if (!category || !semanticCategories.has(category) || row.status !== "ACTIVE") return;
  const hash = createHash("sha256").update(`${row.key}\0${row.value}`).digest("hex");
  if (!options.embeddingProvider && row.embeddingModel && row.embeddingValueHash === hash) return;
  try {
    const provider = await embeddingProvider(options);
    if (!provider) return;
    const response = await provider.generateEmbedding({ input: `${row.key}: ${row.value}`, dimensions: 384 });
    if (row.embeddingModel === response.model && row.embeddingValueHash === hash) return;
    const { validateEmbedding } = await import("../documents/embeddings");
    const vector = JSON.stringify(validateEmbedding(response.vector));
    await db().$executeRaw`UPDATE "UserMemory" SET embedding=${vector}::vector,"embeddingModel"=${response.model},"embeddingValueHash"=${hash}
      WHERE id=${row.id} AND "userId"=${row.userId} AND value=${row.value} AND status='ACTIVE'`;
  } catch {
    // Semantic retrieval is an enhancement. Typed deterministic retrieval stays
    // available when the embedding model is unavailable.
  }
}

async function semanticSimilarities(
  rows: readonly NonNullable<MemoryRow>[],
  input: MemoryRetrievalInput,
  options: MemoryEmbeddingOptions,
): Promise<Map<string, number>> {
  if (input.semantic === false) return new Map();
  const candidates = rows.filter((row) => {
    const category = categoryFromDb[row.category];
    const currentHash = createHash("sha256").update(`${row.key}\0${row.value}`).digest("hex");
    return category && semanticCategories.has(category) && row.embeddingModel && row.embeddingValueHash === currentHash;
  });
  if (!candidates.length) return new Map();
  try {
    const provider = await embeddingProvider(options);
    if (!provider) return new Map();
    const response = await provider.generateEmbedding({ input: input.request, dimensions: 384 });
    const ids = candidates.filter((row) => row.embeddingModel === response.model).map((row) => row.id);
    if (!ids.length) return new Map();
    const { validateEmbedding } = await import("../documents/embeddings");
    const vector = JSON.stringify(validateEmbedding(response.vector));
    const result = await db().$queryRaw<{ id: string; similarity: number }[]>(Prisma.sql`
      SELECT id,1-(embedding <=> ${vector}::vector) AS similarity
      FROM "UserMemory"
      WHERE "userId"=${input.userId} AND status='ACTIVE' AND "embeddingModel"=${response.model}
      AND id IN (${Prisma.join(ids)})
    `);
    return new Map(result.map((row) => [row.id, Number(row.similarity)]));
  } catch {
    return new Map();
  }
}

function boundedText(value: string, maximum: number): string {
  const text = value.normalize("NFKC").trim();
  if (!text || text.length > maximum) throw new MemoryError("INVALID_REQUEST");
  return text;
}

function importance(category: MemoryCategory, value?: number): number {
  const result = value ?? MEMORY_DEFAULT_IMPORTANCE[category];
  if (!Number.isInteger(result) || result < 0 || result > 100) throw new MemoryError("INVALID_REQUEST");
  return result;
}

function definition(categoryValue: unknown, keyValue: unknown, value: unknown) {
  const parsed = memoryCategorySchema.safeParse(categoryValue);
  if (!parsed.success || typeof keyValue !== "string") throw new MemoryError("INVALID_REQUEST");
  try {
    const key = normalizeMemoryKey(parsed.data, keyValue);
    const validated = validateMemoryValue(parsed.data, key, value);
    return { category: parsed.data, key, value: validated, serialized: serializeMemoryValue(validated) };
  } catch {
    throw new MemoryError("INVALID_REQUEST");
  }
}

function publicMemory(row: NonNullable<MemoryRow>, now = new Date()): MemoryRecord | undefined {
  const category = categoryFromDb[row.category];
  if (!category) return undefined;
  try {
    const key = normalizeMemoryKey(category, row.key);
    const record: MemoryRecord = {
      id: row.id,
      category,
      key,
      value: deserializeMemoryValue(category, key, row.value),
      sourceType: sourceFromDb[row.sourceType],
      confidence: row.confidence,
      importance: row.importance,
      status: statusFromDb[row.status],
      explanation: row.evidenceSummary ?? (row.sourceType === "EXPLICIT" ? "Saved from a direct user statement." : "Supported by repeated product-use observations."),
      firstObservedAt: row.firstObservedAt.toISOString(),
      lastObservedAt: row.lastObservedAt.toISOString(),
      lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
      stale: false,
    };
    return { ...record, stale: memoryIsStale(record, now) };
  } catch {
    // Legacy or externally written values outside the product allowlist are not
    // eligible for AI context.
    return undefined;
  }
}

async function identity(headers: Headers): Promise<string> {
  if (!headers || typeof headers.get !== "function") throw new MemoryError("INVALID_REQUEST");
  const session = await auth().api.getSession({ headers: new Headers(headers), query: { disableRefresh: true } });
  if (!session?.user.id) throw new MemoryError("UNAUTHENTICATED");
  return session.user.id;
}

async function makeCapacity(transaction: Parameters<Parameters<ReturnType<typeof db>["$transaction"]>[0]>[0], userId: string) {
  const count = await transaction.userMemory.count({ where: { userId, status: { not: "ARCHIVED" } } });
  if (count < MEMORY_CONFIG.maximumActiveMemories) return;
  const replaceable = await transaction.userMemory.findFirst({
    where: { userId, status: { in: ["CANDIDATE", "ACTIVE"] }, sourceType: { not: "EXPLICIT" } },
    orderBy: [{ status: "asc" }, { importance: "asc" }, { confidence: "asc" }, { lastObservedAt: "asc" }],
    select: { id: true },
  });
  if (!replaceable) throw new MemoryError("LIMIT_REACHED");
  await transaction.userMemory.update({ where: { id: replaceable.id }, data: { status: "ARCHIVED" } });
}

export async function saveExplicitMemory(input: ExplicitMemoryInput, requestHeaders: Headers, options: MemoryEmbeddingOptions = {}): Promise<MemoryRecord> {
  const userId = await identity(requestHeaders);
  const item = definition(input.category, input.key, input.value);
  const source = boundedText(input.source ?? "Direct user statement", 200);
  const score = importance(item.category, input.importance);
  try {
    const row = await db().$transaction(async (transaction) => {
      const existing = await transaction.userMemory.findUnique({
        where: { userId_category_key: { userId, category: categoryToDb[item.category], key: item.key } },
      });
      if (!existing) await makeCapacity(transaction, userId);
      const now = new Date();
      const memory = await transaction.userMemory.upsert({
        where: { userId_category_key: { userId, category: categoryToDb[item.category], key: item.key } },
        create: {
          userId, category: categoryToDb[item.category], key: item.key, value: item.serialized,
          sourceType: "EXPLICIT", confidence: MEMORY_CONFIG.explicitConfidence, importance: score,
          status: "ACTIVE", evidenceSummary: source, firstObservedAt: now, lastObservedAt: now,
        },
        update: {
          value: item.serialized, sourceType: "EXPLICIT", confidence: MEMORY_CONFIG.explicitConfidence,
          importance: score, status: "ACTIVE", evidenceSummary: source, lastObservedAt: now,
        },
      });
      await transaction.memoryObservation.create({
        data: {
          userId, memoryId: memory.id, observedValue: item.serialized, source,
          evidenceKey: `explicit:${randomUUID()}`, evidenceType: "DECLARATION",
        },
      });
      return memory;
    });
    await persistSemanticEmbedding(row, options);
    return publicMemory(row)!;
  } catch (error) {
    if (error instanceof MemoryError) throw error;
    throw new MemoryError("STORAGE_FAILURE");
  }
}

/** Server-only boundary for Agent/Workflow outcomes. It never accepts a browser
 * identity and never promotes one event into active long-term memory. */
export async function recordMemoryObservation(input: MemoryObservationInput, options: MemoryEmbeddingOptions = {}): Promise<MemoryRecord> {
  const item = definition(input.category, input.key, input.observedValue);
  const userId = boundedText(input.userId, 100);
  const source = boundedText(input.source, 200);
  const evidenceKey = boundedText(input.evidenceKey, 200);
  const sourceType: Exclude<MemorySourceType, "explicit"> = input.sourceType ?? "inferred";
  const score = importance(item.category, input.importance);
  if (!evidenceToDb[input.evidenceType]) throw new MemoryError("INVALID_REQUEST");
  try {
    const row = await db().$transaction(async (transaction) => {
      const user = await transaction.user.findUnique({ where: { id: userId }, select: { id: true } });
      if (!user) throw new MemoryError("MEMORY_NOT_FOUND");
      let memory = await transaction.userMemory.findUnique({
        where: { userId_category_key: { userId, category: categoryToDb[item.category], key: item.key } },
      });
      if (!memory) {
        await makeCapacity(transaction, userId);
        memory = await transaction.userMemory.create({
          data: {
            userId, category: categoryToDb[item.category], key: item.key, value: item.serialized,
            sourceType: sourceToDb[sourceType], confidence: 0, importance: score,
            status: "CANDIDATE", evidenceSummary: `Candidate inferred from ${source}.`,
            firstObservedAt: input.observedAt ?? new Date(), lastObservedAt: input.observedAt ?? new Date(),
          },
        });
      }
      const duplicate = await transaction.memoryObservation.findUnique({
        where: { memoryId_evidenceKey: { memoryId: memory.id, evidenceKey } }, select: { id: true },
      });
      if (duplicate) return memory;
      await transaction.memoryObservation.create({
        data: { userId, memoryId: memory.id, observedValue: item.serialized, source, evidenceKey, evidenceType: evidenceToDb[input.evidenceType], createdAt: input.observedAt },
      });
      if (memory.sourceType === "EXPLICIT") {
        return memory.value === item.serialized
          ? transaction.userMemory.update({ where: { id: memory.id }, data: { lastObservedAt: input.observedAt ?? new Date() } })
          : memory;
      }
      const observations = await transaction.memoryObservation.findMany({
        where: { memoryId: memory.id, userId }, orderBy: { createdAt: "desc" },
        take: MEMORY_CONFIG.maximumObservationsPerMemory + 20,
        select: { id: true, observedValue: true },
      });
      const counts = new Map<string, number>();
      for (const observation of observations.slice(0, MEMORY_CONFIG.maximumObservationsPerMemory)) {
        counts.set(observation.observedValue, (counts.get(observation.observedValue) ?? 0) + 1);
      }
      const winner = [...counts].sort((a, b) => b[1] - a[1])[0] ?? [item.serialized, 1];
      const total = Math.min(observations.length, MEMORY_CONFIG.maximumObservationsPerMemory);
      const dominance = winner[1] / Math.max(1, total);
      const confidence = Math.min(
        MEMORY_CONFIG.maximumInferredConfidence,
        Math.round(20 + winner[1] * 15 + dominance * 20),
      );
      const promoted = winner[1] >= MEMORY_CONFIG.promotionEvidenceCount && dominance >= MEMORY_CONFIG.promotionDominance;
      const updated = await transaction.userMemory.update({
        where: { id: memory.id },
        data: {
          value: winner[0], confidence, importance: score,
          status: memory.status === "ACTIVE" || promoted ? "ACTIVE" : "CANDIDATE",
          sourceType: sourceToDb[sourceType],
          evidenceSummary: `${memory.status === "ACTIVE" || promoted ? "Inferred" : "Candidate"} from ${winner[1]} compatible observations.`,
          lastObservedAt: input.observedAt ?? new Date(),
        },
      });
      const overflow = observations.slice(MEMORY_CONFIG.maximumObservationsPerMemory).map((entry) => entry.id);
      if (overflow.length) await transaction.memoryObservation.deleteMany({ where: { id: { in: overflow }, userId } });
      return updated;
    });
    await persistSemanticEmbedding(row, options);
    return publicMemory(row)!;
  } catch (error) {
    if (error instanceof MemoryError) throw error;
    throw new MemoryError("STORAGE_FAILURE");
  }
}

/** Trusted internal retrieval. Context Builder supplies the authenticated userId. */
export async function retrieveRelevantMemories(input: MemoryRetrievalInput, options: MemoryEmbeddingOptions = {}): Promise<MemoryRecord[]> {
  if (!input.userId || input.userId.length > 100 || !input.request.trim() || input.request.length > 10_000) throw new MemoryError("INVALID_REQUEST");
  const limit = input.limit ?? MEMORY_CONFIG.defaultRetrievalLimit;
  if (!Number.isInteger(limit) || limit < 1 || limit > MEMORY_CONFIG.maximumRetrievalLimit) throw new MemoryError("INVALID_REQUEST");
  const requestedCategories = input.categories?.length ? [...new Set(input.categories)] : inferMemoryCategories(input.request);
  if (requestedCategories.some((category) => !memoryCategorySchema.safeParse(category).success)) throw new MemoryError("INVALID_REQUEST");
  const requestedKeys = new Set<string>();
  for (const raw of input.keys ?? []) {
    for (const category of requestedCategories) {
      try { requestedKeys.add(normalizeMemoryKey(category, raw)); } catch { /* A key may belong to another requested category. */ }
    }
  }
  try {
    const rows = await db().userMemory.findMany({
      where: { userId: input.userId, status: "ACTIVE", category: { in: requestedCategories.map((category) => categoryToDb[category]) } },
      orderBy: [{ importance: "desc" }, { confidence: "desc" }, { lastObservedAt: "desc" }],
      take: MEMORY_CONFIG.maximumActiveMemories,
    });
    const now = input.now ?? new Date();
    const similarities = await semanticSimilarities(rows, input, options);
    return rows
      .map((row) => publicMemory(row, now))
      .filter((row): row is MemoryRecord => Boolean(row))
      .filter((row) =>
        !requestedKeys.size ||
        requestedKeys.has(row.key) ||
        row.category === "learning-pattern" ||
        row.category === "successful-strategy" ||
        row.category === "user-defined",
      )
      .map((row) => ({ row, score: rankMemory(row, input, requestedCategories, requestedKeys, similarities.get(row.id) ?? 0) }))
      .sort((a, b) => b.score - a.score || b.row.lastObservedAt.localeCompare(a.row.lastObservedAt))
      .slice(0, limit)
      .map(({ row }) => row);
  } catch (error) {
    if (error instanceof MemoryError) throw error;
    throw new MemoryError("STORAGE_FAILURE");
  }
}

/** Authenticated retrieval for server routes and user-facing memory inspection. */
export async function retrieveMemories(
  input: Omit<MemoryRetrievalInput, "userId">,
  requestHeaders: Headers,
  options: MemoryEmbeddingOptions = {},
): Promise<MemoryRecord[]> {
  return retrieveRelevantMemories({ ...input, userId: await identity(requestHeaders) }, options);
}

export async function listMemories(options: MemoryListOptions, requestHeaders: Headers): Promise<MemoryRecord[]> {
  const userId = await identity(requestHeaders);
  const category = options.category ? memoryCategorySchema.safeParse(options.category) : undefined;
  const status = options.status ? memoryStatusSchema.safeParse(options.status) : undefined;
  const limit = options.limit ?? 100;
  if (category && !category.success || status && !status.success || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new MemoryError("INVALID_REQUEST");
  try {
    const rows = await db().userMemory.findMany({
      where: { userId, ...(category?.success ? { category: categoryToDb[category.data] } : {}), ...(status?.success ? { status: statusToDb[status.data] } : {}) },
      orderBy: [{ status: "asc" }, { importance: "desc" }, { updatedAt: "desc" }], take: limit,
    });
    return rows.map((row) => publicMemory(row)).filter((row): row is MemoryRecord => Boolean(row));
  } catch { throw new MemoryError("STORAGE_FAILURE"); }
}

export async function updateMemory(id: string, input: MemoryUpdateInput, requestHeaders: Headers, options: MemoryEmbeddingOptions = {}): Promise<MemoryRecord> {
  const userId = await identity(requestHeaders);
  if (!id || id.length > 100 || (input.value === undefined && input.importance === undefined)) throw new MemoryError("INVALID_REQUEST");
  try {
    const row = await db().$transaction(async (transaction) => {
      const existing = await transaction.userMemory.findFirst({ where: { id, userId } });
      if (!existing) throw new MemoryError("MEMORY_NOT_FOUND");
      const category = categoryFromDb[existing.category];
      if (!category) throw new MemoryError("INVALID_REQUEST");
      const score = importance(category, input.importance ?? existing.importance);
      const value = input.value === undefined ? existing.value : definition(category, existing.key, input.value).serialized;
      const updated = await transaction.userMemory.update({
        where: { id }, data: {
          value, importance: score,
          ...(input.value !== undefined ? { sourceType: "EXPLICIT" as const, confidence: MEMORY_CONFIG.explicitConfidence, status: "ACTIVE" as const, lastObservedAt: new Date(), evidenceSummary: "Edited directly by the user." } : {}),
        },
      });
      if (input.value !== undefined) await transaction.memoryObservation.create({ data: { userId, memoryId: id, observedValue: value, source: "User memory edit", evidenceKey: `edit:${randomUUID()}`, evidenceType: "CORRECTION" } });
      return updated;
    });
    await persistSemanticEmbedding(row, options);
    return publicMemory(row)!;
  } catch (error) {
    if (error instanceof MemoryError) throw error;
    throw new MemoryError("STORAGE_FAILURE");
  }
}

export async function archiveMemory(id: string, requestHeaders: Headers): Promise<MemoryRecord> {
  const userId = await identity(requestHeaders);
  if (!id || id.length > 100) throw new MemoryError("INVALID_REQUEST");
  try {
    const updated = await db().userMemory.updateMany({ where: { id, userId }, data: { status: "ARCHIVED" } });
    if (!updated.count) throw new MemoryError("MEMORY_NOT_FOUND");
    const row = await db().userMemory.findFirst({ where: { id, userId } });
    return publicMemory(row!)!;
  } catch (error) {
    if (error instanceof MemoryError) throw error;
    throw new MemoryError("STORAGE_FAILURE");
  }
}

export async function deleteMemory(id: string, requestHeaders: Headers): Promise<{ success: true }> {
  const userId = await identity(requestHeaders);
  if (!id || id.length > 100) throw new MemoryError("INVALID_REQUEST");
  try {
    const deleted = await db().userMemory.deleteMany({ where: { id, userId } });
    if (!deleted.count) throw new MemoryError("MEMORY_NOT_FOUND");
    return { success: true };
  } catch (error) {
    if (error instanceof MemoryError) throw error;
    throw new MemoryError("STORAGE_FAILURE");
  }
}

export class MemoryService {
  constructor(private readonly options: MemoryEmbeddingOptions = {}) {}
  saveExplicit(input: ExplicitMemoryInput, headers: Headers) { return saveExplicitMemory(input, headers, this.options); }
  retrieve(input: Omit<MemoryRetrievalInput, "userId">, headers: Headers) { return retrieveMemories(input, headers, this.options); }
  list(options: MemoryListOptions, headers: Headers) { return listMemories(options, headers); }
  update(id: string, input: MemoryUpdateInput, headers: Headers) { return updateMemory(id, input, headers, this.options); }
  archive(id: string, headers: Headers) { return archiveMemory(id, headers); }
  delete(id: string, headers: Headers) { return deleteMemory(id, headers); }
}
