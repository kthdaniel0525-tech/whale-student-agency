import { z } from "zod";
import { api, readJson } from "@/server/api";
import { completeRecommendation, dismissRecommendation } from "@/server/recommendations";

const actionSchema = z.object({ action: z.enum(["dismiss", "complete"]) }).strict();
type Context = { params: Promise<{ id: string }> };

export function PATCH(request: Request, context: Context) {
  return api(request, async (userId) => {
    const id = (await context.params).id;
    const { action } = await readJson(request, actionSchema);
    return action === "dismiss"
      ? dismissRecommendation(userId, id)
      : completeRecommendation(userId, id);
  });
}
