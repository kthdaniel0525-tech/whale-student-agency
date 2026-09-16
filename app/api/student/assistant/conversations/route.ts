import { z } from "zod";
import { api, readJson } from "@/server/api";
import { createAssistantConversation, listAssistantConversations } from "@/server/assistant";

const createSchema = z.object({ courseId: z.string().min(1).max(100).optional() }).strict();

export function GET(request: Request) {
  return api(request, () => listAssistantConversations(request.headers));
}

export function POST(request: Request) {
  return api(request, async () => createAssistantConversation(await readJson(request, createSchema), request.headers));
}
