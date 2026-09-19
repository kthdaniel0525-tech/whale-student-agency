import "server-only";
import { z } from "zod";
import { revalidatePath } from "next/cache";
import { api, readJson, RequestError } from "../api";
import { safeIntegrationError } from "../integrations/errors";
import { googleCalendarService, calendarSelectionSchema } from "./service";
import { calendarWriteService } from "./writes";
import { enqueueGoogleCalendarSync } from "../jobs/sync-google-calendar";
const actionSchema = z.object({ connectedAccountId: z.string().min(1).max(100), calendarId: z.string().min(1).max(1024), action: z.enum(["create", "update", "remove"]), confirmed: z.literal(true) }).strict();
export function createCalendarHttpHandlers(calendar = googleCalendarService, writes = calendarWriteService, enqueue = enqueueGoogleCalendarSync) {
    const call = (request: Request, operation: (userId: string) => Promise<unknown>) => api(request, async (userId) => {
        try {
            return await operation(userId);
        }
        catch (cause) {
            if (cause instanceof z.ZodError || cause instanceof RequestError)
                throw cause;
            const error = safeIntegrationError(cause);
            return Response.json({ error: error.message, code: error.code }, { status: error.status, headers: { "Cache-Control": "private, no-store", ...(error.retryAfterSeconds ? { "Retry-After": String(error.retryAfterSeconds) } : {}) } });
        }
    });
    return {
        settings: (request: Request, id: string) => call(request, userId => calendar.getSettings(userId, id, new URL(request.url).searchParams.get("discover") === "true")),
        select: (request: Request, id: string) => call(request, async (userId) => { const selection = await readJson(request, calendarSelectionSchema); const result = await calendar.saveSelection(userId, id, selection); await enqueue(id); revalidatePath("/student/settings"); return result; }),
        refresh: (request: Request, id: string) => call(request, async (userId) => { await calendar.using(userId, id, "calendar-read", async () => { }); return enqueue(id); }),
        task: (request: Request, id: string) => call(request, userId => writes.getTaskOptions(userId, id)),
        schedule: (request: Request, id: string) => call(request, async (userId) => { const input = await readJson(request, z.object({ localStart: z.string().max(19) }).strict()); const result = await writes.scheduleTask(userId, id, input.localStart); revalidatePath("/student/study-plan"); return result; }),
        mutate: (request: Request, id: string) => call(request, async (userId) => { const body = await readJson(request, actionSchema); const input = { userId, studyTaskId: id, connectedAccountId: body.connectedAccountId, calendarId: body.calendarId }; const result = await (body.action === "create" ? writes.createStudyCalendarEvent(input) : body.action === "update" ? writes.updateStudyCalendarEvent(input) : writes.removeStudyCalendarEvent(input)); revalidatePath("/student/study-plan"); return result; }),
    };
}
export const calendarHttp = createCalendarHttpHandlers();
