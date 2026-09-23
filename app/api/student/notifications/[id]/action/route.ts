import { api } from "@/server/api";
import { getNotificationAction } from "@/server/notifications";
export function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return api(request, async (userId) => getNotificationAction(userId, (await context.params).id));
}
