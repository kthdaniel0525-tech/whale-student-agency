import { z } from "zod";
import { api, readJson } from "@/server/api";
import { resumeAssistantWorkflow } from "@/server/assistant";

type Context = { params: Promise<{ id: string }> };

export function POST(request: Request, context: Context) {
  return api(request, async (userId) => resumeAssistantWorkflow(userId, (await context.params).id, await readJson(request, z.unknown()), request.headers));
}
