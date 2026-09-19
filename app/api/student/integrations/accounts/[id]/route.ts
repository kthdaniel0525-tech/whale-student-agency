import { integrationHttp } from "@/server/integrations/http";
export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  return integrationHttp.disconnect(request, (await context.params).id);
}
