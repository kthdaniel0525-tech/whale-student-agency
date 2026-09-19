import { academicHttp } from "@/server/academic-integrations/http";
export const runtime = "nodejs";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) { return academicHttp.courses(request, (await context.params).id); }
