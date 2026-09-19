import { academicHttp } from "@/server/academic-integrations/http";
export const runtime = "nodejs";
export async function GET(request: Request) { return academicHttp.settings(request); }
