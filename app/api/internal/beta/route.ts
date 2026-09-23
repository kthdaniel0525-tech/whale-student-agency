import { api } from "@/server/api";
import { getBetaOverview, getLaunchReadiness } from "@/server/beta/metrics";
import { z } from "zod";
import { cohortSchema } from "@/server/beta/config";
export function GET(request: Request) { return api(request, async userId => {
  const url = new URL(request.url);
  const filter = z.object({ days: z.coerce.number().int().min(1).max(90).default(30), cohort: cohortSchema.optional() }).parse(Object.fromEntries(url.searchParams));
  return { ...await getBetaOverview(userId, filter), readiness: await getLaunchReadiness(userId) };
}, false); }
