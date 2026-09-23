import { api } from "@/server/api";
import { getCourseWorkspace } from "@/server/course-workspace";

export function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return api(request, async (userId) =>
    getCourseWorkspace(userId, (await context.params).id, request.headers),
  );
}
