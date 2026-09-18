import { api, readJson } from "@/server/api";
import { CareerDataService } from "@/server/career/service";
import { projectSchema } from "@/server/career/schemas";
import { refreshRecommendationsBestEffort } from "@/server/recommendations";

const service = new CareerDataService();

export function GET(request: Request) {
  return api(request, () => service.listProjects(request.headers));
}

export function POST(request: Request) {
  return api(request, async (userId) => {
    const project = await service.saveProject(await readJson(request, projectSchema), request.headers);
    await refreshRecommendationsBestEffort(userId);
    return project;
  });
}
