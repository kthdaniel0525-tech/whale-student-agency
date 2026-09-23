import { api } from "@/server/api";
import { getUnreadNotificationCount } from "@/server/notifications";
export function GET(request: Request) {
  return api(request, async (userId) => ({ count: await getUnreadNotificationCount(userId) }));
}
