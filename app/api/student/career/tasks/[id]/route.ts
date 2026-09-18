import { z } from "zod";
import { api, readJson } from "@/server/api";
import { CareerPlanService } from "@/server/career/plan-service";
import { refreshRecommendationsBestEffort } from "@/server/recommendations";

type Context = { params: Promise<{ id: string }> };
const schema = z.object({ status: z.enum(["planned", "in-progress", "completed", "skipped"]) }).strict();

export function PATCH(request: Request, context: Context) {
  return api(request, async (userId) => {
    const input = await readJson(request, schema);
    const task = await new CareerPlanService().updateTaskStatus((await context.params).id, input.status, request.headers);
    await refreshRecommendationsBestEffort(userId);
    return task;
  });
}
