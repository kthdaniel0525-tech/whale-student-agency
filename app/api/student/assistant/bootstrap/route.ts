import { api } from "@/server/api";
import { getAssistantBootstrap } from "@/server/assistant";

export function GET(request: Request) {
  return api(request, (userId) => getAssistantBootstrap(userId));
}
