import { z } from "zod";
import { api } from "@/server/api";
import { getNotifications } from "@/server/notifications";
export function GET(request: Request) {
  return api(request, async (userId) => {
    const input = z.object({ status: z.enum(["all", "unread"]).optional(), cursor: z.string().max(1000).optional(),
      limit: z.coerce.number().int().min(1).max(50).optional() }).strict().parse(Object.fromEntries(new URL(request.url).searchParams));
    return getNotifications({ userId, ...input });
  });
}
