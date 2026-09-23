import { z } from "zod";
import { api, readJson } from "@/server/api";
import { updateAssistantStudyTask } from "@/server/assistant";

type Context = { params: Promise<{ id: string }> };
const inputSchema = z.object({ status: z.enum(["planned", "in-progress", "completed", "skipped"]) }).strict();

export function PATCH(request: Request, context: Context) {
  return api(request, async () => {
    const input = await readJson(request, inputSchema);
    return updateAssistantStudyTask((await context.params).id, input.status, request.headers);
  });
}
