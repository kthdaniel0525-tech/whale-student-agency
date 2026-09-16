import { z } from "zod";
import { api, readJson } from "@/server/api";
import { evaluateAssistantQuizAnswer } from "@/server/assistant";

type Context = { params: Promise<{ id: string }> };

export function POST(request: Request, context: Context) {
  return api(request, async () => evaluateAssistantQuizAnswer((await context.params).id, await readJson(request, z.unknown()), request.headers));
}
