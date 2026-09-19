import { integrationHttp } from "@/server/integrations/http";
export const runtime = "nodejs";
export async function GET(request: Request, context: { params: Promise<{ provider: string }> }) {
  return integrationHttp.callback(request, (await context.params).provider);
}
