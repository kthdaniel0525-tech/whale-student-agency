import { api } from "@/server/api";
import { startRecommendedAction } from "@/server/recommendations";

type Context = { params: Promise<{ id: string }> };

export function POST(request: Request, context: Context) {
  return api(request, async (userId) =>
    startRecommendedAction(userId, (await context.params).id),
  );
}
