import { publicPlanCatalog } from "@/server/entitlements/service";
export const dynamic = "force-dynamic";
export async function GET() { return Response.json({ plans: await publicPlanCatalog() }, { headers: { "Cache-Control": "no-store" } }); }
