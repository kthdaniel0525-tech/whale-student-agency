import { api, readJson } from "@/server/api";
import { CareerDataService } from "@/server/career/service";
import { skillSchema } from "@/server/career/schemas";
import { refreshRecommendationsBestEffort } from "@/server/recommendations";

const service = new CareerDataService();

export function GET(request: Request) {
  return api(request, () => service.listSkills(request.headers));
}

export function POST(request: Request) {
  return api(request, async (userId) => {
    const skill = await service.saveSkill(await readJson(request, skillSchema), request.headers);
    await refreshRecommendationsBestEffort(userId);
    return skill;
  });
}
