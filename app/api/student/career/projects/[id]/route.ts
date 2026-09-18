import { api, readJson } from "@/server/api";
import { CareerDataService } from "@/server/career/service";
import { projectSchema } from "@/server/career/schemas";
import { refreshRecommendationsBestEffort } from "@/server/recommendations";

type Context = { params: Promise<{ id: string }> };
const service = new CareerDataService();

export function GET(request: Request, context: Context) {
  return api(request, async () => service.getProject((await context.params).id, request.headers));
}

export function PUT(request: Request, context: Context) {
  return api(request, async (userId) => {
    const project = await service.saveProject(await readJson(request, projectSchema), request.headers, (await context.params).id);
    await refreshRecommendationsBestEffort(userId);
    return project;
  });
}

export function DELETE(request: Request, context: Context) {
  return api(request, async (userId) => {
    const result = await service.deleteProject((await context.params).id, request.headers);
    await refreshRecommendationsBestEffort(userId);
    return result;
  });
}
