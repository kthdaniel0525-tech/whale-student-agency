import "server-only";
import { randomUUID } from "node:crypto";
import type { Prisma } from "@/generated/prisma/client";
import { extractPages } from "./extraction";
import { chunkPages } from "./chunking";
import { validateEmbedding, type EmbeddingProvider } from "./embeddings";
import { DocumentError, MAX_CHUNKS } from "./config";
/** Shared by uploads and atomic source replacement. Preparation never changes active data. */
export async function prepareDocument(bytes: Uint8Array, fileType: string, provider: EmbeddingProvider, check = () => { }) {
    // PDF.js transfers its buffer to the worker; retain the original bytes for source replacement.
    const pages = await extractPages(fileType === "PDF" ? bytes.slice() : bytes, fileType);
    check();
    const chunks = chunkPages(pages);
    if (!chunks.length || chunks.length > MAX_CHUNKS)
        throw new DocumentError("This document is empty or too long to index. Split it into smaller files.");
    const embeddings: number[][] = [];
    for (const chunk of chunks) {
        embeddings.push(validateEmbedding(await provider.generateEmbedding(chunk.content)));
        check();
    }
    return { pages, chunks, embeddings, embeddingModel: provider.id };
}
/** Caller holds the document row lock and verifies its lease before publishing. */
export async function publishDocumentIndex(tx: Prisma.TransactionClient, document: {
    id: string;
    userId: string;
    courseId: string | null;
    title: string;
}, prepared: Awaited<ReturnType<typeof prepareDocument>>) {
    const { pages, chunks, embeddings, embeddingModel } = prepared;
    await tx.documentChunk.deleteMany({ where: { documentId: document.id, userId: document.userId } });
    await tx.documentPage.deleteMany({ where: { documentId: document.id, userId: document.userId } });
    await tx.documentPage.createMany({ data: pages.map(page => ({ ...page, documentId: document.id, userId: document.userId })) });
    for (const chunk of chunks) {
        const vector = JSON.stringify(embeddings[chunk.chunkIndex]);
        const metadata = JSON.stringify({ documentTitle: document.title, courseId: document.courseId,
            chunkIndex: chunk.chunkIndex, pageNumber: chunk.pageNumber, pageEnd: chunk.pageEnd,
            tokenEstimate: "unicode-characters/4", chunkerVersion: 1 });
        await tx.$executeRaw `INSERT INTO "DocumentChunk" (id,"documentId","userId","courseId","chunkIndex",content,"pageNumber","pageEnd","tokenCount",embedding,"embeddingModel",metadata)
      VALUES (${randomUUID()},${document.id},${document.userId},${document.courseId},${chunk.chunkIndex},${chunk.content},${chunk.pageNumber},${chunk.pageEnd},${chunk.tokenCount},${vector}::vector,${embeddingModel},${metadata}::jsonb)`;
    }
}
