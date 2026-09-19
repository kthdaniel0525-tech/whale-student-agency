import "server-only";
import { z } from "zod";
export function academicSyncConfig() {
    const env = z.object({ ACADEMIC_SYNC_MINUTES: z.coerce.number().int().min(30).max(1440).default(180), ACADEMIC_FILE_SYNC_HOURS: z.coerce.number().int().min(6).max(168).default(24), ACADEMIC_SYNC_CRON: z.string().min(1).max(100).default("23 * * * *") }).parse(process.env);
    return { intervalMs: env.ACADEMIC_SYNC_MINUTES * 60000, fileIntervalMs: env.ACADEMIC_FILE_SYNC_HOURS * 3600000, cron: env.ACADEMIC_SYNC_CRON, pageSize: 25, maxItems: 100, maxFiles: 20, maxPages: 8, timeoutMs: 480000 };
}
