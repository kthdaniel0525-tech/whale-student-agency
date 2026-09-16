import "server-only";
import { Prisma } from "@/generated/prisma/client";
import { db } from "@/server/db/client";
import {
  embeddingProvider,
  validateEmbedding,
  type EmbeddingProvider,
} from "../embeddings";
import { documentConfig, DocumentError } from "../config";
import { assertCourse, getDocument } from "../service";
import { retrievalSchema } from "@/features/documents/validation/schemas";
import { recordRagCall } from "@/server/observability/request-metrics";
export type RetrievedChunk = {
  id: string;
  content: string;
  documentTitle: string;
  documentId: string;
  pageNumber: number | null;
  pageEnd: number | null;
  courseId: string | null;
  courseCode: string | null;
  chunkIndex: number;
  similarityScore: number;
};
export async function retrieveAcademicContext(
  userId: string,
  request: unknown,
  provider: EmbeddingProvider = embeddingProvider,
): Promise<RetrievedChunk[]> {
  recordRagCall();
  const input = retrievalSchema.parse(request);
  if (input.courseId) await assertCourse(userId, input.courseId);
  if (input.documentIds)
    for (const id of input.documentIds) {
      const document = await getDocument(userId, id);
      if (input.courseId && document.courseId !== input.courseId)
        throw new DocumentError(
          "Selected documents must belong to the selected course.",
        );
    }
  const courseFilter = input.courseId
    ? Prisma.sql`AND d."courseId"=${input.courseId}`
    : Prisma.empty;
  const documentFilter = input.documentIds
    ? Prisma.sql`AND d.id IN (${Prisma.join(input.documentIds)})`
    : Prisma.empty;
  const available = await db().document.count({
    where: {
      userId,
      processingStatus: "READY",
      embeddingModel: provider.id,
      ...(input.courseId ? { courseId: input.courseId } : {}),
      ...(input.documentIds ? { id: { in: input.documentIds } } : {}),
    },
  });
  if (!available) return [];
  let vector: string;
  try {
    vector = JSON.stringify(
      validateEmbedding(await provider.generateEmbedding(input.query)),
    );
  } catch {
    throw new DocumentError(
      "Semantic search is unavailable. Check that the embedding model has been prepared.",
      503,
    );
  }
  // MATERIALIZED guarantees tenant/course filtering precedes exact similarity ranking.
  const rows = await db().$queryRaw<RetrievedChunk[]>(Prisma.sql`
    WITH authorized AS MATERIALIZED (
      SELECT c.id,c.content,c.embedding,c."chunkIndex",c."pageNumber",c."pageEnd",d.id AS "documentId",d.title AS "documentTitle",d."courseId",co."courseCode"
      FROM "DocumentChunk" c JOIN "Document" d ON d.id=c."documentId" AND d."userId"=c."userId"
      LEFT JOIN "Course" co ON co.id=d."courseId" AND co."userId"=d."userId"
      WHERE c."userId"=${userId} AND d."userId"=${userId} AND d."processingStatus"='READY'
      AND c."embeddingModel"=${provider.id} AND d."embeddingModel"=${provider.id} ${courseFilter} ${documentFilter}
    )
    SELECT id,content,"chunkIndex","pageNumber","pageEnd","documentId","documentTitle","courseId","courseCode",1-(embedding <=> ${vector}::vector) AS "similarityScore"
    FROM authorized WHERE 1-(embedding <=> ${vector}::vector)>=${documentConfig().similarity}
    ORDER BY embedding <=> ${vector}::vector,id LIMIT ${input.maxResults * 4}
  `);
  const seen = new Set<string>();
  const result: RetrievedChunk[] = [];
  for (const row of rows) {
    const normalized = row.content.toLowerCase().replace(/\s+/g, " ").trim();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(row);
    if (result.length >= input.maxResults) break;
  }
  return result;
}
export async function documentSections(
  userId: string,
  documentId: string,
  fromPage = 1,
  toPage = 200,
) {
  const document = await getDocument(userId, documentId);
  if (document.processingStatus !== "READY")
    throw new DocumentError("Wait until this document is ready.", 409);
  const pages = await db().documentPage.findMany({
    where: { userId, documentId, pageNumber: { gte: fromPage, lte: toPage } },
    select: { pageNumber: true, content: true },
    orderBy: { pageNumber: "asc" },
  });
  return {
    documentId,
    documentTitle: document.title,
    courseId: document.courseId,
    pages,
  };
}
export async function fullDocumentText(userId: string, documentId: string) {
  const sections = await documentSections(userId, documentId);
  return {
    ...sections,
    content: sections.pages.map((page) => page.content).join("\n\n"),
  };
}
export async function neighboringChunks(
  userId: string,
  documentId: string,
  chunkIndex: number,
) {
  await getDocument(userId, documentId);
  return db().documentChunk.findMany({
    where: {
      userId,
      documentId,
      chunkIndex: { gte: Math.max(0, chunkIndex - 1), lte: chunkIndex + 1 },
      document: { processingStatus: "READY" },
    },
    select: {
      id: true,
      content: true,
      chunkIndex: true,
      pageNumber: true,
      pageEnd: true,
    },
    orderBy: { chunkIndex: "asc" },
  });
}
