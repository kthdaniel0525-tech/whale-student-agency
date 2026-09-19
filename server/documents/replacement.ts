import "server-only";
import { withAIUsageContext } from "../ai/usage/context";
import { randomUUID } from "node:crypto";
import type { Prisma } from "@/generated/prisma/client";
import { db } from "../db/client";
import { NotFoundError } from "../services/academic";
import { storage } from "./storage/local";
import { validateFile } from "./extraction";
import { prepareDocument, publishDocumentIndex } from "./processing";
import { embeddingProvider, type EmbeddingProvider } from "./embeddings";
import { DocumentError } from "./config";
import { cleanupAfterDelete } from "./cleanup";
/** Shared source replacement for Drive/LMS. Source-specific authorization and leases stay with callers. */
export async function replaceDocumentSource(input: {
    userId: string;
    documentId: string;
    courseId: string;
    fileName: string;
    bytes: Uint8Array;
}, hooks: {
    guard(tx: Prisma.TransactionClient): Promise<void>;
    complete(tx: Prisma.TransactionClient): Promise<void>;
    check?: () => void;
    provider?: EmbeddingProvider;
}) {
    const check = hooks.check ?? (() => { }), fileType = validateFile(input.fileName, input.bytes);
    const prepared = await withAIUsageContext({ userId: input.userId, source: "rag-document" }, () => prepareDocument(input.bytes, fileType, hooks.provider ?? embeddingProvider, check));
    check();
    const key = randomUUID();
    let committed = false;
    try {
        await storage.put(key, input.bytes);
        await db().$transaction(async (tx) => {
            await tx.$queryRaw `SELECT id FROM "User" WHERE id=${input.userId} FOR UPDATE`;
            await hooks.guard(tx);
            await tx.$queryRaw `SELECT id FROM "Document" WHERE id=${input.documentId} AND "userId"=${input.userId} FOR UPDATE`;
            const current = await tx.document.findFirst({ where: { id: input.documentId, userId: input.userId, courseId: input.courseId } });
            if (!current)
                throw new NotFoundError();
            if (current.processingStatus === "PROCESSING")
                throw new DocumentError("Document processing is already in progress.", 409);
            const usage = await tx.document.aggregate({ where: { userId: input.userId }, _sum: { fileSize: true } });
            if ((usage._sum.fileSize ?? 0) - current.fileSize + input.bytes.length > 100 * 1024 * 1024)
                throw new DocumentError("Your library storage limit is 100 MB.");
            await publishDocumentIndex(tx, current, prepared);
            check();
            await tx.document.update({ where: { id: current.id }, data: { storageKey: key, originalFileName: input.fileName, fileType, fileSize: input.bytes.length, pageCount: prepared.pages.length, embeddingModel: prepared.embeddingModel, processingStatus: "READY", processingError: null, leaseToken: null, leaseExpiresAt: null, attempts: 0 } });
            await tx.fileDeletion.upsert({ where: { storageKey: current.storageKey }, create: { storageKey: current.storageKey, userId: input.userId }, update: {} });
            await hooks.complete(tx);
        }, { timeout: 60000 });
        committed = true;
        await cleanupAfterDelete(input.userId);
    }
    finally {
        if (!committed) {
            const referenced = await db().document.findUnique({ where: { storageKey: key }, select: { id: true } }).then(Boolean).catch(() => true);
            if (!referenced)
                await storage.remove(key).catch(() => { });
        }
    }
}
