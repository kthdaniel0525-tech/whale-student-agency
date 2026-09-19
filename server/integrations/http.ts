import "server-only";
import { z } from "zod";
import { revalidatePath } from "next/cache";
import { api, readJson, RequestError } from "../api";
import { startConnectionSchema } from "@/lib/student/integrations/types";
import { createIntegrationService } from "./service";
import { IntegrationError, safeIntegrationError } from "./errors";
import { integrationOrigin } from "./config";
const sensitiveHeaders = { "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff" };
export function createIntegrationHttpHandlers(service = createIntegrationService()) {
  function call(request: Request, operation: (userId: string) => Promise<unknown>) {
    return api(request, async (userId) => {
      try { return Response.json(await operation(userId), { headers: sensitiveHeaders }); }
      catch (cause) { if (cause instanceof z.ZodError || cause instanceof RequestError) throw cause; const error = safeIntegrationError(cause); return Response.json({ error: error.message, code: error.code }, { status: error.status, headers: sensitiveHeaders }); }
    });
  }
  return {
    list: (request: Request) => call(request, (userId) => service.getIntegrationSettings(userId)),
    connect: (request: Request) => call(request, async () => {
      const input = await readJson(request, startConnectionSchema);
      return service.startIntegrationConnection(input, request.headers);
    }),
    disconnect: (request: Request, id: string) => call(request, async (userId) => {
      const account = await service.disconnectConnectedAccount(userId, id); revalidatePath("/student/settings"); return account;
    }),
    callback: async (request: Request, provider: string) => {
      let outcome = "connected";
      try {
        const query = new URL(request.url).searchParams;
        if (["state", "code", "error"].some((key) => query.getAll(key).length > 1)) throw new IntegrationError("INVALID_STATE");
        await service.handleIntegrationCallback(provider, { state: query.get("state") ?? undefined, code: query.get("code") ?? undefined, error: query.get("error") ?? undefined }, request.headers);
        revalidatePath("/student/settings");
      } catch (error) { outcome = safeIntegrationError(error).code; }
      // Never render callback parameters or send them to another page/referer.
      try {
        const destination = new URL("/student/settings", integrationOrigin());
        destination.searchParams.set("integration", outcome); destination.hash = "integrations";
        return new Response(null, { status: 303, headers: { ...sensitiveHeaders, Location: destination.toString() } });
      } catch { return new Response("Connection configuration is unavailable. Return to Settings and try again later.", { status: 503, headers: sensitiveHeaders }); }
    },
  };
}
export const integrationHttp = createIntegrationHttpHandlers();
