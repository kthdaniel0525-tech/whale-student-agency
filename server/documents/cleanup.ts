import "server-only";
import { db } from "@/server/db/client";
import { storage, oldStorageKeys } from "./storage/local";
// Deletion has already committed. A cleanup outage must not make it appear to have failed.
export async function cleanupAfterDelete(userId: string) {
  try {
    return (await cleanupFiles(userId)) > 0;
  } catch {
    console.error("Immediate document cleanup deferred to worker.");
    return true;
  }
}
export async function cleanupFiles(userId?: string) {
  const jobs = await db().fileDeletion.findMany({
    where: { ...(userId ? { userId } : {}), retryAt: { lte: new Date() } },
    take: 100,
    orderBy: { createdAt: "asc" },
  });
  for (const job of jobs) {
    try {
      await storage.remove(job.storageKey);
      await db().fileDeletion.deleteMany({
        where: { id: job.id, userId: job.userId },
      });
    } catch {
      await db().fileDeletion.updateMany({
        where: { id: job.id, userId: job.userId },
        data: {
          attempts: { increment: 1 },
          retryAt: new Date(Date.now() + 60000),
        },
      });
    }
  }
  return db().fileDeletion.count({ where: userId ? { userId } : {} });
}
export async function reconcileStorage() {
  for (const key of await oldStorageKeys()) {
    if (
      !(await db().document.findUnique({
        where: { storageKey: key },
        select: { id: true },
      }))
    )
      await storage.remove(key);
  }
  // An upload transaction that died is never visible, and its aged file is handled above.
}
