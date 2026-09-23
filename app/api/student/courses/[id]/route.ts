import { api, readJson } from "@/server/api";
import {
  getCourse,
  updateCourse,
  deleteCourse,
} from "@/server/services/academic";
import { courseSchema } from "@/features/student/validation/schemas";
type Context = { params: Promise<{ id: string }> };
export function GET(req: Request, context: Context) {
  return api(req, async (userId) =>
    getCourse(userId, (await context.params).id),
  );
}
export function PUT(req: Request, context: Context) {
  return api(req, async (userId) =>
    updateCourse(
      userId,
      (await context.params).id,
      await readJson(req, courseSchema),
    ),
  );
}
export function DELETE(req: Request, context: Context) {
  return api(req, async (userId) =>
    deleteCourse(userId, (await context.params).id),
  );
}
