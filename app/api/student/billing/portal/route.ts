import { z } from "zod";
import { api, readJson } from "@/server/api";
import { createBillingPortalSession } from "@/server/billing/service";
export const runtime = "nodejs";
export async function POST(request: Request) { return api(request, async userId => { await readJson(request, z.object({}).strict()); return createBillingPortalSession(userId); }, false); }
