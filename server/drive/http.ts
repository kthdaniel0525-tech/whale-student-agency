import "server-only";
import { z } from "zod";
import { api, readJson, RequestError } from "../api";
import { DocumentError } from "../documents/config";
import { NotFoundError } from "../services/academic";
import { safeIntegrationError } from "../integrations/errors";
import { driveListSchema, driveResourceSchema } from "@/lib/student/drive/types";
import { googleDriveService } from "./google";
import { checkExternalFileFreshness, getDriveSettings, listDriveImports, requestDriveImport, requestDriveRefresh, type DriveEnqueue } from "./service";
export function createDriveHttp(publish?: DriveEnqueue) {
    const call = (req: Request, operation: (userId: string) => Promise<unknown>) => api(req, async (userId) => {
        try {
            return await operation(userId);
        }
        catch (cause) {
            if (cause instanceof z.ZodError || cause instanceof RequestError || cause instanceof DocumentError || cause instanceof NotFoundError)
                throw cause;
            const error = safeIntegrationError(cause);
            return Response.json({ error: error.message, code: error.code }, { status: error.status });
        }
    });
    return {
        settings: (req: Request, id: string) => call(req, userId => getDriveSettings(userId, id)),
        files: (req: Request, id: string) => call(req, userId => googleDriveService.list(userId, id, driveListSchema.parse(Object.fromEntries(new URL(req.url).searchParams)))),
        imports: (req: Request, id: string) => call(req, userId => { const { courseId } = z.object({ courseId: z.string().min(1).max(100).optional() }).strict().parse(Object.fromEntries(new URL(req.url).searchParams)); return listDriveImports(userId, id, courseId); }),
        import: (req: Request) => call(req, async (userId) => requestDriveImport(userId, await readJson(req, driveResourceSchema), publish)),
        freshness: (req: Request, id: string) => call(req, userId => checkExternalFileFreshness(userId, id)),
        refresh: (req: Request, id: string) => call(req, userId => requestDriveRefresh(userId, id, publish)),
    };
}
export const driveHttp = createDriveHttp();
