import { api } from "@/server/api";
import { markAllNotificationsRead } from "@/server/notifications";
export function POST(request: Request) {
  return api(request, (userId) => markAllNotificationsRead(userId));
}
