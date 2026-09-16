import "server-only";
import { randomUUID } from "node:crypto";
import { db } from "@/server/db/client";
import { NotFoundError } from "@/server/services/academic";
import { storage } from "./storage/local";
import { validateFile } from "./extraction";
import { DocumentError } from "./config";
import { cleanupAfterDelete } from "./cleanup";
import { uploadMetadata } from "@/features/documents/validation/schemas";
import { refreshRecommendationsBestEffort } from "@/server/recommendations";
export const documentSelect = {
  id: true,
  title: true,
  originalFileName: true,
  fileType: true,
  fileSize: true,
  courseId: true,
  processingStatus: true,
  processingError: true,
  pageCount: true,
  embeddingModel: true,
  createdAt: true,
  updatedAt: true,
  course: { select: { id: true, courseCode: true, courseName: true } },
  _count: { select: { chunks: true } },
} as const;
export async function getDocument(userId: string, id: string) {
  const document = await db().document.findUnique({
    where: { id_userId: { id, userId } },
    select: documentSelect,
  });
  if (!document) throw new NotFoundError();
  return document;
}
export async function assertCourse(userId: string, courseId: string) {
  if (
    !(await db().course.findUnique({
      where: { id_userId: { id: courseId, userId } },
      select: { id: true },
    }))
  )
    throw new NotFoundError();
}
export async function listDocuments(userId: string, courseId?: string) {
  if (courseId) await assertCourse(userId, courseId);
  return db().document.findMany({
    where: { userId, ...(courseId ? { courseId } : {}) },
    select: documentSelect,
    orderBy: { createdAt: "desc" },
    take: 100,
  });
}
export async function uploadDocument(
  userId: string,
  metadata: unknown,
  fileName: string,
  bytes: Uint8Array,
) {
  const input = uploadMetadata.parse(metadata);
  const fileType = validateFile(fileName, bytes);
  const key = randomUUID();
  try {
    const result = await db().$transaction(
      async (tx) => {
        // Serialize quotas and hold parent locks through file publication, avoiding a delete/upload race.
        await tx.$queryRaw`SELECT id FROM "User" WHERE id=${userId} FOR UPDATE`;
        if (input.courseId) {
          const courses = await tx.$queryRaw<
            { id: string }[]
          >`SELECT id FROM "Course" WHERE id=${input.courseId} AND "userId"=${userId} FOR KEY SHARE`;
          if (!courses.length) throw new NotFoundError();
        }
        const usage = await tx.document.aggregate({
          where: { userId },
          _sum: { fileSize: true },
          _count: true,
        });
        if (
          usage._count >= 100 ||
          (usage._sum.fileSize || 0) + bytes.length > 100 * 1024 * 1024
        )
          throw new DocumentError(
            "Your library limit is 100 documents or 100 MB. Delete a document before uploading more.",
            409,
          );
        await storage.put(key, bytes);
        return tx.document.create({
          data: {
            ...input,
            userId,
            originalFileName: fileName,
            fileType,
            fileSize: bytes.length,
            storageKey: key,
            uploadedAt: new Date(),
          },
          select: documentSelect,
        });
      },
      { timeout: 15000 },
    );
    return result;
  } catch (e) {
    await storage.remove(key).catch(() => {});
    throw e;
  }
}
export async function deleteDocument(userId: string, id: string) {
  const result = await db().document.deleteMany({ where: { id, userId } });
  if (!result.count) throw new NotFoundError();
  const cleanupPending = await cleanupAfterDelete(userId);
  await refreshRecommendationsBestEffort(userId);
  return { success: true, cleanupPending };
}
export async function retryDocument(userId: string, id: string) {
  await getDocument(userId, id);
  const result = await db().document.updateMany({
    where: { id, userId, processingStatus: "FAILED" },
    data: {
      processingStatus: "UPLOADED",
      processingError: null,
      attempts: 0,
      leaseToken: null,
      leaseExpiresAt: null,
    },
  });
  if (!result.count)
    throw new DocumentError(
      "Only failed documents can be retried. Processing may already be in progress.",
      409,
    );
  return getDocument(userId, id);
}
export async function originalFile(userId: string, id: string) {
  const document = await db().document.findUnique({
    where: { id_userId: { id, userId } },
  });
  if (!document) throw new NotFoundError();
  try {
    return { document, bytes: await storage.get(document.storageKey) };
  } catch {
    throw new DocumentError(
      "The original file is unavailable. Please upload it again.",
      503,
    );
  }
}
