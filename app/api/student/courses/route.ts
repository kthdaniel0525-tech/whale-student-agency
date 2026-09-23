import { api, readJson } from "@/server/api";
import { listCourses, createCourse } from "@/server/services/academic";
import { courseSchema } from "@/features/student/validation/schemas";
export function GET(req: Request) {
  return api(req, listCourses);
}
export function POST(req: Request) {
  return api(req, async (userId) =>
    createCourse(userId, await readJson(req, courseSchema)),
  );
}
