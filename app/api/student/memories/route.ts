import { api } from "@/server/api";
import { listMemories } from "@/server/memory";

export function GET(request: Request) {
  return api(request, () => listMemories({ limit: 100 }, request.headers));
}
