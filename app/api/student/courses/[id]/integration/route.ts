import { academicHttp } from "@/server/academic-integrations/http";
export const runtime = "nodejs";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) { return academicHttp.status(request, (await context.params).id); }
