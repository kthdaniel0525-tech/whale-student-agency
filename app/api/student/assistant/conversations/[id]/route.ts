import { api } from "@/server/api";
import { getAssistantConversation } from "@/server/assistant";

type Context = { params: Promise<{ id: string }> };

export function GET(request: Request, context: Context) {
  return api(request, async () => getAssistantConversation((await context.params).id, request.headers));
}
