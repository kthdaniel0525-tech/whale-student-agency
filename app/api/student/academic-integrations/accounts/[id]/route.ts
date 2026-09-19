import { academicHttp } from "@/server/academic-integrations/http";
export const runtime = "nodejs";
export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) { return academicHttp.disconnect(request, (await context.params).id); }
