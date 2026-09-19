import { z } from "zod";
import { api, readJson } from "@/server/api";
import { markNotificationRead, dismissNotification, snoozeNotification } from "@/server/notifications";
const input = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("read") }).strict(), z.object({ operation: z.literal("dismiss") }).strict(),
  z.object({ operation: z.literal("snooze"), until: z.string().datetime() }).strict(),
]);
export function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  return api(request, async (userId) => {
    const body = await readJson(request, input);
    const { id } = await context.params;
    if (body.operation === "read") return markNotificationRead(userId, id);
    if (body.operation === "dismiss") return dismissNotification(userId, id);
    return snoozeNotification(userId, id, new Date(body.until));
  });
}
