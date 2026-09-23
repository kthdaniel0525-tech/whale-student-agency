import { z } from "zod";
import { api, readJson } from "@/server/api";
import { streamAssistantRequest } from "@/server/assistant";

export function POST(request: Request) {
  return api(request, async () => streamAssistantRequest(await readJson(request, z.unknown()), request.headers));
}
