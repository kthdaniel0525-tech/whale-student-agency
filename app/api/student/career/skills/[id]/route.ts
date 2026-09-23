import { api, readJson } from "@/server/api";
import { CareerDataService } from "@/server/career/service";
import { skillSchema } from "@/server/career/schemas";
import { refreshRecommendationsBestEffort } from "@/server/recommendations";

type Context = { params: Promise<{ id: string }> };
const service = new CareerDataService();

export function PUT(request: Request, context: Context) {
  return api(request, async (userId) => {
    const skill = await service.saveSkill(await readJson(request, skillSchema), request.headers, (await context.params).id);
    await refreshRecommendationsBestEffort(userId);
    return skill;
  });
}

export function DELETE(request: Request, context: Context) {
  return api(request, async (userId) => {
    const result = await service.deleteSkill((await context.params).id, request.headers);
    await refreshRecommendationsBestEffort(userId);
    return result;
  });
}
