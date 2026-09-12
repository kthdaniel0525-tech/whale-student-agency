import { api } from "@/server/api";
import { getDocument, deleteDocument } from "@/server/documents/service";
type Context = { params: Promise<{ id: string }> };
export function GET(req: Request, context: Context) {
  return api(req, async (userId) =>
    getDocument(userId, (await context.params).id),
  );
}
export function DELETE(req: Request, context: Context) {
  return api(req, async (userId) =>
    deleteDocument(userId, (await context.params).id),
  );
}
