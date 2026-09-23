import { api, readJson } from "@/server/api";
import {
  getAssignment,
  updateAssignment,
  deleteAssignment,
} from "@/server/services/academic";
import {
  assignmentSchema,
  statusSchema,
} from "@/features/student/validation/schemas";
type Context = { params: Promise<{ id: string }> };
export function GET(req: Request, c: Context) {
  return api(req, async (userId) => getAssignment(userId, (await c.params).id));
}
export function PUT(req: Request, c: Context) {
  return api(req, async (userId) =>
    updateAssignment(
      userId,
      (await c.params).id,
      await readJson(req, assignmentSchema),
    ),
  );
}
export function DELETE(req: Request, c: Context) {
  return api(req, async (userId) =>
    deleteAssignment(userId, (await c.params).id),
  );
}
export function PATCH(req: Request, c: Context) {
  return api(req, async (userId) =>
    updateAssignment(
      userId,
      (await c.params).id,
      await readJson(req, statusSchema),
    ),
  );
}
