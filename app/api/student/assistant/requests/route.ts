import { z } from "zod";
import { api, readJson } from "@/server/api";
import { executeAssistantRequest } from "@/server/assistant";

export function POST(request: Request) {
  return api(request, async () => executeAssistantRequest(await readJson(request, z.unknown()), request.headers));
}
