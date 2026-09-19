import "server-only";
import { withAIUsageContext } from "../ai/usage/context";
import { randomUUID } from "node:crypto";
import { db } from "@/server/db/client";
import { storage } from "./storage/local";
import { prepareDocument, publishDocumentIndex } from "./processing";
import {
  embeddingProvider,
  type EmbeddingProvider,
} from "./embeddings";
import { DocumentError } from "./config";
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
        const bytes = await storage.get(claim.storageKey);
        const prepared = await withAIUsageContext({ userId: claim.userId, source: "rag-document" }, () => prepareDocument(bytes, claim.fileType, provider, checkDeadline));
        await db().$transaction(
          async (tx) => {
            const rows = await tx.$queryRaw<
              { id: string; courseId: string | null; title: string }[]
            >`SELECT id,"courseId",title FROM "Document" WHERE id=${claim.id} AND "userId"=${claim.userId} AND "leaseToken"=${token} AND "processingStatus"='PROCESSING' AND "leaseExpiresAt">NOW() FOR UPDATE`;
            if (!rows.length) return; // Deleted or superseded workers may never publish results.
            checkDeadline();
            const document = rows[0];
            await publishDocumentIndex(tx, { ...document, userId: claim.userId }, prepared);
            checkDeadline();
            await tx.document.update({
              where: { id_userId: { id: claim.id, userId: claim.userId } },
              data: {
                processingStatus: "READY",
                processingError: null,
                pageCount: prepared.pages.length,
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
