import { api, readJson } from "@/server/api";
import { billingSelection } from "@/lib/billing/types";
import { createPlanChangeSession } from "@/server/billing/service";
export const runtime = "nodejs";
export async function POST(request: Request) { return api(request, async userId => createPlanChangeSession(userId, await readJson(request, billingSelection)), false); }
