import { z } from "zod";
import { api, readJson } from "@/server/api";
import { archiveMemory, deleteMemory } from "@/server/memory";

type Context = { params: Promise<{ id: string }> };
const actionSchema = z.object({ action: z.literal("archive") }).strict();

export function PATCH(request: Request, context: Context) {
  return api(request, async () => {
    const { id } = await context.params;
    await readJson(request, actionSchema);
    return archiveMemory(id, request.headers);
  });
}

export function DELETE(request: Request, context: Context) {
  return api(request, async () => deleteMemory((await context.params).id, request.headers));
}
