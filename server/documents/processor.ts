import "server-only";
import { randomUUID } from "node:crypto";
import { db } from "@/server/db/client";
import { storage } from "./storage/local";
import { extractPages } from "./extraction";
import { chunkPages } from "./chunking";
import {
  embeddingProvider,
  validateEmbedding,
  type EmbeddingProvider,
} from "./embeddings";
import { DocumentError, MAX_CHUNKS } from "./config";
import { refreshRecommendationsBestEffort } from "@/server/recommendations";
type Claim = {
  id: string;
  userId: string;
  storageKey: string;
  fileType: string;
  leaseToken: string;
};
export async function processNextDocument(
  provider: EmbeddingProvider = embeddingProvider,
  specificId?: string,
  timeoutMs = 120000,
) {
  await db().document.updateMany({
    where: {
      processingStatus: "PROCESSING",
      leaseExpiresAt: { lt: new Date() },
      attempts: { gte: 3 },
    },
    data: {
      processingStatus: "FAILED",
      processingError: "Processing was interrupted repeatedly. Please retry.",
      leaseToken: null,
      leaseExpiresAt: null,
    },
  });
  const token = randomUUID();
  const claims = await db().$queryRaw<Claim[]>`
    UPDATE "Document" SET "processingStatus"='PROCESSING', "leaseToken"=${token}, "leaseExpiresAt"=NOW()+INTERVAL '2 minutes', attempts=attempts+1, "updatedAt"=NOW()
    WHERE id=(SELECT id FROM "Document" WHERE "uploadedAt" IS NOT NULL
      AND (${specificId || null}::text IS NULL OR id=${specificId || null})
      AND ("processingStatus"='UPLOADED' OR ("processingStatus"='PROCESSING' AND "leaseExpiresAt"<NOW() AND attempts<3))
      ORDER BY "createdAt" LIMIT 1 FOR UPDATE SKIP LOCKED)
    RETURNING id,"userId","storageKey","fileType","leaseToken"
  `;
  const claim = claims[0];
  if (!claim) return false;
  const heartbeat = setInterval(() => {
    void db()
      .document.updateMany({
        where: {
          id: claim.id,
          userId: claim.userId,
          leaseToken: token,
          processingStatus: "PROCESSING",
        },
        data: { leaseExpiresAt: new Date(Date.now() + 120000) },
      })
      .catch(() => {});
  }, 20000);
  let expired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const checkDeadline = () => {
    if (expired)
      throw new DocumentError(
        "Processing took too long. Try a smaller document or retry.",
      );
  };
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      expired = true;
      reject(
        new DocumentError(
          "Processing took too long. Try a smaller document or retry.",
        ),
      );
    }, timeoutMs);
  });
  try {
    await Promise.race([
      deadline,
      (async () => {
        const pages = await extractPages(
          await storage.get(claim.storageKey),
          claim.fileType,
        );
        checkDeadline();
        const chunks = chunkPages(pages);
        if (!chunks.length || chunks.length > MAX_CHUNKS)
          throw new DocumentError(
            "This document is empty or too long to index. Split it into smaller files.",
          );
        const embeddings: number[][] = [];
        for (const chunk of chunks) {
          embeddings.push(
            validateEmbedding(await provider.generateEmbedding(chunk.content)),
          );
          checkDeadline();
        }
        await db().$transaction(
          async (tx) => {
            const rows = await tx.$queryRaw<
              { id: string; courseId: string | null; title: string }[]
            >`SELECT id,"courseId",title FROM "Document" WHERE id=${claim.id} AND "userId"=${claim.userId} AND "leaseToken"=${token} AND "processingStatus"='PROCESSING' AND "leaseExpiresAt">NOW() FOR UPDATE`;
            if (!rows.length) return; // Deleted or superseded workers may never publish results.
            checkDeadline();
            const document = rows[0];
            await tx.documentChunk.deleteMany({
              where: { documentId: claim.id, userId: claim.userId },
            });
            await tx.documentPage.deleteMany({
              where: { documentId: claim.id, userId: claim.userId },
            });
            await tx.documentPage.createMany({
              data: pages.map((page) => ({
                ...page,
                documentId: claim.id,
                userId: claim.userId,
              })),
            });
            for (const chunk of chunks) {
              const vector = JSON.stringify(embeddings[chunk.chunkIndex]);
              const metadata = JSON.stringify({
                documentTitle: document.title,
                courseId: document.courseId,
                chunkIndex: chunk.chunkIndex,
                pageNumber: chunk.pageNumber,
                pageEnd: chunk.pageEnd,
                tokenEstimate: "unicode-characters/4",
                chunkerVersion: 1,
              });
              await tx.$executeRaw`INSERT INTO "DocumentChunk" (id,"documentId","userId","courseId","chunkIndex",content,"pageNumber","pageEnd","tokenCount",embedding,"embeddingModel",metadata)
          VALUES (${randomUUID()},${claim.id},${claim.userId},${document.courseId},${chunk.chunkIndex},${chunk.content},${chunk.pageNumber},${chunk.pageEnd},${chunk.tokenCount},${vector}::vector,${provider.id},${metadata}::jsonb)`;
            }
            checkDeadline();
            await tx.document.update({
              where: { id_userId: { id: claim.id, userId: claim.userId } },
              data: {
                processingStatus: "READY",
                processingError: null,
                pageCount: pages.length,
                embeddingModel: provider.id,
                leaseToken: null,
                leaseExpiresAt: null,
              },
            });
          },
          { timeout: 60000 },
        );
      })(),
    ]);
    await refreshRecommendationsBestEffort(claim.userId);
  } catch (e) {
    await db().document.updateMany({
      where: {
        id: claim.id,
        userId: claim.userId,
        leaseToken: token,
        processingStatus: "PROCESSING",
      },
      data: {
        processingStatus: "FAILED",
        processingError:
          e instanceof DocumentError
            ? e.message
            : "Processing could not finish. Check the document service and try again.",
        leaseToken: null,
        leaseExpiresAt: null,
      },
    });
    console.error("Document processing failed", {
      documentId: claim.id,
      type: e instanceof Error ? e.name : "UnknownError",
    });
  } finally {
    clearInterval(heartbeat);
    clearTimeout(timer);
  }
  return true;
}
