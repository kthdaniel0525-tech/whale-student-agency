import { api, readJson } from "@/server/api";
import { getExam, updateExam, deleteExam } from "@/server/services/academic";
import { examSchema } from "@/features/student/validation/schemas";
type Context = { params: Promise<{ id: string }> };
export function GET(req: Request, c: Context) {
  return api(req, async (userId) => getExam(userId, (await c.params).id));
}
export function PUT(req: Request, c: Context) {
  return api(req, async (userId) =>
    updateExam(userId, (await c.params).id, await readJson(req, examSchema)),
  );
}
export function DELETE(req: Request, c: Context) {
  return api(req, async (userId) => deleteExam(userId, (await c.params).id));
}
