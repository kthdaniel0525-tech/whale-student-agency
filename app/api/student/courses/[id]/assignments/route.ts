import { api, readJson } from "@/server/api";
import { createAssignment } from "@/server/services/academic";
import { assignmentSchema } from "@/features/student/validation/schemas";
export function POST(
  req: Request,
  context: { params: Promise<{ id: string }> },
) {
  return api(req, async (userId) =>
    createAssignment(
      userId,
      (await context.params).id,
      await readJson(req, assignmentSchema),
    ),
  );
}
