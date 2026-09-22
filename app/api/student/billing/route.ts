import { api } from "@/server/api";
import { billingSummary } from "@/server/billing/service";
export const runtime = "nodejs";
export async function GET(request: Request) { return api(request, billingSummary, false); }
