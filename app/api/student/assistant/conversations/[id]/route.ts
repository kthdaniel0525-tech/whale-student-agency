import { api } from "@/server/api";
import { getAssistantConversation } from "@/server/assistant";
import { deleteConversation } from "@/server/conversations";

type Context = { params: Promise<{ id: string }> };

export function GET(request: Request, context: Context) {
  return api(request, async () => getAssistantConversation((await context.params).id, request.headers));
}

export function DELETE(request: Request, context: Context) {
  return api(request, async () => {
    await deleteConversation((await context.params).id, request.headers);
    return { success: true };
  });
}
