import { driveHttp } from "@/server/drive/http";
export const runtime = "nodejs";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) { return driveHttp.files(request, (await context.params).id); }
