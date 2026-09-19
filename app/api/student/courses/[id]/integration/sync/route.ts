import { academicHttp } from "@/server/academic-integrations/http";
export const runtime = "nodejs";
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) { return academicHttp.sync(request, (await context.params).id); }
