import { api, readJson, RequestError } from "@/server/api";
import { db } from "@/server/db/client";
import { z } from "zod";
import { clientEventSchema } from "@/lib/product-analytics/events";
import { trackProductEvent, setAnalyticsPreference, recommendationProperties } from "@/server/product-analytics/service";
import { analyticsConfig } from "@/server/product-analytics/config";
import { betaAccess } from "@/server/beta/access";
import { createHash, randomUUID } from "node:crypto";
export function GET(request: Request) { return api(request, async userId => ({ enabled: analyticsConfig().enabled, optedOut: (await db().productAnalyticsState.findUnique({ where: { userId } }))?.optedOut ?? false }), false); }
export function PUT(request: Request) { return api(request, async userId => { const input = await readJson(request, z.object({ optedOut: z.boolean() }).strict()); await setAnalyticsPreference(userId, input.optedOut); return { optedOut: input.optedOut }; }, false); }
export function POST(request: Request) {
  return api(request, async userId => {
    await betaAccess(userId);
    const input = await readJson(request, clientEventSchema, 2048);
    if (!analyticsConfig().enabled) return { accepted: true };
    const key = createHash("sha256").update(`product-events:${userId}`).digest("hex"), now = BigInt(Date.now()), cutoff = now - BigInt(60000);
    const [limit] = await db().$queryRaw<{ count: number }[]>`INSERT INTO "RateLimit" (id,key,count,"lastRequest") VALUES (${randomUUID()},${key},1,${now})
      ON CONFLICT (key) DO UPDATE SET count=CASE WHEN "RateLimit"."lastRequest"<${cutoff} THEN 1 ELSE LEAST("RateLimit".count+1,121) END,
      "lastRequest"=CASE WHEN "RateLimit"."lastRequest"<${cutoff} THEN ${now} ELSE "RateLimit"."lastRequest" END RETURNING count`;
    if (limit.count > 120) throw new RequestError("Too many events.", 429);
    let dedupe = input.eventId;
    if (input.event === "recommendation_shown") {
      if (!input.recommendationId || !await db().recommendation.findFirst({ where: { id: input.recommendationId, userId, status: "ACTIVE" }, select: { id: true } })) throw new RequestError("Recommendation not found.", 404);
      // Once per recommendation lifetime, matching unique recommendation clicks.
      dedupe = input.recommendationId;
    } else if (input.recommendationId) throw new RequestError("Unexpected recommendation reference.", 400);
    trackProductEvent(userId, input.event, input.event === "recommendation_shown" ? { ...recommendationProperties(userId, input.recommendationId!), ...(input.page ? { page: input.page } : {}) } : {}, dedupe);
    return { accepted: true };
  }, false);
}
