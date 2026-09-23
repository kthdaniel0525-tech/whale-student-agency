import { academicHttp } from "@/server/academic-integrations/http";
export const runtime = "nodejs";
export async function POST(request: Request) { return academicHttp.import(request); }
