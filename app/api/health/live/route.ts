export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function GET() { return Response.json({ status: "alive" }, { headers: { "Cache-Control": "no-store" } }); }
