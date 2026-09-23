import { api, readJson } from "@/server/api";
import { createExam } from "@/server/services/academic";
import { examSchema } from "@/features/student/validation/schemas";
export function POST(
  req: Request,
  context: { params: Promise<{ id: string }> },
) {
  return api(req, async (userId) =>
    createExam(
      userId,
      (await context.params).id,
      await readJson(req, examSchema),
    ),
  );
}
