import { api } from "@/server/api";
import { retryDocument } from "@/server/documents/service";
export function POST(req: Request, c: { params: Promise<{ id: string }> }) {
  return api(req, async (userId) => retryDocument(userId, (await c.params).id));
}
