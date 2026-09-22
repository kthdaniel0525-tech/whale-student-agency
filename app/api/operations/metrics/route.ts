import { operationsAuthorized } from "@/server/operations/health";
import { cachedOperationalMetrics } from "@/server/operations/metrics";
import { reportError } from "@/server/operations/monitoring";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  const headers = { "Cache-Control": "private, no-store" };
  if (!operationsAuthorized(request)) return new Response(null, { status: 404, headers });
  try { return Response.json(await cachedOperationalMetrics(), { headers }); }
  catch (error) { reportError(error, { route: "/api/operations/metrics" }); return Response.json({ status: "unavailable" }, { status: 503, headers }); }
}
