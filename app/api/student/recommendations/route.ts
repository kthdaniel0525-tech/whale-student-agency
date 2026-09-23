import { api } from "@/server/api";
import { getTopRecommendations, RECOMMENDATION_CONFIG } from "@/server/recommendations";

export function GET(request: Request) {
  return api(request, async (userId) => {
    const raw = new URL(request.url).searchParams.get("limit");
    const limit = raw === null ? RECOMMENDATION_CONFIG.defaultTopLimit : Number(raw);
    return {
      recommendations: await getTopRecommendations({ userId, limit }),
    };
  });
}
