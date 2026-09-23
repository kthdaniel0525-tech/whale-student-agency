import "server-only";
import { z } from "zod";
import { api, readJson, RequestError } from "../api";
import { NotFoundError } from "../services/academic";
import { academicError } from "./errors";
import { academicIntegrationService } from "./service";
import { courseImportRequest, confirmedCourseImport } from "@/lib/student/academic-integrations/types";
export function createAcademicHttp(service = academicIntegrationService) {
    const call = (req: Request, operation: (userId: string) => Promise<unknown>) => api(req, async (userId) => { try {
        return await operation(userId);
    }
    catch (cause) {
        if (cause instanceof z.ZodError || cause instanceof RequestError || cause instanceof NotFoundError)
            throw cause;
        const error = academicError(cause);
        return Response.json({ error: error.message, code: error.code }, { status: error.status, headers: error.code === "PROVIDER_RATE_LIMITED" ? { "Retry-After": "60" } : {} });
    } });
    return {
        settings: (req: Request) => call(req, userId => service.settings(userId)),
        courses: (req: Request, id: string) => call(req, userId => { const input = z.object({ cursor: z.string().min(1).max(2048).optional() }).strict().parse(Object.fromEntries(new URL(req.url).searchParams)); return service.listCourses(userId, id, input.cursor); }),
        preview: (req: Request) => call(req, async (userId) => service.preview(userId, await readJson(req, courseImportRequest))),
        import: (req: Request) => call(req, async (userId) => service.importExternalCourse(userId, await readJson(req, confirmedCourseImport))),
        status: (req: Request, id: string) => call(req, async (userId) => Response.json(await service.status(userId, id))),
        sync: (req: Request, id: string) => call(req, userId => service.requestSync(userId, id)),
        disconnect: (req: Request, id: string) => call(req, userId => service.disconnect(userId, id)),
    };
}
export const academicHttp = createAcademicHttp();
