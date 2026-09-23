import { api } from "@/server/api";
import { getAssistantQuiz } from "@/server/assistant";

type Context = { params: Promise<{ id: string }> };

export function GET(request: Request, context: Context) {
  return api(request, async () => getAssistantQuiz((await context.params).id, request.headers));
}
