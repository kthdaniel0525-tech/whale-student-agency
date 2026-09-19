import { driveHttp } from "@/server/drive/http";
export const runtime = "nodejs";
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) { return driveHttp.freshness(request, (await context.params).id); }
